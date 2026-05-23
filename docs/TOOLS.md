<!--
  Sankhya Ajuda MCP - Referência Canônica de Tools
  Skills IT - Soluções em Tecnologia
  https://www.skillsit.com.br  |  (63) 3224-4925  |  Palmas-TO-Brasil
-->

# Referência de Tools, Resources e Prompts (v1.2.0)

> ⚠️ **Consolidação para Single Source of Truth**
> 
> A partir de v1.2.0, a documentação completa de todas as **10 tools**, **6 resources** e **4 prompts** está centralizada em:
>
> ## 📖 [→ mcp-server/docs/TOOLS.md](../mcp-server/docs/TOOLS.md) ← Leia isto
>
> Este arquivo é mantido aqui apenas como referência e navegação. O único source of truth é o arquivo canônico no diretório `mcp-server`.

---

## Resumo Executivo (v1.2.0)

| Aspecto | Detalhes |
|--------|----------|
| **10 Tools** | 3 help center (artigo/categorias/seções) + 3 comunidade (busca unificada/post/spaces) + 4 bridge |
| **Busca Unificada** | Única tool de busca (`search_knowledge_unified`). RRF cross-source (k=60), dedup por título, label de origem oficial (evita burying), coluna `#` de rank autoritativo |
| **6 Resources** | 3 estáticos (categorias/seções/sync_state) + 3 templates RFC 6570 (GET com {id}) |
| **4 Prompts** | troubleshoot, quick_lookup, explain_module, compare_articles (todos drivers do `unified`) |
| **Base Indexada** | mais de 6.000 artigos (help) + posts da comunidade + 33 spaces públicos |
| **Coluna Similaridade** | Cosine 0–1 (3 casas); coluna `#` adicionada em v1.2.0 (R11) como rank autoritativo (cosseno é não-monotônico) |
| **Transport** | Streamable HTTP `:3105/mcp` + Bearer `MCP_AUTH_TOKEN` |

---

## Links Rápidos (Tools v1.2.0)

**Help Center (3 tools — busca consolidada no `unified`):**
- `sankhya_ajuda_get_article_details` — Artigo completo + breadcrumb + metadados
- `sankhya_ajuda_list_categories` — 14 categorias top-level
- `sankhya_ajuda_list_sections` — 230 seções + 59 subseções com hierarquia

**Comunidade + Busca Unificada (3 tools):**
- `sankhya_ajuda_search_knowledge_unified` — **Tool padrão** para qualquer dúvida; busca help + comunidade com RRF cross-source. Aceita `source=help|community|all` (default `all`). Substitui `search_articles` desde v1.2.0.
- `sankhya_ajuda_get_community_post` — Post + thread completo (pergunta + replies aninhadas)
- `sankhya_ajuda_list_community_spaces` — 33 espaços públicos Bettermode

**Bridge Tools (4 tools):**
- `sankhya_ajuda_list_mcp_resources` — Descobre 6 URIs `sankhya-ajuda://`
- `sankhya_ajuda_read_resource_by_uri` — Lê URI concreta ou template RFC 6570
- `sankhya_ajuda_list_prompt_catalog` — Descobre 4 prompts disponíveis
- `sankhya_ajuda_get_prompt_by_name` — Executa prompt parametrizado

---

## O que Mudou em v1.2.0

### Removed (BREAKING — consumer-side)

- **`sankhya_ajuda_search_articles` foi desabilitada como tool MCP** (redundante com `search_knowledge_unified`). Fonte preservada em `src/tools/search.ts`; reativação é descomentar 2 linhas em `working-index.ts`.
- **Filtros `category_id` e `mode` deliberadamente NÃO portados** para o `unified` — decisão intencional. RRF híbrido + ranking cross-source supera o filtro manual em 90%+ das queries reais, e o `mode` é decisão de runtime do backend, não do consumidor. Para filtro por categoria, ainda há `list_categories` + `list_sections`. Detalhes em [`CHANGELOG`](../CHANGELOG.md#120--2026-05-23--unified-only-search).

### Changed

- **`unified.description` reescrita** — removida cross-ref morta para `search_articles`; lead com "Tool padrão para qualquer dúvida sobre o Sankhya".
- **Prompts migrados** — `sankhya_troubleshoot`, `sankhya_quick_lookup` e `sankhya_explain_module` agora chamam `search_knowledge_unified({source: 'all'})`.
- **Tabela do `unified` ganha coluna `#`** (rank autoritativo monotônico) — resolve o caso em que `Similaridade` (cosseno cru) tem valor maior em linhas inferiores.

### Não Mudou
- Tool `get_article_details`, `list_categories`, `list_sections`, `get_community_post`, `list_community_spaces` e as 4 bridge tools permanecem inalteradas.

---

## O que Mudou em v1.1.0

### Renames (R10)
- **Coluna `Score` → `Similaridade`** em tabelas Markdown
  - Antes: `Score` (confundia com rank/percentual)
  - Agora: `Similaridade` (explicita que é cosine 0–1)
  - Código: Sem alteração em `similarity.toFixed(3)` ou `—` (keyword mode)

### Novo em v1.1.0
- **`sankhya_ajuda_search_knowledge_unified`** (R1) com:
  - RRF cross-source k=60 balanceado por posição (não por score)
  - Dedup de posts por título normalizado (remove ~801 reposts 10,5%)
  - Label de origem: `Fonte` (HELP/COMUNIDADE) + `Oficial` (Sim/Não)
  - Sem parâmetro `mode` (RFC04 — sempre híbrido intra-fonte)
  - Colunas: `# | Fonte | Oficial | ID | Título | Contexto | Similaridade | URL` (coluna `#` = rank autoritativo, R11; `Similaridade` é cosseno cru não-monotônico)

- **Recall Scaling** (CHANGE 1)
  - `source=all` agora usa `internalFetchLimit = Math.max(20, limit)` por fonte
  - Antes: ~40 resultados com `limit=50` (20/fonte insuficiente)
  - Agora: 50 resultados garantidos com `limit=50`

- **AD-C02 Reversal** (CHANGE 2)
  - Desempate cross-source: `rrfScore DESC → similarity DESC → help-first → id ASC`
  - Queries técnicas com comunidade relevante (sim≥0.65) agora trazem community #1
  - Queries com erro oficial mantêm HELP #1 (AC02 preservado)

- **Golden-Eval** (CHANGE 3)
  - Harness `tests/integration/golden-eval.test.ts` valida AC02, AD-C02, recall

---

## Documentação Relacionada

| Arquivo | Escopo |
|---------|--------|
| **[mcp-server/docs/TOOLS.md](../mcp-server/docs/TOOLS.md)** | **← LEIA ISTO:** Documentação completa, canônica, v1.1.0 |
| [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) | Arquitetura técnica (Fase 1 ETL + Fase 2 MCP) |
| [`docs/SCHEMA.md`](./SCHEMA.md) | PostgreSQL + pgvector, tabelas help + comunidade |
| [`docs/EMBEDDINGS-PROVIDER.md`](./EMBEDDINGS-PROVIDER.md) | Como escolher vllm / openai / none |
| [`docs/FALLBACK_STRATEGY.md`](./FALLBACK_STRATEGY.md) | Política de fallback e degradação |
| [`docs/EXAMPLES.md`](./EXAMPLES.md) | Cenários práticos por perfil (suporte/consultor/técnico) |
| [`docs/OPERATIONS.md`](./OPERATIONS.md) | Runbook de operação e monitoramento |
| [`docs/INSTALL.md`](./INSTALL.md) | Instalação (5 paths: Docker, Native, Cloud) |
| [`docs/DEPLOY.md`](./DEPLOY.md) | Deploy e CI/CD |
| [`README.md`](../README.md) | Visão geral do projeto |
| [`CHANGELOG.md`](../CHANGELOG.md) | Histórico de versões |

---

## Error Codes (padrão)

| Código | Significado |
|--------|-------------|
| `NOT_FOUND` | Entidade não existe (artigo/post) |
| `RESPONSE_TOO_LARGE` | Resposta > 400 KB |
| `INTERNAL_ERROR` | Falha inesperada (DB, exceção) |
| `EMBEDDING_UNAVAILABLE` | Embeddings indisponíveis (semântico mode apenas) |
| `INVALID_PROMPT_NAME` | Prompt desconhecido |
| `INVALID_URI` | URI sankhya-ajuda:// inválida |

> **Nota:** `sankhya_ajuda_search_knowledge_unified` **nunca** retorna `EMBEDDING_UNAVAILABLE` — degrada internamente para keyword (RFC03).

---

## Ambiente

| Variável | Default | Efeito |
|----------|---------|--------|
| `EMBEDDING_PROVIDER` | `vllm` | `vllm` / `openai` / `none` (FTS-only) |
| `COMMUNITY_DIST_THRESHOLD` | `0.45` | Corte de distância semântica na comunidade |
| `MCP_AUTH_TOKEN` | (obrigatório) | Bearer para autenticação HTTP |

---

<div align="center">

**Construído por [Skills IT](https://www.skillsit.com.br)**

🌐 [www.skillsit.com.br](https://www.skillsit.com.br) · 📱 (63) 3224-4925 · 📍 Palmas — TO — Brasil

*v1.1.0 — Fase 2 (MCP Server) — 2026-05-22*

</div>
