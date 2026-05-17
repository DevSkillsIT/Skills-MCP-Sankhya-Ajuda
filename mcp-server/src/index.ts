#!/usr/bin/env node
/**
 * Entry point for the Sankhya Ajuda MCP server.
 * Boots Streamable HTTP transport on the configured port.
 */

import 'dotenv/config';
import { getSettings } from './config.js';
import { buildPool } from './db.js';
import { buildEmbeddingClient } from './embeddings.js';
import { startHttp } from './transports/http.js';
import { checkIndexCompatibility } from './index-compat.js';
import { createLogger } from './logger.js';

async function main(): Promise<void> {
  const settings = getSettings();

  // No hardcoded VLLM URL in code — require it explicitly when actually used.
  if (settings.embeddingProvider === 'vllm' && !settings.vllm.baseUrl) {
    throw new Error(
      'VLLM_BASE_URL is required when EMBEDDING_PROVIDER=vllm. ' +
        'Set it in .env (see .env.example). To run without vLLM, set ' +
        'EMBEDDING_PROVIDER=openai or EMBEDDING_PROVIDER=none.',
    );
  }
  if (settings.embeddingProvider === 'openai' && !settings.openai.apiKey) {
    throw new Error(
      'OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai. ' +
        'Set it in .env (see .env.example).',
    );
  }

  const logger = createLogger(settings);
  const pool = await buildPool(settings);
  const embedding = buildEmbeddingClient(settings);

  // v1.5.4 guardrail: verify the DB was indexed with the same embedding model
  // we're about to query. Mismatch => semantic/hybrid search would return
  // mathematically random results (cosine across vector spaces).
  const compat = await checkIndexCompatibility(pool, settings);
  if (!compat.compatible) {
    logger.warn(
      {
        provider: compat.provider,
        expectedModel: compat.expectedModel,
        dbModels: compat.dbModels,
        reason: compat.reason,
      },
      'mcp-sankhya-ajuda index/provider mismatch - semantic/hybrid will degrade to keyword',
    );
  } else {
    logger.info(
      {
        provider: compat.provider,
        expectedModel: compat.expectedModel,
        dbModels: compat.dbModels,
      },
      'mcp-sankhya-ajuda index/provider compatible',
    );
  }

  await startHttp({
    pool,
    embedding,
    settings,
    indexCompatible: compat.compatible,
  });
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  pinoFallback().error({ error: msg }, 'fatal startup error');
  process.exit(1);
});

function pinoFallback() {
  return createLogger({
    logLevel: 'error',
    tenantLabel: 'unknown',
    embeddingProvider: 'none',
    http: {
      host: '0.0.0.0',
      port: 0,
      authToken: '',
      bodyLimitBytes: 4_000_000,
      sessionIdleTimeoutMs: 0,
      sessionCleanupIntervalMs: 60_000,
    },
    pg: {
      host: '',
      port: 0,
      database: '',
      user: '',
      password: '',
      poolMin: 0,
      poolMax: 1,
    },
    vllm: {
      baseUrl: 'http://127.0.0.1',
      apiKey: '',
      model: '',
      timeoutMs: 1_000,
    },
    openai: {
      fallbackEnabled: false,
      apiKey: '',
      model: '',
    },
  });
}
