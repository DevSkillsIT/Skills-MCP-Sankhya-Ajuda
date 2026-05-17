# Sankhya Ajuda — Fase 1 (ETL + DB) — Relatório de Aceite

**Data**: 2026-05-15
**Escopo**: scraping completo da base pública `ajuda.sankhya.com.br`, população do PostgreSQL + pgvector, scheduler diário, testes.
**Status**: ✅ **APROVADO**

---

## 1. Resultado do sync inicial

| Métrica | Valor |
|---|---|
| `last_status` | `ok` |
| Artigos retornados pela API | 6.124 |
| Artigos gravados no banco | **6.123** (1 descartado por draft/inativo no Zendesk) |
| Artigos com embedding `halfvec(2560)` | **6.123 / 6.123 (100%)** |
| Artigos pulados (skipped_articles) | **0** |
| Categorias | 14 / 14 |
| Seções | 230 / 230 |
| Seções aninhadas (`parent_section_id` ≠ NULL) | 59 (25,7%) |
| Duração do sync inicial | **1.068s ≈ 17min 48s** |
| `error_count` | 0 |

> Esperado (Zendesk reporta 6.124 / observados 6.123): a diferença de 1 artigo é normal — artigos marcados como `draft` na lista paginada mas não retornados nas chamadas individuais. Mantido `delete_orphan_articles` para autoajustar.

---

## 2. Cobertura por categoria

| Categoria | Artigos |
|---|---:|
| Solução de Problemas | 2.640 |
| Documentação de Telas (Manual) | 1.277 |
| Pessoas+ | 770 |
| Dúvidas Frequentes | 630 |
| Universidade Sankhya | 400 |
| Melhores Práticas | 146 |
| Documentação de Jornadas | 59 |
| Sankhya Official Pack - SOP | 57 |
| Assistente de Melhores Práticas | 51 |
| Reforma tributária | 42 |
| Sankhya Fintech | 35 |
| Service Desk \| área do colaborador | 7 |
| Modalidade SaaS | 5 |
| BIA - Business Intelligence Assistant | 4 |
| **Total** | **6.123** |

---

## 3. Distribuição de tamanho do corpo

`length(body_text)` em caracteres:

| Estatística | Caracteres |
|---|---:|
| min | 35 |
| p50 (mediana) | 1.563 |
| média | 3.774 |
| p95 | 12.652 |
| max | 288.953 |

O truncamento no embedding começa em 8.000 chars; artigos acima desse limite têm `body_text` completo no banco para FTS, mas o vetor é gerado sobre o prefixo. Texto completo sempre disponível via `sankhya_get_article` (Fase 2).

---

## 4. Smoke queries — busca semântica (HNSW + halfvec, cosine)

| Query | Top-1 | Distância | Latência |
|---|---|---:|---:|
| `"como emitir nota fiscal eletronica"` | Não existem serviços na nota 'X' corretamente configurados para a emissão | 0,286 | 179 ms |
| `"configurar aliquota de ICMS"` | Não foi possível resolver o filtro para obtenção da alíquota de ICMS | 0,243 | 43 ms |
| `"erro de divergencia no estoque"` | Há divergência entre o estoque e as movimentações do MGE | 0,302 | 44 ms |
| `"reforma tributaria DPS"` | E0004 Rejeição: Conteúdo do identificador informado na DPS difere | 0,396 | 42 ms |

Primeira query inclui custo do embedding (~100 ms via vLLM). Demais são consultas a vetores já indexados.

---

## 5. Smoke queries — FTS (keyword, `portuguese_unaccent`)

| Query | Top-1 | Rank | Latência |
|---|---|---:|---:|
| `"relatorio contabil"` (sem acento) | Gerenciador de Folhas | 0,665 | 12 ms |
| `"nota fiscal cancelada"` | NFe de Serviço — Prefeituras SC | 1,000 | 14 ms |

`relatorio` (sem acento) encontra documentos com `relatório` (com acento) graças ao `unaccent` na text-search configuration.

---

## 6. Campos capturados (resposta direta ao escopo solicitado)

| Pergunta do Adriano | Campo no schema | Origem Zendesk |
|---|---|---|
| Data de criação | `articles.created_at_zendesk` | `created_at` |
| "Atualizado há X meses" | `articles.updated_at_zendesk` + `edited_at_zendesk` | `updated_at`, `edited_at` |
| Hierarquia completa | **`articles.breadcrumb` materializado** | derivado |
| Categorias e subcategorias | `categories` + `sections.parent_section_id` | category, section, parent_section_id |
| Possíveis tags (texto livre) | `articles.label_names TEXT[]` | `label_names` |
| Tags estruturadas | `articles.content_tag_ids TEXT[]` | `content_tag_ids` |
| Artigos relacionados | calculado em runtime via pgvector (Fase 2) | inferido |
| Conteúdo desatualizado | `articles.outdated BOOLEAN` | `outdated` |
| Autor | `articles.author_id BIGINT` | `author_id` |
| Engajamento | `articles.vote_sum`, `vote_count` | já capturados desde o início |

**Breadcrumb em uso real (resultado da query semântica acima):**
```
Solução de Problemas > Rejeições: NF-e / NFS-e / NFC-e - Reforma tributária > E0004 Rejeição: ...
Documentação de Telas (Manual) > Comercial > Alíquotas de ICMS
Dúvidas Frequentes > WMS > Há divergência entre o estoque e as movimentações do MGE
```

---

## 7. Infraestrutura

| Item | Estado |
|---|---|
| PostgreSQL `postgres:5433/sankhya_ajuda` | ✅ healthy |
| Extensões | `vector 0.8.1`, `unaccent 1.1`, `pg_trgm 1.6` |
| Vector index | HNSW (m=16, ef_construction=64) sobre `halfvec_cosine_ops` |
| FTS index | GIN sobre `tsv` com config `portuguese_unaccent` |
| Tamanho da `articles` (linhas + índices) | 155 MB |
| Tamanho total do database | 164 MB |
| Cron diário `/etc/cron.d/sankhya_ajuda_sync` | ✅ instalado (03:00) |
| logrotate `/etc/logrotate.d/sankhya_ajuda_sync` | ✅ instalado (weekly × 4) |
| Log | `/var/log/sankhya_ajuda_sync.log` |

---

## 8. Engenharia

| Item | Resultado |
|---|---|
| Testes (`pytest`) | **32/32 passam** em 0,8 s |
| Lint (`ruff`) | **All checks passed** |
| Type check (`pyright`) | configurado em pyproject |
| Cobertura aproximada | parser 100%, embeddings ~90%, sync ~80% |
| Secrets em config | `SecretStr` (não vazam em logs) |
| Retry vLLM | full-jitter exponential, 3 tentativas |
| Truncamento de embedding | 8.000 chars (margem de segurança × 4096 tokens) |
| Skip resiliente (`EmbeddingTooLongError`) | grava artigo sem vetor + auditoria em `skipped_articles` |
| Idempotência | `setup_db.sh`, `schema.sql`, sync (via `body_hash` SHA256) |

---

## 9. O que está pronto para a Fase 2 (MCP server)

- `src/sankhya_ajuda/db.py` — pool psycopg async, todas as queries necessárias
- `src/sankhya_ajuda/embeddings.py` — cliente vLLM async com fallback hooks
- VIEW `article_breadcrumb` + coluna materializada `articles.breadcrumb`
- 6.123 artigos com `embedding`, `tsv`, metadata completa
- Schema permite as 4 tools planejadas:
  - `sankhya_search` (semantic + FTS + híbrido)
  - `sankhya_get_article` (texto completo + breadcrumb + URL original)
  - `sankhya_list_categories` (com contagem de artigos)
  - `sankhya_list_sections` (com hierarquia e filtro por categoria)
- Documentado em `docs/FALLBACK_STRATEGY.md`

---

## 10. Próximos passos sugeridos

1. **SPEC formal do MCP** (`SPEC-SANKHYA-AJUDA-001`) — descreve as tools, contratos JSON, e behavior de fallback
2. **Implementar `src/sankhya_ajuda/server.py`** com FastMCP
3. **`docker-compose.yml`** isolando o MCP server (acessando `postgres` externo)
4. **Considerar chunking por seção** (Fase 3): para artigos > 8.000 chars, gerar múltiplos vetores e fazer retrieval em nível de chunk em vez de artigo — melhora recall para artigos longos com múltiplos tópicos

---

*Relatório gerado automaticamente após validação do full sync inicial. Para regenerar, rodar smoke queries em `docs/FALLBACK_STRATEGY.md`.*


---

<div align="center">

🌐 [www.skillsit.com.br](https://www.skillsit.com.br) · 📱 (63) 3224-4925 · 📍 Palmas — TO — Brasil

</div>
