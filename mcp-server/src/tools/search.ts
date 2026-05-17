/**
 * sankhya_ajuda_search_articles — hybrid (RRF) / semantic / keyword search.
 *
 * Branching per RF07 / CC-03:
 *   mode=keyword  -> NEVER calls EmbeddingClient.embed (verified by QG07)
 *   mode=semantic -> vLLM down -> EMBEDDING_UNAVAILABLE structured error
 *   mode=hybrid   -> vLLM down -> keyword_fallback (NEVER OpenAI cross-model)
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { hybridSearch } from '../db.js';
import { EmbeddingError } from '../embeddings.js';
import {
  createSuccessResponse,
  createErrorResponse,
  McpResponseTooLargeError,
} from './base.js';
import { formatToolResponse } from '../formatters/response-formatter.js';
import type { ToolContext } from './working-index.js';
import type { SearchMode, SearchModeReported, SearchHit } from '../types.js';
import '../formatters/entity.js';

const TOOL_NAME = 'sankhya_ajuda_search_articles';

const TOOL_DESCRIPTION =
  'Artigos de ajuda, documentacao, FAQ e manuais do ERP Sankhya — busca ' +
  'hibrida combinando similaridade semantica (pgvector + halfvec 2560d) e ' +
  'FTS PT-BR com unaccent sobre 6.123 artigos do help center oficial Sankhya ' +
  '(ajuda.sankhya.com.br). Use quando o usuario descrever duvida, erro ou ' +
  'topico do Sankhya. Retorna tabela Markdown paginada com titulo, ' +
  'breadcrumb, URL e score.';

const inputSchema = {
  query: z
    .string()
    .min(1, 'query nao pode ser vazia')
    .max(500, 'query maxima de 500 caracteres')
    .describe('Texto livre da consulta do usuario sobre o Sankhya'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(25)
    .default(10)
    .describe('Quantidade maxima de resultados na resposta (1-25, default 10)'),
  category_id: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe('Filtra por uma das 14 categorias do Sankhya (use sankhya_ajuda_list_categories)'),
  include_outdated: z
    .boolean()
    .default(false)
    .describe('Se true, inclui artigos marcados como obsoletos pelo time Sankhya'),
  mode: z
    .enum(['hybrid', 'semantic', 'keyword'])
    .default('hybrid')
    .describe('Estrategia de busca: hibrido (RRF), so semantico ou so keyword'),
};

export function registerSearchTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Buscar artigos de ajuda do Sankhya',
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
          limit: typeof rawArgs.limit === 'number' ? rawArgs.limit : 10,
          category_id:
            typeof rawArgs.category_id === 'number' ? rawArgs.category_id : null,
          include_outdated:
            typeof rawArgs.include_outdated === 'boolean'
              ? rawArgs.include_outdated
              : false,
          mode: (typeof rawArgs.mode === 'string' ? rawArgs.mode : 'hybrid') as SearchMode,
        };

        const result = await runSearch(ctx, args);
        if ('isError' in result) {
          return createErrorResponse(
            stripErrorCode(result.markdown),
            'EMBEDDING_UNAVAILABLE',
          );
        }
        const markdown = formatToolResponse(TOOL_NAME, result, rawArgs);
        return createSuccessResponse(markdown);
      } catch (err) {
        if (err instanceof McpResponseTooLargeError) {
          return createErrorResponse(err.message, 'RESPONSE_TOO_LARGE');
        }
        const msg = err instanceof Error ? err.message : String(err);
        return createErrorResponse(
          `Erro inesperado na busca. Esperado: banco e vLLM disponiveis. ` +
            `Sugestao: tente novamente ou troque para mode=keyword. Detalhe: ${msg}`,
          'INTERNAL_ERROR',
        );
      }
    },
  );
}

function stripErrorCode(markdown: string): string {
  return markdown.replace(/^\*\*\[[A-Z_]+\]\*\*\s*/, '');
}

interface SearchArgs {
  query: string;
  limit: number;
  category_id: number | null;
  include_outdated: boolean;
  mode: SearchMode;
}

interface RunSearchOutput {
  hits: SearchHit[];
  query: string;
  limit: number;
  includeOutdated: boolean;
  modeUsed: SearchModeReported;
}

/** Exported for direct unit testing (bypasses MCP transport). */
export async function runSearch(
  ctx: ToolContext,
  args: SearchArgs,
): Promise<RunSearchOutput | { isError: true; markdown: string }> {
  const { pool, embedding } = ctx;
  const { query, limit, category_id, include_outdated, mode } = args;
  const indexCompatible = ctx.indexCompatible !== false;

  if (ctx.embeddingProvider === 'none' && mode !== 'keyword') {
    const hits = await hybridSearch(pool, {
      query,
      qvec: null,
      limit,
      categoryId: category_id,
      includeOutdated: include_outdated,
      mode: 'keyword',
    });
    return {
      hits,
      query,
      limit,
      includeOutdated: include_outdated,
      modeUsed: 'keyword_fallback',
    };
  }

  // Guardrail v1.5.4: index/provider mismatch -> force keyword for any
  // non-keyword mode. Prevents silent semantic corruption (SPEC RF07/AD-003).
  if (!indexCompatible && mode !== 'keyword') {
    const hits = await hybridSearch(pool, {
      query,
      qvec: null,
      limit,
      categoryId: category_id,
      includeOutdated: include_outdated,
      mode: 'keyword',
    });
    return {
      hits,
      query,
      limit,
      includeOutdated: include_outdated,
      modeUsed: 'keyword_index_mismatch',
    };
  }

  if (mode === 'keyword') {
    const hits = await hybridSearch(pool, {
      query,
      qvec: null,
      limit,
      categoryId: category_id,
      includeOutdated: include_outdated,
      mode: 'keyword',
    });
    return {
      hits,
      query,
      limit,
      includeOutdated: include_outdated,
      modeUsed: 'keyword',
    };
  }

  if (mode === 'semantic') {
    let qvec: number[];
    try {
      qvec = await embedding.embed(query);
    } catch (err) {
      if (err instanceof EmbeddingError) {
        // RF07: NO silent fallback for mode=semantic.
        const message =
          'Servico de embeddings indisponivel para busca semantica. ' +
          'Esperado: vLLM responsivo. ' +
          'Sugestao: tente novamente em alguns minutos ou use mode=keyword.';
        return {
          isError: true,
          markdown: `**[EMBEDDING_UNAVAILABLE]** ${message}`,
        };
      }
      throw err;
    }
    const hits = await hybridSearch(pool, {
      query,
      qvec,
      limit,
      categoryId: category_id,
      includeOutdated: include_outdated,
      mode: 'semantic',
    });
    return {
      hits,
      query,
      limit,
      includeOutdated: include_outdated,
      modeUsed: 'semantic',
    };
  }

  // mode === 'hybrid'
  let qvec: number[] | null = null;
  try {
    qvec = await embedding.embed(query);
  } catch (err) {
    if (err instanceof EmbeddingError) {
      // RF07: hybrid degrades to keyword_fallback. Never OpenAI cross-model.
      const hits = await hybridSearch(pool, {
        query,
        qvec: null,
        limit,
        categoryId: category_id,
        includeOutdated: include_outdated,
        mode: 'keyword',
      });
      return {
        hits,
        query,
        limit,
        includeOutdated: include_outdated,
        modeUsed: 'keyword_fallback',
      };
    }
    throw err;
  }

  const hits = await hybridSearch(pool, {
    query,
    qvec,
    limit,
    categoryId: category_id,
    includeOutdated: include_outdated,
    mode: 'hybrid',
  });
  return {
    hits,
    query,
    limit,
    includeOutdated: include_outdated,
    modeUsed: 'hybrid',
  };
}
