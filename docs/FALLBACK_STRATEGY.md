# Fallback Strategy

How `sankhya_ajuda` degrades when the embedding service is unavailable.

**Version**: v1.5.3+ com toggle `EMBEDDING_PROVIDER` (veja seção "Providers Mutuamente Exclusivos" abaixo).

The strategy applies to two distinct execution paths with very different cost
profiles and recovery semantics:

| Path | When | Failure cost |
|---|---|---|
| **Sync (ETL)** | Daily cron @ 03:00 | Cron alerts; can re-run next day |
| **Search (MCP server, Phase 2)** | Live, per user query | User-visible latency / error |

## Providers Mutuamente Exclusivos (v1.5.3+)

A partir da v1.5.3, `EMBEDDING_PROVIDER` é uma **escolha de deployment**, não um fallback em runtime:

```
EMBEDDING_PROVIDER (env) ∈ { vllm, openai, none }
    ↓
Escolha UMA:
  1. vllm    → vLLM local (Qwen3-Embedding-4B 2560d) — default SkillsIT
  2. openai  → OpenAI Cloud (text-embedding-3-large @ 2560) — adapter pago
  3. none    → Sem embeddings; força mode=keyword (FTS only)
    ↓
Banco precisa estar indexado com O MESMO modelo
```

**NÃO há fallback automático entre providers** (cross-model é matematicamente inválido — ver AD-005 em SPEC-SANKHYA-AJUDA-001).

### Por que o schema pgvector permanece igual entre providers

Ambos Qwen3-embedding-4b (vLLM padrão) e `text-embedding-3-large` (OpenAI)
suportam 2560 dimensões:

- Qwen3-embedding-4b retorna 2560 nativamente.
- `text-embedding-3-large` retorna 3072 por padrão mas aceita parâmetro `dimensions` —
  OpenAI trunca via Matryoshka representation learning, logo os primeiros 2560 floats
  permanecem significativos.

Schema é `HALFVEC(2560)` independentemente do provider. **Uma reindexação completa é
OBRIGATÓRIA quando trocar providers** (espaços vetoriais diferentes), porém o tipo de
coluna e todos os índices permanecem iguais.

## Phase 1 — Sync path (current behavior)

Implemented in `sync/sync.py:_sync_articles`.

```python
try:
    vector = await emb.embed(body_text)
except EmbeddingError as exc:
    log.error("sync.embed_failed", article_id=art["id"], error=str(exc))
    raise
```

**No fallback is intentional here**, for three reasons:

1. **Quality bar**: an article indexed without an embedding is invisible to
   the semantic search path. Better to fail loudly than silently degrade the
   corpus for a full day.
2. **Observability**: the cron exit code is non-zero on failure, which surfaces
   in `journalctl`, `/var/log/sankhya_ajuda_sync.log`, and bumps
   `sync_state.error_count`. Three consecutive failures should trigger an
   alert (left to operator monitoring).
3. **Cost predictability**: silently switching to a paid provider mid-ETL
   could rack up bills for a 6k-article reindex. Provider changes are
   explicit, never automatic.

What does retry: vLLM transient errors (5xx, 429, network timeouts) trigger
the in-client retry chain with full-jitter exponential backoff (max 3
attempts). Only after that does the sync abort.

## Phase 2 — Search path (Implementado em v1.5+)

Implementado em `mcp-server/src/tools/search.ts::sankhya_ajuda_search_articles` (TypeScript/Node).

### Fallback intra-provider (RF07 — Policy)

O fallback **ocorre DENTRO do mesmo provider**, nunca entre providers:

```
mode = hybrid (default):
  try: semantic search com pgvector (qualquer provider)
  except EmbeddingError: degrada para keyword-only FTS
  ↓
  Resultado: RRF (híbrido) ou FTS puro

mode = semantic:
  try: semantic search com pgvector
  except: retorna erro estruturado EMBEDDING_UNAVAILABLE
  ↓
  Sem fallback silencioso

mode = keyword:
  never calls embeddings
  sempre FTS puro
```

### Guardrail de compatibilidade index/provider (v1.5.4)

No boot, `checkIndexCompatibility()` em `index-compat.ts` valida:
- `articles.embedding_model` no banco (ex: "Qwen/Qwen3-Embedding-4B")
- vs `EMBEDDING_PROVIDER` em `.env` (ex: "vllm")

Se **mismatch** (banco Qwen3 + env OpenAI):
- Log: WARN estruturado
- `search.ts`: força `mode != keyword` a degradar para `keyword_index_mismatch`
- Resposta: Markdown com aviso "(⚠️ embedding index mismatch — using keyword fallback)"

**Motivo**: Evitar resultados silenciosamente ruins. Query "emissao de NF-e":
- Banco Qwen3 + query Qwen3: score top-1 = **0.739** (relevante) ✅
- Banco Qwen3 + query OpenAI: score top-1 = **0.052** (lixo matemático) ❌

## Environment surface (v1.5.3+)

Variable | Phase 1 | Phase 2 | Default | Notes
---|---|---|---|---
`EMBEDDING_PROVIDER` | no | **yes** | `vllm` | Toggle mutuamente exclusivo: vllm \| openai \| none
`VLLM_BASE_URL` | yes | yes | `http://vllm.example.com:8090/v1` | usado se `EMBEDDING_PROVIDER=vllm`
`VLLM_API_KEY` | yes | yes | — | Bearer auth para vLLM (se ativo)
`OPENAI_API_KEY` | — | yes | — | required se `EMBEDDING_PROVIDER=openai`
`OPENAI_MODEL` | — | yes | `text-embedding-3-large` | usado se `EMBEDDING_PROVIDER=openai`, com `dimensions=2560`

### Deprecated (v1.5.3+)

- `EMBEDDING_FALLBACK_OPENAI` ← **DEPRECATED**. Use `EMBEDDING_PROVIDER=openai` no lugar.

## Why FTS works at all

The `articles.tsv` column is already populated from `title` + `body_text` using
the `portuguese_unaccent` configuration (custom, defined in `schema.sql`).
Queries like `to_tsvector(...) @@ plainto_tsquery(...)` work without any
embedding; tested and confirmed at sync-test time.

Limitation: FTS misses vocabulary mismatches. The query *"como lançar nota"*
will not match an article titled *"emissão de NF-e"* unless they share tokens.
This is the cost of zero-cost fallback.

## Monitoring (recommended)

- `sync_state.error_count` — alert if `> 3` (three consecutive bad cron runs).
- `sync_state.last_status` — observe transitions away from `ok`.
- Embedding logs — track ratio of `embeddings.retry` events, indicates vLLM
  pressure before total failure.

## Notas históricas

Esta seção continha "open questions" sobre fallback automático OpenAI per-query
vs batched, e sobre um shadow embedding set OpenAI offline. **Ambas resolvidas
em v1.5.3** com a decisão arquitetural AD-005:

- Não há fallback automático cross-model em runtime — provider é escolhido por
  deploy via `EMBEDDING_PROVIDER` (mutuamente exclusivo).
- Shadow embedding set continua tecnicamente possível como projeto futuro (job
  batch offline populando uma coluna `embedding_openai halfvec(2560)`), mas
  está fora do escopo v1.0 — não bloqueia o release.

Ver `SPEC-SANKHYA-AJUDA-001/spec.md` AD-005 para o registro formal.

---

<div align="center">

🌐 [www.skillsit.com.br](https://www.skillsit.com.br) · 📱 (63) 3224-4925 · 📍 Palmas — TO — Brasil

</div>
