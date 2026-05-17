# Schema Reference

Referência completa do schema `sankhya_ajuda` em PostgreSQL. Fonte de verdade: `sql/schema.sql`.

Convenções:
- Sufixo `_zendesk` distingue timestamps vindos da API daqueles internos (`synced_at`, `indexed_at`).
- Todas as `BIGINT` PK refletem o ID original do Zendesk (nunca renumeramos).
- `halfvec` = vetor de float16, suportado pelo pgvector ≥ 0.7.

---

## Extensões necessárias

| Extension | Versão alvo | Para quê |
|---|---|---|
| `vector` | ≥ 0.8 | tipos `halfvec`, `vector` + operadores cosine/L2/IP + HNSW |
| `unaccent` | 1.1+ | remoção de acentos para FTS PT-BR |
| `pg_trgm` | 1.6+ | trigram fallback (reservado para Fase 2) |

Provisionadas pelo `scripts/setup_db.sh` (precisa ser superuser).

---

## Text search configuration

`portuguese_unaccent` é uma cópia da configuração `portuguese` nativa, com o filtro `unaccent` aplicado antes do stemmer português. Garante que `relatorio` e `relatório` casam.

```sql
CREATE TEXT SEARCH CONFIGURATION portuguese_unaccent (COPY = portuguese);
ALTER TEXT SEARCH CONFIGURATION portuguese_unaccent
    ALTER MAPPING FOR hword, hword_part, word
    WITH unaccent, portuguese_stem;
```

---

## Tabela `categories`

Top-level do Help Center (14 linhas atualmente).

| Coluna | Tipo | NOT NULL | Default | Origem Zendesk | Notas |
|---|---|---|---|---|---|
| `id` | BIGINT PK | ✓ | — | `categories[].id` | nunca renumera |
| `name` | TEXT | ✓ | — | `name` | ex: "Pessoas+", "Solução de Problemas" |
| `description` | TEXT | ✓ | `''` | `description` | normalmente vazio |
| `html_url` | TEXT | ✓ | — | `html_url` | URL pública |
| `position` | INT | ✓ | 0 | `position` | ordering no portal |
| `locale` | TEXT | ✓ | `'pt-br'` | `locale` | |
| `created_at_zendesk` | TIMESTAMPTZ | | NULL | `created_at` | |
| `updated_at_zendesk` | TIMESTAMPTZ | | NULL | `updated_at` | |
| `synced_at` | TIMESTAMPTZ | ✓ | `now()` | (interno) | refrescado em cada sync |

Sem índices secundários — 14 linhas, scan sequencial é trivial.

---

## Tabela `sections`

Subdivisões dentro de uma categoria. Podem aninhar (`parent_section_id`). 230 linhas, 26% aninhadas.

| Coluna | Tipo | NOT NULL | Default | Origem Zendesk | Notas |
|---|---|---|---|---|---|
| `id` | BIGINT PK | ✓ | — | `sections[].id` | |
| `category_id` | BIGINT FK | ✓ | — | `category_id` | → `categories(id)` ON DELETE CASCADE |
| `parent_section_id` | BIGINT FK | | NULL | `parent_section_id` | → `sections(id)` ON DELETE SET NULL, **DEFERRABLE** |
| `name` | TEXT | ✓ | — | `name` | |
| `description` | TEXT | ✓ | `''` | `description` | |
| `html_url` | TEXT | ✓ | — | `html_url` | |
| `position` | INT | ✓ | 0 | `position` | |
| `locale` | TEXT | ✓ | `'pt-br'` | `locale` | |
| `created_at_zendesk` | TIMESTAMPTZ | | NULL | `created_at` | |
| `updated_at_zendesk` | TIMESTAMPTZ | | NULL | `updated_at` | |
| `synced_at` | TIMESTAMPTZ | ✓ | `now()` | (interno) | |

Índices:
- `idx_sections_category_id` (btree)
- `idx_sections_parent_id` (btree)

A FK `parent_section_id` é **DEFERRABLE INITIALLY DEFERRED** para permitir que o sync grave todas as seções primeiro (`parent_section_id = NULL`) e faça o link em segundo passe — necessário porque o Zendesk retorna seções em ordem arbitrária.

---

## Tabela `articles`

Conteúdo principal: 6.123 linhas atualmente.

| Coluna | Tipo | NOT NULL | Default | Origem Zendesk | Notas |
|---|---|---|---|---|---|
| `id` | BIGINT PK | ✓ | — | `articles[].id` | |
| `section_id` | BIGINT FK | ✓ | — | `section_id` | → `sections(id)` ON DELETE CASCADE |
| `title` | TEXT | ✓ | — | `title` | |
| `html_url` | TEXT | ✓ | — | `html_url` | |
| `body_html` | TEXT | ✓ | `''` | `body` | HTML cru — preservado para auditoria |
| `body_text` | TEXT | ✓ | `''` | derivado | `clean_html(body)` + título prepended |
| `body_hash` | CHAR(64) | ✓ | `''` | derivado | SHA256(body_text) — gating de re-embedding |
| `embedding` | HALFVEC(2560) | | NULL | derivado | Qwen3-embedding-4b (vLLM) |
| `embedding_model` | TEXT | | NULL | (interno) | string do modelo no momento do embedding |
| `label_names` | TEXT[] | ✓ | `[]` | `label_names` | tags texto livre, geralmente PT |
| `content_tag_ids` | TEXT[] | ✓ | `[]` | `content_tag_ids` | tags estruturadas (UUIDs Zendesk) |
| `outdated` | BOOLEAN | ✓ | false | `outdated` | flag manual no painel Zendesk |
| `author_id` | BIGINT | | NULL | `author_id` | requer `/api/v2/users/{id}` para resolver nome |
| `locale` | TEXT | ✓ | `'pt-br'` | `locale` | |
| `draft` | BOOLEAN | ✓ | false | `draft` | |
| `promoted` | BOOLEAN | ✓ | false | `promoted` | |
| `vote_sum` | INT | ✓ | 0 | `vote_sum` | upvotes − downvotes |
| `vote_count` | INT | ✓ | 0 | `vote_count` | total de votos |
| `created_at_zendesk` | TIMESTAMPTZ | | NULL | `created_at` | criação no Zendesk |
| `updated_at_zendesk` | TIMESTAMPTZ | | NULL | `updated_at` | última edição (incluindo metadata) |
| `edited_at_zendesk` | TIMESTAMPTZ | | NULL | `edited_at` | última edição do corpo |
| `synced_at` | TIMESTAMPTZ | ✓ | `now()` | (interno) | última passagem do sync |
| `indexed_at` | TIMESTAMPTZ | | NULL | (interno) | quando o vetor foi gerado |
| `breadcrumb` | TEXT | | NULL | derivado | `categoria > section > [parent...] > section > title`, refrescado ao fim de cada sync |
| `tsv` | TSVECTOR GENERATED | | (sempre presente) | derivado | `setweight(title, 'A') ‖ setweight(body_text, 'B')` com config `portuguese_unaccent` |

Índices:

| Índice | Tipo | Uso |
|---|---|---|
| `articles_pkey` | btree | PK |
| `idx_articles_section_id` | btree | filtro por seção |
| `idx_articles_body_hash` | btree | sync (check rápido se artigo mudou) |
| `idx_articles_updated_at` | btree DESC | listagens "mais recentes" |
| `idx_articles_tsv` | GIN | busca FTS |
| `idx_articles_embedding_hnsw` | HNSW (halfvec_cosine_ops, m=16, ef_construction=64) | busca semântica |
| `idx_articles_outdated` | btree partial (WHERE NOT outdated) | filtro rápido para "só atuais" |

### Por que `halfvec(2560)` em vez de `vector(2560)`?

O `vector` do pgvector limita índices HNSW a 2.000 dimensões. O `halfvec` usa float16 e suporta até 4.000 dimensões em HNSW. O Qwen3-embedding-4b retorna 2.560 dims, então precisamos de `halfvec`. Trade-off: meia-precisão em vez de full float — recall degrada <1% em benchmarks típicos de busca por similaridade, e ganhamos 50% menos storage.

---

## Tabela `sync_state`

Linha única (`id = 1` com CHECK), refletindo o estado do último sync.

| Coluna | Tipo | NOT NULL | Default | Notas |
|---|---|---|---|---|
| `id` | INT PK | ✓ | 1 | CHECK (id = 1) |
| `last_full_sync_at` | TIMESTAMPTZ | | NULL | `now()` ao terminar (qualquer status) |
| `last_status` | TEXT | ✓ | `'never'` | `never`, `running`, `ok`, `error`, `interrupted` |
| `last_article_count` | INT | ✓ | 0 | processados (incluindo unchanged) |
| `last_changed_count` | INT | ✓ | 0 | re-embedded ou novos |
| `last_duration_sec` | INT | ✓ | 0 | duração em segundos |
| `last_error` | TEXT | | NULL | `repr(exc)` ou NULL em `ok` |
| `error_count` | INT | ✓ | 0 | contador consecutivo; zera em cada `ok` |

---

## Tabela `skipped_articles`

Auditoria de artigos que ficaram sem embedding (mas continuam em `articles` com body_text completo, então a busca FTS ainda os encontra).

| Coluna | Tipo | NOT NULL | Default | Notas |
|---|---|---|---|---|
| `article_id` | BIGINT PK | ✓ | — | mesmo ID do Zendesk |
| `title` | TEXT | ✓ | — | truncado em 500 chars no insert |
| `reason` | TEXT | ✓ | — | hoje só `context_length_exceeded` |
| `body_len` | INT | ✓ | — | len(body_text) no momento do skip |
| `skipped_at` | TIMESTAMPTZ | ✓ | `now()` | última vez que o skip foi registrado |

ON CONFLICT atualiza linha (não duplica) — útil para re-runs.

---

## VIEW `article_breadcrumb`

Recursiva. Resolve o caminho completo `categoria > section1 > [section2...] > article_title` para qualquer artigo. Mais barata de usar via `articles.breadcrumb` (coluna materializada), mas a view continua disponível para queries ad-hoc.

```sql
SELECT path FROM article_breadcrumb WHERE article_id = 12345;
-- "Solução de Problemas > Vendas > Não existem serviços na nota..."
```

Implementação: CTE recursiva sobre `sections` somando o nome de cada parent até alcançar `parent_section_id IS NULL`, depois concatena `category.name` + a chain + `article.title`.

---

## Foreign keys e cascata

| FK | Origem | Destino | ON DELETE |
|---|---|---|---|
| sections.category_id | sections | categories | CASCADE |
| sections.parent_section_id | sections | sections | SET NULL (deferrable) |
| articles.section_id | articles | sections | CASCADE |

Removendo uma categoria, todas as seções e seus artigos são apagados em cascata. Removendo uma seção que tem subseções, as subseções ficam órfãs (`parent_section_id` vira NULL) em vez de cascatear — preserva conteúdo se o Sankhya reorganizar a árvore.

---

## Mapeamento Zendesk ↔ DB (resumo)

| Endpoint Zendesk | Tabela alvo |
|---|---|
| `/api/v2/help_center/pt-br/categories.json` | `categories` |
| `/api/v2/help_center/pt-br/sections.json` | `sections` (com `parent_section_id`) |
| `/api/v2/help_center/pt-br/articles.json` | `articles` |
| `/api/v2/help_center/pt-br/categories/{id}/articles.json` | `articles` (filtrado) |

Campos do Zendesk **não mapeados** (decisão consciente):
- `url` (URL da API, redundante)
- `name` em articles (idêntico a `title`)
- `source_locale` (sempre igual a `locale` neste tenant)
- `permission_group_id`, `user_segment_id` (sempre os mesmos no portal público)
- `outdated_locales` (sempre array vazio)
- `comments_disabled` (sempre false)
- `theme_template` em sections, `sorting` em sections (cosmético)


---

<div align="center">

🌐 [www.skillsit.com.br](https://www.skillsit.com.br) · 📱 (63) 3224-4925 · 📍 Palmas — TO — Brasil

</div>
