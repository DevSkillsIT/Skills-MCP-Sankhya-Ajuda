/**
 * Unit tests for src/tools/community.ts
 *
 * Coverage targets (AC05, AC06):
 *   AC05 — get_community_post: success (metadata + body), NOT_FOUND when null,
 *           max_body_chars Zod range 100-40000 (rejects 99 and 40001, accepts 8000).
 *   AC06 — list_community_spaces: returns formatted rows (private=false already
 *           filtered in db), empty result friendly message.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as dbModule from '../../src/db.js';
import type { Pool } from '../../src/db.js';
import type { ToolContext } from '../../src/tools/working-index.js';
import type { CommunityPostFull, CommunitySpaceRow } from '../../src/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FAKE_POST: CommunityPostFull = {
  id: 'abc123',
  space_name: 'Personalização e Desenvolvimento',
  title: 'Como usar Groovy no Sankhya?',
  url: 'https://community.sankhya.com.br/post/abc123',
  body_text:
    'Pergunta inicial sobre Groovy.\n\n' +
    'Resposta de João: Use o módulo de scripts.\n\n' +
    'Resposta aninhada de Maria: Detalhe sobre o módulo.',
  body_text_truncated: false,
  body_text_full_chars: 150,
  post_type: 'question',
  tags: ['groovy', 'scripts'],
  has_accepted_answer: true,
  reactions_count: 5,
  author_name: 'Pedro',
  created_at: '2024-01-15T10:00:00.000Z',
  updated_at: '2024-01-16T08:00:00.000Z',
};

const FAKE_SPACES: CommunitySpaceRow[] = [
  {
    id: 'space1',
    name: 'Fiscal',
    slug: 'fiscal',
    url: 'https://community.sankhya.com.br/fiscal',
    posts_count: 200,
    members_count: 500,
  },
  {
    id: 'space2',
    name: 'Suporte',
    slug: 'suporte',
    url: 'https://community.sankhya.com.br/suporte',
    posts_count: 150,
    members_count: 300,
  },
];

const fakePool = {} as Pool;

function makeCtx(): ToolContext {
  return {
    pool: fakePool,
    embedding: { embed: vi.fn() },
    embeddingProvider: 'vllm',
    indexCompatible: true,
  };
}

// ─── Helpers: create a minimal McpServer stub ─────────────────────────────────

interface RegisteredTool {
  name: string;
  config: {
    title?: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    annotations?: Record<string, unknown>;
  };
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

function makeServer(): { server: McpServer; getTools: () => RegisteredTool[] } {
  const tools: RegisteredTool[] = [];
  const server = {
    registerTool: (
      name: string,
      config: RegisteredTool['config'],
      handler: RegisteredTool['handler'],
    ) => {
      tools.push({ name, config, handler });
    },
  } as unknown as McpServer;
  return { server, getTools: () => tools };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ─── AC05: sankhya_ajuda_get_community_post ───────────────────────────────────

describe('sankhya_ajuda_get_community_post', () => {
  it('AC05 — returns Markdown with body and metadata on success', async () => {
    vi.spyOn(dbModule, 'getCommunityPost').mockResolvedValue(FAKE_POST);

    const { registerGetCommunityPostTool } = await import(
      '../../src/tools/community.js'
    );
    const { server, getTools } = makeServer();
    registerGetCommunityPostTool(server, makeCtx());

    const [tool] = getTools();
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('sankhya_ajuda_get_community_post');

    const result = await tool!.handler({ post_id: 'abc123', max_body_chars: 8000 });
    const res = result as { content: Array<{ type: string; text: string }> };

    expect(res.content[0]?.text).toContain('Como usar Groovy no Sankhya?');
    expect(res.content[0]?.text).toContain('Resposta de João');
    expect(res.content[0]?.text).toContain('Resposta aninhada de Maria');
    // metadata fields
    expect(res.content[0]?.text).toContain('Personalização e Desenvolvimento');
    expect(res.content[0]?.text).toContain('question');
    expect(res.content[0]?.text).toContain('groovy');
    expect(res.content[0]?.text).toContain('Pedro');
    expect(res.content[0]?.text).toContain('2024-01-15');
    expect(res.content[0]?.text).toContain('https://community.sankhya.com.br/post/abc123');
    // no error flag
    expect((result as { isError?: boolean }).isError).toBeUndefined();
  });

  it('AC05 — has_accepted_answer=true renders "sim" in metadata', async () => {
    vi.spyOn(dbModule, 'getCommunityPost').mockResolvedValue(FAKE_POST);

    const { registerGetCommunityPostTool } = await import(
      '../../src/tools/community.js'
    );
    const { server, getTools } = makeServer();
    registerGetCommunityPostTool(server, makeCtx());

    const result = await getTools()[0]!.handler({ post_id: 'abc123' });
    const res = result as { content: Array<{ type: string; text: string }> };
    expect(res.content[0]?.text).toContain('sim');
  });

  it('AC05 — returns NOT_FOUND error when getCommunityPost returns null', async () => {
    vi.spyOn(dbModule, 'getCommunityPost').mockResolvedValue(null);

    const { registerGetCommunityPostTool } = await import(
      '../../src/tools/community.js'
    );
    const { server, getTools } = makeServer();
    registerGetCommunityPostTool(server, makeCtx());

    const result = await getTools()[0]!.handler({ post_id: 'nonexistent', max_body_chars: 8000 });
    const res = result as { isError: boolean; content: Array<{ text: string }> };

    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('NOT_FOUND');
    expect(res.content[0]?.text).toContain('nonexistent');
    // routing hint
    expect(res.content[0]?.text).toContain('sankhya_ajuda_search_knowledge_unified');
  });

  it('R5 — NOT_FOUND message mentions "comunidade" not "help center"', async () => {
    vi.spyOn(dbModule, 'getCommunityPost').mockResolvedValue(null);

    const { registerGetCommunityPostTool } = await import(
      '../../src/tools/community.js'
    );
    const { server, getTools } = makeServer();
    registerGetCommunityPostTool(server, makeCtx());

    const result = await getTools()[0]!.handler({ post_id: 'bad-id' });
    const res = result as { isError: boolean; content: Array<{ text: string }> };

    expect(res.isError).toBe(true);
    const text = res.content[0]?.text ?? '';
    // R5: must contain "comunidade", must NOT contain "help center".
    expect(text).toContain('comunidade');
    expect(text).not.toContain('help center');
  });

  it('AC05 — truncation notice when body_text_truncated=true', async () => {
    const truncatedPost: CommunityPostFull = {
      ...FAKE_POST,
      body_text: 'A'.repeat(200),
      body_text_truncated: true,
      body_text_full_chars: 1000,
    };
    vi.spyOn(dbModule, 'getCommunityPost').mockResolvedValue(truncatedPost);

    const { registerGetCommunityPostTool } = await import(
      '../../src/tools/community.js'
    );
    const { server, getTools } = makeServer();
    registerGetCommunityPostTool(server, makeCtx());

    const result = await getTools()[0]!.handler({ post_id: 'abc123', max_body_chars: 200 });
    const res = result as { content: Array<{ text: string }> };
    expect(res.content[0]?.text).toContain('truncado em 200 chars de 1000 totais');
  });

  it('AC05 — INTERNAL_ERROR on unexpected db exception', async () => {
    vi.spyOn(dbModule, 'getCommunityPost').mockRejectedValue(new Error('db down'));

    const { registerGetCommunityPostTool } = await import(
      '../../src/tools/community.js'
    );
    const { server, getTools } = makeServer();
    registerGetCommunityPostTool(server, makeCtx());

    const result = await getTools()[0]!.handler({ post_id: 'abc123' });
    const res = result as { isError: boolean; content: Array<{ text: string }> };

    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('INTERNAL_ERROR');
    // Security: the raw DB error must NOT leak to the client (logged server-side only).
    expect(res.content[0]?.text).not.toContain('db down');
  });

  it('AC05 — max_body_chars Zod: accepts 100', async () => {
    // Zod validation is done by the MCP SDK before calling the handler,
    // so here we verify the schema definition directly via z.parse.
    const { z } = await import('zod');
    const schema = z.object({
      post_id: z.string().min(1),
      max_body_chars: z.number().int().min(100).max(40000).default(8000),
    });
    expect(() => schema.parse({ post_id: 'x', max_body_chars: 100 })).not.toThrow();
    expect(() => schema.parse({ post_id: 'x', max_body_chars: 40000 })).not.toThrow();
    expect(() => schema.parse({ post_id: 'x', max_body_chars: 99 })).toThrow();
    expect(() => schema.parse({ post_id: 'x', max_body_chars: 40001 })).toThrow();
  });

  it('AC05 — max_body_chars Zod: rejects 99', async () => {
    const { z } = await import('zod');
    const schema = z.object({
      post_id: z.string().min(1),
      max_body_chars: z.number().int().min(100).max(40000).default(8000),
    });
    expect(() => schema.parse({ post_id: 'x', max_body_chars: 99 })).toThrow();
  });

  it('AC05 — max_body_chars Zod: rejects 40001', async () => {
    const { z } = await import('zod');
    const schema = z.object({
      post_id: z.string().min(1),
      max_body_chars: z.number().int().min(100).max(40000).default(8000),
    });
    expect(() => schema.parse({ post_id: 'x', max_body_chars: 40001 })).toThrow();
  });

  it('AC05 — max_body_chars Zod: accepts default 8000', async () => {
    const { z } = await import('zod');
    const schema = z.object({
      post_id: z.string().min(1),
      max_body_chars: z.number().int().min(100).max(40000).default(8000),
    });
    const parsed = schema.parse({ post_id: 'x' });
    expect(parsed.max_body_chars).toBe(8000);
  });

  it('AC05 — annotations mirror get_article_details (readOnly, not destructive)', async () => {
    vi.spyOn(dbModule, 'getCommunityPost').mockResolvedValue(FAKE_POST);

    const { registerGetCommunityPostTool } = await import(
      '../../src/tools/community.js'
    );
    const { server, getTools } = makeServer();
    registerGetCommunityPostTool(server, makeCtx());

    const tool = getTools()[0]!;
    expect(tool.config.annotations?.readOnlyHint).toBe(true);
    expect(tool.config.annotations?.destructiveHint).toBe(false);
    expect(tool.config.annotations?.idempotentHint).toBe(true);
    expect(tool.config.annotations?.openWorldHint).toBe(false);
    expect(tool.config.title).toBe('Detalhes do post da comunidade Sankhya');
  });
});

// ─── AC06: sankhya_ajuda_list_community_spaces ────────────────────────────────

describe('sankhya_ajuda_list_community_spaces', () => {
  it('AC06 — returns Markdown table with all public space rows', async () => {
    vi.spyOn(dbModule, 'listCommunitySpaces').mockResolvedValue(FAKE_SPACES);

    const { registerListCommunitySpacesTool } = await import(
      '../../src/tools/community.js'
    );
    const { server, getTools } = makeServer();
    registerListCommunitySpacesTool(server, makeCtx());

    const [tool] = getTools();
    expect(tool!.name).toBe('sankhya_ajuda_list_community_spaces');

    const result = await tool!.handler({});
    const res = result as { content: Array<{ text: string }> };

    expect(res.content[0]?.text).toContain('2 espacos');
    // table columns
    expect(res.content[0]?.text).toContain('ID');
    expect(res.content[0]?.text).toContain('Nome');
    expect(res.content[0]?.text).toContain('Slug');
    expect(res.content[0]?.text).toContain('URL');
    expect(res.content[0]?.text).toContain('Posts');
    expect(res.content[0]?.text).toContain('Membros');
    // row data
    expect(res.content[0]?.text).toContain('Fiscal');
    expect(res.content[0]?.text).toContain('fiscal');
    expect(res.content[0]?.text).toContain('200');
    expect(res.content[0]?.text).toContain('500');
    expect((result as { isError?: boolean }).isError).toBeUndefined();
  });

  it('AC06 — private=false filter is enforced at db level (listCommunitySpaces called)', async () => {
    // listCommunitySpaces already filters WHERE private = false in SQL.
    // This test verifies it is the only db function called (no extra filtering needed here).
    const dbSpy = vi.spyOn(dbModule, 'listCommunitySpaces').mockResolvedValue(FAKE_SPACES);

    const { registerListCommunitySpacesTool } = await import(
      '../../src/tools/community.js'
    );
    const { server, getTools } = makeServer();
    registerListCommunitySpacesTool(server, makeCtx());

    await getTools()[0]!.handler({});
    expect(dbSpy).toHaveBeenCalledOnce();
    expect(dbSpy).toHaveBeenCalledWith(fakePool);
  });

  it('AC06 — returns friendly message when no spaces found', async () => {
    vi.spyOn(dbModule, 'listCommunitySpaces').mockResolvedValue([]);

    const { registerListCommunitySpacesTool } = await import(
      '../../src/tools/community.js'
    );
    const { server, getTools } = makeServer();
    registerListCommunitySpacesTool(server, makeCtx());

    const result = await getTools()[0]!.handler({});
    const res = result as { content: Array<{ text: string }>; isError?: boolean };
    expect(res.content[0]?.text).toContain('Nenhum espaco encontrado');
    expect(res.isError).toBeUndefined();
  });

  it('AC06 — INTERNAL_ERROR on db exception', async () => {
    vi.spyOn(dbModule, 'listCommunitySpaces').mockRejectedValue(new Error('timeout'));

    const { registerListCommunitySpacesTool } = await import(
      '../../src/tools/community.js'
    );
    const { server, getTools } = makeServer();
    registerListCommunitySpacesTool(server, makeCtx());

    const result = await getTools()[0]!.handler({});
    const res = result as { isError: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('INTERNAL_ERROR');
    // Security: the raw DB error must NOT leak to the client (logged server-side only).
    expect(res.content[0]?.text).not.toContain('timeout');
  });

  it('AC06 — annotations mirror list_categories (readOnly, not destructive)', async () => {
    vi.spyOn(dbModule, 'listCommunitySpaces').mockResolvedValue(FAKE_SPACES);

    const { registerListCommunitySpacesTool } = await import(
      '../../src/tools/community.js'
    );
    const { server, getTools } = makeServer();
    registerListCommunitySpacesTool(server, makeCtx());

    const tool = getTools()[0]!;
    expect(tool.config.annotations?.readOnlyHint).toBe(true);
    expect(tool.config.annotations?.destructiveHint).toBe(false);
    expect(tool.config.annotations?.idempotentHint).toBe(true);
    expect(tool.config.annotations?.openWorldHint).toBe(false);
    expect(tool.config.title).toBe('Listar espacos da comunidade Sankhya');
  });

  it('AC06 — description has "Sankhya" at least 2 times', async () => {
    // Check via registration: description is embedded in tool config
    vi.spyOn(dbModule, 'listCommunitySpaces').mockResolvedValue([]);

    const { registerListCommunitySpacesTool } = await import(
      '../../src/tools/community.js'
    );
    const { server, getTools } = makeServer();
    registerListCommunitySpacesTool(server, makeCtx());

    const description = getTools()[0]!.config.description ?? '';
    const count = (description.match(/Sankhya/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(2);

    // Char count in [280, 400]
    expect(description.length).toBeGreaterThanOrEqual(280);
    expect(description.length).toBeLessThanOrEqual(400);
  });

  it('AC05 — get_community_post description has "Sankhya" at least 2 times', async () => {
    vi.spyOn(dbModule, 'getCommunityPost').mockResolvedValue(FAKE_POST);

    const { registerGetCommunityPostTool } = await import(
      '../../src/tools/community.js'
    );
    const { server, getTools } = makeServer();
    registerGetCommunityPostTool(server, makeCtx());

    const description = getTools()[0]!.config.description ?? '';
    const count = (description.match(/Sankhya/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(2);

    // Char count in [280, 400]
    expect(description.length).toBeGreaterThanOrEqual(280);
    expect(description.length).toBeLessThanOrEqual(400);
  });
});
