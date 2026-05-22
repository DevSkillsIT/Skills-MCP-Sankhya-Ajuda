/**
 * Entity-specific Markdown formatters for Sankhya Ajuda tool responses.
 * Each formatter calls checkResponseSize() internally via response-formatter.
 */

import { formatTable, formatDetail, formatEmpty } from './markdown.js';
import { escapeMarkdown, truncate } from '../utils/html-stripper.js';
import { registerFormatter } from './response-formatter.js';
import type {
  SearchHit,
  ArticleFull,
  CategoryRow,
  SectionRow,
  SearchModeReported,
} from '../types.js';

// ─── formatSearchResults ─────────────────────────────────────────────────────

export interface SearchResultsInput {
  hits: SearchHit[];
  query: string;
  limit: number;
  includeOutdated: boolean;
  modeUsed: SearchModeReported;
}

export function formatSearchResults(input: SearchResultsInput): string {
  const { hits, query, limit, includeOutdated, modeUsed } = input;

  const n = hits.length;
  const shown = Math.min(n, limit);
  const modeLabel = modeLabelFor(modeUsed);
  const summary = `**${n} resultado${n === 1 ? '' : 's'}** | top-${shown} mostrado${shown === 1 ? '' : 's'} | modo: ${modeLabel}`;

  if (n === 0) {
    return `${summary}\n\n${formatEmpty(query)}`;
  }

  const rows = hits.slice(0, limit).map((hit) => {
    const title = includeOutdated && hit.outdated ? `${hit.title} (obsoleto)` : hit.title;
    const breadcrumb = hit.breadcrumb ? truncate(hit.breadcrumb, 120) : '—';
    return {
      ID: hit.id,
      Titulo: truncate(title, 120),
      Breadcrumb: breadcrumb,
      Score: hit.score.toFixed(3),
      URL: hit.html_url,
    };
  });

  const legend =
    '_Ordenado por relevancia: linha 1 = melhor match. A coluna Score so e ' +
    'comparavel DENTRO do mesmo modo (hybrid/RRF usa escala diferente de ' +
    'semantic e keyword); use a ordem das linhas, nao o valor absoluto._';
  const table = formatTable(['ID', 'Titulo', 'Breadcrumb', 'Score', 'URL'], rows);
  return `${summary}\n${legend}\n\n${table}`;
}

function modeLabelFor(mode: SearchModeReported): string {
  switch (mode) {
    case 'hybrid':
      return 'hybrid';
    case 'semantic':
      return 'semantic';
    case 'keyword':
      return 'keyword';
    case 'keyword_fallback':
      return 'keyword_fallback (vLLM indisponivel)';
    case 'keyword_index_mismatch':
      return 'keyword (index mismatch: provider != modelo do banco)';
  }
}

// ─── formatArticleDetail ─────────────────────────────────────────────────────

export interface ArticleDetailInput {
  article: ArticleFull;
  maxBodyChars: number;
}

export function formatArticleDetail(input: ArticleDetailInput): string {
  const { article, maxBodyChars } = input;
  const title = article.outdated ? `${article.title} (obsoleto)` : article.title;

  const fields: Array<[string, unknown]> = [
    ['ID', article.id],
    ['Breadcrumb', article.breadcrumb ?? '—'],
    ['URL', article.html_url],
    ['Obsoleto', article.outdated ? 'sim' : 'nao'],
    ['Autor (ID)', article.author_id ?? '—'],
    ['Criado em', article.created_at ?? '—'],
    ['Atualizado em', article.updated_at ?? '—'],
    ['Editado em', article.edited_at ?? '—'],
    ['Sincronizado em', article.synced_at],
  ];

  const header = formatDetail(title, fields);

  let content: string;
  if (article.body_text.trim().length === 0) {
    content = '_(artigo sem conteudo de corpo)_';
  } else if (article.body_text_truncated) {
    content =
      article.body_text +
      `\n\n_... (truncado em ${maxBodyChars} chars de ${article.body_text_full_chars} totais; aumente max_body_chars para ver mais)_`;
  } else {
    content = article.body_text;
  }

  const tags = article.label_names.length > 0
    ? article.label_names.map((t) => `\`${escapeMarkdown(t)}\``).join(', ')
    : '—';

  return `${header}\n\n## Conteudo\n\n${content}\n\n## Tags\n\n${tags}`;
}

// ─── formatCategoryList ──────────────────────────────────────────────────────

export function formatCategoryList(rows: CategoryRow[]): string {
  if (rows.length === 0) {
    return formatEmpty();
  }
  const summary = `**${rows.length} categoria${rows.length === 1 ? '' : 's'}** do help center Sankhya`;
  const data = rows.map((r) => ({
    ID: r.id,
    Nome: r.name,
    Artigos: r.article_count,
    URL: r.html_url,
  }));
  const table = formatTable(['ID', 'Nome', 'Artigos', 'URL'], data);
  return `${summary}\n\n${table}`;
}

// ─── formatSectionList ───────────────────────────────────────────────────────

export function formatSectionList(rows: SectionRow[]): string {
  if (rows.length === 0) {
    return formatEmpty();
  }
  const summary = `**${rows.length} ${rows.length === 1 ? 'secao' : 'secoes'}** encontrada${rows.length === 1 ? '' : 's'} no help center Sankhya`;
  const data = rows.map((r) => ({
    ID: r.id,
    Nome: r.name,
    Categoria: r.category_name,
    Parent: r.parent_section_id ?? '—',
    Artigos: r.article_count,
  }));
  const table = formatTable(['ID', 'Nome', 'Categoria', 'Parent', 'Artigos'], data);
  return `${summary}\n\n${table}`;
}

// ─── Registration on the centralized registry ────────────────────────────────

registerFormatter('sankhya_ajuda_search_articles', (data) =>
  formatSearchResults(data as SearchResultsInput),
);

registerFormatter('sankhya_ajuda_get_article_details', (data) =>
  formatArticleDetail(data as ArticleDetailInput),
);

registerFormatter('sankhya_ajuda_list_categories', (data) =>
  formatCategoryList(data as CategoryRow[]),
);

registerFormatter('sankhya_ajuda_list_sections', (data) =>
  formatSectionList(data as SectionRow[]),
);
