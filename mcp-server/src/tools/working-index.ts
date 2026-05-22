/**
 * Tool registry entry point.
 * Each tool module exports a `register(server)` function.
 *
 * Order matters only for documentation/listing; MCP itself does not depend on
 * registration order.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Pool } from 'pg';
import type { EmbeddingClient } from '../embeddings.js';
import type { Settings } from '../config.js';

import { registerSearchTool } from './search.js';
import { registerSearchUnifiedTool } from './search-unified.js';
import { registerArticleTool } from './articles.js';
import { registerCategoriesTool } from './categories.js';
import { registerSectionsTool } from './sections.js';
import { registerResourceTools } from './resource-tools.js';
import { registerPromptTools } from './prompt-tools.js';
import {
  registerGetCommunityPostTool,
  registerListCommunitySpacesTool,
} from './community.js';

export interface ToolContext {
  pool: Pool;
  embedding: EmbeddingClient;
  /**
   * False when EMBEDDING_PROVIDER does not match the model used to index the
   * DB (cross-model). Set at boot by checkIndexCompatibility().
   * When false, search forces degraded `keyword (index mismatch)` mode for
   * hybrid/semantic to prevent silent corruption of results.
   *
   * Optional: defaults to `true` (compatible) when omitted, which keeps unit
   * tests that mock ToolContext lightweight. Production always sets it
   * explicitly via index.ts.
   */
  indexCompatible?: boolean;
  /** Runtime embedding provider from config. `none` forces keyword-only search. */
  embeddingProvider?: Settings['embeddingProvider'];
}

export function registerAllTools(
  server: McpServer,
  ctx: ToolContext,
): void {
  // 4 existing domain tools
  registerSearchTool(server, ctx);
  registerArticleTool(server, ctx);
  registerCategoriesTool(server, ctx);
  registerSectionsTool(server, ctx);

  // 4 bridge tools (resources + prompts)
  registerResourceTools(server, ctx);
  registerPromptTools(server, ctx);

  // Fase 1: unified source-aware search (SPEC-SANKHYA-COMMUNITY-001)
  registerSearchUnifiedTool(server, ctx);

  // Fase 2: community domain drill-down tools (SPEC-SANKHYA-COMMUNITY-001)
  registerGetCommunityPostTool(server, ctx);
  registerListCommunitySpacesTool(server, ctx);
}
