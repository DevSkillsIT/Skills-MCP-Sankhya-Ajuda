import { describe, it, expect } from 'vitest';
import { stripHtml, truncate, escapeMarkdown } from '../src/utils/html-stripper.js';

describe('stripHtml', () => {
  it('removes simple HTML tags and trims whitespace', () => {
    expect(stripHtml('<p>Hello <b>world</b></p>')).toBe('Hello world');
  });

  it('decodes basic HTML entities', () => {
    expect(stripHtml('&amp; &lt;ok&gt; &quot;x&quot;')).toBe('& <ok> "x"');
  });

  it('decodes Brazilian Portuguese named entities', () => {
    expect(stripHtml('&aacute;guia &ccedil;&atilde;o &ordm;')).toBe('águia ção º');
    expect(stripHtml('1&deg; lugar')).toBe('1° lugar');
  });

  it('decodes numeric entities (decimal and hex)', () => {
    expect(stripHtml('&#225;guia')).toBe('águia');
    expect(stripHtml('&#xE1;guia')).toBe('águia');
  });

  it('strips style and script blocks entirely', () => {
    const html = '<style>body{color:red}</style><p>oi</p><script>alert(1)</script>';
    expect(stripHtml(html)).toBe('oi');
  });

  it('preserves paragraph breaks as newlines', () => {
    const md = stripHtml('<p>linha 1</p><p>linha 2</p>');
    expect(md).toContain('linha 1');
    expect(md).toContain('linha 2');
    expect(md.includes('\n')).toBe(true);
  });

  it('handles empty input', () => {
    expect(stripHtml('')).toBe('');
  });
});

describe('truncate', () => {
  it('returns the original string when under the limit', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates and appends ellipsis when over the limit', () => {
    const out = truncate('abcdefghij', 5);
    expect(out).toBe('abcd…');
    expect(out.length).toBe(5);
  });

  it('respects the default maxLen of 300', () => {
    const long = 'x'.repeat(500);
    const out = truncate(long);
    expect(out.length).toBe(300);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('escapeMarkdown', () => {
  it('escapes pipe characters', () => {
    expect(escapeMarkdown('a|b')).toBe('a\\|b');
  });

  it('flattens newlines to spaces', () => {
    expect(escapeMarkdown('line1\nline2')).toBe('line1 line2');
  });

  it('escapes backticks', () => {
    expect(escapeMarkdown('`code`')).toBe('\\`code\\`');
  });
});
