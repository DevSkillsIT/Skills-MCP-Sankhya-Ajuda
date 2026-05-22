/**
 * Unit tests for db.ts query builders.
 * Pool.query is stubbed — these tests verify SQL shape and parameter order,
 * not real database behavior.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  hybridSearch,
  getArticleFull,
  listCategories,
  listSections,
  getSyncState,
  hybridSearchCommunity,
  getCommunityPost,
  listCommunitySpaces,
  decodeBodyText,
  buildPool,
} from '../src/db.js';
import type { Pool } from '../src/db.js';
import pg from 'pg';

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
    // R3: similarity is null in keyword-only mode (no vector query available).
    expect(out[0]).toEqual({
      id: 12345,
      title: 'NF-e',
      breadcrumb: 'x > y',
      html_url: 'https://example/12345',
      outdated: false,
      score: 0.871,
      similarity: null,
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

// ─── AC14: hybridSearch — distThreshold must not alter existing SQL ───────────

describe('hybridSearch — distThreshold (AC14)', () => {
  it('produces identical SQL params when distThreshold is absent vs. no-threshold call', async () => {
    const vec = Array.from({ length: 2560 }, () => 0.1);

    const { pool: pool1, query: q1 } = makePool([]);
    await hybridSearch(pool1, {
      query: 'nfe',
      qvec: vec,
      limit: 5,
      categoryId: null,
      includeOutdated: false,
      mode: 'hybrid',
    });

    const { pool: pool2, query: q2 } = makePool([]);
    await hybridSearch(pool2, {
      query: 'nfe',
      qvec: vec,
      limit: 5,
      categoryId: null,
      includeOutdated: false,
      mode: 'hybrid',
      distThreshold: null,
    });

    // Both calls must produce identical SQL and identical param arrays.
    expect(q1.mock.calls[0]?.[0]).toBe(q2.mock.calls[0]?.[0]);
    expect(q1.mock.calls[0]?.[1]).toEqual(q2.mock.calls[0]?.[1]);
  });

  it('injects distance predicate into semantic CTE when distThreshold is a number', async () => {
    const vec = Array.from({ length: 2560 }, () => 0.1);
    const { pool, query } = makePool([]);
    await hybridSearch(pool, {
      query: 'nfe',
      qvec: vec,
      limit: 5,
      categoryId: null,
      includeOutdated: false,
      mode: 'hybrid',
      distThreshold: 0.45,
    });
    const sql = query.mock.calls[0]?.[0] as string;
    // Predicate must appear inside the semantic CTE block, before the keyword CTE.
    const semanticBlock = sql.substring(sql.indexOf('WITH semantic'), sql.indexOf('keyword AS'));
    expect(semanticBlock).toContain('<= 0.45');
    // Predicate must NOT appear inside the keyword CTE block.
    const keywordBlock = sql.substring(sql.indexOf('keyword AS'), sql.indexOf('fused AS'));
    expect(keywordBlock).not.toContain('<= 0.45');
  });

  it('keyword mode ignores distThreshold (no distance predicate anywhere)', async () => {
    const { pool, query } = makePool([]);
    await hybridSearch(pool, {
      query: 'nfe',
      qvec: null,
      limit: 5,
      categoryId: null,
      includeOutdated: false,
      mode: 'keyword',
      distThreshold: 0.45,
    });
    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).not.toContain('<=>');
    expect(sql).not.toContain('<= 0.45');
  });
});

// ─── hybridSearchCommunity ────────────────────────────────────────────────────

describe('hybridSearchCommunity — SQL shape and result mapping', () => {
  it('keyword mode never references halfvec / embedding columns', async () => {
    const { pool, query } = makePool([]);
    await hybridSearchCommunity(pool, {
      query: 'processo',
      qvec: null,
      limit: 5,
      mode: 'keyword',
    });
    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toContain('plainto_tsquery');
    expect(sql).not.toMatch(/<=>|halfvec/);
  });

  it('hybrid mode contains all three CTEs and RRF formula', async () => {
    const vec = Array.from({ length: 2560 }, () => 0.1);
    const { pool, query } = makePool([]);
    await hybridSearchCommunity(pool, {
      query: 'processo',
      qvec: vec,
      limit: 5,
      mode: 'hybrid',
    });
    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toContain('WITH semantic');
    expect(sql).toContain('keyword');
    expect(sql).toContain('fused');
    expect(sql).toContain('SUM(1.0 / ($4::int + rank))');
    expect(sql).toContain("status = 'PUBLISHED'");
  });

  it('hybrid mode injects distThreshold into semantic CTE only (C5)', async () => {
    const vec = Array.from({ length: 2560 }, () => 0.1);
    const { pool, query } = makePool([]);
    await hybridSearchCommunity(pool, {
      query: 'processo',
      qvec: vec,
      limit: 5,
      mode: 'hybrid',
      distThreshold: 0.45,
    });
    const sql = query.mock.calls[0]?.[0] as string;
    const semanticBlock = sql.substring(sql.indexOf('WITH semantic'), sql.indexOf('keyword AS'));
    const keywordBlock = sql.substring(sql.indexOf('keyword AS'), sql.indexOf('fused AS'));
    expect(semanticBlock).toContain('<= 0.45');
    expect(keywordBlock).not.toContain('<= 0.45');
  });

  it('maps result rows preserving id as string and coercing score to number', async () => {
    const { pool } = makePool([
      {
        id: 'TXT_ALPHA',
        title: 'Processo no Flow',
        context: 'Espaço de Treinamento',
        url: 'https://community.sankhya.com.br/post/TXT_ALPHA',
        score: '0.0163',
        has_accepted_answer: false,
        replies_count: '2',
      },
    ]);
    const out = await hybridSearchCommunity(pool, {
      query: 'processo',
      qvec: null,
      limit: 5,
      mode: 'keyword',
    });
    // R3: similarity is null in keyword-only mode; R8: has_accepted_answer and replies_count present.
    expect(out[0]).toEqual({
      id: 'TXT_ALPHA',
      title: 'Processo no Flow',
      context: 'Espaço de Treinamento',
      url: 'https://community.sankhya.com.br/post/TXT_ALPHA',
      score: 0.0163,
      similarity: null,
      has_accepted_answer: false,
      replies_count: 2,
    });
  });

  it('returns [] for semantic mode when qvec is null', async () => {
    const { pool, query } = makePool([]);
    const out = await hybridSearchCommunity(pool, {
      query: 'processo',
      qvec: null,
      limit: 5,
      mode: 'semantic',
    });
    expect(out).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('hybrid mode falls back to keyword path when qvec is null', async () => {
    const { pool, query } = makePool([]);
    await hybridSearchCommunity(pool, {
      query: 'nfe',
      qvec: null,
      limit: 5,
      mode: 'hybrid',
    });
    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toContain('ts_rank_cd');
    expect(sql).not.toMatch(/<=>|halfvec/);
  });
});

// ─── getCommunityPost ─────────────────────────────────────────────────────────

describe('getCommunityPost', () => {
  it('returns null when no row found', async () => {
    const { pool } = makePool([]);
    const out = await getCommunityPost(pool, 'nonexistent', 8000);
    expect(out).toBeNull();
  });

  it('truncates body_text and reports full char count', async () => {
    const { pool } = makePool([
      {
        id: 'POST1',
        title: 'Título',
        url: 'https://community.sankhya.com.br/post/POST1',
        body_text: 'a'.repeat(500),
        post_type: 'Pergunta',
        tags: ['tag1'],
        has_accepted_answer: true,
        reactions_count: '3',
        author_name: 'João',
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: null,
        space_name: 'Treinamento',
      },
    ]);
    const out = await getCommunityPost(pool, 'POST1', 100);
    expect(out).not.toBeNull();
    expect(out?.body_text.length).toBe(100);
    expect(out?.body_text_truncated).toBe(true);
    expect(out?.body_text_full_chars).toBe(500);
    expect(out?.space_name).toBe('Treinamento');
    expect(out?.id).toBe('POST1');
    expect(out?.reactions_count).toBe(3);
    expect(out?.created_at).toBe('2026-01-01T00:00:00.000Z');
    expect(out?.updated_at).toBeNull();
  });

  it('keeps body_text intact when shorter than maxBodyChars', async () => {
    const { pool } = makePool([
      {
        id: 'P2',
        title: 'Short',
        url: 'https://community.sankhya.com.br/post/P2',
        body_text: 'hello',
        post_type: null,
        tags: [],
        has_accepted_answer: false,
        reactions_count: 0,
        author_name: null,
        created_at: null,
        updated_at: null,
        space_name: 'Geral',
      },
    ]);
    const out = await getCommunityPost(pool, 'P2', 1000);
    expect(out?.body_text).toBe('hello');
    expect(out?.body_text_truncated).toBe(false);
    expect(out?.tags).toEqual([]);
    expect(out?.author_name).toBeNull();
  });
});

// ─── listCommunitySpaces ──────────────────────────────────────────────────────

describe('listCommunitySpaces', () => {
  it('applies private = false filter and orders by posts_count DESC', async () => {
    const { pool, query } = makePool([
      {
        id: 'SP1',
        name: 'Treinamento',
        slug: 'treinamento',
        url: 'https://community.sankhya.com.br/treinamento',
        posts_count: '500',
        members_count: '120',
      },
    ]);
    const rows = await listCommunitySpaces(pool);
    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toContain('private = false');
    expect(sql).toContain('ORDER BY posts_count DESC');
    expect(rows[0]).toEqual({
      id: 'SP1',
      name: 'Treinamento',
      slug: 'treinamento',
      url: 'https://community.sankhya.com.br/treinamento',
      posts_count: 500,
      members_count: 120,
    });
  });

  it('coerces posts_count and members_count strings to numbers', async () => {
    const { pool } = makePool([
      {
        id: 'SP2',
        name: 'Dev',
        slug: 'dev',
        url: 'https://x',
        posts_count: '42',
        members_count: '7',
      },
    ]);
    const rows = await listCommunitySpaces(pool);
    expect(typeof rows[0]!.posts_count).toBe('number');
    expect(typeof rows[0]!.members_count).toBe('number');
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

// ─── R1: Determinism — stable ORDER BY tiebreak ───────────────────────────────

describe('R1 — ORDER BY tiebreak: hybridSearch SQL includes stable secondary sort', () => {
  it('hybrid mode ORDER BY includes a.id as secondary tiebreak', async () => {
    const vec = Array.from({ length: 2560 }, () => 0.1);
    const { pool, query } = makePool([]);
    await hybridSearch(pool, {
      query: 'nfe',
      qvec: vec,
      limit: 5,
      categoryId: null,
      includeOutdated: false,
      mode: 'hybrid',
    });
    const sql = query.mock.calls[0]?.[0] as string;
    // Must contain both rrf_score DESC and a.id as tiebreak.
    expect(sql).toContain('ORDER BY f.rrf_score DESC, a.id');
  });

  it('keyword mode ORDER BY includes a.id as secondary tiebreak', async () => {
    const { pool, query } = makePool([]);
    await hybridSearch(pool, {
      query: 'nfe',
      qvec: null,
      limit: 5,
      categoryId: null,
      includeOutdated: false,
      mode: 'keyword',
    });
    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toContain('ORDER BY score DESC, a.id');
  });
});

describe('R1 — ORDER BY tiebreak: hybridSearchCommunity SQL includes stable secondary sort', () => {
  it('hybrid mode ORDER BY includes rrf_score DESC, has_accepted_answer DESC, replies_count DESC, p.id', async () => {
    const vec = Array.from({ length: 2560 }, () => 0.1);
    const { pool, query } = makePool([]);
    await hybridSearchCommunity(pool, {
      query: 'processo',
      qvec: vec,
      limit: 5,
      mode: 'hybrid',
    });
    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toContain(
      'ORDER BY f.rrf_score DESC, p.has_accepted_answer DESC, p.replies_count DESC, p.id',
    );
  });

  it('keyword mode ORDER BY includes has_accepted_answer DESC, replies_count DESC, p.id', async () => {
    const { pool, query } = makePool([]);
    await hybridSearchCommunity(pool, {
      query: 'processo',
      qvec: null,
      limit: 5,
      mode: 'keyword',
    });
    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toContain(
      'ORDER BY score DESC, p.has_accepted_answer DESC, p.replies_count DESC, p.id',
    );
  });
});

// ─── R3: Similarity — Score = cosine similarity ───────────────────────────────

describe('R3 — similarity field in SearchHit', () => {
  it('keyword mode returns similarity=null (no vector)', async () => {
    const { pool } = makePool([
      {
        id: '1',
        title: 'NF-e',
        breadcrumb: null,
        html_url: 'https://example/1',
        outdated: false,
        score: '0.5',
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
    expect(out[0]?.similarity).toBeNull();
  });

  it('hybrid mode returns similarity as number from DB (mocked)', async () => {
    const vec = Array.from({ length: 2560 }, () => 0.1);
    // The pool stub returns the similarity column value.
    const { pool } = makePool([
      {
        id: '1',
        title: 'NF-e',
        breadcrumb: null,
        html_url: 'https://example/1',
        outdated: false,
        score: '0.015',
        similarity: '0.78',
      },
    ]);
    const out = await hybridSearch(pool, {
      query: 'nf-e',
      qvec: vec,
      limit: 1,
      categoryId: null,
      includeOutdated: false,
      mode: 'hybrid',
    });
    expect(out[0]?.similarity).toBeCloseTo(0.78);
  });
});

describe('R3 — similarity field in CommunityHit', () => {
  it('keyword mode returns similarity=null', async () => {
    const { pool } = makePool([
      {
        id: 'P1',
        title: 'Processo',
        context: 'Geral',
        url: 'https://x',
        score: '0.1',
        has_accepted_answer: false,
        replies_count: '0',
      },
    ]);
    const out = await hybridSearchCommunity(pool, {
      query: 'processo',
      qvec: null,
      limit: 1,
      mode: 'keyword',
    });
    expect(out[0]?.similarity).toBeNull();
  });

  it('hybrid mode returns similarity as number from DB (mocked)', async () => {
    const vec = Array.from({ length: 2560 }, () => 0.1);
    const { pool } = makePool([
      {
        id: 'P1',
        title: 'Processo',
        context: 'Geral',
        url: 'https://x',
        score: '0.015',
        similarity: '0.65',
        has_accepted_answer: true,
        replies_count: '5',
      },
    ]);
    const out = await hybridSearchCommunity(pool, {
      query: 'processo',
      qvec: vec,
      limit: 1,
      mode: 'hybrid',
    });
    expect(out[0]?.similarity).toBeCloseTo(0.65);
    expect(out[0]?.has_accepted_answer).toBe(true);
    expect(out[0]?.replies_count).toBe(5);
  });
});

// ─── R7: decodeBodyText ───────────────────────────────────────────────────────

describe('R7 — decodeBodyText: decode literal escape sequences', () => {
  it('decodes literal \\uXXXX sequences to Unicode characters', () => {
    // é = U+00E9; ç = U+00E7; ã = U+00E3
    expect(decodeBodyText('\\u00e9')).toBe('é');
    expect(decodeBodyText('Algu\\u00e9m')).toBe('Alguém');
    // nota + ç(U+00E7) + ã(U+00E3) + o = notação
    expect(decodeBodyText('nota\\u00e7\\u00e3o')).toBe('notação');
  });

  it('decodes literal \\n (two chars) to a real newline', () => {
    const input = 'linha1\\nlinha2';
    const result = decodeBodyText(input);
    expect(result).toBe('linha1\nlinha2');
    expect(result.split('\n')).toHaveLength(2);
  });

  it('handles mixed escapes in a single string', () => {
    // "serviço.\nDesde" — contains literal ç and literal \n
    const input = 'servi\\u00e7o.\\nDesde';
    expect(decodeBodyText(input)).toBe('serviço.\nDesde');
  });

  it('returns the original string unchanged when no escapes are present', () => {
    const plain = 'Texto simples sem escapes';
    expect(decodeBodyText(plain)).toBe(plain);
  });

  it('handles uppercase \\uXXXX hex digits', () => {
    expect(decodeBodyText('\\u00E9')).toBe('é');
  });
});

// ─── R8: answeredness soft-boost SQL shape ────────────────────────────────────

describe('R8 — hybridSearchCommunity includes has_accepted_answer in SELECT', () => {
  it('hybrid mode SELECT includes has_accepted_answer and replies_count', async () => {
    const vec = Array.from({ length: 2560 }, () => 0.1);
    const { pool, query } = makePool([]);
    await hybridSearchCommunity(pool, {
      query: 'processo',
      qvec: vec,
      limit: 5,
      mode: 'hybrid',
    });
    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toContain('p.has_accepted_answer');
    expect(sql).toContain('p.replies_count');
  });
});

// ─── AC14 updated: distThreshold still only affects semantic CTE ──────────────

describe('AC14 updated — hybridSearch stable ORDER BY and similarity SELECT (R1/R3)', () => {
  it('SQL includes similarity column in the final SELECT', async () => {
    const vec = Array.from({ length: 2560 }, () => 0.1);
    const { pool, query } = makePool([]);
    await hybridSearch(pool, {
      query: 'nfe',
      qvec: vec,
      limit: 5,
      categoryId: null,
      includeOutdated: false,
      mode: 'hybrid',
    });
    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toContain('1.0 - (a.embedding <=> $1::halfvec) AS similarity');
  });

  it('distThreshold absent vs. null still produces identical SQL params (AC14 preserved)', async () => {
    const vec = Array.from({ length: 2560 }, () => 0.1);

    const { pool: pool1, query: q1 } = makePool([]);
    await hybridSearch(pool1, {
      query: 'nfe',
      qvec: vec,
      limit: 5,
      categoryId: null,
      includeOutdated: false,
      mode: 'hybrid',
    });

    const { pool: pool2, query: q2 } = makePool([]);
    await hybridSearch(pool2, {
      query: 'nfe',
      qvec: vec,
      limit: 5,
      categoryId: null,
      includeOutdated: false,
      mode: 'hybrid',
      distThreshold: null,
    });

    // Params must be identical (distThreshold=null must not change params).
    expect(q1.mock.calls[0]?.[1]).toEqual(q2.mock.calls[0]?.[1]);
    // SQL string must be identical (same reference via template literal caching).
    expect(q1.mock.calls[0]?.[0]).toBe(q2.mock.calls[0]?.[0]);
  });

  it('distThreshold still only affects semantic CTE (R1 ORDER BY does not break C5)', async () => {
    const vec = Array.from({ length: 2560 }, () => 0.1);
    const { pool, query } = makePool([]);
    await hybridSearch(pool, {
      query: 'nfe',
      qvec: vec,
      limit: 5,
      categoryId: null,
      includeOutdated: false,
      mode: 'hybrid',
      distThreshold: 0.45,
    });
    const sql = query.mock.calls[0]?.[0] as string;
    const semanticBlock = sql.substring(sql.indexOf('WITH semantic'), sql.indexOf('keyword AS'));
    const keywordBlock = sql.substring(sql.indexOf('keyword AS'), sql.indexOf('fused AS'));
    expect(semanticBlock).toContain('<= 0.45');
    expect(keywordBlock).not.toContain('<= 0.45');
  });
});

// ─── BUG-FIX regression: pg concurrency — no per-connection query-issuing handler ──────

/**
 * Regression test: buildPool must NOT attach a query-issuing 'connect' event
 * handler on the pool.  The previous implementation called
 * pgvector.registerTypes(client) inside pool.on('connect', ...) which issued a
 * client.query() during the connection setup phase.  Under concurrent load two
 * fresh connections could be opened simultaneously and the pool's internal
 * client could be asked to execute two queries at once, triggering:
 *   DeprecationWarning: client already executing a query
 *
 * The fix registers parsers globally via pg.types.setTypeParser (using OIDs
 * resolved once at startup) so no per-connection query is ever issued.
 *
 * This test verifies the fix at the source level:
 *   1. It intercepts Pool.prototype.connect + Pool.prototype.on via prototype
 *      patching so the test is independent of how db.ts destructures 'pg'.
 *   2. It asserts no 'connect' event listener is registered.
 *   3. It asserts pg.types.setTypeParser is called (global registration).
 */
describe('buildPool — pg concurrency regression (no query-issuing connect handler)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does NOT attach a pool.on("connect") handler that issues a query', async () => {
    // Track 'connect' listeners registered on ANY Pool instance via prototype.
    const registeredConnectListeners: Array<(...args: unknown[]) => void> = [];

    // Minimal fake client returned by pool.connect() in the startup probe.
    const fakeClient = {
      query: vi.fn().mockResolvedValue({
        rows: [
          { typname: 'vector', oid: '1111' },
          { typname: 'halfvec', oid: '2222' },
        ],
      }),
      release: vi.fn(),
    };

    // Patch Pool.prototype.connect so the startup probe uses our fake client.
    vi.spyOn(pg.Pool.prototype, 'connect').mockResolvedValue(
      fakeClient as unknown as pg.PoolClient,
    );

    // Patch Pool.prototype.on to intercept event registration.
    vi.spyOn(pg.Pool.prototype, 'on').mockImplementation(
      function (event: string, listener: (...args: unknown[]) => void) {
        if (event === 'connect') {
          registeredConnectListeners.push(listener);
        }
        return this as unknown as pg.Pool;
      },
    );

    // Spy on pg.types.setTypeParser to verify global registration happens.
    const setTypeParserSpy = vi.spyOn(pg.types, 'setTypeParser');

    const fakeSettings = {
      pg: {
        host: 'localhost',
        port: 5432,
        database: 'test',
        user: 'test',
        password: 'test',
        poolMin: 1,
        poolMax: 5,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await buildPool(fakeSettings);

    // Core assertion: no 'connect' listeners should be registered.
    // The old buggy code attached a query-issuing handler here.
    expect(
      registeredConnectListeners,
      'buildPool must not register a pool.on("connect") handler — it caused the concurrency bug',
    ).toHaveLength(0);

    // Secondary assertion: global type parsers must be set via pg.types.setTypeParser.
    // Expect one call per OID returned (2 in our fake: vector + halfvec).
    expect(
      setTypeParserSpy,
      'pg.types.setTypeParser must be called for each OID returned by the startup query',
    ).toHaveBeenCalledTimes(2);
    expect(setTypeParserSpy).toHaveBeenCalledWith(1111, expect.any(Function));
    expect(setTypeParserSpy).toHaveBeenCalledWith(2222, expect.any(Function));
  });
});
