/**
 * End-to-end MCP protocol smoke tests over Streamable HTTP.
 *
 * These exercise the SDK request handlers instead of only calling local helper
 * functions, covering initialize, tools, resources and prompts discovery/read.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { buildHttpApp } from '../src/transports/http.js';
import { buildTestSettings } from '../src/config.js';
import type { Pool } from '../src/db.js';
import type { EmbeddingClient } from '../src/embeddings.js';
import * as dbModule from '../src/db.js';

const fakePool = {
  end: vi.fn().mockResolvedValue(undefined),
} as unknown as Pool;

const fakeEmbedding: EmbeddingClient = {
  embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
};

const settings = buildTestSettings({
  http: {
    host: '127.0.0.1',
    port: 0,
    authToken: 'super-secret',
    bodyLimitBytes: 1_000_000,
    sessionIdleTimeoutMs: 0,
    sessionCleanupIntervalMs: 60_000,
  },
});

beforeEach(() => {
  vi.restoreAllMocks();
});

function parseJsonRpc(res: request.Response): Record<string, unknown> {
  if (res.body && Object.keys(res.body).length > 0) {
    return res.body as Record<string, unknown>;
  }
  const dataLine = res.text
    .split('\n')
    .find((line) => line.startsWith('data: '));
  if (!dataLine) return {};
  return JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>;
}

async function initialize(app: ReturnType<typeof buildHttpApp>['app']): Promise<string> {
  const res = await request(app)
    .post('/mcp')
    .set('Authorization', 'Bearer super-secret')
    .set('Accept', 'application/json, text/event-stream')
    .send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '1.0.0' },
      },
    });

  expect(res.status).toBe(200);
  const body = parseJsonRpc(res) as {
    result: { serverInfo: { name: string }; instructions: string };
  };
  expect(body.result.serverInfo.name).toBe('@skillsit/sankhya-ajuda-mcp');
  expect(body.result.instructions).toContain('sankhya_ajuda_search_articles');

  const sessionId = res.headers['mcp-session-id'];
  expect(typeof sessionId).toBe('string');

  const initialized = await request(app)
    .post('/mcp')
    .set('Authorization', 'Bearer super-secret')
    .set('Mcp-Session-Id', sessionId as string)
    .set('Accept', 'application/json, text/event-stream')
    .send({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
  expect([200, 202]).toContain(initialized.status);

  return sessionId as string;
}

describe('MCP protocol over Streamable HTTP', () => {
  it('lists tools/resources/templates/prompts and reads sync_state', async () => {
    vi.spyOn(dbModule, 'getSyncState').mockResolvedValue({
      articles_count: 6123,
      with_embedding_count: 6123,
      last_sync_status: 'ok',
      last_sync_at: '2026-05-15T03:00:00.000Z',
      error_count: 0,
      last_error: null,
    });
    vi.spyOn(dbModule, 'hybridSearch').mockResolvedValue([
      {
        id: 1001,
        title: 'Como emitir NF-e',
        breadcrumb: 'Documentacao > NF-e',
        html_url: 'https://ajuda.sankhya.com.br/hc/articles/1001',
        outdated: false,
        score: 0.875,
      },
    ]);
    vi.spyOn(dbModule, 'listCategories').mockResolvedValue([
      {
        id: 1,
        name: 'Documentacao',
        html_url: 'https://ajuda.sankhya.com.br/categories/1',
        position: 0,
        article_count: 100,
        synced_at: '2026-05-15T03:00:00.000Z',
      },
    ]);
    vi.spyOn(dbModule, 'listSections').mockResolvedValue([
      {
        id: 10,
        category_id: 1,
        category_name: 'Documentacao',
        parent_section_id: null,
        name: 'NF-e',
        html_url: 'https://ajuda.sankhya.com.br/sections/10',
        position: 0,
        article_count: 25,
        synced_at: '2026-05-15T03:00:00.000Z',
      },
    ]);
    vi.spyOn(dbModule, 'getArticleFull').mockResolvedValue({
      id: 1001,
      section_id: 10,
      title: 'Como emitir NF-e',
      breadcrumb: 'Documentacao > NF-e',
      body_text: 'Corpo do artigo',
      body_text_truncated: false,
      body_text_full_chars: 15,
      html_url: 'https://ajuda.sankhya.com.br/hc/articles/1001',
      label_names: ['nfe'],
      outdated: false,
      author_id: null,
      created_at: null,
      updated_at: null,
      edited_at: null,
      synced_at: '2026-05-15T03:00:00.000Z',
    });

    const { app } = buildHttpApp({ pool: fakePool, embedding: fakeEmbedding, settings });
    const sessionId = await initialize(app);

    const postRpc = async (payload: Record<string, unknown>) => {
      const res = await request(app)
        .post('/mcp')
        .set('Authorization', 'Bearer super-secret')
        .set('Mcp-Session-Id', sessionId)
        .set('Accept', 'application/json, text/event-stream')
        .send(payload);
      return { res, body: parseJsonRpc(res) };
    };

    const tools = await postRpc({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    const toolsBody = tools.body as { result: { tools: Array<{ name: string }> } };
    expect(tools.res.status).toBe(200);
    // Phase 1 adds sankhya_ajuda_search_knowledge_unified → 9 tools.
    // Phase 2 adds get_community_post + list_community_spaces → 11 tools total.
    expect(toolsBody.result.tools).toHaveLength(11);
    expect(toolsBody.result.tools.map((t) => t.name)).toContain(
      'sankhya_ajuda_read_resource_by_uri',
    );

    const resources = await postRpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'resources/list',
    });
    const resourcesBody = resources.body as { result: { resources: unknown[] } };
    expect(resources.res.status).toBe(200);
    expect(resourcesBody.result.resources).toHaveLength(3);

    const templates = await postRpc({
      jsonrpc: '2.0',
      id: 4,
      method: 'resources/templates/list',
    });
    const templatesBody = templates.body as { result: { resourceTemplates: unknown[] } };
    expect(templates.res.status).toBe(200);
    expect(templatesBody.result.resourceTemplates).toHaveLength(3);

    const syncState = await postRpc({
      jsonrpc: '2.0',
      id: 5,
      method: 'resources/read',
      params: { uri: 'sankhya-ajuda://sync_state' },
    });
    const syncBody = syncState.body as {
      result: { contents: Array<{ mimeType: string; text: string }> };
    };
    expect(syncState.res.status).toBe(200);
    expect(syncBody.result.contents[0]?.mimeType).toBe('application/json');
    expect(syncBody.result.contents[0]?.text).toContain('"articles_count": 6123');

    const prompts = await postRpc({
      jsonrpc: '2.0',
      id: 6,
      method: 'prompts/list',
    });
    const promptsBody = prompts.body as { result: { prompts: unknown[] } };
    expect(prompts.res.status).toBe(200);
    expect(promptsBody.result.prompts).toHaveLength(4);

    const prompt = await postRpc({
      jsonrpc: '2.0',
      id: 7,
      method: 'prompts/get',
      params: {
        name: 'sankhya_quick_lookup',
        arguments: { term: 'NF-e' },
      },
    });
    const promptBody = prompt.body as {
      result: { messages: Array<{ content: { text: string } }> };
    };
    expect(prompt.res.status).toBe(200);
    expect(promptBody.result.messages[0]?.content.text).toContain(
      'sankhya_ajuda_search_articles',
    );

    const search = await postRpc({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {
        name: 'sankhya_ajuda_search_articles',
        arguments: { query: 'NF-e', mode: 'keyword', limit: 1 },
      },
    });
    const searchBody = search.body as {
      result: { content: Array<{ text: string }> };
    };
    expect(search.res.status).toBe(200);
    expect(searchBody.result.content[0]?.text).toContain('Como emitir NF-e');

    const article = await postRpc({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: {
        name: 'sankhya_ajuda_get_article_details',
        arguments: { article_id: 1001 },
      },
    });
    const articleBody = article.body as {
      result: { content: Array<{ text: string }> };
    };
    expect(articleBody.result.content[0]?.text).toContain('Corpo do artigo');

    const categories = await postRpc({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'sankhya_ajuda_list_categories',
        arguments: {},
      },
    });
    const categoriesBody = categories.body as {
      result: { content: Array<{ text: string }> };
    };
    expect(categoriesBody.result.content[0]?.text).toContain('Documentacao');

    const sections = await postRpc({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: {
        name: 'sankhya_ajuda_list_sections',
        arguments: {},
      },
    });
    const sectionsBody = sections.body as {
      result: { content: Array<{ text: string }> };
    };
    expect(sectionsBody.result.content[0]?.text).toContain('NF-e');

    const resource = await postRpc({
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: {
        name: 'sankhya_ajuda_read_resource_by_uri',
        arguments: { uri: 'sankhya-ajuda://articles/1001' },
      },
    });
    const resourceBody = resource.body as {
      result: { content: Array<{ text: string }> };
    };
    expect(resourceBody.result.content[0]?.text).toContain('Como emitir NF-e');

    const resourceList = await postRpc({
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: {
        name: 'sankhya_ajuda_list_mcp_resources',
        arguments: {},
      },
    });
    const resourceListBody = resourceList.body as {
      result: { content: Array<{ text: string }> };
    };
    expect(resourceListBody.result.content[0]?.text).toContain('6 recursos');

    const syncResourceTool = await postRpc({
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: {
        name: 'sankhya_ajuda_read_resource_by_uri',
        arguments: { uri: 'sankhya-ajuda://sync_state' },
      },
    });
    const syncResourceToolBody = syncResourceTool.body as {
      result: { content: Array<{ text: string }> };
    };
    expect(syncResourceToolBody.result.content[0]?.text).toContain('```json');

    const invalidResourceTool = await postRpc({
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: {
        name: 'sankhya_ajuda_read_resource_by_uri',
        arguments: { uri: 'sankhya-ajuda://articles/not-a-number' },
      },
    });
    const invalidResourceToolBody = invalidResourceTool.body as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(invalidResourceToolBody.result.isError).toBe(true);
    expect(invalidResourceToolBody.result.content[0]?.text).toContain('INVALID_URI');

    const promptCatalog = await postRpc({
      jsonrpc: '2.0',
      id: 16,
      method: 'tools/call',
      params: {
        name: 'sankhya_ajuda_list_prompt_catalog',
        arguments: {},
      },
    });
    const promptCatalogBody = promptCatalog.body as {
      result: { content: Array<{ text: string }> };
    };
    expect(promptCatalogBody.result.content[0]?.text).toContain('4 prompts');

    const promptTool = await postRpc({
      jsonrpc: '2.0',
      id: 17,
      method: 'tools/call',
      params: {
        name: 'sankhya_ajuda_get_prompt_by_name',
        arguments: { name: 'sankhya_quick_lookup', arguments: { term: 'NF-e' } },
      },
    });
    const promptToolBody = promptTool.body as {
      result: { content: Array<{ text: string }> };
    };
    expect(promptToolBody.result.content[0]?.text).toContain('Prompt: sankhya_quick_lookup');

    const invalidPromptTool = await postRpc({
      jsonrpc: '2.0',
      id: 18,
      method: 'tools/call',
      params: {
        name: 'sankhya_ajuda_get_prompt_by_name',
        arguments: { name: 'invalido', arguments: {} },
      },
    });
    const invalidPromptToolBody = invalidPromptTool.body as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(invalidPromptToolBody.result.isError).toBe(true);
    expect(invalidPromptToolBody.result.content[0]?.text).toContain('INVALID_PROMPT_NAME');
  });
});
