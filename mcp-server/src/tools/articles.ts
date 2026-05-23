/**
 * sankhya_ajuda_get_article_details — single article in Markdown.
 *
 * Constraints (CI-04):
 *   article_id: int >= 1
 *   max_body_chars: int [100, 20000] (default 6000)
 *
 * NOT_FOUND -> 3-part error response.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getArticleFull } from '../db.js';
import {
  createSuccessResponse,
  createErrorResponse,
  createInternalErrorResponse,
  errorNotFound,
  McpResponseTooLargeError,
} from './base.js';
import { formatToolResponse } from '../formatters/response-formatter.js';
import type { ToolContext } from './working-index.js';
import '../formatters/entity.js';

const TOOL_NAME = 'sankhya_ajuda_get_article_details';

const TOOL_DESCRIPTION =
  'Artigo completo da base de ajuda Sankhya — recupera titulo, breadcrumb ' +
  'hierarquico (categoria > secao > subsecao), corpo limpo (HTML removido), ' +
  'URL original em ajuda.sankhya.com.br, autor, tags, datas e flag de ' +
  'obsolescencia. Use quando ja tiver o article_id retornado por uma busca ' +
  'no Sankhya. Retorna Markdown formatado, consulta somente leitura.';

const inputSchema = {
  article_id: z
    .number()
    .int()
    .min(1, 'article_id deve ser um BIGINT positivo do Zendesk')
    .describe('ID BIGINT do artigo Sankhya retornado por uma busca anterior'),
  max_body_chars: z
    .number()
    .int()
    .min(100, 'max_body_chars minimo: 100')
    .max(40000, 'max_body_chars maximo: 40000')
    .default(8000)
    .describe(
      'Limite de caracteres do corpo do artigo. Range 100-40000, default 8000. ' +
        'Empirico no banco Sankhya: default 8000 cobre 92% dos artigos completos ' +
        '(P90=7.144 chars), 15000 cobre 96%, 40000 cobre 99% (P99=40.435). ' +
        'Subir so quando o usuario pedir analise profunda.',
    ),
};

export function registerArticleTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Detalhes do artigo do Sankhya',
      description: TOOL_DESCRIPTION,
      inputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (rawArgs) => {
      try {
        const articleId = Number(rawArgs.article_id);
        const maxBodyChars =
          typeof rawArgs.max_body_chars === 'number' ? rawArgs.max_body_chars : 8000;

        const article = await getArticleFull(ctx.pool, articleId, maxBodyChars);
        if (!article) {
          return errorNotFound(
            'Artigo',
            articleId,
            'use sankhya_ajuda_search_knowledge_unified para descobrir IDs validos',
          );
        }

        const markdown = formatToolResponse(
          TOOL_NAME,
          { article, maxBodyChars },
          rawArgs,
        );
        return createSuccessResponse(markdown);
      } catch (err) {
        if (err instanceof McpResponseTooLargeError) {
          return createErrorResponse(err.message, 'RESPONSE_TOO_LARGE');
        }
        return createInternalErrorResponse(
          err,
          `Erro ao carregar artigo. Esperado: banco disponivel. ` +
            `Sugestao: tente novamente.`,
        );
      }
    },
  );
}
