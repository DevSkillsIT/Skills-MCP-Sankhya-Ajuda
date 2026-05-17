import { describe, it, expect, vi } from 'vitest';
import { checkIndexCompatibility, modelsMatch } from '../src/index-compat.js';
import { buildTestSettings } from '../src/config.js';
import type { Pool } from '../src/db.js';

function makePool(rows: unknown[]): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  } as unknown as Pool;
}

describe('modelsMatch', () => {
  it('accepts exact and substring matches within the same provider family', () => {
    expect(modelsMatch('Qwen/Qwen3-Embedding-4B', 'Qwen3-Embedding-4B', 'vllm')).toBe(true);
    expect(modelsMatch('text-embedding-3-large', 'text-embedding-3-large', 'openai')).toBe(true);
  });

  it('rejects cross-family and same-family different model names', () => {
    expect(modelsMatch('Qwen/Qwen3-Embedding-4B', 'text-embedding-3-large', 'openai')).toBe(false);
    expect(modelsMatch('text-embedding-3-small', 'text-embedding-3-large', 'openai')).toBe(false);
  });
});

describe('checkIndexCompatibility', () => {
  it('treats EMBEDDING_PROVIDER=none as compatible because semantic is disabled', async () => {
    const result = await checkIndexCompatibility(
      makePool([]),
      buildTestSettings({ embeddingProvider: 'none' }),
    );

    expect(result.compatible).toBe(true);
    expect(result.expectedModel).toBe('(no embedding queries)');
  });

  it('returns compatible when the DB model matches the configured provider', async () => {
    const result = await checkIndexCompatibility(
      makePool([{ embedding_model: 'Qwen/Qwen3-Embedding-4B', n: '6123' }]),
      buildTestSettings({ embeddingProvider: 'vllm' }),
    );

    expect(result.compatible).toBe(true);
    expect(result.dbModels).toEqual(['Qwen/Qwen3-Embedding-4B']);
  });

  it('returns incompatible with remediation guidance on cross-model mismatch', async () => {
    const result = await checkIndexCompatibility(
      makePool([{ embedding_model: 'Qwen/Qwen3-Embedding-4B', n: '6123' }]),
      buildTestSettings({ embeddingProvider: 'openai' }),
    );

    expect(result.compatible).toBe(false);
    expect(result.reason).toContain('Cosine similarity cross-model');
    expect(result.reason).toContain('re-indexar');
  });
});
