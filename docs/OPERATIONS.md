# Runbook de Operação

Práticas operacionais para o sync diário do `sankhya_ajuda`. Pressupõe acesso ao servidor com o container `postgres` rodando e ao caminho `/path/to/sankhya-ajuda-mcp/`.

---

## Monitoramento de rotina

### Health check rápido

```bash
docker exec postgres psql -U sankhya_ajuda -d sankhya_ajuda -c "
SELECT last_status, last_full_sync_at, last_article_count, last_changed_count,
       last_duration_sec, error_count, substring(last_error for 80) AS last_error
FROM sync_state;
"
```

Interpretação:

| `last_status` | Significado | Ação |
|---|---|---|
| `ok` | Último sync rodou inteiro sem exceção | Nenhuma |
| `running` | Cron está em execução agora | Aguardar; se >30 min, investigar |
| `error` | Exceção interrompeu o sync | Ver `last_error` e log |
| `interrupted` | SIGINT/SIGTERM | Provavelmente intervenção manual |
| `never` | Banco recém-criado | Esperar 03:00 ou rodar manual |

`error_count` é zerado a cada `ok`. Considera-se incidente quando `error_count >= 3` (três cron runs consecutivos falharam).

### Cobertura de dados

```bash
docker exec postgres psql -U sankhya_ajuda -d sankhya_ajuda -c "
SELECT
  (SELECT count(*) FROM articles) AS articles,
  (SELECT count(*) FROM articles WHERE embedding IS NOT NULL) AS with_embedding,
  (SELECT count(*) FROM articles WHERE breadcrumb IS NOT NULL) AS with_breadcrumb,
  (SELECT count(*) FROM articles WHERE outdated) AS outdated,
  (SELECT count(*) FROM skipped_articles) AS skipped_embeddings;
"
```

- `with_embedding < articles`: alguns artigos não foram vetorizados. Olhar `skipped_articles`.
- `with_breadcrumb < articles`: refresh do breadcrumb falhou (raro). Rodar `SELECT refresh_breadcrumbs()` via Python.
- `outdated > 0`: editores Sankhya marcaram conteúdo obsoleto — Fase 2 deve filtrar.

### Auditoria de artigos pulados

```bash
docker exec postgres psql -U sankhya_ajuda -d sankhya_ajuda -c "
SELECT article_id, substring(title for 60) AS title, reason, body_len, skipped_at
FROM skipped_articles
ORDER BY skipped_at DESC LIMIT 20;
"
```

`reason = 'context_length_exceeded'` significa que o `body_text` ficou maior que 8.000 chars (cap atual) e o vLLM rejeitou. O artigo continua no banco com `body_text` completo (FTS funciona); só falta o vetor.

---

## Comunidade (Bettermode)

A segunda fonte de conteúdo (`community.sankhya.com.br`, Bettermode) tem um sync **independente** do help center: cron próprio às **04:00**, estado próprio em `community_sync_state` e auditoria própria em `community_skipped_posts`. As métricas dos dois pipelines nunca se misturam.

### Health check do sync da comunidade

```bash
docker exec postgres psql -U sankhya_ajuda -d sankhya_ajuda -c "
SELECT last_status, last_full_sync_at, last_post_count, last_changed_count,
       last_duration_sec, error_count, substring(last_error for 80) AS last_error
FROM community_sync_state;
"
```

A coluna `last_status` segue a mesma semântica do help center (`ok`, `running`, `error`, `interrupted`, `never`) e `error_count` zera a cada `ok`. Incidente quando `error_count >= 3`.

### Cobertura de posts

```bash
docker exec postgres psql -U sankhya_ajuda -d sankhya_ajuda -c "
SELECT
  (SELECT count(*) FROM community_posts) AS posts,
  (SELECT count(*) FROM community_posts WHERE embedding IS NOT NULL) AS with_embedding,
  (SELECT count(*) FROM community_posts WHERE is_question) AS questions,
  (SELECT count(*) FROM community_posts WHERE has_accepted_answer) AS answered,
  (SELECT count(*) FROM community_spaces WHERE NOT private) AS public_spaces,
  (SELECT count(*) FROM community_skipped_posts) AS skipped_embeddings;
"
```

### Sync manual da comunidade

```bash
cd /path/to/sankhya-ajuda-mcp
.venv/bin/python -m sync.community_sync --full          # sync completo
.venv/bin/python -m sync.community_sync --space-id ID   # um único space (smoke test)
.venv/bin/python -m sync.community_sync --dry-run --limit 50  # sem escrever no banco
```

> O sync da comunidade tem um *change gate* barato: compara `lastActivityAt`/`updatedAt` de cada post com o valor armazenado e pula o fetch de respostas + embedding quando nada mudou. Na prática, só re-embeda threads com atividade nova.

---

## Comandos manuais

### Rodar sync completo agora

```bash
cd /path/to/sankhya-ajuda-mcp
.venv/bin/python -m sync.sync --full
```

### Re-sync apenas uma categoria

```bash
# IDs das categorias: SELECT id, name FROM categories;
.venv/bin/python -m sync.sync --category-id 360003118793  # Dúvidas Frequentes
```

### Dry-run para validar mudanças no código sem tocar no banco

```bash
.venv/bin/python -m sync.sync --dry-run --limit 50
```

### Forçar re-embedding total (após trocar modelo, por exemplo)

```bash
# Apaga o hash de todos os artigos; o próximo sync detecta "hash diferente"
# e regenera todos os embeddings.
docker exec postgres psql -U sankhya_ajuda -d sankhya_ajuda -c \
  "UPDATE articles SET body_hash = '';"
.venv/bin/python -m sync.sync --full
```

### Reset completo (cuidado: apaga tudo)

```bash
docker exec postgres psql -U sankhya_ajuda -d sankhya_ajuda -c "
TRUNCATE articles, sections, categories, skipped_articles RESTART IDENTITY CASCADE;
UPDATE sync_state SET last_status='never', last_article_count=0, last_changed_count=0,
       last_duration_sec=0, last_error=NULL, error_count=0, last_full_sync_at=NULL WHERE id=1;
"
.venv/bin/python -m sync.sync --full
```

---

## Troubleshooting

### vLLM retornando 401 Unauthorized

Sintoma no log: `embeddings.retry attempt=1 error="HTTP 401"` ou abort com `EmbeddingError: vLLM client error 401`.

Causas comuns:
1. `VLLM_API_KEY` ausente no `.env` (Bearer header não é setado).
2. API key configurada errada no servidor vLLM (`vllm.example.com`).
3. API key foi rotacionada e o `.env` está com a antiga.

Validar:
```bash
curl -s -X POST -H "Authorization: Bearer $(grep VLLM_API_KEY .env | cut -d= -f2)" \
  -H "Content-Type: application/json" \
  -d '{"input":"teste","model":"/model"}' \
  http://vllm.example.com:8090/v1/embeddings | head -c 200
```

Se retornar `{"error":"Unauthorized"}`, conferir a chave com quem mantém o vLLM.

### vLLM retornando 400 "maximum context length"

Sintoma: artigo aparece em `skipped_articles` com `reason='context_length_exceeded'`.

Causa: `body_text` excede 8.000 chars (limite atual de truncamento) e mesmo após o cap o tokenizer Qwen3 mapeia para >4.096 tokens.

Mitigações possíveis:

1. **Reduzir** `_MAX_EMBED_CHARS` em `src/sankhya_ajuda/embeddings.py` de 8000 para 6000.
2. **Chunking por seção** (Fase 3): partir o artigo em chunks de ~3000 chars e gerar múltiplos vetores. Requer mudança no schema (`article_chunks` table).
3. **Modelo de contexto maior**: configurar vLLM com outro modelo de embedding com janela ≥ 8192 tokens.

Estado atual no sync inicial: 0 artigos pulados (todos passaram com cap de 8000).

### Postgres inacessível

Sintoma: `psycopg.OperationalError: connection refused`.

```bash
# Container está up?
docker ps | grep postgres

# Logs do container
docker logs postgres --tail 30

# Conexão direta como superuser para diagnóstico
docker exec -it postgres psql -U sankhya_ajuda -d sankhya_ajuda
```

Se o container está parado, subir: `docker start postgres` (compose file deve estar em outro caminho do projeto host).

### Zendesk retornando 429 (rate limit)

O cliente já trata isso automaticamente — respeita o header `Retry-After`. Aparece no log como `zendesk.rate_limited retry_after=N`. Se for persistente (>30 min seguidos), aumentar `SANKHYA_HC_DELAY` no `.env` (default 0.3s entre páginas).

### Cron não disparou (help center 03:00 / comunidade 04:00)

```bash
# Cron está rodando?
service cron status

# Última execução (troque o filtro pelo job que está investigando)
grep CRON /var/log/syslog | grep sankhya_ajuda_sync           | tail -5  # help center
grep CRON /var/log/syslog | grep sankhya_ajuda_community_sync | tail -5  # comunidade

# Conferir entries
cat /etc/cron.d/sankhya_ajuda_sync            # help center @ 03:00
cat /etc/cron.d/sankhya_ajuda_community_sync  # comunidade  @ 04:00

# Logs de execução (vazio = não rodou)
ls -la /var/log/sankhya_ajuda_sync.log /var/log/sankhya_ajuda_community_sync.log
```

Se o cron rodou mas o log está vazio, o problema é no script (PATH, permissão na venv).

---

## Alertas recomendados (não implementados ainda)

Para um monitor externo (Prometheus / Grafana / cron com mail):

| Condição | Severidade | Ação sugerida |
|---|---|---|
| `error_count >= 3` | High | Investigar último_error; pode ser vLLM, Zendesk ou postgres |
| `last_full_sync_at < now() - 36h` | High | Cron não está rodando |
| `last_status = 'running' AND last_full_sync_at < now() - 30 min` | Medium | Sync travado |
| `last_duration_sec > 1800` (30 min) | Medium | Tendência de duração crescente — protege a janela de escalonamento dos crons (ver nota abaixo) |
| `skipped_articles` cresceu nas últimas 24h | Low | Conteúdo novo do Sankhya com artigos muito longos |
| `outdated > 50` na base | Low | Sankhya marcou muito conteúdo obsoleto; revisar |

> **Janela de escalonamento dos crons:** o help center roda às 03:00 e a comunidade às 04:00, com um `flock` compartilhado (`/var/lock/sankhya_ajuda_etl.lock`) que impede execução concorrente. Hoje o help center leva ~4-5 min (6.125 artigos). Se `last_duration_sec` em `sync_state` tender a subir (crescimento de corpus ou lentidão do Sankhya) e se aproximar de ~55 min, reavalie o horário da comunidade — o `flock` evita a sobreposição (o perdedor pula e se auto-recupera no dia seguinte, pois o sync é incremental), mas um atraso recorrente atrasaria a indexação da comunidade. Monitore `last_duration_sec` nas duas tabelas (`sync_state` e `community_sync_state`).

Query base de alerta:
```sql
SELECT
  CASE
    WHEN error_count >= 3 THEN 'CRITICAL: 3+ consecutive sync failures'
    WHEN last_full_sync_at < now() - interval '36 hours' THEN 'CRITICAL: sync stale > 36h'
    WHEN last_status = 'running' AND last_full_sync_at < now() - interval '30 minutes' THEN 'WARN: sync stuck'
    WHEN last_status = 'error' THEN 'WARN: last sync failed'
    ELSE 'OK'
  END AS alert
FROM sync_state;
```

---

## Logs

| Arquivo | Conteúdo |
|---|---|
| `/var/log/sankhya_ajuda_sync.log` | Output do cron diário do help center (03:00) |
| `/var/log/sankhya_ajuda_community_sync.log` | Output do cron diário da comunidade (04:00) |
| `/var/log/sankhya_ajuda_sync_initial.log` | Output do sync inicial manual (criado em 2026-05-15) |
| `/var/log/syslog` (filtrar `CRON`) | Lifecycle dos jobs pelo cron |

Rotação: weekly, mantém 4 semanas comprimidas. Cada job tem seu próprio config: `/etc/logrotate.d/sankhya_ajuda_sync` (help center) e `/etc/logrotate.d/sankhya_ajuda_community_sync` (comunidade).

Buscar eventos importantes no log:
```bash
grep -E "sync.done|sync.failed|sync.embed_too_long|sync.embed_failed" \
  /var/log/sankhya_ajuda_sync.log | tail -20
# Comunidade: troque o nome do evento e do arquivo
grep -E "community_sync.done|community_sync.failed" \
  /var/log/sankhya_ajuda_community_sync.log | tail -20
```

> **Falsos-positivos ao buscar "erro" no log:** um `grep -i "error\|exception\|erro"` cru
> retorna muitos resultados que **não são falhas de sync** — são *títulos* de artigos e posts
> que contêm essas palavras (ex: `"Unmarshalling Error: Not a number"`,
> `"java.security.cert.CertificateException..."`, `"Erro ao confirmar nota"`), logados em
> eventos `sync.article`/`community_sync.post` com `mode='skip'`. A saúde real do sync é dada
> **apenas** pelo evento final (`sync.done`/`community_sync.done` com `status='ok'`) e pela
> coluna `last_status` + `error_count` em `sync_state`/`community_sync_state`. Não interprete
> ocorrências da palavra "error" no corpo do log como incidentes.

---

## Recuperação de incidentes

### "Sync falhou ontem e a base está incompleta"

1. Verificar `last_status` e `last_error` em `sync_state`.
2. Resolver a causa (vLLM, postgres, rede).
3. Rodar `--full` manual — o sync é incremental por hash, então só re-embedda o que mudou ou faltou.
4. Validar com cobertura de embeddings.

### "Quero voltar ao estado anterior a uma mudança no schema"

1. Backup do database antes de qualquer migração: `docker exec postgres pg_dump -U sankhya_ajuda sankhya_ajuda > backup-$(date +%F).sql`.
2. Para restaurar: `docker exec -i postgres psql -U sankhya_ajuda -d sankhya_ajuda < backup-XXXX.sql`.
3. Schema é idempotente (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`), mas removendo colunas exige ALTER manual.

### "Suspeito que os embeddings estão ruins"

1. Confirmar modelo: `SELECT DISTINCT embedding_model FROM articles;` (deve ser `/model`, o Qwen3-embedding-4b).
2. Rodar smoke queries em `docs/ACCEPTANCE_REPORT.md` seção 4 e comparar distâncias.
3. Se distâncias mudaram drasticamente, vLLM pode ter trocado o modelo subjacente — falar com quem mantém o servidor.


---

<div align="center">

🌐 [www.skillsit.com.br](https://www.skillsit.com.br) · 📱 (63) 3224-4925 · 📍 Palmas — TO — Brasil

</div>
