/**
 * HTML stripping, text truncation, and Markdown escaping utilities.
 *
 * Implementation: TypeScript-native (no dependency on Phase 1 Python parser).
 * Covers the same Brazilian Portuguese entities the Phase 1 clean_html() covers.
 */

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  // Brazilian Portuguese diacritics commonly seen in Zendesk help content.
  '&aacute;': 'á',
  '&Aacute;': 'Á',
  '&acirc;': 'â',
  '&Acirc;': 'Â',
  '&atilde;': 'ã',
  '&Atilde;': 'Ã',
  '&agrave;': 'à',
  '&Agrave;': 'À',
  '&eacute;': 'é',
  '&Eacute;': 'É',
  '&ecirc;': 'ê',
  '&Ecirc;': 'Ê',
  '&iacute;': 'í',
  '&Iacute;': 'Í',
  '&oacute;': 'ó',
  '&Oacute;': 'Ó',
  '&ocirc;': 'ô',
  '&Ocirc;': 'Ô',
  '&otilde;': 'õ',
  '&Otilde;': 'Õ',
  '&uacute;': 'ú',
  '&Uacute;': 'Ú',
  '&ccedil;': 'ç',
  '&Ccedil;': 'Ç',
  '&ordm;': 'º',
  '&ordf;': 'ª',
  '&deg;': '°',
  '&middot;': '·',
  '&hellip;': '…',
  '&ndash;': '–',
  '&mdash;': '—',
  '&laquo;': '«',
  '&raquo;': '»',
  '&euro;': '€',
  '&copy;': '©',
  '&reg;': '®',
  '&trade;': '™',
};

/**
 * Strip HTML tags and decode common Brazilian Portuguese entities.
 * Preserves paragraph breaks by inserting newlines after block-level closes.
 */
export function stripHtml(html: string): string {
  if (!html) return '';

  // Preserve paragraph and line breaks before tag removal.
  let result = html
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');

  // Remove style/script blocks entirely.
  result = result.replace(/<style[\s\S]*?<\/style>/gi, '');
  result = result.replace(/<script[\s\S]*?<\/script>/gi, '');

  // Remove all remaining tags.
  result = result.replace(/<[^>]*>/g, '');

  // Decode named entities.
  for (const [entity, char] of Object.entries(HTML_ENTITIES)) {
    result = result.replaceAll(entity, char);
  }

  // Decode numeric entities (decimal and hex).
  result = result.replace(/&#(\d+);/g, (_m, code) =>
    String.fromCodePoint(parseInt(code, 10)),
  );
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_m, code) =>
    String.fromCodePoint(parseInt(code, 16)),
  );

  // Normalize whitespace.
  result = result.replace(/[ \t]{2,}/g, ' ');
  result = result.replace(/\n{3,}/g, '\n\n');

  return result.trim();
}

/**
 * Truncate a string with an ellipsis marker, returning the original when short.
 *
 * Operates on Unicode code points (not UTF-16 code units) so that surrogate
 * pairs (emoji, astral-plane characters) are never split at the boundary.
 * The ellipsis character '…' counts as one code point in the output.
 */
export function truncate(text: string, maxLen: number = 300): string {
  // Fast path: .length counts UTF-16 units; if it is already within the limit
  // then no code point can be over the limit either (BMP chars are 1 unit each,
  // and an astral pair is 2 units => even more over budget if present).
  if (text.length <= maxLen) return text;

  // Spread into code points to avoid splitting surrogate pairs.
  const codePoints = [...text];
  if (codePoints.length <= maxLen) return text;

  // Keep (maxLen - 1) code points and append the ellipsis (1 code point),
  // matching the original semantics exactly.
  return codePoints.slice(0, Math.max(0, maxLen - 1)).join('') + '…';
}

/**
 * Escape characters that would break Markdown tables (pipe, newline, backtick).
 */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ')
    .replace(/`/g, '\\`');
}
