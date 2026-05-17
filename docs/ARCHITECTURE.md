# sankhya_ajuda — MCP de Ajuda do Sankhya

**Escopo**: Base de conhecimento pública do Sankhya (ajuda.sankhya.com.br).
**NÃO é** integração com o ERP Sankhya — é um assistente de helpdesk/documentação.

**Arquitetura**: Duas fases desacopladas via schema PostgreSQL.

---

## Contexto

A ferramenta oficial de IA do Sankhya (**BIA — Business Intelligence Assistant**) tem limitações
de cobertura e qualidade. Este MCP indexa a base de conhecimento pública do Sankhya e expõe
busca semântica + FTS para uso com **qualquer cliente compatível com MCP 2025-11-25 Streamable HTTP**
(Claude Desktop, Claude Code, Cursor, VS Code Copilot, ChatGPT via OpenAI Responses API, Continue.dev,
Cline, Zed e outros), substituindo a BIA com qualidade superior e custo controlado.

Projeto dividido em:
- **Fase 1** — Python ETL (em produção, intocada)
- **Fase 2** — Node.js TypeScript MCP Server (v1.5+, implementado em SPEC-SANKHYA-AJUDA-001)

---

## Descobertas de API (Análise Realizada em 2026-05-15)

A base de conhecimento é hospedada em **Zendesk**. A API REST é pública (sem auth).

| Endpoint | Status | Dados |
|---|---|---|
| `GET /api/v2/help_center/pt-br/categories.json` | ✅ Público | 14 categorias |
| `GET /api/v2/help_center/pt-br/sections.json` | ✅ Público | 230 seções |
| `GET /api/v2/help_center/pt-br/articles.json` | ✅ Público | 6.124 artigos, 62 páginas |
| `GET /api/v2/help_center/pt-br/articles/{id}.json` | ✅ Público | HTML completo do artigo |
| `GET /api/v2/help_center/articles/search.json?query=X` | ✅ Público | Busca com body + snippet |
| `GET /api/v2/incremental/help_center/articles.json` | ❌ 401 | Requer conta Zendesk admin |

**Base URL**: `https://ajuda.sankhya.com.br`

### Volume de conteúdo
- 14 categorias (Documentação de Telas, Jornadas, Solução de Problemas, FAQ, Reforma Tributária, etc.)
- 230 seções
- 6.124 artigos com HTML completo acessível via API
- Histórico desde março de 2021

### Conteúdo dos artigos
O campo `body` retorna HTML completo com parágrafos, tabelas, listas, `<code>`.
O campo `snippet` na busca retorna trecho com termo destacado via `<em>`.

---

## Arquitetura Definida (Fases 1 + 2)

```
Zendesk API (pública, sem auth)
      │
      │  sync diário 03:00 (FASE 1)
      ▼
 Python ETL (sync/sync.py)
      │  HTML → texto limpo (BeautifulSoup)
      │  SHA256(body) → detecta mudança real
      ▼
PostgreSQL postgres:5433
  database: sankhya_ajuda   ← banco dedicado, isolado
  schema: public
  ├── categories         (14 rows)
  ├── sections           (230 rows; hierarquia parent_section_id)
  ├── articles           (6.123 rows)
  │   ├── body_text       TEXT             (HTML → texto limpo)
  │   ├── embedding_model VARCHAR          (ex: "Qwen/Qwen3-Embedding-4B")
  │   ├── embedding       HALFVEC(2560)    (pgvector; mutuamente exclusivo: vllm OU openai)
  │   ├── outdated        BOOLEAN          (flag Sankhya)
  │   ├── tsv             tsvector         (FTS PT-BR)
  │   └── ... (author, breadcrumb, labels, etc.)
  ├── skipped_articles   (auditoria)
  ├── sync_state         (singleton; status, timestamps, counters)
  └── (índices HNSW pgvector + GIN FTS)
      │
      ├─────────────────────────────────────────────────────────────────
      │
      └─→ [ACOPLAMENTO: APENAS SCHEMA] ←──────────────────────────────
          (ETL escreve, MCP lê — independentes)
      │
      ▼
 MCP Server (FASE 2 — mcp-server/src/)
 Node.js 22 + TypeScript 5 + MCP SDK
      │
      │  8 tools + 6 resources + 4 prompts
      │  Bearer auth, /health, JSON 404 OAuth
      │
      ▼
 Clientes MCP (Claude Desktop, Claude Code, Cursor, VS Code Copilot,
       ChatGPT/OpenAI Responses API, Continue.dev, etc.) via Streamable HTTP
```

**Acoplamento**: Apenas via PostgreSQL. Cada fase é independente.
- Fase 1 (Python ETL): pode ser atualizada sem tocar no MCP
- Fase 2 (Node MCP): pode ser atualizada sem rodar sync

---

## Infraestrutura (já disponível neste servidor)

### PostgreSQL + pgvector
- **Container**: `postgres` (pgvector/pgvector:pg16)
- **Porta**: `5433` (host) → `5432` (container)
- **Database a criar**: `sankhya_ajuda` (banco dedicado, isolado do LibreChat)
- **Extensão**: `vector 0.8.1` ✅ já instalada no container (image pgvector/pgvector:pg16)

### Embeddings — vLLM
- **Endpoint**: `http://vllm.example.com:8090/v1/embeddings`
- **Model**: `/model` (Qwen3-embedding-4b)
- **Dimensões**: 2560
- **Auth**: **Bearer token via `VLLM_API_KEY`** (ativado na implementação)
- **Context length**: **4.096 tokens** — sync trunca `body_text` em 8.000 chars antes de enviar (margem segura para PT-BR ~0,34 tokens/char)
- **Config**: via variáveis de ambiente `VLLM_BASE_URL`, `VLLM_API_KEY`, `VLLM_MODEL`
- **Timeout**: 60s
- **Retry**: 3 tentativas com full-jitter exponential backoff em 5xx/429/network errors; 4xx não retrials

---

## Estratégia de Sync / Reindexação

### Sync diário (03:00, todo dia)
1. Busca todas as 62 páginas da API (6.124 artigos)
2. Para cada artigo, calcula `SHA256(article.body)`
3. Se hash == `body_hash` no banco → **skip** (sem re-embedding, atualiza só se metadados mudaram)
4. Se hash diferente ou artigo novo → atualiza `body_text` + gera embedding novo
5. Remove do banco artigos cujos IDs não aparecerem mais na API (deletados)
6. Atualiza `sync_state.last_sync_at = now()`

> Na prática: ~62 requisições HTTP para listar, re-embedding apenas dos ~5-20 artigos que mudaram.
> Tempo estimado: 2-5 minutos (limitado pela geração de embeddings, não pela API).

### Rate limiting Zendesk
- Tratar HTTP 429 com `Retry-After` header
- Delay de 0.3s entre páginas (precaução)

---

## FASE 2 — MCP Tools (interface pública)

**8 tools (v1.5.5), todas read-only.** Referência detalhada por tool (parâmetros, validação, retorno, exemplos) em [`TOOLS.md`](./TOOLS.md).

| Tool | Parâmetros | Descrição |
|---|---|---|
| `sankhya_ajuda_search_articles` | `query: string` (1-500 chars), `limit?: int=15` (1-50), `category_id?: int\|null`, `mode?: 'hybrid'\|'semantic'\|'keyword'='hybrid'`, `include_outdated?: bool=false` | Busca híbrida (RRF k=60) ou modo único |
| `sankhya_ajuda_get_article_details` | `article_id: int` (BIGINT), `max_body_chars?: int=8000` (100-40000) | Artigo completo em Markdown |
| `sankhya_ajuda_list_categories` | — (input vazio) | Lista as 14 categorias (ID, nome, URL, contagem) |
| `sankhya_ajuda_list_sections` | `category_id?: int\|null`, `parent_section_id?: int\|null` | Lista 230 seções (59 subseções aninhadas) |
| `sankhya_ajuda_list_mcp_resources` | — | Bridge: lista 6 URIs `sankhya-ajuda://` |
| `sankhya_ajuda_read_resource_by_uri` | `uri: string`, `id?: int` (para templates) | Bridge: lê uma URI (categories/{id}, sections/{id}, articles/{id}, categories, sections, sync_state) |
| `sankhya_ajuda_list_prompt_catalog` | — | Bridge: lista 4 prompts (metadados) |
| `sankhya_ajuda_get_prompt_by_name` | `name: enum`, `arguments?: dict<string,string>` | Bridge: executa prompt (`sankhya_troubleshoot`, `sankhya_quick_lookup`, `sankhya_explain_module`, `sankhya_compare_articles`) |

### Anotações MCP (Capabilities)

Todas as tools declaram: `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`. Apenas
`sankhya_ajuda_search_articles` declara `openWorldHint=true` (depende de estado externo do índice).
Outras tools podem ser cacheadas agressivamente pelos clientes.

### Transport (Fase 2)

- **Protocolo**: Streamable HTTP (MCP 2025-11-25)
- **Port**: `:3105`
- **Endpoint**: `/mcp`
- **Auth**: Bearer token via `MCP_AUTH_TOKEN`, validado com `crypto.timingSafeEqual`
- **/health**: endpoint público (sem auth), retorna status + article count
- **OAuth discovery**: JSON 404 (nenhum OAuth suportado)

### Pré-processamento do corpo dos artigos (sync.py)

```
body HTML (Zendesk)
  → BeautifulSoup: strip todas as tags HTML
  → normalizar espaços / quebras de linha
  → body_text = title + "\n\n" + texto_limpo   ← campo indexado e embedado
  → body_hash = SHA256(body_text)              ← detecta mudança real
```

Texto limpo é o que vai para o embedding e para o índice FTS — sem ruído de tags HTML.

### Provedores de embedding (v1.5.3+, mutuamente exclusivos)

**Toggle `EMBEDDING_PROVIDER` (no `.env`) define o provider em DEPLOYMENT**:

| Valor | Provider | Dimensões | Quando usar | Banco indexado com |
|---|---|---|---|---|
| `vllm` (default) | vLLM local (Qwen3-Embedding-4B) | 2560 | GPU NVIDIA + vLLM containerizado | Qwen3 2560d |
| `openai` | OpenAI Cloud (text-embedding-3-large) | 2560 | Sem GPU local, OpenAI key disponível | OpenAI 2560d (re-indexado) |
| `none` | Nenhum (FTS only) | — | Sem vLLM nem OpenAI | qualquer (semantic→keyword forced) |

**Importante**: O banco precisa estar indexado com **o MESMO modelo** do provider em runtime.
Trocar provider **sem re-indexar** quebra a busca semântica (cross-model é matematicamente inválido).

### Fallback intra-provider (RF07 — policy)

Quando o provider em uso falha (timeout, 5xx, etc.), mantendo o mesmo modelo:

| Mode | Provider OK | Provider down |
|---|---|---|
| `hybrid` (default) | RRF (semantic+keyword) | `keyword_fallback` (FTS puro) |
| `semantic` | só semantic (pgvector) | erro estruturado `EMBEDDING_UNAVAILABLE` |
| `keyword` | FTS puro | FTS puro (nunca chama embeddings) |

**Exemplo**: Banco indexado Qwen3, `EMBEDDING_PROVIDER=vllm`:
- vLLM OK → RRF com Qwen3 vectors ✅
- vLLM timeout → FTS puro ✅
- Trocar env para OpenAI SEM re-indexar → guardrail: `keyword_index_mismatch` ⚠️

### Busca híbrida (detalhe)

```sql
-- FTS configurado com unaccent + stemmer portuguese
-- "relatório" e "relatorio" encontram o mesmo artigo
-- Busca em: título + corpo completo (não apenas título)

semantic: embedding <=> query_vector
          (cosine distance, índice HNSW pgvector)

keyword:  to_tsvector('portuguese_unaccent', body_text)
          @@ plainto_tsquery('portuguese_unaccent', query)
```

A query do usuário é embedada em tempo real (vLLM, ~50ms) e comparada contra os
6.124 vetores. Resultado: artigos relevantes mesmo com vocabulário diferente
(ex: "como lançar nota" encontra "emissão de NF-e").

---

## Stack Técnico

### FASE 1 — Python ETL

```
httpx            # HTTP client para Zendesk API
beautifulsoup4   # HTML → texto limpo
psycopg[binary]  # PostgreSQL async (connection pool)
pgvector         # pgvector cliente (embedding insert)
structlog        # JSON logging estruturado
python-dotenv    # variáveis de ambiente
```

### FASE 2 — Node.js TypeScript MCP Server

```
@modelcontextprotocol/sdk  # MCP SDK ≥1.18 (StreamableHTTPServerTransport)
express                    # HTTP server (para /health, fallback)
zod                        # runtime schema validation
pg                         # PostgreSQL client pool + pgvector type registration
pino                       # JSON logging estruturado
typescript                 # strict mode, tsc --noEmit
vitest                     # unit tests
```

---

## Não-Goals (fora do escopo)

- **Não** faz write-back ao Zendesk (somente leitura)
- **Não** se conecta ao ERP Sankhya (banco de dados, API de negócio, pedidos, etc.)
- **Não** substitui o suporte técnico — apenas facilita encontrar documentação
- **Não** gera respostas autônomas — expõe ferramentas para o Claude usar
- **Não** acessa artigos privados/internos do Zendesk (apenas conteúdo público)

---

## Estrutura de Pastas

```
/path/to/sankhya-ajuda-mcp/
│
├── README.md                    ← overview + quick start (2 paths)
├── LICENSE                      ← MIT com Skills IT
├── CHANGELOG.md                 ← Keep a Changelog (v0.1.0 Fase1, v0.2.0+ Fase2)
├── .env.example                 ← convenção (unificado para Fase1+2)
├── pyproject.toml               ← Python 3.13 (Fase 1 — ETL)
│
├── docs/
│   ├── ARCHITECTURE.md          ← este arquivo (Fases 1+2)
│   ├── DEPLOY.md                ← Path A (Docker) + Path B (PM2)
│   ├── SCHEMA.md                ← PostgreSQL schema + índices
│   ├── EMBEDDINGS-PROVIDER.md   ← AD-005 (provider toggle + cross-model guardrail)
│   ├── FALLBACK_STRATEGY.md     ← RF07 (intra-provider fallback policy)
│   ├── OPERATIONS.md            ← runbook: monitoramento, comandos, troubleshooting
│   └── ACCEPTANCE_REPORT.md     ← teste de aceite Fase 1
│
├── src/sankhya_ajuda/           ← FASE 1 (Python ETL, intocado)
│   ├── __init__.py
│   ├── config.py
│   ├── db.py
│   └── embeddings.py
│
├── sync/                        ← FASE 1 (Python, intocado)
│   ├── sync.py
│   ├── parser.py
│   └── zendesk.py
│
├── sql/
│   └── schema.sql               ← schema.sql (DDL idempotente, ambas fases usam)
│
├── mcp-server/                  ← FASE 2 (Node.js TypeScript MCP)
│   ├── README.md                ← overview específico Fase 2
│   ├── CHANGELOG.md             ← v1.0.0+ (pode consolidar com raiz)
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   │
│   ├── .env.example
│   ├── ecosystem.http.config.cjs ← PM2 config (Fase 2)
│   │
│   └── src/
│       ├── index.ts             ← entry point MCP server
│       ├── config.ts            ← settings loader (env vars)
│       ├── db.ts                ← PostgreSQL queries + pgvector
│       ├── index-compat.ts      ← guardrail cross-model (v1.5.4)
│       │
│       ├── tools/               ← 8 MCP tools
│       │   ├── base.ts          ← response formatters
│       │   ├── search.ts        ← sankhya_ajuda_search_articles
│       │   ├── articles.ts      ← sankhya_ajuda_get_article_details
│       │   ├── categories.ts    ← sankhya_ajuda_list_categories
│       │   ├── sections.ts      ← sankhya_ajuda_list_sections
│       │   ├── resource-tools.ts ← list_mcp_resources + read_resource_by_uri
│       │   └── prompt-tools.ts  ← list_prompt_catalog + get_prompt_by_name
│       │
│       ├── resources.ts         ← 6 MCP resources (sankhya-ajuda://)
│       ├── prompts.ts           ← 4 MCP prompts
│       │
│       ├── formatters/
│       │   ├── entity.ts        ← formatters de domain objects
│       │   ├── markdown.ts      ← tabelas + markdown utils
│       │   └── response-formatter.ts ← interceptor respostas
│       │
│       └── transports/
│           └── http.ts          ← Streamable HTTP + /health
│
├── tests/                       ← FASE 1 (Python, podem estar aqui ou mcp-server/tests)
│   └── *.test.ts ou *.test.py
│
├── docker-compose.yml           ← Postgres + ETL + MCP (profiles: default, gpu)
├── Dockerfile.etl               ← multi-stage Python
│
├── scripts/
│   └── setup_db.sh              ← script shell: cria role + extensions
│
└── .moai/specs/
    └── SPEC-SANKHYA-AJUDA-001/  ← SPEC + acceptance criteria (link para docs)
```

**Princípio**: Acoplamento via schema PostgreSQL apenas. Fases independentes.

---

## Variáveis de Ambiente (.env)

```env
# PostgreSQL (postgres existente)
PG_HOST=localhost
PG_PORT=5433
PG_DB=sankhya_ajuda
PG_USER=sankhya_ajuda
PG_PASSWORD=

# vLLM Embeddings
VLLM_BASE_URL=http://vllm.example.com:8090/v1
VLLM_API_KEY=         # vazio por enquanto, será preenchido após configuração
VLLM_MODEL=/model
VLLM_TIMEOUT=60

# Zendesk / Sankhya Help Center
SANKHYA_HC_BASE=https://ajuda.sankhya.com.br
SANKHYA_HC_LOCALE=pt-br
SANKHYA_HC_PER_PAGE=100

# Sync schedule (diário às 03:00)
SYNC_CRON=0 3 * * *
```

---

## Implementation Notes (desvios do design original)

Decisões tomadas durante a implementação que divergem (ou enriquecem) este documento de design:

1. **`HALFVEC(2560)` em vez de `VECTOR(2560)`** — pgvector limita HNSW a 2.000 dims em `vector`; `halfvec` (float16) suporta até 4.000 dims. Trade-off de meia-precisão é desprezível para busca por cosseno (recall < 1% de degradação em literatura).

2. **`parent_section_id` em `sections`** — descoberta durante inspeção da API: 26% das seções aninham sob outra. Sem isso, perderíamos a hierarquia `Sankhya > Pessoas+ > Lançamentos e Cálculos > Lançamentos da folha`. Implementado com FK `DEFERRABLE INITIALLY DEFERRED` + 2-pass no sync (insert all + update parents).

3. **Truncamento de input do embedding em 8.000 chars** — vLLM rejeita inputs > 4.096 tokens. Truncamento happens só na borda do vetor; `body_text` completo continua no banco para FTS e para `sankhya_get_article` (Fase 2).

4. **`articles.breadcrumb` materializado** — VIEW recursiva `article_breadcrumb` existe, mas materializar evita o custo de CTE em toda query (no MCP esse caminho é exibido sempre). Refresh ao final de cada sync.

5. **Campos extras capturados** (não estavam no design original):
   - `outdated` — Sankhya marca conteúdo obsoleto; filtragem no MCP.
   - `author_id` — útil para auditoria; resolver para nome requer chamada extra.
   - `content_tag_ids` — tags estruturadas (UUIDs), complementam `label_names`.

6. **`skipped_articles` table** — auditoria de artigos sem embedding (atualmente 0). Skip resiliente (em vez de abort) impede que 1 artigo problemático invalide o sync inteiro.

7. **`error_count` em `sync_state`** — contador consecutivo de falhas, zera em `ok`. Habilita alertas tipo "N runs de cron consecutivos falharam".

8. **Cron + logrotate instalados** em `/etc/cron.d/` e `/etc/logrotate.d/`. Log em `/var/log/sankhya_ajuda_sync.log` (weekly × 4).

---

## Próximos Passos

1. ~~Criar SPEC formal (SPEC-SANKHYA-AJUDA-001)~~ ← TODO (Fase 2)
2. ~~Implementar `sql/schema.sql`~~ ✅
3. ~~Implementar `sync.py` (ETL + scheduler)~~ ✅
4. ~~Implementar Fase 2 MCP Server~~ ✅ (TypeScript v1.5.5+, 8 tools, 6 resources, 4 prompts)
5. ~~Configurar `docker-compose.yml`~~ ✅
6. ~~Teste de carga: indexar os 6.124 artigos~~ ✅ (1.068 s, 0 skips — ver `docs/ACCEPTANCE_REPORT.md`)
7. Open-source release ← em andamento (ver `[Unreleased]` em CHANGELOG.md)

---

*Documento criado em: 2026-05-15*
*Última revisão: 2026-05-16 (de-bias para multi-cliente MCP, atualizado para v1.5.5 com 8 tools/6 resources/4 prompts)*
*Status: Fase 1 (sync) **completa**; Fase 2 (MCP server) **completa**; release open-source **em andamento***
