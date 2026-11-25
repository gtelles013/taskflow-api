# Tasks

## 1. Dominio e persistencia

- [x] 1.1 Extrair a validacao por linha do mapper PostgreSQL e manter a exigencia de exatamente uma linha em create. Cobrir por testes do repositorio a rejeicao de cardinalidade incorreta e a preservacao do mapeamento de criacao.
- [x] 1.2 Introduzir TaskListInput, TaskListResult e TaskRepository.list, preservando create e close. No mesmo bloco, implementar list no repositorio PostgreSQL e atualizar todas as implementacoes e fixtures tipadas para permitir o proximo typecheck autorizado sem interfaces incompletas. Verificar por testes a selecao explicita no schema qualificado, ORDER BY created_at DESC, id DESC e LIMIT/OFFSET parametrizados com limit + 1 e offset, sem contagem total.
- [x] 1.3 Validar de zero a limit + 1 registros, inclusive a linha de sondagem, antes de derivar hasMore e devolver ate limit itens. Cobrir resultados vazios, parciais, completos e inconsistentes, sondagem invalida, ausencia de pagina parcial e preservacao da classificacao confiavel de falhas.

## 2. Validacao da query

- [x] 2.1 Implementar a validacao local a partir de request.raw.url, separando a query em & e no primeiro = antes de decodificar. Converter + literal em espaco e decodificar nomes e valores uma unica vez. Cobrir escapes validos e invalidos, UTF-8 invalido, delimitadores codificados, %2B, dupla codificacao e segmentos vazios.
- [x] 2.2 Restringir nomes a limit e offset e detectar repeticoes apos a decodificacao. Validar a forma decimal ASCII integral antes da conversao numerica e aplicar defaults 50 e 0 apenas a parametros ausentes, com faixas 1 a 100 e 0 a 100000. Cobrir nomes especiais, arrays, objetos, valores longos, controles, quebras de linha finais e demais formatos invalidos, sem mudar o parser global ou o Ajv.
- [x] 2.3 Integrar o erro especifico de query ao handler central com mensagens fixas e diagnostico sanitizado com reqId. Verificar o envelope 400 exato da listagem e preservar o envelope de criacao.

## 3. Camada HTTP

- [x] 3.1 Registrar GET /tasks com exposeHeadRoute: false somente nessa rota. Usar Fastify.inject para verificar o envelope 400 completo e zero chamadas ao repositorio diante de query invalida ou HEAD.
- [x] 3.2 Definir o schema HTTP 200 com items, nextOffset e truncated e reutilizar os cinco campos publicos de Task, preservando description e serializando createdAt em UTC ISO 8601 com milissegundos. Verificar com Fastify.inject que a resposta contem apenas os campos previstos, inclusive na pagina vazia.
- [x] 3.3 Calcular nextOffset e truncated a partir de hasMore e offset + limit, sem nova consulta nem ajuste artificial do teto. Verificar com mocks o fim dos resultados, as paginas parcial e completa, a soma igual ou superior a 100000 e o offset atual igual a 100000 com e sem resultados adicionais.

## 4. Composicao e ciclo de vida

- [x] 4.1 Conectar a listagem ao repositorio injetado pela app factory e pelo runtime, reutilizando executor e pool e preservando a politica de timeout. Verificar com fixtures tipadas a composicao, a liberacao de clientes e o encerramento dos recursos nos caminhos de sucesso e falha.

## 5. Regressao HTTP em memoria

- [x] 5.1 Verificar via Fastify.inject os envelopes exatos 503 e 500 em falhas reconhecidas, inesperadas e resultados invalidos. Usar marcadores sensiveis para confirmar que respostas e logs omitem detalhes internos e entradas invalidas, preservam reqId, nao retornam sucesso parcial e nao repetem a consulta.
- [x] 5.2 Preservar a suite de POST /tasks e verificar a convivencia das duas rotas com o mesmo repositorio, incluindo as respostas de sucesso e erro de criacao e a rejeicao de ordenacao configuravel na listagem.

## 6. Integracao PostgreSQL

- [x] 6.1 Adicionar cenarios em schemas descartaveis de taskflow_test para banco vazio, pagina alem dos resultados, tarefas persistidas, timestamps distintos e iguais, desempate por UUID e paginas consecutivas em dados estaveis. Conferir os campos publicos, incluindo variacoes de description, e comparar os registros antes e depois para comprovar a ausencia de escrita. Cobrir offsets extremos com os mocks da tarefa 3.3.
- [x] 6.2 Reutilizar as protecoes de isolamento e o encerramento existentes. Assegurar no teste o fechamento da aplicacao e do pool HTTP antes da remocao do schema proprio, a liberacao dos recursos administrativos e a verificacao da ausencia do schema apos o teardown. A execucao real fica na tarefa 7.3.

## 7. Documentacao e validacao final

- [x] 7.1 Atualizar o README e a documentacao publica de GET /tasks com exemplos verificaveis de paginacao, envelopes, teto e truncamento. Registrar a ausencia de snapshot entre requisicoes, o custo de offsets profundos e a politica de timeout existente.
- [x] 7.2 Mediante autorizacao, executar typecheck, build e a suite unitaria e HTTP em memoria, incluindo a regressao de POST /tasks. Registrar os comandos, codigos de saida, contagens e diagnosticos.
- [x] 7.3 Mediante autorizacao separada, executar as suites PostgreSQL necessarias somente em taskflow_test e schemas descartaveis proprios. Registrar resultados, regressao de criacao e evidencias de isolamento e teardown.
- [x] 7.4 Consolidar os resultados, limitacoes e rastreabilidade dos sete requisitos e 34 cenarios em validation.md. Executar OpenSpec strict e verificacoes Git. Marcar cada tarefa somente apos a aprovacao de suas evidencias.
