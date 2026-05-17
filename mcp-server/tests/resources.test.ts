import { describe, it, expect } from 'vitest';
import {
  parseResourceUri,
  RESOURCE_DEFINITIONS,
  RESOURCE_TEMPLATES,
  validUriList,
  InvalidSankhyaUriError,
} from '../src/resources.js';
import { MCP_RESOURCE_TYPES } from '../src/types.js';

describe('parseResourceUri', () => {
  it('parses static URIs', () => {
    expect(parseResourceUri('sankhya-ajuda://categories')).toEqual({
      type: MCP_RESOURCE_TYPES.CATEGORIES,
      id: null,
    });
    expect(parseResourceUri('sankhya-ajuda://sections')).toEqual({
      type: MCP_RESOURCE_TYPES.SECTIONS,
      id: null,
    });
    expect(parseResourceUri('sankhya-ajuda://sync_state')).toEqual({
      type: MCP_RESOURCE_TYPES.SYNC_STATE,
      id: null,
    });
  });

  it('parses template URIs with numeric id', () => {
    expect(parseResourceUri('sankhya-ajuda://articles/12345')).toEqual({
      type: MCP_RESOURCE_TYPES.ARTICLES,
      id: 12345,
    });
    expect(parseResourceUri('sankhya-ajuda://categories/7')).toEqual({
      type: MCP_RESOURCE_TYPES.CATEGORIES,
      id: 7,
    });
  });

  it('returns null for invalid URIs', () => {
    expect(parseResourceUri('http://example.com')).toBeNull();
    expect(parseResourceUri('sankhya-ajuda://')).toBeNull();
    expect(parseResourceUri('sankhya-ajuda://unknown')).toBeNull();
    expect(parseResourceUri('sankhya-ajuda://articles/not-a-number')).toBeNull();
    expect(parseResourceUri('sankhya-ajuda://articles/-1')).toBeNull();
    expect(parseResourceUri('sankhya-ajuda://articles/12345/extra')).toBeNull();
  });
});

describe('RESOURCE_DEFINITIONS / RESOURCE_TEMPLATES', () => {
  it('exposes 3 static resources and 3 templates', () => {
    expect(RESOURCE_DEFINITIONS.length).toBe(3);
    expect(RESOURCE_TEMPLATES.length).toBe(3);
  });

  it('assigns application/json only to sync_state', () => {
    const jsonOnes = RESOURCE_DEFINITIONS.filter(
      (r) => r.mimeType === 'application/json',
    );
    expect(jsonOnes.length).toBe(1);
    expect(jsonOnes[0]?.uri).toBe('sankhya-ajuda://sync_state');
  });
});

describe('validUriList', () => {
  it('returns 6 URIs (3 static + 3 templates)', () => {
    const list = validUriList();
    expect(list.length).toBe(6);
    expect(list).toContain('sankhya-ajuda://categories');
    expect(list).toContain('sankhya-ajuda://articles/{id}');
  });
});

describe('InvalidSankhyaUriError', () => {
  it('carries the offending URI in its message', () => {
    const err = new InvalidSankhyaUriError('sankhya-ajuda://bogus');
    expect(err.name).toBe('InvalidSankhyaUriError');
    expect(err.message).toContain('bogus');
  });
});
