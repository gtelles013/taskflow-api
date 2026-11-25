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


## Validacao complementar da integridade dos campos Unicode

A auditoria final identificou que NUL poderia chegar ao PostgreSQL. A analise complementar identificou que a codificacao UTF-8 poderia substituir unidades UTF-16 isoladas silenciosamente por U+FFFD. Essas consequencias do caminho anterior foram inferidas por leitura estatica, sem reproducao experimental. A especificacao foi atualizada antes da implementacao.

A verificacao compartilhada usa `/[\u0000\uD800-\uDFFF]/u` para rejeitar NUL e substitutos isolados antes do repositorio. A expressao foi escolhida por compatibilidade com TypeScript ES2022. Dependencias, rota, handler, repositorio, executor e migracao foram preservados.

### Etapa 8.6 - typecheck, build e testes em memoria

Cada comando foi executado uma vez.

| Comando | Saida | Duracao | Resultado |
| --- | ---: | ---: | --- |
| `npm.cmd run typecheck` | 0 | 1,23 s | Sem diagnosticos TypeScript |
| `npm.cmd run build` | 0 | 0,92 s | Build aprovado |
| `npm.cmd test -- --bail=1` | 0 | 2,69 s | 12 arquivos e 521 testes aprovados, zero falhas e zero ignorados |

O executor mediu as duracoes de typecheck e build. O Vitest reportou a duracao da suite. Os 469 casos anteriores passaram junto com 36 novos unitarios e 16 novos HTTP. O build gerou dist/server.js e dist/task-validation.js, ignorados pelo Git, com ES2022 preservado.

A configuracao unitaria manteve envDir: false e excluiu as suites de integracao. Os spies foram restaurados entre casos. A execucao em memoria ocorreu sem PostgreSQL e sem sockets. Nenhuma leitura de .env foi reportada na auditoria ou na execucao autorizada. A evidencia nao inclui monitoramento independente de acessos a arquivos. O runner encerrou sem avisos de teardown incompleto ou handles residuais.

| Categoria | Unitarios | HTTP em memoria |
| --- | ---: | ---: |
| NUL em title e description | 12 | 2 |
| Substitutos UTF-16 invalidos | 20 | 8 |
| NUL literal em JSON malformado | 0 | 1 |
| Preservacao de Unicode valido | 4 | 5 |
| Total | 36 | 16 |

- Os [testes unitarios](../../../tests/task-validation.test.ts#L65) confirmam o campo de TaskValidationError para NUL em ambos os campos, substitutos altos e baixos isolados, pares invalidos e unidades isoladas adjacentes a pares validos.
- Os [testes HTTP em memoria](../../../tests/task-routes.test.ts#L475) confirmam o valor decodificado no validador, HTTP 400 com o envelope VALIDATION_ERROR completo e o campo correto, zero chamadas ao repositorio e ausencia do conteudo invalido na resposta. O [NUL literal sem escape](../../../tests/task-routes.test.ts#L521) recebe erro de corpo antes da validacao de campo.
- Os [casos validos](../../../tests/task-validation.test.ts#L99) e os [casos HTTP positivos](../../../tests/task-routes.test.ts#L546) preservam pares validos, U+10000, U+10FFFF, emojis, sequencias combinantes e U+FFFD explicito. Os testes unitarios tambem cobrem tabulacao e quebra de linha internas ja permitidas. A suite completa preservou limites, trim, descricao vazia, espacos e omissao. Os novos casos HTTP confirmam o fechamento das aplicacoes Fastify e dos repositorios simulados.

### Etapa 8.7 - HTTP com PostgreSQL real

O comando abaixo foi executado uma vez.

```powershell
node --env-file=.env node_modules/vitest/vitest.mjs run --config vitest.schema-integration.config.mts tests/schema-integration/task-routes.test.ts --bail=1
```

O Vitest reportou 1 arquivo, 3 testes aprovados, zero falhas e zero ignorados, em 2,14 s. O codigo de saida foi 0. Pelas assercoes e pelo fluxo dos [tres testes](../../../tests/schema-integration/task-routes.test.ts#L113), foram 15 requisicoes via Fastify.inject, 9 respostas HTTP 201, 6 respostas HTTP 400 e 9 registros persistidos e conferidos. Essas quantidades decorrem dos casos aprovados. O runner reportou apenas arquivos e testes.

A [comparacao com as linhas persistidas](../../../tests/schema-integration/task-routes.test.ts#L79) confirmou UUID v4, status pending, createdAt UTC ISO 8601 e o instante armazenado. Os testes confirmaram emojis, sequencias combinantes, contagem por pontos de codigo, trim do titulo, SQL NULL para descricao omitida, descricao vazia e espacos preservados, e titulos duplicados com UUIDs distintos. As seis entradas acima dos limites mantiveram a contagem de linhas.

TEST_DATABASE_URL foi obrigatoria, sem fallback. O destino validado foi localhost:5432/taskflow_test, com usuario taskflow_app. O codigo confirma current_database() antes das escritas. O carregamento de .env ficou restrito ao comando e a resolucao de configuracao autorizados, sem leitura direta ou exposicao de credenciais.

O [helper](../../../tests/support/isolated-schema.ts#L63) cria schemas proprios e aleatorios, sem CREATE SCHEMA IF NOT EXISTS. O SQL de persistencia e migracao e qualificado pelo schema proprio. As sessoes pertinentes usam search_path restrito a pg_catalog. O pool HTTP e separado do administrativo. A [aplicacao e o pool HTTP](../../../tests/schema-integration/task-routes.test.ts#L59) fecham antes do DROP. O helper revalida banco, nome e OID, remove o schema, libera o cliente e encerra o pool administrativo. Os tres casos criaram e removeram tres schemas e passaram por [tres verificacoes independentes de ausencia](../../../tests/schema-integration/task-routes.test.ts#L68). Os nomes nao foram anotados. O runner nao emitiu avisos de handles residuais, e nenhuma consulta adicional foi executada fora da suite.

### Consolidacao e limites

- Validacao historica: 483 testes aprovados em quatro execucoes finais distintas.
- Etapa 8.6: 521 testes em memoria aprovados, incluindo 52 novos casos.
- Etapa 8.7: 3 testes HTTP com PostgreSQL real aprovados, reexecutados da suite existente.

O conjunto atual possui **535 casos distintos**, sendo 521 em memoria, 1 de indisponibilidade TCP controlada, 1 de diagnostico PostgreSQL e 12 de integracao em schemas descartaveis, dos quais 3 foram reexecutados na 8.7. Nenhuma execucao reuniu os 535 casos. As demais suites de integracao mantem sua evidencia historica.

NUL e substitutos isolados foram rejeitados em memoria antes do repositorio. U+FFFD explicito tambem foi verificado em memoria. Esses casos ficaram fora dos testes PostgreSQL, que confirmaram o caminho valido coberto pela suite existente. O codigo de persistencia foi preservado. A aplicacao da migracao em taskflow_dev continua sem comprovacao, e o servidor nao foi iniciado para validacao operacional nesta etapa. Autenticacao, prioridade, prazo, idempotencia, outros endpoints e frontend ficaram fora do escopo.

### Rastreabilidade e conclusao

| Tarefa | Evidencia |
| --- | --- |
| 7.1 | Validador implementado, typecheck e build aprovados e regressoes aprovadas em 8.6 |
| 7.2 | 52 novos casos aprovados em 8.6, com 36 unitarios e 16 HTTP em memoria |
| 7.3 | Contrato HTTP e disponibilidade do endpoint documentados. Decisao tecnica registrada no design |
| 7.4 | Execucoes autorizadas de 8.6 e 8.7 aprovadas, OpenSpec strict aprovado e evidencias consolidadas |

HEAD de referencia: `f26150ecb0b053cd52c3519ace6efa977e60cadf`. SHA-256 aprovados dos arquivos de trabalho:

| Arquivo | SHA-256 |
| --- | --- |
| src/task-validation.ts | 204C324F4EA02697554B908F1FA6A1110EF3712A28A7CCFC74F43D61C3BF91B1 |
| tests/task-validation.test.ts | 97400745AC8D20A2469C301B860966319781B0C84C34A6E90B68A8CB9A7D2C32 |
| tests/task-routes.test.ts | 7F232DB02D637A920CA8B9F2906D1A46CB62F77312EAF5B129E9D400C93645A9 |
| specs/task-creation/spec.md | 6E6E4D38BECB6C351EBA7BA0852835343CFE1D2177B5176C2CDCE68180CAD3B9 |
| design.md | 873D98610475044D2C35AE012EF788E4ADF168E311D4261F1C99B761AB88D316 |
| tasks.md | 8F7F7B691411CD8FE81337F861AC7F5A55577A4660141DB6782709ED60C7A911 |
| docs/task-creation.md | BC59DA8FE9463E41A0E51258FFD04F02C31F0E2DDD5478E345FE561ED7ECAADF |
| README.md | 92B82A6D5F3E771ADCDE4DDD028F7283670D779A2B220A248C5449453A35DFA5 |
| validation.md antes do acrescimo | 1BA15BA11EE8EE7487776B976975B374562E1F7463C280489403D774D5345349 |

As evidencias de implementacao, regressao em memoria, persistencia real do caminho valido e documentacao sustentam o fechamento de 7.1 a 7.4. A marcacao depende de autorizacao separada. O checklist permanece em 22/26 nesta etapa.
