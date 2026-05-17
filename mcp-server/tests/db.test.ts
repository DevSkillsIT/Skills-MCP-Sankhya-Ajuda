/**
 * Unit tests for db.ts query builders.
 * Pool.query is stubbed — these tests verify SQL shape and parameter order,
 * not real database behavior.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  hybridSearch,
  getArticleFull,
  listCategories,
  listSections,
  getSyncState,
} from '../src/db.js';
import type { Pool } from '../src/db.js';

function makePool(rows: unknown[] = []): { pool: Pool; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn().mockResolvedValue({ rows, rowCount: rows.length });
  const pool = { query } as unknown as Pool;
  return { pool, query };
}

describe('hybridSearch — SQL shape', () => {
  it('keyword mode never references embedding columns', async () => {
    const { pool, query } = makePool([]);
    await hybridSearch(pool, {
      query: 'nf-e',
      qvec: null,
      limit: 5,
      categoryId: null,
      includeOutdated: false,
      mode: 'keyword',
    });
    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toContain('plainto_tsquery');
    expect(sql).not.toMatch(/<=>|halfvec/);
  });

  it('semantic mode runs without ts_rank_cd when qvec is provided', async () => {
    const { pool, query } = makePool([]);
    const vec = Array.from({ length: 2560 }, () => 0.1);
    await hybridSearch(pool, {
      query: 'nfe',
      qvec: vec,
      limit: 5,
      categoryId: null,
      includeOutdated: false,
      mode: 'semantic',
    });
    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toContain('halfvec');
    expect(sql).not.toContain('ts_rank_cd');
  });

  it('hybrid mode includes both CTEs and uses RRF k=60 (default)', async () => {
    const { pool, query } = makePool([]);
    const vec = Array.from({ length: 2560 }, () => 0.1);
    await hybridSearch(pool, {
      query: 'nfe',
      qvec: vec,
      limit: 5,
      categoryId: null,
      includeOutdated: false,
      mode: 'hybrid',
    });
    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toContain('WITH semantic');
    expect(sql).toContain('keyword');
    expect(sql).toContain('fused');
    expect(sql).toContain('SUM(1.0 / ($6::int + rank))');
    // a.outdated must appear in the SELECT (CI-08)
    expect(sql).toContain('a.outdated');
    const args = query.mock.calls[0]?.[1] as unknown[];
    expect(args[5]).toBe(60); // default k
  });

  it('hybrid mode falls back to keyword path when qvec is null', async () => {
    const { pool, query } = makePool([]);
    await hybridSearch(pool, {
      query: 'nfe',
      qvec: null,
      limit: 5,
      categoryId: null,
      includeOutdated: false,
      mode: 'hybrid',
    });
    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toContain('ts_rank_cd');
    expect(sql).not.toMatch(/<=>|halfvec/);
  });

  it('semantic mode returns [] when qvec is null', async () => {
    const { pool, query } = makePool([]);
    const out = await hybridSearch(pool, {
      query: 'nfe',
      qvec: null,
      limit: 5,
      categoryId: null,
      includeOutdated: false,
      mode: 'semantic',
    });
    expect(out).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('parses rows back into typed SearchHit values', async () => {
    const { pool } = makePool([
      {
        id: '12345',
        title: 'NF-e',
        breadcrumb: 'x > y',
        html_url: 'https://example/12345',
        outdated: false,
        score: '0.871',
      },
    ]);
    const out = await hybridSearch(pool, {
      query: 'nf-e',
      qvec: null,
      limit: 1,
      categoryId: null,
      includeOutdated: false,
      mode: 'keyword',
    });
    expect(out[0]).toEqual({
      id: 12345,
      title: 'NF-e',
      breadcrumb: 'x > y',
      html_url: 'https://example/12345',
      outdated: false,
      score: 0.871,
    });
  });
});

describe('getArticleFull — truncation logic', () => {
  it('returns null when no row found', async () => {
    const { pool } = makePool([]);
    const out = await getArticleFull(pool, 42, 6000);
    expect(out).toBeNull();
  });

  it('truncates body_text to max_body_chars and reports full length', async () => {
    const { pool } = makePool([
      {
        id: 1,
        section_id: 10,
        title: 'X',
        breadcrumb: null,
        body_text: 'a'.repeat(500),
        html_url: 'https://example/1',
        label_names: ['tag'],
        outdated: false,
        author_id: null,
        created_at: null,
        updated_at: null,
        edited_at: null,
        synced_at: new Date('2026-05-15T03:00:00Z'),
      },
    ]);
    const out = await getArticleFull(pool, 1, 100);
    expect(out).not.toBeNull();
    expect(out?.body_text.length).toBe(100);
    expect(out?.body_text_truncated).toBe(true);
    expect(out?.body_text_full_chars).toBe(500);
  });

  it('handles huge articles up to the new 40000 cap (P99 outlier coverage)', async () => {
    const { pool } = makePool([
      {
        id: 1,
        section_id: 10,
        title: 'X',
        breadcrumb: null,
        body_text: 'a'.repeat(50000),
        html_url: 'https://example/1',
        label_names: null,
        outdated: false,
        author_id: null,
        created_at: null,
        updated_at: null,
        edited_at: null,
        synced_at: new Date('2026-05-15T03:00:00Z'),
      },
    ]);
    const out = await getArticleFull(pool, 1, 40000);
    expect(out?.body_text.length).toBe(40000);
    expect(out?.body_text_truncated).toBe(true);
    expect(out?.body_text_full_chars).toBe(50000);
  });

  it('keeps body_text intact when shorter than max_body_chars', async () => {
    const { pool } = makePool([
      {
        id: 1,
        section_id: 10,
        title: 'X',
        breadcrumb: 'a > b',
        body_text: 'short',
        html_url: 'https://example/1',
        label_names: null,
        outdated: false,
        author_id: 42,
        created_at: new Date('2023-01-01T00:00:00Z'),
        updated_at: new Date('2024-01-01T00:00:00Z'),
        edited_at: null,
        synced_at: new Date('2026-05-15T03:00:00Z'),
      },
    ]);
    const out = await getArticleFull(pool, 1, 100);
    expect(out?.body_text).toBe('short');
    expect(out?.body_text_truncated).toBe(false);
    expect(out?.label_names).toEqual([]);
    expect(out?.author_id).toBe(42);
  });
});

describe('listCategories / listSections', () => {
  it('listCategories maps numeric strings to numbers and ISO dates', async () => {
    const { pool } = makePool([
      {
        id: '1',
        name: 'Cat',
        html_url: 'https://example/1',
        position: 0,
        synced_at: new Date('2026-05-15T03:00:00Z'),
        article_count: '100',
      },
    ]);
    const rows = await listCategories(pool);
    expect(rows[0]).toMatchObject({
      id: 1,
      name: 'Cat',
      article_count: 100,
      synced_at: '2026-05-15T03:00:00.000Z',
    });
  });

  it('listSections passes filters as numbered SQL parameters', async () => {
    const { pool, query } = makePool([]);
    await listSections(pool, 1, 2);
    const args = query.mock.calls[0]?.[1] as unknown[];
    expect(args).toEqual([1, 2]);
  });
});

describe('getSyncState', () => {
  it('reports sync_state status and article counters', async () => {
    const { pool, query } = makePool([
      {
        articles_count: '6123',
        with_embedding_count: '6123',
        last_sync_status: 'ok',
        last_sync_at: new Date('2026-05-15T03:00:00Z'),
        error_count: '0',
        last_error: null,
      },
    ]);
    const state = await getSyncState(pool);
    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toContain('FROM sync_state ss');
    expect(sql).toContain('ss.last_status AS last_sync_status');
    expect(state.last_sync_status).toBe('ok');
    expect(state.articles_count).toBe(6123);
    expect(state.with_embedding_count).toBe(6123);
    expect(state.last_sync_at).toBe('2026-05-15T03:00:00.000Z');
    expect(state.error_count).toBe(0);
    expect(state.last_error).toBeNull();
  });

  it('reports failed sync state instead of inferring ok from articles', async () => {
    const { pool } = makePool([
      {
        articles_count: '6123',
        with_embedding_count: '6120',
        last_sync_status: 'error',
        last_sync_at: null,
        error_count: '2',
        last_error: 'Zendesk timeout',
      },
    ]);
    const state = await getSyncState(pool);
    expect(state.last_sync_status).toBe('error');
    expect(state.last_sync_at).toBeNull();
    expect(state.error_count).toBe(2);
    expect(state.last_error).toBe('Zendesk timeout');
  });
});
