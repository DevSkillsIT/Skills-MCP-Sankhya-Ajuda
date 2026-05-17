/**
 * Bridge tools that wrap MCP prompts/* as regular tools:
 *
 *   sankhya_ajuda_list_prompt_catalog (no params)
 *   sankhya_ajuda_get_prompt_by_name (name enum, arguments?)
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  handleListPrompts,
  handleGetPrompt,
} from '../prompts.js';
import {
  createSuccessResponse,
  createErrorResponse,
  McpResponseTooLargeError,
} from './base.js';
import { formatTable } from '../formatters/markdown.js';
import type { ToolContext } from './working-index.js';

const LIST_NAME = 'sankhya_ajuda_list_prompt_catalog';
const GET_NAME = 'sankhya_ajuda_get_prompt_by_name';

const LIST_DESCRIPTION =
  'Prompts, templates e workflows disponiveis no servidor MCP da base Sankhya — ' +
  'catalogo de prompts pre-configurados com nome, descricao e argumentos ' +
  'necessarios para cada um. Use quando precisar saber quais analises e ' +
  'investigacoes guiadas a base de ajuda Sankhya oferece como slash commands. ' +
  'Retorna tabela Markdown. Consulta local.';

const GET_DESCRIPTION =
  'Prompts, relatorios e investigacoes da base Sankhya — executa prompt ' +
  'parametrizado para troubleshooting de erro, consulta rapida, explicacao de ' +
  'modulo ou comparacao entre artigos do help center Sankhya. Use quando ' +
  'precisar de um workflow estruturado em vez de buscas livres. O campo name ' +
  'deve ser um dos prompts listados em sankhya_ajuda_list_prompt_catalog. Retorna ' +
  'mensagens Markdown.';

export function registerPromptTools(server: McpServer, _ctx: ToolContext): void {
  server.registerTool(
    LIST_NAME,
    {
      title: 'Catalogo de prompts do help Sankhya',
      description: LIST_DESCRIPTION,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const prompts = handleListPrompts();
        const rows = prompts.map((p) => ({
          Nome: p.name,
          Descricao: p.description,
          Argumentos:
            p.arguments.length === 0
              ? '—'
              : p.arguments
                  .map((a) => `${a.name}${a.required ? '*' : '?'}`)
                  .join(', '),
        }));
        const header = `**${prompts.length} prompts** disponiveis no MCP do help Sankhya`;
        const table = formatTable(['Nome', 'Descricao', 'Argumentos'], rows);
        return createSuccessResponse(`${header}\n\n${table}\n\n_(\\* obrigatorio, ? opcional)_`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return createErrorResponse(
          `Erro ao listar prompts. Esperado: registry valido. ` +
            `Sugestao: reporte o problema. Detalhe: ${msg}`,
          'INTERNAL_ERROR',
        );
      }
    },
  );

  server.registerTool(
    GET_NAME,
    {
      title: 'Executar prompt do help Sankhya',
      description: GET_DESCRIPTION,
      inputSchema: {
        name: z
          .string()
          .min(1)
          .describe('Nome do prompt do help Sankhya a executar'),
        arguments: z
          .record(z.string())
          .optional()
          .describe('Argumentos do prompt selecionado (use sankhya_ajuda_list_prompt_catalog para detalhes)'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (rawArgs) => {
      try {
        const name = String(rawArgs.name);
        const promptArgs = (rawArgs.arguments as Record<string, string>) ?? {};
        const result = handleGetPrompt(name, promptArgs);

        if ('error' in result) {
          return createErrorResponse(
            `${result.error} Esperado: nome listado em sankhya_ajuda_list_prompt_catalog. ` +
              `Sugestao: chame sankhya_ajuda_list_prompt_catalog para ver os prompts disponiveis.`,
            'INVALID_PROMPT_NAME',
          );
        }

        let md = `**Prompt: ${name}**\n\n`;
        md += `_${result.description}_\n\n`;
        for (const msg of result.messages) {
          md += `**${msg.role}:**\n${msg.content.text}\n\n`;
        }
        return createSuccessResponse(md);
      } catch (err) {
        if (err instanceof McpResponseTooLargeError) {
          return createErrorResponse(err.message, 'RESPONSE_TOO_LARGE');
        }
        const msg = err instanceof Error ? err.message : String(err);
        return createErrorResponse(
          `Erro ao executar prompt. Esperado: prompt e args validos. ` +
            `Sugestao: tente novamente. Detalhe: ${msg}`,
          'INTERNAL_ERROR',
        );
      }
    },
  );
}
