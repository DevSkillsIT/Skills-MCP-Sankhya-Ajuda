/**
 * Shared type definitions for the Sankhya Ajuda MCP server.
 */

/** Search execution mode (mirrors RF06 / RF07). */
export type SearchMode = 'hybrid' | 'semantic' | 'keyword';

/** Mode actually used in the response (includes keyword_fallback for RF07). */
export type SearchModeReported =
  | 'hybrid'
  | 'semantic'
  | 'keyword'
  | 'keyword_fallback'
  | 'keyword_index_mismatch';

/** Row returned by hybridSearch. */
export interface SearchHit {
  id: number;
  title: string;
  breadcrumb: string | null;
  html_url: string;
  outdated: boolean;
  score: number;
  /**
   * Cosine similarity to the query vector: 1 - (embedding <=> qvec).
   * Present only in hybrid/semantic branches where qvec is available.
   * null in keyword-only mode (R3).
   */
  similarity: number | null;
}

/** Article details returned by getArticleFull. */
export interface ArticleFull {
  id: number;
  section_id: number;
  title: string;
  breadcrumb: string | null;
  body_text: string;
  body_text_truncated: boolean;
  body_text_full_chars: number;
  html_url: string;
  label_names: string[];
  outdated: boolean;
  author_id: number | null;
  created_at: string | null;
  updated_at: string | null;
  edited_at: string | null;
  synced_at: string;
}

export interface CategoryRow {
  id: number;
  name: string;
  html_url: string;
  position: number;
  article_count: number;
  synced_at: string;
}

export interface SectionRow {
  id: number;
  category_id: number;
  category_name: string;
  parent_section_id: number | null;
  name: string;
  html_url: string;
  position: number;
  article_count: number;
  synced_at: string;
}

export interface SyncState {
  articles_count: number;
  with_embedding_count: number;
  last_sync_status: string;
  last_sync_at: string | null;
  error_count: number;
  last_error: string | null;
}

// ─── Community types (SPEC-SANKHYA-COMMUNITY-001 Phase 0) ─────────────────────

/**
 * Arguments for hybridSearchCommunity — mirrors HybridSearchArgs but without
 * categoryId / includeOutdated (community_posts has no such columns, see C3).
 */
export interface CommunitySearchArgs {
  query: string;
  qvec: number[] | null;
  limit: number;
  mode: SearchMode;
  rrfK?: number;
  distThreshold?: number | null;
}

/**
 * Single result row from hybridSearchCommunity.
 * id is TEXT (Bettermode alphanumeric), score is the intra-source RRF score.
 * context holds the space name (subquery from community_spaces).
 */
export interface CommunityHit {
  id: string;
  title: string;
  context: string | null;
  url: string;
  score: number;
  /**
   * Cosine similarity to the query vector: 1 - (embedding <=> qvec).
   * Present only in hybrid/semantic branches where qvec is available.
   * null in keyword-only mode (R3).
   */
  similarity: number | null;
  /** Whether the post has an accepted answer — used for R8 soft-boost. */
  has_accepted_answer: boolean;
  /** Number of replies on the post — used as secondary R8 tiebreak. */
  replies_count: number;
}

/**
 * Normalised cross-source result produced by crossSourceRRF (C1/C2).
 *
 * @MX:ANCHOR: [AUTO] Invariant contract — crossSourceRRF output shape.
 * @MX:REASON: This interface is the contract consumed by every Fase 1 tool and
 *             formatter. Any field addition or rename requires updating all
 *             callers in search-unified.ts and the Markdown formatter.
 * @MX:SPEC: SPEC-SANKHYA-COMMUNITY-001 C2
 */
export interface UnifiedHit {
  /** Source corpus of this result. */
  source: 'help' | 'community';
  /** True if and only if source === 'help'. */
  isOfficial: boolean;
  /** Always a string — help BIGINT is coerced via String(id). */
  id: string;
  title: string;
  /** help: article breadcrumb path; community: space name. */
  context: string | null;
  url: string;
  /** Cross-source RRF score: 1 / (k + sourceRank). */
  rrfScore: number;
  /** 1-indexed position in this result's source list (used to compute rrfScore). */
  sourceRank: number;
  /**
   * Cosine similarity to query vector: 1 - (embedding <=> qvec).
   * Informational signal (comparable across sources via shared /model space).
   * null in keyword/degraded mode (R3).
   */
  similarity: number | null;
}

/** Full post returned by getCommunityPost. */
export interface CommunityPostFull {
  id: string;
  space_name: string;
  title: string;
  url: string;
  body_text: string;
  body_text_truncated: boolean;
  body_text_full_chars: number;
  post_type: string | null;
  tags: string[];
  has_accepted_answer: boolean;
  reactions_count: number;
  author_name: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** Row returned by listCommunitySpaces. */
export interface CommunitySpaceRow {
  id: string;
  name: string;
  slug: string;
  url: string;
  posts_count: number;
  members_count: number;
}

// ─── MCP resource URI types ────────────────────────────────────────────────────

/** MCP resource URI types under the sankhya-ajuda:// namespace. */
export const MCP_RESOURCE_TYPES = {
  CATEGORIES: 'categories',
  SECTIONS: 'sections',
  ARTICLES: 'articles',
  SYNC_STATE: 'sync_state',
} as const;

export type McpResourceType =
  (typeof MCP_RESOURCE_TYPES)[keyof typeof MCP_RESOURCE_TYPES];
