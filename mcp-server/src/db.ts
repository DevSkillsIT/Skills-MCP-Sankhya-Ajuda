/**
 * Read-only database layer.
 * Consumes the Postgres schema populated by the Phase 1 ETL — no writes here.
 *
 * Coupling with Phase 1: ONLY via SQL schema (tables: articles, sections,
 * categories, sync_state; view: article_breadcrumb).
 */

import pg from 'pg';
import pgvector from 'pgvector/pg';
import type { Settings } from './config.js';
import type {
  SearchHit,
  ArticleFull,
  CategoryRow,
  SectionRow,
  SyncState,
  SearchMode,
} from './types.js';

const { Pool } = pg;
export type Pool = pg.Pool;

// ─── Pool factory ─────────────────────────────────────────────────────────────

/**
 * Build a configured pg.Pool with pgvector halfvec type registration.
 *
 * The registration runs as the pool's first action on every new connection so
 * halfvec(2560) results are parsed into number[] instead of raw strings.
 */
export async function buildPool(settings: Settings): Promise<Pool> {
  const pool = new Pool({
    host: settings.pg.host,
    port: settings.pg.port,
    database: settings.pg.database,
    user: settings.pg.user,
    password: settings.pg.password,
    min: settings.pg.poolMin,
    max: settings.pg.poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  // Register the halfvec/vector type parsers on every new connection.
  pool.on('connect', (client) => {
    pgvector.registerTypes(client).catch(() => {
      // Best-effort: registration is per-connection and idempotent.
    });
  });

  // Probe once to ensure the pool is reachable AND register types eagerly on
  // the first connection (avoids first query returning halfvec as string).
  const client = await pool.connect();
  try {
    await pgvector.registerTypes(client);
  } finally {
    client.release();
  }

  return pool;
}

// ─── hybridSearch (RF06 + CI-08) ──────────────────────────────────────────────

export interface HybridSearchArgs {
  query: string;
  qvec: number[] | null;
  limit: number;
  categoryId: number | null;
  includeOutdated: boolean;
  mode: SearchMode;
  rrfK?: number;
}

/**
 * Execute hybrid / semantic / keyword search depending on `mode`.
 * Returns rows ordered by descending score with breadcrumb materialized
 * from the article_breadcrumb view.
 */
export async function hybridSearch(
  pool: Pool,
  args: HybridSearchArgs,
): Promise<SearchHit[]> {
  const { query, qvec, limit, categoryId, includeOutdated, mode } = args;
  const k = args.rrfK ?? 60;

  if (mode === 'keyword') {
    return runKeywordOnly(pool, query, limit, categoryId, includeOutdated);
  }

  if (mode === 'semantic') {
    if (!qvec) {
      // The caller is responsible for ensuring qvec is present for semantic.
      // We treat absence as zero-result rather than throw — handlers decide.
      return [];
    }
    return runSemanticOnly(pool, qvec, limit, categoryId, includeOutdated);
  }

  // hybrid (default): both rankings via RRF, requires qvec.
  if (!qvec) {
    return runKeywordOnly(pool, query, limit, categoryId, includeOutdated);
  }

  const vectorLiteral = pgvector.toSql(qvec);

  // CI-08: SELECT final includes a.outdated for the "(obsoleto)" suffix.
  const sql = `
    WITH semantic AS (
      SELECT a.id, ROW_NUMBER() OVER (ORDER BY a.embedding <=> $1::halfvec) AS rank
      FROM articles a
      WHERE a.embedding IS NOT NULL
        AND (NOT a.outdated OR $5::bool)
        AND ($4::bigint IS NULL OR a.section_id IN (
            SELECT id FROM sections WHERE category_id = $4::bigint))
      ORDER BY a.embedding <=> $1::halfvec
      LIMIT 50
    ),
    keyword AS (
      SELECT a.id, ROW_NUMBER() OVER (
        ORDER BY ts_rank_cd(a.tsv, plainto_tsquery('portuguese_unaccent', $2)) DESC
      ) AS rank
      FROM articles a
      WHERE a.tsv @@ plainto_tsquery('portuguese_unaccent', $2)
        AND (NOT a.outdated OR $5::bool)
        AND ($4::bigint IS NULL OR a.section_id IN (
            SELECT id FROM sections WHERE category_id = $4::bigint))
      LIMIT 50
    ),
    fused AS (
      SELECT id, SUM(1.0 / ($6::int + rank)) AS rrf_score
      FROM (SELECT id, rank FROM semantic UNION ALL SELECT id, rank FROM keyword) u
      GROUP BY id
    )
    SELECT a.id, a.title, ab.path AS breadcrumb, a.html_url, a.outdated,
           f.rrf_score AS score
    FROM fused f
    JOIN articles a ON a.id = f.id
    LEFT JOIN article_breadcrumb ab ON ab.article_id = a.id
    ORDER BY f.rrf_score DESC
    LIMIT $3::int;
  `;

  const result = await pool.query<SearchHit>(sql, [
    vectorLiteral,
    query,
    limit,
    categoryId,
    includeOutdated,
    k,
  ]);

  return result.rows.map((r) => ({
    id: Number(r.id),
    title: r.title,
    breadcrumb: r.breadcrumb ?? null,
    html_url: r.html_url,
    outdated: r.outdated,
    score: Number(r.score),
  }));
}

async function runSemanticOnly(
  pool: Pool,
  qvec: number[],
  limit: number,
  categoryId: number | null,
  includeOutdated: boolean,
): Promise<SearchHit[]> {
  const sql = `
    SELECT a.id, a.title, ab.path AS breadcrumb, a.html_url, a.outdated,
           1.0 - (a.embedding <=> $1::halfvec) AS score
    FROM articles a
    LEFT JOIN article_breadcrumb ab ON ab.article_id = a.id
    WHERE a.embedding IS NOT NULL
      AND (NOT a.outdated OR $4::bool)
      AND ($3::bigint IS NULL OR a.section_id IN (
          SELECT id FROM sections WHERE category_id = $3::bigint))
    ORDER BY a.embedding <=> $1::halfvec
    LIMIT $2::int;
  `;
  const result = await pool.query<SearchHit>(sql, [
    pgvector.toSql(qvec),
    limit,
    categoryId,
    includeOutdated,
  ]);
  return result.rows.map((r) => ({
    id: Number(r.id),
    title: r.title,
    breadcrumb: r.breadcrumb ?? null,
    html_url: r.html_url,
    outdated: r.outdated,
    score: Number(r.score),
  }));
}

async function runKeywordOnly(
  pool: Pool,
  query: string,
  limit: number,
  categoryId: number | null,
  includeOutdated: boolean,
): Promise<SearchHit[]> {
  const sql = `
    SELECT a.id, a.title, ab.path AS breadcrumb, a.html_url, a.outdated,
           ts_rank_cd(a.tsv, plainto_tsquery('portuguese_unaccent', $1)) AS score
    FROM articles a
    LEFT JOIN article_breadcrumb ab ON ab.article_id = a.id
    WHERE a.tsv @@ plainto_tsquery('portuguese_unaccent', $1)
      AND (NOT a.outdated OR $4::bool)
      AND ($3::bigint IS NULL OR a.section_id IN (
          SELECT id FROM sections WHERE category_id = $3::bigint))
    ORDER BY score DESC
    LIMIT $2::int;
  `;
  const result = await pool.query<SearchHit>(sql, [
    query,
    limit,
    categoryId,
    includeOutdated,
  ]);
  return result.rows.map((r) => ({
    id: Number(r.id),
    title: r.title,
    breadcrumb: r.breadcrumb ?? null,
    html_url: r.html_url,
    outdated: r.outdated,
    score: Number(r.score),
  }));
}

// ─── getArticleFull ──────────────────────────────────────────────────────────

export async function getArticleFull(
  pool: Pool,
  articleId: number,
  maxBodyChars: number,
): Promise<ArticleFull | null> {
  const sql = `
    SELECT a.id, a.section_id, a.title, ab.path AS breadcrumb,
           a.body_text, a.html_url, a.label_names, a.outdated, a.author_id,
           a.created_at_zendesk AS created_at,
           a.updated_at_zendesk AS updated_at,
           a.edited_at_zendesk AS edited_at,
           a.synced_at
    FROM articles a
    LEFT JOIN article_breadcrumb ab ON ab.article_id = a.id
    WHERE a.id = $1::bigint
    LIMIT 1;
  `;
  const result = await pool.query<{
    id: string | number;
    section_id: string | number;
    title: string;
    breadcrumb: string | null;
    body_text: string;
    html_url: string;
    label_names: string[] | null;
    outdated: boolean;
    author_id: string | number | null;
    created_at: Date | null;
    updated_at: Date | null;
    edited_at: Date | null;
    synced_at: Date;
  }>(sql, [articleId]);

  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  if (!row) return null;

  const fullChars = row.body_text.length;
  const truncated = fullChars > maxBodyChars;
  const body = truncated ? row.body_text.slice(0, maxBodyChars) : row.body_text;

  return {
    id: Number(row.id),
    section_id: Number(row.section_id),
    title: row.title,
    breadcrumb: row.breadcrumb ?? null,
    body_text: body,
    body_text_truncated: truncated,
    body_text_full_chars: fullChars,
    html_url: row.html_url,
    label_names: row.label_names ?? [],
    outdated: row.outdated,
    author_id: row.author_id !== null ? Number(row.author_id) : null,
    created_at: row.created_at ? row.created_at.toISOString() : null,
    updated_at: row.updated_at ? row.updated_at.toISOString() : null,
    edited_at: row.edited_at ? row.edited_at.toISOString() : null,
    synced_at: row.synced_at.toISOString(),
  };
}

// ─── listCategories ──────────────────────────────────────────────────────────

export async function listCategories(pool: Pool): Promise<CategoryRow[]> {
  const sql = `
    SELECT c.id, c.name, c.html_url, c.position, c.synced_at,
           COUNT(a.id) AS article_count
    FROM categories c
    LEFT JOIN sections s ON s.category_id = c.id
    LEFT JOIN articles a ON a.section_id = s.id
    GROUP BY c.id
    ORDER BY c.position, c.name;
  `;
  const result = await pool.query<{
    id: string | number;
    name: string;
    html_url: string;
    position: number;
    synced_at: Date;
    article_count: string | number;
  }>(sql);

  return result.rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    html_url: r.html_url,
    position: Number(r.position),
    article_count: Number(r.article_count),
    synced_at: r.synced_at.toISOString(),
  }));
}

// ─── listSections ────────────────────────────────────────────────────────────

export async function listSections(
  pool: Pool,
  categoryId: number | null,
  parentSectionId: number | null,
): Promise<SectionRow[]> {
  const sql = `
    SELECT s.id, s.category_id, c.name AS category_name,
           s.parent_section_id, s.name, s.html_url, s.position, s.synced_at,
           (SELECT COUNT(*) FROM articles a WHERE a.section_id = s.id) AS article_count
    FROM sections s
    JOIN categories c ON c.id = s.category_id
    WHERE ($1::bigint IS NULL OR s.category_id = $1::bigint)
      AND (
        $2::bigint IS NULL
        OR s.parent_section_id = $2::bigint
      )
    ORDER BY c.position, s.position, s.name;
  `;
  const result = await pool.query<{
    id: string | number;
    category_id: string | number;
    category_name: string;
    parent_section_id: string | number | null;
    name: string;
    html_url: string;
    position: number;
    synced_at: Date;
    article_count: string | number;
  }>(sql, [categoryId, parentSectionId]);

  return result.rows.map((r) => ({
    id: Number(r.id),
    category_id: Number(r.category_id),
    category_name: r.category_name,
    parent_section_id: r.parent_section_id !== null ? Number(r.parent_section_id) : null,
    name: r.name,
    html_url: r.html_url,
    position: Number(r.position),
    article_count: Number(r.article_count),
    synced_at: r.synced_at.toISOString(),
  }));
}

// ─── getSyncState (CC-02) ────────────────────────────────────────────────────

export async function getSyncState(pool: Pool): Promise<SyncState> {
  const sql = `
    SELECT
      (SELECT COUNT(*)::bigint FROM articles) AS articles_count,
      (SELECT COUNT(*)::bigint FROM articles WHERE embedding IS NOT NULL) AS with_embedding_count,
      ss.last_status AS last_sync_status,
      ss.last_full_sync_at AS last_sync_at,
      ss.error_count,
      ss.last_error
    FROM sync_state ss
    WHERE ss.id = 1;
  `;
  const result = await pool.query<{
    articles_count: string | number;
    with_embedding_count: string | number;
    last_sync_status: string;
    last_sync_at: Date | null;
    error_count: string | number;
    last_error: string | null;
  }>(sql);

  const row = result.rows[0] ?? {
    articles_count: 0,
    with_embedding_count: 0,
    last_sync_status: 'never',
    last_sync_at: null,
    error_count: 0,
    last_error: null,
  };

  return {
    articles_count: Number(row.articles_count),
    with_embedding_count: Number(row.with_embedding_count),
    last_sync_status: row.last_sync_status || 'never',
    last_sync_at: row.last_sync_at ? row.last_sync_at.toISOString() : null,
    error_count: Number(row.error_count),
    last_error: row.last_error,
  };
}
