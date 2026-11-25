# Listagem de tarefas

`GET /tasks` consulta as tarefas persistidas no PostgreSQL. A rota fica disponivel quando o servidor inicia com o repositorio configurado. A leitura depende da migracao 0001 aplicada ao banco de destino. Consulte os [requisitos de execucao](../README.md#configuracao-do-postgresql) e o [procedimento de migracao](migrations.md).

## Parametros de query

| Parametro | Padrao | Faixa inclusiva | Finalidade |
| --- | ---: | --- | --- |
| `limit` | 50 | 1 a 100 | Quantidade maxima de itens da pagina. |
| `offset` | 0 | 0 a 100000 | Quantidade de resultados a pular. |

Os defaults valem para parametros ausentes. Uma query vazia tambem usa os defaults. Nomes e valores sao decodificados uma vez, depois de separar os pares por `&` e cada nome do valor pelo primeiro `=`. O `+` literal vira espaco. `%2B` vira um sinal de mais. Percent-encoding valido e aceito quando o resultado decodificado atende as mesmas regras, como em `l%69mit=%32`.

Os valores devem ser inteiros decimais canonicos com digitos ASCII. Sinais, espacos, fracoes, notacao cientifica, zeros iniciais desnecessarios e valores ausentes, vazios ou fora da faixa recebem 400. A rota tambem rejeita segmentos vazios em query nao vazia, escapes malformados, UTF-8 invalido e nomes desconhecidos ou repetidos, inclusive apos a decodificacao. `HEAD /tasks` automatico esta desabilitado.

## Respostas

### 200 — Pagina de tarefas

`GET /tasks` solicita a primeira pagina com `limit=50` e `offset=0`. A ordenacao e fixa por `created_at DESC, id DESC`. Tarefas mais recentes aparecem primeiro e, no empate de timestamp, o UUID em ordem descendente resolve o empate.

Cada item tem exatamente `id`, `title`, `description`, `status` e `createdAt`. A descricao preserva `null`, string vazia e espacos. `createdAt` representa o instante persistido em UTC ISO 8601 com milissegundos.

Com tres tarefas disponiveis, `GET /tasks?limit=2&offset=0` pode retornar a seguinte pagina:

```json
{
  "items": [
    {
      "id": "00000000-0000-4000-8000-000000000003",
      "title": "Revisar tarefa",
      "description": "  com espacos  ",
      "status": "pending",
      "createdAt": "2026-11-20T10:00:02.333Z"
    },
    {
      "id": "00000000-0000-4000-8000-000000000002",
      "title": "Planejar tarefa",
      "description": null,
      "status": "pending",
      "createdAt": "2026-11-20T10:00:01.222Z"
    }
  ],
  "nextOffset": 2,
  "truncated": false
}
```

O cliente usa `GET /tasks?limit=2&offset=2` para buscar a tarefa restante. Nessa pagina, `nextOffset` e `null` e `truncated` e `false`. Para banco vazio ou offset alem dos resultados, o HTTP 200 retorna:

```json
{"items":[],"nextOffset":null,"truncated":false}
```

A API nao retorna uma contagem total. Quando ha mais resultados, a continuacao usa `offset + limit` se a soma for permitida. Nos exemplos abaixo, suponha que haja pelo menos um resultado adicional apos cada pagina.

| Requisicao | Itens na resposta | nextOffset | truncated |
| --- | ---: | ---: | --- |
| `GET /tasks?limit=2&offset=99998` | 2 | 100000 | false |
| `GET /tasks?limit=2&offset=99999` | 2 | null | true |

`truncated: true` indica que existem resultados adicionais alem da pagina devolvida, mas a proxima pagina calculada excede o teto aceito pelo contrato. Sem resultados adicionais, `nextOffset` e `null` e `truncated` e `false`, inclusive no teto.

### 400 — Query invalida

Por exemplo, `GET /tasks?limit=02` recebe 400 antes da consulta:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid task query",
    "details": [{"field":"query","message":"Invalid query parameters"}]
  }
}
```

### 503 — Indisponibilidade reconhecida

```json
{"error":{"code":"DATABASE_UNAVAILABLE","message":"Database unavailable"}}
```

### 500 — Falha inesperada

Uma falha inesperada ou um resultado invalido recebe o envelope abaixo, sem pagina parcial:

```json
{"error":{"code":"INTERNAL_ERROR","message":"Internal server error"}}
```

Os erros publicos omitem SQL, credenciais, stack traces, detalhes internos e entradas invalidas. A aplicacao nao repete consultas automaticamente.

## Limites operacionais

A paginacao por offset nao mantem um snapshot entre requisicoes. Escritas concorrentes podem deslocar resultados e causar repeticoes ou omissoes entre paginas. Offsets profundos podem aumentar o custo de leitura e ordenacao. Esta mudanca usa os indices existentes.

O executor mantem o timeout de aquisicao de conexao de 2500 ms. Esse prazo se aplica ate o despacho da consulta. A aplicacao nao adiciona um timeout especifico para a consulta ja em execucao.
