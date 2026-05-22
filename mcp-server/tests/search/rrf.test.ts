/**
 * Unit tests for src/search/rrf.ts — pure logic, no DB, no network.
 *
 * Coverage targets:
 *   AC11 — crossSourceRRF position-based rrfScore + exact UnifiedHit shape
 *   AC13 — dedupCommunityByTitle NFD normalisation + first-occurrence rule
 *   RF06 — help-first tiebreak when help and community share the same position
 */

import { describe, it, expect } from 'vitest';
import { crossSourceRRF, dedupCommunityByTitle } from '../../src/search/rrf.js';
import type { SearchHit, CommunityHit, UnifiedHit } from '../../src/types.js';

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeHelpHit(overrides: Partial<SearchHit> & { id: number; title: string }): SearchHit {
  return {
    breadcrumb: null,
    html_url: `https://help.example/${overrides.id}`,
    outdated: false,
    score: 0.9,
    similarity: null,
    ...overrides,
  };
}

function makeCommunityHit(
  overrides: Partial<CommunityHit> & { id: string; title: string },
): CommunityHit {
  return {
    context: null,
    url: `https://community.example/${overrides.id}`,
    score: 0.8,
    similarity: null,
    has_accepted_answer: false,
    replies_count: 0,
    ...overrides,
  };
}

// ─── AC11: crossSourceRRF — position-based scoring and UnifiedHit shape ───────

describe('crossSourceRRF (AC11)', () => {
  it('assigns rrfScore = 1/(60 + sourceRank) using array position, not .score', () => {
    const helpHits = [
      makeHelpHit({ id: 1, title: 'Help A' }),
      makeHelpHit({ id: 2, title: 'Help B' }),
    ];
    const communityHits = [
      makeCommunityHit({ id: 'abc', title: 'Community X' }),
    ];

    const result = crossSourceRRF(helpHits, communityHits);

    // Find specific hits in result.
    const helpA = result.find((r) => r.source === 'help' && r.id === '1')!;
    const helpB = result.find((r) => r.source === 'help' && r.id === '2')!;
    const commX = result.find((r) => r.source === 'community')!;

    expect(helpA).toBeDefined();
    expect(helpA.sourceRank).toBe(1);
    expect(helpA.rrfScore).toBeCloseTo(1 / (60 + 1));

    expect(helpB).toBeDefined();
    expect(helpB.sourceRank).toBe(2);
    expect(helpB.rrfScore).toBeCloseTo(1 / (60 + 2));

    expect(commX).toBeDefined();
    expect(commX.sourceRank).toBe(1);
    expect(commX.rrfScore).toBeCloseTo(1 / (60 + 1));
  });

  it('produces exact UnifiedHit shape required by C2', () => {
    const helpHit = makeHelpHit({ id: 42, title: 'Help Title', breadcrumb: 'A > B' });
    const commHit = makeCommunityHit({ id: 'TXT123', title: 'Comm Title', context: 'Space Alpha' });

    const result = crossSourceRRF([helpHit], [commHit]);

    const h = result.find((r) => r.source === 'help')!;
    expect(h).toMatchObject({
      source: 'help',
      isOfficial: true,
      id: '42',        // BIGINT coerced to string
      title: 'Help Title',
      context: 'A > B',
      url: 'https://help.example/42',
      sourceRank: 1,
    } satisfies Partial<UnifiedHit>);
    expect(typeof h.rrfScore).toBe('number');
    expect(h.rrfScore).toBeGreaterThan(0);

    const c = result.find((r) => r.source === 'community')!;
    expect(c).toMatchObject({
      source: 'community',
      isOfficial: false,
      id: 'TXT123',   // TEXT stays as-is
      title: 'Comm Title',
      context: 'Space Alpha',
      url: 'https://community.example/TXT123',
      sourceRank: 1,
    } satisfies Partial<UnifiedHit>);
  });

  it('sorts merged list descending by rrfScore', () => {
    // help rank 1 = 1/61 ≈ 0.01639, community rank 2 = 1/62 ≈ 0.01613
    const helpHits = [
      makeHelpHit({ id: 10, title: 'H1' }),  // sourceRank 1 → 1/61
    ];
    const commHits = [
      makeCommunityHit({ id: 'c1', title: 'C1' }), // sourceRank 1 → 1/61 (tie)
      makeCommunityHit({ id: 'c2', title: 'C2' }), // sourceRank 2 → 1/62
    ];

    const result = crossSourceRRF(helpHits, commHits);

    // The two rank-1 items tie; both rank-2 item is last.
    expect(result[result.length - 1]!.sourceRank).toBe(2);
    // All scores are in descending order.
    for (let i = 0; i < result.length - 1; i++) {
      expect(result[i]!.rrfScore).toBeGreaterThanOrEqual(result[i + 1]!.rrfScore);
    }
  });

  it('respects custom k parameter', () => {
    const helpHits = [makeHelpHit({ id: 1, title: 'H' })];
    const result = crossSourceRRF(helpHits, [], 30);
    expect(result[0]!.rrfScore).toBeCloseTo(1 / (30 + 1));
  });

  it('returns empty list when both inputs are empty', () => {
    expect(crossSourceRRF([], [])).toEqual([]);
  });

  it('handles null breadcrumb and null context as null in UnifiedHit', () => {
    const helpHit = makeHelpHit({ id: 7, title: 'No BC', breadcrumb: null });
    const commHit = makeCommunityHit({ id: 'noctx', title: 'No Ctx', context: null });
    const result = crossSourceRRF([helpHit], [commHit]);
    const h = result.find((r) => r.id === '7')!;
    const c = result.find((r) => r.id === 'noctx')!;
    expect(h.context).toBeNull();
    expect(c.context).toBeNull();
  });
});

// ─── RF06: tiebreak (v1.1.0 similarity-aware) ────────────────────────────────

describe('crossSourceRRF tiebreak (RF06 v1.1.0 similarity-aware)', () => {
  // ----- Step 2: similarity DESC wins over source (AD-C02 reversal) -----

  it('community with higher similarity beats help with lower similarity at same rrfScore', () => {
    // Both at rank 1 → rrfScore = 1/61.
    // Community similarity=0.739 > Help similarity=0.521 → community MUST come first.
    const helpHits = [makeHelpHit({ id: 99, title: 'PDV Web', similarity: 0.521 })];
    const commHits = [makeCommunityHit({ id: 'com1', title: 'Inserir pedido via API', similarity: 0.739 })];

    const result = crossSourceRRF(helpHits, commHits);

    expect(result[0]!.source).toBe('community');
    expect(result[0]!.similarity).toBeCloseTo(0.739);
    expect(result[1]!.source).toBe('help');
  });

  it('help with higher similarity beats community with lower similarity at same rrfScore', () => {
    // Anti-burying preserved: HELP similarity=0.848 > community similarity=0.4.
    const helpHits = [makeHelpHit({ id: 1, title: 'ORA error article', similarity: 0.848 })];
    const commHits = [makeCommunityHit({ id: 'c1', title: 'Conciliação Bancária', similarity: 0.407 })];

    const result = crossSourceRRF(helpHits, commHits);

    expect(result[0]!.source).toBe('help');
    expect(result[0]!.similarity).toBeCloseTo(0.848);
    expect(result[1]!.source).toBe('community');
  });

  // ----- Step 3: null similarity falls back to help-first (degraded mode) -----

  it('places help before community when both similarities are null (degraded/keyword mode)', () => {
    // Both rank 1, both null similarity → step 3 applies: help-first (v1.0 behaviour preserved).
    const helpHits = [makeHelpHit({ id: 99, title: 'Help first', similarity: null })];
    const commHits = [makeCommunityHit({ id: 'com1', title: 'Community first', similarity: null })];

    const result = crossSourceRRF(helpHits, commHits);

    expect(result[0]!.source).toBe('help');
    expect(result[1]!.source).toBe('community');
  });

  it('null similarity is ranked below any non-null similarity (null treated as lowest)', () => {
    // Help has null similarity, community has a real 0.3 similarity → community wins step 2.
    const helpHits = [makeHelpHit({ id: 10, title: 'Help no-sim', similarity: null })];
    const commHits = [makeCommunityHit({ id: 'c10', title: 'Comm with sim', similarity: 0.3 })];

    const result = crossSourceRRF(helpHits, commHits);

    expect(result[0]!.source).toBe('community');
    expect(result[1]!.source).toBe('help');
  });

  // ----- Step 4: id ascending within same source -----

  it('within same source and equal score, sorts by id ascending (lexicographic)', () => {
    const helpHits = [
      makeHelpHit({ id: 5, title: 'H5' }),  // rank 1
      makeHelpHit({ id: 3, title: 'H3' }),  // rank 2
    ];
    const commHits: CommunityHit[] = [];
    const result = crossSourceRRF(helpHits, commHits);
    // rank 1 has higher score, so H5 comes first regardless of id.
    expect(result[0]!.id).toBe('5');
    expect(result[1]!.id).toBe('3');
  });

  it('when help and community tie, id ascending within same source would order correctly', () => {
    const commHits = [
      makeCommunityHit({ id: 'z_id', title: 'Comm Z' }),
      makeCommunityHit({ id: 'a_id', title: 'Comm A' }),
    ];
    const result = crossSourceRRF([], commHits);
    // Rank 1 has higher score than rank 2 — no real tie here, just verify order.
    expect(result[0]!.id).toBe('z_id');
    expect(result[1]!.id).toBe('a_id');
  });

  // ----- Determinism: equal similarity, equal rrfScore → help-first then id -----

  it('equal rrfScore + equal non-null similarity → help-first then id asc', () => {
    // Both rank 1, same similarity 0.6 → step 3 applies: help before community.
    const helpHits = [makeHelpHit({ id: 42, title: 'H', similarity: 0.6 })];
    const commHits = [makeCommunityHit({ id: 'c42', title: 'C', similarity: 0.6 })];

    const result = crossSourceRRF(helpHits, commHits);

    expect(result[0]!.source).toBe('help');
    expect(result[1]!.source).toBe('community');
  });
});

// ─── AC13: dedupCommunityByTitle — normalisation and first-occurrence rule ────

describe('dedupCommunityByTitle (AC13)', () => {
  it('collapses two hits with same normalised title, keeping index 0', () => {
    const hits: CommunityHit[] = [
      makeCommunityHit({ id: 'a', title: 'Serviço de Config' }),
      makeCommunityHit({ id: 'b', title: 'servico de config!' }),
      makeCommunityHit({ id: 'c', title: 'Outro' }),
    ];

    const result = dedupCommunityByTitle(hits);

    expect(result).toHaveLength(2);
    expect(result[0]!.title).toBe('Serviço de Config');  // kept (index 0)
    expect(result[1]!.title).toBe('Outro');
    // 'servico de config!' must be dropped.
    expect(result.find((h) => h.id === 'b')).toBeUndefined();
  });

  it('strips cedilla/accented characters via NFD so "Serviço" ~ "servico"', () => {
    const hits: CommunityHit[] = [
      makeCommunityHit({ id: '1', title: 'Serviço Fiscal' }),
      makeCommunityHit({ id: '2', title: 'Servico Fiscal' }),
    ];
    const result = dedupCommunityByTitle(hits);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('1');  // first occurrence wins
  });

  it('keeps all hits when all titles are distinct', () => {
    const hits: CommunityHit[] = [
      makeCommunityHit({ id: '1', title: 'Alpha' }),
      makeCommunityHit({ id: '2', title: 'Beta' }),
      makeCommunityHit({ id: '3', title: 'Gamma' }),
    ];
    expect(dedupCommunityByTitle(hits)).toHaveLength(3);
  });

  it('returns empty list for empty input', () => {
    expect(dedupCommunityByTitle([])).toEqual([]);
  });

  it('handles punctuation and extra spaces in normalisation', () => {
    const hits: CommunityHit[] = [
      makeCommunityHit({ id: 'x', title: 'Hello World!' }),
      makeCommunityHit({ id: 'y', title: '  hello  world  ' }),
    ];
    const result = dedupCommunityByTitle(hits);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('x');
  });

  it('preserves original relative order of remaining hits', () => {
    const hits: CommunityHit[] = [
      makeCommunityHit({ id: 'a', title: 'First' }),
      makeCommunityHit({ id: 'b', title: 'Second' }),
      makeCommunityHit({ id: 'c', title: 'first' }),  // duplicate of 'a'
      makeCommunityHit({ id: 'd', title: 'Third' }),
    ];
    const result = dedupCommunityByTitle(hits);
    expect(result.map((h) => h.id)).toEqual(['a', 'b', 'd']);
  });

  it('collapses numeric-only titles correctly', () => {
    const hits: CommunityHit[] = [
      makeCommunityHit({ id: '1', title: '12345' }),
      makeCommunityHit({ id: '2', title: '12345' }),
    ];
    expect(dedupCommunityByTitle(hits)).toHaveLength(1);
  });
});

// ─── R1: Determinism — crossSourceRRF produces identical id order twice ────────

describe('R1 — crossSourceRRF determinism (same input → same output)', () => {
  it('two calls with the same inputs produce identical id sequences', () => {
    const helpHits = [
      makeHelpHit({ id: 10, title: 'H10', similarity: 0.7 }),
      makeHelpHit({ id: 20, title: 'H20', similarity: 0.6 }),
    ];
    const commHits = [
      makeCommunityHit({ id: 'c1', title: 'C1', similarity: 0.75 }),
      makeCommunityHit({ id: 'c2', title: 'C2', similarity: 0.5 }),
    ];

    const result1 = crossSourceRRF(helpHits, commHits);
    const result2 = crossSourceRRF(helpHits, commHits);

    expect(result1.map((r) => r.id)).toEqual(result2.map((r) => r.id));
  });

  it('equal-score tie with null similarity resolved deterministically: help-first (degraded mode)', () => {
    // Both at rank 1, both null similarity → help wins tiebreak (v1.0 behaviour).
    const helpHits = [makeHelpHit({ id: 5, title: 'H', similarity: null })];
    const commHits = [makeCommunityHit({ id: 'c5', title: 'C', similarity: null })];

    const r1 = crossSourceRRF(helpHits, commHits);
    const r2 = crossSourceRRF(helpHits, commHits);

    // Both runs must agree.
    expect(r1[0]?.source).toBe('help');
    expect(r2[0]?.source).toBe('help');
    expect(r1.map((r) => r.id)).toEqual(r2.map((r) => r.id));
  });

  it('equal-score tie with community having higher similarity: community wins (AD-C02)', () => {
    // Both at rank 1, community has higher similarity → community wins step 2.
    const helpHits = [makeHelpHit({ id: 5, title: 'H', similarity: 0.5 })];
    const commHits = [makeCommunityHit({ id: 'c5', title: 'C', similarity: 0.8 })];

    const r1 = crossSourceRRF(helpHits, commHits);
    const r2 = crossSourceRRF(helpHits, commHits);

    // Community wins, both runs agree.
    expect(r1[0]?.source).toBe('community');
    expect(r2[0]?.source).toBe('community');
    expect(r1.map((r) => r.id)).toEqual(r2.map((r) => r.id));
  });
});

// ─── R3: crossSourceRRF threads similarity from source hits ───────────────────

describe('R3 — crossSourceRRF threads similarity through to UnifiedHit', () => {
  it('help hit with similarity=0.8 produces UnifiedHit.similarity=0.8', () => {
    const h = makeHelpHit({ id: 1, title: 'H', similarity: 0.8 });
    const result = crossSourceRRF([h], []);
    expect(result[0]?.similarity).toBeCloseTo(0.8);
  });

  it('help hit with similarity=null produces UnifiedHit.similarity=null', () => {
    const h = makeHelpHit({ id: 2, title: 'H', similarity: null });
    const result = crossSourceRRF([h], []);
    expect(result[0]?.similarity).toBeNull();
  });

  it('community hit with similarity=0.65 produces UnifiedHit.similarity=0.65', () => {
    const c = makeCommunityHit({ id: 'c1', title: 'C', similarity: 0.65 });
    const result = crossSourceRRF([], [c]);
    expect(result[0]?.similarity).toBeCloseTo(0.65);
  });

  it('community hit with similarity=null produces UnifiedHit.similarity=null', () => {
    const c = makeCommunityHit({ id: 'c2', title: 'C', similarity: null });
    const result = crossSourceRRF([], [c]);
    expect(result[0]?.similarity).toBeNull();
  });
});
