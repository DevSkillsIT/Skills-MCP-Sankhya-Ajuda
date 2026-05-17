/**
 * Base Markdown helpers (pure functions, no domain dependencies).
 * Mirrors omie-erp/src/formatters/markdown.ts.
 */

import { escapeMarkdown } from '../utils/html-stripper.js';

/** Build a Markdown table from headers and rows keyed by header name. */
export function formatTable(
  headers: string[],
  rows: Array<Record<string, unknown>>,
): string {
  const lines: string[] = [];

  lines.push('| ' + headers.map((h) => escapeMarkdown(h)).join(' | ') + ' |');
  lines.push('|' + headers.map(() => '---|').join(''));

  for (const row of rows) {
    const cells = headers.map((key) => {
      const val = row[key];
      if (val === undefined || val === null) return '—';
      return escapeMarkdown(String(val));
    });
    lines.push('| ' + cells.join(' | ') + ' |');
  }

  return lines.join('\n');
}

/** Format a single record as a Markdown detail view (title + field/value table). */
export function formatDetail(
  title: string,
  fields: Array<[string, unknown]>,
): string {
  const lines: string[] = [];

  lines.push(`# ${title}`);
  lines.push('');
  lines.push('| Campo | Valor |');
  lines.push('|---|---|');

  for (const [label, value] of fields) {
    const cell =
      value === undefined || value === null ? '—' : escapeMarkdown(String(value));
    lines.push(`| ${escapeMarkdown(label)} | ${cell} |`);
  }

  return lines.join('\n');
}

/**
 * Friendly pt-BR "nothing found" message tailored to Sankhya help center.
 * Accepts a context string (e.g., the original query) for a more helpful hint.
 */
export function formatEmpty(query?: string): string {
  if (query && query.length > 0) {
    const safe = escapeMarkdown(query);
    return (
      `Nenhum artigo encontrado para a consulta \`${safe}\`. ` +
      'Tente variar termos ou consulte `sankhya_ajuda_list_categories` para ver o escopo.'
    );
  }
  return 'Nenhum resultado encontrado no help center do Sankhya.';
}
