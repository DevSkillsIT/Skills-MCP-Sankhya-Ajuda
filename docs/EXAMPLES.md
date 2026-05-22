<!--
  Sankhya Ajuda MCP - Cenarios Praticos de Uso
  Skills IT - Solucoes em Tecnologia
  https://www.skillsit.com.br  |  (63) 3224-4925  |  Palmas-TO-Brasil
-->

# Exemplos Práticos — Sankhya Ajuda MCP

> Cenários reais de uso do MCP em diferentes contextos: **suporte técnico (N1/N2)**, **consultoria**, **onboarding de colaboradores**, **análise técnica**, **comparativos** e **integrações automatizadas**.

Todos os exemplos são **agnósticos ao cliente MCP** (funcionam em Claude Desktop, Claude Code, Cursor, VS Code Copilot, ChatGPT/OpenAI Responses API, ou qualquer cliente compatível com MCP 2025-11-25 sobre Streamable HTTP).

---

## Índice

1. [Convenção de prompts](#convenção-de-prompts)
2. [Suporte Técnico N1 — Dia a Dia](#suporte-técnico-n1--dia-a-dia)
3. [Suporte Técnico N2 — Troubleshooting](#suporte-técnico-n2--troubleshooting)
4. [Consultoria e Onboarding](#consultoria-e-onboarding)
5. [Análise Técnica e Auditoria](#análise-técnica-e-auditoria)
6. [Comparativos entre Artigos](#comparativos-entre-artigos)
7. [Casos de Reforma Tributária](#casos-de-reforma-tributária)
8. [Uso Programático (chamadas diretas)](#uso-programático-chamadas-diretas)
9. [Comunidade — Busca e Drill-Down](#comunidade--busca-e-drill-down)
10. [Padrões Anti-Hallucination](#padrões-anti-hallucination)

---

## Convenção de prompts

Todos os exemplos abaixo são **prompts em linguagem natural** que a LLM cliente recebe. Para evitar colisão com outros MCPs e ajudar o roteamento de tools, **prefixe os pedidos com a palavra-chave "Sankhya"**.

> Exemplo: `Sankhya, como configurar alíquota de ICMS?` em vez de `Como configurar alíquota?`

A LLM, ao receber o prompt, identifica o domínio e chama as tools `sankhya_ajuda_*` apropriadas.

---

## Suporte Técnico N1 — Dia a Dia

### 1.1 Busca rápida por código de erro

**Prompt:**

```
Sankhya, o que significa o erro E0004 na NF-e?
```

**O que a LLM faz:**

1. Chama `sankhya_ajuda_search_articles({query: "E0004 NF-e", mode: "keyword", limit: 3})`
2. Identifica o artigo top-1
3. Chama opcionalmente `sankhya_ajuda_get_article_details({article_id: <id>})` se precisar do passo-a-passo

**Resposta esperada:**

```markdown
**E0004 Rejeição: Conteúdo do identificador informado na DPS difere**

Significa que o identificador da DPS está divergente do esperado pelo SEFAZ.

Solução: ...

Fonte: https://ajuda.sankhya.com.br/hc/pt-br/articles/360067891234
```

---

### 1.2 Localizar uma tela específica

**Prompt:**

```
Sankhya, onde fica a tela de Cadastro de Produtos?
```

**Tools usadas:**

- `sankhya_ajuda_search_articles({query: "cadastro de produtos tela", mode: "hybrid"})`

**Resposta esperada:** caminho de menu (`MGE > Vendas > Cadastros > Produtos`) + URL do artigo oficial.

---

### 1.3 Prompt nomeado: `quick_lookup`

Use o prompt MCP nativo para resposta enxuta:

**Cliente Claude Code (slash command):**

```
/sankhya_quick_lookup term="emissão NF-e"
```

**Cliente Claude Desktop / Cursor / OpenAI:** chame a tool-bridge:

```json
{
  "name": "sankhya_ajuda_get_prompt_by_name",
  "arguments": {
    "name": "sankhya_quick_lookup",
    "arguments": { "term": "emissão NF-e" }
  }
}
```

**Resultado:** 1 tool call interno (`search_articles({query: "emissão NF-e", limit: 3})`) e resposta compactada com top-1.

---

### 1.4 Diretamente para o usuário final

**Prompt:**

```
Sankhya, um cliente me ligou perguntando como cancelar uma NF-e que foi emitida errada. Me dê uma resposta pronta para passar.
```

**Tools:**

- `sankhya_ajuda_search_articles({query: "cancelamento NF-e procedimento", limit: 5})`
- `sankhya_ajuda_get_article_details({article_id: <top match>, max_body_chars: 8000})`

**Resposta esperada:** resposta pronta em tom de atendimento + link do artigo para enviar ao cliente.

---

## Suporte Técnico N2 — Troubleshooting

### 2.1 Investigação guiada com `troubleshoot`

**Prompt:**

```
Sankhya, preciso investigar este problema:
"Cliente reporta que ao tentar emitir NF-e o sistema retorna 'serviço não configurado',
mesmo após configurar o emissor. Já validamos certificado digital."
```

**Cliente Claude Code (slash):**

```
/sankhya_troubleshoot problem="Cliente reporta erro 'serviço não configurado' ao emitir NF-e mesmo com emissor configurado e certificado válido"
```

**O que o prompt faz (embutido no protocolo):**

1. `sankhya_ajuda_search_articles({query: "serviço não configurado NF-e", mode: "hybrid", limit: 7})`
2. `sankhya_ajuda_get_article_details({article_id: <top-1>})` para detalhes
3. Opcional: `sankhya_ajuda_list_categories()` se precisar filtrar

**Resposta esperada (estruturada):**

```markdown
## Causa provável
- Configuração da TGF (Tipo de Operação) sem vinculação ao serviço de NF-e
- Faltam parâmetros XYZ na empresa emissora

## Solução passo-a-passo
1. ...
2. ...

## Artigos referenciados
- [Não existem serviços na nota configurados...](https://ajuda.sankhya.com.br/...)
- [Configuração de emissor NF-e](https://ajuda.sankhya.com.br/...)

## Se não resolver
- Validar logs do SEFAZ
- Conferir status do serviço estadual
```

---

### 2.2 Erro recorrente — analisar histórico

**Prompt:**

```
Sankhya, qual a causa raiz do erro "Há divergência entre o estoque e as movimentações do MGE"?
Já apareceu várias vezes em clientes diferentes.
```

**Tools:**

- `sankhya_ajuda_search_articles({query: "divergência estoque movimentações MGE", limit: 5})`
- `sankhya_ajuda_get_article_details` no top match

**Resposta:** causa estrutural + procedimento de reconciliação + link.

---

### 2.3 Pesquisa multi-categoria

**Prompt:**

```
Sankhya, quero ver todos os artigos sobre Reforma Tributária. Liste por relevância.
```

**Tools:**

1. `sankhya_ajuda_list_categories()` para descobrir o `category_id` de "Reforma tributária"
2. `sankhya_ajuda_search_articles({query: "reforma tributária", category_id: <id>, limit: 20})`

**Resposta:** tabela ordenada por similaridade com os 20 artigos mais relevantes da categoria (42 artigos no total nesta categoria atualmente).

---

## Consultoria e Onboarding

### 3.1 Explicar um módulo (prompt nomeado)

**Prompt (slash command):**

```
/sankhya_explain_module module_name="Faturamento"
```

**Ou via tool-bridge:**

```json
{
  "name": "sankhya_ajuda_get_prompt_by_name",
  "arguments": {
    "name": "sankhya_explain_module",
    "arguments": { "module_name": "Faturamento" }
  }
}
```

**Resposta esperada (estruturada):**

```markdown
# Módulo Faturamento — Sankhya

## O que é
Módulo responsável pela emissão e gestão de notas fiscais...

## Quando usar
Toda operação de saída fiscal: NF-e, NFC-e, NFS-e, conhecimentos de transporte...

## Pré-requisitos
1. Cadastro de empresa emissora configurado
2. Certificado digital A1 ou A3
3. ...

## Telas principais
- `Faturamento > Nota Fiscal Eletrônica` — [link]
- `Faturamento > Cancelamento` — [link]
- ...

## Erros comuns
- E0004: identificador divergente — [link]
- E215: certificado expirado — [link]
- ...
```

---

### 3.2 Novo colaborador (onboarding)

**Prompt:**

```
Sankhya, sou novo na empresa e vou trabalhar com módulo Estoque. Me passa um roteiro
de aprendizado: o que ler primeiro, em que ordem, e quais erros comuns devo conhecer.
```

**Tools:**

1. `sankhya_ajuda_list_categories()` para mapear domínios
2. `sankhya_ajuda_list_sections({category_id: <Documentação de Telas>})` para listar seções de "Estoque"
3. `sankhya_ajuda_search_articles({query: "estoque conceito introdução", mode: "semantic", limit: 15})`

**Resposta:** roteiro com 5-10 artigos em ordem didática.

---

### 3.3 Preparação para reunião com cliente

**Prompt:**

```
Sankhya, tenho uma reunião com cliente que vai falar sobre Pessoas+ (folha de pagamento).
Me dê um resumo dos principais conceitos e funcionalidades do módulo.
```

**Tools:**

- `sankhya_ajuda_list_sections({category_id: <Pessoas+>})` para conhecer estrutura (770 artigos na categoria)
- `sankhya_ajuda_search_articles({query: "Pessoas+ visão geral introdução", mode: "semantic"})`

---

## Análise Técnica e Auditoria

### 4.1 Conferir status da base de conhecimento

**Prompt:**

```
Sankhya, qual o estado atual da indexação? Quantos artigos estão sincronizados?
Quando foi o último sync?
```

**Tool usada:**

- `sankhya_ajuda_read_resource_by_uri({uri: "sankhya-ajuda://sync_state"})`

**Resposta (JSON):**

```json
{
  "last_status": "ok",
  "last_full_sync_at": "2026-05-16T03:00:42.000Z",
  "last_article_count": 6123,
  "last_changed_count": 14,
  "articles_count": 6123,
  "with_embedding_count": 6123,
  "error_count": 0
}
```

> Útil para alertas automatizados ou healthchecks externos. Também disponível em `GET /health` (sem auth).

---

### 4.2 Auditar artigos obsoletos

**Prompt:**

```
Sankhya, busque artigos sobre "Reforma Tributária" incluindo os marcados como obsoletos,
quero ver se há conteúdo arquivado relevante.
```

**Tool:**

```json
{
  "name": "sankhya_ajuda_search_articles",
  "arguments": {
    "query": "reforma tributária",
    "include_outdated": true,
    "limit": 25
  }
}
```

**Coluna `Outdated`** aparece na tabela de resultados quando `include_outdated=true`.

---

### 4.3 Conferir conteúdo de uma seção específica

**Prompt:**

```
Sankhya, mostre tudo o que tem na seção 360001823814.
```

**Tool:**

- `sankhya_ajuda_read_resource_by_uri({uri: "sankhya-ajuda://sections/360001823814"})`

Retorna metadados da seção (nome, categoria pai, parent, contagem de artigos, URL).

---

## Comparativos entre Artigos

### 5.1 Comparar 3 artigos (prompt nomeado)

**Prompt (slash command):**

```
/sankhya_compare_articles article_ids="360045123456,360067891234,360011223344"
```

**Ou via tool-bridge:**

```json
{
  "name": "sankhya_ajuda_get_prompt_by_name",
  "arguments": {
    "name": "sankhya_compare_articles",
    "arguments": { "article_ids": "360045123456,360067891234,360011223344" }
  }
}
```

**O que acontece:** o prompt instrui a LLM a fazer 3 chamadas `get_article_details` (uma por ID) e produzir comparativo.

**Resposta esperada:**

```markdown
## Comparativo dos 3 artigos

| Aspecto | Artigo 1 (E0004) | Artigo 2 (Não config emissor) | Artigo 3 (DPS divergente) |
|---|---|---|---|
| Domínio | Rejeição SEFAZ | Configuração inicial | Validação de DPS |
| Quando aplica | Após emissão | Antes da primeira emissão | Reforma tributária |
| Solução | Validar identificador | Configurar emissor TGF | Conferir CFOP da DPS |
| Status | ✅ Atual | ✅ Atual | ⚠️ Obsoleto (substituído por #4567) |

## Convergências
Todos tratam de erros de validação SEFAZ na emissão de NF-e.

## Divergências
- Artigo 1 e 3 tratam de erros pós-emissão; artigo 2 é configuração prévia.
- Artigo 3 referencia a Reforma Tributária 2026 (LC 87/2024) — outros não.

## Gaps
Nenhum dos artigos cobre o caso de emissão para municípios sem convênio com o SEFAZ.
```

---

### 5.2 Comparar abordagens (semântica)

**Prompt:**

```
Sankhya, compare as abordagens de cancelamento de NF-e em até 30 dias vs. após 30 dias.
Existem artigos diferentes para cada caso?
```

**Tools:**

1. `sankhya_ajuda_search_articles({query: "cancelamento NF-e 30 dias", mode: "semantic", limit: 15})`
2. `sankhya_ajuda_get_article_details` nos top-2 mais relevantes
3. LLM produz comparativo em tabela

---

## Casos de Reforma Tributária

A Reforma Tributária (LC 87/2024, vigência 2026+) introduziu mudanças significativas. A categoria dedicada tem **42 artigos** atualmente.

### 6.1 Visão geral do que mudou

**Prompt:**

```
Sankhya, me dê uma visão geral da Reforma Tributária no contexto do Sankhya ERP.
Quais módulos foram afetados?
```

**Tools:**

1. `sankhya_ajuda_list_categories()` → identifica a categoria "Reforma tributária"
2. `sankhya_ajuda_search_articles({query: "reforma tributária visão geral", category_id: <id>, mode: "semantic", limit: 15})`

---

### 6.2 Cuidados na transição

**Prompt:**

```
Sankhya, quais cuidados devo ter ao configurar TGF (Tipos de Operação) sob a Reforma Tributária?
Há rejeições novas do SEFAZ?
```

**Tools:**

- `sankhya_ajuda_search_articles({query: "TGF reforma tributária rejeição SEFAZ", mode: "hybrid", limit: 15})`

---

### 6.3 DPS (Declaração Prestada de Serviço)

**Prompt:**

```
Sankhya, o que é DPS e qual a diferença para a NFS-e padrão?
```

**Tools:**

- `sankhya_ajuda_search_articles({query: "DPS declaração prestada serviço", mode: "semantic", limit: 10})`
- `sankhya_ajuda_get_article_details` no top match

---

## Uso Programático (chamadas diretas)

Útil para integrações automatizadas (bots de suporte, dashboards, agentes CrewAI/LangChain, etc.).

### 7.1 Health check externo (bash)

```bash
#!/bin/bash
# health-check.sh

response=$(curl -s -w "\n%{http_code}" http://mcp.example.com:3105/health)
status_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | head -n-1)

if [ "$status_code" = "200" ]; then
  articles=$(echo "$body" | jq -r '.articles_count')
  with_emb=$(echo "$body" | jq -r '.with_embedding_count')
  echo "OK: $articles artigos, $with_emb com embedding"
else
  echo "DEGRADED ($status_code): $body"
  exit 1
fi
```

---

### 7.2 Busca via curl (chamada MCP)

```bash
curl -s -X POST http://mcp.example.com:3105/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H "MCP-Protocol-Version: 2025-11-25" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "sankhya_ajuda_search_articles",
      "arguments": {
        "query": "emissão NF-e",
        "limit": 5,
        "mode": "hybrid"
      }
    }
  }' | jq
```

> **Nota:** chamadas MCP exigem o handshake `initialize` antes. Para protótipos rápidos, prefira clientes MCP nativos. Para integrações de produção, use uma biblioteca cliente (MCP SDK).

---

### 7.3 Python — OpenAI Responses API com MCP remoto

```python
from openai import OpenAI

client = OpenAI()

response = client.responses.create(
    model="gpt-4.1",
    input="Sankhya, como resolver o erro E0004 na NF-e?",
    tools=[{
        "type": "mcp",
        "server_label": "sankhya-ajuda",
        "server_url": "http://mcp.example.com:3105/mcp",
        "headers": {
            "Authorization": "Bearer SEU_MCP_AUTH_TOKEN"
        },
        "require_approval": "never"
    }]
)

print(response.output_text)
```

Disponível desde **OpenAI Responses API** (introduzida em 2025-05). Permite que o ChatGPT/GPT-4.1+ use o MCP do Sankhya Ajuda diretamente como ferramenta remota.

---

### 7.4 Node.js — cliente MCP oficial

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(
  new URL("http://mcp.example.com:3105/mcp"),
  {
    requestInit: {
      headers: { Authorization: `Bearer ${process.env.MCP_AUTH_TOKEN}` }
    }
  }
);

const client = new Client({ name: "meu-script", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

const result = await client.callTool({
  name: "sankhya_ajuda_search_articles",
  arguments: { query: "cadastro de produtos", limit: 5 }
});

console.log(result.content[0].text);
await client.close();
```

---

### 7.5 Bot de Slack/Teams reactivo (pseudocódigo)

```python
@app.event("message")
def handle_message(event, say):
    text = event["text"]
    if not text.lower().startswith("sankhya"):
        return

    # Chama LLM com tool MCP configurada
    response = llm_with_mcp.invoke(text)
    say(f"📚 {response}")
```

Use junto com OpenAI Responses API (item 7.3) ou Anthropic Tool Use + MCP gateway.

---

## Comunidade — Busca e Drill-Down

O MCP agora expõe também a **comunidade Sankhya (Bettermode)** com 7.619 threads de Q&A (perguntas + respostas de usuários) em 33 espaços públicos. Use estas ferramentas para encontrar soluções compartilhadas por pares e troubleshooting comunitário.

### 9.1 Busca unificada (help center + comunidade)

**Prompt:**

```
Sankhya, como cancelar uma NF-e emitida? Quero respostas do help e de discussões comunitárias.
```

**O que a LLM faz:**

1. Chama `sankhya_ajuda_search_knowledge_unified({query: "cancelar NF-e", source: "all", limit: 10})`
2. Recebe resultados de ambas as fontes com rótulo de origem (`fonte: help` ou `fonte: community`)
3. Integra e destaques respostas e melhores práticas

**Resposta esperada:**

```markdown
**Cancelamento de NF-e**

Encontrei 10 resultados de ajuda e comunidade:

Fonte **help center** (oficial):
1. "Como cancelar uma NF-e emitida" — https://ajuda.sankhya.com.br/...
2. "Procedimento de cancelamento em lote" — https://ajuda.sankhya.com.br/...

Fonte **comunidade** (usuários):
1. "Dúvida: qual o prazo para cancelar NF-e?" — https://community.sankhya.com.br/...
2. "Experência: cancelamento rápido usando atalho" — https://community.sankhya.com.br/...

Resumo: ...
```

---

### 9.2 Ler uma resposta comunitária completa

**Prompt:**

```
Sankhya, mostra a discussão sobre "como resolver erro de ICMS em NF-e" (post da comunidade).
```

**O que a LLM faz:**

1. Primeiro chama `sankhya_ajuda_search_knowledge_unified({query: "erro ICMS NF-e", source: "community", limit: 5})` para localizar o post
2. Chama `sankhya_ajuda_get_community_post({post_id: "<id>", max_body_chars: 15000})` para ler a thread completa (pergunta + todas as respostas)

**Resposta esperada:**

```markdown
**Tópico: Como resolver erro de ICMS em NF-e?**

Pergunta original (por João Silva):
...

Respostas (3):
1. Resposta de Maria (⭐ marcada como solução):
   ...
2. Resposta de Pedro:
   ...
3. Resposta de Ana:
   ...

Reações: 12 upvotes
```

---

### 9.3 Explorar espaços da comunidade

**Prompt:**

```
Sankhya, que espaços existem na comunidade?
```

**O que a LLM faz:**

1. Chama `sankhya_ajuda_list_community_spaces()` para listar todos

**Resposta esperada:**

```markdown
**Espaços da Comunidade Sankhya**

33 espaços públicos disponíveis:

| Espaço | Membros | Posts |
|---|---|---|
| Dúvidas | 2.340 | 1.240 |
| Novas Funcionalidades | 1.890 | 450 |
| Melhores Práticas | 1.220 | 320 |
| Sugestões | 980 | 280 |
| ... (mais 29 espaços) |

Acesse https://community.sankhya.com.br/
```

---

## Padrões Anti-Hallucination

A LLM cliente deve **sempre citar a fonte** (URL do artigo) ao responder com base em conteúdo do help center. Padrões recomendados:

### 8.1 System prompt sugerido (para o cliente)

```
Você tem acesso ao MCP `sankhya-ajuda` com 11 tools sobre o help center (ajuda.sankhya.com.br)
e comunidade (community.sankhya.com.br) públicos do ERP Sankhya. Para qualquer pergunta sobre o Sankhya:

1. Use `sankhya_ajuda_search_articles` primeiro. NUNCA invente IDs, telas ou códigos de erro.
2. Cite a URL pública do artigo em ajuda.sankhya.com.br em toda resposta factual.
3. Se a busca não retornar resultado relevante, diga explicitamente "não encontrei nada sobre X no help oficial"
   em vez de adivinhar.
4. Use mode=keyword para códigos de erro específicos (ex: "E0004", "PRD0011").
5. Use mode=semantic ou hybrid (default) para perguntas conceituais.
6. Para troubleshooting estruturado, prefira o prompt nomeado `sankhya_troubleshoot`.
```

### 8.2 Indicador de cobertura

Sempre que a busca retornar similaridade baixa (< 0.2 em hybrid), a LLM deve sinalizar:

> ⚠️ A busca retornou resultados com baixa relevância. Verifique se sua pergunta usa termos do contexto Sankhya
> ou refine a consulta com nomes de tela / códigos de erro específicos.

### 8.3 Confiabilidade do modo

O campo `modeUsed` na resposta indica o modo **efetivamente usado**:

- `hybrid` ou `semantic`: ranking semântico confiável
- `keyword`: apenas FTS (vocabulário precisa casar)
- `keyword_fallback`: vLLM/OpenAI caiu — qualidade reduzida temporariamente
- `keyword_index_mismatch`: ⚠️ provider trocado sem reindex — busca semântica desabilitada por guardrail

A LLM deve mencionar `keyword_index_mismatch` ao usuário quando aparecer, pois indica problema de configuração.

---

## Padrões Anti-Padrão (evite)

❌ **Não faça** múltiplas chamadas `get_article_details` em loop para todos os resultados de uma busca — viola o cap de 400 KB e queima tokens.

❌ **Não invente** `article_id` — IDs são BIGINT do Zendesk, não sequenciais. Sempre obter via `search`.

❌ **Não troque** `EMBEDDING_PROVIDER` em produção sem reindexar — o guardrail vai degradar para keyword e a busca semântica fica indisponível silenciosamente para o usuário até a reindexação.

❌ **Não cache** resultados de `search_articles` por mais de algumas horas — o ETL roda diariamente às 03:00 e pode incluir/remover artigos.

✅ **Pode cachear** resultados de `list_categories`, `list_sections`, `list_mcp_resources`, `list_prompt_catalog` agressivamente — `openWorldHint=false`.

---

## Limitações Conhecidas

| Limite | Valor | Razão |
|---|---|---|
| Cap de resposta total | 400 KB | Performance e custo de transporte |
| `limit` máximo em `search_articles` | 25 | Cobertura suficiente sem inflar resposta |
| `max_body_chars` máximo | 40.000 | Cobre P99 dos artigos (P99 = 40.435 chars) |
| Server instructions | 2.000 chars | Constraint do MCP SDK |
| Idiomas | apenas pt-BR | Help center oficial é só pt-BR |
| Latência típica de query | 50-300 ms | Depende do provider (vLLM ~50ms, OpenAI ~300ms) |
| Atualização do índice | Diário (03:00 UTC-3) | ETL cron via Fase 1 Python |

---

## Suporte e Feedback

- **Issues técnicas:** GitHub Issues no repositório
- **Suporte comercial:** [Skills IT](https://www.skillsit.com.br) · 📱 (63) 3224-4925 · 📍 Palmas — TO — Brasil
- **Sugestões de cenários:** PRs em `docs/EXAMPLES.md` são bem-vindos

---

## Referências Cruzadas

| Documento | Sobre |
|---|---|
| [`TOOLS.md`](./TOOLS.md) | Referência completa de cada tool, resource e prompt |
| [`README.md`](../README.md) | Visão geral, instalação rápida, configuração de clientes MCP |
| [`INSTALL.md`](./INSTALL.md) | Instalação detalhada em 5 cenários |
| [`EMBEDDINGS-PROVIDER.md`](./EMBEDDINGS-PROVIDER.md) | Como escolher provider |

---

<div align="center">

**Construído por [Skills IT](https://www.skillsit.com.br)**

🌐 [www.skillsit.com.br](https://www.skillsit.com.br) · 📱 (63) 3224-4925 (WhatsApp/Telefone) · 📍 Palmas — TO — Brasil

</div>
