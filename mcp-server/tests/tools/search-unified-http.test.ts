/**
 * HTTP integration tests for the sankhya_ajuda_search_knowledge_unified MCP tool.
 *
 * These exercise the registerSearchUnifiedTool MCP handler (lines that are not
 * reachable from runUnifiedSearch unit tests alone), including:
 *   - Successful Markdown response with correct table format (RF01.8)
 *   - Empty-result friendly message
 *   - RESPONSE_TOO_LARGE error path (McpResponseTooLargeError)
 *   - INTERNAL_ERROR path (unexpected DB error)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { buildHttpApp } from '../../src/transports/http.js';
import { buildTestSettings } from '../../src/config.js';
import type { Pool } from '../../src/db.js';
import type { EmbeddingClient } from '../../src/embeddings.js';
import * as dbModule from '../../src/db.js';

const fakePool = {
  end: vi.fn().mockResolvedValue(undefined),
} as unknown as Pool;

const fakeEmbedding: EmbeddingClient = {
  embed: vi.fn().mockResolvedValue(Array(2560).fill(0.1)),
};

const settings = buildTestSettings({
  http: {
    host: '127.0.0.1',
    port: 0,
    authToken: 'test-secret',
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
  const dataLine = res.text.split('\n').find((line) => line.startsWith('data: '));
  if (!dataLine) return {};
  return JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>;
}

async function initSession(app: ReturnType<typeof buildHttpApp>['app']): Promise<string> {
  const res = await request(app)
    .post('/mcp')
    .set('Authorization', 'Bearer test-secret')
    .set('Accept', 'application/json, text/event-stream')
    .send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'vitest-unified', version: '1.0.0' },
      },
    });

  const sessionId = res.headers['mcp-session-id'] as string;

  await request(app)
    .post('/mcp')
    .set('Authorization', 'Bearer test-secret')
    .set('Mcp-Session-Id', sessionId)
    .set('Accept', 'application/json, text/event-stream')
    .send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  return sessionId;
}

async function callTool(
  app: ReturnType<typeof buildHttpApp>['app'],
  sessionId: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await request(app)
    .post('/mcp')
    .set('Authorization', 'Bearer test-secret')
    .set('Mcp-Session-Id', sessionId)
    .set('Accept', 'application/json, text/event-stream')
    .send({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: toolName, arguments: toolArgs },
    });

  expect(res.status).toBe(200);
  return parseJsonRpc(res);
}

describe('sankhya_ajuda_search_knowledge_unified via HTTP transport', () => {
  it('returns Markdown with correct RF01.8 columns (R2: ID added, R3: Similaridade=similarity)', async () => {
    const { app } = buildHttpApp({
      settings,
      pool: fakePool,
      embedding: fakeEmbedding,
    });

    vi.spyOn(dbModule, 'hybridSearch').mockResolvedValue([
      {
        id: 42,
        title: 'Emissão de NF-e',
        breadcrumb: 'Fiscal > NF-e',
        html_url: 'https://ajuda.sankhya.com.br/hc/pt-br/articles/42',
        outdated: false,
        score: 0.9,
        // similarity present (hybrid mode): Similaridade column shows "0.850"
        similarity: 0.85,
      },
    ]);
    vi.spyOn(dbModule, 'hybridSearchCommunity').mockResolvedValue([
      {
        id: 'comm1',
        title: 'Dúvida sobre NF-e',
        context: 'Fiscal',
        url: 'https://community.sankhya.com.br/post/comm1',
        score: 0.8,
        similarity: 0.72,
        has_accepted_answer: false,
        replies_count: 3,
      },
    ]);

    const sessionId = await initSession(app);
    const body = await callTool(app, sessionId, 'sankhya_ajuda_search_knowledge_unified', {
      query: 'nota fiscal',
      source: 'all',
      limit: 10,
    });

    const result = body as { result: { content: Array<{ type: string; text: string }> } };
    expect(result.result).toBeDefined();
    const text = result.result.content[0]?.text ?? '';

    // Column headers — R2 adds ID between Oficial and Título
    expect(text).toContain('Fonte');
    expect(text).toContain('Oficial');
    expect(text).toContain('ID');
    expect(text).toContain('Título');
    expect(text).toContain('Contexto');
    expect(text).toContain('Similaridade');
    expect(text).toContain('URL');

    // Source labels and official flags
    expect(text).toContain('HELP');
    expect(text).toContain('COMUNIDADE');
    expect(text).toContain('Sim');
    expect(text).toContain('Não');

    // ID values must appear (R2)
    expect(text).toContain('42');
    expect(text).toContain('comm1');

    // R3: Similaridade = similarity with 3 decimal places (not RRF 4-decimal)
    expect(text).toMatch(/0\.\d{3}/);
    // Actual similarity values from mock
    expect(text).toContain('0.850');
    expect(text).toContain('0.720');
  });

  it('returns friendly message when no results found', async () => {
    const { app } = buildHttpApp({ settings, pool: fakePool, embedding: fakeEmbedding });

    vi.spyOn(dbModule, 'hybridSearch').mockResolvedValue([]);
    vi.spyOn(dbModule, 'hybridSearchCommunity').mockResolvedValue([]);

    const sessionId = await initSession(app);
    const body = await callTool(app, sessionId, 'sankhya_ajuda_search_knowledge_unified', {
      query: 'xpto irrelevante',
      source: 'all',
      limit: 5,
    });

    const result = body as { result: { content: Array<{ type: string; text: string }> } };
    const text = result.result.content[0]?.text ?? '';
    expect(text).toContain('Nenhum resultado encontrado');
  });

  it('returns INTERNAL_ERROR when DB throws unexpectedly', async () => {
    const { app } = buildHttpApp({ settings, pool: fakePool, embedding: fakeEmbedding });

    vi.spyOn(dbModule, 'hybridSearch').mockRejectedValue(new Error('DB connection lost'));
    vi.spyOn(dbModule, 'hybridSearchCommunity').mockResolvedValue([]);

    const sessionId = await initSession(app);
    const body = await callTool(app, sessionId, 'sankhya_ajuda_search_knowledge_unified', {
      query: 'nota fiscal',
      source: 'all',
      limit: 5,
    });

    const result = body as {
      result: { content: Array<{ type: string; text: string }>; isError: boolean };
    };
    expect(result.result.isError).toBe(true);
    const text = result.result.content[0]?.text ?? '';
    expect(text).toContain('INTERNAL_ERROR');
    // Security: the raw DB error must NOT leak to the client (logged server-side only).
    expect(text).not.toContain('DB connection lost');
  });

  it('returns RESPONSE_TOO_LARGE when formatted Markdown exceeds 400KB', async () => {
    const { app } = buildHttpApp({ settings, pool: fakePool, embedding: fakeEmbedding });

    // Titles are now truncated to 90 chars (R4), so a single long title can no longer
    // push the response over 400KB. Instead, use a URL that is very long (URLs are
    // never truncated by R4) to blow the cap with a single hit.
    const veryLongUrl = 'https://ajuda.sankhya.com.br/hc/pt-br/articles/' + 'x'.repeat(400_001);
    vi.spyOn(dbModule, 'hybridSearch').mockResolvedValue([
      {
        id: 1,
        title: 'Emissao de NF-e',
        breadcrumb: null,
        html_url: veryLongUrl,
        outdated: false,
        score: 0.9,
        similarity: 0.8,
      },
    ]);
    vi.spyOn(dbModule, 'hybridSearchCommunity').mockResolvedValue([]);

    const sessionId = await initSession(app);
    const body = await callTool(app, sessionId, 'sankhya_ajuda_search_knowledge_unified', {
      query: 'nota fiscal',
      source: 'all',
      limit: 5,
    });

    // The MCP SDK wraps CallToolResult inside result.
    const result = body as {
      result: { content: Array<{ type: string; text: string }>; isError?: boolean };
    };
    expect(result.result.isError).toBe(true);
    const text = result.result.content[0]?.text ?? '';
    expect(text).toContain('RESPONSE_TOO_LARGE');
  });
});
