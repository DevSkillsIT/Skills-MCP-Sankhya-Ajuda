/**
 * R9 Investigation: measure community result counts pre/post distThreshold
 * for 4 representative queries.
 *
 * Run with:
 *   RUN_DB_SMOKE=1 npx --prefix /opt/mcp-servers/sankhya_ajuda/mcp-server \
 *     vitest run tests/integration/r9-threshold-investigation.ts
 *
 * This script is investigative — not part of the automated test suite.
 * It intentionally has no assertions; it only logs metrics.
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenvConfig({ path: resolve(__dirname, '../../.env'), override: false });

import { describe, it, beforeAll, afterAll } from 'vitest';
import { buildPool, hybridSearchCommunity } from '../../src/db.js';
import { buildEmbeddingClient } from '../../src/embeddings.js';
import { getSettings, _resetSettingsCache } from '../../src/config.js';
import type { Pool } from '../../src/db.js';
import type { EmbeddingClient } from '../../src/embeddings.js';

const RUN_SMOKE = process.env['RUN_DB_SMOKE'] === '1';

describe.skipIf(!RUN_SMOKE)('R9 — COMMUNITY_DIST_THRESHOLD investigation (informational only)', () => {
  let pool: Pool;
  let embedding: EmbeddingClient;

  beforeAll(async () => {
    _resetSettingsCache();
    const settings = getSettings();
    pool = await buildPool(settings);
    embedding = buildEmbeddingClient(settings);
  }, 30_000);

  afterAll(async () => {
    await pool.end();
  });

  const QUERIES = [
    'erro ao confirmar nota fiscal',
    'como criar processo no Sankhya Flow BPM',
    'integracao Sankhya via API REST com Python',
    'parametrizacao regras da reforma tributaria',
  ] as const;

  const THRESHOLD = 0.45;
  const LIMIT = 50;

  for (const query of QUERIES) {
    it(`threshold investigation: "${query}"`, async () => {
      const qvec = await embedding.embed(query);

      // Without threshold (distThreshold=null) — baseline count
      const noThresh = await hybridSearchCommunity(pool, {
        query,
        qvec,
        limit: LIMIT,
        mode: 'hybrid',
        distThreshold: null,
      });

      // With current default threshold (0.45)
      const withThresh = await hybridSearchCommunity(pool, {
        query,
        qvec,
        limit: LIMIT,
        mode: 'hybrid',
        distThreshold: THRESHOLD,
      });

      const filtered = noThresh.filter(
        (h) => !new Set(withThresh.map((w) => w.id)).has(h.id),
      );

      console.warn(`\n[R9] Query: "${query}"`);
      console.warn(`     Without threshold: ${noThresh.length} results`);
      console.warn(`     With threshold ${THRESHOLD}: ${withThresh.length} results`);
      console.warn(`     Filtered out: ${filtered.length}`);

      if (filtered.length > 0) {
        console.warn(`     Filtered titles (first 5):`);
        for (const h of filtered.slice(0, 5)) {
          const space = h.context ?? 'null';
          console.warn(`       - [${space}] ${h.title}`);
        }
      } else {
        console.warn(`     No results filtered by threshold (all results within distance)`);
      }

      // Informational: show top-5 from each to compare quality
      console.warn(`     Top-5 WITHOUT threshold:`);
      for (const h of noThresh.slice(0, 5)) {
        console.warn(`       score=${h.score.toFixed(4)} [${h.context ?? 'null'}] ${h.title}`);
      }
      console.warn(`     Top-5 WITH threshold:`);
      for (const h of withThresh.slice(0, 5)) {
        console.warn(`       score=${h.score.toFixed(4)} [${h.context ?? 'null'}] ${h.title}`);
      }

      // No assertion — this is pure investigation
    }, 30_000);
  }
});

describe.skipIf(RUN_SMOKE)('R9 — investigation (GUARDED — set RUN_DB_SMOKE=1 to enable)', () => {
  it('is skipped in default test runs', () => {
    // Always passes — documents purpose only
  });
});
