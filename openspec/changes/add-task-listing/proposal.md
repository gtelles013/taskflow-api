# Proposal

## Why

O TaskFlow permite criar tarefas, mas ainda nao oferece uma listagem pela API. O futuro frontend React precisa consultar as tarefas persistidas com um contrato previsivel, paginacao limitada e tratamento seguro de erros.

## What Changes

- Introduzir `GET /tasks` com HTTP 200 e o envelope `items`, `nextOffset` e `truncated`. Cada item retorna os cinco campos publicos da criacao: `id`, `title`, `description`, `status` e `createdAt`. Uma pagina vazia retorna `items: []`, `nextOffset: null` e `truncated: false`.
- Paginar por `limit` (1 a 100, padrao 50) e `offset` (0 a 100000, padrao 0), em ordem fixa `created_at DESC, id DESC`. Consultar ate `limit + 1` registros, sem contagem total.
- Quando houver mais resultados e `offset + limit` for permitido, retornar esse valor em `nextOffset`. Quando houver mais resultados alem do teto, retornar `nextOffset: null` e `truncated: true`. No fim dos resultados, retornar `nextOffset: null` e `truncated: false`.
- Validar estritamente a query apos uma unica decodificacao. Aceitar somente `limit` e `offset` em forma decimal canonica. Rejeitar parametros desconhecidos, repetidos ou invalidos com HTTP 400 `VALIDATION_ERROR` e detalhe `query`, antes de consultar o repositorio.
- Desabilitar o `HEAD` automatico somente nesta rota. Reutilizar os envelopes `503 DATABASE_UNAVAILABLE` e `500 INTERNAL_ERROR`, com erros e logs sanitizados. Preservar integralmente o contrato de `POST /tasks`.

## Capabilities

### New Capabilities

- `task-listing`: consulta paginada de tarefas persistidas, com ordenacao deterministica, validacao de query e respostas previsiveis.

### Modified Capabilities

Nenhuma. Os requisitos da capacidade `task-creation` permanecem os mesmos.

## Impact

- `TaskRepository`, `PostgresTaskRepository` e mapeamento de registros para o dominio.
- Rotas, schemas HTTP, validacao de query, tratamento centralizado de erros e composicao da aplicacao.
- Testes unitarios, HTTP em memoria e de integracao. A mudanca reutiliza a tabela `tasks`, o executor PostgreSQL, o pool e a infraestrutura de testes existentes.
- A paginacao por offset pode repetir ou omitir itens entre paginas sob escritas concorrentes. Offsets profundos podem aumentar o custo da consulta mesmo com uma pagina pequena.

Ficam fora do escopo o frontend React, filtros, busca, ordenacao configuravel, contagem total, paginacao por cursor, autenticacao, CORS, `GET /tasks/:id`, atualizacao ou exclusao de tarefas, novos campos de dominio, migrations, indices, dependencias adicionais e mudancas na politica de timeout de consultas.
