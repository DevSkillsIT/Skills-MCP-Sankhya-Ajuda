/**
 * sankhya_ajuda_list_categories — 14 top-level categories of the Sankhya help center.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listCategories } from '../db.js';
import {
  createSuccessResponse,
  createErrorResponse,
  McpResponseTooLargeError,
} from './base.js';
import { formatToolResponse } from '../formatters/response-formatter.js';
import type { ToolContext } from './working-index.js';
import '../formatters/entity.js';

const TOOL_NAME = 'sankhya_ajuda_list_categories';

const TOOL_DESCRIPTION =
  'Categorias da base de conhecimento Sankhya — lista as 14 categorias ' +
  'top-level do help center do ERP Sankhya (Documentacao de Telas, Pessoas+, ' +
  'Reforma Tributaria, Solucao de Problemas, FAQ, Universidade Sankhya etc.) ' +
  'com ID, nome, URL publica e contagem de artigos. Use para descobrir o ' +
  'escopo da documentacao Sankhya antes de filtrar buscas. Retorna tabela ' +
  'Markdown.';

export function registerCategoriesTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Listar categorias do help Sankhya',
      description: TOOL_DESCRIPTION,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (rawArgs) => {
      try {
        const rows = await listCategories(ctx.pool);
        const markdown = formatToolResponse(TOOL_NAME, rows, rawArgs);
        return createSuccessResponse(markdown);
      } catch (err) {
        if (err instanceof McpResponseTooLargeError) {
          return createErrorResponse(err.message, 'RESPONSE_TOO_LARGE');
        }
        const msg = err instanceof Error ? err.message : String(err);
        return createErrorResponse(
          `Erro ao listar categorias. Esperado: banco disponivel. ` +
            `Sugestao: tente novamente. Detalhe: ${msg}`,
          'INTERNAL_ERROR',
        );
      }
    },
  );
}
