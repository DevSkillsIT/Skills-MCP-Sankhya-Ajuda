<!--
  Sankhya Ajuda MCP — Deploy Guide
  Skills IT — Soluções em Tecnologia
  https://www.skillsit.com.br  ·  (63) 3224-4925  ·  Palmas-TO-Brasil
-->

# Deploy Guide

Este projeto suporta **dois caminhos de deploy oficialmente** — escolha o que melhor casa com sua infra. Ambos chegam ao mesmo resultado funcional.

| Path | Quando usar |
|---|---|
| **[A. Docker Compose](#path-a-docker)** | Você quer começar rápido / não tem Postgres local / quer isolamento total |
| **[B. Native (PM2)](#path-b-native--pm2)** | Você já tem Postgres+pgvector instalado / prefere processo nativo / produção Skills IT |

> Decida **antes** qual `EMBEDDING_PROVIDER` vai usar — `vllm`, `openai` ou `none`. O banco precisa estar indexado com o mesmo modelo que você vai consultar. Detalhes em [`EMBEDDINGS-PROVIDER.md`](./EMBEDDINGS-PROVIDER.md).

---

## Pré-requisitos comuns

| Item | Versão mínima | Observação |
|---|---|---|
| Sistema | Linux x86_64 | Testado em Ubuntu 22.04+ e Debian 12 |
| RAM | 1 GB | 4 GB+ se for rodar vLLM containerizado |
| Disco | 5 GB | + ~10 GB se for rodar vLLM (modelo Qwen3) |
| Conta OpenAI **OU** vLLM | qualquer | Necessário para indexar com embeddings semânticos |

---

## Path A — Docker

### Requisitos

- Docker 24+
- Docker Compose v2 (built-in: `docker compose version`)
- Opcional: NVIDIA Container Toolkit (`nvidia-docker2`) se for usar o profile `gpu`

### Passo 1 — Clonar e preparar `.env`

```bash
git clone https://github.com/skillsit/sankhya-ajuda-mcp.git
cd sankhya-ajuda-mcp

cp .env.example .env
```

Edite `.env` e configure no mínimo:

```env
PG_PASSWORD=$(openssl rand -base64 32)
MCP_AUTH_TOKEN=sk-sankhya-ajuda-$(openssl rand -hex 32)
EMBEDDING_PROVIDER=openai
OPENAI_API_KEY=sk-proj-...
```

### Passo 2 — Subir Postgres + MCP

```bash
docker compose up -d
```

Compose vai:
1. Subir o container `sankhya-ajuda-postgres` (pgvector/pgvector:pg17).
2. Executar `sql/schema.sql` no primeiro start (cria tabelas + extensions).
3. Buildar a imagem do MCP e subir `sankhya-ajuda-mcp` na porta 3105.

Verifique:

```bash
docker compose ps
docker compose logs mcp-server --tail 20
curl http://localhost:3105/health | jq
```

Esperado:
```json
{
  "status": "ok",
  "articles_count": 0,
  "with_embedding_count": 0,
  "last_sync_status": "never"
}
```

### Passo 3 — Indexar o help center (primeira vez)

A ETL roda **sob demanda**, não em loop. Use `docker compose run` para rodar uma vez:

```bash
docker compose run --rm etl sankhya-sync
```

Tempo estimado: **5-15 minutos** dependendo do provider de embeddings e latência de rede.

Quando terminar:

```bash
curl http://localhost:3105/health | jq
# "articles_count": 6123, "with_embedding_count": 6123, "last_sync_status": "ok"
```

### Passo 4 — Agendar sync diário (cron do host)

Adicione ao cron do host (não no container — ETL é batch):

```bash
sudo crontab -e
```

```cron
# Sankhya Ajuda — sync diário às 03:00
0 3 * * * cd /opt/sankhya-ajuda-mcp && /usr/bin/docker compose run --rm etl sankhya-sync >> /var/log/sankhya-ajuda-sync.log 2>&1
```

### Profile `gpu` (opcional, com vLLM containerizado)

Se você tem GPU NVIDIA com `nvidia-docker2` instalado:

```bash
# .env: trocar para vllm
EMBEDDING_PROVIDER=vllm
VLLM_BASE_URL=http://vllm:8000/v1
HF_TOKEN=hf_...     # se Qwen3 precisar de token

docker compose --profile gpu up -d
```

O container `sankhya-ajuda-vllm` baixa o modelo (~9 GB) na primeira execução. Depois disso a ETL deve ser re-rodada para reindexar com Qwen3 (o guardrail vai detectar e bloquear semantic search até a reindexação).

### Operação diária com Docker

| Tarefa | Comando |
|---|---|
| Ver status | `docker compose ps` |
| Logs do MCP | `docker compose logs -f mcp-server` |
| Reiniciar MCP | `docker compose restart mcp-server` |
| Re-rodar ETL | `docker compose run --rm etl sankhya-sync` |
| Atualizar versão | `git pull && docker compose pull && docker compose up -d` |
| Backup do banco | `docker compose exec postgres pg_dump -U sankhya_ajuda sankhya_ajuda > backup.sql` |
| Destruir tudo (cuidado) | `docker compose down -v` |

---

## Path B — Native + PM2

Para quando você **já tem PostgreSQL** rodando no host (ou em rede acessível) e quer gerenciar o MCP com PM2 — esse é o setup Skills IT em produção.

### Requisitos

- Python 3.13
- Node.js 22 LTS
- PostgreSQL 15+ com `pgvector`, `unaccent` e `pg_trgm` instaláveis
- PM2 (`npm install -g pm2`)
- Acesso root para `setup_db.sh` (cria role + extensions)

### Passo 1 — Clonar e configurar

```bash
git clone https://github.com/skillsit/sankhya-ajuda-mcp.git
cd sankhya-ajuda-mcp
cp .env.example .env
$EDITOR .env
```

### Passo 2 — Banco de dados

```bash
sudo ./scripts/setup_db.sh
```

O script cria a role `sankhya_ajuda`, o database `sankhya_ajuda`, e habilita extensions `vector`, `unaccent`, `pg_trgm`.

### Passo 3 — Fase 1 (ETL Python)

```bash
python3.13 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"

# Primeira sincronização (~10 min)
sankhya-sync
```

Validar:
```bash
psql -h localhost -p 5433 -U sankhya_ajuda -d sankhya_ajuda \
  -c "SELECT COUNT(*), COUNT(embedding) FROM articles;"
# Esperado: 6123 | 6123 (se EMBEDDING_PROVIDER ≠ none)
```

### Passo 4 — Cron diário

```bash
sudo cp scripts/sankhya_ajuda_sync.cron      /etc/cron.d/sankhya-ajuda-sync
sudo cp scripts/sankhya_ajuda_sync.logrotate /etc/logrotate.d/sankhya-ajuda-sync
```

### Passo 5 — Fase 2 (MCP Server TypeScript)

```bash
cd mcp-server
cp .env.example .env
$EDITOR .env   # alinhe MCP_AUTH_TOKEN, PG_*, EMBEDDING_PROVIDER, etc.

npm install
npm run build

# Subir via PM2
pm2 start ecosystem.http.config.cjs
pm2 save                                # persiste para autostart
pm2 logs mcp-sankhya-ajuda --lines 20
```

Validar:
```bash
curl http://localhost:3105/health | jq
```

### Passo 6 — Habilitar autostart no boot (uma vez)

```bash
pm2 startup systemd                 # gera comando — copie e execute
# `sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u root --hp /root`
pm2 save
```

### Operação diária no modo Native

| Tarefa | Comando |
|---|---|
| Status MCP | `pm2 status mcp-sankhya-ajuda` |
| Logs MCP | `pm2 logs mcp-sankhya-ajuda --lines 50` |
| Restart MCP | `pm2 restart mcp-sankhya-ajuda` |
| Re-rodar ETL manualmente | `source .venv/bin/activate && sankhya-sync` |
| Atualizar código | `git pull && cd mcp-server && npm install && npm run build && pm2 restart mcp-sankhya-ajuda` |
| Backup banco | `pg_dump -h localhost -p 5433 -U sankhya_ajuda sankhya_ajuda > backup.sql` |

---

## Conectar clientes MCP

Independente do path escolhido, o endpoint é o mesmo: **`http://<host>:3105/mcp`** com header `Authorization: Bearer ${MCP_AUTH_TOKEN}`.

O servidor é **agnóstico ao cliente** — funciona com qualquer aplicação compatível com **MCP 2025-11-25 Streamable HTTP**: Claude Desktop, Claude Code, Cursor, VS Code Copilot, ChatGPT (via OpenAI Responses API ou Custom Connectors no plano Enterprise/Team), Continue.dev, Cline, Zed e outros.

### Padrão de configuração (vale para a maioria dos clientes)

```json
{
  "mcpServers": {
    "sankhya-ajuda": {
      "type": "http",
      "url": "http://127.0.0.1:3105/mcp",
      "headers": { "Authorization": "Bearer SEU_TOKEN" }
    }
  }
}
```

VS Code Copilot usa a chave `servers` em vez de `mcpServers`. OpenAI Responses API usa o parâmetro `tools=[{type:"mcp", ...}]` na chamada da API.

📖 **Exemplos detalhados por cliente** (Claude Desktop, Claude Code, Cursor, VS Code, OpenAI Responses API com Python/curl, ChatGPT Enterprise) em [`../README.md#configuração-nos-clientes-mcp`](../README.md#configuração-nos-clientes-mcp).

### Onde o cliente roda

| Cenário | URL | Pré-requisitos |
|---|---|---|
| Mesma VM | `http://127.0.0.1:3105/mcp` | Nada — já funciona |
| Outra VM na LAN/VPN | `http://<ip-do-host>:3105/mcp` | `MCP_HOST=0.0.0.0` (default) + firewall liberando 3105 |
| Internet pública | `https://<seu-dominio>/mcp` | Reverse proxy (Caddy/Nginx) + TLS (Let's Encrypt / `acme.sh`) |

> **Importante:** cada cliente carrega apenas o **token Bearer** no seu config local — nunca copie o `.env` completo do servidor (ele contém `PG_PASSWORD`, `VLLM_API_KEY`, etc.). O Bearer é segredo independente, rotacionável.

---

## Troubleshooting rápido

| Sintoma | Diagnóstico | Solução |
|---|---|---|
| `connection refused` em :3105 | MCP não subiu | Docker: `docker compose logs mcp-server`. PM2: `pm2 logs mcp-sankhya-ajuda` |
| `401 unauthorized` | Token errado ou ausente | Confirme `MCP_AUTH_TOKEN` igual em `.env` e no client |
| `503 degraded` no /health | Postgres down ou inacessível | `docker compose ps postgres` ou `pg_isready` no host |
| `mode=keyword (index mismatch)` | Provider trocado sem reindex | Reindexe com `sankhya-sync` ou volte ao provider correto. Ver [`EMBEDDINGS-PROVIDER.md`](./EMBEDDINGS-PROVIDER.md) |
| `EMBEDDING_UNAVAILABLE` em semantic | vLLM/OpenAI fora do ar | Logs do provider. Use `mode=keyword` enquanto isso |
| 100 requests demoram 20s cada | Múltiplos clientes na mesma sessão | Use sessões distintas por cliente (`initialize` por worker) |

---

## Suporte

Implementação e suporte: **[Skills IT — Soluções em Tecnologia](https://www.skillsit.com.br)**

- 🌐 [www.skillsit.com.br](https://www.skillsit.com.br)
- 📱 (63) 3224-4925 — WhatsApp / Telefone
- 📍 Palmas — TO — Brasil

Issues técnicas: abra um issue no GitHub (após publicação) ou contate diretamente.
