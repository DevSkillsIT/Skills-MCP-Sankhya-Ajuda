/**
 * Centralized response formatting registry (RNF03 — MP-1.2).
 *
 * Tools never return raw JSON. All responses go through this map, which
 * also enforces the 400KB payload cap via checkResponseSize() (CI-09 / QG09).
 */

import { formatTable, formatDetail, formatEmpty } from './markdown.js';
import { checkResponseSize } from '../tools/base.js';

export type ToolFormatter = (data: unknown, args: Record<string, unknown>) => string;

/** Registry populated by entity formatters during their module load. */
export const TOOL_FORMATTERS: Record<string, ToolFormatter> = {};

/** Register a formatter for a specific tool name (called by entity.ts). */
export function registerFormatter(toolName: string, formatter: ToolFormatter): void {
  TOOL_FORMATTERS[toolName] = formatter;
}

/**
 * Format raw tool output into a Markdown string. Always falls back gracefully —
 * NEVER returns JSON.stringify.
 *
 * Always enforces the 400KB payload cap via checkResponseSize before returning.
 */
export function formatToolResponse(
  toolName: string,
  data: unknown,
  args: Record<string, unknown> = {},
): string {
  let out: string;

  if (typeof data === 'string') {
    out = data;
  } else {
    const formatter = TOOL_FORMATTERS[toolName];
    if (formatter) {
      out = formatter(data, args);
    } else {
      out = fallbackFormat(data);
    }
  }

  checkResponseSize(out);
  return out;
}

function fallbackFormat(data: unknown): string {
  if (data === null || data === undefined) {
    return formatEmpty();
  }
  if (Array.isArray(data)) {
    if (data.length === 0) return formatEmpty();
    const first = data[0] as Record<string, unknown>;
    const keys = Object.keys(first);
    return formatTable(keys, data as Array<Record<string, unknown>>);
  }
  if (typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const fields = Object.entries(obj).map(([k, v]): [string, unknown] => [k, v]);
    return formatDetail('Resultado', fields);
  }
  return formatEmpty();
}
