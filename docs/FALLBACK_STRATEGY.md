<!--
  Sankhya Ajuda MCP — Estratégia de Fallback
  Skills IT — Soluções em Tecnologia
  https://www.skillsit.com.br  ·  (63) 3224-4925  ·  Palmas-TO-Brasil
-->

# Estratégia de Fallback

Como o `sankhya_ajuda` se comporta (degrada) quando o serviço de embeddings está indisponível.

**Versão**: v1.5.3+ com o toggle `EMBEDDING_PROVIDER` (veja a seção "Providers Mutuamente Exclusivos" abaixo).

A estratégia se aplica a dois caminhos de execução distintos, com perfis de custo e semântica de recuperação bem diferentes:

| Caminho | Quando | Custo da falha |
|---|---|---|
| **Sync (ETL)** | Cron diário @ 03:00 (help) / 04:00 (comunidade) | Alerta de cron; pode re-rodar no dia seguinte |
| **Busca (servidor MCP, Fase 2)** | Ao vivo, por consulta do usuário | Latência/erro visível ao usuário |

## Providers Mutuamente Exclusivos (v1.5.3+)

A partir da v1.5.3, `EMBEDDING_PROVIDER` é uma **escolha de deployment**, não um fallback em runtime:

```
EMBEDDING_PROVIDER (env) ∈ { vllm, openai, none }
    ↓
Escolha UMA:
  1. vllm    → vLLM local (Qwen3-Embedding-4B 2560d) — default Skills IT
  2. openai  → OpenAI Cloud (text-embedding-3-large @ 2560) — adapter pago
  3. none    → Sem embeddings; força mode=keyword (FTS only)
    ↓
O banco precisa estar indexado com O MESMO modelo
```

**NÃO há fallback automático entre providers** (cross-model é matematicamente inválido — ver AD-005 em SPEC-SANKHYA-AJUDA-001).

### Por que o schema pgvector permanece igual entre providers

Tanto o Qwen3-Embedding-4B (vLLM, padrão) quanto o `text-embedding-3-large` (OpenAI) suportam 2560 dimensões:

- Qwen3-Embedding-4B retorna 2560 nativamente.
- `text-embedding-3-large` retorna 3072 por padrão, mas aceita o parâmetro `dimensions` — a OpenAI trunca via Matryoshka representation learning, então os primeiros 2560 floats permanecem significativos.

O schema é `HALFVEC(2560)` independentemente do provider. **Uma reindexação completa é OBRIGATÓRIA ao trocar de provider** (espaços vetoriais diferentes), porém o tipo da coluna e todos os índices permanecem iguais.

## Fase 1 — Caminho de Sync (comportamento atual)

Implementado em `sync/sync.py:_sync_articles` (e espelhado em `sync/community_sync.py` para a comunidade).

```python
try:
    vector = await emb.embed(body_text)
except EmbeddingError as exc:
    log.error("sync.embed_failed", article_id=art["id"], error=str(exc))
    raise
```

**A ausência de fallback aqui é intencional**, por três motivos:

1. **Barra de qualidade**: um artigo indexado sem embedding fica invisível para a busca semântica. É melhor falhar de forma explícita do que degradar silenciosamente o corpus por um dia inteiro.
2. **Observabilidade**: o exit code do cron é diferente de zero em caso de falha, o que aparece no `journalctl`, em `/var/log/sankhya_ajuda_sync.log` e incrementa `sync_state.error_count`. Três falhas consecutivas devem disparar um alerta (a cargo do monitoramento do operador).
3. **Previsibilidade de custo**: trocar silenciosamente para um provider pago no meio do ETL poderia gerar custos altos numa reindexação de ~6 mil artigos. Mudanças de provider são explícitas, nunca automáticas.

O que **tem retry**: erros transitórios do vLLM (5xx, 429, timeouts de rede) disparam a cadeia de retry no cliente, com backoff exponencial full-jitter (máximo 3 tentativas). Só depois disso o sync aborta.

## Fase 2 — Caminho de Busca (implementado em v1.5+)

Implementado em `mcp-server/src/tools/search-unified.ts::sankhya_ajuda_search_knowledge_unified` (TypeScript/Node) desde v1.2.0. A política descrita abaixo aplica-se igualmente à `search.ts` (DISABLED em v1.2.0, source preservado) caso seja reativada.

### Fallback intra-provider (RF07 — política)

O fallback **ocorre DENTRO do mesmo provider**, nunca entre providers:

```
mode = hybrid (default):
  try: busca semântica com pgvector (qualquer provider)
  except EmbeddingError: degrada para keyword-only (FTS)
  ↓
  Resultado: RRF (híbrido) ou FTS puro

mode = semantic:
  try: busca semântica com pgvector
  except: retorna erro estruturado EMBEDDING_UNAVAILABLE
  ↓
  Sem fallback silencioso

mode = keyword:
  nunca chama embeddings
  sempre FTS puro
```

### Guardrail de compatibilidade índice/provider (v1.5.4)

No boot, o `checkIndexCompatibility()` em `index-compat.ts` valida:
- `articles.embedding_model` no banco (ex: "Qwen/Qwen3-Embedding-4B")
- vs `EMBEDDING_PROVIDER` no `.env` (ex: "vllm")

Se houver **mismatch** (banco Qwen3 + env OpenAI):
- Log: WARN estruturado
- `search.ts`: força `mode != keyword` a degradar para `keyword_index_mismatch`
- Resposta: Markdown com aviso "(⚠️ índice de embedding incompatível — usando fallback keyword)"

**Motivo**: evitar resultados silenciosamente ruins. Query "emissao de NF-e":
- Banco Qwen3 + query Qwen3: score top-1 = **0.739** (relevante) ✅
- Banco Qwen3 + query OpenAI: score top-1 = **0.052** (ruído matemático) ❌

## Variáveis de ambiente (v1.5.3+)

| Variável | Fase 1 | Fase 2 | Default | Observações |
|---|---|---|---|---|
| `EMBEDDING_PROVIDER` | não | **sim** | `vllm` | Toggle mutuamente exclusivo: vllm \| openai \| none |
| `VLLM_BASE_URL` | sim | sim | `http://vllm.example.com:8090/v1` | usado se `EMBEDDING_PROVIDER=vllm` |
| `VLLM_API_KEY` | sim | sim | — | Bearer auth para o vLLM (se ativo) |
| `OPENAI_API_KEY` | — | sim | — | obrigatório se `EMBEDDING_PROVIDER=openai` |
| `OPENAI_MODEL` | — | sim | `text-embedding-3-large` | usado se `EMBEDDING_PROVIDER=openai`, com `dimensions=2560` |

### Depreciado (v1.5.3+)

- `EMBEDDING_FALLBACK_OPENAI` ← **DEPRECIADO**. Use `EMBEDDING_PROVIDER=openai` no lugar.

## Por que o FTS funciona sem embeddings

A coluna `articles.tsv` já é populada a partir de `title` + `body_text` usando a configuração `portuguese_unaccent` (customizada, definida em `schema.sql`). Consultas como `to_tsvector(...) @@ plainto_tsquery(...)` funcionam sem nenhum embedding; testado e confirmado no momento do sync.

Limitação: o FTS não cobre divergências de vocabulário. A consulta *"como lançar nota"* não casa com um artigo intitulado *"emissão de NF-e"* a menos que compartilhem tokens. Esse é o custo do fallback de custo zero.

## Monitoramento (recomendado)

- `sync_state.error_count` — alerta se `> 3` (três execuções de cron ruins consecutivas).
- `sync_state.last_status` — observe transições para fora de `ok`.
- Logs de embedding — acompanhe a proporção de eventos `embeddings.retry`, que indicam pressão no vLLM antes da falha total.

## Notas históricas

Esta seção continha "open questions" sobre fallback automático para OpenAI por query vs. em lote, e sobre um shadow embedding set OpenAI offline. **Ambas resolvidas na v1.5.3** com a decisão arquitetural AD-005:

- Não há fallback automático cross-model em runtime — o provider é escolhido por deploy via `EMBEDDING_PROVIDER` (mutuamente exclusivo).
- O shadow embedding set continua tecnicamente possível como projeto futuro (um job batch offline populando uma coluna `embedding_openai halfvec(2560)`), mas está fora do escopo da v1.0 — não bloqueia o release.

Veja `SPEC-SANKHYA-AJUDA-001/spec.md` AD-005 para o registro formal.

---

<div align="center">

🌐 [www.skillsit.com.br](https://www.skillsit.com.br) · 📱 (63) 3224-4925 · 📍 Palmas — TO — Brasil

</div>
