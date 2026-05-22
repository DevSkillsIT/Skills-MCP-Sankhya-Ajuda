/**
 * Pure RRF (Reciprocal Rank Fusion) helpers for cross-source search.
 * No DB, no I/O, no side effects — fully unit-testable with fixtures.
 *
 * Two operations are defined here:
 *   1. dedupCommunityByTitle  — collapses near-duplicate community posts (C6)
 *   2. crossSourceRRF         — fuses help and community ranked lists (C1/C2)
 *
 * @MX:NOTE: [AUTO] RRF-by-position rationale:
 *   Intra-source scores (hybrid RRF, cosine similarity, ts_rank_cd) are
 *   incomparable across corpora. The only comparable unit is array position
 *   within each source list. crossSourceRRF therefore uses 1-indexed array
 *   position (sourceRank) as the input to the RRF formula, ignoring the raw
 *   .score field entirely.
 * @MX:SPEC: SPEC-SANKHYA-COMMUNITY-001 C1, C2, C6, RF03, RF04, RF06
 */

import type { SearchHit, CommunityHit, UnifiedHit } from '../types.js';

// ─── dedupCommunityByTitle ────────────────────────────────────────────────────

/**
 * Collapse community hits whose titles normalise to the same key (C6).
 *
 * Normalisation steps (NORMATIVE per C6):
 *   1. NFD decomposition + strip combining diacritics → "Serviço" → "servico"
 *   2. toLowerCase
 *   3. replace non-alphanumeric sequences with a single space
 *   4. trim
 *
 * Input order is preserved.  Only the first occurrence of each key (lowest
 * array index = best intra-source rank) is kept; duplicates are discarded.
 *
 * The help corpus is never passed to this function — dedup is community-only.
 *
 * @MX:NOTE: [AUTO] Dedup business rule:
 *   ~10.5% of community posts are reposts with identical normalised titles
 *   (measured: "Serviço de configuração de processos no Flow" appeared 6× in
 *   a single result set). Without dedup the top-limit would be dominated by
 *   one recurring thread.
 */
export function dedupCommunityByTitle(hits: CommunityHit[]): CommunityHit[] {
  const seen = new Set<string>();
  const result: CommunityHit[] = [];

  for (const hit of hits) {
    // Step 1: NFD + strip combining diacritics (Unicode category Mn, range U+0300-U+036F)
    const normalised = hit.title
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();

    if (!seen.has(normalised)) {
      seen.add(normalised);
      result.push(hit);
    }
  }

  return result;
}

// ─── crossSourceRRF ───────────────────────────────────────────────────────────

/**
 * Fuse two ranked lists (help and community) via cross-source RRF (C1).
 *
 * @MX:ANCHOR: [AUTO] High-fan_in invariant — called by every Fase 1 formatter.
 * @MX:REASON: This function is the central ranking contract for unified search.
 *   Any change to the scoring formula or tiebreak order affects every caller
 *   in search-unified.ts and all downstream Markdown formatters.
 * @MX:SPEC: SPEC-SANKHYA-COMMUNITY-001 C1, C2, RF03, RF06
 *
 * Algorithm (NORMATIVE — v1.1.0 AD-C02 enacted):
 *   - sourceRank = 1-indexed array position in the source list (NOT .score)
 *   - rrfScore   = 1 / (k + sourceRank)
 *   - Tiebreak (RF06 v1.1.0, deterministic, in order):
 *       1. rrfScore DESC          — RRF position is still the backbone
 *       2. similarity DESC        — more semantically-similar result wins the rank-pair;
 *                                   null similarity (keyword/degraded) treated as lowest,
 *                                   falling back to the v1.0 behaviour (help-first) so
 *                                   degraded mode is unchanged
 *       3. source==='help' first  — tiebreak only when similarities are equal or both null
 *       4. id ascending           — determinism within same source
 *
 * Rationale (AD-C02 reversal):
 *   A community answer with similarity=0.739 was buried below a HELP article with
 *   similarity=0.521 at the same RRF position because the v1.0 tiebreak was
 *   unconditionally help-first. The similarity tiebreak surfaces the more semantically-
 *   similar answer regardless of source, while preserving anti-burying (AC02) for
 *   official-error queries where HELP articles have competitive/higher similarity.
 *
 * Callers MUST pass the already-deduped community list so that sourceRank
 * reflects post-dedup positions.
 *
 * @param helpHits      - Ordered help results (best first).
 * @param communityHits - Ordered, already-deduped community results (best first).
 * @param k             - RRF constant (default 60, matching intra-source k).
 * @returns Merged list sorted desc by rrfScore with deterministic tiebreak.
 */
export function crossSourceRRF(
  helpHits: SearchHit[],
  communityHits: CommunityHit[],
  k = 60,
): UnifiedHit[] {
  const unified: UnifiedHit[] = [];

  // Map help hits — id is BIGINT in SearchHit (number), coerce to string (C2).
  // R3: thread similarity from the DB result through the UnifiedHit.
  for (let i = 0; i < helpHits.length; i++) {
    const hit = helpHits[i]!;
    const sourceRank = i + 1;
    unified.push({
      source: 'help',
      isOfficial: true,
      id: String(hit.id),
      title: hit.title,
      context: hit.breadcrumb ?? null,
      url: hit.html_url,
      rrfScore: 1 / (k + sourceRank),
      sourceRank,
      similarity: hit.similarity ?? null,
    });
  }

  // Map community hits — id is already TEXT (string).
  // R3: thread similarity from the DB result through the UnifiedHit.
  for (let i = 0; i < communityHits.length; i++) {
    const hit = communityHits[i]!;
    const sourceRank = i + 1;
    unified.push({
      source: 'community',
      isOfficial: false,
      id: hit.id,
      title: hit.title,
      context: hit.context ?? null,
      url: hit.url,
      rrfScore: 1 / (k + sourceRank),
      sourceRank,
      similarity: hit.similarity ?? null,
    });
  }

  // Sort descending by rrfScore, then by the similarity-aware tiebreak (RF06 v1.1.0).
  //
  // Step 1: rrfScore DESC (position backbone — unchanged from v1.0).
  // Step 2: similarity DESC (AD-C02 reversal — more semantically-similar wins).
  //         null similarity (keyword/degraded mode) is treated as -Infinity so
  //         the v1.0 help-first fallback applies (step 3) for degraded queries.
  // Step 3: source==='help' first (anti-burying, only triggers when similarities
  //         are equal OR both null — preserves AC02 for official-error queries).
  // Step 4: id ascending (lexicographic determinism within same source).
  unified.sort((a, b) => {
    // Step 1: rrfScore DESC.
    if (b.rrfScore !== a.rrfScore) return b.rrfScore - a.rrfScore;

    // Step 2: similarity DESC with null-as-lowest sentinel.
    const simA = a.similarity ?? -Infinity;
    const simB = b.similarity ?? -Infinity;
    if (simB !== simA) return simB - simA;

    // Step 3: help-first (identical similarities, including both-null degraded case).
    if (a.source !== b.source) {
      return a.source === 'help' ? -1 : 1;
    }

    // Step 4: id ascending (lexicographic determinism within same source).
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return unified;
}
