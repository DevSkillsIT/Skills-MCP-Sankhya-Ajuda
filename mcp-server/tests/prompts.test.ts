import { describe, it, expect } from 'vitest';
import {
  handleListPrompts,
  handleGetPrompt,
  VALID_PROMPT_NAMES,
} from '../src/prompts.js';

describe('handleListPrompts', () => {
  it('returns 4 prompts with required arguments declared', () => {
    const list = handleListPrompts();
    expect(list.length).toBe(4);
    expect(list.map((p) => p.name).sort()).toEqual(
      [...VALID_PROMPT_NAMES].sort(),
    );
  });
});

describe('handleGetPrompt', () => {
  it('rejects unknown prompt names with a clear error', () => {
    const result = handleGetPrompt('sankhya_xpto', {});
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('Prompts disponiveis');
    }
  });

  it('returns messages[] with a system + user pair for known names', () => {
    for (const name of VALID_PROMPT_NAMES) {
      const result = handleGetPrompt(name, {
        problem: 'erro de teste',
        term: 'pedido',
        module_name: 'Faturamento',
        article_ids: '1,2,3',
      });
      expect('messages' in result).toBe(true);
      if ('messages' in result) {
        expect(result.messages.length).toBeGreaterThan(0);
        expect(result.messages[0]?.content.type).toBe('text');
      }
    }
  });

  it('rejects a known prompt when a required argument is missing or blank', () => {
    for (const [name, args] of [
      ['sankhya_troubleshoot', {}],
      ['sankhya_quick_lookup', { term: '   ' }],
      ['sankhya_explain_module', {}],
      ['sankhya_compare_articles', {}],
    ] as const) {
      const result = handleGetPrompt(name, args);
      expect('error' in result, `expected error for ${name}`).toBe(true);
      if ('error' in result) {
        expect(result.code).toBe('MISSING_ARGUMENT');
        expect(result.error).toContain('obrigatorio');
      }
    }
  });

  it('embeds the troubleshoot problem in the user message', () => {
    const result = handleGetPrompt('sankhya_troubleshoot', { problem: 'erro X' });
    expect('messages' in result).toBe(true);
    if ('messages' in result) {
      const allText = result.messages
        .map((m) => m.content.text)
        .join('\n');
      expect(allText).toContain('erro X');
    }
  });
});
