# Tasks

## 1. Configuracao do projeto

- [x] 1.1 Adicionar Fastify, pg, Vitest e tipos necessarios; ajustar TypeScript e scripts de desenvolvimento, build, typecheck e testes; verificar instalacao e typecheck sem mudar desnecessariamente o formato do pacote.
- [x] 1.2 Criar fabrica Fastify separada do entrypoint, com repositorio injetavel e encerramento de recursos; verificar com teste Vitest que inicia e fecha sem abrir porta.
- [x] 1.3 Documentar requisitos Node/PostgreSQL UTF-8 e variaveis DATABASE_URL e TEST_DATABASE_URL, sem credenciais reais; verificar existencia dos scripts e comandos compativeis com Windows.

## 2. Validacoes

- [x] 2.1 Definir schema estrito de title/description sem coercao, defaults ou remocao de propriedades; testar com Vitest tipos invalidos e rejeicao de campos desconhecidos, inclusive id/status/createdAt com valores validos e null.
- [x] 2.2 Aplicar trim ao titulo antes da contagem por pontos de codigo; testar limites 1/120/121, vazio/apenas espacos, 120/121 emojis U+1F600 e sequencias U+0065 U+0301 sem normalizacao.
- [x] 2.3 Validar description opcional preservando espacos e string vazia, convertendo ausencia para null interno e rejeitando null de entrada; testar limites 0/500/501 pontos de codigo, emojis e tipos invalidos.
- [x] 2.4 Documentar exemplos de trim, Unicode, descricao ausente/vazia e campos proibidos; verificar correspondencia com os cenarios da spec.

## 3. PostgreSQL

- [x] 3.1 Configurar pool com timeout finito e ambiente de testes dedicado; verificar conexao UTF-8, teardown e falha clara da suite de integracao quando TEST_DATABASE_URL nao estiver disponivel.
- [x] 3.2 Criar migracao versionada para tasks com UUID/default, title e description com CHECKs, pending/default e created_at com precisao de milissegundos; aplicar em banco de teste e verificar defaults, NOT NULL, limites Unicode e ausencia de unicidade de titulo.
- [x] 3.3 Implementar repositorio create com SQL parametrizado e INSERT RETURNING, omitindo campos gerados; testar em PostgreSQL real UUID, pending, data, descricao nula/vazia/com espacos e titulos duplicados.
- [x] 3.4 Documentar migracao, precondicao gen_random_uuid() e rollback operacional preservando dados; verificar migracao em banco descartavel e instrucoes locais.

## 4. Endpoint POST /tasks

- [x] 4.1 Registrar rota com validacao antes de inserir e resposta JSON completa obtida do repositorio; testar com Fastify.inject criacao minima/completa e 201 somente apos persistencia confirmada.
- [x] 4.2 Mapear created_at para createdAt UTC ISO 8601 e definir schema de resposta com description nullable; verificar UUID, titulo apos trim, descricao e pending nos testes HTTP.
- [ ] 4.3 Cobrir com inject JSON malformado, corpo ausente, lista/escalares/null e toda a matriz de entradas invalidas; verificar 400 e zero chamadas ao repositorio.
- [ ] 4.4 Documentar exemplos HTTP de entrada e resposta, incluindo duplicados e ausencia de idempotencia; conferir exemplos contra testes da rota.

## 5. Tratamento de erros

- [ ] 5.1 Centralizar envelope error com code/message estaveis e details por campo quando aplicavel; testar 400 e garantir que mensagens internas nao sejam expostas.
- [ ] 5.2 Classificar indisponibilidade por codigos estruturados de rede/driver/SQLSTATE e timeout conhecido; testar 503 para casos identificados e 500 para erros inesperados, incluindo falhas nao classificadas de insercao.
- [ ] 5.3 Registrar diagnosticos internos com identificador de requisicao sem expor SQL, credenciais ou stack traces nas respostas; testar ausencia desses dados e ausencia de retry automatico.
- [ ] 5.4 Documentar respostas 400/503/500 e resultado incerto em queda de conexao apos commit; verificar alinhamento com o design sem prometer ausencia de linha apos falha de infraestrutura.

## 6. Verificacao integrada

- [ ] 6.1 Executar testes Vitest via HTTP com PostgreSQL real e consultar as linhas; verificar criacao minima/completa, limites Unicode, preservacao de descricao, UUIDs distintos para titulos duplicados e mesmo instante de createdAt.
- [ ] 6.2 Testar conexao real controlada a banco indisponivel e falha inesperada simulada; verificar respectivamente 503 e 500 sem afetar ambientes de desenvolvimento/producao.
- [ ] 6.3 Executar typecheck, build e suites unitarias/HTTP/integracao com isolamento e teardown; registrar resultados e conferir cobertura de todos os cenarios aprovados sem adicionar autenticacao, prioridade, prazo ou outros endpoints.

