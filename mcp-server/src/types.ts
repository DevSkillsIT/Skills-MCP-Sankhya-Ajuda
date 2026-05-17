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

/** MCP resource URI types under the sankhya-ajuda:// namespace. */
export const MCP_RESOURCE_TYPES = {
  CATEGORIES: 'categories',
  SECTIONS: 'sections',
  ARTICLES: 'articles',
  SYNC_STATE: 'sync_state',
} as const;

export type McpResourceType =
  (typeof MCP_RESOURCE_TYPES)[keyof typeof MCP_RESOURCE_TYPES];
