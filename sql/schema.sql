-- =====================================================================
-- sankhya_ajuda schema
--
-- Run as the owner role (sankhya_ajuda) inside database sankhya_ajuda.
-- Required extensions (vector, unaccent, pg_trgm) are installed by
-- scripts/setup_db.sh as superuser before this script runs.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Portuguese text search configuration with unaccent
-- "relatório" and "relatorio" hit the same documents
-- ---------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_ts_config
        WHERE cfgname = 'portuguese_unaccent'
    ) THEN
        CREATE TEXT SEARCH CONFIGURATION portuguese_unaccent (COPY = portuguese);
        ALTER TEXT SEARCH CONFIGURATION portuguese_unaccent
            ALTER MAPPING FOR hword, hword_part, word
            WITH unaccent, portuguese_stem;
    END IF;
END
$$;

-- ---------------------------------------------------------------------
-- categories
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
    id                  BIGINT PRIMARY KEY,
    name                TEXT        NOT NULL,
    description         TEXT        NOT NULL DEFAULT '',
    html_url            TEXT        NOT NULL,
    position            INTEGER     NOT NULL DEFAULT 0,
    locale              TEXT        NOT NULL DEFAULT 'pt-br',
    created_at_zendesk  TIMESTAMPTZ,
    updated_at_zendesk  TIMESTAMPTZ,
    synced_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- sections (belong to a category)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sections (
    id                  BIGINT PRIMARY KEY,
    category_id         BIGINT      NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    -- Sub-section hierarchy (~45% of sections nest under another section).
    -- DEFERRABLE so a sync transaction can insert children before parents.
    parent_section_id   BIGINT REFERENCES sections(id) ON DELETE SET NULL
                        DEFERRABLE INITIALLY DEFERRED,
    name                TEXT        NOT NULL,
    description         TEXT        NOT NULL DEFAULT '',
    html_url            TEXT        NOT NULL,
    position            INTEGER     NOT NULL DEFAULT 0,
    locale              TEXT        NOT NULL DEFAULT 'pt-br',
    created_at_zendesk  TIMESTAMPTZ,
    updated_at_zendesk  TIMESTAMPTZ,
    synced_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sections_category_id ON sections (category_id);

-- Idempotent migration: existing deployments (created before this column) get
-- the column added; new deployments find the column already in the CREATE TABLE.
ALTER TABLE sections ADD COLUMN IF NOT EXISTS parent_section_id BIGINT
    REFERENCES sections(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX IF NOT EXISTS idx_sections_parent_id ON sections (parent_section_id);

-- ---------------------------------------------------------------------
-- articles
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS articles (
    id                  BIGINT PRIMARY KEY,
    section_id          BIGINT      NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
    title               TEXT        NOT NULL,
    html_url            TEXT        NOT NULL,
    body_html           TEXT        NOT NULL DEFAULT '',
    body_text           TEXT        NOT NULL DEFAULT '',
    body_hash           CHAR(64)    NOT NULL DEFAULT '',
    -- halfvec (float16) supports HNSW up to 4000 dims; vector caps at 2000
    embedding           HALFVEC(2560),
    embedding_model     TEXT,
    label_names         TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
    content_tag_ids     TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
    locale              TEXT        NOT NULL DEFAULT 'pt-br',
    -- Sankhya editors mark stale content via this flag. Search should
    -- de-prioritize or filter outdated=true entries.
    outdated            BOOLEAN     NOT NULL DEFAULT false,
    author_id           BIGINT,
    draft               BOOLEAN     NOT NULL DEFAULT false,
    promoted            BOOLEAN     NOT NULL DEFAULT false,
    vote_sum            INTEGER     NOT NULL DEFAULT 0,
    vote_count          INTEGER     NOT NULL DEFAULT 0,
    created_at_zendesk  TIMESTAMPTZ,
    updated_at_zendesk  TIMESTAMPTZ,
    edited_at_zendesk   TIMESTAMPTZ,
    synced_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    indexed_at          TIMESTAMPTZ,
    tsv                 TSVECTOR GENERATED ALWAYS AS (
        setweight(to_tsvector('portuguese_unaccent', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('portuguese_unaccent', coalesce(body_text, '')), 'B')
    ) STORED
);

CREATE INDEX IF NOT EXISTS idx_articles_section_id ON articles (section_id);
CREATE INDEX IF NOT EXISTS idx_articles_body_hash ON articles (body_hash);
CREATE INDEX IF NOT EXISTS idx_articles_updated_at ON articles (updated_at_zendesk DESC);
CREATE INDEX IF NOT EXISTS idx_articles_tsv ON articles USING GIN (tsv);

-- HNSW vector index (cosine distance, good recall for 6k vectors)
-- halfvec_cosine_ops is the half-precision cosine operator class
CREATE INDEX IF NOT EXISTS idx_articles_embedding_hnsw
    ON articles USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- ---------------------------------------------------------------------
-- sync_state (singleton row id = 1)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_state (
    id                   INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    last_full_sync_at    TIMESTAMPTZ,
    last_status          TEXT NOT NULL DEFAULT 'never',
    last_article_count   INTEGER NOT NULL DEFAULT 0,
    last_changed_count   INTEGER NOT NULL DEFAULT 0,
    last_duration_sec    INTEGER NOT NULL DEFAULT 0,
    last_error           TEXT,
    -- Consecutive failure counter; resets to 0 on a successful sync.
    -- Useful for alerting: error_count > N means N consecutive cron runs failed.
    error_count          INTEGER NOT NULL DEFAULT 0
);

INSERT INTO sync_state (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- Idempotent migration for existing deployments where the column may be absent.
ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS error_count INTEGER NOT NULL DEFAULT 0;

-- Idempotent migrations for the 4 new article columns.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS content_tag_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE articles ADD COLUMN IF NOT EXISTS outdated BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS author_id BIGINT;
-- Materialized breadcrumb path (cat > section > [parent...] > section > title).
-- Refreshed at the tail of each sync; cheap for ~6k rows.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS breadcrumb TEXT;

CREATE INDEX IF NOT EXISTS idx_articles_outdated ON articles (outdated) WHERE NOT outdated;

-- ---------------------------------------------------------------------
-- skipped_articles: audit trail of articles that bypassed embedding
-- (context-length exceeded after truncation, etc).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS skipped_articles (
    article_id    BIGINT PRIMARY KEY,
    title         TEXT        NOT NULL,
    reason        TEXT        NOT NULL,
    body_len      INTEGER     NOT NULL,
    skipped_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- article_breadcrumb: recursive path
-- category > section > [parent_section]* > section > article_title
-- Use:
--   SELECT path FROM article_breadcrumb WHERE article_id = 12345;
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW article_breadcrumb AS
WITH RECURSIVE section_path AS (
    -- Anchor: each section starts with just its own name
    SELECT
        s.id              AS section_id,
        s.category_id,
        s.parent_section_id,
        ARRAY[s.name]     AS names
    FROM sections s
    UNION ALL
    -- Recursive step: prepend the parent's name to the chain
    SELECT
        sp.section_id,
        p.category_id,
        p.parent_section_id,
        p.name || sp.names
    FROM section_path sp
    JOIN sections p ON p.id = sp.parent_section_id
)
SELECT
    a.id                                                    AS article_id,
    a.title,
    c.name                                                  AS category_name,
    full_path.names                                         AS section_chain,
    array_to_string(c.name || full_path.names || a.title, ' > ') AS path
FROM articles a
JOIN sections s ON s.id = a.section_id
JOIN LATERAL (
    SELECT names
    FROM section_path sp
    WHERE sp.section_id = s.id AND sp.parent_section_id IS NULL
    LIMIT 1
) full_path ON true
JOIN categories c ON c.id = s.category_id;
