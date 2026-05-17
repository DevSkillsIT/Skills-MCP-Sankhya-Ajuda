/**
 * Index/provider compatibility guardrail (v1.5.4).
 *
 * The DB stores `articles.embedding_model` for every indexed article. At boot,
 * we read that value and compare against the configured EMBEDDING_PROVIDER.
 *
 * If the names don't match, semantic / hybrid queries would return
 * mathematically random results (cross-model cosine similarity). To prevent
 * silent corruption of search results, we set a process-wide flag and the
 * search handler forces a degraded `keyword (index mismatch)` mode.
 *
 * Rationale: see SPEC RF07 / AD-003 / Risco 3 and the 2026-05-16 empirical
 * validation (top-1 score 0.739 vs 0.052 cross-model).
 */

import type { Pool } from './db.js';
import type { Settings } from './config.js';

export interface IndexCompatResult {
  /** Whether the DB embedding model is compatible with the configured provider. */
  compatible: boolean;
  /** Provider currently configured. */
  provider: 'vllm' | 'openai' | 'none';
  /** Distinct `embedding_model` values found in the DB (excluding NULL). */
  dbModels: string[];
  /** Model name expected by the configured provider. */
  expectedModel: string;
  /** Human-readable explanation when incompatible. */
  reason: string | null;
}

/**
 * Inspect `articles.embedding_model` distinct values and decide whether the
 * configured provider's model can produce semantically valid queries against
 * the existing vectors.
 */
export async function checkIndexCompatibility(
  pool: Pool,
  settings: Settings,
): Promise<IndexCompatResult> {
  const provider = settings.embeddingProvider;

  if (provider === 'none') {
    return {
      compatible: true,
      provider,
      dbModels: [],
      expectedModel: '(no embedding queries)',
      reason: null,
    };
  }

  const expectedModel =
    provider === 'vllm' ? settings.vllm.model : settings.openai.model;

  const { rows } = await pool.query<{ embedding_model: string | null; n: string }>(
    `SELECT embedding_model, COUNT(*)::text AS n
       FROM articles
      WHERE embedding IS NOT NULL
   GROUP BY embedding_model
   ORDER BY COUNT(*) DESC;`,
  );

  const dbModels = rows
    .map((r) => r.embedding_model ?? '')
    .filter((s) => s.length > 0);

  if (dbModels.length === 0) {
    // No indexed vectors at all — semantic queries can't be meaningful but
    // also can't be wrong. Treat as compatible (search will return 0 hits).
    return {
      compatible: true,
      provider,
      dbModels: [],
      expectedModel,
      reason: null,
    };
  }

  const compatible = dbModels.some((m) => modelsMatch(m, expectedModel, provider));

  if (compatible) {
    return {
      compatible: true,
      provider,
      dbModels,
      expectedModel,
      reason: null,
    };
  }

  return {
    compatible: false,
    provider,
    dbModels,
    expectedModel,
    reason:
      `Index foi populado com [${dbModels.join(', ')}] mas EMBEDDING_PROVIDER=${provider} ` +
      `usaria queries do modelo "${expectedModel}". Cosine similarity cross-model e ` +
      'matematicamente invalido (SPEC RF07/AD-003). Acoes: (a) re-indexar o banco com o ' +
      'modelo do provider escolhido, OU (b) trocar EMBEDDING_PROVIDER para o modelo que ' +
      'indexou o banco, OU (c) usar EMBEDDING_PROVIDER=none.',
  };
}

/**
 * Loose match — DB stores arbitrary strings (e.g. "/model" for our vLLM, or
 * "text-embedding-3-large" for OpenAI). Matching strategy:
 *
 *   1. Exact match (case-insensitive).
 *   2. Either side contains the other as substring (case-insensitive).
 *   3. Provider-family heuristic: OpenAI models all start with
 *      "text-embedding"; everything else is treated as a local/custom vLLM.
 */
export function modelsMatch(
  dbModel: string,
  expected: string,
  provider: 'vllm' | 'openai' | 'none',
): boolean {
  if (provider === 'none') return true;

  const a = dbModel.toLowerCase().trim();
  const b = expected.toLowerCase().trim();

  if (a === b) return true;
  if (a.length > 0 && b.length > 0 && (a.includes(b) || b.includes(a))) return true;

  const isOpenAiDb = a.startsWith('text-embedding');
  const isOpenAiProvider = provider === 'openai';

  // Family mismatch: any DB model that isn't from the OpenAI family is treated
  // as local/custom (vLLM-like). Cross-family = incompatible.
  if (isOpenAiDb !== isOpenAiProvider) return false;

  // Same family (both OpenAI or both non-OpenAI) but specific names differ —
  // be conservative and reject.
  return false;
}
