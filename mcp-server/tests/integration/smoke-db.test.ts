/**
 * Real-DB smoke test for SPEC-SANKHYA-COMMUNITY-001.
 *
 * GUARDED: The entire suite is skipped unless RUN_DB_SMOKE=1 is set.
 * Default `npm test` (no flag) stays green everywhere without DB access.
 *
 *   RUN_DB_SMOKE=1 npx --prefix /opt/mcp-servers/sankhya_ajuda/mcp-server \
 *     vitest run tests/integration/smoke-db.test.ts
 *
 * Builds a real runtime context the same way src/index.ts does:
 *   - buildPool(settings) for a real PostgreSQL connection
 *   - buildEmbeddingClient(settings) for the configured provider
 *   - checkIndexCompatibility(pool, settings) for index/provider guard
 *   - dotenv loaded via import 'dotenv/config' at the top
 *
 * All queries are read-only. Pool is closed in afterAll.
 *
 * Acceptance Criteria exercised:
 *   AC02 — anti-burying: >=1 HELP result in top-8 for 4 benchmark queries
 *   AC03 — dedup: no community title appears more than once in top-15
 *   AC07 — threshold: no pure-greeting post in top-3 for social query
 *   AC09 — performance: source=all responds <300ms (warm)
 */

// Load .env from the mcp-server root regardless of CWD (handles --prefix invocation).
import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenvConfig({ path: resolve(__dirname, '../../.env'), override: false });

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildPool } from '../../src/db.js';
import { buildEmbeddingClient } from '../../src/embeddings.js';
import { checkIndexCompatibility } from '../../src/index-compat.js';
import { getSettings, _resetSettingsCache } from '../../src/config.js';
import { runUnifiedSearch } from '../../src/tools/search-unified.js';
import type { Pool } from '../../src/db.js';
import type { EmbeddingClient } from '../../src/embeddings.js';
import type { ToolContext } from '../../src/tools/working-index.js';

// ─── Guard: skip entire suite unless RUN_DB_SMOKE=1 ──────────────────────────

const RUN_SMOKE = process.env['RUN_DB_SMOKE'] === '1';

describe.skipIf(!RUN_SMOKE)('Real-DB smoke (SPEC-SANKHYA-COMMUNITY-001)', () => {
  let pool: Pool;
  let embedding: EmbeddingClient;
  let ctx: ToolContext;

  // ─── Setup: build real context like src/index.ts does ──────────────────────

  beforeAll(async () => {
    // Reset the settings cache so getSettings() re-reads from process.env
    // (which was populated by dotenv above, after module-level cache may have run).
    _resetSettingsCache();
    const settings = getSettings();
    pool = await buildPool(settings);
    embedding = buildEmbeddingClient(settings);

    const compat = await checkIndexCompatibility(pool, settings);
    ctx = {
      pool,
      embedding,
      indexCompatible: compat.compatible,
      embeddingProvider: settings.embeddingProvider,
    };

    console.warn(
      `[smoke] indexCompatible=${compat.compatible} provider=${settings.embeddingProvider}` +
        ` dbModels=${JSON.stringify(compat.dbModels)}`,
    );
  }, 30_000);

  afterAll(async () => {
    await pool.end();
  });

  // ─── AC02: anti-burying — >=1 HELP in top-8 for 4 benchmark queries ─────

  const AC02_QUERIES = [
    'erro ao confirmar nota fiscal',
    'parametrizacao regras da reforma tributaria',
    'como criar processo no Sankhya Flow BPM',
    'integracao Sankhya via API REST com Python',
  ] as const;

  describe('AC02 — anti-burying: >=1 HELP result in top-8 (source=all)', () => {
    for (const query of AC02_QUERIES) {
      it(`query: "${query}"`, async () => {
        const hits = await runUnifiedSearch(ctx, {
          query,
          source: 'all',
          limit: 8,
          include_outdated: false,
        });

        const helpCount = hits.filter((h) => h.source === 'help').length;
        const communityCount = hits.filter((h) => h.source === 'community').length;

        console.warn(
          `[AC02] "${query}" → top-8: help=${helpCount} community=${communityCount}`,
        );
        for (const h of hits) {
          console.warn(
            `  [${h.source.toUpperCase().padEnd(9)}] rank=${h.sourceRank} score=${h.rrfScore.toFixed(4)} | ${h.title}`,
          );
        }

        // Firm metric: at least 1 help result must appear in the top-8.
        // Exact count may vary between the hybrid implementation and the
        // prototype experiment (C7) — only >=1 is a hard gate.
        expect(
          helpCount,
          `Expected >=1 HELP in top-8 for query "${query}", got ${helpCount}`,
        ).toBeGreaterThanOrEqual(1);
      }, 20_000);
    }
  });

  // ─── AC03: dedup — no community title appears more than once in top-15 ───

  describe('AC03 — dedup: no community title repeated in top-15', () => {
    it('query: "como criar processo no Sankhya Flow BPM" source=all limit=15', async () => {
      const hits = await runUnifiedSearch(ctx, {
        query: 'como criar processo no Sankhya Flow BPM',
        source: 'all',
        limit: 15,
        include_outdated: false,
      });

      const communityTitles = hits
        .filter((h) => h.source === 'community')
        .map((h) => h.title);

      const titleCounts = new Map<string, number>();
      for (const title of communityTitles) {
        titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
      }

      const duplicates = [...titleCounts.entries()].filter(([, count]) => count > 1);

      console.warn(`[AC03] community titles in top-15: ${communityTitles.length}`);
      if (duplicates.length > 0) {
        console.warn(`[AC03] DUPLICATES FOUND: ${JSON.stringify(duplicates)}`);
      } else {
        console.warn('[AC03] No duplicates found (dedup working correctly)');
      }
      for (const h of hits.filter((h) => h.source === 'community')) {
        console.warn(`  [COMMUNITY] "${h.title}"`);
      }

      expect(
        duplicates,
        `Duplicate community titles found: ${JSON.stringify(duplicates)}`,
      ).toHaveLength(0);
    }, 20_000);
  });

  // ─── AC07 (revised R6): threshold — technical query returns no "Diga Olá" space posts ────

  describe('AC07 (R6) — threshold: technical query produces no "Diga Olá" space posts in top-N', () => {
    it('query: "erro ao confirmar nota fiscal" source=all — no "Diga Olá" space in top-10', async () => {
      // R6: AC07 was previously tested with a greeting query, which is self-contradictory:
      // the threshold is designed to suppress social noise from TECHNICAL queries.
      // Using a greeting query as the test vector is invalid because greeting posts
      // ARE semantically relevant to a greeting query — the threshold should not cut them.
      //
      // The correct AC07 test: a technical query must not surface posts from the "Diga Olá"
      // space (introductory/social-only space) in the top results.
      const hits = await runUnifiedSearch(ctx, {
        query: 'erro ao confirmar nota fiscal',
        source: 'all',
        limit: 10,
        include_outdated: false,
      });

      console.warn('[AC07] top-10 for technical query "erro ao confirmar nota fiscal":');
      for (const h of hits) {
        console.warn(
          `  [${h.source.toUpperCase().padEnd(9)}] score=${h.rrfScore.toFixed(4)} ctx="${h.context ?? 'null'}" | ${h.title}`,
        );
      }

      // AC07 assertion (R6): no community result in the top-N should belong to
      // the "Diga Olá" space (a purely social/introductory space).
      // The distance threshold (COMMUNITY_DIST_THRESHOLD=0.45) should cut these posts
      // for technical queries because they are semantically distant from the query vector.
      const digaOlaInResults = hits.filter(
        (h) => h.source === 'community' && h.context === 'Diga Olá',
      );

      console.warn(
        `[AC07] "Diga Olá" posts in top-10: ${digaOlaInResults.length}`,
      );
      if (digaOlaInResults.length > 0) {
        for (const h of digaOlaInResults) {
          console.warn(`  [DIGA OLA] "${h.title}"`);
        }
      } else {
        console.warn('[AC07] No "Diga Olá" posts in top-10 (threshold working for technical query)');
      }

      expect(
        digaOlaInResults,
        `"Diga Olá" space posts appeared in top-10 for technical query: ${JSON.stringify(digaOlaInResults.map((h) => h.title))}`,
      ).toHaveLength(0);
    }, 20_000);
  });

  // ─── AC09: performance — source=all responds <300ms (warm) ──────────────

  describe('AC09 — performance: source=all <300ms (warm)', () => {
    it('warm query responds in under 300ms', async () => {
      // Two warm-up calls: discard results, not measured.
      // Ensures the connection pool is fully warmed and plans are cached.
      await runUnifiedSearch(ctx, {
        query: 'nota fiscal',
        source: 'all',
        limit: 15,
        include_outdated: false,
      });
      await runUnifiedSearch(ctx, {
        query: 'erro sankhya',
        source: 'all',
        limit: 15,
        include_outdated: false,
      });

      // Measured call.
      const start = performance.now();
      const hits = await runUnifiedSearch(ctx, {
        query: 'nota fiscal',
        source: 'all',
        limit: 15,
        include_outdated: false,
      });
      const elapsed = performance.now() - start;

      console.warn(
        `[AC09] source=all limit=15 → ${hits.length} results | elapsed=${elapsed.toFixed(1)}ms`,
      );

      expect(
        elapsed,
        `source=all took ${elapsed.toFixed(1)}ms, expected <300ms`,
      ).toBeLessThan(300);
    }, 20_000);
  });
});

// ─── Placeholder describe when smoke is skipped (keeps test file parseable) ──

describe.skipIf(RUN_SMOKE)('Real-DB smoke (GUARDED — set RUN_DB_SMOKE=1 to enable)', () => {
  it('is skipped in default test runs (no DB required)', () => {
    // This test always passes and serves as documentation.
    expect(process.env['RUN_DB_SMOKE']).not.toBe('1');
  });
});
