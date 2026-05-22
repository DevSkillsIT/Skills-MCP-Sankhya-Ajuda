/**
 * Static compliance audit — AC08 regression guard.
 *
 * Introspects the registered tool set by spinning up an McpServer with
 * registerAllTools using a mocked context and asserts the full set of
 * naming and annotation constraints that must never regress.
 *
 * Assertions:
 *   AC08 — exactly 11 tools; the 8 existing names present and unchanged.
 *   — every tool has all four annotation hints.
 *   — every tool name starts with `sankhya_ajuda_` and is 25-64 chars.
 *   — every description is 280-400 chars and contains "Sankhya" at least twice.
 *
 * No DB, no network — fully deterministic.
 */

import { describe, it, expect, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools } from '../src/tools/working-index.js';
import type { ToolContext } from '../src/tools/working-index.js';
import type { Pool } from '../src/db.js';
import type { EmbeddingClient } from '../src/embeddings.js';

// ─── Minimal McpServer stub that captures tool registrations ─────────────────

interface CapturedTool {
  name: string;
  description: string;
  annotations: Record<string, unknown>;
}

function buildCapturingServer(): { server: McpServer; getTools: () => CapturedTool[] } {
  const tools: CapturedTool[] = [];
  const server = {
    registerTool: (
      name: string,
      config: {
        description?: string;
        annotations?: Record<string, unknown>;
        [key: string]: unknown;
      },
    ) => {
      tools.push({
        name,
        description: config.description ?? '',
        annotations: config.annotations ?? {},
      });
    },
  } as unknown as McpServer;
  return { server, getTools: () => tools };
}

function buildMockCtx(): ToolContext {
  return {
    pool: {} as Pool,
    embedding: { embed: vi.fn() } as EmbeddingClient,
    embeddingProvider: 'vllm',
    indexCompatible: true,
  };
}

// ─── The 8 existing tool names that must never change (AC08 regression guard) ─

const EXISTING_TOOL_NAMES = [
  'sankhya_ajuda_search_articles',
  'sankhya_ajuda_get_article_details',
  'sankhya_ajuda_list_categories',
  'sankhya_ajuda_list_sections',
  'sankhya_ajuda_list_mcp_resources',
  'sankhya_ajuda_read_resource_by_uri',
  'sankhya_ajuda_list_prompt_catalog',
  'sankhya_ajuda_get_prompt_by_name',
] as const;

// The 3 new tools added by SPEC-SANKHYA-COMMUNITY-001
const NEW_TOOL_NAMES = [
  'sankhya_ajuda_search_knowledge_unified',
  'sankhya_ajuda_get_community_post',
  'sankhya_ajuda_list_community_spaces',
] as const;

const ALL_EXPECTED_NAMES = [...EXISTING_TOOL_NAMES, ...NEW_TOOL_NAMES] as const;

// ─── Collect tools once for all assertions ────────────────────────────────────

const { server, getTools } = buildCapturingServer();
registerAllTools(server, buildMockCtx());
const registeredTools = getTools();

// ─── AC08: Exactly 11 tools ───────────────────────────────────────────────────

describe('AC08 — tool count and names', () => {
  it('registers exactly 11 tools', () => {
    expect(registeredTools).toHaveLength(11);
  });

  it('all 8 existing tool names are present and unchanged', () => {
    const registeredNames = new Set(registeredTools.map((t) => t.name));
    for (const name of EXISTING_TOOL_NAMES) {
      expect(registeredNames, `Missing existing tool: ${name}`).toContain(name);
    }
  });

  it('all 3 new community/unified tool names are present', () => {
    const registeredNames = new Set(registeredTools.map((t) => t.name));
    for (const name of NEW_TOOL_NAMES) {
      expect(registeredNames, `Missing new tool: ${name}`).toContain(name);
    }
  });

  it('registered names match the expected full set exactly (no extras, no missing)', () => {
    const registeredNames = registeredTools.map((t) => t.name).sort();
    const expectedNames = [...ALL_EXPECTED_NAMES].sort();
    expect(registeredNames).toEqual(expectedNames);
  });
});

// ─── Annotation hints (all 4 required on every tool) ─────────────────────────

describe('Annotation hints — all 4 required on every tool', () => {
  for (const tool of registeredTools) {
    it(`${tool.name} — has readOnlyHint`, () => {
      expect(
        Object.prototype.hasOwnProperty.call(tool.annotations, 'readOnlyHint'),
        `${tool.name} missing readOnlyHint`,
      ).toBe(true);
    });

    it(`${tool.name} — has destructiveHint`, () => {
      expect(
        Object.prototype.hasOwnProperty.call(tool.annotations, 'destructiveHint'),
        `${tool.name} missing destructiveHint`,
      ).toBe(true);
    });

    it(`${tool.name} — has openWorldHint`, () => {
      expect(
        Object.prototype.hasOwnProperty.call(tool.annotations, 'openWorldHint'),
        `${tool.name} missing openWorldHint`,
      ).toBe(true);
    });

    it(`${tool.name} — has idempotentHint`, () => {
      expect(
        Object.prototype.hasOwnProperty.call(tool.annotations, 'idempotentHint'),
        `${tool.name} missing idempotentHint`,
      ).toBe(true);
    });
  }
});

// ─── Naming guidelines ────────────────────────────────────────────────────────

describe('Naming guidelines — prefix and length', () => {
  for (const tool of registeredTools) {
    it(`${tool.name} — starts with "sankhya_ajuda_"`, () => {
      expect(
        tool.name.startsWith('sankhya_ajuda_'),
        `${tool.name} does not start with sankhya_ajuda_`,
      ).toBe(true);
    });

    it(`${tool.name} — name length 25-64 chars (got ${tool.name.length})`, () => {
      expect(tool.name.length).toBeGreaterThanOrEqual(25);
      expect(tool.name.length).toBeLessThanOrEqual(64);
    });
  }
});

// ─── Description quality ─────────────────────────────────────────────────────

describe('Description quality — 280-400 chars, "Sankhya" >= 2x', () => {
  for (const tool of registeredTools) {
    it(`${tool.name} — description 280-400 chars (got ${tool.description.length})`, () => {
      expect(
        tool.description.length,
        `${tool.name} description too short: ${tool.description.length} chars`,
      ).toBeGreaterThanOrEqual(280);
      expect(
        tool.description.length,
        `${tool.name} description too long: ${tool.description.length} chars`,
      ).toBeLessThanOrEqual(400);
    });

    it(`${tool.name} — description contains "Sankhya" at least 2 times`, () => {
      const count = (tool.description.match(/Sankhya/g) ?? []).length;
      expect(
        count,
        `${tool.name} description contains "Sankhya" ${count} time(s), need >= 2`,
      ).toBeGreaterThanOrEqual(2);
    });
  }
});

// ─── Summary diagnostic (printed on failure for easy triage) ─────────────────

describe('Audit summary — diagnostic snapshot', () => {
  it('prints tool audit table (always passes, informational only)', () => {
    const rows = registeredTools.map((t) => ({
      name: t.name,
      nameLen: t.name.length,
      descLen: t.description.length,
      sankhyaCount: (t.description.match(/Sankhya/g) ?? []).length,
      hasAllAnnotations:
        'readOnlyHint' in t.annotations &&
        'destructiveHint' in t.annotations &&
        'openWorldHint' in t.annotations &&
        'idempotentHint' in t.annotations,
    }));

    // This log is visible in vitest verbose output for human review.
    console.warn('\n=== Tool Audit Table ===');
    for (const row of rows) {
      const status =
        row.nameLen >= 25 &&
        row.nameLen <= 64 &&
        row.descLen >= 280 &&
        row.descLen <= 400 &&
        row.sankhyaCount >= 2 &&
        row.hasAllAnnotations
          ? 'PASS'
          : 'FAIL';
      console.warn(
        `[${status}] ${row.name} | nameLen=${row.nameLen} | descLen=${row.descLen} | Sankhya×${row.sankhyaCount} | allAnnotations=${row.hasAllAnnotations}`,
      );
    }
    console.warn('========================\n');

    // Guarantee this test always passes — it is informational only.
    expect(rows).toHaveLength(11);
  });
});
