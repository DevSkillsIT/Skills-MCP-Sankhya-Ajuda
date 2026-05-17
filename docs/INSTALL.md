<!--
  Sankhya Ajuda MCP — Skills IT — Soluções em Tecnologia
  https://www.skillsit.com.br  ·  (63) 3224-4925  ·  Palmas - TO - Brasil
-->

# Guia de Instalação — Para Leigos

Este documento explica como instalar e rodar o **Sankhya Ajuda MCP**. Escolha o cenário que melhor descreve sua situação.

> O servidor é **agnóstico ao cliente MCP** — funciona com qualquer cliente compatível com MCP 2025-11-25 Streamable HTTP (Claude Desktop, Claude Code, Cursor, VS Code Copilot, ChatGPT via OpenAI Responses API, Continue.dev, Cline, Zed e outros). Veja exemplos de configuração para cada um em [`../README.md#configuração-nos-clientes-mcp`](../README.md#configuração-nos-clientes-mcp).

---

## Cenário 1: "Quero testar rapidamente sem instalar nada"

**Para você se**: Você quer ver como o MCP funciona em 5 minutos, sem GPU, sem banco de dados pré-existente.

**O que vai precisar**:
- Docker Desktop (Windows, Mac) ou Docker + Docker Compose (Linux)
  - **Download**: https://www.docker.com/products/docker-desktop/
  - **Verificar**: Abra terminal, rode `docker --version` → deve mostrar versão

**Passo-a-passo**:

1. Clone o repositório
   ```bash
   git clone https://github.com/skillsit/sankhya-ajuda-mcp.git
   cd sankhya-ajuda-mcp
   ```

2. Configure o arquivo `.env` (variáveis de ambiente — "configurações secretas")
   ```bash
   cp .env.example .env
   ```
   
   Abra o `.env` em um editor de texto (Notepad, VS Code, etc.) e:
   - Deixe `EMBEDDING_PROVIDER=none` (sem IA local, apenas busca por palavras-chave)
   - **OU** se você tiver uma chave OpenAI:
     - Troque `EMBEDDING_PROVIDER=none` para `EMBEDDING_PROVIDER=openai`
     - Preencha `OPENAI_API_KEY=sk-...` (sua chave da OpenAI)
   
   Para gerar o token de segurança (`MCP_AUTH_TOKEN`), abra o terminal:
   ```bash
   # Linux/Mac
   openssl rand -hex 32
   
   # Windows (PowerShell)
   [System.Convert]::ToHexString((1..32 | ForEach-Object { [byte](Get-Random -Max 256) }))
   ```
   Copie o resultado (ex: `a1b2c3d4...`) e cole na linha `MCP_AUTH_TOKEN=` do `.env`.

3. Suba os containers (Postgres + MCP)
   ```bash
   docker compose up -d
   ```
   
   **O que acontece**:
   - Docker baixa as imagens (~3 GB, leva alguns minutos)
   - Sobe um container PostgreSQL (banco de dados)
   - Sobe o servidor MCP na porta 3105
   
   **Verificar**: Após 30s, rode:
   ```bash
   curl http://localhost:3105/health
   ```
   Se aparecer algo como `{"status":"ok",...}`, está funcionando ✅

4. Carregue a base de dados (6.123 artigos do Sankhya)
   ```bash
   docker compose run --rm etl sankhya-sync
   ```
   
   **O que esperar**:
   - "Baixando artigos do Zendesk..." (2-5 minutos)
   - "Indexando no banco..." (depende de `EMBEDDING_PROVIDER`)
   - Ao final: `✓ Sync completed: 6123 articles indexed`

5. Conecte um cliente MCP

   Este servidor MCP funciona com **qualquer cliente compatível com MCP 2025-11-25 Streamable HTTP**:
   Claude Desktop, Claude Code, Cursor, VS Code Copilot, ChatGPT via OpenAI Responses API,
   Continue.dev, Cline, Zed, e outros.

   Padrão de configuração (vale para todos):

   ```json
   {
     "mcpServers": {
       "sankhya-ajuda": {
         "type": "http",
         "url": "http://127.0.0.1:3105/mcp",
         "headers": {
           "Authorization": "Bearer COLE_SEU_MCP_AUTH_TOKEN_AQUI"
         }
       }
     }
   }
   ```

   **Onde colocar este JSON** (varia por cliente):

   | Cliente | Caminho |
   |---|---|
   | Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
   | Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
   | Claude Code | `.mcp.json` na raiz do projeto ou `~/.claude/.mcp.json` |
   | Cursor | `~/.cursor/mcp.json` |
   | VS Code Copilot | `.vscode/mcp.json` no workspace (chave `servers` em vez de `mcpServers`) |
   | ChatGPT Enterprise/Team | Painel admin → Custom Connectors → Remote MCP Server |
   | OpenAI Responses API | Parâmetro `tools=[{type:"mcp", ...}]` na chamada da API |

   📖 **Exemplos completos por cliente** em [`../README.md#configuração-nos-clientes-mcp`](../README.md#configuração-nos-clientes-mcp)
   (inclui exemplos Python e curl para OpenAI Responses API).

   Após adicionar o config, **reinicie o cliente**. As tools `sankhya_ajuda_*` aparecerão automaticamente.

**Para parar**:
```bash
docker compose down
```

---

## Cenário 2: "Já tenho PostgreSQL rodando — quero production-ready"

**Para você se**: Você tem PostgreSQL 16+ com pgvector instalado, e quer usar PM2 para gerenciar o serviço como um daemon (background) em um servidor real.

**Pré-requisitos**:
- PostgreSQL 16+ rodando em algum lugar (local ou remoto)
- pgvector extension instalada (como verificar: `psql -d meubanco -c "CREATE EXTENSION IF NOT EXISTS vector;"`
- Node.js 22 LTS (download em https://nodejs.org)
- Python 3.13+ (download em https://www.python.org)
- PM2 instalado globalmente: `npm install -g pm2`

**Passo-a-passo**:

1. Clone o repositório
   ```bash
   git clone https://github.com/skillsit/sankhya-ajuda-mcp.git
   cd sankhya-ajuda-mcp
   ```

2. Configure o Postgres e crie o banco (uma única vez)
   ```bash
   # Crie o banco e a role (se não existir)
   psql -U seu_user_admin -h seu_postgres_host -c "
     CREATE ROLE sankhya_ajuda WITH LOGIN PASSWORD 'senha_segura';
     CREATE DATABASE sankhya_ajuda OWNER sankhya_ajuda;
   "
   
   # Instale as extensões necessárias
   psql -U seu_user_admin -d sankhya_ajuda -c "
     CREATE EXTENSION IF NOT EXISTS vector;
     CREATE EXTENSION IF NOT EXISTS pg_trgm;
     CREATE EXTENSION IF NOT EXISTS unaccent;
   "
   
   # Carregue o schema (uma única vez)
   psql -U sankhya_ajuda -d sankhya_ajuda -f sql/schema.sql
   ```

3. Configure Fase 1 (Python ETL)
   ```bash
   python3.13 -m venv .venv
   source .venv/bin/activate
   pip install -e ".[dev]"
   
   cp .env.example .env
   ```
   
   Edite `.env`:
   - `PG_HOST=seu_postgres_host`
   - `PG_USER=sankhya_ajuda`
   - `PG_PASSWORD=senha_que_voce_criou`
   - `EMBEDDING_PROVIDER=vllm` ou `openai` ou `none`
   - Se `openai`: preencha `OPENAI_API_KEY`
   - Se `vllm`: preencha `VLLM_BASE_URL` e `VLLM_API_KEY`

4. Rode a primeira indexação (Fase 1)
   ```bash
   .venv/bin/python -m sync.sync --full
   ```
   
   **Tempo**: 10-30 minutos (depende do `EMBEDDING_PROVIDER` e conexão com Zendesk)

5. Configure Fase 2 (Node.js MCP Server)
   ```bash
   cd mcp-server
   cp .env.example .env
   npm install
   npm run build
   ```
   
   Edite `.env` do mcp-server com os mesmos dados do Postgres.

6. Inicie com PM2 (para rodar 24/7)
   ```bash
   pm2 start ecosystem.http.config.cjs
   pm2 save
   pm2 startup
   ```
   
   **O que acontece**:
   - PM2 sobe o MCP em background
   - Após reboot, PM2 reinicia automaticamente
   - Logs salvos em `~/.pm2/logs/`

7. Verifique status
   ```bash
   pm2 status
   pm2 logs mcp-sankhya-ajuda --lines 20
   curl http://localhost:3105/health | jq .
   ```

8. (Opcional) Configure cron para sync diário
   ```bash
   # Abre o crontab
   crontab -e
   
   # Adicione a linha (para rodar daily @ 03:00):
   0 3 * * * cd /path/to/sankhya-ajuda-mcp && .venv/bin/python -m sync.sync >> /var/log/sankhya_ajuda_sync.log 2>&1
   ```

**Para parar**:
```bash
pm2 stop mcp-sankhya-ajuda
pm2 delete mcp-sankhya-ajuda
```

---

## Cenário 3: "Tenho GPU NVIDIA e quero rodar vLLM offline"

**Para você se**: Você tem GPU NVIDIA e quer embeddings locais (sem pagar OpenAI) usando vLLM containerizado.

**Pré-requisitos**:
- NVIDIA GPU (A100, L40, RTX 3090, etc.)
- Docker com nvidia-docker2 instalado
  - Verificar: `docker run --rm --gpus all nvidia/cuda:12.0-runtime nvidia-smi`

**Passo-a-passo**:

1. Clone e configure como no **Cenário 1**, mas:
   ```bash
   cp .env.example .env
   # Edite .env:
   EMBEDDING_PROVIDER=vllm
   VLLM_BASE_URL=http://vllm:8090/v1  # hostname do container vllm (não localhost)
   ```

2. Inicie com GPU profile:
   ```bash
   docker compose --profile gpu up -d
   ```
   
   **O que o Docker sobe**:
   - PostgreSQL (sem GPU)
   - vLLM container (com GPU)
   - MCP server
   
   **Tempo de boot**: 2-5 minutos (vLLM baixa o modelo Qwen3-4B, ~8 GB)

3. Verifique que vLLM está pronto:
   ```bash
   docker compose logs vllm | tail -20
   # Procure por: "Uvicorn running on http://0.0.0.0:8090"
   ```

4. Rode o sync (Fase 1):
   ```bash
   docker compose run --rm etl sankhya-sync
   ```
   
   **Nota**: Embeddings com vLLM são MUITO mais rápidos (10-30 seg para 6k artigos).

5. Conecte um cliente MCP como no Cenário 1 (instruções para Claude/Cursor/VS Code/ChatGPT no Passo 5 do Cenário 1).

**Notas**:
- vLLM usa VRAM (8GB por defaul, Qwen3-4B)
- Se a GPU ficar "fora de memória", reduza o batch size em `docker-compose.yml`
- Para usar GPU em outro servidor: mude `VLLM_BASE_URL=http://seu_servidor:8090/v1`

---

## Cenário 4: "Quero Produção Endurecida em VPS/Servidor Real"

**Para você se**: Você vai rodar isso 24/7 em um servidor VPS ou dedicado, com TLS/HTTPS, DNS, e backup automático.

Este é um setup avançado. Consulte [`docs/DEPLOY.md`](./DEPLOY.md) para instruções completas.

**Resumo rápido**:
- Instale Path B (PM2) + PostgreSQL backups
- Configure Caddy/Nginx com TLS via `acme.sh + dns_cpanel`
- Configure monitoring (Prometheus/Grafana ou Uptime Kuma)
- Teste failover (reiniciar container, verificar PM2 recovery)

---

## Cenário 5: "Quero apenas FTS, sem custo, sem GPU, sem OpenAI"

**Para você se**: Você não quer pagar OpenAI e não tem GPU. Quer apenas busca por palavras-chave (FTS).

**Passo-a-passo** (Cenário 1, mas com change):

1. Configure o `.env`:
   ```
   EMBEDDING_PROVIDER=none
   ```

2. Suba como no Cenário 1:
   ```bash
   docker compose up -d
   docker compose run --rm etl sankhya-sync
   ```

**Resultado**:
- Busca funciona por texto (ex: "como lançar nota fiscal")
- Não usa semântica (ex: "emissão de NF-e" pode não ser encontrado se não tiver os mesmos termos)
- Velocidade: muito rápido (PostgreSQL FTS é super otimizado)
- Custo: zero

**Quando usar**:
- ✅ Base de conhecimento pequena (< 10k artigos)
- ✅ Termos padronizados (ex: "estoque", "faturamento")
- ❌ Se espera encontrar sinonimos e conceitos relacionados

---

## Troubleshooting Rápido

### "Docker não consegue baixar imagens"
- Verifique conexão com internet
- Tente: `docker pull postgres:16` (deve funcionar)
- Se não: configure proxy em `~/.docker/config.json`

### "Postgres recusa conexão"
```bash
# Verifique se o container está rodando
docker ps | grep postgres

# Veja os logs
docker compose logs postgres --tail 20

# Reinicie
docker compose restart postgres
```

### "MCP health mostra 'articles_count: 0'"
- Sync ainda está rodando. Aguarde: `docker compose logs etl --tail 30`
- Ou rode manualmente: `docker compose run --rm etl sankhya-sync`

### "Cliente MCP não encontra as tools"

Vale para Claude Desktop, Claude Code, Cursor, VS Code Copilot, ChatGPT etc:

- Verifique que o config do cliente tem o token correto (compare com `MCP_AUTH_TOKEN=` do `.env`)
- Teste o servidor diretamente: `curl -H "Authorization: Bearer SEU_TOKEN" http://localhost:3105/health`
  → deve retornar `{"status":"ok",...}` (o `/health` em si não exige auth; este teste valida apenas conectividade)
- Para validar Bearer end-to-end, faça uma chamada `initialize` via `curl` (ver [`../README.md#testar-conexão`](../README.md#testar-conexão))
- Reinicie o cliente MCP após qualquer edição de config
- Em Claude Code, use `claude --debug "mcp"` para ver o handshake

### "Embeddings muito lentos com OpenAI"
- Normal (API OpenAI leva 1-2 sec por request)
- Para acelerar: use vLLM (Cenário 3) ou FTS only (Cenário 5)

---

## Próximas Leituras

- **Referência das tools**: [`docs/TOOLS.md`](./TOOLS.md)
- **Cenários práticos de uso**: [`docs/EXAMPLES.md`](./EXAMPLES.md)
- **Instalação detalhada / Deploy avançado**: [`docs/DEPLOY.md`](./DEPLOY.md)
- **Arquitetura técnica**: [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md)
- **Como escolher provider**: [`docs/EMBEDDINGS-PROVIDER.md`](./EMBEDDINGS-PROVIDER.md)
- **Operação/Monitoramento**: [`docs/OPERATIONS.md`](./OPERATIONS.md)

---

## Suporte

Se tiver dúvidas:
1. Procure em [`docs/OPERATIONS.md`](./OPERATIONS.md) seção "Troubleshooting"
2. Verifique os logs: `docker compose logs` ou `pm2 logs`
3. Abra uma issue no GitHub

---

**Construído por [Skills IT](https://www.skillsit.com.br) · Palmas — TO — Brasil**
