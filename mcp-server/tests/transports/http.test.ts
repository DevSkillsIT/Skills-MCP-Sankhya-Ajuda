/**
 * AC01, AC02, AC03: integration tests via supertest (no real port binding).
 * Pool and embedding are stubbed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { buildHttpApp, reapIdleSessions, type SessionEntry } from '../../src/transports/http.js';
import { buildTestSettings } from '../../src/config.js';
import type { Pool } from '../../src/db.js';
import type { EmbeddingClient } from '../../src/embeddings.js';
import * as dbModule from '../../src/db.js';
import { SERVER_VERSION } from '../../src/version.js';

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

describe('GET /health (AC01 / QG01) — public, no auth', () => {
  it('returns 200 JSON with sync state payload', async () => {
    vi.spyOn(dbModule, 'getSyncState').mockResolvedValue({
      articles_count: 6123,
      with_embedding_count: 6123,
      last_sync_status: 'ok',
      last_sync_at: '2026-05-15T03:00:00.000Z',
      error_count: 0,
      last_error: null,
    });

    const { app } = buildHttpApp({ pool: fakePool, embedding: fakeEmbedding, settings });

    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toMatchObject({
      status: 'ok',
      version: SERVER_VERSION,
      tenant: 'skillsit-test',
      last_sync_status: 'ok',
      error_count: 0,
      articles_count: 6123,
      with_embedding_count: 6123,
    });
    // Defense in depth: never expose credentials.
    const json = JSON.stringify(res.body).toLowerCase();
    expect(json).not.toContain('token');
    expect(json).not.toContain('password');
    expect(json).not.toContain('api_key');
  });

  it('returns 503 JSON when the database read fails (graceful degradation)', async () => {
    vi.spyOn(dbModule, 'getSyncState').mockRejectedValue(new Error('pg down'));
    const { app } = buildHttpApp({ pool: fakePool, embedding: fakeEmbedding, settings });

    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
  });

  it('returns degraded status when the last sync failed', async () => {
    vi.spyOn(dbModule, 'getSyncState').mockResolvedValue({
      articles_count: 6123,
      with_embedding_count: 6120,
      last_sync_status: 'error',
      last_sync_at: '2026-05-15T03:00:00.000Z',
      error_count: 2,
      last_error: 'Zendesk timeout',
    });
    const { app } = buildHttpApp({ pool: fakePool, embedding: fakeEmbedding, settings });

    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'degraded',
      last_sync_status: 'error',
      error_count: 2,
      // Security: expose only that an error occurred, never the raw text.
      last_error: 'see server logs',
    });
    // The raw sync error must NOT leak on the public (no-auth) endpoint.
    expect(JSON.stringify(res.body)).not.toContain('Zendesk timeout');
  });
});

describe('POST /mcp without Bearer (AC02 / QG02)', () => {
  it('returns 401 JSON', async () => {
    const { app } = buildHttpApp({ pool: fakePool, embedding: fakeEmbedding, settings });
    const res = await request(app)
      .post('/mcp')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body.error).toBe('unauthorized');
  });

  it('returns 401 JSON with an invalid token (constant-time path)', async () => {
    const { app } = buildHttpApp({ pool: fakePool, embedding: fakeEmbedding, settings });
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', 'Bearer wrong-token')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });
});

describe('OAuth discovery rejection (AC03 / QG03)', () => {
  const oauthPaths = [
    '/register',
    '/.well-known/oauth-authorization-server',
    '/.well-known/openid-configuration',
    '/authorize',
    '/token',
  ];

  for (const path of oauthPaths) {
    it(`returns 404 JSON for ${path}`, async () => {
      const { app } = buildHttpApp({ pool: fakePool, embedding: fakeEmbedding, settings });
      const res = await request(app).get(path);
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(res.body).toEqual({
        error: 'not_supported',
        message: 'MCP Sankhya Ajuda usa Bearer token, nao OAuth.',
      });
    });
  }
});

describe('GET/DELETE /mcp without Mcp-Session-Id', () => {
  it('GET returns 400 JSON', async () => {
    const { app } = buildHttpApp({ pool: fakePool, embedding: fakeEmbedding, settings });
    const res = await request(app)
      .get('/mcp')
      .set('Authorization', 'Bearer super-secret');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_request');
  });

  it('DELETE returns 400 JSON', async () => {
    const { app } = buildHttpApp({ pool: fakePool, embedding: fakeEmbedding, settings });
    const res = await request(app)
      .delete('/mcp')
      .set('Authorization', 'Bearer super-secret');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_request');
  });
});

describe('reapIdleSessions (Gap 2 fix v1.5.2)', () => {
  function makeEntry(lastActivityAt: number): SessionEntry {
    return {
      lastActivityAt,
      // Use minimal stubs — reapIdleSessions only reads lastActivityAt and calls transport.close().
      server: {} as never,
      transport: { close: vi.fn().mockResolvedValue(undefined) } as never,
    };
  }

  it('returns 0 when idleTimeoutMs is 0 (disabled)', async () => {
    const sessions = new Map<string, SessionEntry>();
    sessions.set('s1', makeEntry(0));
    const closed = await reapIdleSessions(sessions, 0, Date.now());
    expect(closed).toBe(0);
    expect(sessions.size).toBe(1);
  });

  it('closes only sessions older than cutoff', async () => {
    const now = 10_000;
    const idleMs = 1_000;
    const sessions = new Map<string, SessionEntry>();
    sessions.set('fresh', makeEntry(now - 500)); // still active
    sessions.set('stale', makeEntry(now - 5_000)); // expired
    const staleClose = sessions.get('stale')!.transport.close as ReturnType<typeof vi.fn>;

    const closed = await reapIdleSessions(sessions, idleMs, now);

    expect(closed).toBe(1);
    expect(sessions.has('fresh')).toBe(true);
    expect(sessions.has('stale')).toBe(false);
    expect(staleClose).toHaveBeenCalledOnce();
  });

  it('survives transport.close() rejection (best-effort)', async () => {
    const now = 10_000;
    const sessions = new Map<string, SessionEntry>();
    const flaky = makeEntry(now - 5_000);
    (flaky.transport.close as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    sessions.set('flaky', flaky);

    const closed = await reapIdleSessions(sessions, 1_000, now);

    expect(closed).toBe(1);
    expect(sessions.has('flaky')).toBe(false);
  });
});
