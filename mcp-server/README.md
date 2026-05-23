<!--
  Sankhya Ajuda MCP Server - Fase 3 (TypeScript)
  Skills IT - Solucoes em Tecnologia
  https://www.skillsit.com.br  |  (63) 3224-4925  |  Palmas-TO-Brasil
-->

# Sankhya Ajuda MCP Server

> Sub-projeto TypeScript. Documentação geral do projeto em [`../README.md`](../README.md). Guia de instalação em [`../docs/INSTALL.md`](../docs/INSTALL.md). Referência completa de todas as 10 tools (v1.2.0) em [`docs/TOOLS.md`](./docs/TOOLS.md).

Servidor MCP (Streamable HTTP) que expõe a **base de conhecimento unificada do ERP Sankhya** — 6.125 artigos do help center público (`ajuda.sankhya.com.br`) **e** 7.619 posts do fórum da comunidade — para qualquer cliente MCP compatível com o protocolo **2025-11-25**: Claude Desktop, Claude Code, Cursor, VS Code Copilot, ChatGPT/OpenAI Responses API, e outros.

Implementa busca híbrida (Reciprocal Rank Fusion k=60) sobre similaridade semântica (pgvector + halfvec 2560d) e FTS PT-BR (`portuguese_unaccent`), com RRF cross-fonte para misturar help e comunidade numa única consulta.

Implementação das SPEC-SANKHYA-AJUDA-001 e SPEC-SANKHYA-COMMUNITY-001. Mirrors os padrões validados em produção de `omie-erp` e `gseonline` (também MCPs da Skills IT).

---

## Arquitetura

| Camada | Tecnologia |
|---|---|
| **Stack** | Node.js 22 LTS + TypeScript 5 (strict) + MCP SDK ≥1.18 |
| **Transport** | Streamable HTTP em `:3105/mcp` com Bearer auth |
| **Storage** | PostgreSQL 16+ com pgvector (`halfvec(2560)`) |
| **Embeddings** | `EMBEDDING_PROVIDER` ∈ {`vllm`, `openai`, `none`} — mutuamente exclusivos. Ver [`../docs/EMBEDDINGS-PROVIDER.md`](../docs/EMBEDDINGS-PROVIDER.md) |
| **Hospedagem** | PM2 (path nativo) **ou** Docker Compose |
| **Auth** | Bearer com `crypto.timingSafeEqual` (constant-time) |

---

## Superfície MCP

### 11 Tools

#### Busca e Navegação (Help Center)

| Tool | Função |
|---|---|
| ~~`sankhya_ajuda_search_articles`~~ | _Removida em v1.2.0_ — busca consolidada em `sankhya_ajuda_search_knowledge_unified` (Busca Unificada abaixo). Source preservado em `src/tools/search.ts` para reativação |
| `sankhya_ajuda_get_article_details` | Artigo completo em Markdown (`max_body_chars` 100-40000, default 8000) |
| `sankhya_ajuda_list_categories` | 14 categorias top-level do help center |
| `sankhya_ajuda_list_sections` | 230 seções (filtros `category_id`, `parent_section_id`) |

#### Busca Unificada (Help + Comunidade)

| Tool | Função |
|---|---|
| `sankhya_ajuda_search_knowledge_unified` | Busca unificada sobre help center **e** fórum da comunidade Sankhya em uma consulta, com ranking RRF cross-fonte e rótulo de fonte/oficial. `source ∈ {help, community, all}` (default `all`) |

#### Comunidade Sankhya

| Tool | Função |
|---|---|
| `sankhya_ajuda_get_community_post` | Thread completo de um post da comunidade (perguntas, respostas e replies aninhadas) a partir do `post_id` |
| `sankhya_ajuda_list_community_spaces` | Lista os 33 espaços públicos do fórum da comunidade Sankhya (id, nome, slug, URL, posts\_count, members\_count) |

#### Bridge MCP (Resources e Prompts)

| Tool | Função |
|---|---|
| `sankhya_ajuda_list_mcp_resources` | Bridge: lista 6 URIs MCP disponíveis |
| `sankhya_ajuda_read_resource_by_uri` | Bridge: lê uma URI `sankhya-ajuda://` |
| `sankhya_ajuda_list_prompt_catalog` | Bridge: lista 4 prompts pré-configurados |
| `sankhya_ajuda_get_prompt_by_name` | Bridge: executa prompt parametrizado |

### 6 Resources (`sankhya-ajuda://`)

- `sankhya-ajuda://categories` (estático, Markdown)
- `sankhya-ajuda://sections` (estático, Markdown)
- `sankhya-ajuda://sync_state` (estático, JSON)
- `sankhya-ajuda://categories/{id}` (template, Markdown)
- `sankhya-ajuda://sections/{id}` (template, Markdown)
- `sankhya-ajuda://articles/{id}` (template, Markdown)

### 4 Prompts

- `sankhya_troubleshoot` (argumento: `problem`)
- `sankhya_quick_lookup` (argumento: `term`)
- `sankhya_explain_module` (argumento: `module_name`)
- `sankhya_compare_articles` (argumento: `article_ids` — CSV de BIGINTs)

📖 **Referência completa de cada tool/resource/prompt:** [`../docs/TOOLS.md`](../docs/TOOLS.md)

---

## Rodar local

### Instalação

```bash
# Instalar dependências
npm install

# Build TypeScript
npm run build

# Configurar .env (a partir de .env.example)
cp .env.example .env
$EDITOR .env   # ajustar MCP_AUTH_TOKEN, PG_PASSWORD, EMBEDDING_PROVIDER, etc.

# Rodar uma vez (dev)
npm start

# Ou via PM2 (produção)
pm2 start ecosystem.http.config.cjs
pm2 logs mcp-sankhya-ajuda
```

### Variáveis de Ambiente Mínimas

| Variável | Obrigatório | Default | Observação |
|---|---|---|---|
| `MCP_AUTH_TOKEN` | ✅ Sim | — | Gere com `openssl rand -hex 32` |
| `MCP_HOST` | Não | `0.0.0.0` | Bind address |
| `MCP_PORT` | Não | `3105` | TCP port |
| `PG_HOST` | ✅ Sim | `127.0.0.1` | PostgreSQL host |
| `PG_PORT` | Não | `5433` | PostgreSQL port |
| `PG_DATABASE` | Não | `sankhya_ajuda` | Database name |
| `PG_USER` | Não | `sankhya_ajuda` | DB user |
| `PG_PASSWORD` | ✅ Sim | — | DB password |
| `EMBEDDING_PROVIDER` | Não | `vllm` | `vllm` / `openai` / `none` |
| `VLLM_BASE_URL` | se provider=`vllm` | — | URL do vLLM |
| `VLLM_API_KEY` | se provider=`vllm` | — | Bearer do vLLM |
| `OPENAI_API_KEY` | se provider=`openai` | — | Chave OpenAI |
| `SESSION_IDLE_TIMEOUT_MS` | Não | `1800000` (30 min) | Cleanup de sessões idle |

Lista completa em [`.env.example`](./.env.example).

---

## Conectar Clientes MCP

O endpoint é universal: **`http://<host>:3105/mcp`** com header `Authorization: Bearer ${MCP_AUTH_TOKEN}`.

### Padrão de configuração (todos os clientes)

| Campo | Valor |
|---|---|
| Transport | `http` (Streamable HTTP) |
| URL | `http://127.0.0.1:3105/mcp` (mesma VM) ou `http://<ip>:3105/mcp` (LAN/VPN) |
| Auth | Header `Authorization: Bearer <MCP_AUTH_TOKEN>` |
| Protocol | `2025-11-25` (negociado no handshake) |

📖 **Configurações específicas por cliente** (Claude Desktop, Claude Code, Cursor, VS Code Copilot, OpenAI Responses API, ChatGPT Enterprise) em [`../README.md#configuração-nos-clientes-mcp`](../README.md#configuração-nos-clientes-mcp).

### Usar de Outra Máquina (LAN / VPN / Internet)

| Cenário | URL | Pré-requisitos |
|---|---|---|
| **Mesma VM** | `http://127.0.0.1:3105/mcp` | Nenhum — já funciona |
| **Outra VM na LAN/VPN** | `http://<ip-do-host>:3105/mcp` | `MCP_HOST=0.0.0.0` (default) + firewall liberando 3105 |
| **Internet pública** | `https://<seu-dominio>/mcp` | Reverse proxy (Caddy/Nginx) com TLS via `acme.sh` ou Let's Encrypt |

> **Importante:** cada cliente leva apenas o **token Bearer** no seu config local — nunca copie o `.env` completo do servidor (ele contém `PG_PASSWORD`, `VLLM_API_KEY`, etc.). O Bearer é segredo independente, rotacionável.

### Rotacionar Token

```bash
NOVO=$(openssl rand -hex 32)
sed -i "s/^MCP_AUTH_TOKEN=.*/MCP_AUTH_TOKEN=$NOVO/" .env
pm2 restart mcp-sankhya-ajuda
# Atualizar em TODOS os clientes (Claude/Cursor/etc) com o novo token
```

---

## Verificar `/health`

Endpoint **público (sem auth)**, ideal para healthchecks externos.

```bash
curl -s http://localhost:3105/health | jq
```

Resposta esperada:

```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptime_sec": 3600,
  "sessions": 0,
  "tenant": "skillsit",
  "last_sync_status": "ok",
  "last_sync_at": "2026-05-16T03:00:00.000Z",
  "articles_count": 6125,
  "with_embedding_count": 6125,
  "error_count": 0
}
```

Status possíveis: `ok` (saudável), `degraded` (sync com erro ou banco fora), HTTP 503 (exception não tratada).

---

## Embeddings: `EMBEDDING_PROVIDER` (v1.5.3+)

Escolha **mutuamente exclusiva**, configurada no `.env`. Cada deploy define **um** provider; o banco precisa estar indexado com **o mesmo modelo** usado em runtime.

| `EMBEDDING_PROVIDER` | Quando usar | Banco esperado |
|---|---|---|
| `vllm` (default, SkillsIT) | Você tem vLLM local com `Qwen3-Embedding-4B` | indexado Qwen3 2560d ✅ |
| `openai` | Sem GPU local, OpenAI key disponível | re-indexar com `text-embedding-3-large @ dimensions=2560` |
| `none` | Sem vLLM nem chave OpenAI | qualquer estado (semantic forçado a keyword) |

### ⚠️ Aviso crítico: NUNCA misture providers (cross-model)

Trocar `EMBEDDING_PROVIDER` **sem re-indexar o banco** quebra a busca semântica. Os vetores ficam em espaços vetoriais diferentes — o cosine similarity vira ruído matemático.

Demonstração empírica em 2026-05-16, query `"emissao de NF-e"`:

| | Banco Qwen3 + query Qwen3 | Banco Qwen3 + query OpenAI |
|---|---|---|
| Score top-1 | **0.739** | **0.052** (14× pior) |
| Top-1 | "A empresa não configurada como emissora de NF-e" ✅ | "B.I.A - Business Intelligence Analyst" ❌ |

**Conclusão:** não há "fallback automático para OpenAI quando vLLM cai". É decisão de deploy mutuamente exclusiva — SPEC RF07/AD-005.

O **guardrail v1.5.4** detecta automaticamente no boot e força `keyword_index_mismatch` para evitar resultados silenciosamente ruins.

📖 Detalhes em [`../docs/EMBEDDINGS-PROVIDER.md`](../docs/EMBEDDINGS-PROVIDER.md).

---

## Política de Fallback intra-provider (RF07)

Quando o provider primário falha (timeout, 5xx) **mantendo o mesmo modelo**:

| Mode | provider ok | provider down |
|---|---|---|
| `hybrid` (default) | RRF (semantic + keyword) | `keyword_fallback` (FTS puro) |
| `semantic` | só semantic | erro `EMBEDDING_UNAVAILABLE` (sem fallback silencioso) |
| `keyword` | só FTS | só FTS (nunca chama embeddings) |

Se `EMBEDDING_PROVIDER=none`, `hybrid` e `semantic` se comportam como provider permanentemente down (degrada para keyword ou retorna erro estruturado).

📖 Detalhes em [`../docs/FALLBACK_STRATEGY.md`](../docs/FALLBACK_STRATEGY.md).

---

## Comandos de Desenvolvimento

```bash
npm run lint        # ESLint
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run test:coverage  # vitest com cobertura
npm run build       # tsc → dist/
```

### Estrutura de Pastas

```
mcp-server/
├── src/
│   ├── index.ts                       ← entry point
│   ├── server.ts                      ← McpServer factory
│   ├── config.ts                      ← zod settings (env)
│   ├── db.ts                          ← PostgreSQL queries + pgvector + community funcs
│   ├── embeddings.ts                  ← vLLM + OpenAI clients
│   ├── index-compat.ts                ← guardrail cross-model (v1.5.4)
│   ├── resources.ts                   ← 6 resources sankhya-ajuda://
│   ├── prompts.ts                     ← 4 prompts MCP
│   ├── version.ts                     ← versão do servidor
│   ├── types.ts                       ← tipos compartilhados (UnifiedHit, CommunityHit, ...)
│   ├── logger.ts                      ← pino setup
│   │
│   ├── tools/
│   │   ├── base.ts                    ← createSuccess/Error/Cap helpers
│   │   ├── working-index.ts           ← registerAllTools (10 tools em v1.2.0)
│   │   ├── search.ts                  ← sankhya_ajuda_search_articles (DISABLED em v1.2.0)
│   │   ├── articles.ts                ← sankhya_ajuda_get_article_details
│   │   ├── categories.ts              ← sankhya_ajuda_list_categories
│   │   ├── sections.ts                ← sankhya_ajuda_list_sections
│   │   ├── search-unified.ts          ← sankhya_ajuda_search_knowledge_unified (novo)
│   │   ├── community.ts               ← sankhya_ajuda_get_community_post + sankhya_ajuda_list_community_spaces (novo)
│   │   ├── resource-tools.ts          ← bridge: sankhya_ajuda_list_mcp_resources + sankhya_ajuda_read_resource_by_uri
│   │   └── prompt-tools.ts            ← bridge: sankhya_ajuda_list_prompt_catalog + sankhya_ajuda_get_prompt_by_name
│   │
│   ├── search/
│   │   └── rrf.ts                     ← crossSourceRRF + dedupCommunityByTitle (novo)
│   │
│   ├── formatters/
│   │   ├── entity.ts                  ← formatadores de domain objects
│   │   ├── markdown.ts                ← table/detail utilities
│   │   └── response-formatter.ts      ← interceptor central de respostas
│   │
│   ├── transports/
│   │   ├── http.ts                    ← Streamable HTTP + session lifecycle
│   │   ├── auth.ts                    ← bearer middleware (timingSafeEqual)
│   │   ├── oauth-rejection.ts         ← JSON 404 para OAuth
│   │   └── health.ts                  ← /health handler
│   │
│   └── utils/
│       └── html-stripper.ts           ← sanitização HTML residual
│
├── tests/                             ← vitest unit tests
│   ├── search/rrf.test.ts             ← crossSourceRRF + dedupCommunityByTitle
│   ├── tools/search-unified.test.ts   ← runUnifiedSearch (mocked DB)
│   ├── tools/community.test.ts        ← sankhya_ajuda_get_community_post + sankhya_ajuda_list_community_spaces
│   ├── audit.test.ts                  ← AC08 compliance: 10 tools (v1.2.0), annotations, naming
│   └── integration/
│       └── smoke-db.test.ts           ← AC02/03/07/09 (guarded: RUN_DB_SMOKE=1)
├── docs/TOOLS.md                      ← referência completa de todas as 10 tools (v1.2.0)
├── ecosystem.http.config.cjs          ← config PM2
├── Dockerfile                         ← imagem multi-stage Node
├── .env.example
├── package.json
└── tsconfig.json
```

---

## SPEC e Histórico

Implementações:
- [`SPEC-SANKHYA-AJUDA-001`](../../.moai/specs/SPEC-SANKHYA-AJUDA-001/spec.md) — help center, busca híbrida, resources, prompts.
- [`SPEC-SANKHYA-COMMUNITY-001`](../../.moai/specs/SPEC-SANKHYA-COMMUNITY-001/spec.md) — busca unificada (help + comunidade), RRF cross-fonte, ferramentas de domínio da comunidade.

Histórico de versões em [`../CHANGELOG.md`](../CHANGELOG.md).

---

<div align="center">

**Construído por [Skills IT](https://www.skillsit.com.br) · Palmas-TO-Brasil**

🌐 [www.skillsit.com.br](https://www.skillsit.com.br) · 📱 (63) 3224-4925 · 📍 Palmas — TO — Brasil

</div>
