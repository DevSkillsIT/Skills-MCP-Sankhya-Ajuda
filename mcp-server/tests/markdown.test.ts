import { describe, it, expect } from 'vitest';
import { formatTable, formatDetail, formatEmpty } from '../src/formatters/markdown.js';

describe('formatTable', () => {
  it('builds a Markdown table with header, separator and data rows', () => {
    const md = formatTable(['ID', 'Nome'], [
      { ID: 1, Nome: 'Alfa' },
      { ID: 2, Nome: 'Beta' },
    ]);
    const lines = md.split('\n');
    expect(lines[0]).toBe('| ID | Nome |');
    expect(lines[1]).toBe('|---|---|');
    expect(lines[2]).toBe('| 1 | Alfa |');
    expect(lines[3]).toBe('| 2 | Beta |');
  });

  it('escapes pipe characters in cell values', () => {
    const md = formatTable(['Titulo'], [{ Titulo: 'a | b' }]);
    expect(md).toContain('| a \\| b |');
  });

  it('renders missing values as em-dash', () => {
    const md = formatTable(['A', 'B'], [{ A: 1 }]);
    expect(md).toContain('| 1 | — |');
  });
});

describe('formatDetail', () => {
  it('renders title and field/value rows', () => {
    const md = formatDetail('Artigo 42', [
      ['titulo', 'NF-e'],
      ['autor', null],
    ]);
    expect(md).toContain('# Artigo 42');
    expect(md).toContain('| Campo | Valor |');
    expect(md).toContain('| titulo | NF-e |');
    expect(md).toContain('| autor | — |');
  });
});

describe('formatEmpty', () => {
  it('returns a generic message when no query is provided', () => {
    const msg = formatEmpty();
    expect(msg).toContain('Nenhum resultado encontrado');
    expect(msg).toContain('Sankhya');
  });

  it('returns a query-aware suggestion when a query is provided', () => {
    const msg = formatEmpty('emissao NF-e');
    expect(msg).toContain('`emissao NF-e`');
    expect(msg).toContain('sankhya_ajuda_list_categories');
  });

  it('escapes pipe in the query rendering', () => {
    const msg = formatEmpty('a | b');
    expect(msg).toContain('`a \\| b`');
  });
});
