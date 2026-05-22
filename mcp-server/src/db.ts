/**
 * Read-only database layer.
 * Consumes the Postgres schema populated by the Phase 1 ETL — no writes here.
 *
 * Coupling with Phase 1: ONLY via SQL schema (tables: articles, sections,
 * categories, sync_state; view: article_breadcrumb).
 */

import pg from 'pg';
import pgvector, { fromSql as pgvectorFromSql } from 'pgvector';
import type { Settings } from './config.js';
import type {
  SearchHit,
  ArticleFull,
  CategoryRow,
  SectionRow,
  SyncState,
  SearchMode,
  CommunitySearchArgs,
  CommunityHit,
  CommunityPostFull,
  CommunitySpaceRow,
} from './types.js';

const { Pool } = pg;
export type Pool = pg.Pool;

// ─── Pool factory ─────────────────────────────────────────────────────────────

/**
 * Build a configured pg.Pool with pgvector halfvec type registration.
 *
 * Type parsers are registered GLOBALLY (pg.types.setTypeParser) using OIDs
 * resolved from one startup query. This avoids the per-connection
 * registerTypes() approach which issued a query on every new connection event
 * and caused a "client already executing a query" DeprecationWarning when two
 * connections were opened concurrently (e.g. source=all Promise.all path).
 *
 * @MX:NOTE: [AUTO] Global OID registration replaces per-connection handler.
 * @MX:REASON: per-connection pgvector.registerTypes() fired a query inside the
 *   pool 'connect' event, creating a race when parallel queries opened two fresh
 *   connections simultaneously — two queries on one client, protocol corruption risk.
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

  // Probe once: verify reachability AND resolve pgvector type OIDs so we can
  // register GLOBAL parsers. Global parsers (pg.types.setTypeParser) apply to
  // every pooled connection without issuing a per-connection query, eliminating
  // the "client already executing" race that the old pool.on('connect') handler
  // produced under concurrent load.
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ typname: string; oid: string }>(
      "SELECT typname, oid FROM pg_type WHERE typname IN ('vector', 'halfvec', 'sparsevec')",
    );
    for (const row of rows) {
      // pgvectorFromSql handles vector, halfvec, and sparsevec text formats,
      // converting "[1,2,3]" into number[].
      pg.types.setTypeParser(Number(row.oid), (v: string) => pgvectorFromSql(v));
    }
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
  /**
   * Optional cosine-distance upper bound for the semantic CTE only (C5/RF05).
   * When absent or null the SQL is byte-identical to the pre-C5 version so the
   * existing sankhya_ajuda_search_articles tool is completely unaffected (RF07/AC14).
   */
  distThreshold?: number | null;
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
  // distThreshold is optional; undefined/null = no filter (existing default behaviour).
  const distThreshold = args.distThreshold ?? null;

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

  // C5/RF05: when distThreshold is a number, inject it into the semantic CTE
  // WHERE clause only.  When absent/null the SQL is byte-identical to the
  // original so the existing sankhya_ajuda_search_articles is unaffected (RF07/AC14).
  const distFilter =
    distThreshold !== null
      ? `AND (a.embedding <=> $1::halfvec) <= ${distThreshold}`
      : '';

  // CI-08: SELECT final includes a.outdated for the "(obsoleto)" suffix.
  // R1: stable tiebreak ORDER BY f.rrf_score DESC, a.id eliminates non-determinism.
  // R3: similarity = 1 - (embedding <=> qvec) selected in the final projection.
  const sql = `
    WITH semantic AS (
      SELECT a.id, ROW_NUMBER() OVER (ORDER BY a.embedding <=> $1::halfvec) AS rank
      FROM articles a
      WHERE a.embedding IS NOT NULL
        AND (NOT a.outdated OR $5::bool)
        AND ($4::bigint IS NULL OR a.section_id IN (
            SELECT id FROM sections WHERE category_id = $4::bigint))
        ${distFilter}
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
           f.rrf_score AS score,
           1.0 - (a.embedding <=> $1::halfvec) AS similarity
    FROM fused f
    JOIN articles a ON a.id = f.id
    LEFT JOIN article_breadcrumb ab ON ab.article_id = a.id
    ORDER BY f.rrf_score DESC, a.id
    LIMIT $3::int;
  `;

  const result = await pool.query<SearchHit & { similarity: string | number | null }>(sql, [
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
    similarity: r.similarity !== null && r.similarity !== undefined ? Number(r.similarity) : null,
  }));
}

async function runSemanticOnly(
  pool: Pool,
  qvec: number[],
  limit: number,
  categoryId: number | null,
  includeOutdated: boolean,
): Promise<SearchHit[]> {
  // R1: stable tiebreak ORDER BY distance, a.id eliminates non-determinism for ties.
  // R3: similarity = 1 - distance.
  const sql = `
    SELECT a.id, a.title, ab.path AS breadcrumb, a.html_url, a.outdated,
           1.0 - (a.embedding <=> $1::halfvec) AS score,
           1.0 - (a.embedding <=> $1::halfvec) AS similarity
    FROM articles a
    LEFT JOIN article_breadcrumb ab ON ab.article_id = a.id
    WHERE a.embedding IS NOT NULL
      AND (NOT a.outdated OR $4::bool)
      AND ($3::bigint IS NULL OR a.section_id IN (
          SELECT id FROM sections WHERE category_id = $3::bigint))
    ORDER BY a.embedding <=> $1::halfvec, a.id
    LIMIT $2::int;
  `;
  const result = await pool.query<SearchHit & { similarity: string | number | null }>(sql, [
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
    similarity: r.similarity !== null && r.similarity !== undefined ? Number(r.similarity) : null,
  }));
}

async function runKeywordOnly(
  pool: Pool,
  query: string,
  limit: number,
  categoryId: number | null,
  includeOutdated: boolean,
): Promise<SearchHit[]> {
  // R1: stable tiebreak ORDER BY score DESC, a.id eliminates non-determinism for ties.
  // R3: similarity is null in keyword-only mode (no vector available).
  const sql = `
    SELECT a.id, a.title, ab.path AS breadcrumb, a.html_url, a.outdated,
           ts_rank_cd(a.tsv, plainto_tsquery('portuguese_unaccent', $1)) AS score
    FROM articles a
    LEFT JOIN article_breadcrumb ab ON ab.article_id = a.id
    WHERE a.tsv @@ plainto_tsquery('portuguese_unaccent', $1)
      AND (NOT a.outdated OR $4::bool)
      AND ($3::bigint IS NULL OR a.section_id IN (
          SELECT id FROM sections WHERE category_id = $3::bigint))
    ORDER BY score DESC, a.id
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
    similarity: null,
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

// ─── hybridSearchCommunity (SPEC-SANKHYA-COMMUNITY-001, C1/C3/C5) ────────────

/**
 * Hybrid / keyword / semantic search over community_posts.
 *
 * @MX:NOTE: [AUTO] Exact mirror of hybridSearch but targeting community_posts.
 *   id stays as TEXT (Bettermode alphanumeric). context = space name subquery.
 *   distThreshold (C5) applies to the semantic CTE WHERE clause only.
 *
 * Intra-source RRF formula: SUM(1.0 / (k + rank)), k=60.
 * Returned list is ordered rrf_score DESC; callers use array position as sourceRank.
 */
export async function hybridSearchCommunity(
  pool: Pool,
  args: CommunitySearchArgs,
): Promise<CommunityHit[]> {
  const { query, qvec, limit, mode } = args;
  const k = args.rrfK ?? 60;
  const distThreshold = args.distThreshold ?? null;

  if (mode === 'keyword') {
    return runCommunityKeywordOnly(pool, query, limit);
  }

  if (mode === 'semantic') {
    if (!qvec) {
      return [];
    }
    return runCommunitySemanticOnly(pool, qvec, limit, distThreshold);
  }

  // hybrid: both CTEs via RRF, requires qvec.
  if (!qvec) {
    return runCommunityKeywordOnly(pool, query, limit);
  }

  const vectorLiteral = pgvector.toSql(qvec);

  // C5: inject distThreshold into semantic CTE WHERE only; never into keyword.
  const distFilter =
    distThreshold !== null
      ? `AND (p.embedding <=> $1::halfvec) <= ${distThreshold}`
      : '';

  // R1+R8: combined stable tiebreak: rrf_score DESC, has_accepted_answer DESC,
  //   replies_count DESC, p.id — answered posts soft-boosted, ties deterministic.
  // R3: similarity = 1 - (embedding <=> qvec) selected in final projection.
  const sql = `
    WITH semantic AS (
      SELECT p.id, ROW_NUMBER() OVER (ORDER BY p.embedding <=> $1::halfvec) AS rank
      FROM community_posts p
      WHERE p.embedding IS NOT NULL
        AND p.status = 'PUBLISHED'
        ${distFilter}
      ORDER BY p.embedding <=> $1::halfvec
      LIMIT 50
    ),
    keyword AS (
      SELECT p.id, ROW_NUMBER() OVER (
        ORDER BY ts_rank_cd(p.tsv, plainto_tsquery('portuguese_unaccent', $2)) DESC
      ) AS rank
      FROM community_posts p
      WHERE p.tsv @@ plainto_tsquery('portuguese_unaccent', $2)
        AND p.status = 'PUBLISHED'
      LIMIT 50
    ),
    fused AS (
      SELECT id, SUM(1.0 / ($4::int + rank)) AS rrf_score
      FROM (SELECT id, rank FROM semantic UNION ALL SELECT id, rank FROM keyword) u
      GROUP BY id
    )
    SELECT p.id, p.title,
           (SELECT s.name FROM community_spaces s WHERE s.id = p.space_id) AS context,
           p.url,
           f.rrf_score AS score,
           1.0 - (p.embedding <=> $1::halfvec) AS similarity,
           p.has_accepted_answer,
           p.replies_count
    FROM fused f
    JOIN community_posts p ON p.id = f.id
    ORDER BY f.rrf_score DESC, p.has_accepted_answer DESC, p.replies_count DESC, p.id
    LIMIT $3::int;
  `;

  const result = await pool.query<{
    id: string;
    title: string;
    context: string | null;
    url: string;
    score: string | number;
    similarity: string | number | null;
    has_accepted_answer: boolean;
    replies_count: number | string;
  }>(sql, [vectorLiteral, query, limit, k]);

  return result.rows.map((r) => ({
    id: r.id,
    title: r.title,
    context: r.context ?? null,
    url: r.url,
    score: Number(r.score),
    similarity: r.similarity !== null && r.similarity !== undefined ? Number(r.similarity) : null,
    has_accepted_answer: r.has_accepted_answer,
    replies_count: Number(r.replies_count),
  }));
}

async function runCommunitySemanticOnly(
  pool: Pool,
  qvec: number[],
  limit: number,
  distThreshold: number | null,
): Promise<CommunityHit[]> {
  const distFilter =
    distThreshold !== null
      ? `AND (p.embedding <=> $1::halfvec) <= ${distThreshold}`
      : '';

  // R1+R8: stable tiebreak with answeredness soft-boost.
  // R3: similarity = 1 - distance (same as score in semantic-only mode).
  const sql = `
    SELECT p.id, p.title,
           (SELECT s.name FROM community_spaces s WHERE s.id = p.space_id) AS context,
           p.url,
           1.0 - (p.embedding <=> $1::halfvec) AS score,
           1.0 - (p.embedding <=> $1::halfvec) AS similarity,
           p.has_accepted_answer,
           p.replies_count
    FROM community_posts p
    WHERE p.embedding IS NOT NULL
      AND p.status = 'PUBLISHED'
      ${distFilter}
    ORDER BY p.embedding <=> $1::halfvec, p.has_accepted_answer DESC, p.replies_count DESC, p.id
    LIMIT $2::int;
  `;
  const result = await pool.query<{
    id: string;
    title: string;
    context: string | null;
    url: string;
    score: string | number;
    similarity: string | number | null;
    has_accepted_answer: boolean;
    replies_count: number | string;
  }>(sql, [pgvector.toSql(qvec), limit]);

  return result.rows.map((r) => ({
    id: r.id,
    title: r.title,
    context: r.context ?? null,
    url: r.url,
    score: Number(r.score),
    similarity: r.similarity !== null && r.similarity !== undefined ? Number(r.similarity) : null,
    has_accepted_answer: r.has_accepted_answer,
    replies_count: Number(r.replies_count),
  }));
}

async function runCommunityKeywordOnly(
  pool: Pool,
  query: string,
  limit: number,
): Promise<CommunityHit[]> {
  // R1+R8: stable tiebreak with answeredness soft-boost.
  // R3: similarity is null in keyword-only mode (no vector available).
  const sql = `
    SELECT p.id, p.title,
           (SELECT s.name FROM community_spaces s WHERE s.id = p.space_id) AS context,
           p.url,
           ts_rank_cd(p.tsv, plainto_tsquery('portuguese_unaccent', $1)) AS score,
           p.has_accepted_answer,
           p.replies_count
    FROM community_posts p
    WHERE p.tsv @@ plainto_tsquery('portuguese_unaccent', $1)
      AND p.status = 'PUBLISHED'
    ORDER BY score DESC, p.has_accepted_answer DESC, p.replies_count DESC, p.id
    LIMIT $2::int;
  `;
  const result = await pool.query<{
    id: string;
    title: string;
    context: string | null;
    url: string;
    score: string | number;
    has_accepted_answer: boolean;
    replies_count: number | string;
  }>(sql, [query, limit]);

  return result.rows.map((r) => ({
    id: r.id,
    title: r.title,
    context: r.context ?? null,
    url: r.url,
    score: Number(r.score),
    similarity: null,
    has_accepted_answer: r.has_accepted_answer,
    replies_count: Number(r.replies_count),
  }));
}

// ─── decodeBodyText (R7) ──────────────────────────────────────────────────────

/**
 * Decode literal JSON escape sequences stored in body_text by the ETL.
 *
 * The ETL composes replies without decoding JSON escapes, leaving literal
 * backslash sequences in the DB (e.g. literal `é` instead of `é`,
 * literal `\n` as two characters instead of a real newline).
 *
 * This read-only render fix decodes those escapes before truncation and
 * display. The ETL and DB schema are NOT changed (RNF01).
 *
 * Two transformations applied in order:
 *   1. Literal `\uXXXX` hex escape sequences → correct Unicode characters.
 *   2. Literal `\n` (backslash + n) → real newline character.
 *
 * @MX:NOTE: [AUTO] Read-only presentation fix — does not touch ETL or DB.
 * @MX:SPEC: SPEC-SANKHYA-COMMUNITY-001 R7
 */
export function decodeBodyText(raw: string): string {
  // Step 1: decode literal \uXXXX escape sequences.
  // Regex matches backslash + u + exactly four hex digits.
  const withUnicode = raw.replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
  // Step 2: decode literal \n (two characters: backslash + n) into real newline.
  return withUnicode.replace(/\\n/g, '\n');
}

// ─── getCommunityPost ─────────────────────────────────────────────────────────

/**
 * Fetch a single community post with its full body_text (truncated to maxBodyChars)
 * and the owning space name. Returns null when the post does not exist.
 *
 * Truncation mirrors getArticleFull exactly: slice(0, maxBodyChars) + flags.
 */
export async function getCommunityPost(
  pool: Pool,
  postId: string,
  maxBodyChars: number,
): Promise<CommunityPostFull | null> {
  const sql = `
    SELECT p.id, p.title, p.url, p.body_text, p.post_type, p.tags,
           p.has_accepted_answer, p.reactions_count, p.author_name,
           p.created_at, p.updated_at,
           s.name AS space_name
    FROM community_posts p
    JOIN community_spaces s ON s.id = p.space_id
    WHERE p.id = $1
    LIMIT 1;
  `;
  const result = await pool.query<{
    id: string;
    title: string;
    url: string;
    body_text: string;
    post_type: string | null;
    tags: string[];
    has_accepted_answer: boolean;
    reactions_count: number | string;
    author_name: string | null;
    created_at: Date | null;
    updated_at: Date | null;
    space_name: string;
  }>(sql, [postId]);

  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  if (!row) return null;

  // R7: decode literal \uXXXX and \n escape sequences before truncation.
  const decodedBody = decodeBodyText(row.body_text);
  const fullChars = decodedBody.length;
  const truncated = fullChars > maxBodyChars;
  const body = truncated ? decodedBody.slice(0, maxBodyChars) : decodedBody;

  return {
    id: row.id,
    space_name: row.space_name,
    title: row.title,
    url: row.url,
    body_text: body,
    body_text_truncated: truncated,
    body_text_full_chars: fullChars,
    post_type: row.post_type ?? null,
    tags: Array.isArray(row.tags) ? row.tags : [],
    has_accepted_answer: row.has_accepted_answer,
    reactions_count: Number(row.reactions_count),
    author_name: row.author_name ?? null,
    created_at: row.created_at ? row.created_at.toISOString() : null,
    updated_at: row.updated_at ? row.updated_at.toISOString() : null,
  };
}

// ─── listCommunitySpaces ──────────────────────────────────────────────────────

/**
 * List all public community spaces ordered by post count descending.
 * Only rows with private = false are returned (private spaces excluded by ETL
 * but guarded here for defence-in-depth).
 */
export async function listCommunitySpaces(pool: Pool): Promise<CommunitySpaceRow[]> {
  const sql = `
    SELECT id, name, slug, url, posts_count, members_count
    FROM community_spaces
    WHERE private = false
    ORDER BY posts_count DESC;
  `;
  const result = await pool.query<{
    id: string;
    name: string;
    slug: string;
    url: string;
    posts_count: number | string;
    members_count: number | string;
  }>(sql);

  return result.rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    url: r.url,
    posts_count: Number(r.posts_count),
    members_count: Number(r.members_count),
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
