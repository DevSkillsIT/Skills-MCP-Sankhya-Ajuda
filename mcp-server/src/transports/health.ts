/**
 * /health endpoint (RNF05 / AC01).
 * Public (no auth), exposes never-credential metadata derived from db.getSyncState.
 */

import type { Request, Response } from 'express';
import { getSyncState } from '../db.js';
import type { Pool } from 'pg';
import type { Settings } from '../config.js';
import { SERVER_VERSION } from '../version.js';

const STARTUP_TS = Date.now();

export function buildHealthHandler(
  pool: Pool,
  settings: Settings,
  sessionsRef: { size: number },
) {
  return async (_req: Request, res: Response): Promise<void> => {
    try {
      const state = await getSyncState(pool);
      const uptimeSec = Math.floor((Date.now() - STARTUP_TS) / 1000);
      const syncHealthy = state.last_sync_status === 'ok' && state.error_count === 0;

      res.status(200).type('application/json').json({
        status: syncHealthy ? 'ok' : 'degraded',
        version: SERVER_VERSION,
        uptime_sec: uptimeSec,
        sessions: sessionsRef.size,
        tenant: settings.tenantLabel,
        last_sync_status: state.last_sync_status,
        last_sync_at: state.last_sync_at,
        last_error: state.last_error,
        error_count: state.error_count,
        articles_count: state.articles_count,
        with_embedding_count: state.with_embedding_count,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(503).type('application/json').json({
        status: 'degraded',
        version: SERVER_VERSION,
        error: msg,
      });
    }
  };
}
