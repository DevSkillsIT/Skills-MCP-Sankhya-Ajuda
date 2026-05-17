import { describe, it, expect, beforeEach } from 'vitest';
import {
  formatToolResponse,
  registerFormatter,
  TOOL_FORMATTERS,
} from '../src/formatters/response-formatter.js';
import {
  McpResponseTooLargeError,
  RESPONSE_BYTE_CAP,
} from '../src/tools/base.js';

describe('formatToolResponse', () => {
  beforeEach(() => {
    // Wipe registry between tests to avoid cross-test pollution.
    for (const k of Object.keys(TOOL_FORMATTERS)) {
      delete TOOL_FORMATTERS[k];
    }
  });

  it('returns string data verbatim', () => {
    const out = formatToolResponse('some_tool', 'already markdown', {});
    expect(out).toBe('already markdown');
  });

  it('delegates to a registered formatter when one exists', () => {
    registerFormatter('test_tool', (data: unknown) => {
      const obj = data as { v: string };
      return `formatted:${obj.v}`;
    });
    const out = formatToolResponse('test_tool', { v: 'hello' }, {});
    expect(out).toBe('formatted:hello');
  });

  it('returns pre-formatted string data verbatim WITHOUT calling the formatter', () => {
    let called = false;
    registerFormatter('verbatim_tool', () => {
      called = true;
      return 'should not run';
    });
    const out = formatToolResponse('verbatim_tool', 'already markdown', {});
    expect(out).toBe('already markdown');
    expect(called).toBe(false);
  });

  it('falls back to empty message for null/undefined', () => {
    expect(formatToolResponse('unknown', null)).toContain('Nenhum resultado');
    expect(formatToolResponse('unknown', undefined)).toContain('Nenhum resultado');
  });

  it('falls back to table for arrays and detail for objects', () => {
    const arr = formatToolResponse('unknown', [{ id: 1, name: 'a' }]);
    expect(arr).toContain('| id | name |');
    expect(arr).toContain('| 1 | a |');

    const obj = formatToolResponse('unknown', { foo: 'bar' });
    expect(obj).toContain('# Resultado');
    expect(obj).toContain('| foo | bar |');
  });

  it('NEVER returns a raw JSON.stringify output', () => {
    const out = formatToolResponse('unknown', { foo: 'bar' });
    // JSON.stringify would produce {"foo":"bar"} — make sure we don't
    expect(out).not.toBe('{"foo":"bar"}');
    expect(out.startsWith('{')).toBe(false);
  });

  it('throws McpResponseTooLargeError when the output exceeds the cap', () => {
    registerFormatter('big_tool', () => 'a'.repeat(RESPONSE_BYTE_CAP + 10));
    expect(() => formatToolResponse('big_tool', null)).toThrow(McpResponseTooLargeError);
  });
});
