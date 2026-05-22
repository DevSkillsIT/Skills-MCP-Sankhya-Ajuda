/**
 * sankhya_ajuda_search_knowledge_unified — unified source-aware search (help + community).
 *
 * Degradation strategy (mirrors runSearch from search.ts, but simpler — no semantic-only path):
 *   embeddingProvider='none' OR indexCompatible=false → degraded=true → keyword-only for BOTH sources.
 *   Otherwise → embed query ONCE via ctx.embedding.embed():
 *     EmbeddingError thrown → keyword-only fallback for BOTH sources (never EMBEDDING_UNAVAILABLE).
 *     Success → mode='hybrid' with qvec for BOTH sources.
 *
 * This tool NEVER exposes mode='semantic' and NEVER returns EMBEDDING_UNAVAILABLE.
 *
 * @MX:NOTE: [AUTO] Degradation + threshold logic:
 *   Two-level degradation: (1) provider='none' or indexCompatible=false bypasses embed entirely;
 *   (2) EmbeddingError at runtime falls back to keyword-only for both corpora.
 *   COMMUNITY_DIST_THRESHOLD (default 0.45) is read from env and forwarded to hybridSearch and
 *   hybridSearchCommunity as distThreshold. The threshold is only applied inside the semantic CTE
 *   in the DB layer (C5); in keyword/degraded mode it is ignored by the DB.
 * @MX:SPEC: SPEC-SANKHYA-COMMUNITY-001 C4, C5, RF01
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { hybridSearch, hybridSearchCommunity } from '../db.js';
import { EmbeddingError } from '../embeddings.js';
import {
  createSuccessResponse,
  createErrorResponse,
  createInternalErrorResponse,
  checkResponseSize,
  McpResponseTooLargeError,
} from './base.js';
import type { ToolContext } from './working-index.js';
import type { UnifiedHit, SearchHit, CommunityHit } from '../types.js';
import { crossSourceRRF, dedupCommunityByTitle } from '../search/rrf.js';
import { escapeMarkdown, truncate } from '../utils/html-stripper.js';

const TOOL_NAME = 'sankhya_ajuda_search_knowledge_unified';

// Description: 280-400 chars, "Sankhya" ≥2x, key noun FIRST, routing hint included.
// Verified length: 396 chars, 2× "Sankhya".
const TOOL_DESCRIPTION =
  'Base de conhecimento do Sankhya unificada — busca artigos da Central de Ajuda e posts da ' +
  'comunidade (fórum) do Sankhya numa consulta, com ranking RRF que mistura as fontes e ' +
  'rotula cada item (oficial vs comunidade). Use para dúvidas, erros, mensagens de erro, how-to ' +
  'e discussões. Para documentação oficial com filtro de categoria/modo, use ' +
  'sankhya_ajuda_search_articles. Retorna tabela Markdown.';

// RRF constant — matches intra-source k used by hybridSearch and hybridSearchCommunity.
const RRF_K = 60;

// CHANGE 1 (v1.1.0): internalPerSource = Math.max(20, limit) so that for limit up to 50
// each source contributes enough candidates for the cross-source RRF to fill the requested
// limit with well-ranked results (not pad with lower-ranked leftovers from a fixed 20-cap).
// The final result is still sliced to limit before returning.
function internalFetchLimit(limit: number): number {
  return Math.max(20, limit);
}

/** Read COMMUNITY_DIST_THRESHOLD from env once at module load (C5). Default 0.45. */
function readDistThreshold(): number {
  const raw = process.env['COMMUNITY_DIST_THRESHOLD'];
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return 0.45;
}

const DIST_THRESHOLD = readDistThreshold();

const inputSchema = {
  query: z
    .string()
    .min(1, 'query não pode ser vazia')
    .max(500, 'query máxima de 500 caracteres')
    .describe('Texto livre da consulta do usuário sobre o Sankhya'),
  source: z
    .enum(['help', 'community', 'all'])
    .default('all')
    .describe('Fonte de busca: help (Central de Ajuda), community (fórum), ou all (ambas com RRF)'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(15)
    .describe('Quantidade máxima de resultados na resposta (1-50, default 15)'),
  include_outdated: z
    .boolean()
    .default(false)
    .describe('Se true, inclui artigos obsoletos do help (ignorado para community)'),
};

// R4: max display lengths for table columns (preserve meaning, never truncate URLs).
const TITLE_MAX_CHARS = 90;
const CONTEXT_MAX_CHARS = 70;

/** Map a SearchHit (help source) to UnifiedHit with 1-indexed sourceRank. */
function helpHitToUnified(hit: SearchHit, sourceRank: number): UnifiedHit {
  return {
    source: 'help',
    isOfficial: true,
    id: String(hit.id),
    title: hit.title,
    context: hit.breadcrumb ?? null,
    url: hit.html_url,
    sourceRank,
    rrfScore: 1 / (RRF_K + sourceRank),
    similarity: hit.similarity ?? null,
  };
}

/** Map a CommunityHit to UnifiedHit with 1-indexed sourceRank (post-dedup position). */
function communityHitToUnified(hit: CommunityHit, sourceRank: number): UnifiedHit {
  return {
    source: 'community',
    isOfficial: false,
    id: hit.id,
    title: hit.title,
    context: hit.context ?? null,
    url: hit.url,
    sourceRank,
    rrfScore: 1 / (RRF_K + sourceRank),
    similarity: hit.similarity ?? null,
  };
}

/**
 * Format a list of UnifiedHits as Markdown table per RF01.8 (updated).
 *
 * Columns (R2): # | Fonte | Oficial | ID | Título | Contexto | Similaridade | URL
 * # (R11): 1-indexed RRF rank — the monotonic, authoritative ordering anchor.
 *   Added so a weak model has an unambiguous numeric rank to sort by, instead
 *   of latching onto the non-monotonic Similaridade column.
 * Similaridade (R3): cosine similarity (0.000–1.000) or "—" in keyword mode.
 *   NOTE: label changed Score→Similaridade (R10) because the value is cosine
 *   similarity from 1-(embedding<=>qvec), NOT a rank or relevance percent.
 *   Hybrid RRF ranking makes this column non-monotonic with row order, so the
 *   label "Similaridade" plus the explicit # rank prevent reading it as a rank.
 * Truncation (R4): Título ≤ 90 chars, Contexto ≤ 70 chars. URL never truncated.
 */
function formatUnifiedMarkdown(hits: UnifiedHit[]): string {
  if (hits.length === 0) {
    return 'Nenhum resultado encontrado.';
  }

  const headers = ['#', 'Fonte', 'Oficial', 'ID', 'Título', 'Contexto', 'Similaridade', 'URL'];
  const lines: string[] = [];

  // R10/R11: rows are already in RRF rank order (best match first), exposed in the
  // monotonic "#" column. The Similaridade column is the raw cosine per item and is
  // NON-monotonic with row order, so a weak model must rank by "#"/ROW ORDER, never
  // by the cosine value.
  lines.push(
    '_Ordenado por relevância: a coluna # é o rank autoritativo (1 = melhor match). ' +
      'A coluna Similaridade é o cosseno cru de cada item e NÃO acompanha a ordem; ' +
      'use o # / a ordem, não o valor de Similaridade._',
  );
  lines.push('');
  lines.push('| ' + headers.join(' | ') + ' |');
  lines.push('|' + headers.map(() => '---|').join(''));

  let rank = 0;
  for (const hit of hits) {
    rank += 1;
    const fonte = hit.source === 'help' ? 'HELP' : 'COMUNIDADE';
    const oficial = hit.isOfficial ? 'Sim' : 'Não';
    const id = escapeMarkdown(hit.id);
    // R4: truncate title and context; never truncate URL.
    const titulo = escapeMarkdown(truncate(hit.title, TITLE_MAX_CHARS));
    const contexto = hit.context ? escapeMarkdown(truncate(hit.context, CONTEXT_MAX_CHARS)) : '—';
    // R3: similarity as Similaridade (0.000–1.000) or "—" in keyword/degraded mode.
    const score = hit.similarity !== null ? hit.similarity.toFixed(3) : '—';
    // URL must NEVER be truncated (the post id is at the end of the slug).
    const url = escapeMarkdown(hit.url);

    lines.push(
      `| ${rank} | ${fonte} | ${oficial} | ${id} | ${titulo} | ${contexto} | ${score} | ${url} |`,
    );
  }

  return lines.join('\n');
}

export function registerSearchUnifiedTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Busca unificada (Ajuda + Comunidade) no Sankhya',
      description: TOOL_DESCRIPTION,
      inputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (rawArgs) => {
      try {
        const args = {
          query: String(rawArgs.query),
          source: (typeof rawArgs.source === 'string' ? rawArgs.source : 'all') as
            | 'help'
            | 'community'
            | 'all',
          limit: typeof rawArgs.limit === 'number' ? rawArgs.limit : 15,
          include_outdated:
            typeof rawArgs.include_outdated === 'boolean' ? rawArgs.include_outdated : false,
        };

        const hits = await runUnifiedSearch(ctx, args);
        const markdown = formatUnifiedMarkdown(hits);

        // Enforce 400KB cap before returning.
        checkResponseSize(markdown);

        return createSuccessResponse(markdown);
      } catch (err) {
        if (err instanceof McpResponseTooLargeError) {
          return createErrorResponse(err.message, 'RESPONSE_TOO_LARGE');
        }
        return createInternalErrorResponse(
          err,
          `Erro inesperado na busca unificada. Esperado: banco e serviço de embeddings disponíveis. ` +
            `Sugestão: tente novamente ou reduza o limit.`,
        );
      }
    },
  );
}

interface UnifiedSearchArgs {
  query: string;
  source: 'help' | 'community' | 'all';
  limit: number;
  include_outdated: boolean;
}

/**
 * Core search logic — exported for direct unit testing (bypasses MCP transport).
 *
 * Degradation mirrors search.ts runSearch but without the semantic-only path:
 *   degraded=true  → qvec=null, mode='keyword' for both sources (no embed call).
 *   degraded=false → embed query; on EmbeddingError → keyword fallback for both;
 *                    on success → mode='hybrid' with qvec for both.
 */
export async function runUnifiedSearch(
  ctx: ToolContext,
  args: UnifiedSearchArgs,
): Promise<UnifiedHit[]> {
  const { pool, embedding } = ctx;
  const { query, source, limit, include_outdated } = args;

  // Determine degradation state (mirrors runSearch from search.ts).
  const degraded =
    ctx.embeddingProvider === 'none' || ctx.indexCompatible === false;

  let qvec: number[] | null = null;
  let mode: 'hybrid' | 'keyword' = 'keyword';

  if (!degraded) {
    try {
      qvec = await embedding.embed(query);
      mode = 'hybrid';
    } catch (err) {
      if (err instanceof EmbeddingError) {
        // Keyword fallback for both sources — never EMBEDDING_UNAVAILABLE.
        qvec = null;
        mode = 'keyword';
      } else {
        throw err;
      }
    }
  }

  // distThreshold only applies in hybrid mode's semantic CTE (C5).
  // In keyword mode the DB layer ignores it.
  const distThreshold = DIST_THRESHOLD;

  if (source === 'help') {
    const helpHits = await hybridSearch(pool, {
      query,
      qvec,
      limit,
      categoryId: null,
      includeOutdated: include_outdated,
      mode,
      distThreshold,
    });
    return helpHits.map((hit, i) => helpHitToUnified(hit, i + 1));
  }

  if (source === 'community') {
    const commHits = await hybridSearchCommunity(pool, {
      query,
      qvec,
      limit,
      mode,
      distThreshold,
    });
    const deduped = dedupCommunityByTitle(commHits);
    return deduped.map((hit, i) => communityHitToUnified(hit, i + 1));
  }

  // source === 'all': fetch from both sources in parallel, then RRF + slice.
  // CHANGE 1 (v1.1.0): use internalFetchLimit(limit) instead of a fixed 20 so that
  // for limit up to 50 each source contributes enough candidates for the RRF merge.
  const perSource = internalFetchLimit(limit);
  const [rawHelp, rawComm] = await Promise.all([
    hybridSearch(pool, {
      query,
      qvec,
      limit: perSource,
      categoryId: null,
      includeOutdated: include_outdated,
      mode,
      distThreshold,
    }),
    hybridSearchCommunity(pool, {
      query,
      qvec,
      limit: perSource,
      mode,
      distThreshold,
    }),
  ]);

  const dedupedComm = dedupCommunityByTitle(rawComm);
  const fused = crossSourceRRF(rawHelp, dedupedComm, RRF_K);
  return fused.slice(0, limit);
}
