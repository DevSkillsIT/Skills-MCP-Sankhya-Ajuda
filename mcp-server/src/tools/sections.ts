/**
 * sankhya_ajuda_list_sections — 230 sections of the Sankhya help center.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listSections } from '../db.js';
import {
  createSuccessResponse,
  createErrorResponse,
  McpResponseTooLargeError,
} from './base.js';
import { formatToolResponse } from '../formatters/response-formatter.js';
import type { ToolContext } from './working-index.js';
import '../formatters/entity.js';

const TOOL_NAME = 'sankhya_ajuda_list_sections';

const TOOL_DESCRIPTION =
  'Secoes e subsecoes da documentacao do ERP Sankhya — lista as 230 secoes ' +
  'do help center Sankhya com hierarquia aninhada (parent_section_id ' +
  'mapeia 59 subsecoes). Aceita filtro opcional por category_id ou ' +
  'parent_section_id. Use para navegar o indice antes de uma busca ' +
  'dirigida no Sankhya. Retorna tabela Markdown ordenada por position.';

const inputSchema = {
  category_id: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe('Filtra por categoria do Sankhya (use sankhya_ajuda_list_categories)'),
  parent_section_id: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe('Filtra apenas subsecoes de um nodo pai do help center Sankhya'),
};

export function registerSectionsTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Listar secoes do help Sankhya',
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
        const categoryId =
          typeof rawArgs.category_id === 'number' ? rawArgs.category_id : null;
        const parentSectionId =
          typeof rawArgs.parent_section_id === 'number'
            ? rawArgs.parent_section_id
            : null;

        const rows = await listSections(ctx.pool, categoryId, parentSectionId);
        const markdown = formatToolResponse(TOOL_NAME, rows, rawArgs);
        return createSuccessResponse(markdown);
      } catch (err) {
        if (err instanceof McpResponseTooLargeError) {
          return createErrorResponse(err.message, 'RESPONSE_TOO_LARGE');
        }
        const msg = err instanceof Error ? err.message : String(err);
        return createErrorResponse(
          `Erro ao listar secoes. Esperado: banco disponivel. ` +
            `Sugestao: tente novamente. Detalhe: ${msg}`,
          'INTERNAL_ERROR',
        );
      }
    },
  );
}
