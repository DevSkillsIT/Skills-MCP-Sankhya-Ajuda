<!--
  Sankhya Ajuda MCP - Skills IT - Solucoes em Tecnologia
  https://www.skillsit.com.br  |  (63) 3224-4925  |  Palmas-TO-Brasil
-->

# Sankhya Ajuda MCP

> **Status:** ✅ Em produção · **Versão:** 1.5.5 · **Endpoint padrão:** `http://<host>:3105/mcp` · **Tools:** 8 · **Resources:** 6 · **Prompts:** 4 · **Desenvolvido por:** [Skills IT](https://www.skillsit.com.br)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![MCP Protocol](https://img.shields.io/badge/MCP-2025--11--25-orange)](https://modelcontextprotocol.io)
[![Node](https://img.shields.io/badge/Node-22%20LTS-green)](https://nodejs.org)
[![Python](https://img.shields.io/badge/Python-3.13-blue)](https://www.python.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16%2B%20%2B%20pgvector-336791)](https://www.postgresql.org/)

> **Servidor MCP (Model Context Protocol)** que torna pesquisável os **6.123 artigos** do help center público do ERP **Sankhya** (`ajuda.sankhya.com.br`) via **busca híbrida** (Reciprocal Rank Fusion sobre `pgvector` + FTS PT-BR com `unaccent`).

---

## 📋 Índice

1. [Visão Geral](#visão-geral)
2. [Por que desenvolvemos este MCP?](#por-que-desenvolvemos-este-mcp)
3. [Arquitetura](#arquitetura)
4. [Instalação Rápida](#instalação-rápida)
5. [Configuração nos Clientes MCP](#configuração-nos-clientes-mcp)
6. [Tools, Resources e Prompts](#tools-resources-e-prompts)
7. [Exemplos de Uso](#exemplos-de-uso)
8. [Embeddings: provider toggle](#embeddings-provider-toggle)
9. [Segurança e Autenticação](#segurança-e-autenticação)
10. [Operação e Monitoramento](#operação-e-monitoramento)
11. [Troubleshooting](#troubleshooting)
12. [Stack Técnico](#stack-técnico)
13. [Disclaimer](#disclaimer)
14. [Documentação Relacionada](#documentação-relacionada)
15. [Links Úteis](#links-úteis)

---

## Visão Geral

O **Sankhya Ajuda MCP** é um servidor desenvolvido internamente pela **Skills IT** que implementa o **Model Context Protocol (MCP)** para tornar pesquisável o help center público do ERP **Sankhya** (sistema brasileiro líder em gestão empresarial).

Este servidor permite que assistentes de IA (**Claude Desktop, Claude Code, Cursor, VS Code Copilot, ChatGPT/OpenAI Responses API**, e qualquer cliente MCP compatível) façam consultas estruturadas sobre os **6.123 artigos** indexados do help oficial, retornando:

- 🔍 **Busca híbrida** com ranking de relevância (semântica + keyword)
- 📖 **Conteúdo completo** dos artigos em Markdown limpo
- 🗂️ **Hierarquia** de categorias e seções (14 + 230 + 59 subseções)
- 🤖 **Workflows nomeados** para troubleshooting, lookup, explicação de módulos e comparativos
- 📊 **Estado da sincronização** via endpoint público `/health`

### Casos de Uso

| Perfil | Benefício |
|---|---|
| **Suporte Técnico N1/N2** | Busca rápida de soluções, códigos de erro, procedimentos |
| **Consultores** | Explicação estruturada de módulos para reuniões e treinamentos |
| **Novos colaboradores** | Roteiro de onboarding com artigos oficiais em ordem didática |
| **Analistas** | Comparativos entre artigos, auditoria de conteúdo obsoleto |
| **Bots/Integrações** | API uniforme MCP para integrar com Slack/Teams/CrewAI/LangChain |

---

## Por que desenvolvemos este MCP?

A ferramenta oficial de IA do Sankhya (**BIA — Business Intelligence Assistant**) tem limitações de qualidade e cobertura. Este MCP foi desenvolvido para:

| Característica | BIA (oficial) | Sankhya Ajuda MCP (Skills IT) |
|---|---|---|
| **Cobertura de artigos** | Limitada | ✅ 6.123 artigos indexados |
| **Busca semântica** | Restrita | ✅ pgvector + Qwen3 / OpenAI (mutuamente exclusivos) |
| **Busca por código de erro** | Imprecisa | ✅ FTS PT-BR com `unaccent` |
| **Acessível via IA externa** | ❌ | ✅ Claude, ChatGPT, Cursor, Copilot, etc. |
| **Histórico/cache local** | ❌ | ✅ PostgreSQL próprio |
| **Atualização** | ? | ✅ Cron diário às 03:00 (SHA256 change detection) |
| **Sem custo recorrente** | ❌ (B.I.A é parte do plano) | ✅ Opção `EMBEDDING_PROVIDER=none` zero cost |
| **Auto-hospedado** | ❌ | ✅ Docker ou PM2 nativo |

### Funcionalidades Exclusivas

1. **Busca Híbrida RRF** — Reciprocal Rank Fusion (k=60) combinando similaridade semântica e FTS PT-BR
2. **Guardrail Cross-Model** — detecta automaticamente quando provider de embeddings não bate com modelo do índice e degrada com aviso visível (v1.5.4)
3. **Modos de fallback transparentes** — `keyword_fallback`, `keyword_index_mismatch` com label visível na resposta
4. **Toggle `EMBEDDING_PROVIDER`** — `vllm` (local), `openai` (cloud) ou `none` (FTS-only, sem custo)
5. **Tools-bridge** — adaptadores que expõem `resources/*` e `prompts/*` como tools regulares, para máxima compatibilidade
6. **4 Prompts pré-configurados** — workflows guiados (troubleshoot, quick_lookup, explain_module, compare_articles)
7. **Calibração empírica** — defaults `limit=10`, `max_body_chars=6000` baseados em distribuição real do corpus (P50-P99)

---

## Arquitetura

O projeto é composto por **duas fases desacopladas**, conversando apenas via schema PostgreSQL.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Cliente IA (Claude, ChatGPT, Cursor, Copilot, scripts...)              │
│                                                                          │
│  Streamable HTTP + Bearer (Authorization header) + MCP-Protocol-Version │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ MCP 2025-11-25
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Sankhya Ajuda MCP Server (FASE 2 — Node 22 + TypeScript 5)             │
│  Default port :3105                                                      │
│                                                                          │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌────────────────┐ │
│  │  4 tools     │ │  4 bridge    │ │  6 resources │ │  4 prompts     │ │
│  │  domínio     │ │  tools       │ │  sankhya-    │ │  workflows     │ │
│  │              │ │              │ │  ajuda://    │ │  nomeados      │ │
│  └──────────────┘ └──────────────┘ └──────────────┘ └────────────────┘ │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │  Auth (timingSafeEqual)  │  /health público  │  OAuth 404 JSON     │ │
│  │  Session lifecycle (30 min idle)  │  Response cap 400 KB           │ │
│  │  Guardrail cross-model index/provider (v1.5.4)                     │ │
│  └────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │  SQL (pgvector + FTS)
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  PostgreSQL 16+ com pgvector + unaccent + pg_trgm                       │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  categories (14)  │  sections (230, 59 aninhadas)                │  │
│  │  articles (6.123) │  embedding HALFVEC(2560) + tsvector FTS PT-BR │  │
│  │  sync_state       │  skipped_articles  │  article_breadcrumb VIEW │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│         Índices: HNSW pgvector + GIN FTS + btree partial outdated       │
└─────────────────────────────────────────────────────────────────────────┘
                                    ▲
                                    │  Sync diário 03:00 (SHA256 detection)
                                    │
┌─────────────────────────────────────────────────────────────────────────┐
│  ETL Sankhya Ajuda (FASE 1 — Python 3.13)                               │
│                                                                          │
│  Zendesk Help Center API (público, sem auth)                            │
│         │                                                                │
│         ▼                                                                │
│  httpx → BeautifulSoup (HTML strip) → SHA256 diff →                     │
│  vLLM/OpenAI embedding → PostgreSQL upsert                              │
└─────────────────────────────────────────────────────────────────────────┘
                                    ▲
                                    │
                          https://ajuda.sankhya.com.br
                                (Help Center público,
                                 hospedado no Zendesk)
```

### Componentes

| Componente | Função | Tecnologia |
|---|---|---|
| **Fase 1 — ETL** | Scraping diário, geração de embeddings, popula banco | Python 3.13, `httpx`, `psycopg`, `pgvector`, `beautifulsoup4`, `structlog` |
| **Fase 2 — MCP Server** | Expõe tools/resources/prompts MCP via HTTP | Node 22 LTS, TypeScript 5, MCP SDK ≥ 1.18, Express, `zod`, `pino`, `pg` |
| **Banco** | Schema dedicado `sankhya_ajuda` | PostgreSQL 16+ + `pgvector` (halfvec 2560d) + `unaccent` + `pg_trgm` |
| **Embeddings** | Geração de vetores em índice e em query | vLLM (Qwen3-Embedding-4B) **ou** OpenAI `text-embedding-3-large @ 2560` |
| **Transporte** | Streamable HTTP MCP 2025-11-25 | Bearer auth com `crypto.timingSafeEqual`, SSE para chunked responses |
| **Orquestração** | Deploy | Docker Compose (com profile `gpu`) **ou** PM2 nativo |

> **Acoplamento mínimo:** Fase 1 e Fase 2 conversam apenas via schema PostgreSQL. Cada uma pode ser atualizada independentemente.

---

## Instalação Rápida

### 5 Cenários Suportados

| Cenário | Stack | Tempo | Custo |
|---|---|---|---|
| **#1 — Teste rápido** | Docker, sem GPU, sem DB | 5 min | Grátis |
| **#2 — Servidor Production (PM2)** | PostgreSQL existente | 30 min | Grátis (infra própria) |
| **#3 — Com GPU NVIDIA** | Docker + nvidia-docker, vLLM | 10 min | Grátis |
| **#4 — Production com TLS** | PM2 + Caddy/Nginx + backup | 1 hora | Grátis |
| **#5 — FTS only (zero cost)** | Docker, sem embeddings | 5 min | Grátis |

📖 **Instruções passo-a-passo:** [`docs/INSTALL.md`](./docs/INSTALL.md)

### Teste Rápido (Cenário #1)

```bash
git clone https://github.com/skillsit/sankhya-ajuda-mcp.git
cd sankhya-ajuda-mcp

cp .env.example .env
# Edite .env: gere MCP_AUTH_TOKEN com: openssl rand -hex 32
# Para zero-cost, deixe EMBEDDING_PROVIDER=none

docker compose up -d                              # sobe postgres + mcp
docker compose run --rm etl sankhya-sync          # primeira indexação

curl http://localhost:3105/health                 # verificar status
```

Completo em ~10 min. Veja [`docs/INSTALL.md`](./docs/INSTALL.md) para detalhes.

### Production (Cenário #2 — com PostgreSQL existente)

```bash
git clone https://github.com/skillsit/sankhya-ajuda-mcp.git
cd sankhya-ajuda-mcp

# FASE 1 — Python ETL
python3.13 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env && $EDITOR .env
.venv/bin/python -m sync.sync --full

# FASE 2 — Node MCP Server
cd mcp-server && npm install && npm run build
cp .env.example .env && $EDITOR .env
pm2 start ecosystem.http.config.cjs
pm2 save
```

Detalhes em [`docs/DEPLOY.md`](./docs/DEPLOY.md).

---

## Configuração nos Clientes MCP

> **Princípio universal:** todo cliente MCP precisa de **3 dados**: URL (`http://<host>:3105/mcp`), header `Authorization: Bearer <MCP_AUTH_TOKEN>` e (idealmente) versão de protocolo `2025-11-25`.

### Claude Desktop

Arquivo: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) ou `%APPDATA%\Claude\claude_desktop_config.json` (Windows).

```json
{
  "mcpServers": {
    "sankhya-ajuda": {
      "type": "http",
      "url": "http://mcp.example.com:3105/mcp",
      "headers": {
        "Authorization": "Bearer SEU_MCP_AUTH_TOKEN"
      }
    }
  }
}
```

Reinicie o Claude Desktop. As tools `sankhya_ajuda_*` aparecerão no painel.

### Claude Code (CLI)

Arquivo: `.mcp.json` na raiz do projeto **ou** `~/.claude/.mcp.json` global.

```json
{
  "mcpServers": {
    "sankhya-ajuda": {
      "type": "http",
      "url": "http://mcp.example.com:3105/mcp",
      "headers": {
        "Authorization": "Bearer SEU_MCP_AUTH_TOKEN"
      }
    }
  }
}
```

Reinicie o Claude Code. Comando: `claude --debug "mcp"` para verificar conexão.

### Cursor

Arquivo: `~/.cursor/mcp.json` ou settings do projeto.

```json
{
  "mcpServers": {
    "sankhya-ajuda": {
      "transport": "http",
      "url": "http://mcp.example.com:3105/mcp",
      "headers": {
        "Authorization": "Bearer SEU_MCP_AUTH_TOKEN"
      }
    }
  }
}
```

### VS Code Copilot

Arquivo: `.vscode/mcp.json` no workspace **ou** `settings.json` global.

```json
{
  "servers": {
    "sankhya-ajuda": {
      "type": "http",
      "url": "http://mcp.example.com:3105/mcp",
      "headers": {
        "Authorization": "Bearer SEU_MCP_AUTH_TOKEN"
      }
    }
  }
}
```

### OpenAI Responses API (ChatGPT / GPT-4.1+)

Disponível desde 2025-05. Use o tipo `mcp` na lista de tools da chamada.

**Python:**

```python
from openai import OpenAI

client = OpenAI()

response = client.responses.create(
    model="gpt-4.1",
    input="Como resolver o erro E0004 na NF-e do Sankhya?",
    tools=[{
        "type": "mcp",
        "server_label": "sankhya-ajuda",
        "server_url": "http://mcp.example.com:3105/mcp",
        "headers": {
            "Authorization": "Bearer SEU_MCP_AUTH_TOKEN"
        },
        "require_approval": "never"
    }]
)

print(response.output_text)
```

**curl:**

```bash
curl https://api.openai.com/v1/responses \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4.1",
    "input": "Sankhya, como cancelar uma NF-e?",
    "tools": [{
      "type": "mcp",
      "server_label": "sankhya-ajuda",
      "server_url": "http://mcp.example.com:3105/mcp",
      "headers": { "Authorization": "Bearer SEU_MCP_AUTH_TOKEN" },
      "require_approval": "never"
    }]
  }'
```

### ChatGPT (Enterprise / Team — Custom Connectors)

ChatGPT Enterprise e Team suportam **conectores MCP customizados** via painel admin. Configure:

- **Tipo:** Remote MCP Server
- **URL:** `http://mcp.example.com:3105/mcp`
- **Auth:** Bearer header `Authorization: Bearer <MCP_AUTH_TOKEN>`
- **Protocol version:** `2025-11-25`

> Após adicionado pelo admin, usuários veem o conector no menu **Tools** do ChatGPT.

### Outros Clientes Compatíveis com MCP

Qualquer aplicação que implemente o **MCP 2025-11-25 com Streamable HTTP** consegue usar este servidor. Padrão de configuração:

| Campo | Valor |
|---|---|
| Transport | `http` ou `streamable-http` |
| URL | `http://<host>:3105/mcp` |
| Headers | `Authorization: Bearer <token>` |
| Protocol-Version | `2025-11-25` |

Exemplos de clientes confirmados: **mcp-cli**, **Cline (VS Code)**, **Zed**, **Continue.dev**, **LibreChat**, **Open WebUI**.

### Testar Conexão

```bash
# Health check (sem auth, público)
curl http://localhost:3105/health | jq

# Esperado:
# {
#   "status": "ok",
#   "version": "1.0.0",
#   "articles_count": 6123,
#   "with_embedding_count": 6123,
#   "last_sync_status": "ok",
#   ...
# }
```

```bash
# Testar tools/list (com auth)
curl -s -X POST http://localhost:3105/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer SEU_TOKEN" \
  -H "MCP-Protocol-Version: 2025-11-25" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-11-25",
      "capabilities": {},
      "clientInfo": { "name": "curl-test", "version": "1.0" }
    }
  }'
```

---

## Tools, Resources e Prompts

📖 **Referência completa:** [`docs/TOOLS.md`](./docs/TOOLS.md)

### 8 Tools (somente leitura)

| Tool | Categoria | Função |
|---|---|---|
| `sankhya_ajuda_search_articles` | Domínio | Busca híbrida (RRF) / semantic / keyword sobre os 6.123 artigos |
| `sankhya_ajuda_get_article_details` | Domínio | Artigo completo em Markdown (com cap configurável de caracteres) |
| `sankhya_ajuda_list_categories` | Domínio | Lista as 14 categorias top-level |
| `sankhya_ajuda_list_sections` | Domínio | Lista 230 seções (com `category_id` e `parent_section_id` opcionais) |
| `sankhya_ajuda_list_mcp_resources` | Bridge | Lista as 6 URIs `sankhya-ajuda://` disponíveis |
| `sankhya_ajuda_read_resource_by_uri` | Bridge | Lê o conteúdo de uma URI `sankhya-ajuda://` |
| `sankhya_ajuda_list_prompt_catalog` | Bridge | Lista os 4 prompts com argumentos |
| `sankhya_ajuda_get_prompt_by_name` | Bridge | Executa um prompt parametrizado |

### 6 Resources (esquema `sankhya-ajuda://`)

| URI | Tipo | Conteúdo |
|---|---|---|
| `sankhya-ajuda://categories` | Estático Markdown | Tabela das 14 categorias |
| `sankhya-ajuda://sections` | Estático Markdown | Tabela das 230 seções |
| `sankhya-ajuda://sync_state` | Estático JSON | Status do último sync |
| `sankhya-ajuda://categories/{id}` | Template Markdown | Detalhe de 1 categoria |
| `sankhya-ajuda://sections/{id}` | Template Markdown | Detalhe de 1 seção |
| `sankhya-ajuda://articles/{id}` | Template Markdown | Artigo completo |

### 4 Prompts (workflows nomeados)

| Prompt | Função | Argumento |
|---|---|---|
| `sankhya_troubleshoot` | Investigação passo-a-passo de problema | `problem` (descrição do erro) |
| `sankhya_quick_lookup` | Busca rápida com resposta compactada | `term` (termo, código, tela) |
| `sankhya_explain_module` | Explicação estruturada de módulo | `module_name` (ex: "Faturamento") |
| `sankhya_compare_articles` | Comparativo entre N artigos | `article_ids` (CSV de IDs) |

---

## Exemplos de Uso

📖 **Cenários práticos detalhados:** [`docs/EXAMPLES.md`](./docs/EXAMPLES.md)

### Exemplo 1 — Suporte rápido por código de erro

**Prompt no cliente MCP:**

```
Sankhya, o que significa o erro E0004 na NF-e?
```

**O que acontece:**

1. A LLM chama `sankhya_ajuda_search_articles({query: "E0004 NF-e", mode: "keyword"})`
2. Recebe top-3 artigos com URLs
3. Apresenta resposta com causa, solução e link oficial

---

### Exemplo 2 — Troubleshooting estruturado (prompt nomeado)

**Em Claude Code:**

```
/sankhya_troubleshoot problem="Cliente reporta erro 'serviço não configurado' ao emitir NF-e"
```

**Em qualquer outro cliente:**

Chame `sankhya_ajuda_get_prompt_by_name` com `name="sankhya_troubleshoot"` e `arguments={problem: "..."}`.

**Resposta esperada:** investigação estruturada com causa provável, solução passo-a-passo e artigos referenciados.

---

### Exemplo 3 — Explicar um módulo para reunião

```
Sankhya, me dê uma visão geral do módulo de Faturamento.
```

A LLM usa o prompt `sankhya_explain_module` internamente e produz:

- O que é
- Quando usar
- Pré-requisitos
- Telas principais (com links)
- Erros comuns (com links)

---

### Exemplo 4 — Comparativo técnico

```
Sankhya, compare estes 3 artigos: 360045123456, 360067891234, 360011223344
```

Usa o prompt `sankhya_compare_articles` e produz tabela com convergências, divergências e gaps.

---

### Exemplo 5 — Reforma Tributária

```
Sankhya, quais cuidados devo ter com TGF (Tipos de Operação) sob a Reforma Tributária?
```

Busca filtrada pela categoria "Reforma tributária" (42 artigos).

---

📖 **Mais 15+ cenários por perfil em** [`docs/EXAMPLES.md`](./docs/EXAMPLES.md): suporte N1, suporte N2, consultoria, onboarding, análise técnica, comparativos, casos da Reforma Tributária, uso programático (Python/Node/curl), padrões anti-hallucination.

---

## Embeddings: provider toggle

O servidor suporta **3 providers de embeddings** **mutuamente exclusivos**, configurados via `EMBEDDING_PROVIDER` no `.env`.

| Provider | Modelo | Dimensões | Quando usar | Custo |
|---|---|---|---|---|
| **`vllm`** (default) | Qwen3-Embedding-4B | 2560 | GPU NVIDIA local com vLLM | Zero (após GPU) |
| **`openai`** | text-embedding-3-large | 2560 (truncado via Matryoshka) | Sem GPU, OpenAI key disponível | ~$0.03 / 6k artigos + $0.00001/query |
| **`none`** | — | — | Sem vLLM e sem OpenAI | Zero |

### ⚠️ Cross-Model Guardrail (v1.5.4)

**Trocar `EMBEDDING_PROVIDER` SEM re-indexar o banco quebra a busca semântica** — vetores de modelos diferentes vivem em espaços vetoriais incompatíveis. O servidor detecta automaticamente no boot e:

- Loga `warn` estruturado
- Força `mode=hybrid|semantic` a degradar para `keyword_index_mismatch`
- Exibe label visível na resposta da tool

📖 **Decisão arquitetural completa:** [`docs/EMBEDDINGS-PROVIDER.md`](./docs/EMBEDDINGS-PROVIDER.md)

📖 **Política de fallback (RF07):** [`docs/FALLBACK_STRATEGY.md`](./docs/FALLBACK_STRATEGY.md)

---

## Segurança e Autenticação

### Bearer Token (Authorization Header)

Todas as chamadas para `/mcp` exigem o header:

```
Authorization: Bearer <MCP_AUTH_TOKEN>
```

A comparação é feita com **`crypto.timingSafeEqual`** (constant-time, evita timing attacks).

### Rotação de Token

```bash
# 1. Gerar novo token
NOVO=$(openssl rand -hex 32)

# 2. Atualizar no .env do servidor
sed -i "s/^MCP_AUTH_TOKEN=.*/MCP_AUTH_TOKEN=$NOVO/" .env

# 3. Atualizar em TODOS os clientes (Claude, Cursor, etc.)

# 4. Reiniciar servidor
pm2 restart mcp-sankhya-ajuda           # PM2
# ou
docker compose restart mcp-server       # Docker
```

### Endpoint Público

`GET /health` é **público (sem auth)** propositalmente, para healthchecks externos (Prometheus, Uptime Kuma, etc.). **Nunca expõe credenciais** — apenas status, contadores e timestamps.

### OAuth Discovery

O servidor responde **JSON 404** em `/.well-known/oauth-*` para indicar que **não suporta OAuth** (apenas Bearer estático). Clientes MCP modernos detectam isso e fazem fallback automático para Bearer.

### Não há acesso ao ERP Sankhya

Este MCP **consome apenas o conteúdo público** do help center (`ajuda.sankhya.com.br`). **Não acessa**:

- ❌ API de negócio do Sankhya ERP
- ❌ Banco de dados do cliente
- ❌ Dados financeiros, pedidos, cadastros de clientes
- ❌ Artigos privados/internos do Zendesk (apenas público)

### Camadas de Segurança

| Camada | Implementação |
|---|---|
| **Autenticação** | Bearer token via `Authorization` header |
| **Constant-time compare** | `crypto.timingSafeEqual` (Node.js nativo) |
| **Session lifecycle** | Idle timeout 30 min (configurável), reaper periódico |
| **Response cap** | 400 KB por resposta (evita exfiltração massiva) |
| **Read-only** | Nenhuma tool escreve no banco |
| **Input validation** | `zod` schemas em todos os parâmetros |
| **No secrets in logs** | Pino com redaction; tokens nunca aparecem em log |
| **JSON 404 OAuth** | Bloqueia descoberta de OAuth não suportado |

---

## Operação e Monitoramento

📖 **Runbook completo:** [`docs/OPERATIONS.md`](./docs/OPERATIONS.md)

### Health Check

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
  "articles_count": 6123,
  "with_embedding_count": 6123
}
```

Status possíveis: `ok` (saudável), `degraded` (banco fora ou sync com erro), `error` (exception interna).

### Comandos PM2

```bash
pm2 status mcp-sankhya-ajuda
pm2 logs mcp-sankhya-ajuda --lines 50
pm2 restart mcp-sankhya-ajuda
pm2 stop mcp-sankhya-ajuda
pm2 monit
```

### Comandos Docker

```bash
docker compose ps
docker compose logs -f mcp-server
docker compose restart mcp-server
docker compose run --rm etl sankhya-sync          # forçar resync
```

### Sync Manual

```bash
# Native
cd /path/to/sankhya-ajuda-mcp
.venv/bin/python -m sync.sync --full

# Docker
docker compose run --rm etl sankhya-sync
```

### Cron Diário (default 03:00)

```cron
0 3 * * * cd /path/to/sankhya-ajuda-mcp && .venv/bin/python -m sync.sync >> /var/log/sankhya_ajuda_sync.log 2>&1
```

### Alertas Recomendados

| Condição | Severidade |
|---|---|
| `sync_state.error_count >= 3` | High |
| `last_sync_at < now() - 36h` | High |
| `with_embedding_count < articles_count - 10` | Medium |
| `/health` retorna 503 por > 5 min | Critical |

---

## Troubleshooting

### Erro: `401 unauthorized`

**Causa:** Token Bearer incorreto ou ausente.

**Solução:**
1. Confirme que `MCP_AUTH_TOKEN` no `.env` é idêntico ao header `Authorization: Bearer ...` no cliente
2. Verifique se não há espaços extras ou quebra de linha no token
3. Reinicie o servidor após editar `.env`

```bash
# Teste manual
curl -i -H "Authorization: Bearer $MCP_AUTH_TOKEN" http://localhost:3105/mcp
```

### Erro: `connection refused` em :3105

**Causa:** Servidor MCP não está rodando.

**Solução:**

```bash
# Docker
docker compose ps
docker compose logs mcp-server --tail 30

# PM2
pm2 status
pm2 logs mcp-sankhya-ajuda --lines 30
```

### Erro: `EMBEDDING_UNAVAILABLE` em modo `semantic`

**Causa:** vLLM ou OpenAI fora do ar.

**Solução:**
1. Verifique conectividade com o provider (`curl $VLLM_BASE_URL/health`)
2. Use `mode=keyword` ou `mode=hybrid` temporariamente (`hybrid` degrada para `keyword_fallback` automaticamente)
3. Investigue logs do provider

### Resposta com label `keyword (index mismatch)`

**Causa:** `EMBEDDING_PROVIDER` foi alterado SEM re-indexar o banco.

**Solução:** [Migrar entre providers](./docs/EMBEDDINGS-PROVIDER.md#como-migrar-entre-providers) — reindexa o banco com o novo modelo.

### Health retorna `articles_count: 0`

**Causa:** Sync ainda não rodou.

**Solução:**

```bash
docker compose run --rm etl sankhya-sync   # Docker
# OU
sankhya-sync                                # Native (com venv ativo)
```

### Cliente MCP não enxerga as tools

**Solução:**
1. Confirme `.mcp.json` / settings com URL e token corretos
2. Reinicie o cliente (Claude Desktop, Cursor, VS Code, etc.)
3. Use o comando `--debug "mcp"` (Claude Code) para inspecionar handshake
4. Teste manualmente com `curl` (ver seção [Testar Conexão](#testar-conexão))

### Erro: `RESPONSE_TOO_LARGE`

**Causa:** Resposta excede 400 KB (cap de proteção).

**Solução:** Reduzir `limit` (em `search_articles`) ou `max_body_chars` (em `get_article_details`).

📖 **Troubleshooting completo:** [`docs/OPERATIONS.md`](./docs/OPERATIONS.md#troubleshooting)

---

## Stack Técnico

| Camada | Tecnologia | Versão |
|---|---|---|
| **ETL (Fase 1)** | Python | 3.13 |
| | httpx, psycopg, pgvector, beautifulsoup4, structlog, pytest | latest stable |
| **Banco** | PostgreSQL | 16+ |
| | Extensões | `vector` ≥0.8, `unaccent`, `pg_trgm` |
| **Embeddings** | vLLM com Qwen3-Embedding-4B (2560d) | runtime escolha |
| | **OU** OpenAI `text-embedding-3-large @ 2560` | |
| **MCP Server (Fase 2)** | Node.js | 22 LTS |
| | TypeScript | 5 (strict) |
| | MCP SDK | ≥ 1.18 |
| | Express, zod, pino, vitest | latest stable |
| **Transporte** | Streamable HTTP (MCP 2025-11-25) | Bearer auth, SSE |
| **Orquestração** | Docker Compose com profiles | **ou** PM2 |
| **TLS (produção)** | Caddy / Nginx + `acme.sh + dns_cpanel` | wildcard |

---

## Disclaimer

> Este projeto **não é afiliado, endossado ou patrocinado pela Sankhya Gestão de Negócios S/A**. Ele consome apenas o conteúdo público disponível em `ajuda.sankhya.com.br` (Help Center hospedado no Zendesk). "Sankhya" é uma marca de seu respectivo titular e é referenciada aqui apenas para identificar o domínio da documentação processada.
>
> **Nenhum dado de negócio, financeiro ou pessoal do ERP Sankhya é acessado ou processado por este software.** O MCP opera exclusivamente sobre conteúdo público de help center.

### Suporte e Contato

Implementação e manutenção: **[Skills IT — Soluções em Tecnologia](https://www.skillsit.com.br)**

- 🌐 [www.skillsit.com.br](https://www.skillsit.com.br)
- 📱 **(63) 3224-4925** — WhatsApp / Telefone
- 📍 **Palmas — TO — Brasil**
- ✉️ suporte@skillit.com.br

Para questões técnicas: abra uma **issue no GitHub** (após publicação) ou contate diretamente pelos canais acima.

---

## Documentação Relacionada

| Documento | Conteúdo |
|---|---|
| [`docs/TOOLS.md`](./docs/TOOLS.md) | Referência detalhada de cada tool, resource e prompt |
| [`docs/EXAMPLES.md`](./docs/EXAMPLES.md) | 20+ cenários práticos por perfil (suporte, consultor, técnico) |
| [`docs/INSTALL.md`](./docs/INSTALL.md) | Instalação passo-a-passo em 5 cenários |
| [`docs/DEPLOY.md`](./docs/DEPLOY.md) | Deploy avançado (Docker + PM2 + TLS) |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | Arquitetura técnica (Fase 1 + Fase 2) |
| [`docs/SCHEMA.md`](./docs/SCHEMA.md) | Schema PostgreSQL + pgvector |
| [`docs/EMBEDDINGS-PROVIDER.md`](./docs/EMBEDDINGS-PROVIDER.md) | Como escolher e migrar provider (vllm/openai/none) |
| [`docs/FALLBACK_STRATEGY.md`](./docs/FALLBACK_STRATEGY.md) | Política de fallback intra-provider (RF07) |
| [`docs/OPERATIONS.md`](./docs/OPERATIONS.md) | Runbook de operação e monitoramento |
| [`docs/ACCEPTANCE_REPORT.md`](./docs/ACCEPTANCE_REPORT.md) | Relatório de aceite da Fase 1 (ETL) |
| [`CHANGELOG.md`](./CHANGELOG.md) | Histórico completo de versões |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | Como contribuir com o projeto |

---

## Links Úteis

- 📘 [Help Center Sankhya](https://ajuda.sankhya.com.br/) — Fonte indexada
- 🔧 [Sankhya — Site oficial](https://www.sankhya.com.br/) — ERP de origem
- 📦 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) — Especificação do protocolo
- 🤖 [Claude Desktop](https://claude.ai/download) · [Claude Code](https://claude.com/claude-code)
- 🛠 [Cursor](https://cursor.com/) · [VS Code Copilot](https://github.com/features/copilot)
- 🚀 [OpenAI Responses API com MCP](https://platform.openai.com/docs/guides/tools-remote-mcp)
- 🧠 [pgvector](https://github.com/pgvector/pgvector) — Vector similarity search no Postgres
- ⚡ [vLLM](https://github.com/vllm-project/vllm) — High-throughput LLM inference engine
- 🏢 [Skills IT](https://www.skillsit.com.br) — Nossa empresa

---

## Licença

[MIT](./LICENSE) — © 2026 Skills IT — Soluções em Tecnologia

---

<div align="center">

**Construído com 🛠 por [Skills IT](https://www.skillsit.com.br)**

🌐 [www.skillsit.com.br](https://www.skillsit.com.br) · 📱 (63) 3224-4925 (WhatsApp/Telefone) · 📍 Palmas — TO — Brasil

*Este MCP é desenvolvido e mantido pela Skills IT como contribuição à comunidade brasileira do Sankhya.*

</div>
