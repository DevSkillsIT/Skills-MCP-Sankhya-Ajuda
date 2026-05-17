/**
 * Streamable HTTP transport for the Sankhya Ajuda MCP server.
 *
 * Mirrors omie-erp/src/transports/http.ts:
 *   - per-session McpServer (StreamableHTTPServerTransport constraint)
 *   - randomUUID() session IDs
 *   - public /health (no auth)
 *   - OAuth discovery -> JSON 404
 *   - Bearer auth with crypto.timingSafeEqual
 *   - SIGTERM/SIGINT graceful shutdown
 */

import express from 'express';
import type { Application, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Pool } from 'pg';
import type { Settings } from '../config.js';
import { createServer } from '../server.js';
import { bearerAuth } from './auth.js';
import { buildHealthHandler } from './health.js';
import { attachOauthRejection } from './oauth-rejection.js';
import type { EmbeddingClient } from '../embeddings.js';
import { createLogger } from '../logger.js';

export interface SessionEntry {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  // Gap 2 fix (v1.5.2): tracked for idle cleanup. Updated on every request.
  lastActivityAt: number;
}

export interface HttpAppDeps {
  pool: Pool;
  embedding: EmbeddingClient;
  settings: Settings;
  /** v1.5.4: cross-model index/provider compatibility, computed at boot. */
  indexCompatible?: boolean;
}

/**
 * Build the Express application without binding to a port. Exposed for
 * supertest-based integration tests (CI-12).
 */
export function buildHttpApp(deps: HttpAppDeps): {
  app: Application;
  sessions: Map<string, SessionEntry>;
} {
  const { pool, embedding, settings } = deps;
  const indexCompatible = deps.indexCompatible ?? true;
  const sessions = new Map<string, SessionEntry>();

  const app = express();
  app.use(express.json({ limit: settings.http.bodyLimitBytes }));

  // ── /health (public, no auth) ──────────────────────────────────────────
  const healthHandler = buildHealthHandler(pool, settings, {
    get size() {
      return sessions.size;
    },
  });
  app.get('/health', healthHandler);

  // ── OAuth discovery rejection (JSON 404) ───────────────────────────────
  attachOauthRejection(app);

  // ── Bearer auth for /mcp ───────────────────────────────────────────────
  const auth = bearerAuth(settings.http.authToken);

  // POST /mcp — create or dispatch session
  app.post('/mcp', auth, async (req: Request, res: Response) => {
    try {
      const sessionId = req.header('mcp-session-id');

      if (sessionId) {
        const entry = sessions.get(sessionId);
        if (!entry) {
          res.status(404).type('application/json').json({
            error: 'session_not_found',
            message: 'Sessao expirada ou desconhecida.',
          });
          return;
        }
        entry.lastActivityAt = Date.now(); // Gap 2 fix v1.5.2
        await entry.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!isInitializeRequest(req.body)) {
        res.status(400).type('application/json').json({
          error: 'bad_request',
          message: 'Sessao nao iniciada. Envie um initialize antes de outras requisicoes.',
        });
        return;
      }

      const newId = randomUUID();
      const mcpServer = createServer({
        pool,
        embedding,
        indexCompatible,
        embeddingProvider: settings.embeddingProvider,
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newId,
        onsessioninitialized: (sid) => {
          if (!sessions.has(sid)) {
            sessions.set(sid, {
              server: mcpServer,
              transport,
              lastActivityAt: Date.now(),
            });
          }
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
        }
      };

      sessions.set(newId, {
        server: mcpServer,
        transport,
        lastActivityAt: Date.now(),
      });
      await mcpServer.connect(transport);
      res.setHeader('Mcp-Session-Id', newId);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        res.status(500).type('application/json').json({
          error: 'internal_error',
          message: msg,
        });
      }
    }
  });

  // GET /mcp — SSE stream for existing session
  app.get('/mcp', auth, async (req: Request, res: Response) => {
    const sessionId = req.header('mcp-session-id');
    if (!sessionId) {
      res.status(400).type('application/json').json({
        error: 'bad_request',
        message: 'Header Mcp-Session-Id ausente.',
      });
      return;
    }
    const entry = sessions.get(sessionId);
    if (!entry) {
      res.status(404).type('application/json').json({
        error: 'session_not_found',
        message: 'Sessao expirada ou desconhecida.',
      });
      return;
    }
    entry.lastActivityAt = Date.now(); // Gap 2 fix v1.5.2
    await entry.transport.handleRequest(req, res);
  });

  // DELETE /mcp — close session
  app.delete('/mcp', auth, async (req: Request, res: Response) => {
    const sessionId = req.header('mcp-session-id');
    if (!sessionId) {
      res.status(400).type('application/json').json({
        error: 'bad_request',
        message: 'Header Mcp-Session-Id ausente.',
      });
      return;
    }
    const entry = sessions.get(sessionId);
    if (!entry) {
      res.status(404).type('application/json').json({
        error: 'session_not_found',
        message: 'Sessao desconhecida.',
      });
      return;
    }
    try {
      await entry.transport.close();
    } catch {
      // best-effort
    }
    sessions.delete(sessionId);
    res.status(204).end();
  });

  return { app, sessions };
}

/**
 * Sweep sessions whose lastActivityAt is older than idleTimeoutMs. Exported for
 * unit testing. No-op when idleTimeoutMs === 0 (cleanup disabled).
 */
export async function reapIdleSessions(
  sessions: Map<string, SessionEntry>,
  idleTimeoutMs: number,
  now: number = Date.now(),
): Promise<number> {
  if (idleTimeoutMs <= 0) return 0;
  const cutoff = now - idleTimeoutMs;
  let closed = 0;
  for (const [id, entry] of sessions.entries()) {
    if (entry.lastActivityAt < cutoff) {
      try {
        await entry.transport.close();
      } catch {
        // best-effort
      }
      sessions.delete(id);
      closed += 1;
    }
  }
  return closed;
}

/** Production launcher: builds the app, binds the port, wires SIGTERM/SIGINT. */
export async function startHttp(deps: HttpAppDeps): Promise<void> {
  const { app, sessions } = buildHttpApp(deps);
  const { settings, pool } = deps;
  const logger = createLogger(settings);

  const httpServer = app.listen(settings.http.port, settings.http.host, () => {
    logger.info(
      {
        port: settings.http.port,
        host: settings.http.host,
        tenant: settings.tenantLabel,
      },
      'mcp-sankhya-ajuda http ready',
    );
  });

  // Gap 2 fix (v1.5.2): periodic sweep of idle sessions.
  let cleanupTimer: NodeJS.Timeout | null = null;
  if (settings.http.sessionIdleTimeoutMs > 0) {
    cleanupTimer = setInterval(() => {
      void reapIdleSessions(sessions, settings.http.sessionIdleTimeoutMs).then((closed) => {
        if (closed > 0) {
          logger.info(
            {
              closed,
              remaining: sessions.size,
            },
            'mcp-sankhya-ajuda idle sessions reaped',
          );
        }
      });
    }, settings.http.sessionCleanupIntervalMs);
    cleanupTimer.unref();
  }

  const shutdown = async (): Promise<void> => {
    logger.info('mcp-sankhya-ajuda shutting down');
    if (cleanupTimer) clearInterval(cleanupTimer);
    for (const [id, entry] of sessions.entries()) {
      try {
        await entry.transport.close();
      } catch {
        // ignore
      }
      sessions.delete(id);
    }
    try {
      await pool.end();
    } catch {
      // ignore
    }
    httpServer.close(() => process.exit(0));
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}
