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

Detalhes e exemplos de validacao: [Validacao de entrada](task-validation.md). Os envelopes publicos de erro estao documentados na secao Respostas de erro abaixo.

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

## Respostas de erro

As respostas abaixo usam Content-Type: application/json; charset=utf-8. O corpo contem um objeto error, com code e message publicos e fixos. Nos erros de validacao aplicaveis, details identifica o campo com uma mensagem controlada.

### 400: entrada invalida

Por exemplo, a entrada {} omite title e recebe HTTP 400 Bad Request:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid task input",
    "details": [
      { "field": "title", "message": "Invalid title" }
    ]
  }
}
```

Os detalhes publicos usam somente title, description ou body, com mensagens Invalid title, Invalid description ou Invalid request body, respectivamente. Campos desconhecidos sao representados genericamente por body, sem refletir seu nome ou valor. JSON malformado ou vazio tambem recebe HTTP 400 com o seguinte corpo:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid task input",
    "details": [
      { "field": "body", "message": "Invalid request body" }
    ]
  }
}
```

Essas entradas invalidas sao rejeitadas antes da chamada de criacao ao repositorio. A validacao continua estrita, sem coercao ou normalizacao adicional.

### 503: indisponibilidade reconhecida

Quando uma requisicao valida encontra indisponibilidade reconhecida na fronteira PostgreSQL, recebe HTTP 503 Service Unavailable:

```json
{
  "error": {
    "code": "DATABASE_UNAVAILABLE",
    "message": "Database unavailable"
  }
}
```

A classificacao utiliza codigos estruturados reconhecidos ou o timeout controlado de aquisicao. Uma mensagem contendo palavras como timeout ou connection, por si so, nao estabelece indisponibilidade. Nem todo erro de banco e classificado como 503, e uma resposta 503 nao garante que nenhuma insercao tenha ocorrido.

### 500: falha inesperada

Erros inesperados, inclusive falhas de insercao nao classificadas como indisponibilidade, recebem HTTP 500 Internal Server Error:

```json
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Internal server error"
  }
}
```

Falhas de autenticacao ou permissao do PostgreSQL, constraints inesperadas e resultado invalido do repositorio permanecem erros internos. As respostas 500 e 503 nao incluem details nem databaseCode. Nenhuma dessas respostas expoe SQL, parametros, credenciais, stack traces, cause ou mensagens internas do driver. Codigos tecnicos de banco pertencem exclusivamente aos diagnosticos internos permitidos, nao ao JSON publico.

Os exemplos descrevem erros de criacao tratados pela aplicacao. Nao redefinem respostas do framework como 404, 413 ou 415.

## Resultado incerto apos efetivacao do INSERT

Uma queda de conexao depois que o PostgreSQL efetivou o INSERT, pelo commit implicito do autocommit, pode impedir que a aplicacao receba corretamente sua confirmacao. A tarefa pode estar persistida mesmo quando a operacao termina com erro. Uma falha reconhecida pode resultar em 503; uma falha nao classificada permanece 500. Nao e correto inferir a ausencia da linha a partir de uma falha de infraestrutura.

A aplicacao nao repete automaticamente o INSERT nem presume sucesso apos a falha. Isso nao garante reversao de uma insercao ja efetivada. Nem toda resposta 503 ocorre antes da insercao.

POST /tasks nao e idempotente e nao deduplica por titulo. Se o cliente repetir a requisicao, pode criar uma segunda tarefa com outro UUID, inclusive quando a primeira chamada terminou com erro. Nao ha garantia de execucao unica, chave de idempotencia ou recuperacao automatica implementada.

## Conferencia com os testes

Os exemplos correspondem aos testes de tests/task-routes.test.ts para criacao minima, completa, descricao vazia e duas requisicoes com o mesmo titulo. Os testes tambem conferem os argumentos normalizados enviados ao repositorio, os cinco campos da resposta e a espera pela confirmacao de create.

O teste HTTP de duplicados usa dois retornos simulados validos e comprova que a rota encaminha ambas as criacoes. Nao comprova geracao de UUID ou persistencia real no PostgreSQL. A verificacao HTTP com PostgreSQL real pertence a secao 6 da mudanca. O tratamento centralizado de erros ja esta implementado.

Evidencias dos erros e dos limites da verificacao:

- [tests/http-errors.test.ts](../tests/http-errors.test.ts) compara os envelopes exatos de 400, 500 e 503, rejeita falsificacoes e verifica ausencia de dados sensiveis. Os cenarios de persistencia HTTP usam executor simulado e repositorio PostgreSQL real em TypeScript; nao abrem conexao ao banco.
- [tests/http-logging.test.ts](../tests/http-logging.test.ts) verifica que os diagnosticos nao alteram as respostas publicas, inclusive quando a escrita sincrona do logger falha. Tambem verifica tentativa unica de insercao nos cenarios cobertos.
- [tests/postgres-query-executor.test.ts](../tests/postgres-query-executor.test.ts) verifica prazo de aquisicao, falhas e tentativa unica, com pool e clientes simulados, sem PostgreSQL real.
- [tests/schema-integration/task-repository.test.ts](../tests/schema-integration/task-repository.test.ts), no caso does not duplicate a committed insert when its result is lost at the executor boundary, executa um INSERT real em autocommit dentro de schema temporario e exclusivo. Depois da conclusao da consulta, o executor lanca uma falha simulada ECONNRESET. O teste verifica rejeicao, uma tentativa e uma linha persistida. Nao corta a conexao TCP real e nao executa essa falha pelo endpoint HTTP.

As evidencias sao complementares: os testes HTTP comprovam a traducao publica de falhas simuladas, enquanto o teste de integracao demonstra que um erro apos a insercao real pode coexistir com a linha persistida. Isso nao equivale a um teste de queda fisica de conexao apos commit.
