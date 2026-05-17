/**
 * MCP Prompts: 4 workflow templates for Sankhya help center queries.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export interface PromptArgument {
  name: string;
  description: string;
  required: boolean;
}

export interface PromptDefinition {
  name: string;
  description: string;
  arguments: PromptArgument[];
}

export interface PromptMessage {
  role: 'user' | 'assistant';
  content: { type: 'text'; text: string };
}

export const VALID_PROMPT_NAMES = [
  'sankhya_troubleshoot',
  'sankhya_quick_lookup',
  'sankhya_explain_module',
  'sankhya_compare_articles',
] as const;

export type PromptName = (typeof VALID_PROMPT_NAMES)[number];

export const PROMPT_DEFINITIONS: PromptDefinition[] = [
  {
    name: 'sankhya_troubleshoot',
    description:
      'Guia investigacao passo-a-passo de um erro ou problema no Sankhya. Para tecnicos N1/N2.',
    arguments: [
      {
        name: 'problem',
        description: 'Descricao do erro ou comportamento inesperado no Sankhya.',
        required: true,
      },
    ],
  },
  {
    name: 'sankhya_quick_lookup',
    description:
      'Busca rapida com resposta compactada. Para suporte que precisa do artigo direto.',
    arguments: [
      {
        name: 'term',
        description: 'Termo, codigo ou nome de tela do Sankhya a localizar.',
        required: true,
      },
    ],
  },
  {
    name: 'sankhya_explain_module',
    description:
      'Explica um modulo do Sankhya citando docs oficiais. Para consultores e onboarding.',
    arguments: [
      {
        name: 'module_name',
        description: 'Nome do modulo Sankhya (ex: "Faturamento", "Estoque", "MGE").',
        required: true,
      },
    ],
  },
  {
    name: 'sankhya_compare_articles',
    description:
      'Compara N artigos do help Sankhya para detectar divergencias. Para analise tecnica.',
    arguments: [
      {
        name: 'article_ids',
        description:
          'Lista de IDs (BIGINT do Zendesk) separados por virgula, ex: "12345,67890".',
        required: true,
      },
    ],
  },
];

export interface PromptResult {
  description: string;
  messages: PromptMessage[];
}

export function handleListPrompts(): PromptDefinition[] {
  return PROMPT_DEFINITIONS;
}

export function handleGetPrompt(
  name: string,
  args: Record<string, string>,
): PromptResult | { error: string } {
  if (!VALID_PROMPT_NAMES.includes(name as PromptName)) {
    return {
      error: `Prompt invalido: "${name}". Prompts disponiveis: ${VALID_PROMPT_NAMES.join(', ')}`,
    };
  }

  const messages = generatePromptMessages(name as PromptName, args);
  const def = PROMPT_DEFINITIONS.find((d) => d.name === name);
  return {
    description: def?.description ?? name,
    messages,
  };
}

// ─── Generators ──────────────────────────────────────────────────────────────

function generatePromptMessages(
  name: PromptName,
  args: Record<string, string>,
): PromptMessage[] {
  switch (name) {
    case 'sankhya_troubleshoot': {
      const problem = args.problem ?? '(nao informado)';
      return [
        systemMessage(
          'Voce e um suporte tecnico N2 do ERP Sankhya. Investigue o problema do usuario seguindo este protocolo:\n\n' +
            'PASSO 1 (obrigatorio): sankhya_ajuda_search_articles({query: "<sintoma exato>", mode: "hybrid", limit: 7})\n' +
            'PASSO 2 (condicional): sankhya_ajuda_get_article_details({article_id: <melhor match>}) para detalhe.\n' +
            'PASSO 3 (condicional): sankhya_ajuda_list_categories() se precisar filtrar por dominio.\n\n' +
            'Apresente: causa provavel, solucao passo-a-passo, artigos referenciados (com URL), proximos passos se nao resolver.\n\n' +
            'MAXIMO: 3 tool calls. Use mode=keyword se o usuario forneceu codigo de erro especifico.',
        ),
        userMessage(`Problema reportado no Sankhya: ${problem}`),
      ];
    }

    case 'sankhya_quick_lookup': {
      const term = args.term ?? '(nao informado)';
      return [
        systemMessage(
          'Voce e um atendente de suporte do Sankhya. Resposta direta e curta:\n\n' +
            '1 TOOL CALL: sankhya_ajuda_search_articles({query: "<termo>", limit: 3})\n\n' +
            'Apresente: top-1 artigo (titulo + breadcrumb + URL + 1 paragrafo de resumo se necessario).\n' +
            'Se o usuario quiser mais detalhes, ofereca o article_id.',
        ),
        userMessage(`Busca rapida no Sankhya: ${term}`),
      ];
    }

    case 'sankhya_explain_module': {
      const module = args.module_name ?? '(nao informado)';
      return [
        systemMessage(
          'Voce e um consultor Sankhya. Explique o modulo solicitado citando docs oficiais.\n\n' +
            `PASSO 1: sankhya_ajuda_search_articles({query: "${module} Sankhya conceito", limit: 10, mode: "semantic"})\n` +
            'PASSO 2 (opcional): sankhya_ajuda_get_article_details no artigo mais relevante.\n\n' +
            'Estrutura: O que e -> Quando usar -> Pre-requisitos -> Telas principais -> Erros comuns.\n' +
            'Cite URLs do help Sankhya em cada secao.',
        ),
        userMessage(`Explique o modulo ${module} do Sankhya.`),
      ];
    }

    case 'sankhya_compare_articles': {
      const idsRaw = args.article_ids ?? '';
      const ids = idsRaw
        .split(/[,\s;]+/)
        .map((s) => s.trim())
        .filter((s) => /^\d+$/.test(s));
      return [
        systemMessage(
          'Voce e um analista tecnico Sankhya. Compare os artigos a seguir.\n\n' +
            ids
              .map((id) => `- sankhya_ajuda_get_article_details({article_id: ${id}})`)
              .join('\n') +
            '\n\nComparativo final em tabela Markdown: convergencias, divergencias, gaps.\n' +
            'Indique se algum artigo esta marcado como obsoleto.',
        ),
        userMessage(`Compare estes artigos do Sankhya: ${ids.join(', ')}`),
      ];
    }
  }
}

function systemMessage(text: string): PromptMessage {
  return { role: 'user', content: { type: 'text', text: `[System] ${text}` } };
}

function userMessage(text: string): PromptMessage {
  return { role: 'user', content: { type: 'text', text } };
}

// ─── McpServer registration ──────────────────────────────────────────────────

export function registerPrompts(server: McpServer): void {
  for (const def of PROMPT_DEFINITIONS) {
    const argsSchema = def.arguments.reduce<Record<string, z.ZodType>>(
      (acc, a) => {
        const base = z.string().describe(a.description);
        acc[a.name] = a.required ? base : base.optional();
        return acc;
      },
      {},
    );

    server.registerPrompt(
      def.name,
      {
        description: def.description,
        argsSchema,
      },
      async (rawArgs: Record<string, string | undefined>) => {
        const cleanArgs: Record<string, string> = {};
        for (const [k, v] of Object.entries(rawArgs ?? {})) {
          if (typeof v === 'string') cleanArgs[k] = v;
        }
        const result = handleGetPrompt(def.name, cleanArgs);
        if ('error' in result) {
          throw new Error(result.error);
        }
        return {
          description: result.description,
          messages: result.messages,
        };
      },
    );
  }
}
