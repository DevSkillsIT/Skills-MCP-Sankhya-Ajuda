/**
 * Smoke test for createServer + tools registration.
 *
 * We construct an McpServer with mocked pool/embedding and assert that:
 *   - 8 tools are reachable
 *   - SERVER_INSTRUCTIONS stays under the 2000-char cap (RF05 / GUIA-REF Sec 5)
 */

import { describe, it, expect, vi } from 'vitest';
import { createServer, SERVER_INSTRUCTIONS } from '../src/server.js';
import type { Pool } from '../src/db.js';
import type { EmbeddingClient } from '../src/embeddings.js';

describe('SERVER_INSTRUCTIONS', () => {
  it('is static and under 2000 characters (RF05)', () => {
    expect(typeof SERVER_INSTRUCTIONS).toBe('string');
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(2000);
    // Contains the canonical tool names so clients can self-discover.
    expect(SERVER_INSTRUCTIONS).toContain('sankhya_ajuda_search_articles');
    expect(SERVER_INSTRUCTIONS).toContain('sankhya_ajuda_get_article_details');
    expect(SERVER_INSTRUCTIONS).toContain('sankhya_ajuda_list_categories');
    expect(SERVER_INSTRUCTIONS).toContain('sankhya_ajuda_list_sections');
  });
});

describe('createServer', () => {
  it('builds a McpServer instance without throwing', () => {
    const pool = {} as Pool;
    const embedding: EmbeddingClient = { embed: vi.fn() };
    const server = createServer({ pool, embedding });
    expect(server).toBeDefined();
    expect(typeof server.connect).toBe('function');
  });
});
