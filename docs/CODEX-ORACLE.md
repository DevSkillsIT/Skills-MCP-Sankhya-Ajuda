# POC Codex + Oracle — Victor Ferreira
## Instalação Windows (PowerShell)
Na raiz do clone, com Python 3.13 e Codex instalados:
```powershell
py -3.13 -m venv mcp-oracle/.venv
& mcp-oracle/.venv/Scripts/python.exe -m pip install -r mcp-oracle/requirements.txt
& mcp-oracle/.venv/Scripts/python.exe -m unittest discover -s mcp-oracle
```
Mescle .codex/config.toml.example em $HOME/.codex/config.toml, ajustando os caminhos absolutos. Não sobrescreva configurações existentes. Defina no ambiente do processo Codex ORACLE_ENV=TESTE, ORACLE_DSN=host:1521/service, ORACLE_USER, ORACLE_PASSWORD, ORACLE_SCHEMA=SANKHYA e SANKHYA_MCP_TOKEN. Não grave senhas em arquivos versionados. ORACLE_ALLOW_SOURCE deve permanecer ausente salvo autorização.
O rótulo TESTE não comprova o destino: confirme DSN com DBA e restrinja rede ao ambiente de testes.
Solicite usuário dedicado com CREATE SESSION e acesso mínimo a metadados/views autorizadas. Não conceda SELECT ANY TABLE, DBA ou privilégios de escrita. ALL_* mostra apenas objetos acessíveis; valide cobertura com DBA. A ferramenta não aceita SQL livre nem consulta registros transacionais.
Suba o MCP Ajuda conforme docs/INSTALL.md. Atenção: nesta versão o ETL Python exige endpoint de embeddings compatível com vLLM para indexar conteúdo novo; EMBEDDING_PROVIDER=none no servidor Node não desativa o ETL. Use base já indexada ou configure embeddings antes da carga.
Reinicie Codex e execute codex mcp list. Peça para descrever TGFCAB e pesquisar documentação de faturamento. Verifique que as fontes são distintas.
