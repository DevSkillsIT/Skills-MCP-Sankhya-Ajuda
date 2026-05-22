/**
 * Base tool helpers: success/error response builders, NOT_FOUND helper, and
 * the McpResponseTooLargeError used by the 400KB cap (RNF02 / QG09 / CI-09).
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import pino from 'pino';

/** Hard cap on a single tool response body in bytes (RNF02 / MP-10.2). */
export const RESPONSE_BYTE_CAP = 400_000;

/**
 * Server-side logger for tool error detail. The raw error is logged HERE and
 * never echoed to the client (see createInternalErrorResponse).
 */
const toolErrorLog = pino({ name: 'sankhya-ajuda-tools' });

/** Thrown when a tool response exceeds RESPONSE_BYTE_CAP. */
export class McpResponseTooLargeError extends Error {
  public readonly size: number;
  public readonly limit: number;

  constructor(size: number, limit: number = RESPONSE_BYTE_CAP) {
    super(
      `Resposta excedeu o limite de ${limit.toLocaleString('pt-BR')} bytes ` +
        `(${size.toLocaleString('pt-BR')} bytes). ` +
        'Esperado: resposta dentro do cap de 400KB. ' +
        'Sugestao: reduza `limit` ou `max_body_chars` na chamada.',
    );
    this.name = 'McpResponseTooLargeError';
    this.size = size;
    this.limit = limit;
  }
}

/** Build a successful MCP tool result wrapping Markdown text. */
export function createSuccessResponse(markdown: string): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: markdown,
      },
    ],
  };
}

/**
 * Build a 3-part error MCP tool result (MELHORES-PRATICAS 9.2):
 *  - what failed
 *  - expected state
 *  - actionable suggestion
 *
 * @param message - Already-composed 3-part pt-BR message.
 * @param code    - Optional machine-readable error code.
 */
export function createErrorResponse(
  message: string,
  code?: string,
): CallToolResult {
  const text = code ? `**[${code}]** ${message}` : message;
  return {
    content: [
      {
        type: 'text',
        text,
      },
    ],
    isError: true,
  };
}

/**
 * Build an INTERNAL_ERROR response WITHOUT leaking internal detail to the
 * client. The raw error — which may expose DB schema, SQL fragments, connection
 * strings, or filesystem paths — is logged server-side only; the caller gets a
 * generic, actionable pt-BR message.
 *
 * @param err           - The caught error (logged server-side, never returned).
 * @param clientMessage - Already-composed 3-part pt-BR message (what failed +
 *   Esperado + Sugestao). Do NOT append the raw error to it.
 */
export function createInternalErrorResponse(
  err: unknown,
  clientMessage: string,
): CallToolResult {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  toolErrorLog.error({ detail }, 'tool internal error');
  return createErrorResponse(clientMessage, 'INTERNAL_ERROR');
}

/**
 * Convenience builder for NOT_FOUND tool errors.
 *
 * @param entity     - Entity type label (e.g. "Post", "Artigo").
 * @param identifier - The identifier that was not found.
 * @param suggestion - Actionable suggestion for the caller.
 * @param expected   - Optional override for the "Esperado" clause.
 *   Defaults to "identificador valido do help center" to preserve
 *   existing get_article_details behaviour (R5).
 */
export function errorNotFound(
  entity: string,
  identifier: string | number,
  suggestion: string,
  expected?: string,
): CallToolResult {
  const expectedClause = expected ?? 'identificador valido do help center';
  const message =
    `${entity} ${identifier} nao encontrado no Sankhya. ` +
    `Esperado: ${expectedClause}. ` +
    `Sugestao: ${suggestion}`;
  return createErrorResponse(message, 'NOT_FOUND');
}

/**
 * Measure the UTF-8 byte size of a Markdown payload and throw when it exceeds
 * the configured cap. Called by all entity formatters before returning text.
 */
export function checkResponseSize(
  content: string,
  limit: number = RESPONSE_BYTE_CAP,
): void {
  const size = Buffer.byteLength(content, 'utf8');
  if (size > limit) {
    throw new McpResponseTooLargeError(size, limit);
  }
}
