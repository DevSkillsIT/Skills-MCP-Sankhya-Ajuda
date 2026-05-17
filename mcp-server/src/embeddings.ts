/**
 * Embedding clients.
 *
 * - VllmEmbeddingClient: production client (OpenAI-compatible /v1/embeddings,
 *   Qwen3-Embedding-4B at 2560 dimensions). Retries with full-jitter.
 *
 * - OpenAIEmbeddingClient: adapter declared per ENV03 but INERT in runtime
 *   v1.0 (RF07 / AD-003). Cross-model vectors (OpenAI 3-large vs Qwen3) are
 *   not comparable via cosine similarity — see Risco 3 in spec.md. The
 *   client is kept loadable so a future shadow embedding set (offline batch
 *   job) can populate articles.embedding_openai without re-architecting.
 */

import OpenAI from 'openai';
import type { Settings } from './config.js';

/** Common interface for embedding providers. */
export interface EmbeddingClient {
  embed(text: string): Promise<number[]>;
}

/** Thrown by EmbeddingClient implementations when the upstream is unavailable. */
export class EmbeddingError extends Error {
  public readonly cause?: unknown;
  public readonly reason: 'timeout' | 'http_5xx' | 'http_4xx' | 'network' | 'unknown';

  constructor(
    message: string,
    reason: 'timeout' | 'http_5xx' | 'http_4xx' | 'network' | 'unknown',
    cause?: unknown,
  ) {
    super(message);
    this.name = 'EmbeddingError';
    this.reason = reason;
    this.cause = cause;
  }
}

// ─── VllmEmbeddingClient ─────────────────────────────────────────────────────

interface VllmEmbeddingResponse {
  data: Array<{ embedding: number[] }>;
}

/**
 * OpenAI-compatible client for a local vLLM instance hosting Qwen3-Embedding-4B
 * at 2560 dims. Implements 3-attempt full-jitter retry policy.
 */
export class VllmEmbeddingClient implements EmbeddingClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxRetries = 3;

  constructor(settings: Settings) {
    this.baseUrl = settings.vllm.baseUrl.replace(/\/+$/, '');
    this.apiKey = settings.vllm.apiKey;
    this.model = settings.vllm.model;
    this.timeoutMs = settings.vllm.timeoutMs;
  }

  async embed(text: string): Promise<number[]> {
    let lastError: EmbeddingError | undefined;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.embedOnce(text);
      } catch (err) {
        const error = err instanceof EmbeddingError
          ? err
          : new EmbeddingError(
              err instanceof Error ? err.message : String(err),
              'unknown',
              err,
            );

        lastError = error;
        // Do not retry on 4xx — these are deterministic errors (auth, bad input).
        if (error.reason === 'http_4xx') break;
        if (attempt === this.maxRetries) break;

        const base = Math.min(2_000, 100 * 2 ** (attempt - 1));
        const jitter = Math.random() * base;
        await sleep(jitter);
      }
    }

    throw lastError ?? new EmbeddingError('Failed to embed text via vLLM.', 'unknown');
  }

  private async embedOnce(text: string): Promise<number[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.model, input: text }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const aborted = (err as { name?: string } | undefined)?.name === 'AbortError';
      throw new EmbeddingError(
        aborted ? `vLLM request timed out after ${this.timeoutMs}ms` : 'vLLM network failure',
        aborted ? 'timeout' : 'network',
        err,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const reason = response.status >= 500 ? 'http_5xx' : 'http_4xx';
      throw new EmbeddingError(
        `vLLM HTTP ${response.status}: ${body.slice(0, 200)}`,
        reason,
      );
    }

    const json = (await response.json()) as VllmEmbeddingResponse;
    const vec = json.data?.[0]?.embedding;
    if (!Array.isArray(vec) || vec.length === 0) {
      throw new EmbeddingError('vLLM returned an empty embedding payload.', 'unknown');
    }
    return vec;
  }
}

// ─── OpenAIEmbeddingClient (inert adapter — see AD-003) ─────────────────────

/**
 * OpenAI-compatible client kept loadable but NOT wired into the search runtime
 * fallback chain in v1.0. See spec.md RF07 / AD-003 for the rationale (cosine
 * incompatibility with the Qwen3-indexed banco).
 *
 * Production usage of this client requires a separate offline batch job that
 * populates an `articles.embedding_openai halfvec(2560)` shadow column.
 */
export class OpenAIEmbeddingClient implements EmbeddingClient {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(settings: Settings) {
    if (!settings.openai.apiKey) {
      throw new EmbeddingError(
        'OPENAI_API_KEY ausente. Esperado: chave configurada quando OpenAI client e instanciado. ' +
          'Sugestao: configure OPENAI_API_KEY no .env ou nao instancie este client.',
        'http_4xx',
      );
    }
    this.client = new OpenAI({ apiKey: settings.openai.apiKey });
    this.model = settings.openai.model;
  }

  async embed(text: string): Promise<number[]> {
    try {
      const result = await this.client.embeddings.create({
        model: this.model,
        input: text,
        dimensions: 2560,
      });
      const vec = result.data?.[0]?.embedding;
      if (!Array.isArray(vec) || vec.length === 0) {
        throw new EmbeddingError('OpenAI returned an empty embedding payload.', 'unknown');
      }
      return vec;
    } catch (err) {
      if (err instanceof EmbeddingError) throw err;
      // The SDK raises RateLimitError / OpenAIError subclasses — surface as
      // EmbeddingError so callers can treat upstream failures uniformly.
      const msg = err instanceof Error ? err.message : String(err);
      const status = (err as { status?: number } | undefined)?.status;
      const reason: EmbeddingError['reason'] =
        status === 429 || (status !== undefined && status >= 500)
          ? 'http_5xx'
          : status !== undefined && status >= 400
            ? 'http_4xx'
            : 'unknown';
      throw new EmbeddingError(`OpenAI embedding failure: ${msg}`, reason, err);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Null embedding client — always raises EmbeddingError. Used when
 * EMBEDDING_PROVIDER=none. The search handler treats this exactly like a
 * vLLM outage:
 *   - mode=hybrid  -> degrades to keyword_fallback (no semantic CTE)
 *   - mode=semantic -> structured EMBEDDING_UNAVAILABLE error
 *   - mode=keyword -> never reaches this client (short-circuit)
 */
export class NullEmbeddingClient implements EmbeddingClient {
  async embed(_text: string): Promise<number[]> {
    throw new EmbeddingError(
      'Embeddings desabilitados nesta instalacao (EMBEDDING_PROVIDER=none). ' +
        'Esperado: provider local ou OpenAI. ' +
        'Sugestao: use mode=keyword ou configure EMBEDDING_PROVIDER=vllm|openai no .env.',
      'http_4xx',
    );
  }
}

/**
 * Factory used by index.ts to produce the runtime EmbeddingClient based on
 * EMBEDDING_PROVIDER. Each provider is mutually exclusive — the DB must be
 * indexed with the same model used for queries (cross-model cosine similarity
 * is mathematically invalid; see SPEC RF07 / AD-003 / Risco 3).
 */
export function buildEmbeddingClient(settings: Settings): EmbeddingClient {
  switch (settings.embeddingProvider) {
    case 'vllm':
      return new VllmEmbeddingClient(settings);
    case 'openai':
      return new OpenAIEmbeddingClient(settings);
    case 'none':
      return new NullEmbeddingClient();
  }
}
