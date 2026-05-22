# Sankhya Ajuda MCP — Referência de Tools

Todas as 11 tools expostas pelo servidor MCP. Transporte: Streamable HTTP em `:3105/mcp`.
Auth: `Authorization: Bearer <MCP_AUTH_TOKEN>`.

---

## Tabela de Referência Rápida

| # | Tool | Grupo | Função |
|---|------|-------|--------|
| 1 | `sankhya_ajuda_search_articles` | Busca (Help) | Busca híbrida sobre 6.125 artigos do help center |
| 2 | `sankhya_ajuda_get_article_details` | Busca (Help) | Corpo completo do artigo por ID |
| 3 | `sankhya_ajuda_list_categories` | Navegação (Help) | 14 categorias top-level |
| 4 | `sankhya_ajuda_list_sections` | Navegação (Help) | 230 seções com filtros opcionais |
| 5 | `sankhya_ajuda_search_knowledge_unified` | Busca Unificada | Help + comunidade combinados com RRF cross-source |
| 6 | `sankhya_ajuda_get_community_post` | Comunidade | Thread completo de um post da comunidade |
| 7 | `sankhya_ajuda_list_community_spaces` | Comunidade | Lista os 33 espaços públicos da comunidade |
| 8 | `sankhya_ajuda_list_mcp_resources` | Bridge | Lista as 6 URIs de resources MCP |
| 9 | `sankhya_ajuda_read_resource_by_uri` | Bridge | Lê uma URI `sankhya-ajuda://` |
| 10 | `sankhya_ajuda_list_prompt_catalog` | Bridge | Lista os 4 prompts pré-configurados |
| 11 | `sankhya_ajuda_get_prompt_by_name` | Bridge | Executa um prompt nomeado |

Todas as tools são **somente leitura** (`readOnlyHint=true`, `destructiveHint=false`).

---

## Tools do Help Center

### 1. `sankhya_ajuda_search_articles`

Busca híbrida (RRF k=60) combinando similaridade semântica (pgvector `halfvec 2560d`) e
full-text search PT-BR (`portuguese_unaccent`) sobre 6.125 artigos oficiais do help center Sankhya.

**Anotações:** `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=true`

**Parâmetros:**

| Parâmetro | Tipo | Obrigatório | Default | Descrição |
|-----------|------|-------------|---------|-----------|
| `query` | string (1-500 chars) | Sim | — | Consulta em texto livre |
| `limit` | integer (1-50) | Não | 15 | Máximo de resultados |
| `category_id` | integer | Não | null | Filtra por uma categoria específica |
| `include_outdated` | boolean | Não | false | Inclui artigos marcados como obsoletos |
| `mode` | enum: `hybrid`/`semantic`/`keyword` | Não | `hybrid` | Estratégia de busca |

**Retorna:** tabela Markdown com colunas: `Título | Breadcrumb | Similaridade | URL`.

**Degradação:** quando `EMBEDDING_PROVIDER=none` ou há mismatch de índice, `hybrid` e `semantic`
degradam para busca keyword-only; `semantic` retorna `EMBEDDING_UNAVAILABLE` se os embeddings
estiverem indisponíveis e o fallback não for possível.

---

### 2. `sankhya_ajuda_get_article_details`

Recupera o corpo completo de um artigo (HTML limpo para Markdown) pelo seu ID numérico,
mais metadados: hierarquia de breadcrumb, autor, tags, datas, flag de obsolescência e URL canônica.

**Anotações:** `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=false`

**Parâmetros:**

| Parâmetro | Tipo | Obrigatório | Default | Descrição |
|-----------|------|-------------|---------|-----------|
| `article_id` | integer | Sim | — | ID BIGINT do artigo no Zendesk |
| `max_body_chars` | integer (100-40000) | Não | 8000 | Limite de caracteres do corpo |

**Retorna:** visão de detalhe em Markdown com corpo completo e metadados. Aviso de truncamento é anexado quando o corpo excede `max_body_chars`.

**Erros:** `NOT_FOUND` quando o ID do artigo não existe; `RESPONSE_TOO_LARGE` quando o corpo excede 400 KB.

---

### 3. `sankhya_ajuda_list_categories`

Lista as 14 categorias top-level do help center Sankhya (ex.: Documentação de Telas,
Solução de Problemas, Reforma Tributária, Universidade Sankhya).

**Anotações:** `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=false`

**Parâmetros:** nenhum.

**Retorna:** tabela Markdown com colunas: `ID | Nome | URL | Artigos`.

---

### 4. `sankhya_ajuda_list_sections`

Lista as 230 seções do help center Sankhya com filtragem opcional por categoria ou
seção pai. Útil para navegação antes de uma busca dirigida.

**Anotações:** `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=false`

**Parâmetros:**

| Parâmetro | Tipo | Obrigatório | Default | Descrição |
|-----------|------|-------------|---------|-----------|
| `category_id` | integer | Não | null | Filtra por uma categoria específica |
| `parent_section_id` | integer | Não | null | Filtra subseções de um nó pai |

**Retorna:** tabela Markdown ordenada por posição com colunas: `ID | Nome | Categoria | URL`.

---

## Tools Novas (Busca Unificada + Comunidade)

### 5. `sankhya_ajuda_search_knowledge_unified`

Busca unificada sobre o help center e o fórum da comunidade Sankhya em uma única consulta.
Usa ranking RRF cross-source para intercalar resultados dos dois corpora, rotulando cada
item com sua origem (help oficial vs. comunidade) e uma flag de oficialidade.

Esta tool resolve o problema de "anti-burying": sem RRF cross-source, os posts da comunidade
(7.619 itens) podem soterrar os artigos oficiais do help (6.125 itens) quando seu volume é maior.
O RRF com k=60 garante que os artigos oficiais apareçam consistentemente no topo quando relevantes.

**Anotações:** `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=true`

**Parâmetros:**

| Parâmetro | Tipo | Obrigatório | Default | Descrição |
|-----------|------|-------------|---------|-----------|
| `query` | string (1-500 chars) | Sim | — | Consulta em texto livre |
| `source` | enum: `help`/`community`/`all` | Não | `all` | Fonte a buscar: só help, só comunidade, ou ambas |
| `limit` | integer (1-50) | Não | 15 | Máximo de resultados retornados |
| `include_outdated` | boolean | Não | false | Inclui artigos obsoletos do help (ignorado para comunidade) |

> **Nota:** esta tool NÃO aceita `mode` nem `category_id`. Ela sempre usa busca híbrida
> (semântica + keyword via RRF) para as duas fontes. NUNCA retorna `EMBEDDING_UNAVAILABLE`.

**Comportamento do enum `source`:**

| `source` | Chamadas ao banco | RRF | Dedup |
|----------|-------------------|-----|-------|
| `help` | só `hybridSearch` | intra-fonte (por posição) | nenhum |
| `community` | só `hybridSearchCommunity` | intra-fonte (por posição) | `dedupCommunityByTitle` |
| `all` | ambas, `Math.max(20, limit)` cada | `crossSourceRRF` e fatia para `limit` | `dedupCommunityByTitle` antes do RRF |

**Retorna:** tabela Markdown com colunas (ordem exata por RF01.8):

```
| Fonte | Oficial | ID | Título | Contexto | Similaridade | URL |
```

- `Fonte`: `HELP` ou `COMUNIDADE`
- `Oficial`: `Sim` (help) ou `Não` (comunidade)
- `ID`: ID do artigo (help, BIGINT como string) ou ID do post (comunidade, string alfanumérica)
- `Título`: título do artigo ou post
- `Contexto`: breadcrumb (help) ou nome do espaço (comunidade); `—` se ausente
- `Similaridade`: similaridade de cosseno 0.000–1.000 (3 casas decimais) ou `—` em modo keyword

**Degradação:** igual à `sankhya_ajuda_search_articles` — quando `EMBEDDING_PROVIDER=none` ou
há mismatch de índice, os dois corpora caem para busca keyword-only. O `distThreshold`
(env `COMMUNITY_DIST_THRESHOLD`, default 0.45) filtra posts da comunidade com baixa
relevância, apenas no CTE semântico.

**Exemplo de chamada:**
```json
{
  "query": "erro ao confirmar nota fiscal",
  "source": "all",
  "limit": 10
}
```

**Trecho de resposta de exemplo:**
```
| Fonte | Oficial | ID | Título | Contexto | Similaridade | URL |
|---|---|---|---|---|---|---|
| HELP | Sim | 12345 | Nota Fiscal não confirmada — causa e solução | NF-e > Emissão | 0.739 | https://ajuda.sankhya.com.br/... |
| COMUNIDADE | Não | ABC123XYZ | Erro ao confirmar NF-e no Sankhya | Fiscal | 0.712 | https://community.sankhya.com.br/... |
```

---

### 6. `sankhya_ajuda_get_community_post`

Recupera o thread completo de um post da comunidade, incluindo o corpo do post original
mais todas as respostas aninhadas, conforme compostas pelo ETL (os prefixos
`"Resposta de ..."` / `"Resposta aninhada de ..."` são preservados). Também retorna espaço,
tags, tipo do post, flag de resposta aceita, contagem de reações, autor, datas e URL.

Use como drill-down depois que a `sankhya_ajuda_search_knowledge_unified` retornar um
resultado da comunidade de interesse.

**Anotações:** `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=false`

**Parâmetros:**

| Parâmetro | Tipo | Obrigatório | Default | Descrição |
|-----------|------|-------------|---------|-----------|
| `post_id` | string (mín. 1 char) | Sim | — | ID alfanumérico do post da comunidade (retornado por `sankhya_ajuda_search_knowledge_unified`) |
| `max_body_chars` | integer (100-40000) | Não | 8000 | Limite de caracteres do corpo composto do post |

> Os IDs de post são strings alfanuméricas do Bettermode, não BIGINTs como os IDs de artigo.

**Retorna:** visão de detalhe em Markdown com:
- **Bloco de cabeçalho:** ID, espaço, tipo do post, tags, resposta aceita, reações, autor, datas de criação/atualização, URL.
- **Seção de corpo:** texto completo do thread composto (pergunta + todas as respostas). Aviso de truncamento anexado quando `body_text_truncated=true`.

**Erros:**
- `NOT_FOUND` — ID do post não existe em `community_posts`.
- `RESPONSE_TOO_LARGE` — corpo composto excede 400 KB.
- `INTERNAL_ERROR` — erro inesperado no banco.

**Exemplo de chamada:**
```json
{
  "post_id": "ABC123XYZ",
  "max_body_chars": 8000
}
```

---

### 7. `sankhya_ajuda_list_community_spaces`

Lista todos os espaços públicos (tópicos/grupos/canais) do fórum da comunidade Sankhya.
Útil para descobrir onde a dúvida do usuário se encaixa antes de filtrar uma busca.
Retorna exatamente os espaços com `private=false` (esperado: 33 espaços públicos).

**Anotações:** `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=false`

**Parâmetros:** nenhum.

**Retorna:** tabela Markdown com colunas:

```
| ID | Nome | Slug | URL | Posts | Membros |
```

Ordenada por `posts_count DESC`. Nenhum espaço privado é retornado.

**Trecho de resposta de exemplo:**
```
**33 espaços** públicos da comunidade Sankhya

| ID | Nome | Slug | URL | Posts | Membros |
|---|---|---|---|---|---|
| abc | Fiscal | fiscal | https://community.sankhya.com.br/fiscal | 850 | 1200 |
| ...
```

---

## Tools Bridge

### 8. `sankhya_ajuda_list_mcp_resources`

Lista todas as 6 URIs de resources MCP disponíveis no esquema `sankhya-ajuda://`, com seu
MIME type e indicador de template. Use para descoberta antes de chamar `sankhya_ajuda_read_resource_by_uri`.

**Anotações:** `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=false`

**Parâmetros:** nenhum. **Retorna:** tabela Markdown com URI, MIME type e flag de template.

---

### 9. `sankhya_ajuda_read_resource_by_uri`

Lê dados de uma URI `sankhya-ajuda://` específica. Suporta tanto URIs concretas
(ex.: `sankhya-ajuda://categories`) quanto templates parametrizados
(ex.: `sankhya-ajuda://articles/{id}`).

**Parâmetros:**

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `uri` | string | Sim | URI canônica de resource MCP |

**Retorna:** Markdown ou JSON dependendo da URI (sync_state retorna JSON).

---

### 10. `sankhya_ajuda_list_prompt_catalog`

Lista os 4 templates de prompt pré-configurados com seus nomes, descrições e argumentos
obrigatórios. Use antes de chamar `sankhya_ajuda_get_prompt_by_name`.

**Parâmetros:** nenhum. **Retorna:** tabela Markdown listando todos os prompts disponíveis.

**Prompts disponíveis:**

| Nome | Argumento | Função |
|------|-----------|--------|
| `sankhya_troubleshoot` | `problem` | Workflow estruturado de troubleshooting |
| `sankhya_quick_lookup` | `term` | Consulta rápida de termo/funcionalidade |
| `sankhya_explain_module` | `module_name` | Explicação detalhada de módulo |
| `sankhya_compare_articles` | `article_ids` (CSV de BIGINTs) | Comparação lado a lado |

---

### 11. `sankhya_ajuda_get_prompt_by_name`

Executa um template de prompt nomeado com argumentos fornecidos pelo usuário, retornando
mensagens Markdown estruturadas para workflows guiados de análise.

**Parâmetros:**

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `name` | string | Sim | Nome do prompt (deve casar com um de `sankhya_ajuda_list_prompt_catalog`) |
| `arguments` | object | Varia | Argumentos específicos do prompt |

**Erros:** `INVALID_PROMPT_NAME` quando o nome não casa com nenhum prompt registrado.

---

## Códigos de Erro

| Código | Significado | Tools |
|--------|-------------|-------|
| `NOT_FOUND` | Entidade não existe | `sankhya_ajuda_get_article_details`, `sankhya_ajuda_get_community_post` |
| `RESPONSE_TOO_LARGE` | Resposta excede 400 KB | Todas as tools |
| `INTERNAL_ERROR` | Exceção inesperada | Todas as tools |
| `EMBEDDING_UNAVAILABLE` | Busca semântica indisponível, sem fallback | `sankhya_ajuda_search_articles` (só modo semantic) |
| `INVALID_PROMPT_NAME` | Nome de prompt desconhecido | `sankhya_ajuda_get_prompt_by_name` |

> A `sankhya_ajuda_search_knowledge_unified` **nunca** retorna `EMBEDDING_UNAVAILABLE` —
> ela sempre cai para busca keyword quando os embeddings estão indisponíveis.

---

## Variáveis de Ambiente (relacionadas à busca)

| Variável | Default | Descrição |
|----------|---------|-----------|
| `EMBEDDING_PROVIDER` | `vllm` | `vllm` / `openai` / `none` |
| `COMMUNITY_DIST_THRESHOLD` | `0.45` | Threshold de distância de cosseno para o CTE semântico da comunidade (filtra ruído) |

---

*Gerado para SPEC-SANKHYA-COMMUNITY-001 Fase 3. As 11 tools são registradas em `src/tools/working-index.ts`.*
