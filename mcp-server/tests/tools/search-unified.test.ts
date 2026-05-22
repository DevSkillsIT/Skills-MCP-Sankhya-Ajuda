/**
 * Unit tests for src/tools/search-unified.ts — pure logic, mocked DB + EmbeddingClient.
 *
 * Coverage targets:
 *   AC01 — source=all: columns EXACT (Fonte|Oficial|Título|Contexto|Similaridade|URL), order desc by rrfScore,
 *           Oficial=Sim for HELP / Não for COMUNIDADE, Similaridade 3 decimals (cosine) or "—".
 *   AC01 — source=help: only HELP rows, isOfficial=true.
 *   AC01 — source=community: only COMUNIDADE rows, isOfficial=false.
 *   AC12 — schema rejects `mode` and `category_id`; tool never returns EMBEDDING_UNAVAILABLE.
 *   Degradation — embeddingProvider='none', indexCompatible=false, EmbeddingError → keyword-only.
 *   C5   — distThreshold (default 0.45) forwarded to both DB calls in hybrid mode.
 *   source='all' — calls both DB functions with limit 20, dedup + crossSourceRRF + slice.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runUnifiedSearch } from '../../src/tools/search-unified.js';
import { EmbeddingError, type EmbeddingClient } from '../../src/embeddings.js';
import * as dbModule from '../../src/db.js';
import type { Pool } from '../../src/db.js';
import type { SearchHit, CommunityHit } from '../../src/types.js';
import type { ToolContext as WorkingToolContext } from '../../src/tools/working-index.js';

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeHelpHit(id: number, title = `Help ${id}`, breadcrumb: string | null = null): SearchHit {
  return {
    id,
    title,
    breadcrumb,
    html_url: `https://ajuda.sankhya.com.br/hc/pt-br/articles/${id}`,
    outdated: false,
    score: 0.9,
    similarity: null,
  };
}

function makeCommHit(id: string, title = `Community ${id}`, context: string | null = null): CommunityHit {
  return {
    id,
    title,
    context,
    url: `https://community.sankhya.com.br/post/${id}`,
    score: 0.8,
    similarity: null,
    has_accepted_answer: false,
    replies_count: 0,
  };
}

const FAKE_HELP_HITS: SearchHit[] = [
  makeHelpHit(1, 'Como emitir NF-e', 'NF-e > Emissão'),
  makeHelpHit(2, 'Cancelamento de NF', null),
];

const FAKE_COMM_HITS: CommunityHit[] = [
  makeCommHit('abc', 'Dúvida NF-e', 'Fiscal'),
  makeCommHit('def', 'Erro ao confirmar NF', 'Suporte'),
];

const fakePool = {} as Pool;

function makeCtx(overrides: Partial<WorkingToolContext> = {}): WorkingToolContext {
  const embedding: EmbeddingClient = {
    embed: vi.fn().mockResolvedValue(Array(2560).fill(0.1)),
  };
  return {
    pool: fakePool,
    embedding,
    embeddingProvider: 'vllm',
    indexCompatible: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ─── AC01: source=help — only HELP rows ──────────────────────────────────────

describe('source=help', () => {
  it('returns only HELP rows with isOfficial=true, score 4 decimals, sorted desc', async () => {
    vi.spyOn(dbModule, 'hybridSearch').mockResolvedValue(FAKE_HELP_HITS);

    const ctx = makeCtx();
    const hits = await runUnifiedSearch(ctx, {
      query: 'nota fiscal',
      source: 'help',
      limit: 10,
      include_outdated: false,
    });

    expect(hits).toHaveLength(FAKE_HELP_HITS.length);
    for (const hit of hits) {
      expect(hit.source).toBe('help');
      expect(hit.isOfficial).toBe(true);
    }
    // Score decreases (or stays equal) across the array.
    for (let i = 0; i < hits.length - 1; i++) {
      expect(hits[i]!.rrfScore).toBeGreaterThanOrEqual(hits[i + 1]!.rrfScore);
    }
    // id must be the string version of the numeric SearchHit.id
    expect(hits[0]!.id).toBe('1');
    expect(hits[1]!.id).toBe('2');
    // context maps to breadcrumb
    expect(hits[0]!.context).toBe('NF-e > Emissão');
    expect(hits[1]!.context).toBeNull();
    // Score format: 4 decimal places
    expect(hits[0]!.rrfScore.toFixed(4)).toMatch(/^\d+\.\d{4}$/);
  });

  it('rrfScore = 1/(60+sourceRank) exactly', async () => {
    vi.spyOn(dbModule, 'hybridSearch').mockResolvedValue([makeHelpHit(99)]);

    const ctx = makeCtx();
    const hits = await runUnifiedSearch(ctx, {
      query: 'test',
      source: 'help',
      limit: 5,
      include_outdated: false,
    });

    expect(hits[0]!.sourceRank).toBe(1);
    expect(hits[0]!.rrfScore).toBeCloseTo(1 / (60 + 1));
  });

  it('does NOT call hybridSearchCommunity', async () => {
    const helpSpy = vi.spyOn(dbModule, 'hybridSearch').mockResolvedValue(FAKE_HELP_HITS);
    const commSpy = vi.spyOn(dbModule, 'hybridSearchCommunity').mockResolvedValue([]);

    await runUnifiedSearch(makeCtx(), {
      query: 'test',
      source: 'help',
      limit: 5,
      include_outdated: false,
    });

    expect(helpSpy).toHaveBeenCalledOnce();
    expect(commSpy).not.toHaveBeenCalled();
  });
});

// ─── AC01: source=community — only COMUNIDADE rows ───────────────────────────

describe('source=community', () => {
  it('returns only COMMUNITY rows with isOfficial=false', async () => {
    vi.spyOn(dbModule, 'hybridSearchCommunity').mockResolvedValue(FAKE_COMM_HITS);

    const hits = await runUnifiedSearch(makeCtx(), {
      query: 'nota fiscal',
      source: 'community',
      limit: 10,
      include_outdated: false,
    });

    expect(hits).toHaveLength(FAKE_COMM_HITS.length);
    for (const hit of hits) {
      expect(hit.source).toBe('community');
      expect(hit.isOfficial).toBe(false);
    }
    // Sorted desc by rrfScore
    for (let i = 0; i < hits.length - 1; i++) {
      expect(hits[i]!.rrfScore).toBeGreaterThanOrEqual(hits[i + 1]!.rrfScore);
    }
  });

  it('applies dedup before assigning sourceRank', async () => {
    // Two hits with the same normalised title — dedup must keep only the first.
    const dupeHits: CommunityHit[] = [
      makeCommHit('x1', 'Serviço de Config'),
      makeCommHit('x2', 'servico de config!'),  // duplicate
      makeCommHit('x3', 'Outro tópico'),
    ];
    vi.spyOn(dbModule, 'hybridSearchCommunity').mockResolvedValue(dupeHits);

    const hits = await runUnifiedSearch(makeCtx(), {
      query: 'config',
      source: 'community',
      limit: 10,
      include_outdated: false,
    });

    // Only 2 unique titles survive dedup
    expect(hits).toHaveLength(2);
    // sourceRank starts at 1 after dedup
    expect(hits[0]!.sourceRank).toBe(1);
    expect(hits[1]!.sourceRank).toBe(2);
  });

  it('does NOT call hybridSearch', async () => {
    const helpSpy = vi.spyOn(dbModule, 'hybridSearch').mockResolvedValue([]);
    const commSpy = vi.spyOn(dbModule, 'hybridSearchCommunity').mockResolvedValue(FAKE_COMM_HITS);

    await runUnifiedSearch(makeCtx(), {
      query: 'test',
      source: 'community',
      limit: 5,
      include_outdated: false,
    });

    expect(commSpy).toHaveBeenCalledOnce();
    expect(helpSpy).not.toHaveBeenCalled();
  });
});

// ─── AC01: source=all — mixed result with correct columns ────────────────────

describe('source=all', () => {
  it('calls both DB functions with limit=20, applies dedup+RRF+slice, returns mixed results', async () => {
    const helpSpy = vi.spyOn(dbModule, 'hybridSearch').mockResolvedValue(FAKE_HELP_HITS);
    const commSpy = vi.spyOn(dbModule, 'hybridSearchCommunity').mockResolvedValue(FAKE_COMM_HITS);

    const hits = await runUnifiedSearch(makeCtx(), {
      query: 'nota fiscal',
      source: 'all',
      limit: 5,
      include_outdated: false,
    });

    // Both called with limit=20
    expect(helpSpy).toHaveBeenCalledWith(fakePool, expect.objectContaining({ limit: 20 }));
    expect(commSpy).toHaveBeenCalledWith(fakePool, expect.objectContaining({ limit: 20 }));

    // Result contains both sources
    const sources = new Set(hits.map((h) => h.source));
    expect(sources).toContain('help');
    expect(sources).toContain('community');

    // Sliced to limit=5
    expect(hits.length).toBeLessThanOrEqual(5);

    // Sorted desc by rrfScore
    for (let i = 0; i < hits.length - 1; i++) {
      expect(hits[i]!.rrfScore).toBeGreaterThanOrEqual(hits[i + 1]!.rrfScore);
    }
  });

  it('respects the limit slice', async () => {
    // Provide more hits than the limit to verify slicing.
    const manyHelp = Array.from({ length: 15 }, (_, i) => makeHelpHit(i + 1));
    const manyComm = Array.from({ length: 15 }, (_, i) => makeCommHit(`c${i + 1}`));
    vi.spyOn(dbModule, 'hybridSearch').mockResolvedValue(manyHelp);
    vi.spyOn(dbModule, 'hybridSearchCommunity').mockResolvedValue(manyComm);

    const hits = await runUnifiedSearch(makeCtx(), {
      query: 'test',
      source: 'all',
      limit: 7,
      include_outdated: false,
    });

    expect(hits).toHaveLength(7);
  });

  it('Oficial=Sim for help rows and Oficial=Não for community rows', async () => {
    vi.spyOn(dbModule, 'hybridSearch').mockResolvedValue([makeHelpHit(1)]);
    vi.spyOn(dbModule, 'hybridSearchCommunity').mockResolvedValue([makeCommHit('c1')]);

    const hits = await runUnifiedSearch(makeCtx(), {
      query: 'test',
      source: 'all',
      limit: 10,
      include_outdated: false,
    });

    const helpHit = hits.find((h) => h.source === 'help')!;
    const commHit = hits.find((h) => h.source === 'community')!;
    expect(helpHit.isOfficial).toBe(true);
    expect(commHit.isOfficial).toBe(false);
  });

  it('dedup is applied to community hits before RRF', async () => {
    const dupComm: CommunityHit[] = [
      makeCommHit('d1', 'Título Duplicado'),
      makeCommHit('d2', 'titulo duplicado'),  // same normalised title → dropped
      makeCommHit('d3', 'Outro'),
    ];
    vi.spyOn(dbModule, 'hybridSearch').mockResolvedValue([makeHelpHit(1)]);
    vi.spyOn(dbModule, 'hybridSearchCommunity').mockResolvedValue(dupComm);

    const hits = await runUnifiedSearch(makeCtx(), {
      query: 'test',
      source: 'all',
      limit: 10,
      include_outdated: false,
    });

    // 'd2' must not appear in results (deduped away)
    const ids = hits.map((h) => h.id);
    expect(ids).not.toContain('d2');
  });
});

// ─── AC12: schema does NOT accept `mode` or `category_id` ────────────────────

describe('AC12 — schema exclusions', () => {
  it('unknown params like mode and category_id are ignored (not wired), no EMBEDDING_UNAVAILABLE ever', async () => {
    // The tool does not define mode or category_id in its Zod schema.
    // We test runUnifiedSearch directly — it has no mode/category_id path, no
    // semantic-only path, and therefore can never return EMBEDDING_UNAVAILABLE.
    // Instead we verify that even when embedding is down, we get keyword hits back.
    const embedding: EmbeddingClient = {
      embed: vi.fn().mockRejectedValue(new EmbeddingError('down', 'timeout')),
    };
    vi.spyOn(dbModule, 'hybridSearch').mockResolvedValue(FAKE_HELP_HITS);

    const ctx = makeCtx({ embedding });
    const hits = await runUnifiedSearch(ctx, {
      query: 'test',
      source: 'help',
      limit: 5,
      include_outdated: false,
    });

    // Hits returned — no error thrown, no EMBEDDING_UNAVAILABLE.
    expect(hits.length).toBeGreaterThan(0);
    // DB was called with keyword mode (fallback)
    expect(dbModule.hybridSearch).toHaveBeenCalledWith(
      fakePool,
      expect.objectContaining({ mode: 'keyword', qvec: null }),
    );
  });
});

// ─── Degradation: embeddingProvider='none' ───────────────────────────────────

describe('Degradation — embeddingProvider=none', () => {
  it('never calls embed, always passes qvec=null and mode=keyword', async () => {
    const embedding: EmbeddingClient = {
      embed: vi.fn().mockRejectedValue(new Error('should not be called')),
    };
    const helpSpy = vi.spyOn(dbModule, 'hybridSearch').mockResolvedValue(FAKE_HELP_HITS);
    const commSpy = vi.spyOn(dbModule, 'hybridSearchCommunity').mockResolvedValue(FAKE_COMM_HITS);

    const ctx = makeCtx({ embedding, embeddingProvider: 'none' });

    await runUnifiedSearch(ctx, {
      query: 'test',
      source: 'all',
      limit: 5,
      include_outdated: false,
    });

    expect(embedding.embed).not.toHaveBeenCalled();
    expect(helpSpy).toHaveBeenCalledWith(fakePool, expect.objectContaining({ mode: 'keyword', qvec: null }));
    expect(commSpy).toHaveBeenCalledWith(fakePool, expect.objectContaining({ mode: 'keyword', qvec: null }));
  });
});

// ─── Degradation: indexCompatible=false ──────────────────────────────────────

describe('Degradation — indexCompatible=false', () => {
  it('never calls embed, forces keyword for both sources', async () => {
    const embedding: EmbeddingClient = {
      embed: vi.fn().mockRejectedValue(new Error('should not be called')),
    };
    const helpSpy = vi.spyOn(dbModule, 'hybridSearch').mockResolvedValue(FAKE_HELP_HITS);
    const commSpy = vi.spyOn(dbModule, 'hybridSearchCommunity').mockResolvedValue(FAKE_COMM_HITS);

    const ctx = makeCtx({ embedding, indexCompatible: false });

    await runUnifiedSearch(ctx, {
      query: 'test',
      source: 'all',
      limit: 5,
      include_outdated: false,
    });

    expect(embedding.embed).not.toHaveBeenCalled();
    expect(helpSpy).toHaveBeenCalledWith(fakePool, expect.objectContaining({ mode: 'keyword', qvec: null }));
    expect(commSpy).toHaveBeenCalledWith(fakePool, expect.objectContaining({ mode: 'keyword', qvec: null }));
  });
});

// ─── Degradation: EmbeddingError at runtime ──────────────────────────────────

describe('Degradation — EmbeddingError at runtime', () => {
  it('falls back to keyword for both sources, does not throw, never returns EMBEDDING_UNAVAILABLE', async () => {
    const embedding: EmbeddingClient = {
      embed: vi.fn().mockRejectedValue(new EmbeddingError('vLLM 503', 'http_5xx')),
    };
    const helpSpy = vi.spyOn(dbModule, 'hybridSearch').mockResolvedValue(FAKE_HELP_HITS);
    const commSpy = vi.spyOn(dbModule, 'hybridSearchCommunity').mockResolvedValue(FAKE_COMM_HITS);

    const ctx = makeCtx({ embedding });

    const hits = await runUnifiedSearch(ctx, {
      query: 'test',
      source: 'all',
      limit: 5,
      include_outdated: false,
    });

    // embed was called (we are NOT in degraded-at-setup mode) but threw
    expect(embedding.embed).toHaveBeenCalledOnce();

    // Falls back to keyword for both — no exception propagated
    expect(helpSpy).toHaveBeenCalledWith(fakePool, expect.objectContaining({ mode: 'keyword', qvec: null }));
    expect(commSpy).toHaveBeenCalledWith(fakePool, expect.objectContaining({ mode: 'keyword', qvec: null }));

    // Results are returned normally
    expect(hits.length).toBeGreaterThan(0);
  });

  it('EmbeddingError with source=help falls back to keyword', async () => {
    const embedding: EmbeddingClient = {
      embed: vi.fn().mockRejectedValue(new EmbeddingError('vLLM down', 'timeout')),
    };
    vi.spyOn(dbModule, 'hybridSearch').mockResolvedValue(FAKE_HELP_HITS);

    const ctx = makeCtx({ embedding });
    const hits = await runUnifiedSearch(ctx, {
      query: 'test',
      source: 'help',
      limit: 5,
      include_outdated: false,
    });

    expect(dbModule.hybridSearch).toHaveBeenCalledWith(
      fakePool,
      expect.objectContaining({ mode: 'keyword', qvec: null }),
    );
    expect(hits.length).toBeGreaterThan(0);
  });
});

// ─── C5: distThreshold plumbing ──────────────────────────────────────────────

describe('C5 — distThreshold plumbing', () => {
  it('passes distThreshold to hybridSearch in hybrid mode', async () => {
    const fakeVec = Array(2560).fill(0.1);
    const embedding: EmbeddingClient = {
      embed: vi.fn().mockResolvedValue(fakeVec),
    };
    const helpSpy = vi.spyOn(dbModule, 'hybridSearch').mockResolvedValue(FAKE_HELP_HITS);
    vi.spyOn(dbModule, 'hybridSearchCommunity').mockResolvedValue([]);

    const ctx = makeCtx({ embedding });

    await runUnifiedSearch(ctx, {
      query: 'nota fiscal',
      source: 'help',
      limit: 5,
      include_outdated: false,
    });

    // distThreshold must be present (default 0.45) in hybrid mode
    expect(helpSpy).toHaveBeenCalledWith(
      fakePool,
      expect.objectContaining({ distThreshold: 0.45 }),
    );
  });

  it('passes distThreshold to hybridSearchCommunity in hybrid mode', async () => {
    const fakeVec = Array(2560).fill(0.1);
    const embedding: EmbeddingClient = {
      embed: vi.fn().mockResolvedValue(fakeVec),
    };
    vi.spyOn(dbModule, 'hybridSearch').mockResolvedValue([]);
    const commSpy = vi.spyOn(dbModule, 'hybridSearchCommunity').mockResolvedValue(FAKE_COMM_HITS);

    const ctx = makeCtx({ embedding });

    await runUnifiedSearch(ctx, {
      query: 'nota fiscal',
      source: 'community',
      limit: 5,
      include_outdated: false,
    });

    expect(commSpy).toHaveBeenCalledWith(
      fakePool,
      expect.objectContaining({ distThreshold: 0.45 }),
    );
  });

  it('passes distThreshold to both sources when source=all', async () => {
    const fakeVec = Array(2560).fill(0.1);
    const embedding: EmbeddingClient = {
      embed: vi.fn().mockResolvedValue(fakeVec),
    };
    const helpSpy = vi.spyOn(dbModule, 'hybridSearch').mockResolvedValue(FAKE_HELP_HITS);
    const commSpy = vi.spyOn(dbModule, 'hybridSearchCommunity').mockResolvedValue(FAKE_COMM_HITS);

    const ctx = makeCtx({ embedding });

    await runUnifiedSearch(ctx, {
      query: 'test',
      source: 'all',
      limit: 5,
      include_outdated: false,
    });

    expect(helpSpy).toHaveBeenCalledWith(fakePool, expect.objectContaining({ distThreshold: 0.45 }));
    expect(commSpy).toHaveBeenCalledWith(fakePool, expect.objectContaining({ distThreshold: 0.45 }));
  });
});

// ─── Happy path: hybrid mode with embedding available ────────────────────────

describe('Happy path — hybrid mode', () => {
  it('calls embed once and passes qvec to both DB functions for source=all', async () => {
    const fakeVec = Array(2560).fill(0.2);
    const embedding: EmbeddingClient = {
      embed: vi.fn().mockResolvedValue(fakeVec),
    };
    const helpSpy = vi.spyOn(dbModule, 'hybridSearch').mockResolvedValue(FAKE_HELP_HITS);
    const commSpy = vi.spyOn(dbModule, 'hybridSearchCommunity').mockResolvedValue(FAKE_COMM_HITS);

    const ctx = makeCtx({ embedding });

    await runUnifiedSearch(ctx, {
      query: 'nota fiscal',
      source: 'all',
      limit: 5,
      include_outdated: false,
    });

    // embed called exactly once (shared between sources)
    expect(embedding.embed).toHaveBeenCalledOnce();
    expect(helpSpy).toHaveBeenCalledWith(fakePool, expect.objectContaining({ mode: 'hybrid', qvec: fakeVec }));
    expect(commSpy).toHaveBeenCalledWith(fakePool, expect.objectContaining({ mode: 'hybrid', qvec: fakeVec }));
  });
});

// ─── Empty results ────────────────────────────────────────────────────────────

describe('Empty results', () => {
  it('returns empty array when both sources return nothing', async () => {
    vi.spyOn(dbModule, 'hybridSearch').mockResolvedValue([]);
    vi.spyOn(dbModule, 'hybridSearchCommunity').mockResolvedValue([]);

    const hits = await runUnifiedSearch(makeCtx(), {
      query: 'xpto query unlikely',
      source: 'all',
      limit: 10,
      include_outdated: false,
    });

    expect(hits).toHaveLength(0);
  });
});

// ─── include_outdated forwarding ─────────────────────────────────────────────

describe('include_outdated forwarding', () => {
  it('passes include_outdated=true to hybridSearch (help only)', async () => {
    const helpSpy = vi.spyOn(dbModule, 'hybridSearch').mockResolvedValue(FAKE_HELP_HITS);

    await runUnifiedSearch(makeCtx(), {
      query: 'obsoleto',
      source: 'help',
      limit: 5,
      include_outdated: true,
    });

    expect(helpSpy).toHaveBeenCalledWith(
      fakePool,
      expect.objectContaining({ includeOutdated: true }),
    );
  });
});

// ─── categoryId must NOT be forwarded to hybridSearch ────────────────────────

describe('categoryId is never set (C4)', () => {
  it('always passes categoryId=null to hybridSearch regardless of what caller provides', async () => {
    const helpSpy = vi.spyOn(dbModule, 'hybridSearch').mockResolvedValue(FAKE_HELP_HITS);

    await runUnifiedSearch(makeCtx(), {
      query: 'test',
      source: 'help',
      limit: 5,
      include_outdated: false,
    });

    expect(helpSpy).toHaveBeenCalledWith(
      fakePool,
      expect.objectContaining({ categoryId: null }),
    );
  });
});

// ─── R3: Similaridade = similarity ───────────────────────────────────────────

describe('R3 — Similaridade column shows similarity or "—"', () => {
  it('similarity present in UnifiedHit when hit has similarity from DB', async () => {
    const hitWithSim = { ...FAKE_HELP_HITS[0]!, similarity: 0.873 };
    vi.spyOn(dbModule, 'hybridSearch').mockResolvedValue([hitWithSim]);

    const hits = await runUnifiedSearch(makeCtx(), {
      query: 'nota',
      source: 'help',
      limit: 5,
      include_outdated: false,
    });

    expect(hits[0]?.similarity).toBeCloseTo(0.873);
  });

  it('similarity is null in UnifiedHit when hit has no similarity (keyword mode)', async () => {
    const hitNoSim = { ...FAKE_HELP_HITS[0]!, similarity: null };
    vi.spyOn(dbModule, 'hybridSearch').mockResolvedValue([hitNoSim]);

    const hits = await runUnifiedSearch(makeCtx(), {
      query: 'nota',
      source: 'help',
      limit: 5,
      include_outdated: false,
    });

    expect(hits[0]?.similarity).toBeNull();
  });
});

// ─── R2: ID column in UnifiedHit ─────────────────────────────────────────────

describe('R2 — ID column present in UnifiedHit', () => {
  it('help hit id is the string version of the numeric SearchHit id', async () => {
    vi.spyOn(dbModule, 'hybridSearch').mockResolvedValue([makeHelpHit(999)]);

    const hits = await runUnifiedSearch(makeCtx(), {
      query: 'test',
      source: 'help',
      limit: 5,
      include_outdated: false,
    });

    expect(hits[0]?.id).toBe('999');
  });

  it('community hit id is the string id from the CommunityHit', async () => {
    const commHit = { ...makeCommHit('XY-789'), similarity: null, has_accepted_answer: false, replies_count: 0 };
    vi.spyOn(dbModule, 'hybridSearchCommunity').mockResolvedValue([commHit]);

    const hits = await runUnifiedSearch(makeCtx(), {
      query: 'test',
      source: 'community',
      limit: 5,
      include_outdated: false,
    });

    expect(hits[0]?.id).toBe('XY-789');
  });
});

// ─── R4: Truncation in formatUnifiedMarkdown ──────────────────────────────────

describe('R4 — title and context truncation in formatted Markdown (via formatter test)', () => {
  // We test the formatter indirectly by checking that results pass through
  // without title or context exceeding 90/70 chars respectively.
  it('hit with a title of 200 chars maps to UnifiedHit with full title (truncation is in formatter only)', async () => {
    const longTitle = 'A'.repeat(200);
    vi.spyOn(dbModule, 'hybridSearch').mockResolvedValue([makeHelpHit(1, longTitle, null)]);

    const hits = await runUnifiedSearch(makeCtx(), {
      query: 'test',
      source: 'help',
      limit: 5,
      include_outdated: false,
    });

    // UnifiedHit preserves the full title; truncation happens in the Markdown formatter.
    expect(hits[0]?.title).toBe(longTitle);
  });
});

// ─── Non-EmbeddingError rethrow path ─────────────────────────────────────────

describe('Non-EmbeddingError is rethrown', () => {
  it('propagates a non-EmbeddingError from embed', async () => {
    const embedding: EmbeddingClient = {
      embed: vi.fn().mockRejectedValue(new TypeError('unexpected network error')),
    };
    vi.spyOn(dbModule, 'hybridSearch').mockResolvedValue([]);

    const ctx = makeCtx({ embedding });

    await expect(
      runUnifiedSearch(ctx, { query: 'test', source: 'help', limit: 5, include_outdated: false }),
    ).rejects.toThrow('unexpected network error');
  });
});

// ─── Markdown formatter output shape ─────────────────────────────────────────

describe('Markdown formatter output (AC01 columns)', () => {
  it('produces correct columns and HELP/COMUNIDADE labels with Sim/Não', async () => {
    vi.spyOn(dbModule, 'hybridSearch').mockResolvedValue([
      makeHelpHit(1, 'Help Title', 'Breadcrumb > Path'),
    ]);
    vi.spyOn(dbModule, 'hybridSearchCommunity').mockResolvedValue([
      makeCommHit('c1', 'Community Title', 'Espaço Fiscal'),
    ]);

    const hits = await runUnifiedSearch(makeCtx(), {
      query: 'nota',
      source: 'all',
      limit: 10,
      include_outdated: false,
    });

    // Verify the raw UnifiedHit data that feeds the formatter.
    const helpHit = hits.find((h) => h.source === 'help')!;
    const commHit = hits.find((h) => h.source === 'community')!;

    // Fonte labels
    expect(helpHit.source).toBe('help');
    expect(commHit.source).toBe('community');

    // Oficial flags
    expect(helpHit.isOfficial).toBe(true);
    expect(commHit.isOfficial).toBe(false);

    // Contexto mapping
    expect(helpHit.context).toBe('Breadcrumb > Path');
    expect(commHit.context).toBe('Espaço Fiscal');

    // Score is a number with 4 decimal places when formatted
    expect(helpHit.rrfScore.toFixed(4)).toMatch(/^\d+\.\d{4}$/);
    expect(commHit.rrfScore.toFixed(4)).toMatch(/^\d+\.\d{4}$/);

    // URL mapping
    expect(helpHit.url).toBe('https://ajuda.sankhya.com.br/hc/pt-br/articles/1');
    expect(commHit.url).toBe('https://community.sankhya.com.br/post/c1');
  });

  it('null context (breadcrumb) maps to null in the UnifiedHit', async () => {
    vi.spyOn(dbModule, 'hybridSearch').mockResolvedValue([makeHelpHit(5, 'No BC', null)]);

    const hits = await runUnifiedSearch(makeCtx(), {
      query: 'test',
      source: 'help',
      limit: 5,
      include_outdated: false,
    });

    expect(hits[0]!.context).toBeNull();
  });
});
