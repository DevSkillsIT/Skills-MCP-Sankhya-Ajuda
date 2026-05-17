<!--
  Sankhya Ajuda MCP — CHANGELOG
  Skills IT — Soluções em Tecnologia
  https://www.skillsit.com.br  ·  (63) 3224-4925  ·  Palmas-TO-Brasil
-->

# Changelog — Sankhya Ajuda MCP

Todas as mudanças documentadas aqui.

Formato: [Keep a Changelog](https://keepachangelog.com/) · Versionamento: [Semantic](https://semver.org/)

---

## [Unreleased]

### Documentation refactor (2026-05-16)

Reescrita completa do conjunto de documentos para preparar publicação Open Source no GitHub
e remover viés de cliente MCP único. O servidor é **agnóstico** — funciona com Claude Desktop,
Claude Code, Cursor, VS Code Copilot, ChatGPT (OpenAI Responses API ou Custom Connectors) e
qualquer cliente compatível com MCP 2025-11-25 Streamable HTTP.

- `README.md` raiz reescrito no padrão estendido (índice navegável, multi-cliente, disclaimer
  expandido com contato Skills IT, troubleshooting, links úteis)
- **Novo** `docs/TOOLS.md` — referência completa das 8 tools + 6 resources + 4 prompts
  (parâmetros, defaults, limites, retorno, exemplos JSON-RPC, códigos de erro, capabilities)
- **Novo** `docs/EXAMPLES.md` — 20+ cenários práticos por perfil (suporte N1/N2, consultor,
  onboarding, análise técnica, comparativos, Reforma Tributária, uso programático Python/Node/curl,
  padrões anti-hallucination)
- `mcp-server/README.md` atualizado para multi-cliente
- `docs/INSTALL.md` — passo 5 reescrito para multi-cliente (tabela de caminhos por cliente)
- `docs/ARCHITECTURE.md` — de-bias e atualização da tabela de tools (parâmetros completos,
  capabilities MCP); status atualizado (Fase 2 completa)
- `docs/DEPLOY.md` — seção "Conectar clientes MCP" expandida com padrão universal e
  referência cruzada para exemplos por cliente

### Preparação para Open Source

- LICENSE (MIT), CONTRIBUTING.md com atribuição Skills IT
- Dockerfiles multi-stage (Python 3.13 ETL + Node 22 MCP)
- `docker-compose.yml` com profiles (default + gpu para vLLM)
- `docs/DEPLOY.md` com 2 paths (Docker + Native/PM2)
- `docs/INSTALL.md` com 5 cenários para leigos
- `docs/EMBEDDINGS-PROVIDER.md` consolidando AD-005 + evidência cross-model

---

## [1.5.6] — 2026-05-17 — Recalibração por Densidade do Corpus

### Changed — Fase 2 (MCP Server)
- `limit` default em `sankhya_ajuda_search_articles`: **10 → 15** (max: **25 → 50**)
  - Motivo: corpus de 6.123 artigos com 64% concentrado em 2 categorias (Solução de Problemas: 2.640; Documentação de Telas: 1.277). top-10 perdia nuance em queries densas; top-15 captura cluster relevante + variantes
  - Cap superior subiu para suportar análise comparativa profunda; ~8K tokens em top-50, cap 400KB folgado
  - Lost-in-the-middle controlado: top-15-25 é sweet spot para LLMs modernas
- `max_body_chars` default em `sankhya_ajuda_get_article_details`: **6000 → 8000**
  - Motivo: P90 = 7.144 chars; default 8000 cobre 92% dos artigos completos (vs 88% anterior)
  - Cap superior (40.000) mantido — P99 já coberto
- Prompts nomeados recalibrados:
  - `sankhya_troubleshoot`: limit **5 → 7** (mais margem para causas não-óbvias)
  - `sankhya_explain_module`: limit **5 → 10** (módulos densos como Pessoas+ tem 770 artigos)
  - `sankhya_quick_lookup`: mantém limit=3 (é "quick")

### Documentation
- README, TOOLS.md, ARCHITECTURE.md, mcp-server/README.md, EXAMPLES.md alinhados com novos defaults
- Server instructions atualizadas para refletir nova recomendação ("Use 5 para rápida, 25-50 para análise")
- Tabela de cobertura em TOOLS.md atualizada com nova linha P90

---

## [1.5.5] — 2026-05-16 — Calibração Empírica de Defaults

### Changed — Fase 2 (MCP Server)
- `limit` default em `sankhya_ajuda_search_articles`: **5 → 10**
  - Motivo: cap 400KB permite ~100k tokens; top-10 usa ~880 tokens (vs subutilização de top-5)
  - Distribuição real: P50=1.563, P75=3.046, P90=7.144, P95=12.661, P99=40.435, MAX=288.953 chars
- `max_body_chars` cap superior em `sankhya_ajuda_get_article_details`: **20.000 → 40.000**
  - Motivo: P99 = 40.435 chars; cap de 20k truncava 173 artigos sem opção do usuário
  - Default 6.000 mantido (cobre 88% dos artigos completos)

---

## [1.5.4] — 2026-05-16 — Cross-Model Guardrail

### Added — Fase 2 (MCP Server)
- **Guardrail de compatibilidade index/provider**
  - Boot: `checkIndexCompatibility()` valida `articles.embedding_model` vs `EMBEDDING_PROVIDER`
  - Mismatch (ex: banco Qwen3 + env OpenAI): logs WARN + `search.ts` força `keyword_index_mismatch`
  - Motivo: Evitar silenciosamente resultados ruins (query "emissao NF-e": score 0.739 OK vs 0.052 lixo cross-model)

---

## [1.5.3] — 2026-05-16 — EMBEDDING_PROVIDER Toggle

### Changed — BREAKING (Fase 1 + Fase 2)
- **Novo toggle** `EMBEDDING_PROVIDER` ∈ { `vllm`, `openai`, `none` }
  - Mutuamente exclusivos — banco precisa estar indexado com o MESMO modelo
  - Replaces deprecated `EMBEDDING_FALLBACK_OPENAI`
  - Motivo: Clientes sem vLLM precisam de provider alternativo; deixar inerte bloqueava deploys

### Removed
- `EMBEDDING_FALLBACK_OPENAI` (DEPRECATED, v1.5.3+)
  - Use `EMBEDDING_PROVIDER=openai` no lugar

---

## [1.5.2] — 2026-05-16 — Session Lifecycle (Gap 2)

### Added — Fase 2 (MCP Server)
- Session idle reaper periodico
  - `SESSION_IDLE_TIMEOUT_MS` (default 30 min, 0 = disabled)
  - `SESSION_CLEANUP_INTERVAL_MS` (default 60s)
  - `SessionEntry.lastActivityAt` atualizado em todo /mcp request
  - Previne memory growth em deploys h24

---

## [1.5.1] — 2026-05-16 — Second Vibe-Coding Roundpass

### Fixed — Fase 2 (MCP Server)
- Segunda passada de migração Python → TypeScript
  - 14 arquivos `tests/test_*.py` → `tests/*.test.ts` (vitest)
  - Snippets pytest → vitest (`beforeEach`, `vi.spyOn`)

---

## [1.5.0] — 2026-05-16 — Vibe-Coding-Ready

### Fixed — Fase 2 (MCP Server)
- Eliminados todos residuos Python das diretivas
  - Caminhos `src/*.py` → `mcp-server/src/*.ts`
  - Snippets Starlette → Express
  - Config FASTMCP → config.ts (Node)

---

## [1.4.0] — 2026-05-15 — Namespace Isolation

### Changed — BREAKING (Fase 2)
- **Renomeação para evitar colisão com futuro MCP Sankhya ERP**:
  - URIs: `sankhya://` → `sankhya-ajuda://` (6 URIs)
  - Tools: `sankhya_*` → `sankhya_ajuda_*` (8 tools)
  - Removed redundant `_help_` segment nos nomes
  - Permite futuro `sankhya-erp://` + `sankhya_erp_*` sem ambiguidade

---

## [1.3.0] — 2026-05-15 — Pivot para TypeScript

### Changed — MAJOR (Fase 2)
- **Python → TypeScript** (auditoria revelou todos MCPs nossos são TS)
  - MCP SDK TypeScript com `StreamableHTTPServerTransport`
  - Per-session `McpServer` + `randomUUID()` — padrão validado em omie-erp production
  - Fase 1 (ETL Python) mantida intacta (acoplamento APENAS via schema Postgres)

---

## [1.2.0] — 2026-05-15 — Multi-IA Consolidation V2

### Fixed
- CC-01: resumo AC08 reescrito (removido "Fallback vLLM→OpenAI→FTS")
- CI-01: RNF01 (FastMCP → TypeScript SDK em v1.3.0)
- CI-02: Risco 2 (removido "Fallback automático para OpenAI")

---

## [1.1.0] — 2026-05-15 — Multi-IA Consolidation V1

### Changed — Fase 2 SPEC
- CC-04: política fallback unificada por mode em RF07
- CI-08: `a.outdated` no SELECT de RF06
- ENV03: OpenAI como adapter, não fallback runtime

---

## [1.0.0] — 2026-05-15 — Initial Release (Fases 1 + 2 Spec)

### Added — Phase 1 (Python ETL — já em produção)
- Zendesk API (público) → BeautifulSoup → PostgreSQL + pgvector
- 6.123 artigos indexados, FTS `portuguese_unaccent`
- Sync diário @ 03:00 com SHA256 change detection
- 14 categorias, 230 seções, embeddings Qwen3 2560d

### Added — Phase 2 (MCP Server — TypeScript v1.5.5+)
- Node.js 22 LTS + TypeScript 5 (strict)
- MCP SDK ≥1.18 com Streamable HTTP em `:3105/mcp`
- Bearer auth via `crypto.timingSafeEqual`
- `/health` público + OAuth 404
- 8 tools (4 domain + 4 bridge), 6 resources, 4 prompts
- Busca híbrida: RRF (k=60) pgvector + FTS PT-BR
- Fallback intra-provider (RF07): hybrid→keyword, semantic→error, keyword→keyword
- Guardrail cross-model (v1.5.4): detecta mismatch embedding_model vs provider
- 3 providers: `vllm` (local), `openai` (cloud), `none` (FTS only)
- Response cap 400KB, server instructions ≤2000 chars

---

**Construído por [Skills IT](https://www.skillsit.com.br) · Palmas-TO-Brasil**
