import { describe, it, expect } from 'vitest';
import {
  createSuccessResponse,
  createErrorResponse,
  errorNotFound,
  checkResponseSize,
  McpResponseTooLargeError,
  RESPONSE_BYTE_CAP,
} from '../src/tools/base.js';

describe('createSuccessResponse', () => {
  it('wraps Markdown into a CallToolResult content array', () => {
    const result = createSuccessResponse('# Title');
    expect(result.content).toEqual([{ type: 'text', text: '# Title' }]);
    expect(result.isError).toBeUndefined();
  });
});

describe('createErrorResponse', () => {
  it('returns isError=true and renders text without code', () => {
    const result = createErrorResponse('Algo deu errado.');
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({ type: 'text', text: 'Algo deu errado.' });
  });

  it('prefixes message with code when supplied', () => {
    const result = createErrorResponse('Tente novamente.', 'EMBEDDING_UNAVAILABLE');
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toBe('**[EMBEDDING_UNAVAILABLE]** Tente novamente.');
  });
});

describe('errorNotFound', () => {
  it('builds a 3-part error with entity, id and suggestion', () => {
    const result = errorNotFound('Artigo', 12345, 'consulte sankhya_ajuda_list_categories');
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('**[NOT_FOUND]**');
    expect(text).toContain('Artigo 12345');
    expect(text).toContain('Esperado:');
    expect(text).toContain('Sugestao:');
    expect(text).toContain('sankhya_ajuda_list_categories');
  });
});

describe('checkResponseSize', () => {
  it('passes for content under the cap', () => {
    expect(() => checkResponseSize('a'.repeat(1000))).not.toThrow();
  });

  it('throws McpResponseTooLargeError when content exceeds the default cap', () => {
    const oversize = 'a'.repeat(RESPONSE_BYTE_CAP + 1);
    expect(() => checkResponseSize(oversize)).toThrow(McpResponseTooLargeError);
  });

  it('respects custom limit override', () => {
    expect(() => checkResponseSize('a'.repeat(101), 100)).toThrow(McpResponseTooLargeError);
  });

  it('measures UTF-8 bytes, not character length (multibyte safe)', () => {
    // 'á' is 2 bytes in UTF-8 — 60 chars = 120 bytes
    const multibyte = 'á'.repeat(60);
    expect(() => checkResponseSize(multibyte, 119)).toThrow(McpResponseTooLargeError);
    expect(() => checkResponseSize(multibyte, 120)).not.toThrow();
  });
});
