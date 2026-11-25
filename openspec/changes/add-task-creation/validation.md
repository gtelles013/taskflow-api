# Evidencias de validacao de add-task-creation

## Escopo e referencias

Validacao final de POST /tasks conforme a [especificacao](specs/task-creation/spec.md), o [design](design.md) e o [checklist](tasks.md). O registro consolida os resultados aprovados de 6.2H, 6.3B.3 e 6.3C. A tarefa 6.3 permanece aberta no checklist, com 21 de 22 tarefas concluidas.

- `41dd563` registra o teste TCP controlado da 6.2H.
- `4bec9dc` registra a configuracao unitaria com `envDir: false` validada na 6.3B.3 e identifica o HEAD da execucao 6.3C.
- SHA-256 de `vitest.unit.config.mts` na 6.3B.3 e na 6.3C: `5C5084E43F46AB1AF858479621C3844D249A36B906D3651791D5D01EF520CA9D`.

## Resultados das execucoes aprovadas

| Etapa | Comando executado ou referencia disponivel | Resultado | Saida | Duracao Vitest |
| --- | --- | --- | --- | --- |
| 6.3B.3 | `npm.cmd run typecheck` | Aprovado | 0 | Nao aplicavel |
| 6.3B.3 | `npm.cmd run build` | Aprovado, com `dist/server.js` gerado e ignorado pelo Git | 0 | Nao aplicavel |
| 6.3B.3 | `npm.cmd test -- --bail=1` | 12 arquivos e 469 testes aprovados, zero falhas e zero ignorados | 0 | 4,00 s |
| 6.2H | Execucao do arquivo `tests/integration/postgres-unavailability.test.ts`, registrada em `41dd563` | 1 arquivo e 1 teste aprovado, zero falhas e zero ignorados na execucao final | Codigo numerico nao disponivel | Nao disponivel |
| 6.3C | `node --env-file=.env node_modules/vitest/vitest.mjs run --config vitest.integration.config.mts tests/integration/database.test.ts --bail=1` | 1 arquivo e 1 teste aprovado, zero falhas e zero ignorados | 0 | 435 ms |
| 6.3C | `node --env-file=.env node_modules/vitest/vitest.mjs run --config vitest.schema-integration.config.mts --bail=1` | 3 arquivos e 12 testes aprovados, zero falhas e zero ignorados | 0 | 4,56 s |

As quatro execucoes finais distintas somam **17 arquivos de testes e 483 testes aprovados**, com zero falhas e zero ignorados. Typecheck e build tambem foram aprovados. A 6.3B.3 validou funcionalmente a configuracao unitaria com `envDir: false` e encerrou sem falhas de teardown ou avisos de handles residuais. A linha de comando exata, o codigo numerico de saida e a duracao da 6.2H nao constam nas evidencias disponiveis para este registro.

Na 6.2H, a primeira execucao falhou na sincronizacao do teardown. A causa foi corrigida e a execucao posterior autorizada passou. Um servidor TCP proprio em loopback e porta efemera recebeu o inicio do handshake do driver PostgreSQL real e deixou a aquisicao expirar. O teste confirmou HTTP 503 exato e sanitizado, uma tentativa, nenhum SQL enviado ao cliente e encerramento completo do servidor, sockets e pool.

Na 6.3C, o diagnostico confirmou conexao real com `taskflow_test`, codificacao `UTF8` e sessao read-only. A suite de integracao real usou schemas descartaveis proprios e terminou sem falhas de teardown ou avisos de handles residuais.

## Matriz de cobertura

Os caminhos abaixo sao relativos a raiz do repositorio. Os testes HTTP usam `Fastify.inject`. Na suite unitaria, banco, clientes ou repositorios sao substituidos conforme o caso. Na suite de schemas, a rota usa persistencia PostgreSQL real.

| Cenario aprovado | Evidencia executada | Arquivos de teste |
| --- | --- | --- |
| Criacao minima e completa, HTTP 201 apos confirmacao | Resposta com os cinco campos, espera pelo repositorio em memoria e comparacao com a linha persistida no PostgreSQL | `tests/task-routes.test.ts`, `tests/schema-integration/task-routes.test.ts` |
| Titulo obrigatorio, trim e limites Unicode | Titulo ausente, vazio ou so com espacos rejeitado. Casos com 1, 120 e 121 pontos de codigo, emojis suplementares e sequencias combinantes, com trim antes da contagem. A integracao compara texto e comprimento armazenados e verifica contagem de linhas apos rejeicoes | `tests/task-validation.test.ts`, `tests/task-routes.test.ts`, `tests/schema-integration/task-routes.test.ts` |
| Descricao opcional, vazia, com espacos e limites Unicode | Omissao produz `null` no JSON e SQL `NULL` na linha. String vazia e espacos sao preservados. Casos com 500 e 501 pontos cobrem ASCII, emojis e combinantes | `tests/task-validation.test.ts`, `tests/task-routes.test.ts`, `tests/schema-integration/task-routes.test.ts`, `tests/schema-integration/task-repository.test.ts` |
| Null explicito, tipos invalidos e campos desconhecidos | Titulo e descricao rejeitam `null` explicito e tipos invalidos. Campos extras e os campos gerados `id`, `status` e `createdAt` sao rejeitados, inclusive com valores validos ou `null`. HTTP 400 e zero chamadas de criacao no repositorio simulado | `tests/task-validation.test.ts`, `tests/task-routes.test.ts`, `tests/http-errors.test.ts` |
| Corpo ausente, JSON malformado ou valor nao objeto | HTTP 400 com detalhe de corpo quando aplicavel, incluindo lista, escalares e `null`. JSON malformado e rejeitado antes do validador da rota, sem tentativa de persistencia | `tests/task-routes.test.ts`, `tests/http-errors.test.ts` |
| UUID, status inicial e data gerados pelo banco | O INSERT omite campos gerados. PostgreSQL preenche UUID v4, `pending` e timestamp com precisao de milissegundos. A resposta UTC ISO 8601 representa o mesmo instante de `created_at` na linha | `tests/schema-integration/migrations.test.ts`, `tests/schema-integration/task-repository.test.ts`, `tests/schema-integration/task-routes.test.ts` |
| Titulos duplicados e nao idempotencia | Duas requisicoes criam duas linhas com o mesmo titulo normalizado, UUIDs distintos e duas respostas 201 | `tests/task-routes.test.ts`, `tests/schema-integration/task-routes.test.ts` |
| HTTP 400, 503 e 500, sanitizacao e logging seguro | Envelopes publicos estaveis e detalhes de validacao aplicaveis. Erros inesperados de insercao simulados retornam 500. A classificacao de indisponibilidade e testada em memoria e o 503 tambem pelo TCP real. Logs em memoria conferem correlacao por ID e omissao de dados sensiveis | `tests/http-errors.test.ts`, `tests/http-logging.test.ts`, `tests/integration/postgres-unavailability.test.ts` |
| Ausencia de retry | Uma tentativa nos erros simulados e na aquisicao TCP. Constraints reais falham uma vez por chamada. A perda simulada do resultado apos INSERT confirmado deixa uma linha e uma tentativa | `tests/http-errors.test.ts`, `tests/postgres-query-executor.test.ts`, `tests/integration/postgres-unavailability.test.ts`, `tests/schema-integration/task-repository.test.ts` |
| Migracoes, defaults e constraints | Migracao 0001 e historico versionado aplicados no schema proprio. Reaplicacao sem nova versao e rollback do historico diante de conflito deliberado. Defaults e constraints conferidos em PostgreSQL real. Caminhos de falha do migrador exercitados com mocks | `tests/migrations.test.ts`, `tests/migrations-initial.test.ts`, `tests/schema-integration/migrations.test.ts` |
| Isolamento e teardown | Diagnostico real read-only, schemas exclusivos e limpeza por identidade. Casos simulados exercitam colisao, perda de identidade e ordem de fechamento. A composicao e o encerramento da aplicacao tambem sao verificados em memoria | `tests/integration/database.test.ts`, `tests/isolated-schema.test.ts`, `tests/server-runtime.test.ts`, `tests/schema-integration/task-routes.test.ts`, `tests/schema-integration/task-repository.test.ts` |

## Isolamento, teardown e limites da evidencia

- O destino validado e `localhost:5432/taskflow_test`, com `TEST_DATABASE_URL` sem fallback. Os testes de escrita reconfirmam o banco antes da escrita e operam em schemas `taskflow_test_` seguidos de 32 digitos hexadecimais, criados pela propria execucao. O SQL de tarefas e historico e qualificado. A execucao nao aplica migracoes em `public`.
- O helper reconfirma banco, nome e OID antes do DROP. A aplicacao Fastify e o pool HTTP fecham antes do DROP. O cliente administrativo e liberado e seu pool e encerrado depois. O migrador encerra seus recursos ao terminar.
- Tres casos HTTP e um caso de repositorio confirmaram independentemente a ausencia dos schemas com consultas a `pg_namespace` apos o teardown. Nos demais casos, a evidencia de remocao deriva do DROP bem-sucedido pelo helper. Os nomes dos schemas nao foram registrados.
- O TCP demonstra handshake indisponivel em endpoint proprio. Nenhuma instancia PostgreSQL foi desligada. A perda de resposta apos INSERT confirmado foi simulada no executor, sem interrupcao fisica da conexao.
- A aprovacao da suite unitaria demonstra o funcionamento com a configuracao corrigida. Ela nao constitui monitoramento independente de acessos a arquivos de ambiente.
- O [README](../../../README.md) descreve o script de integracao como verificacao read-only, mas a configuracao desse script tambem descobre o teste TCP. Os comandos filtrados da 6.3C preservaram o escopo. O README permanece pendente de ajuste fora desta etapa.

## Conclusao tecnica

As evidencias aprovadas cobrem os cenarios da especificacao e do design para POST /tasks, incluindo persistencia real, isolamento e teardown. Os criterios tecnicos da tarefa 6.3 estao atendidos. A marcacao no checklist depende de revisao e autorizacao separada.
