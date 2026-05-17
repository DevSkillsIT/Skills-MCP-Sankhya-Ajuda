/**
 * Unit tests for VllmEmbeddingClient (retry, timeout, 4xx vs 5xx classification).
 * The global fetch is stubbed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  VllmEmbeddingClient,
  OpenAIEmbeddingClient,
  NullEmbeddingClient,
  EmbeddingError,
  buildEmbeddingClient,
} from '../src/embeddings.js';
import { buildTestSettings } from '../src/config.js';

const settings = buildTestSettings({
  vllm: {
    baseUrl: 'http://localhost:8090/v1',
    apiKey: 'test-key',
    model: 'Qwen/Qwen3-Embedding-4B',
    timeoutMs: 5_000,
  },
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('VllmEmbeddingClient.embed', () => {
  it('returns the first embedding from a successful response', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = new VllmEmbeddingClient(settings);
    const out = await client.embed('hello');
    expect(out).toEqual([0.1, 0.2, 0.3]);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('classifies 4xx as http_4xx and does NOT retry', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('unauthorized', { status: 401 }),
    );
    const client = new VllmEmbeddingClient(settings);
    await expect(client.embed('hello')).rejects.toMatchObject({
      name: 'EmbeddingError',
      reason: 'http_4xx',
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('classifies 5xx as http_5xx and retries up to 3 attempts', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('boom', { status: 503 }),
    );
    const client = new VllmEmbeddingClient(settings);
    await expect(client.embed('hello')).rejects.toMatchObject({
      name: 'EmbeddingError',
      reason: 'http_5xx',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('throws when payload has no data entries', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new VllmEmbeddingClient(settings);
    await expect(client.embed('x')).rejects.toBeInstanceOf(EmbeddingError);
  });
});

describe('OpenAIEmbeddingClient (inert adapter)', () => {
  it('refuses to instantiate without OPENAI_API_KEY', () => {
    const noKey = buildTestSettings({
      openai: { fallbackEnabled: false, apiKey: '', model: 'text-embedding-3-large' },
    });
    expect(() => new OpenAIEmbeddingClient(noKey)).toThrow(EmbeddingError);
  });
});

describe('buildEmbeddingClient', () => {
  it('returns the selected provider implementation', () => {
    expect(buildEmbeddingClient(buildTestSettings({ embeddingProvider: 'vllm' }))).toBeInstanceOf(
      VllmEmbeddingClient,
    );
    expect(buildEmbeddingClient(buildTestSettings({ embeddingProvider: 'none' }))).toBeInstanceOf(
      NullEmbeddingClient,
    );
    expect(
      buildEmbeddingClient(
        buildTestSettings({
          embeddingProvider: 'openai',
          openai: {
            fallbackEnabled: false,
            apiKey: 'sk-test',
            model: 'text-embedding-3-large',
          },
        }),
      ),
    ).toBeInstanceOf(OpenAIEmbeddingClient);
  });
});

describe('NullEmbeddingClient', () => {
  it('always rejects with a structured EmbeddingError', async () => {
    await expect(new NullEmbeddingClient().embed('x')).rejects.toMatchObject({
      name: 'EmbeddingError',
      reason: 'http_4xx',
    });
  });
});
