import { describe, it, expect } from 'vitest';
import {
  formatSearchResults,
  formatArticleDetail,
  formatCategoryList,
  formatSectionList,
} from '../src/formatters/entity.js';
import type {
  SearchHit,
  ArticleFull,
  CategoryRow,
  SectionRow,
} from '../src/types.js';

const HIT: SearchHit = {
  id: 12345,
  title: 'Emissao de NF-e',
  breadcrumb: 'Documentacao > NF-e > Emissao',
  html_url: 'https://ajuda.sankhya.com.br/hc/pt-br/articles/12345',
  outdated: false,
  score: 0.871,
};

describe('formatSearchResults', () => {
  it('renders summary with mode and a 5-column table for one hit', () => {
    const md = formatSearchResults({
      hits: [HIT],
      query: 'nf-e',
      limit: 5,
      includeOutdated: false,
      modeUsed: 'hybrid',
    });
    expect(md).toContain('**1 resultado**');
    expect(md).toContain('modo: hybrid');
    expect(md).toContain('| ID | Titulo | Breadcrumb | Score | URL |');
    expect(md).toContain('12345');
    expect(md).toContain('0.871');
  });

  it('shows keyword_fallback metadata line when vLLM is down', () => {
    const md = formatSearchResults({
      hits: [HIT],
      query: 'nf-e',
      limit: 5,
      includeOutdated: false,
      modeUsed: 'keyword_fallback',
    });
    expect(md).toContain('keyword_fallback (vLLM indisponivel)');
  });

  it('suffixes "(obsoleto)" only when include_outdated=true and hit.outdated=true (CI-08 / RF08)', () => {
    const obsolete: SearchHit = { ...HIT, outdated: true };

    const without = formatSearchResults({
      hits: [obsolete],
      query: 'nf-e',
      limit: 5,
      includeOutdated: false,
      modeUsed: 'hybrid',
    });
    expect(without).not.toContain('(obsoleto)');

    const withFlag = formatSearchResults({
      hits: [obsolete],
      query: 'nf-e',
      limit: 5,
      includeOutdated: true,
      modeUsed: 'hybrid',
    });
    expect(withFlag).toContain('(obsoleto)');
  });

  it('falls back to friendly empty message when no hits', () => {
    const md = formatSearchResults({
      hits: [],
      query: 'xyz123',
      limit: 5,
      includeOutdated: false,
      modeUsed: 'hybrid',
    });
    expect(md).toContain('Nenhum artigo encontrado');
    expect(md).toContain('`xyz123`');
  });
});

const ARTICLE: ArticleFull = {
  id: 12345,
  section_id: 999,
  title: 'Emissao de NF-e',
  breadcrumb: 'Documentacao > NF-e',
  body_text: 'Conteudo do artigo',
  body_text_truncated: false,
  body_text_full_chars: 18,
  html_url: 'https://ajuda.sankhya.com.br/hc/pt-br/articles/12345',
  label_names: ['nfe', 'fiscal'],
  outdated: false,
  author_id: 42,
  created_at: '2023-01-01T00:00:00.000Z',
  updated_at: '2024-06-01T00:00:00.000Z',
  edited_at: null,
  synced_at: '2026-05-15T03:00:00.000Z',
};

describe('formatArticleDetail', () => {
  it('renders title, fields, content section and tags', () => {
    const md = formatArticleDetail({ article: ARTICLE, maxBodyChars: 6000 });
    expect(md).toContain('# Emissao de NF-e');
    expect(md).toContain('| ID | 12345 |');
    expect(md).toContain('## Conteudo');
    expect(md).toContain('Conteudo do artigo');
    expect(md).toContain('## Tags');
    expect(md).toContain('`nfe`');
  });

  it('marks title with (obsoleto) when article.outdated=true', () => {
    const md = formatArticleDetail({
      article: { ...ARTICLE, outdated: true },
      maxBodyChars: 6000,
    });
    expect(md).toContain('# Emissao de NF-e (obsoleto)');
    expect(md).toContain('| Obsoleto | sim |');
  });

  it('appends truncation marker when body is truncated', () => {
    const md = formatArticleDetail({
      article: {
        ...ARTICLE,
        body_text: 'cortado',
        body_text_truncated: true,
        body_text_full_chars: 50000,
      },
      maxBodyChars: 100,
    });
    expect(md).toContain('truncado em 100 chars');
    expect(md).toContain('50000');
  });
});

describe('formatCategoryList / formatSectionList', () => {
  const cat: CategoryRow = {
    id: 1,
    name: 'Documentacao de Telas',
    html_url: 'https://ajuda.sankhya.com.br/hc/pt-br/categories/1',
    position: 1,
    article_count: 100,
    synced_at: '2026-05-15T03:00:00.000Z',
  };
  const sec: SectionRow = {
    id: 10,
    category_id: 1,
    category_name: 'Documentacao de Telas',
    parent_section_id: null,
    name: 'NF-e',
    html_url: 'https://ajuda.sankhya.com.br/hc/pt-br/sections/10',
    position: 0,
    article_count: 25,
    synced_at: '2026-05-15T03:00:00.000Z',
  };

  it('builds categories table with 4 columns', () => {
    const md = formatCategoryList([cat]);
    expect(md).toContain('| ID | Nome | Artigos | URL |');
    expect(md).toContain('Documentacao de Telas');
  });

  it('builds sections table with 5 columns', () => {
    const md = formatSectionList([sec]);
    expect(md).toContain('| ID | Nome | Categoria | Parent | Artigos |');
    expect(md).toContain('| 10 | NF-e |');
  });
});
