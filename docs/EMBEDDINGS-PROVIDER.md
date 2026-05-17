<!--
  Sankhya Ajuda MCP — Embeddings Provider Decision Guide
  Skills IT — Soluções em Tecnologia
  https://www.skillsit.com.br  ·  (63) 3224-4925  ·  Palmas-TO-Brasil
-->

# Embeddings Provider Guide

Esta é provavelmente a **decisão de configuração mais importante** do projeto. Ler isto evita ranking semântico aleatório em produção.

## TL;DR

```
EMBEDDING_PROVIDER=openai   # cloud, paga por embedding mas sem GPU
EMBEDDING_PROVIDER=vllm     # local com GPU, latência baixa, custo zero
EMBEDDING_PROVIDER=none     # sem busca semântica, só keyword (FTS)
```

**Os 3 são mutuamente exclusivos.** Trocar exige re-rodar a ETL para reindexar o banco com o novo modelo.

---

## Por que provider e índice precisam casar (a parte importante)

Embeddings são vetores em **espaços vetoriais**. Cada modelo gera vetores num espaço próprio:

- `Qwen3-Embedding-4B` (vLLM) → vetor de 2560 dimensões no espaço Qwen
- `text-embedding-3-large` (OpenAI) → vetor de 2560 dimensões no espaço OpenAI

Esses dois espaços **não são compatíveis**. O cosine similarity entre eles é matematicamente computável, mas semanticamente é ruído.

### Demonstração empírica (medida 2026-05-16 em produção SkillsIT)

Mesma query (`"emissao de NF-e"`), banco indexado com Qwen3-4b, mesmo modo (`semantic`):

| Provider de query | Top-1 score | Top-1 título | Veredito |
|---|---|---|---|
| **vLLM** (consistente com banco) | **0.739** | "A empresa não está configurada como emissora de NF-e" | Relevante ✅ |
| **OpenAI** (cross-model) | **0.052** (14× pior) | "B.I.A - Business Intelligence Analyst" | Irrelevante ❌ |

Os outros top-N são igualmente ruins: "Assistente de Filtros", "Configuração da Estrutura de Metas/Orçamentos" — nada a ver com NF-e.

---

## O guardrail v1.5.4

O servidor **detecta automaticamente** este tipo de mismatch e protege você.

### Como funciona

No boot, o MCP lê:
```sql
SELECT DISTINCT embedding_model FROM articles WHERE embedding IS NOT NULL;
```

Compara com `EMBEDDING_PROVIDER` configurado:

- **Match (compatible)**: log `info` confirmando alinhamento. Busca normal.
- **Mismatch**: log `warn` com instruções de remediação. `ToolContext.indexCompatible = false`. Qualquer `mode=hybrid|semantic` é **forçado a degradar** para `mode=keyword` com label visível `keyword (index mismatch: provider != modelo do banco)` no Markdown de resposta.

### Como aparece em log

```json
{"level":"warn","msg":"mcp-sankhya-ajuda index/provider mismatch — semantic/hybrid will degrade to keyword","provider":"openai","expectedModel":"text-embedding-3-large","dbModels":["/model"],"reason":"Index foi populado com [/model] mas EMBEDDING_PROVIDER=openai usaria queries do modelo \"text-embedding-3-large\"..."}
```

### Como aparece no Markdown da tool

```
**10 resultados** | top-10 mostrados | modo: keyword (index mismatch: provider != modelo do banco)

| ID | Titulo | Breadcrumb | Score | URL |
| ... |
```

O score é `ts_rank_cd` (FTS), não cosine — você sabe que o ranking semântico não foi usado.

---

## Como escolher provider

### Use `vllm` se...

- Você tem GPU NVIDIA com ≥ 8 GB VRAM
- Quer **custo zero** após o setup inicial
- Latência precisa ser **baixa** (≤ 100 ms por embedding)
- Aceita gerenciar uma dependência adicional (servidor vLLM)
- Volume alto de queries (milhares/dia)

**Setup recomendado:**
- vLLM externo: você rodando `vllm serve Qwen/Qwen3-Embedding-4B` numa máquina com GPU
- vLLM containerizado: `docker compose --profile gpu up -d` (requer `nvidia-docker2`)

### Use `openai` se...

- Não tem GPU local
- Volume baixo/médio (custo OpenAI ≈ $0.13 / 1M tokens em `text-embedding-3-large`; reindexar 6.123 artigos custa ~$0.03)
- Quer deploy **simples** — só uma API key
- Aceita dependência externa de cloud paga
- Latência de ~300 ms é aceitável

### Use `none` se...

- Está só testando o MCP, não precisa de qualidade de ranking
- Quer rodar **sem custo** e **sem GPU**
- FTS PT-BR (com `unaccent` + `pg_trgm`) já é suficiente para seu caso
- Volume é minúsculo, ou os termos buscados são exatos (códigos de erro, nomes técnicos)

Neste modo, qualquer `mode=hybrid|semantic` degrada para keyword automaticamente sem warning de mismatch (provider é deliberadamente "ausente").

---

## Como migrar entre providers

Trocar provider **exige re-indexar o banco** — o guardrail vai bloquear semantic search até isso ser feito.

### Migração `vllm` → `openai` (ou vice-versa)

```bash
# 1. Editar .env
$EDITOR .env
# EMBEDDING_PROVIDER=openai
# OPENAI_API_KEY=sk-...

# 2. Limpar embeddings antigos (mantém artigos, zera coluna embedding)
psql -h localhost -p 5433 -U sankhya_ajuda -d sankhya_ajuda <<SQL
UPDATE articles SET embedding = NULL, embedding_model = NULL;
DELETE FROM sync_state;
INSERT INTO sync_state (id) VALUES (1);
SQL

# 3. Reindexar com o novo provider
#    Docker:
docker compose run --rm etl sankhya-sync
#    Native:
sankhya-sync

# 4. Restart o MCP para revalidar compatibility
docker compose restart mcp-server   # ou: pm2 restart mcp-sankhya-ajuda

# 5. Confirmar no health/log
docker compose logs mcp-server | grep "index/provider"
# Esperado: {"level":"info","msg":"mcp-sankhya-ajuda index/provider compatible"...}
```

### Migração para `none`

```bash
$EDITOR .env
# EMBEDDING_PROVIDER=none

docker compose restart mcp-server
```

Não precisa reindexar — o banco fica como está, e o MCP ignora a coluna `embedding`.

---

## Custos comparativos (referência)

| Provider | Custo de indexar 6.123 artigos | Custo por busca | Latência |
|---|---|---|---|
| `vllm` (local) | Eletricidade da GPU | Eletricidade | 30-80 ms |
| `openai` | ~$0.03 (1×) | ~$0.00001 / query | 250-400 ms |
| `none` | $0 | $0 | 5-15 ms |

> Valores `openai` baseados em `text-embedding-3-large` em 2026-05. Confira preços atualizados em [openai.com/api/pricing](https://openai.com/api/pricing/).

---

## Decisão arquitetural formal

Esta decisão está registrada como **AD-005** em [`SPEC-SANKHYA-AJUDA-001/spec.md`](../.moai/specs/SPEC-SANKHYA-AJUDA-001/spec.md), juntamente com o histórico de versões:

- **v1.5.3** — Toggle `EMBEDDING_PROVIDER` introduzido (substitui AD-003 "OpenAI inerte")
- **v1.5.4** — Guardrail runtime adicionado após sugestão convergente de revisores (Codex/GLM/Gemini)

---

<div align="center">

🌐 [www.skillsit.com.br](https://www.skillsit.com.br) · 📱 (63) 3224-4925 · 📍 Palmas — TO — Brasil

</div>
