-- =====================================================================
-- sankhya_ajuda — COMMUNITY schema (source: community.sankhya.com.br)
--
-- Second content source for the same database. The community runs on
-- Bettermode (GraphQL), NOT Zendesk, so its identifiers are alphanumeric
-- TEXT (e.g. "0SZM9HssEOkp") instead of the BIGINT ids used by the help
-- center. These tables live alongside the help tables (categories /
-- sections / articles) and never touch them.
--
-- Idempotent: safe to run repeatedly and after the help schema.sql.
-- Run as the owner role (sankhya_ajuda) inside database sankhya_ajuda.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Portuguese text search configuration with unaccent.
-- Already created by schema.sql; guarded here so this file is standalone.
-- ---------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_ts_config WHERE cfgname = 'portuguese_unaccent'
    ) THEN
        CREATE TEXT SEARCH CONFIGURATION portuguese_unaccent (COPY = portuguese);
        ALTER TEXT SEARCH CONFIGURATION portuguese_unaccent
            ALTER MAPPING FOR hword, hword_part, word
            WITH unaccent, portuguese_stem;
    END IF;
END
$$;

-- ---------------------------------------------------------------------
-- community_spaces (Bettermode "spaces" — the community equivalent of
-- Zendesk categories/sections). Only PUBLIC spaces are ingested; private
-- spaces are filtered out at the ETL layer and never reach this table.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS community_spaces (
    id             TEXT PRIMARY KEY,
    name           TEXT        NOT NULL,
    slug           TEXT        NOT NULL DEFAULT '',
    url            TEXT        NOT NULL DEFAULT '',
    members_count  INTEGER     NOT NULL DEFAULT 0,
    posts_count    INTEGER     NOT NULL DEFAULT 0,
    private        BOOLEAN     NOT NULL DEFAULT false,
    synced_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- community_posts: one row per post. The indexed body_text is the whole
-- Q&A thread (question + replies, accepted answer flagged) so semantic
-- search can surface a post whose solution lives in a reply.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS community_posts (
    id                  TEXT PRIMARY KEY,
    space_id            TEXT        NOT NULL REFERENCES community_spaces(id) ON DELETE CASCADE,
    title               TEXT        NOT NULL DEFAULT '',
    url                 TEXT        NOT NULL DEFAULT '',
    -- Raw thread HTML (question + replies) preserved for audit / re-parse.
    body_html           TEXT        NOT NULL DEFAULT '',
    -- Clean text of the whole thread; what gets embedded and FTS-indexed.
    body_text           TEXT        NOT NULL DEFAULT '',
    body_hash           CHAR(64)    NOT NULL DEFAULT '',
    -- halfvec (float16) supports HNSW up to 4000 dims; vector caps at 2000.
    embedding           HALFVEC(2560),
    embedding_model     TEXT,
    -- Thread metadata (drives ranking / display in Phase 2).
    replies_count       INTEGER     NOT NULL DEFAULT 0,
    reactions_count     INTEGER     NOT NULL DEFAULT 0,
    is_question         BOOLEAN     NOT NULL DEFAULT false,
    has_accepted_answer BOOLEAN     NOT NULL DEFAULT false,
    -- Bettermode post type name (e.g. "Tópico", "Pergunta") + free-form tags.
    post_type           TEXT,
    tags                TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
    tag_ids             TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
    author_name         TEXT,
    status              TEXT        NOT NULL DEFAULT 'PUBLISHED',
    created_at          TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ,
    -- Bumped by new replies; used as a cheap change-detection gate before hashing.
    last_activity_at    TIMESTAMPTZ,
    synced_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    indexed_at          TIMESTAMPTZ,
    tsv                 TSVECTOR GENERATED ALWAYS AS (
        setweight(to_tsvector('portuguese_unaccent', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('portuguese_unaccent', coalesce(body_text, '')), 'B')
    ) STORED
);

CREATE INDEX IF NOT EXISTS idx_community_posts_space_id     ON community_posts (space_id);
CREATE INDEX IF NOT EXISTS idx_community_posts_body_hash    ON community_posts (body_hash);
CREATE INDEX IF NOT EXISTS idx_community_posts_last_activity ON community_posts (last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_community_posts_tsv          ON community_posts USING GIN (tsv);

-- HNSW vector index (cosine), same operator class as the help articles.
CREATE INDEX IF NOT EXISTS idx_community_posts_embedding_hnsw
    ON community_posts USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- Idempotent migrations for deployments created before these columns existed.
ALTER TABLE community_posts ADD COLUMN IF NOT EXISTS post_type TEXT;
ALTER TABLE community_posts ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE community_posts ADD COLUMN IF NOT EXISTS tag_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- GIN index on tags for fast tag filtering.
CREATE INDEX IF NOT EXISTS idx_community_posts_tags ON community_posts USING GIN (tags);

-- ---------------------------------------------------------------------
-- community_sync_state (singleton). Kept SEPARATE from the help
-- sync_state so the two ingestion pipelines have independent metrics,
-- error counters, and alerting.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS community_sync_state (
    id                  INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    last_full_sync_at   TIMESTAMPTZ,
    last_status         TEXT NOT NULL DEFAULT 'never',
    last_post_count     INTEGER NOT NULL DEFAULT 0,
    last_changed_count  INTEGER NOT NULL DEFAULT 0,
    last_duration_sec   INTEGER NOT NULL DEFAULT 0,
    last_error          TEXT,
    error_count         INTEGER NOT NULL DEFAULT 0
);

INSERT INTO community_sync_state (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------
-- community_skipped_posts: audit of posts that bypassed the embedding
-- step (body too long after truncation, etc). The post still lands in
-- community_posts with full body_text, so FTS keeps finding it.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS community_skipped_posts (
    post_id     TEXT PRIMARY KEY,
    title       TEXT        NOT NULL,
    reason      TEXT        NOT NULL,
    body_len    INTEGER     NOT NULL,
    skipped_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
