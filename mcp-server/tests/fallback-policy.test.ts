/**
 * AC08 + QG07 + QG08: politica de fallback por modo (RF07).
 *
 * Cobertura:
 *   - mode=hybrid + vLLM down -> keyword_fallback (sem OpenAI)
 *   - mode=semantic + vLLM down -> EMBEDDING_UNAVAILABLE estruturado
 *   - mode=keyword -> EmbeddingClient.embed() NUNCA chamado (spy assert)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runSearch } from '../src/tools/search.js';
import { EmbeddingError, type EmbeddingClient } from '../src/embeddings.js';
import * as dbModule from '../src/db.js';
import type { Pool } from '../src/db.js';
import type { SearchHit } from '../src/types.js';

const FAKE_HITS: SearchHit[] = [
  {
    id: 1001,
    title: 'Como emitir NF-e',
    breadcrumb: 'Documentacao > NF-e',
    html_url: 'https://ajuda.sankhya.com.br/hc/pt-br/articles/1001',
    outdated: false,
    score: 0.875,
  },
];

const fakePool = {} as Pool;

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('AC08 — mode=keyword never invokes embeddings (QG07 / CC-03)', () => {
  it('never calls EmbeddingClient.embed when mode=keyword', async () => {
    const embedSpy = vi.fn<EmbeddingClient['embed']>();
    const embedding: EmbeddingClient = { embed: embedSpy };
    const hybridSpy = vi
      .spyOn(dbModule, 'hybridSearch')
      .mockResolvedValue(FAKE_HITS);

    const result = await runSearch(
      { pool: fakePool, embedding },
      {
        query: 'nota fiscal',
        limit: 5,
        category_id: null,
        include_outdated: false,
        mode: 'keyword',
      },
    );

    expect(embedSpy).not.toHaveBeenCalled();
    expect(hybridSpy).toHaveBeenCalledWith(
      fakePool,
      expect.objectContaining({ mode: 'keyword', qvec: null }),
    );
    expect('isError' in result).toBe(false);
    if (!('isError' in result)) {
      expect(result.modeUsed).toBe('keyword');
    }
  });
});

describe('AC08 — mode=hybrid degrades to keyword_fallback when vLLM down', () => {
  it('reports keyword_fallback and never invokes OpenAI', async () => {
    const embedding: EmbeddingClient = {
      embed: vi.fn().mockRejectedValue(new EmbeddingError('vllm timeout', 'timeout')),
    };
    const hybridSpy = vi
      .spyOn(dbModule, 'hybridSearch')
      .mockResolvedValue(FAKE_HITS);

    const result = await runSearch(
      { pool: fakePool, embedding },
      {
        query: 'erro nfe',
        limit: 5,
        category_id: null,
        include_outdated: false,
        mode: 'hybrid',
      },
    );

    expect('isError' in result).toBe(false);
    if (!('isError' in result)) {
      expect(result.modeUsed).toBe('keyword_fallback');
    }
    // hybridSearch called with mode=keyword and qvec=null (FTS only)
    expect(hybridSpy).toHaveBeenLastCalledWith(
      fakePool,
      expect.objectContaining({ mode: 'keyword', qvec: null }),
    );
  });
});

describe('AC08 — mode=semantic returns EMBEDDING_UNAVAILABLE when vLLM down', () => {
  it('does NOT silently fall back', async () => {
    const embedding: EmbeddingClient = {
      embed: vi.fn().mockRejectedValue(new EmbeddingError('vllm 503', 'http_5xx')),
    };
    const hybridSpy = vi
      .spyOn(dbModule, 'hybridSearch')
      .mockResolvedValue(FAKE_HITS);

    const result = await runSearch(
      { pool: fakePool, embedding },
      {
        query: 'estoque',
        limit: 5,
        category_id: null,
        include_outdated: false,
        mode: 'semantic',
      },
    );

    expect('isError' in result).toBe(true);
    if ('isError' in result) {
      expect(result.markdown).toContain('EMBEDDING_UNAVAILABLE');
      expect(result.markdown).toContain('mode=keyword');
    }
    expect(hybridSpy).not.toHaveBeenCalled();
  });
});

describe('EMBEDDING_PROVIDER=none — keyword-only runtime', () => {
  it('forces semantic requests to keyword fallback without invoking embeddings', async () => {
    const embedding: EmbeddingClient = {
      embed: vi.fn().mockRejectedValue(new Error('should not be called')),
    };
    const hybridSpy = vi
      .spyOn(dbModule, 'hybridSearch')
      .mockResolvedValue(FAKE_HITS);

    const result = await runSearch(
      { pool: fakePool, embedding, embeddingProvider: 'none' },
      {
        query: 'estoque',
        limit: 5,
        category_id: null,
        include_outdated: false,
        mode: 'semantic',
      },
    );

    expect(embedding.embed).not.toHaveBeenCalled();
    expect('isError' in result).toBe(false);
    if (!('isError' in result)) {
      expect(result.modeUsed).toBe('keyword_fallback');
    }
    expect(hybridSpy).toHaveBeenCalledWith(
      fakePool,
      expect.objectContaining({ mode: 'keyword', qvec: null }),
    );
  });
});

describe('AC08 — happy paths', () => {
  it('mode=hybrid with vLLM up calls hybridSearch with qvec', async () => {
    const fakeVec = Array.from({ length: 2560 }, () => 0.1);
    const embedding: EmbeddingClient = {
      embed: vi.fn().mockResolvedValue(fakeVec),
    };
    const hybridSpy = vi.spyOn(dbModule, 'hybridSearch').mockResolvedValue(FAKE_HITS);

    const result = await runSearch(
      { pool: fakePool, embedding },
      {
        query: 'pedido de venda',
        limit: 3,
        category_id: null,
        include_outdated: false,
        mode: 'hybrid',
      },
    );

    expect('isError' in result).toBe(false);
    if (!('isError' in result)) {
      expect(result.modeUsed).toBe('hybrid');
    }
    expect(hybridSpy).toHaveBeenCalledWith(
      fakePool,
      expect.objectContaining({ mode: 'hybrid', qvec: fakeVec }),
    );
  });

  it('mode=semantic with vLLM up returns semantic mode', async () => {
    const fakeVec = Array.from({ length: 2560 }, () => 0.2);
    const embedding: EmbeddingClient = {
      embed: vi.fn().mockResolvedValue(fakeVec),
    };
    vi.spyOn(dbModule, 'hybridSearch').mockResolvedValue(FAKE_HITS);

    const result = await runSearch(
      { pool: fakePool, embedding },
      {
        query: 'cancelamento de NF',
        limit: 5,
        category_id: null,
        include_outdated: false,
        mode: 'semantic',
      },
    );

    expect('isError' in result).toBe(false);
    if (!('isError' in result)) {
      expect(result.modeUsed).toBe('semantic');
    }
  });
});
