/**
 * Bridge tools that wrap MCP resources/* as regular tools for clients that
 * cannot speak the native resources protocol.
 *
 *   sankhya_ajuda_list_mcp_resources   (no params)
 *   sankhya_ajuda_read_resource_by_uri (uri, id?)
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  RESOURCE_DEFINITIONS,
  RESOURCE_TEMPLATES,
  readResourceByUri,
  validUriList,
  InvalidSankhyaUriError,
} from '../resources.js';
import {
  createSuccessResponse,
  createErrorResponse,
  createInternalErrorResponse,
  McpResponseTooLargeError,
} from './base.js';
import { formatTable } from '../formatters/markdown.js';
import type { ToolContext } from './working-index.js';

const LIST_NAME = 'sankhya_ajuda_list_mcp_resources';
const READ_NAME = 'sankhya_ajuda_read_resource_by_uri';

const LIST_DESCRIPTION =
  'Recursos, dados e URIs do servidor MCP da base Sankhya — lista todas as URIs ' +
  'sankhya-ajuda:// com nome, tipo de conteudo (mimeType) e indicacao de template ' +
  'parametrizavel. Use quando precisar descobrir quais dados da base de ajuda ' +
  'Sankhya estao acessiveis via protocolo de recursos MCP. Retorna tabela ' +
  'Markdown. Consulta local.';

const READ_DESCRIPTION =
  'Conteudo de um recurso MCP da base Sankhya — le dados de uma URI sankhya-ajuda:// ' +
  'especifica para obter categorias, secoes ou artigos da documentacao do ' +
  'Sankhya. Use quando precisar acessar dados do Sankhya via protocolo de ' +
  'recursos MCP em vez de chamar as tools de dominio. Retorna Markdown ' +
  'formatado ou JSON para sync_state. Somente leitura.';

export function registerResourceTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    LIST_NAME,
    {
      title: 'Listar recursos MCP do help Sankhya',
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
        const rows = [
          ...RESOURCE_DEFINITIONS.map((r) => ({
            URI: r.uri,
            Nome: r.name,
            Tipo: 'Estatico',
            mimeType: r.mimeType,
            Descricao: r.description,
          })),
          ...RESOURCE_TEMPLATES.map((t) => ({
            URI: t.uriTemplate,
            Nome: t.name,
            Tipo: 'Template',
            mimeType: t.mimeType,
            Descricao: t.description,
          })),
        ];
        const header = `**${rows.length} recursos** disponiveis no MCP do help Sankhya`;
        const table = formatTable(
          ['URI', 'Nome', 'Tipo', 'mimeType', 'Descricao'],
          rows,
        );
        return createSuccessResponse(`${header}\n\n${table}`);
      } catch (err) {
        return createInternalErrorResponse(
          err,
          `Erro ao listar recursos MCP. Esperado: registry valido. ` +
            `Sugestao: reporte o problema.`,
        );
      }
    },
  );

  server.registerTool(
    READ_NAME,
    {
      title: 'Ler recurso MCP do help Sankhya',
      description: READ_DESCRIPTION,
      inputSchema: {
        uri: z
          .string()
          .min(1)
          .describe(
            'URI canonica do recurso MCP do help Sankhya. Aceita URI concreta ' +
              'como sankhya-ajuda://articles/123 ou template sankhya-ajuda://articles/{id}.',
          ),
        id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'ID quando a URI for um template ({id}); ignorado para URIs estaticas',
          ),
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
        const baseUri = String(rawArgs.uri);
        const id = typeof rawArgs.id === 'number' ? rawArgs.id : null;

        const fullUri = baseUri.includes('{id}')
          ? id === null
            ? baseUri
            : baseUri.replace('{id}', String(id))
          : baseUri;

        const result = await readResourceByUri(ctx, fullUri);

        if (result.mimeType === 'application/json') {
          return createSuccessResponse(
            '```json\n' + result.text + '\n```\n\n_lastModified: ' + result.lastModified + '_',
          );
        }
        return createSuccessResponse(
          result.text + '\n\n_lastModified: ' + result.lastModified + '_',
        );
      } catch (err) {
        if (err instanceof McpResponseTooLargeError) {
          return createErrorResponse(err.message, 'RESPONSE_TOO_LARGE');
        }
        if (err instanceof InvalidSankhyaUriError) {
          const valid = validUriList().join(', ');
          return createErrorResponse(
            `${err.message} Esperado: uma das URIs validas. Sugestao: use uma destas: ${valid}`,
            'INVALID_URI',
          );
        }
        return createInternalErrorResponse(
          err,
          `Erro ao ler recurso. Esperado: URI valida e banco disponivel. ` +
            `Sugestao: tente novamente.`,
        );
      }
    },
  );
}
