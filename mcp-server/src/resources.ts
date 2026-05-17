/**
 * MCP Resources under the sankhya-ajuda:// namespace.
 *
 * 3 static resources:
 *   sankhya-ajuda://categories     -> markdown table of all categories
 *   sankhya-ajuda://sections       -> markdown table of all sections
 *   sankhya-ajuda://sync_state     -> JSON document of last sync status
 *
 * 3 RFC 6570 templates:
 *   sankhya-ajuda://categories/{id} -> markdown detail of a single category
 *   sankhya-ajuda://sections/{id}   -> markdown detail of a single section
 *   sankhya-ajuda://articles/{id}   -> markdown detail of a single article
 *
 * Every read payload carries `lastModified` (ISO 8601, UTC) per CI-03.
 */

import {
  ResourceTemplate as McpResourceTemplate,
  type McpServer,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getArticleFull,
  getSyncState,
  listCategories,
  listSections,
} from './db.js';
import {
  formatCategoryList,
  formatSectionList,
  formatArticleDetail,
} from './formatters/entity.js';
import { formatDetail } from './formatters/markdown.js';
import { checkResponseSize } from './tools/base.js';
import type { ToolContext } from './tools/working-index.js';
import { MCP_RESOURCE_TYPES } from './types.js';
import type { McpResourceType } from './types.js';

// ─── URI Definitions ─────────────────────────────────────────────────────────

export interface ResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface SankhyaResourceTemplate {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string;
}

export const RESOURCE_DEFINITIONS: ResourceDefinition[] = [
  {
    uri: 'sankhya-ajuda://categories',
    name: 'Categorias do help Sankhya',
    description:
      'Lista completa das 14 categorias top-level do help center publico do ERP Sankhya. Conteudo Markdown.',
    mimeType: 'text/markdown',
  },
  {
    uri: 'sankhya-ajuda://sections',
    name: 'Secoes do help Sankhya',
    description:
      'Lista completa das 230 secoes do help center publico do ERP Sankhya com hierarquia parent_section_id. Conteudo Markdown.',
    mimeType: 'text/markdown',
  },
  {
    uri: 'sankhya-ajuda://sync_state',
    name: 'Estado da sincronizacao',
    description:
      'Documento JSON com status da ultima sincronizacao do help Sankhya: total de artigos, com embedding, ultimo sync_at.',
    mimeType: 'application/json',
  },
];

export const RESOURCE_TEMPLATES: SankhyaResourceTemplate[] = [
  {
    uriTemplate: 'sankhya-ajuda://categories/{id}',
    name: 'Detalhe da categoria do help Sankhya',
    description:
      'Detalhes de uma categoria especifica do help center Sankhya: nome, URL publica, quantidade de artigos.',
    mimeType: 'text/markdown',
  },
  {
    uriTemplate: 'sankhya-ajuda://sections/{id}',
    name: 'Detalhe da secao do help Sankhya',
    description:
      'Detalhes de uma secao especifica do help center Sankhya: categoria pai, parent_section_id, contagem de artigos.',
    mimeType: 'text/markdown',
  },
  {
    uriTemplate: 'sankhya-ajuda://articles/{id}',
    name: 'Detalhe do artigo do help Sankhya',
    description:
      'Artigo completo do help center publico Sankhya (ajuda.sankhya.com.br). Markdown formatado com breadcrumb, corpo, URL.',
    mimeType: 'text/markdown',
  },
];

// ─── URI parser ──────────────────────────────────────────────────────────────

export class InvalidSankhyaUriError extends Error {
  constructor(uri: string) {
    super(`URI invalida: "${uri}".`);
    this.name = 'InvalidSankhyaUriError';
  }
}

const SCHEME = 'sankhya-ajuda://';

export function parseResourceUri(
  uri: string,
): { type: McpResourceType; id: number | null } | null {
  if (!uri.startsWith(SCHEME)) return null;
  const path = uri.slice(SCHEME.length);
  if (path.length === 0) return null;

  const segments = path.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return null;

  const head = segments[0];
  if (!head) return null;

  const validTypes = Object.values(MCP_RESOURCE_TYPES) as string[];
  if (!validTypes.includes(head)) return null;
  const type = head as McpResourceType;

  if (segments.length === 1) {
    return { type, id: null };
  }

  if (segments.length === 2 && segments[1] !== undefined) {
    const idStr = segments[1];
    const id = Number.parseInt(idStr, 10);
    if (Number.isNaN(id) || id <= 0) return null;
    return { type, id };
  }

  return null;
}

export function validUriList(): string[] {
  return [
    ...RESOURCE_DEFINITIONS.map((r) => r.uri),
    ...RESOURCE_TEMPLATES.map((t) => t.uriTemplate),
  ];
}

// ─── Read dispatcher ─────────────────────────────────────────────────────────

export interface ReadResourceResult {
  uri: string;
  mimeType: string;
  text: string;
  lastModified: string;
}

export async function readResourceByUri(
  ctx: ToolContext,
  uri: string,
): Promise<ReadResourceResult> {
  const parsed = parseResourceUri(uri);
  if (!parsed) {
    throw new InvalidSankhyaUriError(uri);
  }

  switch (parsed.type) {
    case MCP_RESOURCE_TYPES.SYNC_STATE: {
      const state = await getSyncState(ctx.pool);
      const text = JSON.stringify(state, null, 2);
      checkResponseSize(text);
      return {
        uri,
        mimeType: 'application/json',
        text,
        lastModified: state.last_sync_at ?? new Date(0).toISOString(),
      };
    }

    case MCP_RESOURCE_TYPES.CATEGORIES: {
      if (parsed.id === null) {
        const rows = await listCategories(ctx.pool);
        const text = formatCategoryList(rows);
        checkResponseSize(text);
        const lastModified = maxIsoDate(rows.map((r) => r.synced_at));
        return { uri, mimeType: 'text/markdown', text, lastModified };
      }
      const rows = await listCategories(ctx.pool);
      const row = rows.find((r) => r.id === parsed.id);
      if (!row) {
        throw new InvalidSankhyaUriError(uri);
      }
      const text = formatDetail(row.name, [
        ['ID', row.id],
        ['URL', row.html_url],
        ['Artigos', row.article_count],
        ['Position', row.position],
        ['Sincronizado em', row.synced_at],
      ]);
      checkResponseSize(text);
      return { uri, mimeType: 'text/markdown', text, lastModified: row.synced_at };
    }

    case MCP_RESOURCE_TYPES.SECTIONS: {
      if (parsed.id === null) {
        const rows = await listSections(ctx.pool, null, null);
        const text = formatSectionList(rows);
        checkResponseSize(text);
        const lastModified = maxIsoDate(rows.map((r) => r.synced_at));
        return { uri, mimeType: 'text/markdown', text, lastModified };
      }
      const all = await listSections(ctx.pool, null, null);
      const row = all.find((r) => r.id === parsed.id);
      if (!row) {
        throw new InvalidSankhyaUriError(uri);
      }
      const text = formatDetail(row.name, [
        ['ID', row.id],
        ['Categoria', `${row.category_name} (${row.category_id})`],
        ['Parent', row.parent_section_id ?? '—'],
        ['URL', row.html_url],
        ['Artigos', row.article_count],
        ['Position', row.position],
        ['Sincronizado em', row.synced_at],
      ]);
      checkResponseSize(text);
      return { uri, mimeType: 'text/markdown', text, lastModified: row.synced_at };
    }

    case MCP_RESOURCE_TYPES.ARTICLES: {
      if (parsed.id === null) {
        throw new InvalidSankhyaUriError(uri);
      }
      const article = await getArticleFull(ctx.pool, parsed.id, 20000);
      if (!article) {
        throw new InvalidSankhyaUriError(uri);
      }
      const text = formatArticleDetail({ article, maxBodyChars: 20000 });
      checkResponseSize(text);
      return {
        uri,
        mimeType: 'text/markdown',
        text,
        lastModified: article.synced_at,
      };
    }
  }
}

function maxIsoDate(dates: string[]): string {
  if (dates.length === 0) return new Date(0).toISOString();
  let max = dates[0] ?? new Date(0).toISOString();
  for (const d of dates) {
    if (d > max) max = d;
  }
  return max;
}

// ─── Registration on the McpServer ───────────────────────────────────────────

export function registerResources(server: McpServer, ctx: ToolContext): void {
  // Static resources
  for (const def of RESOURCE_DEFINITIONS) {
    server.registerResource(
      def.name,
      def.uri,
      {
        description: def.description,
        mimeType: def.mimeType,
      },
      async () => {
        const result = await readResourceByUri(ctx, def.uri);
        return {
          contents: [
            {
              uri: result.uri,
              mimeType: result.mimeType,
              text: result.text,
              _meta: { lastModified: result.lastModified },
            },
          ],
        };
      },
    );
  }

  // Templates — must be `ResourceTemplate` instances so the SDK exposes them
  // under `resources/templates/list` (RFC 6570 advertising).
  for (const tpl of RESOURCE_TEMPLATES) {
    server.registerResource(
      tpl.name,
      new McpResourceTemplate(tpl.uriTemplate, { list: undefined }),
      {
        description: tpl.description,
        mimeType: tpl.mimeType,
      },
      async (uri: URL) => {
        const result = await readResourceByUri(ctx, uri.toString());
        return {
          contents: [
            {
              uri: result.uri,
              mimeType: result.mimeType,
              text: result.text,
              _meta: { lastModified: result.lastModified },
            },
          ],
        };
      },
    );
  }
}
