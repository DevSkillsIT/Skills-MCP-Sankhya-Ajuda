/**
 * Sankhya Ajuda MCP server factory.
 *
 * Builds the per-session McpServer instance, registers tools/resources/prompts,
 * and returns the instance ready to be connected to a transport.
 *
 * Mirrors omie-erp/src/server.ts and gseonline/src/server.ts.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Pool } from 'pg';
import { registerAllTools } from './tools/working-index.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';
import type { EmbeddingClient } from './embeddings.js';
import type { Settings } from './config.js';
import { SERVER_VERSION } from './version.js';

// ─── Static instructions (RF05, RNF03 token economy) ─────────────────────────

/**
 * Static MCP server instructions (<= 2000 chars, no dynamic data — MP-10.4).
 * Returned in every initialize handshake.
 */
export const SERVER_INSTRUCTIONS = `MCP do Help Center publico do Sankhya ERP (ajuda.sankhya.com.br, Zendesk).
Mais de 6.000 artigos indexados em pt-BR. Somente leitura.

REGRAS CRITICAS:
1. ECONOMIA: 1 call de search_articles ja retorna top-N com breadcrumb. Nao
   chame get_article_details em loop.
2. LIMIT default 15 (max 50). Use 5 para resposta rapida, 25-50 para analise
   comparativa ou exploracao de tema novo. Corpus tem mais de 6.000 artigos, 64%
   concentrados em 2 categorias (Solucao de Problemas + Documentacao de Telas).
3. BUSCA HIBRIDA: mode=hybrid (default) combina semantica + FTS via RRF.
   Use semantic para sinonimos, keyword para codigo de erro/nome exato.
4. OBSOLETOS: include_outdated=false default. So passe true se pedido.
5. CATEGORIA: list_categories() antes de filtrar busca por category_id.
6. ARTIGOS LONGOS: max_body_chars default 8000 (cobre 92% completo). Aumente para comparacao.
7. FALLBACK: hybrid degrada para keyword_fallback se embeddings caem.
   semantic retorna EMBEDDING_UNAVAILABLE. keyword nunca chama embeddings.
8. CROSS-MODEL: se provider != modelo do banco, semantic forca keyword com
   label keyword_index_mismatch (sem ranking semantico ruidoso).
9. RESOURCES sankhya-ajuda://: navegacao livre sem side effects.
10. PROMPTS: 4 templates (troubleshoot, quick_lookup, explain_module,
    compare_articles). list_prompt_catalog para detalhes.

TOOLS:
- sankhya_ajuda_search_articles(query, limit?=15, category_id?, include_outdated?, mode?)
- sankhya_ajuda_get_article_details(article_id, max_body_chars?=8000)
- sankhya_ajuda_list_categories()
- sankhya_ajuda_list_sections(category_id?, parent_section_id?)
- bridge: sankhya_ajuda_list_mcp_resources, sankhya_ajuda_read_resource_by_uri,
  sankhya_ajuda_list_prompt_catalog, sankhya_ajuda_get_prompt_by_name

FORMATOS: Datas ISO 8601, respostas Markdown, IDs BIGINT do Zendesk.`;

// ─── Factory ──────────────────────────────────────────────────────────────────

export interface CreateServerOptions {
  pool: Pool;
  embedding: EmbeddingClient;
  /** Cross-model index compatibility flag (v1.5.4). See index-compat.ts. */
  indexCompatible?: boolean;
  embeddingProvider?: Settings['embeddingProvider'];
}

/**
 * Create a fresh McpServer instance configured with tools, resources and
 * prompts. One instance per session — DO NOT share across HTTP sessions
 * (StreamableHTTPServerTransport SDK constraint).
 */
export function createServer(opts: CreateServerOptions): McpServer {
  const server = new McpServer(
    {
      name: '@skillsit/sankhya-ajuda-mcp',
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  const ctx = {
    pool: opts.pool,
    embedding: opts.embedding,
    indexCompatible: opts.indexCompatible ?? true,
    embeddingProvider: opts.embeddingProvider ?? 'vllm',
  };

  registerAllTools(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server);

  return server;
}
