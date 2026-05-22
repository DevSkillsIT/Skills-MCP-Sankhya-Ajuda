# Sankhya Ajuda MCP — Tool Reference

All 11 tools exposed by the MCP server. Transport: Streamable HTTP on `:3105/mcp`.
Auth: `Authorization: Bearer <MCP_AUTH_TOKEN>`.

---

## Quick Reference Table

| # | Tool | Group | Purpose |
|---|------|-------|---------|
| 1 | `sankhya_ajuda_search_articles` | Help Search | Hybrid search over 6,123 help center articles |
| 2 | `sankhya_ajuda_get_article_details` | Help Search | Full article body by ID |
| 3 | `sankhya_ajuda_list_categories` | Help Navigation | 14 top-level categories |
| 4 | `sankhya_ajuda_list_sections` | Help Navigation | 230 sections with optional filters |
| 5 | `sankhya_ajuda_search_knowledge_unified` | Unified Search | Help + community combined with RRF cross-source |
| 6 | `sankhya_ajuda_get_community_post` | Community | Full thread detail for a community post |
| 7 | `sankhya_ajuda_list_community_spaces` | Community | List 33 public community spaces |
| 8 | `sankhya_ajuda_list_mcp_resources` | Bridge | List 6 MCP resource URIs |
| 9 | `sankhya_ajuda_read_resource_by_uri` | Bridge | Read a `sankhya-ajuda://` URI |
| 10 | `sankhya_ajuda_list_prompt_catalog` | Bridge | List 4 preconfigured prompts |
| 11 | `sankhya_ajuda_get_prompt_by_name` | Bridge | Execute a named prompt |

All tools are **read-only** (`readOnlyHint=true`, `destructiveHint=false`).

---

## Existing Tools (Help Center)

### 1. `sankhya_ajuda_search_articles`

Hybrid search (RRF k=60) combining semantic similarity (pgvector `halfvec 2560d`) and
PT-BR full-text search (`portuguese_unaccent`) over 6,123 official Sankhya help center articles.

**Annotations:** `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=true`

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string (1-500 chars) | Yes | — | Free-text search query |
| `limit` | integer (1-50) | No | 15 | Maximum results |
| `category_id` | integer | No | null | Filter to a specific category |
| `include_outdated` | boolean | No | false | Include articles marked as outdated |
| `mode` | enum: `hybrid`/`semantic`/`keyword` | No | `hybrid` | Search strategy |

**Returns:** Markdown table with columns: `Titulo | Breadcrumb | Similaridade | URL`.

**Degradation:** When `EMBEDDING_PROVIDER=none` or index mismatch detected, `hybrid` and `semantic`
degrade to keyword-only search; `semantic` returns `EMBEDDING_UNAVAILABLE` if embeddings are
unavailable and fallback is not possible.

---

### 2. `sankhya_ajuda_get_article_details`

Retrieves a complete article body (HTML stripped to clean Markdown) by its numeric ID,
plus metadata: breadcrumb hierarchy, author, tags, dates, outdated flag, and canonical URL.

**Annotations:** `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=false`

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `article_id` | integer | Yes | — | Zendesk article BIGINT ID |
| `max_body_chars` | integer (100-40000) | No | 8000 | Character limit for body text |

**Returns:** Markdown detail view with full body and metadata. Truncation notice appended when body exceeds `max_body_chars`.

**Errors:** `NOT_FOUND` when article ID does not exist; `RESPONSE_TOO_LARGE` when body exceeds 400 KB.

---

### 3. `sankhya_ajuda_list_categories`

Lists the 14 top-level categories of the Sankhya help center (e.g., Documentacao de Telas,
Solucao de Problemas, Reforma Tributaria, Universidade Sankhya).

**Annotations:** `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=false`

**Parameters:** None.

**Returns:** Markdown table with columns: `ID | Nome | URL | Artigos`.

---

### 4. `sankhya_ajuda_list_sections`

Lists the 230 sections of the Sankhya help center with optional filtering by category or
parent section. Useful for navigation before a targeted search.

**Annotations:** `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=false`

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `category_id` | integer | No | null | Filter to a specific category |
| `parent_section_id` | integer | No | null | Filter to subsections of a parent |

**Returns:** Markdown table ordered by position with columns: `ID | Nome | Categoria | URL`.

---

## New Tools (Unified Search + Community)

### 5. `sankhya_ajuda_search_knowledge_unified`

Unified search across both the Sankhya help center and the Sankhya community forum in a
single query. Uses RRF cross-source ranking to interleave results from both corpora, labeling
each item with its source (official help vs. community) and an official flag.

This tool solves the "anti-burying" problem: without cross-source RRF, community posts
(7,618 items) can bury official help articles (6,123 items) when their volume is higher.
RRF at k=60 ensures official articles consistently appear in the top results when relevant.

**Annotations:** `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=true`

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string (1-500 chars) | Yes | — | Free-text search query |
| `source` | enum: `help`/`community`/`all` | No | `all` | Source to search: help only, community only, or both |
| `limit` | integer (1-50) | No | 15 | Maximum results returned |
| `include_outdated` | boolean | No | false | Include outdated help articles (ignored for community) |

> **Note:** This tool does NOT accept `mode` or `category_id`. It always uses hybrid search
> (semantic + keyword via RRF) for both sources. It NEVER returns `EMBEDDING_UNAVAILABLE`.

**`source` enum behavior:**

| `source` | DB calls | RRF | Dedup |
|----------|----------|-----|-------|
| `help` | `hybridSearch` only | intra-source (position-based) | none |
| `community` | `hybridSearchCommunity` only | intra-source (position-based) | `dedupCommunityByTitle` |
| `all` | both, `Math.max(20, limit)` each | `crossSourceRRF` then slice to `limit` | `dedupCommunityByTitle` before RRF |

**Returns:** Markdown table with columns (exact order per RF01.8):

```
| Fonte | Oficial | ID | Título | Contexto | Similaridade | URL |
```

- `Fonte`: `HELP` or `COMUNIDADE`
- `Oficial`: `Sim` (help) or `Não` (community)
- `ID`: Article ID (help, BIGINT as string) or post ID (community, alphanumeric string)
- `Titulo`: Article or post title
- `Contexto`: breadcrumb (help) or space name (community); `—` if absent
- `Similaridade`: Cosine similarity 0.000–1.000 (3 decimal places) or `—` in keyword mode

**Degradation:** Same as `search_articles` — when `EMBEDDING_PROVIDER=none` or index mismatch,
both corpora fall back to keyword-only search. `distThreshold` (env `COMMUNITY_DIST_THRESHOLD`,
default 0.45) filters low-relevance community posts in the semantic CTE only.

**Example call:**
```json
{
  "query": "erro ao confirmar nota fiscal",
  "source": "all",
  "limit": 10
}
```

**Example response excerpt:**
```
| Fonte | Oficial | ID | Título | Contexto | Similaridade | URL |
|---|---|---|---|---|---|---|
| HELP | Sim | 12345 | Nota Fiscal não confirmada — causa e solução | NF-e > Emissão | 0.739 | https://ajuda.sankhya.com.br/... |
| COMUNIDADE | Não | ABC123XYZ | Erro ao confirmar NF-e no Sankhya | Fiscal | 0.712 | https://community.sankhya.com.br/... |
```

---

### 6. `sankhya_ajuda_get_community_post`

Retrieves the full thread of a community post, including the original post body plus all
nested replies as composed by the ETL (`"Resposta de ..."` / `"Resposta aninhada de ..."`
prefixes are preserved). Also returns space, tags, post type, accepted answer flag,
reaction count, author, dates, and URL.

Use this as a drill-down after `sankhya_ajuda_search_knowledge_unified` returns a community
result of interest.

**Annotations:** `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=false`

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `post_id` | string (min 1 char) | Yes | — | Alphanumeric community post ID (returned by `sankhya_ajuda_search_knowledge_unified`) |
| `max_body_chars` | integer (100-40000) | No | 8000 | Character limit for the composed post body |

> Post IDs are alphanumeric strings from Bettermode, not BIGINTs like article IDs.

**Returns:** Markdown detail view with:
- **Header block:** ID, space, post type, tags, accepted answer, reactions, author, created/updated dates, URL.
- **Body section:** full composed thread text (question + all replies). Truncation notice appended when `body_text_truncated=true`.

**Errors:**
- `NOT_FOUND` — post ID does not exist in `community_posts`.
- `RESPONSE_TOO_LARGE` — composed body exceeds 400 KB.
- `INTERNAL_ERROR` — unexpected DB error.

**Example call:**
```json
{
  "post_id": "ABC123XYZ",
  "max_body_chars": 8000
}
```

---

### 7. `sankhya_ajuda_list_community_spaces`

Lists all public spaces (topics/groups/channels) of the Sankhya community forum.
Useful for discovering where a user's question fits before filtering a search.
Returns exactly the spaces with `private=false` (expected: 33 public spaces).

**Annotations:** `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=false`

**Parameters:** None.

**Returns:** Markdown table with columns:

```
| ID | Nome | Slug | URL | Posts | Membros |
```

Ordered by `posts_count DESC`. No private spaces are ever returned.

**Example response excerpt:**
```
**33 espacos** publicos da comunidade Sankhya

| ID | Nome | Slug | URL | Posts | Membros |
|---|---|---|---|---|---|
| abc | Fiscal | fiscal | https://community.sankhya.com.br/fiscal | 850 | 1200 |
| ...
```

---

## Bridge Tools

### 8. `sankhya_ajuda_list_mcp_resources`

Lists all 6 MCP resource URIs available under the `sankhya-ajuda://` scheme, with their
MIME type and template indicator. Use for discovery before calling `read_resource_by_uri`.

**Annotations:** `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=false`

**Parameters:** None. **Returns:** Markdown table with URI, MIME type, and template flag.

---

### 9. `sankhya_ajuda_read_resource_by_uri`

Reads data from a specific `sankhya-ajuda://` URI. Supports both concrete URIs
(e.g., `sankhya-ajuda://categories`) and parameterized templates
(e.g., `sankhya-ajuda://articles/{id}`).

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | Yes | Canonical MCP resource URI |

**Returns:** Markdown or JSON depending on the URI (sync_state returns JSON).

---

### 10. `sankhya_ajuda_list_prompt_catalog`

Lists the 4 preconfigured prompt templates with their names, descriptions, and required
arguments. Use before calling `get_prompt_by_name`.

**Parameters:** None. **Returns:** Markdown table listing all available prompts.

**Available prompts:**

| Name | Argument | Purpose |
|------|----------|---------|
| `sankhya_troubleshoot` | `problem` | Structured troubleshooting workflow |
| `sankhya_quick_lookup` | `term` | Quick terminology/feature lookup |
| `sankhya_explain_module` | `module_name` | Detailed module explanation |
| `sankhya_compare_articles` | `article_ids` (CSV of BIGINTs) | Side-by-side comparison |

---

### 11. `sankhya_ajuda_get_prompt_by_name`

Executes a named prompt template with user-provided arguments, returning structured
Markdown messages for guided analysis workflows.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Prompt name (must match one from `list_prompt_catalog`) |
| `arguments` | object | Varies | Prompt-specific arguments |

**Errors:** `INVALID_PROMPT_NAME` when the name does not match any registered prompt.

---

## Error Codes

| Code | Meaning | Tools |
|------|---------|-------|
| `NOT_FOUND` | Entity does not exist | `get_article_details`, `get_community_post` |
| `RESPONSE_TOO_LARGE` | Response exceeds 400 KB | All tools |
| `INTERNAL_ERROR` | Unexpected exception | All tools |
| `EMBEDDING_UNAVAILABLE` | Semantic search unavailable, no fallback | `search_articles` (semantic mode only) |
| `INVALID_PROMPT_NAME` | Unknown prompt name | `get_prompt_by_name` |

> `sankhya_ajuda_search_knowledge_unified` **never** returns `EMBEDDING_UNAVAILABLE` —
> it always falls back to keyword search when embeddings are unavailable.

---

## Environment Variables (Search-Related)

| Variable | Default | Description |
|----------|---------|-------------|
| `EMBEDDING_PROVIDER` | `vllm` | `vllm` / `openai` / `none` |
| `COMMUNITY_DIST_THRESHOLD` | `0.45` | Cosine distance threshold for community semantic CTE (filters noise) |

---

*Generated for SPEC-SANKHYA-COMMUNITY-001 Phase 3. All 11 tools registered in `src/tools/working-index.ts`.*
