# Design

## Context

A motivacao esta em [proposal.md](proposal.md) e o contrato aprovado em [specs/task-listing/spec.md](specs/task-listing/spec.md). O Fastify 5.12.8 ja injeta um repositorio de tarefas que usa o executor e o pool PostgreSQL existentes. A tabela tasks ja contem os campos de leitura. O mapper atual combina a validacao da linha com a exigencia de uma unica linha em create.

## Goals / Non-Goals

**Goals:** separar validacao HTTP, leitura e representacao publica, garantir paginacao deterministica para dados estaveis e preservar o comportamento de criacao e encerramento.

**Non-Goals:** alterar o parser global, Ajv, o contrato de POST /tasks, a politica de timeout ou a estrutura do banco. O escopo funcional segue a proposta.

## Decisions

### Contrato de dominio

Adicionar TaskListInput com limit e offset numericos, TaskListResult com items: Task[] e hasMore: boolean, e TaskRepository.list(input: TaskListInput): Promise<TaskListResult>. A rota entrega inteiros ja validados. items contem de zero a limit tarefas na ordem da consulta. hasMore e verdadeiro somente quando existe uma linha adicional valida depois dos itens devolvidos. hasMore verdadeiro implica items.length igual a limit. Uma pagina vazia ou parcial tem hasMore falso. Uma pagina completa pode ter hasMore falso.

Preservar a assinatura e o comportamento de create e o close opcional. Atualizar os mocks e a composicao das aplicacoes que injetam TaskRepository. Manter a leitura no mesmo repositorio evita duplicar mapeamento, classificacao de falhas e ciclo de vida do pool.

### Validacao local da query

Usar request.raw.url na rota GET /tasks. No Fastify instalado, request.url le essa mesma URL, e o roteador analisa o alvo sem substituir req.url na configuracao atual, que nao usa rewriteUrl. Extrair o trecho apos o primeiro ?. O parser padrao ja decodifica e pode descartar segmentos vazios, por isso request.query perde informacao necessaria ao contrato. A validacao fica em um modulo local de listagem, e a rota nao usa schema de query do Ajv para essa entrada.

1. Tratar query ausente ou vazia como ausencia de parametros. Para query nao vazia, separar em & e rejeitar segmentos vazios. Em cada segmento, exigir = e separar no primeiro = antes de decodificar.
2. Em cada nome e valor, converter + literal em espaco e aplicar decodeURIComponent exatamente uma vez. Falhas de escape percentual ou UTF-8 produzem erro de query. Delimitadores codificados permanecem parte do valor decodificado, e %2B produz um sinal de mais.
3. Aceitar somente os nomes exatos limit e offset. Detectar duplicatas depois da decodificacao, inclusive quando os valores coincidem. A lista permitida e o controle de nomes vistos evitam interpretar arrays, objetos, nomes especiais ou capitalizacao alternativa.
4. Verificar a string inteira como decimal ASCII canonico. Aceitar 0 ou um digito de 1 a 9 seguido de quaisquer digitos de 0 a 9. Usar um teste de fim absoluto, como (?![\s\S]), para rejeitar tambem uma quebra de linha final que a ancora $ pode deixar passar. Rejeitar espacos, sinais, controles e qualquer caractere fora dos digitos permitidos. Rejeitar mais de tres digitos para limit ou seis para offset antes da conversao numerica para evitar perda de precisao com valores longos.
5. Converter somente os lexemas validos com Number, conferir limit de 1 a 100 e offset de 0 a 100000, e aplicar 50 e 0 somente aos parametros ausentes.

Falhas conhecidas da validacao geram um erro especifico de query, sem reter o valor recebido. O fluxo termina antes de repository.list. O handler central retorna exatamente {"error":{"code":"VALIDATION_ERROR","message":"Invalid task query","details":[{"field":"query","message":"Invalid query parameters"}]}} com HTTP 400. A rota nao altera o parser global, as opcoes Ajv ou a validacao de POST /tasks.

### Persistencia e sondagem

Reutilizar o schema qualificado pela validacao e citacao existentes no repositorio. A consulta candidata e:

```sql
SELECT id, title, description, status, created_at
FROM "<schema-validado>".tasks
ORDER BY created_at DESC, id DESC
LIMIT $1::integer OFFSET $2::integer
```

O repositorio chama o executor com as strings decimais de limit + 1 e offset, compativeis com a interface de parametros atual. O identificador de schema vem da configuracao ja validada do repositorio. Valores do cliente entram somente como parametros. A consulta evita SELECT *, COUNT(*) e interpolacao de valores da query.

Extrair a validacao e o mapeamento de uma linha da logica existente, preservando UUID, titulo, descricao, status e data valida. create continua exigindo exatamente uma linha. list exige um objeto com array rows de zero a limit + 1 entradas e valida todas, inclusive a sondagem. Resultado estruturalmente invalido, linha invalida ou excesso de linhas gera falha interna, sem pagina parcial. Somente apos validar o conjunto, derivar hasMore e omitir a linha adicional. O repositorio determina a existencia de mais resultados. A politica de continuacao publica fica na rota.

### Rota e representacao HTTP

Registrar GET /tasks junto a POST /tasks e definir exposeHeadRoute: false somente em GET. A resposta 200 tem schema com exatamente items, nextOffset e truncated, todos obrigatorios. items reutiliza a representacao publica de uma tarefa com exatamente id, title, description, status e createdAt. Preservar description como recebida da persistencia e serializar createdAt como UTC ISO 8601 com milissegundos via toISOString. Preservar o schema, a assinatura e os envelopes de POST /tasks.

| Resultado | nextOffset | truncated |
| --- | --- | --- |
| hasMore falso | null | false |
| hasMore verdadeiro e offset + limit <= 100000 | offset + limit | false |
| hasMore verdadeiro e offset + limit > 100000 | null | true |

Calcular esses campos com o resultado de list, sem consulta adicional e sem ajustar a soma para o teto. HEAD /tasks nao aciona o repositorio.

### Erros, logging e ciclo de vida

Adicionar ao handler central um ramo proprio para o erro de query, com mensagens fixas. Preservar a traducao do erro de criacao para Invalid task input. Em create e list, reutilizar a fronteira existente que registra a identidade das falhas PostgreSQL reconhecidas. A rota mapeia somente essa identidade para 503 DATABASE_UNAVAILABLE. Falhas inesperadas de consulta, mapeamento ou serializacao usam 500 INTERNAL_ERROR. Nenhuma consulta e repetida automaticamente.

O serializer req padrao do Fastify inclui url. O LogController atual, com disableRequestLogging: true, ja suprime os logs automaticos de entrada, fim, 404 e falhas de serializacao. O roteador entrega a query ao parser sem executar decodeURI sobre o trecho da query. Escapes malformados da query de /tasks chegam ao validador local, que converte a falha de decodificacao no erro fixo. Falhas de transporte ou de URL anterior ao reconhecimento da rota seguem o tratamento do framework. O clientError padrao tem log em trace, abaixo do nivel info usado pelo runtime atual. Manter o LogController e os serializers atuais. A mudanca minima e encaminhar o novo erro ao diagnostico sanitizado existente, mantendo reqId e passando apenas categoria, status e metadados ja permitidos, sem req, URL, query ou erro bruto. Verificar esses caminhos com marcadores sensiveis em testes de logging.

A app factory continua registrando as rotas quando recebe o repositorio. O runtime injeta create, list e o close que encerra o pool ja existente. O repositorio usa o mesmo executor. O executor libera o cliente ao terminar a consulta, e o encerramento da aplicacao continua fechando o pool uma vez. Um pool separado de leitura aumentaria a complexidade de configuracao e teardown. A listagem nao precisa de um novo pool nem altera a politica de timeout.

### Estrategia de testes e rastreabilidade

| Requisito da delta | Cenarios | Cobertura planejada |
| --- | ---: | --- |
| Listagem e representacao publica | 4 | HTTP em memoria para envelope exato, banco vazio simulado e pagina alem dos resultados. PostgreSQL para valores persistidos, incluindo description null, vazia e com espacos, e instante de createdAt. |
| Decodificacao unica da query | 5 | Unitarios e Fastify.inject com escapes validos e invalidos, UTF-8 invalido, mais literal e codificado, delimitadores codificados, tentativa de dupla decodificacao e segmentos vazios. |
| Parametros de paginacao estritos | 7 | Unitarios para forma lexical, valores longos, controles e quebra de linha final. HTTP para defaults, limites, nomes especiais e repetidos, envelope 400 exato e zero chamadas a list. |
| Ordenacao deterministica | 3 | Unitario confere a clausula de ordem e HTTP rejeita ordenacao configuravel. PostgreSQL comprova timestamps diferentes e iguais, com desempate real por UUID. |
| Paginacao e continuacao | 8 | Unitarios verificam SQL e parametros de sondagem. HTTP com mocks cobre pagina completa com ou sem mais dados, parcial e limites 99950, 99999 e 100000. PostgreSQL compara paginas consecutivas sob dados estaveis. A pagina vazia tambem e coberta no primeiro requisito. |
| Erros de listagem e diagnosticos seguros | 4 | Unitarios cobrem zero ou multiplas linhas, sondagem valida e invalida, excesso, estrutura inconsistente, liberacao e classificacao. HTTP verifica 503 e 500 exatos, ausencia de pagina parcial, reqId, ausencia da entrada bruta nos logs e uma unica tentativa. |
| Escopo HTTP e preservacao da criacao | 3 | HTTP verifica HEAD sem repositorio e regressao de POST. Integracao compara o estado persistido antes e depois da listagem. Testes de composicao verificam list e o encerramento de aplicacao e pool. |

A integracao prepara dados apenas em schema descartavel proprio em taskflow_test, com TEST_DATABASE_URL, verificacao de identidade do banco, SQL qualificado e teardown do helper existente. Encerrar aplicacao e pool HTTP antes da remocao do schema, liberar recursos administrativos e confirmar a ausencia do schema apos o teardown. Exercitar offsets proximos a 100000 com mocks, sem inserir 100000 tarefas. Execucoes futuras com PostgreSQL real exigem autorizacao separada.

## Risks / Trade-offs

- Escritas concorrentes podem deslocar offsets entre consultas. A ordenacao e deterministica para dados estaveis, e o contrato documenta a ausencia de snapshot entre requisicoes. Cursor exigiria outro contrato e fica fora desta mudanca.
- Offsets profundos e a ordenacao composta podem elevar o custo mesmo com resposta pequena. O teto e a sondagem limitam o volume devolvido. A tabela atual permite a consulta, e qualquer indice ou migration adicional deve partir de evidencia de custo.
- O timeout do executor cobre aquisicao, sem limitar consulta ja iniciada. Preservar a politica atual e avaliar eventual mudanca separadamente com evidencia operacional.
- A reutilizacao do mapper e da classificacao pode alterar o fluxo de criacao se as invariantes forem misturadas. Manter as checagens de cardinalidade separadas e executar a regressao de POST antes de concluir a mudanca.

## Migration Plan

A listagem usa a tabela tasks existente e a mesma configuracao de conexao. Implantar a nova versao apenas em destinos com a migracao 0001 ja aplicada. O rollback consiste em voltar a versao anterior da aplicacao, preservando tabela e dados. A mudanca dispensa migration, indice e dependencia adicionais.
