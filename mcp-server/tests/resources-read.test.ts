/**
 * Tests for readResourceByUri — exercises each URI shape with a mocked Pool.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  readResourceByUri,
  InvalidSankhyaUriError,
} from '../src/resources.js';
import * as dbModule from '../src/db.js';
import type { Pool } from '../src/db.js';
import type { EmbeddingClient } from '../src/embeddings.js';

const pool = {} as Pool;
const embedding: EmbeddingClient = { embed: vi.fn() };
const ctx = { pool, embedding };

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('readResourceByUri', () => {
  it('returns JSON payload with lastModified=last_sync_at for sync_state', async () => {
    vi.spyOn(dbModule, 'getSyncState').mockResolvedValue({
      articles_count: 6123,
      with_embedding_count: 6123,
      last_sync_status: 'ok',
      last_sync_at: '2026-05-15T03:00:00.000Z',
      error_count: 0,
      last_error: null,
    });

    const result = await readResourceByUri(ctx, 'sankhya-ajuda://sync_state');
    expect(result.mimeType).toBe('application/json');
    expect(result.lastModified).toBe('2026-05-15T03:00:00.000Z');
    expect(JSON.parse(result.text)).toMatchObject({ articles_count: 6123 });
  });

  it('returns Markdown table for sankhya-ajuda://categories', async () => {
    vi.spyOn(dbModule, 'listCategories').mockResolvedValue([
      {
        id: 1,
        name: 'Cat A',
        html_url: 'https://example/1',
        position: 0,
        article_count: 10,
        synced_at: '2026-05-15T03:00:00.000Z',
      },
    ]);

    const result = await readResourceByUri(ctx, 'sankhya-ajuda://categories');
    expect(result.mimeType).toBe('text/markdown');
    expect(result.text).toContain('Cat A');
    expect(result.lastModified).toBe('2026-05-15T03:00:00.000Z');
  });

  it('returns category detail for sankhya-ajuda://categories/{id}', async () => {
    vi.spyOn(dbModule, 'listCategories').mockResolvedValue([
      {
        id: 7,
        name: 'Documentacao',
        html_url: 'https://example/7',
        position: 0,
        article_count: 100,
        synced_at: '2026-05-15T03:00:00.000Z',
      },
    ]);

    const result = await readResourceByUri(ctx, 'sankhya-ajuda://categories/7');
    expect(result.text).toContain('# Documentacao');
    expect(result.lastModified).toBe('2026-05-15T03:00:00.000Z');
  });

  it('throws InvalidSankhyaUriError when category id does not exist', async () => {
    vi.spyOn(dbModule, 'listCategories').mockResolvedValue([]);
    await expect(
      readResourceByUri(ctx, 'sankhya-ajuda://categories/999'),
    ).rejects.toBeInstanceOf(InvalidSankhyaUriError);
  });

  it('returns section list and detail with lastModified', async () => {
    vi.spyOn(dbModule, 'listSections').mockResolvedValue([
      {
        id: 10,
        category_id: 1,
        category_name: 'Cat',
        parent_section_id: null,
        name: 'Sec',
        html_url: 'https://example/sec/10',
        position: 0,
        article_count: 25,
        synced_at: '2026-05-15T03:00:00.000Z',
      },
    ]);

    const list = await readResourceByUri(ctx, 'sankhya-ajuda://sections');
    expect(list.text).toContain('Sec');

    const detail = await readResourceByUri(ctx, 'sankhya-ajuda://sections/10');
    expect(detail.text).toContain('# Sec');
    expect(detail.text).toContain('Cat (1)');
  });

  it('returns article detail for sankhya-ajuda://articles/{id}', async () => {
    vi.spyOn(dbModule, 'getArticleFull').mockResolvedValue({
      id: 42,
      section_id: 10,
      title: 'NF-e',
      breadcrumb: 'Doc > NF-e',
      body_text: 'corpo',
      body_text_truncated: false,
      body_text_full_chars: 5,
      html_url: 'https://example/42',
      label_names: [],
      outdated: false,
      author_id: null,
      created_at: null,
      updated_at: null,
      edited_at: null,
      synced_at: '2026-05-15T03:00:00.000Z',
    });

    const result = await readResourceByUri(ctx, 'sankhya-ajuda://articles/42');
    expect(result.mimeType).toBe('text/markdown');
    expect(result.text).toContain('# NF-e');
    expect(result.lastModified).toBe('2026-05-15T03:00:00.000Z');
  });

  it('rejects sankhya-ajuda://articles without an id', async () => {
    await expect(
      readResourceByUri(ctx, 'sankhya-ajuda://articles'),
    ).rejects.toBeInstanceOf(InvalidSankhyaUriError);
  });

  it('rejects entirely unknown URIs', async () => {
    await expect(
      readResourceByUri(ctx, 'sankhya-ajuda://unknown/1'),
    ).rejects.toBeInstanceOf(InvalidSankhyaUriError);
  });
});
