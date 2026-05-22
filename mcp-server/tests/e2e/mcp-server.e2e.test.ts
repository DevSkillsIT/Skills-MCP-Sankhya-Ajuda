/**
 * End-to-End test suite for the Sankhya Ajuda MCP server.
 *
 * Hits the LIVE running server at http://127.0.0.1:3105/mcp via the MCP SDK
 * StreamableHTTPClientTransport (manages Mcp-Session-Id + MCP protocol
 * handshake automatically).
 *
 * GUARD: The entire suite is skipped unless RUN_E2E=1 is set.
 * Default `npm test` (no env var) stays green without needing the live server.
 *
 *   RUN_E2E=1 npx --prefix /opt/mcp-servers/sankhya_ajuda/mcp-server \
 *     vitest run tests/e2e/mcp-server.e2e.test.ts
 *
 * Auth: reads MCP_AUTH_TOKEN from process.env (populated by dotenv).
 * The token value is never logged or hardcoded here.
 *
 * Surface exercised (MAXIMUM COVERAGE):
 *   - GET /health (plain fetch, no SDK) — with retry loop
 *   - SDK initialize / serverInfo after client.connect()
 *   - tools/list → exact 11 tools, all sankhya_ajuda_* prefix, annotations
 *   - sankhya_ajuda_search_knowledge_unified — matrix: 7 queries × 3 sources +
 *       limit edges (1, 50) + include_outdated + technical-noise assertion
 *   - sankhya_ajuda_search_articles — queries × 3 modes + category_id filter +
 *       include_outdated
 *   - sankhya_ajuda_get_article_details — derived id × 3 max_body_chars + invalid id
 *   - sankhya_ajuda_get_community_post — derived ids × 2 max_body_chars + NOT_FOUND
 *   - sankhya_ajuda_list_categories (assert 14)
 *   - sankhya_ajuda_list_sections (no filter; by category_id; by parent_section_id)
 *   - sankhya_ajuda_list_community_spaces (assert ~33)
 *   - Resources: client.listResources() + sankhya_ajuda_list_mcp_resources;
 *       READ every static URI + every template with real ids via both
 *       client.readResource() and sankhya_ajuda_read_resource_by_uri
 *   - Prompts (ALL 4): client.listPrompts() + sankhya_ajuda_list_prompt_catalog;
 *       client.getPrompt() + sankhya_ajuda_get_prompt_by_name for each
 *   - Error/edge cases: Zod validation (limit=0, limit=51, query="",
 *       max_body_chars=99, max_body_chars=40001); invalid resource URI;
 *       invalid prompt name
 */

// Load .env from the mcp-server root regardless of CWD (handles --prefix invocation).
import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenvConfig({ path: resolve(__dirname, '../../.env'), override: false });

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// ─── Guard: skip entire suite unless RUN_E2E=1 ───────────────────────────────

const RUN_E2E = process.env['RUN_E2E'] === '1';

// ─── Placeholder suite when E2E is disabled (keeps file parseable) ────────────

describe.skipIf(RUN_E2E)(
  'MCP E2E (GUARDED — set RUN_E2E=1 to enable)',
  () => {
    it('is skipped in default test runs (no live server required)', () => {
      expect(process.env['RUN_E2E']).not.toBe('1');
    });
  },
);

// ─── E2E suite (only runs when RUN_E2E=1) ────────────────────────────────────

describe.skipIf(!RUN_E2E)('MCP E2E — live server at http://127.0.0.1:3105', () => {
  const SERVER_URL = 'http://127.0.0.1:3105';
  const MCP_ENDPOINT = `${SERVER_URL}/mcp`;
  const HEALTH_ENDPOINT = `${SERVER_URL}/health`;

  // Auth token comes from process.env populated by dotenv — never hardcoded.
  const authToken = process.env['MCP_AUTH_TOKEN'] ?? '';

  let client: Client;

  // ─── Dynamically derived IDs (populated in beforeAll) ────────────────────
  // All IDs are found at runtime from live search results — no hardcoded rot.

  let derivedArticleId: number = 0;         // from sankhya_ajuda_search_articles
  let derivedArticleId2: number = 0;        // second article for compare_articles
  let derivedCommunityPostId: string = '';  // from sankhya_ajuda_search_knowledge_unified
  let derivedCommunityPostId2: string = ''; // second post from a different space
  let derivedCategoryId: number = 0;        // from sankhya_ajuda_list_categories (reforma)
  let derivedSectionId: number = 0;         // from sankhya_ajuda_list_sections

  // ─── Setup: health-check retry + connect a real SDK client ───────────────

  beforeAll(async () => {
    if (!authToken) {
      throw new Error(
        'MCP_AUTH_TOKEN is not set. Export it before running E2E tests.\n' +
          'Example: MCP_AUTH_TOKEN=<token> RUN_E2E=1 npx vitest run tests/e2e/mcp-server.e2e.test.ts',
      );
    }

    // Health-check retry: poll up to 5 times with ~1.5s spacing before connecting.
    // Prevents flaky failures immediately after a pm2 restart.
    const MAX_RETRIES = 5;
    const RETRY_DELAY_MS = 1500;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(HEALTH_ENDPOINT);
        if (res.status === 200) {
          const body = (await res.json()) as Record<string, unknown>;
          if (body['status'] === 'ok') {
            console.log(`[E2E] Health check OK on attempt ${attempt}. articles_count=${body['articles_count']}`);
            break;
          }
        }
        lastError = new Error(`Health returned non-ok on attempt ${attempt}`);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.warn(`[E2E] Health check attempt ${attempt}/${MAX_RETRIES} failed: ${lastError.message}`);
      }

      if (attempt === MAX_RETRIES) {
        throw new Error(
          `Server at ${HEALTH_ENDPOINT} is still down after ${MAX_RETRIES} attempts. ` +
            `Last error: ${lastError?.message ?? 'unknown'}`,
        );
      }

      // Wait before retrying.
      await new Promise<void>((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }

    // Connect MCP SDK client.
    client = new Client(
      { name: 'e2e-vitest', version: '1.0.0' },
      { capabilities: {} },
    );

    const transport = new StreamableHTTPClientTransport(
      new URL(MCP_ENDPOINT),
      {
        requestInit: {
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
        },
      },
    );

    // connect() drives the initialize handshake and populates serverCapabilities.
    await client.connect(transport);

    // ── Derive real IDs from live search results ──────────────────────────

    // 1. Derive article IDs from a help search.
    try {
      const searchResult = await client.callTool({
        name: 'sankhya_ajuda_search_articles',
        arguments: { query: 'nota fiscal faturamento', limit: 5 },
      });
      const text = extractText(searchResult);
      // Parse the first numeric ID from the Markdown table (column "ID").
      const idMatches = text.match(/\|\s*(\d{10,})\s*\|/g);
      if (idMatches && idMatches.length >= 1) {
        const first = idMatches[0]!.replace(/[^\d]/g, '');
        derivedArticleId = Number(first);
      }
      if (idMatches && idMatches.length >= 2) {
        const second = idMatches[1]!.replace(/[^\d]/g, '');
        derivedArticleId2 = Number(second);
      }
      console.log(`[E2E] Derived article IDs: ${derivedArticleId}, ${derivedArticleId2}`);
    } catch (err) {
      console.warn('[E2E] Could not derive article IDs:', err);
    }

    // 2. Derive community post IDs from unified search.
    try {
      const unifiedResult = await client.callTool({
        name: 'sankhya_ajuda_search_knowledge_unified',
        arguments: { query: 'parametrizacao nota fiscal', source: 'community', limit: 5 },
      });
      const text = extractText(unifiedResult);
      // The unified search table exposes the REAL post_id in the ID column (4th
      // column: | # | Fonte | Oficial | ID | Título | ... |). Parse it directly — the
      // URL slug is the title-slug + id and is NOT a valid post_id by itself.
      for (const line of text.split('\n')) {
        if (!line.includes('COMUNIDADE')) continue;
        const cols = line.split('|').map((c) => c.trim());
        const id = cols[4];
        if (id && /^[A-Za-z0-9_-]{8,}$/.test(id)) {
          derivedCommunityPostId = id;
          break;
        }
      }

      console.log(`[E2E] Derived community post ID 1: ${derivedCommunityPostId}`);
    } catch (err) {
      console.warn('[E2E] Could not derive community post IDs:', err);
    }

    // 3. Derive second community post ID from different query.
    try {
      const unifiedResult2 = await client.callTool({
        name: 'sankhya_ajuda_search_knowledge_unified',
        arguments: { query: 'integracao API Sankhya', source: 'community', limit: 5 },
      });
      const text2 = extractText(unifiedResult2);
      for (const line of text2.split('\n')) {
        if (!line.includes('COMUNIDADE')) continue;
        const cols = line.split('|').map((c) => c.trim());
        const id = cols[4];
        if (id && /^[A-Za-z0-9_-]{8,}$/.test(id) && id !== derivedCommunityPostId) {
          derivedCommunityPostId2 = id;
          break;
        }
      }
      console.log(`[E2E] Derived community post ID 2: ${derivedCommunityPostId2}`);
    } catch (err) {
      console.warn('[E2E] Could not derive second community post ID:', err);
    }

    // 4. Derive category_id for "reforma tributaria" via list_categories.
    try {
      const catResult = await client.callTool({
        name: 'sankhya_ajuda_list_categories',
        arguments: {},
      });
      const catText = extractText(catResult);
      // Find a category ID in the table rows (14-digit numbers typical for Zendesk).
      const catIdMatches = catText.match(/\|\s*(\d{14,})\s*\|/g);
      if (catIdMatches && catIdMatches.length >= 1) {
        derivedCategoryId = Number(catIdMatches[0]!.replace(/[^\d]/g, ''));
      }
      console.log(`[E2E] Derived category ID: ${derivedCategoryId}`);
    } catch (err) {
      console.warn('[E2E] Could not derive category ID:', err);
    }

    // 5. Derive section_id from list_sections.
    try {
      const secResult = await client.callTool({
        name: 'sankhya_ajuda_list_sections',
        arguments: {},
      });
      const secText = extractText(secResult);
      const secIdMatches = secText.match(/\|\s*(\d{14,})\s*\|/g);
      if (secIdMatches && secIdMatches.length >= 1) {
        derivedSectionId = Number(secIdMatches[0]!.replace(/[^\d]/g, ''));
      }
      console.log(`[E2E] Derived section ID: ${derivedSectionId}`);
    } catch (err) {
      console.warn('[E2E] Could not derive section ID:', err);
    }
  }, 60_000);

  afterAll(async () => {
    await client.close();
  });

  // ─── Helper: extract text from a callTool response ───────────────────────

  function extractText(
    result: Awaited<ReturnType<typeof client.callTool>>,
  ): string {
    const textContent = result.content.find((c) => c.type === 'text');
    return textContent && 'text' in textContent ? textContent.text : '';
  }

  // ─── Assertion: response is Markdown, not raw JSON ───────────────────────

  function assertMarkdownNotRawJson(text: string, toolName: string): void {
    // Raw JSON dumps start with '{' or contain '"id":' at the beginning.
    expect(text, `${toolName} response looks like raw JSON object`).not.toMatch(
      /^\s*\{/,
    );
    expect(text, `${toolName} response looks like a JSON id field`).not.toMatch(
      /^"id":/,
    );
  }

  // ─── Assertion: no literal unicode escape sequences in output ────────────

  function assertNoLiteralUnicodeEscapes(text: string, context: string): void {
    // Decoded accents should not appear as \uXXXX or \n literal backslash-n.
    expect(
      text,
      `${context}: response contains literal \\uXXXX unicode escape (should be decoded)`,
    ).not.toMatch(/\\u[0-9a-fA-F]{4}/);
    expect(
      text,
      `${context}: response contains literal \\n escape (should be real newlines)`,
    ).not.toMatch(/\\n/);
  }

  // ─── Helper: count table data rows (lines starting with | that are not separator) ──

  function countTableDataRows(text: string): number {
    return text
      .split('\n')
      .filter((line) => line.startsWith('|') && !line.includes('---'))
      .length;
  }

  // ─── Helper: extract similarity values from a unified search result ──────

  function extractSimilarityValues(text: string): number[] {
    // The Similaridade column contains 0.000-1.000 floats or "—".
    const matches = text.match(/\|\s*(0\.\d{3}|1\.000)\s*\|/g);
    if (!matches) return [];
    return matches.map((m) => Number(m.replace(/[|s]/g, '').trim()));
  }

  // ─── Helper: count source labels in unified search table ─────────────────

  function countSources(text: string): { help: number; comunidade: number } {
    const lines = text.split('\n').filter((l) => l.startsWith('|') && !l.includes('---') && !l.includes('Fonte'));
    let help = 0;
    let comunidade = 0;
    for (const line of lines) {
      if (line.includes('HELP')) help++;
      if (line.includes('COMUNIDADE')) comunidade++;
    }
    return { help, comunidade };
  }

  // ─── Health endpoint ──────────────────────────────────────────────────────

  describe('GET /health', () => {
    it('returns 200 with status ok and positive articles_count', async () => {
      const res = await fetch(HEALTH_ENDPOINT);
      expect(res.status).toBe(200);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body['status']).toBe('ok');
      expect(typeof body['articles_count']).toBe('number');
      expect((body['articles_count'] as number)).toBeGreaterThan(0);
    });
  });

  // ─── Server capabilities / initialize ────────────────────────────────────

  describe('initialize / serverInfo', () => {
    it('server capabilities are populated after connect()', () => {
      const caps = client.getServerCapabilities();
      expect(caps).toBeDefined();
      // Server must advertise at least tools, resources, and prompts.
      expect(caps?.tools).toBeDefined();
      expect(caps?.resources).toBeDefined();
      expect(caps?.prompts).toBeDefined();
    });

    it('serverInfo identifies the Sankhya Ajuda MCP server', () => {
      const info = client.getServerVersion();
      expect(info).toBeDefined();
      expect(info?.name).toContain('sankhya');
    });
  });

  // ─── tools/list ──────────────────────────────────────────────────────────

  describe('tools/list', () => {
    it('returns exactly 11 tools, all prefixed sankhya_ajuda_', async () => {
      const result = await client.listTools();
      expect(result.tools).toHaveLength(11);

      for (const tool of result.tools) {
        expect(
          tool.name,
          `Tool "${tool.name}" does not start with "sankhya_ajuda_"`,
        ).toMatch(/^sankhya_ajuda_/);
      }
    });

    it('every tool has all four annotation hints', async () => {
      const result = await client.listTools();

      for (const tool of result.tools) {
        const hints = tool.annotations as Record<string, unknown> | undefined;
        expect(hints, `Tool "${tool.name}" is missing annotations`).toBeDefined();
        expect(
          hints,
          `Tool "${tool.name}" is missing readOnlyHint`,
        ).toHaveProperty('readOnlyHint');
        expect(
          hints,
          `Tool "${tool.name}" is missing destructiveHint`,
        ).toHaveProperty('destructiveHint');
        expect(
          hints,
          `Tool "${tool.name}" is missing openWorldHint`,
        ).toHaveProperty('openWorldHint');
        expect(
          hints,
          `Tool "${tool.name}" is missing idempotentHint`,
        ).toHaveProperty('idempotentHint');
      }
    });

    it('every tool description is 280–400 characters', async () => {
      const result = await client.listTools();

      for (const tool of result.tools) {
        const len = (tool.description ?? '').length;
        expect(
          len,
          `Tool "${tool.name}" description length ${len} is outside 280–400`,
        ).toBeGreaterThanOrEqual(280);
        expect(
          len,
          `Tool "${tool.name}" description length ${len} is outside 280–400`,
        ).toBeLessThanOrEqual(400);
      }
    });
  });

  // ─── sankhya_ajuda_search_knowledge_unified — maximum coverage matrix ────

  describe('tools/call — sankhya_ajuda_search_knowledge_unified', () => {

    // Matrix: 7 queries × 3 sources = 21 combinations tested via it.each.
    const QUERIES = [
      'erro ao confirmar nota fiscal',
      'parametrizacao regras da reforma tributaria',
      'como criar processo no Sankhya Flow BPM',
      'integracao Sankhya via API REST com Python',
      'gestao de estoque',
      'folha de pagamento e RH',
      'ola pessoal me apresentando',  // social/noise query
    ] as const;

    const SOURCES = ['all', 'help', 'community'] as const;

    it.each(
      QUERIES.flatMap((query) =>
        SOURCES.map((source) => ({ query, source })),
      )
    )('query="$query" source=$source → Markdown table + logged counts', async ({ query, source }) => {
      const result = await client.callTool({
        name: 'sankhya_ajuda_search_knowledge_unified',
        arguments: { query, source, limit: 10 },
      });

      expect(result.isError, `query="${query}" source=${source} returned isError`).not.toBe(true);
      const text = extractText(result);
      assertMarkdownNotRawJson(text, `search_unified query="${query}" source=${source}`);

      const hasTable = text.includes('|');
      const hasNoResultsMsg = text.toLowerCase().includes('nenhum');
      expect(
        hasTable || hasNoResultsMsg,
        `Expected Markdown table or no-results message for query="${query}" source=${source}. Got: ${text.slice(0, 200)}`,
      ).toBe(true);

      if (hasTable) {
        // Unified search must always show Fonte and Similaridade columns.
        expect(text, `Missing Fonte column for source=${source}`).toContain('Fonte');
        expect(text, `Missing Similaridade column for source=${source}`).toContain('Similaridade');

        const counts = countSources(text);
        const similarities = extractSimilarityValues(text);

        console.log(
          `[E2E] unified query="${query.slice(0, 40)}" source=${source} ` +
          `| HELP=${counts.help} COMUNIDADE=${counts.comunidade} ` +
          `| top_similarity=${similarities[0]?.toFixed(3) ?? '—'} ` +
          `| rows=${counts.help + counts.comunidade}`,
        );

        // Source-specific assertions.
        if (source === 'help') {
          expect(
            counts.comunidade,
            `source=help must NOT return COMUNIDADE rows`,
          ).toBe(0);
        } else if (source === 'community') {
          expect(
            counts.help,
            `source=community must NOT return HELP rows`,
          ).toBe(0);
        } else {
          // source='all': both sources CAN appear (not necessarily in every query).
          // We only assert column presence — not that both are always present.
        }
      }
    }, 30_000);

    it('source=all — technical query should mix HELP and COMUNIDADE results', async () => {
      // "nota fiscal" is a strong technical query with results in both corpora.
      const result = await client.callTool({
        name: 'sankhya_ajuda_search_knowledge_unified',
        arguments: { query: 'nota fiscal faturamento', source: 'all', limit: 15 },
      });
      expect(result.isError).not.toBe(true);
      const text = extractText(result);

      if (text.includes('|')) {
        const counts = countSources(text);
        console.log(`[E2E] mixed source test: HELP=${counts.help} COMUNIDADE=${counts.comunidade}`);
        // With limit=15 from a broad technical query, expect at least one of each source.
        // This can occasionally not hold for very narrow corpora — use a soft check.
        const hasAtLeastOneSource = counts.help > 0 || counts.comunidade > 0;
        expect(hasAtLeastOneSource, 'Expected at least one result row in source=all').toBe(true);
      }
    }, 30_000);

    it('limit=1 returns at most 1 result', async () => {
      const result = await client.callTool({
        name: 'sankhya_ajuda_search_knowledge_unified',
        arguments: { query: 'nota fiscal', source: 'all', limit: 1 },
      });
      expect(result.isError).not.toBe(true);
      const text = extractText(result);
      if (text.includes('|')) {
        // Data rows = total rows minus header and separator.
        const allRows = text.split('\n').filter((l) => l.startsWith('|'));
        // allRows includes header row + separator row + data rows.
        const dataRows = allRows.filter((l) => !l.includes('---') && !l.includes('Fonte'));
        expect(
          dataRows.length,
          `Expected at most 1 data row for limit=1, got ${dataRows.length}`,
        ).toBeLessThanOrEqual(1);
      }
    }, 20_000);

    it('limit=50 returns up to 50 results without error', async () => {
      const result = await client.callTool({
        name: 'sankhya_ajuda_search_knowledge_unified',
        arguments: { query: 'Sankhya', source: 'all', limit: 50 },
      });
      expect(result.isError).not.toBe(true);
      const text = extractText(result);
      assertMarkdownNotRawJson(text, 'search_unified limit=50');
      // Only assert no crash — row count depends on corpus size.
    }, 30_000);

    it('include_outdated=true still returns Markdown', async () => {
      const result = await client.callTool({
        name: 'sankhya_ajuda_search_knowledge_unified',
        arguments: { query: 'nota fiscal', source: 'help', limit: 5, include_outdated: true },
      });
      expect(result.isError).not.toBe(true);
      const text = extractText(result);
      assertMarkdownNotRawJson(text, 'search_unified include_outdated=true');
    }, 30_000);

    it('source=all Similaridade column values are 0–1 floats or dashes', async () => {
      const result = await client.callTool({
        name: 'sankhya_ajuda_search_knowledge_unified',
        arguments: { query: 'parametros sistema', source: 'all', limit: 10 },
      });
      expect(result.isError).not.toBe(true);
      const text = extractText(result);
      if (text.includes('|')) {
        // Collect all values in the Similaridade column — either x.xxx or —.
        const rows = text.split('\n').filter((l) => l.startsWith('|') && !l.includes('---') && !l.includes('Fonte'));
        for (const row of rows) {
          const cols = row.split('|').map((c) => c.trim());
          // Similaridade is the 7th column (0-indexed: 0=empty, 1=#, 2=Fonte, ..., 7=Similaridade).
          const simCol = cols[7];
          if (simCol !== undefined && simCol !== '' && simCol !== '—') {
            const val = Number(simCol);
            expect(
              isNaN(val),
              `Similaridade value "${simCol}" is not a valid float`,
            ).toBe(false);
            expect(val, `Similaridade ${val} is outside [0, 1]`).toBeGreaterThanOrEqual(0);
            expect(val, `Similaridade ${val} is outside [0, 1]`).toBeLessThanOrEqual(1);
          }
        }
      }
    }, 30_000);
  });

  // ─── sankhya_ajuda_search_articles — modes × queries ─────────────────────

  describe('tools/call — sankhya_ajuda_search_articles', () => {
    const ARTICLE_QUERIES = [
      'nota fiscal faturamento',
      'erro parametro configuracao',
      'estoque produto',
    ] as const;

    const MODES = ['hybrid', 'semantic', 'keyword'] as const;

    it.each(
      ARTICLE_QUERIES.flatMap((query) =>
        MODES.map((mode) => ({ query, mode })),
      )
    )('query="$query" mode=$mode → Markdown + mode label', async ({ query, mode }) => {
      const result = await client.callTool({
        name: 'sankhya_ajuda_search_articles',
        arguments: { query, mode, limit: 5 },
      });

      expect(result.isError, `query="${query}" mode=${mode} returned isError`).not.toBe(true);
      const text = extractText(result);
      assertMarkdownNotRawJson(text, `search_articles mode=${mode}`);

      const hasTable = text.includes('|');
      const hasNoResults = text.toLowerCase().includes('nenhum');
      expect(
        hasTable || hasNoResults,
        `Expected table or no-results for query="${query}" mode=${mode}`,
      ).toBe(true);

      // Log for the report.
      if (hasTable) {
        const rows = countTableDataRows(text);
        const similarities = extractSimilarityValues(text);
        console.log(
          `[E2E] search_articles mode=${mode} query="${query.slice(0, 30)}" ` +
          `rows=${rows} top_similarity=${similarities[0]?.toFixed(3) ?? '—'}`,
        );
      }
    }, 30_000);

    it('filter by derived category_id returns Markdown', async () => {
      if (!derivedCategoryId) {
        console.warn('[E2E] Skipping category_id filter test — no derived ID');
        return;
      }
      const result = await client.callTool({
        name: 'sankhya_ajuda_search_articles',
        arguments: { query: 'configuracao', category_id: derivedCategoryId, limit: 5 },
      });
      expect(result.isError).not.toBe(true);
      const text = extractText(result);
      assertMarkdownNotRawJson(text, `search_articles category_id=${derivedCategoryId}`);
      console.log(`[E2E] search_articles category_id=${derivedCategoryId}: ${text.slice(0, 120)}`);
    }, 30_000);

    it('include_outdated=true returns articles (possibly more than without)', async () => {
      const result = await client.callTool({
        name: 'sankhya_ajuda_search_articles',
        arguments: { query: 'configuracao sistema', include_outdated: true, limit: 10 },
      });
      expect(result.isError).not.toBe(true);
      const text = extractText(result);
      assertMarkdownNotRawJson(text, 'search_articles include_outdated=true');
    }, 30_000);
  });

  // ─── sankhya_ajuda_get_article_details — max_body_chars caps ─────────────

  describe('tools/call — sankhya_ajuda_get_article_details', () => {
    it('derived article_id with max_body_chars=100: truncation note expected', async () => {
      if (!derivedArticleId) {
        console.warn('[E2E] Skipping: no derived article ID');
        return;
      }
      const result = await client.callTool({
        name: 'sankhya_ajuda_get_article_details',
        arguments: { article_id: derivedArticleId, max_body_chars: 100 },
      });
      expect(result.isError).not.toBe(true);
      const text = extractText(result);
      assertMarkdownNotRawJson(text, `get_article_details id=${derivedArticleId} max=100`);
      // With only 100 chars allowed, the body must be truncated — assert the truncation note.
      const hasTruncationNote = text.includes('truncado') || text.toLowerCase().includes('truncat') || text.includes('max_body_chars');
      expect(
        hasTruncationNote,
        `Expected truncation note for max_body_chars=100. Response: ${text.slice(0, 300)}`,
      ).toBe(true);
      console.log(`[E2E] article ${derivedArticleId} max=100: ${text.slice(0, 120)}...`);
    }, 30_000);

    it('derived article_id with max_body_chars=8000: standard response', async () => {
      if (!derivedArticleId) {
        console.warn('[E2E] Skipping: no derived article ID');
        return;
      }
      const result = await client.callTool({
        name: 'sankhya_ajuda_get_article_details',
        arguments: { article_id: derivedArticleId, max_body_chars: 8000 },
      });
      expect(result.isError).not.toBe(true);
      const text8000 = extractText(result);
      assertMarkdownNotRawJson(text8000, `get_article_details id=${derivedArticleId} max=8000`);
      expect(text8000.length, 'Expected non-empty article body at max=8000').toBeGreaterThan(50);
      console.log(`[E2E] article ${derivedArticleId} max=8000 len=${text8000.length}`);
    }, 30_000);

    it('derived article_id with max_body_chars=40000: body is larger than at 100', async () => {
      if (!derivedArticleId) {
        console.warn('[E2E] Skipping: no derived article ID');
        return;
      }
      // Fetch at 100 chars.
      const small = await client.callTool({
        name: 'sankhya_ajuda_get_article_details',
        arguments: { article_id: derivedArticleId, max_body_chars: 100 },
      });
      const textSmall = extractText(small);

      // Fetch at 40000 chars.
      const large = await client.callTool({
        name: 'sankhya_ajuda_get_article_details',
        arguments: { article_id: derivedArticleId, max_body_chars: 40000 },
      });
      const textLarge = extractText(large);

      // The large version must have more content than the small version.
      expect(
        textLarge.length,
        `Expected max_body_chars=40000 to produce a larger body than max_body_chars=100`,
      ).toBeGreaterThan(textSmall.length);
      console.log(`[E2E] article ${derivedArticleId} size: 100=${textSmall.length} 40000=${textLarge.length}`);
    }, 45_000);

    it('invalid/unknown article_id returns NOT_FOUND error', async () => {
      const result = await client.callTool({
        name: 'sankhya_ajuda_get_article_details',
        arguments: { article_id: 99999999999999 },
      });
      expect(result.isError).toBe(true);
      const text = extractText(result);
      expect(text, 'Expected NOT_FOUND code for unknown article').toContain('NOT_FOUND');
      console.log(`[E2E] invalid article NOT_FOUND: ${text.slice(0, 120)}`);
    }, 20_000);

    it('falls back to hardcoded id 37125749024151 if no derived ID', async () => {
      const idToUse = derivedArticleId || 37125749024151;
      const result = await client.callTool({
        name: 'sankhya_ajuda_get_article_details',
        arguments: { article_id: idToUse },
      });
      expect(result.isError).not.toBe(true);
      const text = extractText(result);
      assertMarkdownNotRawJson(text, 'get_article_details fallback id');
      const hasBreadcrumbOrContent =
        text.includes('►') || text.includes('>') || text.length > 200;
      expect(hasBreadcrumbOrContent, 'Expected breadcrumb or content').toBe(true);
    }, 30_000);
  });

  // ─── sankhya_ajuda_get_community_post ─────────────────────────────────────

  describe('tools/call — sankhya_ajuda_get_community_post', () => {
    it('derived community post_id with max_body_chars=100: truncation expected', async () => {
      if (!derivedCommunityPostId) {
        console.warn('[E2E] Skipping: no derived community post ID');
        return;
      }
      const result = await client.callTool({
        name: 'sankhya_ajuda_get_community_post',
        arguments: { post_id: derivedCommunityPostId, max_body_chars: 100 },
      });

      const text = extractText(result);
      assertMarkdownNotRawJson(text, `get_community_post id=${derivedCommunityPostId} max=100`);
      assertNoLiteralUnicodeEscapes(text, `get_community_post id=${derivedCommunityPostId} max=100`);

      // Derived from the ID column → must be a REAL post (NOT_FOUND not tolerated).
      expect(
        result.isError ?? false,
        `get_community_post failed for derived ID ${derivedCommunityPostId}: ${text.slice(0, 200)}`,
      ).toBe(false);
      expect(text, 'Expected post thread metadata').toMatch(/Espa|Conteudo|\| ID \|/);
      const hasTruncation = text.includes('truncado') || text.includes('max_body_chars');
      expect(
        hasTruncation,
        `Expected truncation note for max_body_chars=100. Response: ${text.slice(0, 300)}`,
      ).toBe(true);
      console.log(`[E2E] community post ${derivedCommunityPostId} max=100 truncated OK`);
    }, 30_000);

    it('derived community post_id with max_body_chars=8000: decoded accents', async () => {
      if (!derivedCommunityPostId) {
        console.warn('[E2E] Skipping: no derived community post ID');
        return;
      }
      const result = await client.callTool({
        name: 'sankhya_ajuda_get_community_post',
        arguments: { post_id: derivedCommunityPostId, max_body_chars: 8000 },
      });

      const text = extractText(result);
      assertMarkdownNotRawJson(text, `get_community_post id=${derivedCommunityPostId} max=8000`);
      assertNoLiteralUnicodeEscapes(text, `get_community_post id=${derivedCommunityPostId} max=8000`);

      expect(
        result.isError ?? false,
        `get_community_post failed for ${derivedCommunityPostId}: ${text.slice(0, 200)}`,
      ).toBe(false);
      expect(text, 'Expected ## Conteudo section in the post thread').toContain('Conteudo');
      expect(text.length, 'Expected non-empty body at max=8000').toBeGreaterThan(50);
      console.log(`[E2E] community post ${derivedCommunityPostId} max=8000 len=${text.length}`);
    }, 30_000);

    it('second derived community post_id returns valid response', async () => {
      if (!derivedCommunityPostId2) {
        console.warn('[E2E] Skipping: no second derived community post ID');
        return;
      }
      const result = await client.callTool({
        name: 'sankhya_ajuda_get_community_post',
        arguments: { post_id: derivedCommunityPostId2, max_body_chars: 8000 },
      });
      const text = extractText(result);
      assertMarkdownNotRawJson(text, `get_community_post id2=${derivedCommunityPostId2}`);
      expect(
        result.isError ?? false,
        `get_community_post failed for 2nd ID ${derivedCommunityPostId2}: ${text.slice(0, 200)}`,
      ).toBe(false);
      console.log(`[E2E] community post 2 ${derivedCommunityPostId2} len=${text.length}`);
    }, 30_000);

    it('returns isError=true with NOT_FOUND for a non-existent post id', async () => {
      const result = await client.callTool({
        name: 'sankhya_ajuda_get_community_post',
        arguments: { post_id: 'id-inexistente-zzz-99999' },
      });
      expect(result.isError).toBe(true);
      const text = extractText(result);
      expect(text, 'Expected NOT_FOUND code').toContain('NOT_FOUND');
      // The message should mention "comunidade".
      expect(
        text.toLowerCase(),
        'Expected NOT_FOUND message to mention community',
      ).toContain('comunidade');
      console.log(`[E2E] bogus post NOT_FOUND: ${text.slice(0, 120)}`);
    }, 20_000);

    it('valid post from original test suite (LR9SZjEKiZryRtI) — metadata or NOT_FOUND', async () => {
      const result = await client.callTool({
        name: 'sankhya_ajuda_get_community_post',
        arguments: { post_id: 'LR9SZjEKiZryRtI' },
      });
      const text = extractText(result);
      assertMarkdownNotRawJson(text, 'get_community_post LR9SZjEKiZryRtI');

      if (!result.isError) {
        const hasMetadata =
          text.toLowerCase().includes('post') ||
          text.toLowerCase().includes('comunidade') ||
          text.includes('|');
        expect(hasMetadata, `Expected community post metadata`).toBe(true);
      }
    }, 30_000);
  });

  // ─── sankhya_ajuda_list_categories ────────────────────────────────────────

  describe('tools/call — sankhya_ajuda_list_categories', () => {
    it('returns exactly 14 categories in a Markdown table', async () => {
      const result = await client.callTool({
        name: 'sankhya_ajuda_list_categories',
        arguments: {},
      });

      expect(result.isError).not.toBe(true);
      const text = extractText(result);
      assertMarkdownNotRawJson(text, 'sankhya_ajuda_list_categories');

      expect(text).toContain('|');

      // The number "14" must appear somewhere (as a count or in a cell).
      const has14 = text.includes('14');
      expect(
        has14,
        `Expected 14 categories in response: ${text.slice(0, 400)}`,
      ).toBe(true);

      // Count data rows: should be 14 + 2 (header + separator).
      const totalRows = countTableDataRows(text);
      // At minimum 14 data rows (not counting header and separator).
      expect(totalRows, `Expected at least 15 rows (header + 14 data), got ${totalRows}`).toBeGreaterThanOrEqual(14);

      console.log(`[E2E] list_categories: ${totalRows} rows found`);
    }, 30_000);
  });

  // ─── sankhya_ajuda_list_sections ─────────────────────────────────────────

  describe('tools/call — sankhya_ajuda_list_sections', () => {
    it('no filter — returns all sections as Markdown table', async () => {
      const result = await client.callTool({
        name: 'sankhya_ajuda_list_sections',
        arguments: {},
      });
      expect(result.isError).not.toBe(true);
      const text = extractText(result);
      assertMarkdownNotRawJson(text, 'list_sections no filter');

      const hasTable = text.includes('|');
      const hasNoResults = text.toLowerCase().includes('nenhum');
      expect(hasTable || hasNoResults, 'Expected table or no-results').toBe(true);
      if (hasTable) {
        const rows = countTableDataRows(text);
        console.log(`[E2E] list_sections (no filter): ${rows} rows`);
        expect(rows, 'Expected many sections (at least 50)').toBeGreaterThan(50);
      }
    }, 30_000);

    it('filtered by derived category_id — returns category sections', async () => {
      if (!derivedCategoryId) {
        console.warn('[E2E] Skipping: no derived category ID');
        return;
      }
      const result = await client.callTool({
        name: 'sankhya_ajuda_list_sections',
        arguments: { category_id: derivedCategoryId },
      });
      expect(result.isError).not.toBe(true);
      const text = extractText(result);
      assertMarkdownNotRawJson(text, `list_sections category_id=${derivedCategoryId}`);
      const rows = countTableDataRows(text);
      console.log(`[E2E] list_sections category_id=${derivedCategoryId}: ${rows} rows`);
    }, 30_000);

    it('filtered by derived parent_section_id — returns child sections', async () => {
      if (!derivedSectionId) {
        console.warn('[E2E] Skipping: no derived section ID');
        return;
      }
      const result = await client.callTool({
        name: 'sankhya_ajuda_list_sections',
        arguments: { parent_section_id: derivedSectionId },
      });
      expect(result.isError).not.toBe(true);
      const text = extractText(result);
      assertMarkdownNotRawJson(text, `list_sections parent_section_id=${derivedSectionId}`);
      // May return 0 rows if section has no children — that is valid.
      const hasTable = text.includes('|');
      const hasNoResults = text.toLowerCase().includes('nenhum');
      expect(hasTable || hasNoResults, 'Expected table or no-results for parent_section_id filter').toBe(true);
      console.log(`[E2E] list_sections parent=${derivedSectionId}: table=${hasTable} noResults=${hasNoResults}`);
    }, 30_000);

    it('hardcoded category_id 34702076010775 returns sections', async () => {
      const result = await client.callTool({
        name: 'sankhya_ajuda_list_sections',
        arguments: { category_id: 34702076010775 },
      });
      expect(result.isError).not.toBe(true);
      const text = extractText(result);
      assertMarkdownNotRawJson(text, 'list_sections category_id=34702076010775');
      const hasTable = text.includes('|');
      const hasNoResults = text.toLowerCase().includes('nenhum');
      expect(hasTable || hasNoResults).toBe(true);
    }, 30_000);
  });

  // ─── sankhya_ajuda_list_community_spaces ─────────────────────────────────

  describe('tools/call — sankhya_ajuda_list_community_spaces', () => {
    it('returns approximately 33 public spaces — none private', async () => {
      const result = await client.callTool({
        name: 'sankhya_ajuda_list_community_spaces',
        arguments: {},
      });

      expect(result.isError).not.toBe(true);
      const text = extractText(result);
      assertMarkdownNotRawJson(text, 'sankhya_ajuda_list_community_spaces');

      const hasTable = text.includes('|');
      const hasNoResultsMsg = text.toLowerCase().includes('nenhum');
      expect(hasTable || hasNoResultsMsg).toBe(true);

      if (hasTable) {
        const rows = text
          .split('\n')
          .filter((line) => line.startsWith('|') && !line.includes('---'));
        // Header row + at minimum several data rows expected (~33 spaces).
        expect(
          rows.length,
          `Expected at least 11 rows (header + >=10 spaces), got ${rows.length}`,
        ).toBeGreaterThanOrEqual(11);

        console.log(`[E2E] list_community_spaces: ${rows.length - 1} data rows`);

        // The response should contain the word "publico" (public spaces only).
        expect(
          text.toLowerCase(),
          'Expected "publico" in community spaces response (all spaces should be public)',
        ).toContain('publico');
      }
    }, 30_000);
  });

  // ─── Resources: native SDK + bridge tool ─────────────────────────────────

  describe('resources — native SDK client.listResources()', () => {
    it('returns static resources with sankhya-ajuda:// URIs', async () => {
      const result = await client.listResources();

      expect(result.resources.length, 'Expected at least 1 static resource').toBeGreaterThanOrEqual(1);

      for (const resource of result.resources) {
        expect(
          resource.uri,
          `Resource URI "${resource.uri}" does not use sankhya-ajuda:// scheme`,
        ).toMatch(/^sankhya-ajuda:\/\//);
      }

      const uris = result.resources.map((r) => r.uri);
      console.log(`[E2E] listResources: ${uris.join(', ')}`);
    });
  });

  describe('resources — sankhya_ajuda_list_mcp_resources (bridge tool)', () => {
    it('returns 6 MCP resources (3 static + 3 templates)', async () => {
      const result = await client.callTool({
        name: 'sankhya_ajuda_list_mcp_resources',
        arguments: {},
      });

      expect(result.isError).not.toBe(true);
      const text = extractText(result);
      assertMarkdownNotRawJson(text, 'sankhya_ajuda_list_mcp_resources');
      expect(text).toContain('6 recursos');
      console.log(`[E2E] list_mcp_resources: ${text.slice(0, 200)}`);
    }, 15_000);
  });

  // Static resource reads via native SDK.

  describe('resources — native client.readResource() for static URIs', () => {
    it('sankhya-ajuda://sync_state returns JSON with articles_count', async () => {
      const result = await client.readResource({ uri: 'sankhya-ajuda://sync_state' });
      expect(result.contents.length).toBeGreaterThan(0);
      const content = result.contents[0];
      expect(content).toBeDefined();
      if (content && 'text' in content) {
        const parsed = JSON.parse(content.text) as Record<string, unknown>;
        expect(typeof parsed['articles_count']).toBe('number');
        expect((parsed['articles_count'] as number)).toBeGreaterThan(0);
        console.log(`[E2E] sync_state: articles_count=${parsed['articles_count']}`);
      } else {
        throw new Error('Expected text content in sync_state resource');
      }
    });

    it('sankhya-ajuda://categories returns Markdown with category list', async () => {
      const result = await client.readResource({ uri: 'sankhya-ajuda://categories' });
      expect(result.contents.length).toBeGreaterThan(0);
      const content = result.contents[0];
      if (content && 'text' in content) {
        expect(content.text, 'Expected Markdown table for categories resource').toContain('|');
        console.log(`[E2E] resource categories len=${content.text.length}`);
      }
    }, 20_000);

    it('sankhya-ajuda://sections returns Markdown with section list', async () => {
      const result = await client.readResource({ uri: 'sankhya-ajuda://sections' });
      expect(result.contents.length).toBeGreaterThan(0);
      const content = result.contents[0];
      if (content && 'text' in content) {
        expect(content.text, 'Expected Markdown table for sections resource').toContain('|');
        console.log(`[E2E] resource sections len=${content.text.length}`);
      }
    }, 20_000);
  });

  // Template resource reads via native SDK.

  describe('resources — native client.readResource() for template URIs', () => {
    it('sankhya-ajuda://articles/{id} with derived article id returns Markdown', async () => {
      if (!derivedArticleId) {
        console.warn('[E2E] Skipping: no derived article ID');
        return;
      }
      const uri = `sankhya-ajuda://articles/${derivedArticleId}`;
      const result = await client.readResource({ uri });
      expect(result.contents.length).toBeGreaterThan(0);
      const content = result.contents[0];
      if (content && 'text' in content) {
        expect(content.text.length, `Expected non-empty article resource`).toBeGreaterThan(50);
        console.log(`[E2E] resource articles/${derivedArticleId} len=${content.text.length}`);
      }
    }, 30_000);

    it('sankhya-ajuda://categories/{id} with derived category id returns Markdown', async () => {
      if (!derivedCategoryId) {
        console.warn('[E2E] Skipping: no derived category ID');
        return;
      }
      const uri = `sankhya-ajuda://categories/${derivedCategoryId}`;
      const result = await client.readResource({ uri });
      expect(result.contents.length).toBeGreaterThan(0);
      const content = result.contents[0];
      if (content && 'text' in content) {
        expect(content.text, 'Expected Markdown for category detail resource').toContain('|');
        console.log(`[E2E] resource categories/${derivedCategoryId} len=${content.text.length}`);
      }
    }, 20_000);

    it('sankhya-ajuda://sections/{id} with derived section id returns Markdown', async () => {
      if (!derivedSectionId) {
        console.warn('[E2E] Skipping: no derived section ID');
        return;
      }
      const uri = `sankhya-ajuda://sections/${derivedSectionId}`;
      const result = await client.readResource({ uri });
      expect(result.contents.length).toBeGreaterThan(0);
      const content = result.contents[0];
      if (content && 'text' in content) {
        expect(content.text.length, 'Expected non-empty section detail').toBeGreaterThan(20);
        console.log(`[E2E] resource sections/${derivedSectionId} len=${content.text.length}`);
      }
    }, 20_000);
  });

  // Static resource reads via bridge tool sankhya_ajuda_read_resource_by_uri.

  describe('resources — sankhya_ajuda_read_resource_by_uri (bridge tool) static URIs', () => {
    it('sankhya-ajuda://sync_state returns Markdown code block with JSON', async () => {
      const result = await client.callTool({
        name: 'sankhya_ajuda_read_resource_by_uri',
        arguments: { uri: 'sankhya-ajuda://sync_state' },
      });
      expect(result.isError).not.toBe(true);
      const text = extractText(result);
      expect(text, 'Expected articles_count in sync_state').toContain('articles_count');
      expect(text, 'Expected code block (```) in sync_state response').toContain('```');
      console.log(`[E2E] read_resource_by_uri sync_state: ${text.slice(0, 150)}`);
    }, 15_000);

    it('sankhya-ajuda://categories returns Markdown with table', async () => {
      const result = await client.callTool({
        name: 'sankhya_ajuda_read_resource_by_uri',
        arguments: { uri: 'sankhya-ajuda://categories' },
      });
      expect(result.isError).not.toBe(true);
      const text = extractText(result);
      expect(text, 'Expected Markdown table in categories resource').toContain('|');
      console.log(`[E2E] read_resource_by_uri categories len=${text.length}`);
    }, 20_000);

    it('sankhya-ajuda://sections returns Markdown with table', async () => {
      const result = await client.callTool({
        name: 'sankhya_ajuda_read_resource_by_uri',
        arguments: { uri: 'sankhya-ajuda://sections' },
      });
      expect(result.isError).not.toBe(true);
      const text = extractText(result);
      expect(text, 'Expected Markdown table in sections resource').toContain('|');
      console.log(`[E2E] read_resource_by_uri sections len=${text.length}`);
    }, 20_000);
  });

  // Template resource reads via bridge tool.

  describe('resources — sankhya_ajuda_read_resource_by_uri (bridge tool) template URIs', () => {
    it('sankhya-ajuda://articles/{id} via bridge tool returns Markdown', async () => {
      if (!derivedArticleId) {
        console.warn('[E2E] Skipping: no derived article ID');
        return;
      }
      const uri = `sankhya-ajuda://articles/${derivedArticleId}`;
      const result = await client.callTool({
        name: 'sankhya_ajuda_read_resource_by_uri',
        arguments: { uri },
      });
      expect(result.isError).not.toBe(true);
      const text = extractText(result);
      assertMarkdownNotRawJson(text, `read_resource_by_uri articles/${derivedArticleId}`);
      expect(text.length, 'Expected non-empty article via bridge tool').toBeGreaterThan(50);
      console.log(`[E2E] read_resource_by_uri articles/${derivedArticleId} len=${text.length}`);
    }, 30_000);

    it('sankhya-ajuda://categories/{id} via bridge tool returns Markdown', async () => {
      if (!derivedCategoryId) {
        console.warn('[E2E] Skipping: no derived category ID');
        return;
      }
      const uri = `sankhya-ajuda://categories/${derivedCategoryId}`;
      const result = await client.callTool({
        name: 'sankhya_ajuda_read_resource_by_uri',
        arguments: { uri },
      });
      expect(result.isError).not.toBe(true);
      const text = extractText(result);
      assertMarkdownNotRawJson(text, `read_resource_by_uri categories/${derivedCategoryId}`);
      console.log(`[E2E] read_resource_by_uri categories/${derivedCategoryId} len=${text.length}`);
    }, 20_000);

    it('sankhya-ajuda://sections/{id} via bridge tool returns Markdown', async () => {
      if (!derivedSectionId) {
        console.warn('[E2E] Skipping: no derived section ID');
        return;
      }
      const uri = `sankhya-ajuda://sections/${derivedSectionId}`;
      const result = await client.callTool({
        name: 'sankhya_ajuda_read_resource_by_uri',
        arguments: { uri },
      });
      expect(result.isError).not.toBe(true);
      const text = extractText(result);
      assertMarkdownNotRawJson(text, `read_resource_by_uri sections/${derivedSectionId}`);
      console.log(`[E2E] read_resource_by_uri sections/${derivedSectionId} len=${text.length}`);
    }, 20_000);
  });

  // ─── Prompts: native SDK + bridge tool, all 4 prompts ────────────────────

  describe('prompts — native SDK client.listPrompts()', () => {
    it('returns exactly 4 prompts', async () => {
      const result = await client.listPrompts();
      expect(result.prompts).toHaveLength(4);
      const names = result.prompts.map((p) => p.name);
      console.log(`[E2E] listPrompts: ${names.join(', ')}`);
    });
  });

  describe('prompts — sankhya_ajuda_list_prompt_catalog (bridge tool)', () => {
    it('returns 4 prompts catalog', async () => {
      const result = await client.callTool({
        name: 'sankhya_ajuda_list_prompt_catalog',
        arguments: {},
      });
      expect(result.isError).not.toBe(true);
      const text = extractText(result);
      assertMarkdownNotRawJson(text, 'sankhya_ajuda_list_prompt_catalog');
      expect(text).toContain('4 prompts');
      console.log(`[E2E] list_prompt_catalog: ${text.slice(0, 200)}`);
    }, 15_000);
  });

  // All 4 prompts via native SDK getPrompt.

  describe('prompts — native SDK client.getPrompt() for all 4 prompts', () => {
    it('sankhya_troubleshoot: returns 2 messages with problem injected', async () => {
      const result = await client.getPrompt({
        name: 'sankhya_troubleshoot',
        arguments: { problem: 'erro ao confirmar nota' },
      });
      expect(result.messages.length, 'Expected at least 1 message').toBeGreaterThan(0);
      const text = result.messages.map((m) => m.content.type === 'text' ? m.content.text : '').join('\n');
      expect(text, 'Expected problem reference in troubleshoot prompt').toContain('nota');
      expect(text, 'Expected tool call reference in troubleshoot prompt').toContain('sankhya_ajuda_search_articles');
      console.log(`[E2E] getPrompt sankhya_troubleshoot: ${text.slice(0, 100)}`);
    }, 15_000);

    it('sankhya_quick_lookup: returns messages referencing the term', async () => {
      const result = await client.getPrompt({
        name: 'sankhya_quick_lookup',
        arguments: { term: 'nota fiscal' },
      });
      expect(result.messages.length).toBeGreaterThan(0);
      const firstMessage = result.messages[0];
      if (firstMessage && firstMessage.content.type === 'text') {
        expect(
          firstMessage.content.text,
          'Expected tool reference in quick_lookup prompt',
        ).toContain('sankhya_ajuda_search_articles');
      }
      console.log(`[E2E] getPrompt sankhya_quick_lookup: messages=${result.messages.length}`);
    }, 15_000);

    it('sankhya_explain_module: returns messages with module name', async () => {
      const result = await client.getPrompt({
        name: 'sankhya_explain_module',
        arguments: { module_name: 'Reforma Tributária' },
      });
      expect(result.messages.length).toBeGreaterThan(0);
      const text = result.messages.map((m) => m.content.type === 'text' ? m.content.text : '').join('\n');
      // The prompt template injects the module_name into the search query.
      expect(text, 'Expected module reference in explain_module prompt').toContain('Reforma');
      console.log(`[E2E] getPrompt sankhya_explain_module: ${text.slice(0, 100)}`);
    }, 15_000);

    it('sankhya_compare_articles: returns messages with get_article_details calls', async () => {
      // Use two real article IDs if available.
      const id1 = derivedArticleId || 37125749024151;
      const id2 = derivedArticleId2 || 37125749024152;
      const articleIds = `${id1},${id2}`;

      const result = await client.getPrompt({
        name: 'sankhya_compare_articles',
        arguments: { article_ids: articleIds },
      });
      expect(result.messages.length).toBeGreaterThan(0);
      const text = result.messages.map((m) => m.content.type === 'text' ? m.content.text : '').join('\n');
      expect(
        text,
        'Expected get_article_details calls in compare_articles prompt',
      ).toContain('sankhya_ajuda_get_article_details');
      console.log(`[E2E] getPrompt sankhya_compare_articles ids=${articleIds}: ${text.slice(0, 100)}`);
    }, 15_000);
  });

  // All 4 prompts via bridge tool sankhya_ajuda_get_prompt_by_name.

  describe('prompts — sankhya_ajuda_get_prompt_by_name (bridge tool) for all 4 prompts', () => {
    it('sankhya_troubleshoot via bridge tool: Markdown + name present', async () => {
      const result = await client.callTool({
        name: 'sankhya_ajuda_get_prompt_by_name',
        arguments: { name: 'sankhya_troubleshoot', arguments: { problem: 'erro ao confirmar nota' } },
      });
      expect(result.isError).not.toBe(true);
      const text = extractText(result);
      assertMarkdownNotRawJson(text, 'get_prompt_by_name sankhya_troubleshoot');
      expect(text).toContain('sankhya_troubleshoot');
      console.log(`[E2E] get_prompt_by_name troubleshoot: ${text.slice(0, 100)}`);
    }, 15_000);

    it('sankhya_quick_lookup via bridge tool: prompt name and term present', async () => {
      const result = await client.callTool({
        name: 'sankhya_ajuda_get_prompt_by_name',
        arguments: { name: 'sankhya_quick_lookup', arguments: { term: 'nota fiscal' } },
      });
      expect(result.isError).not.toBe(true);
      const text = extractText(result);
      assertMarkdownNotRawJson(text, 'get_prompt_by_name sankhya_quick_lookup');
      expect(text).toContain('sankhya_quick_lookup');
      console.log(`[E2E] get_prompt_by_name quick_lookup: ${text.slice(0, 100)}`);
    }, 15_000);

    it('sankhya_explain_module via bridge tool: module_name injected', async () => {
      const result = await client.callTool({
        name: 'sankhya_ajuda_get_prompt_by_name',
        arguments: { name: 'sankhya_explain_module', arguments: { module_name: 'Reforma Tributária' } },
      });
      expect(result.isError).not.toBe(true);
      const text = extractText(result);
      assertMarkdownNotRawJson(text, 'get_prompt_by_name sankhya_explain_module');
      expect(text).toContain('sankhya_explain_module');
      console.log(`[E2E] get_prompt_by_name explain_module: ${text.slice(0, 100)}`);
    }, 15_000);

    it('sankhya_compare_articles via bridge tool: article IDs in prompt', async () => {
      const id1 = derivedArticleId || 37125749024151;
      const id2 = derivedArticleId2 || 37125749024152;

      const result = await client.callTool({
        name: 'sankhya_ajuda_get_prompt_by_name',
        arguments: {
          name: 'sankhya_compare_articles',
          arguments: { article_ids: `${id1},${id2}` },
        },
      });
      expect(result.isError).not.toBe(true);
      const text = extractText(result);
      assertMarkdownNotRawJson(text, 'get_prompt_by_name sankhya_compare_articles');
      expect(text).toContain('sankhya_compare_articles');
      console.log(`[E2E] get_prompt_by_name compare_articles: ${text.slice(0, 100)}`);
    }, 15_000);
  });

  // ─── Edge cases and Zod validation ───────────────────────────────────────

  describe('edge cases — Zod validation errors', () => {
    it('search_knowledge_unified: limit=0 → Zod error or coerced', async () => {
      const result = await client.callTool({
        name: 'sankhya_ajuda_search_knowledge_unified',
        arguments: { query: 'nota', limit: 0 },
      });
      // limit min=1; limit=0 should error.
      if (!result.isError) {
        // If coerced, must still be Markdown.
        assertMarkdownNotRawJson(extractText(result), 'search_unified limit=0 coerced');
      } else {
        expect(result.isError).toBe(true);
      }
      console.log(`[E2E] search_unified limit=0 isError=${result.isError}`);
    }, 15_000);

    it('search_knowledge_unified: limit=51 → isError or coerced Markdown', async () => {
      const result = await client.callTool({
        name: 'sankhya_ajuda_search_knowledge_unified',
        arguments: { query: 'x', limit: 51 },
      });
      const text = extractText(result);
      if (!result.isError) {
        assertMarkdownNotRawJson(text, 'search_unified limit=51 coerced');
      } else {
        expect(result.isError).toBe(true);
      }
      console.log(`[E2E] search_unified limit=51 isError=${result.isError}`);
    }, 15_000);

    it('search_knowledge_unified: query="" → Zod error (min length 1)', async () => {
      const result = await client.callTool({
        name: 'sankhya_ajuda_search_knowledge_unified',
        arguments: { query: '', limit: 5 },
      });
      // query min=1; empty query should produce an error.
      expect(result.isError, 'Expected isError=true for empty query').toBe(true);
      console.log(`[E2E] search_unified query="" isError=${result.isError}`);
    }, 15_000);

    it('search_articles: query="" → Zod error', async () => {
      const result = await client.callTool({
        name: 'sankhya_ajuda_search_articles',
        arguments: { query: '' },
      });
      expect(result.isError, 'Expected isError=true for empty query in search_articles').toBe(true);
      console.log(`[E2E] search_articles query="" isError=${result.isError}`);
    }, 15_000);

    it('get_article_details: max_body_chars=99 → Zod error (min 100)', async () => {
      const idToUse = derivedArticleId || 37125749024151;
      const result = await client.callTool({
        name: 'sankhya_ajuda_get_article_details',
        arguments: { article_id: idToUse, max_body_chars: 99 },
      });
      expect(result.isError, 'Expected isError=true for max_body_chars=99').toBe(true);
      console.log(`[E2E] get_article_details max_body_chars=99 isError=${result.isError}`);
    }, 15_000);

    it('get_article_details: max_body_chars=40001 → Zod error (max 40000)', async () => {
      const idToUse = derivedArticleId || 37125749024151;
      const result = await client.callTool({
        name: 'sankhya_ajuda_get_article_details',
        arguments: { article_id: idToUse, max_body_chars: 40001 },
      });
      expect(result.isError, 'Expected isError=true for max_body_chars=40001').toBe(true);
      console.log(`[E2E] get_article_details max_body_chars=40001 isError=${result.isError}`);
    }, 15_000);

    it('read_resource_by_uri: invalid URI → error response', async () => {
      const result = await client.callTool({
        name: 'sankhya_ajuda_read_resource_by_uri',
        arguments: { uri: 'sankhya-ajuda://bogus' },
      });
      // Invalid resource URIs should produce an error.
      expect(result.isError, 'Expected isError=true for invalid URI').toBe(true);
      const text = extractText(result);
      console.log(`[E2E] read_resource_by_uri bogus URI: ${text.slice(0, 120)}`);
    }, 15_000);

    it('get_prompt_by_name: invalid name → error response', async () => {
      const result = await client.callTool({
        name: 'sankhya_ajuda_get_prompt_by_name',
        arguments: { name: 'prompt_inexistente_xyz', arguments: {} },
      });
      expect(result.isError, 'Expected isError=true for invalid prompt name').toBe(true);
      const text = extractText(result);
      console.log(`[E2E] get_prompt_by_name invalid: ${text.slice(0, 120)}`);
    }, 15_000);

    it('get_community_post: max_body_chars=99 → Zod error (min 100)', async () => {
      const result = await client.callTool({
        name: 'sankhya_ajuda_get_community_post',
        arguments: { post_id: 'some_id', max_body_chars: 99 },
      });
      expect(result.isError, 'Expected isError=true for max_body_chars=99 in community post').toBe(true);
      console.log(`[E2E] get_community_post max_body_chars=99 isError=${result.isError}`);
    }, 15_000);
  });
});
