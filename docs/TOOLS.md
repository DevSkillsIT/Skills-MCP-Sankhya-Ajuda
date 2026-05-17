<!--
  Sankhya Ajuda MCP - Referencia Completa de Tools, Resources e Prompts
  Skills IT - Solucoes em Tecnologia
  https://www.skillsit.com.br  |  (63) 3224-4925  |  Palmas-TO-Brasil
-->

# Referência de Tools, Resources e Prompts

> Documentação detalhada da superfície MCP do **Sankhya Ajuda MCP**: **8 tools**, **6 resources** (3 estáticas + 3 templates RFC 6570) e **4 prompts**. Todas as operações são **somente leitura** (read-only) sobre o help center público do ERP Sankhya.

**Versão:** 1.5.6 · **Servidor:** `@skillsit/sankhya-ajuda-mcp` · **Protocolo MCP:** 2025-11-25 (Streamable HTTP)

---

## Índice

1. [Visão Geral](#visão-geral)
2. [Convenções de Resposta](#convenções-de-resposta)
3. [Códigos de Erro](#códigos-de-erro)
4. [Tools de Domínio (4)](#tools-de-domínio-4)
   - [`sankhya_ajuda_search_articles`](#sankhya_ajuda_search_articles)
   - [`sankhya_ajuda_get_article_details`](#sankhya_ajuda_get_article_details)
   - [`sankhya_ajuda_list_categories`](#sankhya_ajuda_list_categories)
   - [`sankhya_ajuda_list_sections`](#sankhya_ajuda_list_sections)
5. [Tools-Bridge (4)](#tools-bridge-4)
   - [`sankhya_ajuda_list_mcp_resources`](#sankhya_ajuda_list_mcp_resources)
   - [`sankhya_ajuda_read_resource_by_uri`](#sankhya_ajuda_read_resource_by_uri)
   - [`sankhya_ajuda_list_prompt_catalog`](#sankhya_ajuda_list_prompt_catalog)
   - [`sankhya_ajuda_get_prompt_by_name`](#sankhya_ajuda_get_prompt_by_name)
6. [Resources MCP (6)](#resources-mcp-6)
7. [Prompts MCP (4)](#prompts-mcp-4)
8. [Anotações de Capabilities (MCP Annotations)](#anotações-de-capabilities-mcp-annotations)

---

## Visão Geral

| Categoria | Itens | Prefixo / Esquema | Observação |
|---|---|---|---|
| Tools de domínio | 4 | `sankhya_ajuda_*` | Busca, artigo, categorias, seções |
| Tools-bridge | 4 | `sankhya_ajuda_*` | Adaptadores para clientes que não falam `resources/*` e `prompts/*` nativos |
| Resources | 6 | `sankhya-ajuda://` | 3 estáticas + 3 templates RFC 6570 |
| Prompts | 4 | `sankhya_*` | Workflows parametrizados (troubleshoot, lookup, explain, compare) |

**Base de conhecimento indexada:** 6.123 artigos · 14 categorias · 230 seções (59 aninhadas como subseções) · língua **pt-BR**.

---

## Convenções de Resposta

### Formato

- **Toda resposta é Markdown** (interceptor central em `formatters/response-formatter.ts`).
- Listas e tabelas usam **Markdown table** com cabeçalho fixo.
- Datas em **ISO 8601 UTC** (`2026-05-16T03:00:00.000Z`).
- IDs são sempre **BIGINT** (vindos do Zendesk, nunca renumerados).
- URLs apontam para `https://ajuda.sankhya.com.br/...` (URL pública original do artigo/seção/categoria).

### Cap de Tamanho

- **Cap total de resposta:** 400 KB. Se ultrapassado, a tool retorna `RESPONSE_TOO_LARGE` com sugestão para reduzir `limit` ou `max_body_chars`.
- **Server instructions** (entregues no handshake `initialize`): ≤ 2.000 caracteres.

### Erros (formato 3-partes)

Todos os erros seguem o template:

```
**[CODIGO_DO_ERRO]** {causa} Esperado: {estado esperado}. Sugestão: {próxima ação acionável}.
```

Exemplo:

```
**[EMBEDDING_UNAVAILABLE]** Serviço de embeddings indisponível para busca semântica.
Esperado: vLLM responsivo. Sugestão: tente novamente em alguns minutos ou use mode=keyword.
```

---

## Códigos de Erro

| Código | Causa típica | Resposta sugerida |
|---|---|---|
| `EMBEDDING_UNAVAILABLE` | `mode=semantic` com vLLM/OpenAI fora do ar | Trocar para `mode=keyword` ou aguardar |
| `RESPONSE_TOO_LARGE` | Resposta ultrapassaria 400 KB | Reduzir `limit` ou `max_body_chars` |
| `INTERNAL_ERROR` | Falha inesperada (banco indisponível, exceção interna) | Tentar novamente; reportar se persistir |
| `INVALID_URI` | URI `sankhya-ajuda://` inexistente ou mal-formada | Chamar `sankhya_ajuda_list_mcp_resources` para descobrir URIs válidas |
| `INVALID_PROMPT_NAME` | Nome de prompt fora do enum | Chamar `sankhya_ajuda_list_prompt_catalog` |

> **Erros estruturados** retornam com `isError: true` na resposta MCP, permitindo que o cliente distinga entre falha e sucesso programaticamente.

---

## Tools de Domínio (4)

### `sankhya_ajuda_search_articles`

Busca **híbrida** (RRF k=60), **semântica** ou **keyword-only** sobre os 6.123 artigos.

#### Parâmetros

| Nome | Tipo | Obrigatório | Default | Limites | Descrição |
|---|---|:---:|---|---|---|
| `query` | `string` | Sim | — | 1-500 chars | Texto livre da consulta |
| `limit` | `int` | Não | `15` | 1-50 | Quantidade máxima de resultados |
| `category_id` | `int \| null` | Não | `null` | > 0 | Filtra por uma das 14 categorias |
| `include_outdated` | `bool` | Não | `false` | — | Inclui artigos marcados como obsoletos pela Sankhya |
| `mode` | `enum` | Não | `"hybrid"` | `hybrid` / `semantic` / `keyword` | Estratégia de ranking |

#### Modos de Busca

| Mode | O que faz | Quando usar |
|---|---|---|
| `hybrid` (default) | RRF combinando **pgvector cosine** + **FTS portuguese_unaccent** | Caso geral, melhor recall |
| `semantic` | Apenas pgvector (HNSW cosine sobre `halfvec(2560)`) | Buscar por sinônimos ou paráfrase |
| `keyword` | Apenas FTS PT-BR | Códigos de erro, nomes exatos de tela |

#### Modos Degradados (resposta indica `modeUsed`)

| `modeUsed` retornado | Quando acontece |
|---|---|
| `keyword_fallback` | `mode=hybrid` solicitado mas embeddings indisponíveis → degrada para FTS puro |
| `keyword_index_mismatch` | Guardrail v1.5.4: `EMBEDDING_PROVIDER` ≠ modelo do índice → força keyword |

#### Resposta

Tabela Markdown com colunas:

- **ID** — `article_id` (BIGINT)
- **Título** — título do artigo
- **Breadcrumb** — caminho `Categoria > Seção > [Subseção] > Artigo`
- **Score** — cosine (semantic/hybrid) ou `ts_rank_cd` (keyword)
- **URL** — link público em `ajuda.sankhya.com.br`
- **Outdated** — flag se `include_outdated=true`

Header informativo: `**N resultados** | top-K mostrados | modo: <modeUsed>`.

#### Exemplo de chamada (JSON-RPC MCP)

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "sankhya_ajuda_search_articles",
    "arguments": {
      "query": "como emitir NF-e",
      "limit": 5,
      "mode": "hybrid"
    }
  }
}
```

#### Exemplo de resposta (Markdown)

```markdown
**5 resultados** | top-5 mostrados | modo: hybrid

| ID | Título | Breadcrumb | Score | URL |
|---|---|---|---|---|
| 360045123456 | A empresa não está configurada como emissora de NF-e | Solução de Problemas > Vendas > Emissão de NF-e > ... | 0.739 | https://ajuda.sankhya.com.br/hc/pt-br/articles/360045123456 |
| 360067891234 | E0004 Rejeição: Conteúdo do identificador informado na DPS | Solução de Problemas > Rejeições: NF-e | 0.621 | https://ajuda.sankhya.com.br/hc/pt-br/articles/360067891234 |
| ... | ... | ... | ... | ... |
```

#### Comportamento com `EMBEDDING_PROVIDER=none`

Qualquer `mode != keyword` é silenciosamente coagido para `keyword_fallback`. Sem custo, sem dependência externa.

---

### `sankhya_ajuda_get_article_details`

Recupera o **conteúdo completo** de um artigo: título, breadcrumb, corpo limpo (HTML removido), URL original, autor, tags, datas e flag de obsolescência.

#### Parâmetros

| Nome | Tipo | Obrigatório | Default | Limites | Descrição |
|---|---|:---:|---|---|---|
| `article_id` | `int` (BIGINT) | Sim | — | ≥ 1 | ID do artigo Zendesk (retornado por search) |
| `max_body_chars` | `int` | Não | `8000` | 100 - 40.000 | Limite de caracteres do corpo |

#### Calibração empírica (v1.5.6)

Distribuição real de `length(body_text)` em chars: **P50=1.563**, **P75=3.046**, **P90=7.144**, **P95=12.661**, **P99=40.435**, **MAX=288.953**.

| `max_body_chars` | Cobertura de artigos completos | Quando usar |
|---|---|---|
| `6000` | 88% | Resposta enxuta para suporte |
| `8000` (default) | 92% | Cobre P90, padrão para a maioria dos casos |
| `15000` | 96% | Análise técnica detalhada |
| `40000` (max) | 99% | Comparação ou auditoria profunda |

#### Resposta

Bloco Markdown com:

- **Cabeçalho:** `# <título>` + breadcrumb
- **Metadados:** ID, URL, datas (criação, edição), tags, votos, flag `outdated`
- **Corpo:** texto limpo (HTML stripado), truncado em `max_body_chars` com indicador `...[truncado X chars]` se aplicável

#### Erros

- `NOT_FOUND`: artigo inexistente — sugere chamar `search_articles` para descobrir IDs válidos
- `RESPONSE_TOO_LARGE`: combinação `max_body_chars` excede 400 KB total

#### Exemplo de chamada

```json
{
  "name": "sankhya_ajuda_get_article_details",
  "arguments": {
    "article_id": 360045123456,
    "max_body_chars": 15000
  }
}
```

---

### `sankhya_ajuda_list_categories`

Lista as **14 categorias top-level** do help center.

#### Parâmetros

Nenhum (input schema vazio).

#### Resposta

Tabela Markdown com colunas:

| Coluna | Descrição |
|---|---|
| `id` | BIGINT do Zendesk |
| `name` | Nome da categoria |
| `html_url` | URL pública |
| `article_count` | Total de artigos diretos + via seções aninhadas |
| `position` | Ordem no portal |

Categorias atuais (snapshot 2026-05-16):

1. Solução de Problemas (2.640 artigos)
2. Documentação de Telas (Manual) (1.277)
3. Pessoas+ (770)
4. Dúvidas Frequentes (630)
5. Universidade Sankhya (400)
6. Melhores Práticas (146)
7. Documentação de Jornadas (59)
8. Sankhya Official Pack - SOP (57)
9. Assistente de Melhores Práticas (51)
10. Reforma tributária (42)
11. Sankhya Fintech (35)
12. Service Desk | área do colaborador (7)
13. Modalidade SaaS (5)
14. BIA - Business Intelligence Assistant (4)

---

### `sankhya_ajuda_list_sections`

Lista as **230 seções** com hierarquia aninhada (59 subseções via `parent_section_id`).

#### Parâmetros

| Nome | Tipo | Obrigatório | Default | Descrição |
|---|---|:---:|---|---|
| `category_id` | `int \| null` | Não | `null` | Filtra por uma das 14 categorias |
| `parent_section_id` | `int \| null` | Não | `null` | Filtra apenas subseções de um nodo pai |

#### Resposta

Tabela Markdown ordenada por `position` com colunas:

- `id` (BIGINT)
- `name`
- `category_id` / `category_name`
- `parent_section_id` (ou `—` para top-level)
- `html_url`
- `article_count`

---

## Tools-Bridge (4)

Adaptadores que expõem **resources** e **prompts** MCP nativos como tools regulares, para clientes que não implementam os endpoints `resources/list`, `resources/read`, `prompts/list`, `prompts/get`.

### `sankhya_ajuda_list_mcp_resources`

Lista as **6 URIs** disponíveis sob `sankhya-ajuda://`.

#### Parâmetros

Nenhum.

#### Resposta

Tabela Markdown:

| Coluna | Conteúdo |
|---|---|
| `URI` | URI canônica ou template RFC 6570 |
| `Nome` | Nome legível |
| `Tipo` | `Estatico` ou `Template` |
| `mimeType` | `text/markdown` ou `application/json` |
| `Descricao` | Descrição da URI |

---

### `sankhya_ajuda_read_resource_by_uri`

Lê o conteúdo de uma URI `sankhya-ajuda://`.

#### Parâmetros

| Nome | Tipo | Obrigatório | Descrição |
|---|---|:---:|---|
| `uri` | `string` | Sim | URI concreta (`sankhya-ajuda://articles/123`) ou template (`sankhya-ajuda://articles/{id}` — passar `id` separado) |
| `id` | `int` | Não | Substitui `{id}` quando `uri` é template |

#### Resposta

- **Markdown** para categorias, seções, artigos (com sufixo `_lastModified: <ISO 8601>_`)
- **JSON em fence triplo** para `sync_state`

#### Erros

- `INVALID_URI`: URI fora do conjunto válido — sugere lista de URIs corretas

---

### `sankhya_ajuda_list_prompt_catalog`

Lista os **4 prompts** disponíveis com nome, descrição e argumentos.

#### Parâmetros

Nenhum.

#### Resposta

Tabela Markdown com colunas `Nome`, `Descricao`, `Argumentos` (argumentos obrigatórios marcados com `*`, opcionais com `?`).

---

### `sankhya_ajuda_get_prompt_by_name`

Executa um prompt parametrizado e retorna mensagens estruturadas para a LLM.

#### Parâmetros

| Nome | Tipo | Obrigatório | Descrição |
|---|---|:---:|---|
| `name` | `string` (enum) | Sim | Um de: `sankhya_troubleshoot`, `sankhya_quick_lookup`, `sankhya_explain_module`, `sankhya_compare_articles` |
| `arguments` | `dict<string, string>` | Não (depende do prompt) | Argumentos do prompt (varia por nome) |

#### Resposta

Markdown com:

```markdown
**Prompt: <nome>**

_<descrição>_

**user:**
[System] <instruções do agente>

**user:**
<contexto do usuário com argumentos preenchidos>
```

#### Erros

- `INVALID_PROMPT_NAME`: nome não está no enum

---

## Resources MCP (6)

URIs no esquema `sankhya-ajuda://`. Navegação livre, sem side effects.

### Resources Estáticos (3)

| URI | Nome | mimeType | Conteúdo |
|---|---|---|---|
| `sankhya-ajuda://categories` | Categorias | `text/markdown` | Tabela das 14 categorias |
| `sankhya-ajuda://sections` | Seções | `text/markdown` | Tabela das 230 seções com hierarquia |
| `sankhya-ajuda://sync_state` | Estado do sync | `application/json` | Status JSON do último ETL diário |

#### Schema do `sync_state` (JSON)

```json
{
  "last_status": "ok",
  "last_full_sync_at": "2026-05-16T03:00:42.000Z",
  "last_article_count": 6123,
  "last_changed_count": 14,
  "last_duration_sec": 1068,
  "last_error": null,
  "error_count": 0,
  "articles_count": 6123,
  "with_embedding_count": 6123
}
```

### Resources Template (3, RFC 6570)

| Template | Exemplo concreto | mimeType | Conteúdo |
|---|---|---|---|
| `sankhya-ajuda://categories/{id}` | `sankhya-ajuda://categories/360002947114` | `text/markdown` | Detalhes da categoria |
| `sankhya-ajuda://sections/{id}` | `sankhya-ajuda://sections/360001823814` | `text/markdown` | Detalhes da seção |
| `sankhya-ajuda://articles/{id}` | `sankhya-ajuda://articles/360045123456` | `text/markdown` | Artigo completo (cap interno de 20.000 chars) |

### Metadados de Frescor

Todo `readResource` retorna `_meta.lastModified` (ISO 8601 UTC), permitindo cache invalidation no cliente.

---

## Prompts MCP (4)

Workflows estruturados que orientam a LLM a usar as tools de forma econômica e padronizada.

### `sankhya_troubleshoot`

Investigação passo-a-passo de um erro/problema no Sankhya. Voltado para **técnicos N1/N2**.

| Argumento | Tipo | Obrigatório | Descrição |
|---|---|:---:|---|
| `problem` | `string` | Sim | Descrição do erro ou comportamento inesperado |

**Protocolo embutido:**

1. `search_articles({query: "<sintoma>", mode: "hybrid", limit: 5})`
2. Opcional: `get_article_details({article_id: <melhor match>})`
3. Opcional: `list_categories()` se precisar filtrar por domínio

**Output esperado da LLM:** causa provável, solução passo-a-passo, artigos referenciados (com URL), próximos passos.

**Limite:** máximo 3 tool calls. Recomenda `mode=keyword` se o usuário fornece código de erro específico.

---

### `sankhya_quick_lookup`

Busca rápida com resposta compactada. Voltado para **atendimento** que precisa do artigo direto.

| Argumento | Tipo | Obrigatório | Descrição |
|---|---|:---:|---|
| `term` | `string` | Sim | Termo, código ou nome de tela a localizar |

**Protocolo embutido:** 1 tool call (`search_articles({query: "<termo>", limit: 3})`).

**Output esperado:** top-1 artigo (título + breadcrumb + URL + 1 parágrafo de resumo se necessário).

---

### `sankhya_explain_module`

Explica um módulo do Sankhya citando docs oficiais. Voltado para **consultores e onboarding**.

| Argumento | Tipo | Obrigatório | Descrição |
|---|---|:---:|---|
| `module_name` | `string` | Sim | Nome do módulo (ex: "Faturamento", "Estoque", "MGE") |

**Protocolo embutido:**

1. `search_articles({query: "<módulo> Sankhya conceito", limit: 5, mode: "semantic"})`
2. Opcional: `get_article_details` no artigo mais relevante

**Output esperado:** estrutura *O que é → Quando usar → Pré-requisitos → Telas principais → Erros comuns*, com URLs do help em cada seção.

---

### `sankhya_compare_articles`

Compara N artigos para detectar divergências, convergências e gaps. Voltado para **análise técnica**.

| Argumento | Tipo | Obrigatório | Descrição |
|---|---|:---:|---|
| `article_ids` | `string` (CSV) | Sim | Lista de IDs separados por vírgula, ex: `"12345,67890,11111"` |

**Protocolo embutido:** `get_article_details` para cada ID na lista.

**Output esperado:** tabela Markdown comparativa com convergências/divergências/gaps + sinalização de artigos `outdated`.

---

## Anotações de Capabilities (MCP Annotations)

Todas as tools declaram, via `annotations` do MCP SDK:

| Annotation | Valor | Significado |
|---|---|---|
| `readOnlyHint` | `true` | Nenhuma tool grava no banco |
| `destructiveHint` | `false` | Nenhuma ação destrutiva |
| `idempotentHint` | `true` | Chamadas repetidas com mesmos args retornam mesmo resultado |
| `openWorldHint` | `true` (apenas em `search_articles`) | Resultado depende de estado externo (índice do banco) |

> **Implicação prática:** clientes MCP que respeitam `openWorldHint` podem cachear `list_categories`, `list_sections`, `list_mcp_resources` e `list_prompt_catalog` agressivamente. Apenas `search_articles` e `get_article_details` precisam invalidação por `lastModified` do `sync_state`.

---

## Variáveis de Ambiente que Afetam o Comportamento das Tools

| Variável | Efeito nas tools |
|---|---|
| `EMBEDDING_PROVIDER=vllm` | `search_articles` usa vLLM Qwen3 para vetorizar queries |
| `EMBEDDING_PROVIDER=openai` | Usa OpenAI `text-embedding-3-large @ 2560` (banco precisa estar reindexado) |
| `EMBEDDING_PROVIDER=none` | `search_articles` força `keyword_fallback` em todos os modes |
| `MCP_AUTH_TOKEN` | Bearer obrigatório em todas as chamadas exceto `/health` |

Detalhes completos em [`EMBEDDINGS-PROVIDER.md`](./EMBEDDINGS-PROVIDER.md) e [`FALLBACK_STRATEGY.md`](./FALLBACK_STRATEGY.md).

---

## Boas Práticas de Uso (para a LLM e para o desenvolvedor)

1. **Economia de tokens:** 1 call de `search_articles` já retorna top-N com breadcrumb. Evite chamar `get_article_details` em loop para todos os resultados.
2. **Default `limit=15`:** use `limit=3-5` para resposta rápida; `limit=25-50` apenas em análise comparativa profunda. Calibrado para corpus de 6.123 artigos com 64% concentrados em 2 categorias.
3. **`include_outdated=false` default:** só passe `true` se o usuário pedir conteúdo arquivado.
4. **Use `list_categories()` antes de filtrar:** se for limitar busca por `category_id`, descubra os IDs primeiro.
5. **Códigos de erro do Sankhya:** use `mode=keyword` para correspondência exata (ex: `"E0004"`, `"PRD0011"`).
6. **Sinônimos e paráfrase:** use `mode=semantic` ou `hybrid` (default).
7. **Comparações entre artigos:** prefira o prompt `sankhya_compare_articles` em vez de múltiplos `get_article_details` manuais.

---

## Referências Cruzadas

| Documento | Sobre |
|---|---|
| [`README.md`](../README.md) | Visão geral do projeto e instalação rápida |
| [`EXAMPLES.md`](./EXAMPLES.md) | Cenários práticos de uso por perfil (suporte, consultor, técnico) |
| [`INSTALL.md`](./INSTALL.md) | Instalação passo-a-passo (5 cenários) |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Arquitetura técnica (Fase 1 ETL + Fase 2 MCP) |
| [`SCHEMA.md`](./SCHEMA.md) | Schema PostgreSQL + pgvector |
| [`EMBEDDINGS-PROVIDER.md`](./EMBEDDINGS-PROVIDER.md) | Como escolher e migrar entre `vllm` / `openai` / `none` |
| [`FALLBACK_STRATEGY.md`](./FALLBACK_STRATEGY.md) | Política de fallback intra-provider |

---

<div align="center">

**Construído por [Skills IT](https://www.skillsit.com.br)**

🌐 [www.skillsit.com.br](https://www.skillsit.com.br) · 📱 (63) 3224-4925 (WhatsApp/Telefone) · 📍 Palmas — TO — Brasil

</div>
