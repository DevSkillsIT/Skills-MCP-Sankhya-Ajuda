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

  // Hardening: code-point safety for surrogate pairs (emoji / astral plane).
  it('truncates at code-point boundary — emoji is never split into a broken surrogate', () => {
    // Each emoji below is a surrogate pair: 2 UTF-16 units but 1 code point.
    // A string of 5 emoji = 10 UTF-16 units (length 10), but only 5 code points.
    const fiveEmoji = '😀😁😂😃😄'; // 5 code points, .length === 10
    expect(fiveEmoji.length).toBe(10); // sanity-check: JS .length counts units

    // Truncate to maxLen=3: should keep 2 code points + '…' = 3 code points total.
    const out = truncate(fiveEmoji, 3);

    // The result must be exactly 2 emoji + ellipsis (3 code points).
    const outCodePoints = [...out];
    expect(outCodePoints).toHaveLength(3);

    // The last code point must be the ellipsis marker.
    expect(outCodePoints[outCodePoints.length - 1]).toBe('…');

    // The first two code points must each be a valid single emoji (not a lone surrogate).
    // A lone surrogate would be U+D800–U+DFFF; a valid emoji round-trips through encode/decode.
    for (const cp of outCodePoints.slice(0, 2)) {
      expect(() => encodeURIComponent(cp)).not.toThrow();
    }
  });

  it('returns the original string unchanged when emoji string fits within maxLen', () => {
    const threeEmoji = '🚀🎉🔥'; // 3 code points, .length === 6
    // maxLen=5 is larger than 3 code points, so no truncation should occur.
    expect(truncate(threeEmoji, 5)).toBe(threeEmoji);
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

  it('escapes square brackets (prevents reference-link mangling)', () => {
    expect(escapeMarkdown('[nItem: 999]')).toBe('\\[nItem: 999\\]');
    expect(escapeMarkdown("[nRec:'XXXXXXXXXXX']")).toBe("\\[nRec:'XXXXXXXXXXX'\\]");
    expect(escapeMarkdown('[IdentificacaoRps]')).toBe('\\[IdentificacaoRps\\]');
  });

  it('escapes underscores (prevents accidental italic)', () => {
    expect(escapeMarkdown('c_motivo_extra')).toBe('c\\_motivo\\_extra');
    expect(escapeMarkdown('_versao_2026')).toBe('\\_versao\\_2026');
  });

  it('escapes asterisks (prevents accidental italic/bold)', () => {
    expect(escapeMarkdown('*texto*')).toBe('\\*texto\\*');
    expect(escapeMarkdown('**bold**')).toBe('\\*\\*bold\\*\\*');
  });

  it('handles real SEFAZ title from corpus (regression)', () => {
    const real = '1039 Rejeição: nItem do DFeReferenciado informado indevidamente [nItem: 999]';
    const escaped = escapeMarkdown(real);
    expect(escaped).toContain('\\[nItem: 999\\]');
    expect(escaped).not.toMatch(/(?<!\\)\[/); // no unescaped [
    expect(escaped).not.toMatch(/(?<!\\)\]/); // no unescaped ]
  });

  // NOTE: escapeMarkdown is intentionally NOT idempotent. Calling it twice
  // would double-escape (e.g. `\|` → `\\|`). Callers must invoke exactly once
  // per cell value. This is documented in the function's docstring, not asserted
  // here, because asserting a non-property would just add maintenance noise.
});
