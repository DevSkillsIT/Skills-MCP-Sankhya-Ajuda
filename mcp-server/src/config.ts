/**
 * Configuration loader for the Sankhya Ajuda MCP server.
 *
 * Loads from process.env (optionally hydrated by dotenv at process bootstrap).
 * Never stores secrets in plain fields — token comparison is always done in
 * the HTTP layer via crypto.timingSafeEqual.
 */

import { z } from 'zod';

// ─── Schemas ──────────────────────────────────────────────────────────────────

const httpSchema = z.object({
  host: z.string().min(1).default('0.0.0.0'),
  port: z.coerce.number().int().min(1).max(65535).default(3105),
  authToken: z.string().min(1, 'MCP_AUTH_TOKEN is required'),
  bodyLimitBytes: z.coerce.number().int().min(1024).default(4_000_000),
  // Session lifecycle (Gap 2 fix v1.5.2). 0 = no cleanup (legacy behavior).
  sessionIdleTimeoutMs: z.coerce.number().int().min(0).default(30 * 60 * 1000),
  sessionCleanupIntervalMs: z.coerce.number().int().min(1000).default(60_000),
});

const pgSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.coerce.number().int().default(5433),
  database: z.string().default('sankhya_ajuda'),
  user: z.string().default('sankhya_ajuda'),
  password: z.string().default(''),
  poolMin: z.coerce.number().int().min(0).default(1),
  poolMax: z.coerce.number().int().min(1).default(4),
});

const vllmSchema = z.object({
  // No hardcoded default URL. Set VLLM_BASE_URL in .env when EMBEDDING_PROVIDER=vllm.
  // Empty string is allowed so EMBEDDING_PROVIDER=openai|none does not require it;
  // boot-time check in index.ts enforces presence when actually needed.
  baseUrl: z.string().default(''),
  apiKey: z.string().default(''),
  model: z.string().default('Qwen/Qwen3-Embedding-4B'),
  timeoutMs: z.coerce.number().int().min(1000).default(60_000),
});

const openaiSchema = z.object({
  fallbackEnabled: z
    .preprocess((v: unknown) => String(v).toLowerCase() === 'true', z.boolean())
    .default(false),
  apiKey: z.string().default(''),
  model: z.string().default('text-embedding-3-large'),
});

/**
 * Embeddings provider selector — pick exactly ONE based on how the DB was indexed.
 *
 *   vllm:   local vLLM (Qwen3-Embedding-4B 2560d). Default for our SkillsIT deploy.
 *   openai: OpenAI API (text-embedding-3-large at 2560 dims). For deploys without
 *           local GPU; DB must be re-indexed with OpenAI vectors for semantic to
 *           be meaningful (cross-model similarity is mathematically invalid).
 *   none:   no embeddings — forces every search to mode=keyword (FTS only). Useful
 *           when neither vLLM nor an OpenAI key are available.
 */
const configSchema = z.object({
  http: httpSchema,
  pg: pgSchema,
  vllm: vllmSchema,
  openai: openaiSchema,
  embeddingProvider: z.enum(['vllm', 'openai', 'none']).default('vllm'),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  tenantLabel: z.string().default('skillsit'),
});

export type Settings = z.infer<typeof configSchema>;

// ─── Loader ───────────────────────────────────────────────────────────────────

let cached: Settings | null = null;

export function getSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  if (cached) return cached;

  const parsed = configSchema.parse({
    http: {
      host: env['MCP_HOST'],
      port: env['MCP_PORT'],
      authToken: env['MCP_AUTH_TOKEN'] ?? '',
      bodyLimitBytes: env['MCP_BODY_LIMIT_BYTES'],
      sessionIdleTimeoutMs: env['SESSION_IDLE_TIMEOUT_MS'],
      sessionCleanupIntervalMs: env['SESSION_CLEANUP_INTERVAL_MS'],
    },
    pg: {
      host: env['PG_HOST'],
      port: env['PG_PORT'],
      database: env['PG_DATABASE'],
      user: env['PG_USER'],
      password: env['PG_PASSWORD'],
      poolMin: env['PG_POOL_MIN'],
      poolMax: env['PG_POOL_MAX'],
    },
    vllm: {
      baseUrl: env['VLLM_BASE_URL'],
      apiKey: env['VLLM_API_KEY'],
      model: env['VLLM_MODEL'],
      timeoutMs: env['VLLM_TIMEOUT_MS'],
    },
    openai: {
      fallbackEnabled: env['EMBEDDING_FALLBACK_OPENAI'] ?? 'false',
      apiKey: env['OPENAI_API_KEY'],
      model: env['OPENAI_MODEL'],
    },
    embeddingProvider: env['EMBEDDING_PROVIDER'],
    logLevel: env['LOG_LEVEL'],
    tenantLabel: env['TENANT_LABEL'],
  });

  cached = parsed;
  return parsed;
}

/** Test-only helper to clear the memoized cache. */
export function _resetSettingsCache(): void {
  cached = null;
}

/** Test-only builder for deterministic Settings without parsing env. */
export function buildTestSettings(overrides: Partial<Settings> = {}): Settings {
  const base: Settings = {
    http: {
      host: '127.0.0.1',
      port: 3105,
      authToken: 'test-token',
      bodyLimitBytes: 4_000_000,
      sessionIdleTimeoutMs: 0, // disabled in tests by default
      sessionCleanupIntervalMs: 60_000,
    },
    pg: {
      host: '127.0.0.1',
      port: 5433,
      database: 'sankhya_ajuda',
      user: 'sankhya_ajuda',
      password: '',
      poolMin: 1,
      poolMax: 4,
    },
    vllm: {
      baseUrl: 'http://localhost:8090/v1',
      apiKey: '',
      model: 'Qwen/Qwen3-Embedding-4B',
      timeoutMs: 60_000,
    },
    openai: {
      fallbackEnabled: false,
      apiKey: '',
      model: 'text-embedding-3-large',
    },
    embeddingProvider: 'vllm',
    logLevel: 'error',
    tenantLabel: 'skillsit-test',
  };
  return { ...base, ...overrides };
}
