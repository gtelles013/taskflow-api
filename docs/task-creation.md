# Criacao de tarefas: contrato HTTP

## Disponibilidade atual

A rota POST /tasks esta implementada na fabrica Fastify quando TaskRepository e injetado. O entrypoint atual src/server.ts ainda nao compoe essa dependencia; portanto, npm start ainda nao disponibiliza POST /tasks. A composicao operacional sera realizada posteriormente.

Os blocos abaixo descrevem o contrato HTTP e nao sao comandos para executar contra npm start neste estagio. UUIDs e timestamps das respostas sao valores ilustrativos gerados pelo sistema, nunca enviados pelo cliente. A resposta 201 utiliza os valores retornados pelo repositorio, somente apos a confirmacao da criacao.

## Entrada e resposta

Enviar um objeto JSON com title e, opcionalmente, description:

- title e uma string obrigatoria, com 1 a 120 pontos de codigo Unicode apos trim. Espacos internos sao preservados.
- description e uma string opcional de ate 500 pontos de codigo Unicode, sem trim. Quando omitida, resulta em null na resposta; null explicito na entrada e invalido.
- Descricao vazia ou composta somente por espacos e preservada. Nao ha normalizacao Unicode adicional.
- Campos desconhecidos, inclusive id, status e createdAt, e tipos invalidos sao rejeitados com HTTP 400. Nao ha coercao automatica de tipos.
- JSON malformado, corpo ausente e corpos JSON que nao sejam objetos tambem retornam 400, sem chamada de criacao ao repositorio.

Detalhes e exemplos de validacao: [Validacao de entrada](task-validation.md). A padronizacao do envelope de erros pertence a secao 5 da mudanca OpenSpec; este documento nao estabelece um corpo definitivo para erros.

Toda resposta de sucesso tem exatamente id, title, description, status e createdAt. O status e pending; createdAt e uma string ISO 8601 UTC com milissegundos.

## Criacao minima

Requisicao:

```http
POST /tasks HTTP/1.1
Content-Type: application/json

{"title":"Example"}
```

Resposta:

```http
HTTP/1.1 201 Created
Content-Type: application/json; charset=utf-8
```

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "title": "Example",
  "description": null,
  "status": "pending",
  "createdAt": "2026-11-19T15:30:45.123Z"
}
```

## Criacao completa: trim e espacos preservados

Requisicao:

```http
POST /tasks HTTP/1.1
Content-Type: application/json

{"title":"  Complete  ","description":"  Keep these spaces  "}
```

Resposta:

```http
HTTP/1.1 201 Created
Content-Type: application/json; charset=utf-8
```

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "title": "Complete",
  "description": "  Keep these spaces  ",
  "status": "pending",
  "createdAt": "2026-11-19T15:30:45.123Z"
}
```

Os exemplos de secoes diferentes sao independentes; seus identificadores ilustrativos nao representam uma sequencia de insercoes.

## Descricao vazia

Requisicao:

```http
POST /tasks HTTP/1.1
Content-Type: application/json

{"title":"Example","description":""}
```

Resposta:

```http
HTTP/1.1 201 Created
Content-Type: application/json; charset=utf-8
```

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "title": "Example",
  "description": "",
  "status": "pending",
  "createdAt": "2026-11-19T15:30:45.123Z"
}
```

A string vazia e diferente da descricao omitida, que retorna null.

## Titulos duplicados e ausencia de idempotencia

Enviar duas vezes a mesma requisicao valida:

```http
POST /tasks HTTP/1.1
Content-Type: application/json

{"title":"  Repeated  "}
```

Primeira resposta:

```http
HTTP/1.1 201 Created
Content-Type: application/json; charset=utf-8
```

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "title": "Repeated",
  "description": null,
  "status": "pending",
  "createdAt": "2026-11-19T15:30:45.123Z"
}
```

Segunda resposta:

```http
HTTP/1.1 201 Created
Content-Type: application/json; charset=utf-8
```

```json
{
  "id": "123e4567-e89b-42d3-a456-426614174000",
  "title": "Repeated",
  "description": null,
  "status": "pending",
  "createdAt": "2026-11-19T15:30:46.123Z"
}
```

Titulos duplicados sao permitidos. Cada requisicao valida e encaminhada como uma nova criacao; nao ha deduplicacao por titulo nem garantia de idempotencia ou execucao unica. Repetir uma requisicao pode criar outra tarefa. A rota nao executa retry automatico, e o cliente nao deve presumir que uma repeticao evita duplicados.

## Conferencia com os testes

Os exemplos correspondem aos testes de tests/task-routes.test.ts para criacao minima, completa, descricao vazia e duas requisicoes com o mesmo titulo. Os testes tambem conferem os argumentos normalizados enviados ao repositorio, os cinco campos da resposta e a espera pela confirmacao de create.

O teste HTTP de duplicados usa dois retornos simulados validos e comprova que a rota encaminha ambas as criacoes. Nao comprova geracao de UUID ou persistencia real no PostgreSQL. A verificacao HTTP com PostgreSQL real pertence a secao 6 da mudanca; o tratamento centralizado de erros permanece na secao 5.
