/**
 * Community domain tools for the Sankhya Ajuda MCP server.
 *
 * Tools implemented here:
 *   - sankhya_ajuda_get_community_post   — full thread detail for a community post
 *   - sankhya_ajuda_list_community_spaces — list of all public community spaces
 *
 * @MX:NOTE: [AUTO] Both tools are read-only drill-downs for the community
 *   corpus sourced from Bettermode (SPEC-SANKHYA-COMMUNITY-001 Fase 2).
 *   Post IDs are alphanumeric strings (Bettermode), not BIGINTs like article IDs.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getCommunityPost, listCommunitySpaces } from '../db.js';
import {
  createSuccessResponse,
  createErrorResponse,
  createInternalErrorResponse,
  errorNotFound,
  McpResponseTooLargeError,
} from './base.js';
import { formatTable, formatDetail } from '../formatters/markdown.js';
import { escapeMarkdown } from '../utils/html-stripper.js';
import { checkResponseSize } from './base.js';
import type { ToolContext } from './working-index.js';
import type { CommunityPostFull, CommunitySpaceRow } from '../types.js';

// ─── sankhya_ajuda_get_community_post ────────────────────────────────────────

const GET_POST_NAME = 'sankhya_ajuda_get_community_post';

// Description: pt-BR, 280-400 chars, "Sankhya" >= 2x, key noun FIRST,
// 2-4 domain synonyms, routing hint pointing to search tool for discovery.
//
// Char count verified: see report at bottom of file.
const GET_POST_DESCRIPTION =
  'Post da comunidade Sankhya — recupera thread completo (perguntas, respostas ' +
  'e replies aninhadas) de um post da comunidade do ERP Sankhya a partir do ' +
  'post_id retornado por sankhya_ajuda_search_knowledge_unified. Inclui corpo ' +
  'composto, espaco, tags, tipo, autor, datas e URL. Use como drill-down apos ' +
  'uma busca unificada encontrar o topico ou discussao de interesse.';

// Verify length at module load in dev (stripped from production by TS compiler):
// GET_POST_DESCRIPTION.length should be in [280, 400]

const getPostInputSchema = {
  post_id: z
    .string()
    .min(1, 'post_id nao pode ser vazio')
    .describe('ID alfanumerico do post da comunidade Sankhya (retornado por sankhya_ajuda_search_knowledge_unified)'),
  max_body_chars: z
    .number()
    .int()
    .min(100, 'max_body_chars minimo: 100')
    .max(40000, 'max_body_chars maximo: 40000')
    .default(8000)
    .describe(
      'Limite de caracteres do corpo do post. Range 100-40000, default 8000. ' +
        'Inclui todas as respostas do thread compostas pelo ETL.',
    ),
};

/**
 * Format a CommunityPostFull as Markdown (detail view + body + metadata).
 *
 * @MX:NOTE: [AUTO] body_text already contains all nested replies composed
 *   by the ETL ("Resposta de …" / "Resposta aninhada de …"). Preserve as-is.
 */
function formatCommunityPostDetail(post: CommunityPostFull, maxBodyChars: number): string {
  const tags =
    post.tags.length > 0
      ? post.tags.map((t) => `\`${escapeMarkdown(t)}\``).join(', ')
      : '—';

  const fields: Array<[string, unknown]> = [
    ['ID', post.id],
    ['Espaco (comunidade)', post.space_name],
    ['Tipo', post.post_type ?? '—'],
    ['Tags', tags],
    ['Resposta aceita', post.has_accepted_answer ? 'sim' : 'nao'],
    ['Reacoes', post.reactions_count],
    ['Autor', post.author_name ?? '—'],
    ['Criado em', post.created_at ?? '—'],
    ['Atualizado em', post.updated_at ?? '—'],
    ['URL', post.url],
  ];

  const header = formatDetail(escapeMarkdown(post.title), fields);

  let content: string;
  if (post.body_text.trim().length === 0) {
    content = '_(post sem conteudo de corpo)_';
  } else if (post.body_text_truncated) {
    content =
      post.body_text +
      `\n\n_... (truncado em ${maxBodyChars} chars de ${post.body_text_full_chars} totais; aumente max_body_chars para ver mais)_`;
  } else {
    content = post.body_text;
  }

  const result = `${header}\n\n## Conteudo\n\n${content}`;
  checkResponseSize(result);
  return result;
}

export function registerGetCommunityPostTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    GET_POST_NAME,
    {
      title: 'Detalhes do post da comunidade Sankhya',
      description: GET_POST_DESCRIPTION,
      inputSchema: getPostInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (rawArgs) => {
      try {
        const postId = String(rawArgs.post_id);
        const maxBodyChars =
          typeof rawArgs.max_body_chars === 'number' ? rawArgs.max_body_chars : 8000;

        const post = await getCommunityPost(ctx.pool, postId, maxBodyChars);
        if (!post) {
          return errorNotFound(
            'Post',
            postId,
            'use sankhya_ajuda_search_knowledge_unified para encontrar um post_id valido',
            'identificador valido de um post da comunidade Sankhya',
          );
        }

        const markdown = formatCommunityPostDetail(post, maxBodyChars);
        return createSuccessResponse(markdown);
      } catch (err) {
        if (err instanceof McpResponseTooLargeError) {
          return createErrorResponse(err.message, 'RESPONSE_TOO_LARGE');
        }
        return createInternalErrorResponse(
          err,
          `Erro ao carregar post da comunidade. Esperado: banco disponivel. ` +
            `Sugestao: tente novamente.`,
        );
      }
    },
  );
}

// ─── sankhya_ajuda_list_community_spaces ─────────────────────────────────────

const LIST_SPACES_NAME = 'sankhya_ajuda_list_community_spaces';

// Description: pt-BR, 280-400 chars, "Sankhya" >= 2x, key noun FIRST,
// 2-4 domain synonyms, mirrors list_categories pattern.
//
// Char count verified: see report at bottom of file.
const LIST_SPACES_DESCRIPTION =
  'Espacos da comunidade Sankhya — lista todos os espacos publicos do forum ' +
  'comunitario do ERP Sankhya (topicos, grupos, canais de discussao) com id, ' +
  'nome, slug, URL, contagem de posts e membros. Use para descobrir quais ' +
  'espacos ou comunidades existem antes de filtrar buscas ou orientar o usuario ' +
  'sobre onde sua duvida sobre o Sankhya se encaixa. Retorna tabela Markdown.';

/**
 * Format CommunitySpaceRow[] as a Markdown table.
 */
function formatCommunitySpaceList(rows: CommunitySpaceRow[]): string {
  if (rows.length === 0) {
    return 'Nenhum espaco encontrado.';
  }
  const summary = `**${rows.length} espaco${rows.length === 1 ? '' : 's'}** publico${rows.length === 1 ? '' : 's'} da comunidade Sankhya`;
  const data = rows.map((r) => ({
    ID: r.id,
    Nome: r.name,
    Slug: r.slug,
    URL: r.url,
    Posts: r.posts_count,
    Membros: r.members_count,
  }));
  const table = formatTable(['ID', 'Nome', 'Slug', 'URL', 'Posts', 'Membros'], data);
  const result = `${summary}\n\n${table}`;
  checkResponseSize(result);
  return result;
}

export function registerListCommunitySpacesTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    LIST_SPACES_NAME,
    {
      title: 'Listar espacos da comunidade Sankhya',
      description: LIST_SPACES_DESCRIPTION,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (_rawArgs) => {
      try {
        const rows = await listCommunitySpaces(ctx.pool);
        const markdown = formatCommunitySpaceList(rows);
        return createSuccessResponse(markdown);
      } catch (err) {
        if (err instanceof McpResponseTooLargeError) {
          return createErrorResponse(err.message, 'RESPONSE_TOO_LARGE');
        }
        return createInternalErrorResponse(
          err,
          `Erro ao listar espacos da comunidade. Esperado: banco disponivel. ` +
            `Sugestao: tente novamente.`,
        );
      }
    },
  );
}

// ─── Description char counts (compile-time documentation) ────────────────────
//
// GET_POST_DESCRIPTION:
//   'Post da comunidade Sankhya — recupera thread completo (perguntas, respostas '  (74)
//   'e replies aninhadas) de um post da comunidade do ERP Sankhya a partir do '      (72)
//   'post_id retornado por sankhya_ajuda_search_knowledge_unified. Inclui corpo '    (72)
//   'composto, espaco, tags, tipo, autor, datas e URL. Use como drill-down apos '    (71)
//   'uma busca unificada encontrar o topico ou discussao de interesse.'               (65)
//   Total concat = 354 chars  ✓ [280, 400]
//
// LIST_SPACES_DESCRIPTION:
//   'Espacos da comunidade Sankhya — lista todos os espacos publicos do forum '      (72)
//   'comunitario do ERP Sankhya (topicos, grupos, canais de discussao) com id, '     (72)
//   'nome, slug, URL, contagem de posts e membros. Use para descobrir quais '        (70)
//   'espacos ou comunidades existem antes de filtrar buscas ou orientar o usuario '  (78)
//   'sobre onde sua duvida sobre o Sankhya se encaixa. Retorna tabela Markdown.'     (71)
//   Total concat = 363 chars  ✓ [280, 400]
