-- Compatibility views mapping the Sankhya KB tables to the kb_search contract
-- (see CONTRACT.md). Read-only; do NOT touch the Sankhya ETL or MCP. Apply in
-- the sankhya_ajuda database:
--   psql "<sankhya_ajuda dsn>" -f sankhya_views.sql
-- Re-runnable (CREATE OR REPLACE). If the Sankhya schema changes, re-apply.

-- Help center articles -> contract.
CREATE OR REPLACE VIEW kb_search_help AS
SELECT
    a.id::text                                          AS id,
    a.title                                             AS title,
    a.body_text                                         AS body,
    NULL::text                                          AS solution,
    a.html_url                                          AS url,
    COALESCE(a.breadcrumb, '')                          AS context,
    a.label_names                                       AS tags,
    COALESCE(a.locale, 'pt-BR')                         AS lang,
    NULL::text                                          AS tenant,
    'public'                                            AS visibility,
    NULL::text                                          AS canonical_id,
    a.created_at_zendesk                                AS source_date,
    COALESCE(a.edited_at_zendesk, a.updated_at_zendesk) AS updated_at,
    (NOT a.outdated AND NOT a.draft)                    AS active,
    a.embedding                                         AS embedding,
    a.tsv                                               AS fts,
    a.embedding_model                                   AS embedding_model,
    jsonb_build_object(
        'promoted', a.promoted,
        'vote_sum', a.vote_sum,
        'vote_count', a.vote_count,
        'section_id', a.section_id
    )                                                   AS metadata
FROM articles a;

-- Community posts -> contract.
CREATE OR REPLACE VIEW kb_search_community AS
SELECT
    p.id                                                AS id,
    p.title                                             AS title,
    p.body_text                                         AS body,
    NULL::text                                          AS solution,
    p.url                                               AS url,
    (SELECT s.name FROM community_spaces s WHERE s.id = p.space_id) AS context,
    p.tags                                              AS tags,
    'pt-BR'                                             AS lang,
    NULL::text                                          AS tenant,
    'public'                                            AS visibility,
    NULL::text                                          AS canonical_id,
    p.created_at                                        AS source_date,
    COALESCE(p.last_activity_at, p.updated_at)          AS updated_at,
    (p.status = 'PUBLISHED')                            AS active,
    p.embedding                                         AS embedding,
    p.tsv                                               AS fts,
    p.embedding_model                                   AS embedding_model,
    jsonb_build_object(
        'has_accepted_answer', p.has_accepted_answer,
        'replies_count', p.replies_count,
        'reactions_count', p.reactions_count,
        'is_question', p.is_question,
        'post_type', p.post_type
    )                                                   AS metadata
FROM community_posts p;

GRANT SELECT ON kb_search_help TO sankhya_ajuda;
GRANT SELECT ON kb_search_community TO sankhya_ajuda;
