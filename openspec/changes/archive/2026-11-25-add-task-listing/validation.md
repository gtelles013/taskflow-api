# Evidencias de validacao de add-task-listing

## Escopo e identificacao

Mudanca `add-task-listing`, capacidade `task-listing`, branch `feature/add-task-listing`, base `95a30157dd0efdc2e2c0760f364f8ed01da6e9d8`. As etapas 10.4 a 10.7 consolidaram [proposta](proposal.md), [delta](specs/task-listing/spec.md), [design](design.md) e [checklist](tasks.md).

## Implementacao

A etapa 11.1 introduziu `GET /tasks` com `items`, `nextOffset` e `truncated`, sem HEAD automatico e sem contagem total. A query usa decodificacao unica, parametros estritos e defaults 50 e 0. O repositorio PostgreSQL usa SQL qualificado e parametrizado, ordem `created_at DESC, id DESC` e sondagem `limit + 1`. O mapper de linha e compartilhado com `create`. A rota valida a estrutura e as invariantes da pagina antes de calcular a continuacao. Os envelopes 400, 503 e 500 e os diagnosticos sanitizados preservam o identificador da requisicao. O contrato de POST permanece preservado. [README](../../../../README.md) e [contrato HTTP](../../../../docs/task-listing.md) descrevem o uso.

## Auditoria e correcoes

- 11.1.1 e 11.1.2: a rota passou a rejeitar paginas inconsistentes; os testes passaram a procurar marcadores isolados no corpo e em todos os logs, inclusive na sondagem invalida; a tabela HTTP ganhou %00 e %0D, preservando %0A e a cobertura direta do parser. Foram nove novos casos HTTP, sete de pagina invalida e dois de controles codificados.
- 11.2: preparacao dos quatro casos PostgreSQL e da documentacao publica, seguida de revisao estatica.
- 11.3: o primeiro typecheck terminou com saida 1 em 1,18 s. Houve TS7022 em response e page e TS2347 na chamada generica de json. Na etapa 11.3.1, a anotacao `LightMyRequestResponse` no laco quebrou o ciclo de inferencia, preservando o teste e o isolamento.
- 12.1 e 12.1.1: a integracao foi inicialmente interrompida antes de acessar o banco. A leitura restrita com `node:util.parseEnv`, sem carregar o arquivo no ambiente, confirmou `AUSENTE` para `NODE_OPTIONS`, inclusive na comparacao sem distincao de capitalizacao. A sessao tambem apresentava a chave ausente.

## Validacao em memoria — 11.3.1

| Comando | Saida | Duracao | Resultado |
| --- | ---: | --- | --- |
| `npm.cmd run typecheck` | 0 | 1,09 s pelo executor | Sem diagnosticos. |
| `npm.cmd run build` | 0 | 0,90 s pelo executor | Sem diagnosticos; artefatos ignorados. |
| `npm.cmd test -- --bail=1` | 0 | 2,69 s pelo runner; 3,65 s pelo executor | Vitest 5.1.0; 636 aprovados em 14 arquivos, zero falhas e zero ignorados. |

Foram 115 novos casos: 51 de query, 52 de HTTP de listagem, dez de repositorio e dois de runtime. A regressao integral de POST em memoria cobriu entrada, Unicode, envelopes, persistencia simulada, indisponibilidade, logging e ciclo de vida. A configuracao unitaria manteve `envDir: false` e excluiu as suites de integracao.

## Validacao PostgreSQL real — 12.1.1

```powershell
node --env-file=.env node_modules/vitest/vitest.mjs run --config vitest.schema-integration.config.mts --bail=1
```

Saida 0, Vitest 5.1.0, 6,77 s pelo runner e 7,24 s pelo executor. Foram 16 aprovados em quatro arquivos, zero falhas e zero ignorados.

| Arquivo em tests/schema-integration | Aprovados |
| --- | ---: |
| migrations.test.ts | 3 |
| task-repository.test.ts | 6 |
| task-routes.test.ts | 3 |
| task-listing-routes.test.ts | 4 |

A listagem cobriu tabela vazia; cinco linhas com representacao publica exata, UTC com milissegundos, descricoes nulas, vazias ou com espacos e Unicode; ordenacao por timestamp e desempate descendente de UUID com insercao em ordem distinta; e paginas de dois, dois e um item, com nextOffset 2, 4 e null. A pagina completa terminal e o offset alem dos dados retornaram sem continuacao. Os GETs preservaram todos os campos persistidos; um POST 201 foi comparado com a linha armazenada e recuperado por GET.

A regressao confirmou migracao versionada e reaplicacao, defaults, constraints, rollback de conflito, mapeamento de RETURNING, criacao HTTP, Unicode e duplicatas. O erro de constraint foi real. A perda de resposta apos INSERT confirmado foi simulada no executor. A cardinalidade invalida de create foi coberta em memoria.

## Isolamento e seguranca

As suites usaram apenas `taskflow_test`, com `TEST_DATABASE_URL` obrigatoria e sem fallback, validacao de destino e `current_database()`. O helper cria schemas descartaveis proprios, captura o OID e revalida a identidade antes do DROP. A migracao e o SQL qualificado operam no schema proprio, com search_path restrito nas sessoes pertinentes. Os pools HTTP e administrativo sao separados. O beforeDrop fecha a aplicacao e o pool HTTP antes da remocao; os recursos administrativos sao liberados pelo helper.

A execucao aprovada sustenta oito verificacoes read-only independentes de ausencia (quatro de listagem, tres de criacao HTTP e uma de repositorio). Nos outros oito casos, a evidencia e o termino bem-sucedido do helper. Nomes e OIDs individuais ficaram sem registro. Nao houve inventario manual posterior nem indicacao de schemas residuais. A verificacao de NODE_OPTIONS foi sanitizada. O escopo das evidencias e o das assercoes e dos caminhos inspecionados, sem monitoramento independente de todas as leituras de arquivos ou operacoes de rede.

## Consolidacao

636 testes em memoria em 14 arquivos e 16 PostgreSQL em quatro arquivos totalizam 652 aprovados em 18 arquivos, em duas execucoes distintas, com zero falhas e zero ignorados nessas execucoes. Houve 119 novos casos frente as suites correspondentes do primeiro ciclo. O teste TCP historico e o diagnostico isolado de conexao ficam fora dos totais. O typecheck inicial com saida 1 e a interrupcao previa a integracao estao registrados separadamente.

## Matriz dos 34 cenarios

M = memoria (11.3.1); PG = PostgreSQL real (12.1.1). As referencias apontam ao caso ou a tabela parametrizada.

| Requisito | Cenario da delta | Arquivo e caso | Evidencia | Resultado | Limite |
| --- | --- | --- | --- | --- | --- |
| Listagem e representacao publica | Listagem de tarefas persistidas | [campos persistidos](../../../../tests/schema-integration/task-listing-routes.test.ts#L131) | PG | Aprovado | Fixture de cinco linhas |
| Listagem e representacao publica | Preservacao da descricao | [descricoes nulas, vazias e com espacos](../../../../tests/schema-integration/task-listing-routes.test.ts#L131) | PG | Aprovado | Fixture com Unicode |
| Listagem e representacao publica | Banco sem tarefas | [schema vazio](../../../../tests/schema-integration/task-listing-routes.test.ts#L122) | PG | Aprovado | Schema descartavel |
| Listagem e representacao publica | Pagina alem dos resultados | [pagina alem dos resultados](../../../../tests/schema-integration/task-listing-routes.test.ts#L144) | PG | Aprovado | Offset 6 sobre cinco linhas |
| Decodificacao unica da query | Percent encoding valido | [alias e valor codificados](../../../../tests/task-listing-routes.test.ts#L31) | M | Aprovado | Injecao HTTP |
| Decodificacao unica da query | Mais literal e mais codificado | [mais literal e %2B](../../../../tests/task-listing-routes.test.ts#L96) | M | Aprovado | Assertiva de rejeicao; sem persistencia |
| Decodificacao unica da query | Delimitadores codificados e decodificacao unica | [delimitadores e dupla decodificacao](../../../../tests/task-query.test.ts#L14) | M | Aprovado | Parser direto; HTTP na tabela de rejeicoes |
| Decodificacao unica da query | Codificacao invalida | [escape e UTF-8 invalidos](../../../../tests/task-listing-routes.test.ts#L96) | M | Aprovado | Parser direto tambem testa nomes |
| Decodificacao unica da query | Segmento vazio em query nao vazia | [segmentos vazios](../../../../tests/task-query.test.ts#L14) | M | Aprovado | Parser direto; caso interno tambem via HTTP |
| Parametros de paginacao estritos | Query ausente ou vazia | [sem query ou apenas ?](../../../../tests/task-query.test.ts#L5) | M | Aprovado | Parser direto preserva o delimitador vazio |
| Parametros de paginacao estritos | Default apenas para parametro ausente | [parametro isolado e default complementar](../../../../tests/task-listing-routes.test.ts#L31) | M | Aprovado | Repositorio simulado |
| Parametros de paginacao estritos | Limites inclusivos | [minimos e maximos inclusivos](../../../../tests/task-listing-routes.test.ts#L31) | M | Aprovado | Offset maximo simulado |
| Parametros de paginacao estritos | Parametros repetidos | [duplicatas literais e codificadas](../../../../tests/task-query.test.ts#L14) | M | Aprovado | Parser direto; alias repetido tambem via HTTP |
| Parametros de paginacao estritos | Nomes invalidos | [nomes especiais, arrays e objetos](../../../../tests/task-query.test.ts#L14) | M | Aprovado | Parser direto e casos HTTP |
| Parametros de paginacao estritos | Valores invalidos | [formatos decimais e controles](../../../../tests/task-query.test.ts#L14) | M | Aprovado | Inclui controles e quebra literal no parser direto |
| Parametros de paginacao estritos | Envelope de query invalida | [400 integral, sem consulta ou reflexo](../../../../tests/task-listing-routes.test.ts#L96) | M | Aprovado | Repositorio simulado |
| Ordenacao deterministica | Timestamps diferentes | [ordem por timestamp](../../../../tests/schema-integration/task-listing-routes.test.ts#L131) | PG | Aprovado | Timestamps fixos |
| Ordenacao deterministica | Empate de timestamp | [desempate por UUID](../../../../tests/schema-integration/task-listing-routes.test.ts#L131) | PG | Aprovado | UUIDs fixos; ordem de insercao distinta |
| Ordenacao deterministica | Tentativa de alterar a ordem | [ordenacao configuravel rejeitada](../../../../tests/task-listing-routes.test.ts#L96) | M | Aprovado | Parametro sort |
| Paginacao e continuacao | Pagina completa com mais resultados | [pagina completa com proxima](../../../../tests/schema-integration/task-listing-routes.test.ts#L144) | PG | Aprovado | Limite 2 e proximo offset 2 |
| Paginacao e continuacao | Pagina completa sem mais resultados | [pagina completa terminal](../../../../tests/schema-integration/task-listing-routes.test.ts#L144) | PG | Aprovado | Offset 3 em cinco linhas |
| Paginacao e continuacao | Pagina parcial | [pagina parcial](../../../../tests/schema-integration/task-listing-routes.test.ts#L144) | PG | Aprovado | Terceira pagina com um item |
| Paginacao e continuacao | Proximo offset exatamente 100000 | [soma igual ao teto](../../../../tests/task-listing-routes.test.ts#L46) | M | Aprovado | Offset 99950 e limite 50 simulados |
| Paginacao e continuacao | Proximo offset excede 100000 | [soma excede o teto](../../../../tests/task-listing-routes.test.ts#L46) | M | Aprovado | Offset 99999 e limite 2 simulados |
| Paginacao e continuacao | Offset 100000 com resultados adicionais | [teto com continuacao bloqueada](../../../../tests/task-listing-routes.test.ts#L46) | M | Aprovado | Offset 100000 simulado |
| Paginacao e continuacao | Offset 100000 sem resultados adicionais | [teto sem mais resultados](../../../../tests/task-listing-routes.test.ts#L46) | M | Aprovado | Offset 100000 simulado |
| Paginacao e continuacao | Paginas consecutivas com dados estaveis | [sequencia sem repeticao ou omissao](../../../../tests/schema-integration/task-listing-routes.test.ts#L144) | PG | Aprovado | Dados estaveis; sem teste de concorrencia |
| Erros de listagem e diagnosticos seguros | Indisponibilidade reconhecida | [503 de falha reconhecida](../../../../tests/task-listing-routes.test.ts#L142) | M | Aprovado | Falha simulada no executor |
| Erros de listagem e diagnosticos seguros | Falha inesperada | [500 de falha inesperada](../../../../tests/task-listing-routes.test.ts#L142) | M | Aprovado | Falha simulada no executor |
| Erros de listagem e diagnosticos seguros | Resultado invalido | [pagina invalida ou inconsistente](../../../../tests/task-listing-routes.test.ts#L167) | M | Aprovado | Adapter simulado; sondagem invalida no mesmo arquivo |
| Erros de listagem e diagnosticos seguros | Diagnostico sanitizado e sem retry | [reqId, sanitizacao e tentativa unica](../../../../tests/task-listing-routes.test.ts#L142) | M | Aprovado | Marcadores ficticios; inclui casos de query e sondagem no arquivo |
| Escopo HTTP e preservacao da criacao | HEAD sem listagem | [HEAD sem consulta](../../../../tests/task-listing-routes.test.ts#L124) | M | Aprovado | Injecao HTTP |
| Escopo HTTP e preservacao da criacao | Listagem sem escrita | [comparacao integral antes e depois](../../../../tests/schema-integration/task-listing-routes.test.ts#L144) | PG | Aprovado | Assercao sobre o estado final nos casos de listagem |
| Escopo HTTP e preservacao da criacao | Contrato de criacao preservado | [POST persistido e recuperado](../../../../tests/schema-integration/task-listing-routes.test.ts#L174) | PG | Aprovado | Regressao HTTP de criacao tambem executada |

## Rastreabilidade individual das 18 tarefas

| Tarefa | Evidencia de conclusao |
| --- | --- |
| 1.1 | [Mapper e cardinalidade](../../../../src/postgres-task-repository.ts#L47); [RETURNING](../../../../tests/postgres-task-repository.test.ts#L51) e [cardinalidade invalida](../../../../tests/postgres-task-repository.test.ts#L97) aprovados em memoria. |
| 1.2 | [Contrato e assinaturas](../../../../src/task-repository.ts#L9), [SELECT qualificado e parametros](../../../../tests/postgres-task-repository.test.ts#L263) e typecheck sem diagnosticos para implementacoes e fixtures. |
| 1.3 | [Cardinalidade e sondagem](../../../../tests/postgres-task-repository.test.ts#L286), [resultado invalido sem resposta parcial](../../../../tests/task-listing-routes.test.ts#L200) e [classificacao e tentativa unica](../../../../tests/task-listing-routes.test.ts#L142). |
| 2.1 | [Extracao e decodificacao local](../../../../src/task-query.ts#L29); [tabela de codificacao e segmentos](../../../../tests/task-query.test.ts#L14). |
| 2.2 | [Casos validos](../../../../tests/task-query.test.ts#L5) e [invalidos](../../../../tests/task-query.test.ts#L14); [configuracao global preservada](../../../../src/app.ts#L20). |
| 2.3 | [Handler central](../../../../src/http-errors.ts#L81); [400 de listagem com reqId](../../../../tests/task-listing-routes.test.ts#L96) e [400 de criacao](../../../../tests/task-listing-routes.test.ts#L86). |
| 3.1 | [Registro local de GET](../../../../src/task-routes.ts#L49); [query invalida](../../../../tests/task-listing-routes.test.ts#L96) e [HEAD](../../../../tests/task-listing-routes.test.ts#L124) com zero chamadas. |
| 3.2 | [Schema e representacao](../../../../src/task-response.ts#L11); [200 vazio e campos publicos](../../../../tests/task-listing-routes.test.ts#L31) e [representacao persistida](../../../../tests/schema-integration/task-listing-routes.test.ts#L131). |
| 3.3 | [Tabela de paginas e teto](../../../../tests/task-listing-routes.test.ts#L46), com uma chamada por requisicao. |
| 4.1 | [Runtime usa o executor existente](../../../../src/server-runtime.ts#L50); [liberacao e encerramento em sucesso e falha](../../../../tests/server-runtime.test.ts#L222). |
| 5.1 | [Envelopes seguros, reqId e tentativa unica](../../../../tests/task-listing-routes.test.ts#L142); [sondagem invalida sem pagina parcial](../../../../tests/task-listing-routes.test.ts#L200). |
| 5.2 | [Convivencia e envelopes de POST](../../../../tests/task-listing-routes.test.ts#L67); [ordenacao configuravel rejeitada](../../../../tests/task-listing-routes.test.ts#L96); regressao integral em 11.3.1. |
| 6.1 | [Quatro casos reais](../../../../tests/schema-integration/task-listing-routes.test.ts#L122); [teto simulado](../../../../tests/task-listing-routes.test.ts#L46). |
| 6.2 | [Fechamento HTTP e ausencia independente](../../../../tests/schema-integration/task-listing-routes.test.ts#L58); [identidade e encerramento administrativo](../../../../tests/support/isolated-schema.ts#L88); resultados de 12.1.1. |
| 7.1 | [README](../../../../README.md) e [contrato de listagem](../../../../docs/task-listing.md), incluindo exemplos, teto, snapshot, custo e timeout. |
| 7.2 | Resultados aprovados da etapa 11.3.1 registrados na secao de validacao em memoria. |
| 7.3 | Resultados aprovados da etapa 12.1.1 registrados nas secoes PostgreSQL e isolamento. |
| 7.4 | Resultados, limites e matriz consolidados neste documento e revisados com verificacoes Git e OpenSpec strict. |

## Limitacoes conhecidas e exclusoes

Paginacao por offset sem snapshot entre requisicoes pode repetir ou omitir itens sob escritas concorrentes. Offsets profundos podem elevar o custo, sem novo indice nesta mudanca. O teto foi exercitado em memoria, sem inserir 100000 registros reais. O timeout de aquisicao existente permanece; consultas ja em execucao ficam sem timeout especifico da aplicacao. Este ciclo ficou sem novo teste TCP, interrupcao fisica da conexao nos cenarios simulados, execucao em taskflow_dev, medicao de cobertura percentual ou validacao CI independente. Links relativos devem ser revistos quando o diretorio for movido para arquivamento.

Fora do escopo: frontend, autenticacao, CORS, filtros, busca, ordenacao configuravel, contagem total, cursor, GET /tasks/:id, atualizacao e exclusao de tarefas, campos novos, migrations, indices e dependencias adicionais.

## Veredito

Validacao funcional aprovada com base nas etapas 11.3.1 e 12.1.1. Publicacao, merge e arquivamento pertencem a etapas posteriores.
