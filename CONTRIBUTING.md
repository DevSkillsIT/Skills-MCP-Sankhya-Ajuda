<!--
  Sankhya Ajuda MCP — Contributing Guide
  Skills IT — Soluções em Tecnologia
  https://www.skillsit.com.br  ·  (63) 3224-4925  ·  Palmas-TO-Brasil
-->

# Contribuindo

Obrigado pelo interesse em contribuir!

## Antes de abrir um PR

1. **Discuta antes de implementar** mudanças grandes — abra uma issue descrevendo o caso de uso e a abordagem proposta.
2. **Mantenha o escopo pequeno** — um PR por motivação. Refactor + feature + fix no mesmo PR fica difícil de revisar.
3. **Não comite segredos**. O `.gitignore` cobre `.env`, mas confirme manualmente antes de cada push.

## Setup local

Siga o [`docs/DEPLOY.md`](./docs/DEPLOY.md), preferencialmente o **Path B (Native)** para desenvolvimento ativo — feedback loop mais rápido.

## Checklist antes do PR

### Para mudanças na Fase 1 (ETL Python)

```bash
source .venv/bin/activate
ruff check src/ sync/ tests/
ruff format --check src/ sync/ tests/
pyright src/ sync/
pytest -q
```

### Para mudanças na Fase 2 (MCP TypeScript)

```bash
cd mcp-server
npm run lint
npm run typecheck
npm test
npm run build
```

### Para mudanças que afetam dois lados (schema, etc.)

- Atualize `sql/schema.sql` E os testes que dependem dele
- Documente o impacto em `docs/SCHEMA.md`
- Bump na versão se for breaking change

## Convenções de commit

Usamos [Conventional Commits](https://www.conventionalcommits.org/):

- `feat(mcp): ...` — nova funcionalidade
- `fix(etl): ...` — bug fix
- `docs: ...` — só documentação
- `chore: ...` — manutenção (deps, build)
- `refactor: ...` — sem mudança de comportamento
- `test: ...` — só testes
- `perf: ...` — otimização

Mensagens em **inglês**. O corpo pode ser em português se for explicação detalhada.

## Estrutura do repositório

```
sankhya_ajuda/
├── src/sankhya_ajuda/   ← Fase 1 ETL — config, db, embeddings (Python)
├── sync/                ← Fase 1 ETL — scraper, parser, orchestrator
├── sql/                 ← Schema PostgreSQL
├── scripts/             ← setup_db.sh, cron, logrotate
├── tests/               ← Phase 1 tests (pytest)
├── mcp-server/          ← Fase 2 MCP — TypeScript code
│   ├── src/             ← server, db, embeddings, tools, transports
│   └── tests/           ← Phase 2 tests (vitest)
├── docs/                ← Documentação técnica
├── .moai/               ← SPEC + auditoria (interno)
├── docker-compose.yml   ← Orquestração Docker
├── Dockerfile.etl       ← Fase 1 Python image
└── pyproject.toml       ← Fase 1 Python metadata
```

## Onde alterar o quê (fonte da verdade da documentação)

Como o conjunto de docs ficou grande, mantenha **single source of truth** por tópico:

| Tópico | Fonte da verdade | Não duplicar em |
|---|---|---|
| Comportamento das tools (parâmetros, retorno, erros) | **Código** (`mcp-server/src/tools/*`) | docs replicam, não definem |
| Referência pública das tools/resources/prompts | **`docs/TOOLS.md`** | README apenas resume e linka |
| Cenários de uso por perfil | **`docs/EXAMPLES.md`** | README mostra 5 exemplos curtos e linka |
| Instalação passo-a-passo | **`docs/INSTALL.md`** | README mostra quickstart e linka |
| Schema do banco | **`sql/schema.sql`** + `docs/SCHEMA.md` | nunca duplicar DDL em outros .md |
| Política de fallback / providers | **`docs/EMBEDDINGS-PROVIDER.md`** + `docs/FALLBACK_STRATEGY.md` | outros docs linkam |
| Operação diária / monitoramento | **`docs/OPERATIONS.md`** | README mostra comandos essenciais e linka |
| Histórico de mudanças | **`CHANGELOG.md`** (raiz) | `mcp-server/CHANGELOG.md` é stub que aponta para a raiz |

**Regra prática:** mudou comportamento no código? Atualize `docs/TOOLS.md` **primeiro** (é a "API pública" da documentação). README e EXAMPLES só citam ou resumem.

Antes de abrir PR de doc, rode a checagem básica:

```bash
# Confirmar que cross-refs resolvem
grep -roE '\]\((\.\.?/[^)]+)\)' docs/ README.md mcp-server/README.md CONTRIBUTING.md \
  | awk -F: '{print $2}' \
  | grep -oE '\(.*\)' \
  | sed 's/[()]//g; s/#.*//' \
  | sort -u \
  | while read p; do
      [ -f "$p" ] || [ -f "docs/$p" ] || echo "BROKEN: $p";
    done
```

Para validar que docs ainda batem com o servidor após mudanças no código:

```bash
cd mcp-server
npm run typecheck
npm run lint
npm test
```

## Princípios de design

Estes são princípios que guiam mudanças no projeto:

1. **Read-only**: o MCP nunca grava no banco. A Fase 1 é a única fonte de escrita.
2. **Acoplamento mínimo**: Fase 1 ↔ Fase 2 conversam apenas via schema Postgres. Sem RPC, sem fila, sem cache compartilhado.
3. **Provider explícito**: nunca silencie um cross-model embedding. Vetores de modelos diferentes não devem produzir ranking. Veja [`docs/EMBEDDINGS-PROVIDER.md`](./docs/EMBEDDINGS-PROVIDER.md).
4. **Markdown sempre**: tools nunca retornam JSON cru. Há um interceptor central em `mcp-server/src/formatters/response-formatter.ts`.
5. **Errors em 3 partes**: `what happened` + `expected` + `actionable suggestion`. Veja `tools/base.ts:createErrorResponse`.
6. **Bearer constant-time**: comparação via `crypto.timingSafeEqual`, nunca `===`.

## Reportar bugs

Inclua:
- Versão (`git rev-parse HEAD` + `npm pkg get version` ou `python -c "import sankhya_ajuda; print(sankhya_ajuda.__version__)"`)
- Provider configurado (`echo $EMBEDDING_PROVIDER`)
- Output de `curl /health`
- Trecho relevante de log (sem credenciais)
- Reprodução mínima

## Contato

Suporte técnico e perguntas comerciais: **[Skills IT](https://www.skillsit.com.br)** · 📱 (63) 3224-4925 · 📍 Palmas-TO-Brasil
