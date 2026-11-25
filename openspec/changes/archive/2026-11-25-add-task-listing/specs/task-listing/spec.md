# Spec Delta

## Purpose

Permitir a consulta paginada de tarefas persistidas pela API, com ordem deterministica, validacao estrita da query e respostas previsiveis para clientes.

## ADDED Requirements

### Requirement: Listagem e representacao publica
GET /tasks MUST retornar HTTP 200 com exatamente items, nextOffset e truncated quando a listagem for bem-sucedida. Cada item MUST conter exatamente id, title, description, status e createdAt, preservando os valores persistidos. createdAt MUST representar o instante persistido em UTC ISO 8601 com milissegundos.

#### Scenario: Listagem de tarefas persistidas
- **WHEN** uma requisicao valida encontra tarefas na pagina solicitada
- **THEN** a API retorna HTTP 200 e somente items, nextOffset e truncated
- **AND** cada item contem somente id, title, description, status e createdAt em UTC ISO 8601 com milissegundos, correspondente ao instante persistido

#### Scenario: Preservacao da descricao
- **WHEN** as tarefas selecionadas tem description null, vazia ou com espacos
- **THEN** os itens preservam esses valores exatamente como persistidos

#### Scenario: Banco sem tarefas
- **WHEN** uma requisicao valida consulta um banco sem tarefas
- **THEN** a API retorna HTTP 200 com items vazio, nextOffset null e truncated false

#### Scenario: Pagina alem dos resultados
- **WHEN** um offset valido esta alem do ultimo resultado
- **THEN** a API retorna HTTP 200 com items vazio, nextOffset null e truncated false

### Requirement: Decodificacao unica da query
A API MUST separar os pares em & e separar nome e valor no primeiro = antes da decodificacao. MUST interpretar + literal como espaco e %2B como sinal de mais, e decodificar nomes e valores uma unica vez. MUST rejeitar escapes malformados, sequencias UTF-8 invalidas e segmentos vazios em uma query nao vazia.

#### Scenario: Percent encoding valido
- **WHEN** a query contem l%69mit=%35%30
- **THEN** a API aceita a query como limit igual a 50

#### Scenario: Mais literal e mais codificado
- **WHEN** a query contem limit=+5 ou limit=%2B5
- **THEN** a API interpreta os valores como espaco seguido de 5 ou sinal de mais seguido de 5, respectivamente
- **AND** retorna HTTP 400 sem chamar o repositorio

#### Scenario: Delimitadores codificados e decodificacao unica
- **WHEN** a query contem limit=1%26offset%3D0 ou limit=%2531
- **THEN** a API retorna HTTP 400 sem chamar o repositorio, sem reinterpretar o valor como novos pares nem decodifica-lo novamente

#### Scenario: Codificacao invalida
- **WHEN** um nome ou valor contem escape percentual malformado ou sequencia UTF-8 invalida, como %ZZ ou %FF
- **THEN** a API retorna HTTP 400 sem chamar o repositorio

#### Scenario: Segmento vazio em query nao vazia
- **WHEN** a query contem um segmento vazio, como em limit=1&&offset=0, &limit=1 ou limit=1&
- **THEN** a API retorna HTTP 400 sem chamar o repositorio

### Requirement: Parametros de paginacao estritos
A API MUST aceitar apenas limit e offset, com nomes exatos e sem repeticao apos decodificar. Os valores MUST ser inteiros decimais canonicos em digitos ASCII, sem sinais, espacos ou zeros iniciais, exceto o valor 0. limit MUST estar entre 1 e 100 e offset entre 0 e 100000, inclusive. A API MUST aplicar os padroes 50 e 0 somente aos parametros ausentes e rejeitar entradas invalidas sem coercao ou descarte de propriedades.

#### Scenario: Query ausente ou vazia
- **WHEN** a requisicao omite a query ou termina somente em ?
- **THEN** a API aplica limit 50 e offset 0

#### Scenario: Default apenas para parametro ausente
- **WHEN** a query fornece apenas limit=2 ou apenas offset=3
- **THEN** a API preserva o parametro fornecido e aplica somente o default do parametro ausente

#### Scenario: Limites inclusivos
- **WHEN** a query fornece limit=1&offset=0 ou limit=100&offset=100000
- **THEN** a API aceita os valores informados

#### Scenario: Parametros repetidos
- **WHEN** limit ou offset aparece mais de uma vez, inclusive por nomes equivalentes apos decodificacao ou com valores iguais
- **THEN** a API retorna HTTP 400 sem chamar o repositorio

#### Scenario: Nomes invalidos
- **WHEN** a query usa nome desconhecido, vazio ou com outra capitalizacao, sintaxe de array ou objeto, ou nome especial como __proto__, constructor ou prototype
- **THEN** a API retorna HTTP 400 sem chamar o repositorio, inclusive quando o nome invalido resulta de decodificacao

#### Scenario: Valores invalidos
- **WHEN** um parametro esta presente sem valor, com valor vazio, negativo, com sinal, espacos, fracao, notacao cientifica, zeros iniciais desnecessarios ou fora da faixa
- **THEN** a API retorna HTTP 400 sem substituir o valor por um default e sem chamar o repositorio

#### Scenario: Envelope de query invalida
- **WHEN** qualquer regra de decodificacao ou de parametros da query e violada
- **THEN** a API retorna HTTP 400 com exatamente {"error":{"code":"VALIDATION_ERROR","message":"Invalid task query","details":[{"field":"query","message":"Invalid query parameters"}]}}
- **AND** a API nao consulta o repositorio nem reflete a entrada invalida

### Requirement: Ordenacao deterministica
A API MUST ordenar a listagem por created_at DESC, id DESC, com as tarefas mais recentes primeiro e desempate por UUID em ordem descendente. A ordenacao MUST ser deterministica para dados estaveis e nao configuravel pelo cliente.

#### Scenario: Timestamps diferentes
- **WHEN** a pagina contem tarefas com instantes de criacao diferentes
- **THEN** as tarefas mais recentes aparecem primeiro independentemente da ordem de seus UUIDs

#### Scenario: Empate de timestamp
- **WHEN** duas ou mais tarefas tem o mesmo instante de criacao
- **THEN** o UUID em ordem descendente determina a ordem relativa

#### Scenario: Tentativa de alterar a ordem
- **WHEN** a query inclui um parametro de ordenacao
- **THEN** a API retorna HTTP 400 sem chamar o repositorio

### Requirement: Paginacao e continuacao
A API MUST retornar no maximo limit itens a partir do offset solicitado. MUST determinar se ha resultados adicionais sem contagem total e sem expor a linha de sondagem. Sem mais resultados, MUST retornar nextOffset null e truncated false. Com mais resultados, MUST retornar offset + limit e truncated false se a soma for ate 100000. Se exceder 100000, MUST retornar nextOffset null e truncated true, sem ajustar a soma para o teto.

#### Scenario: Pagina completa com mais resultados
- **WHEN** a pagina tem limit itens, ha resultado adicional e offset + limit esta abaixo de 100000
- **THEN** a API devolve somente os limit itens, nextOffset igual a offset + limit e truncated false

#### Scenario: Pagina completa sem mais resultados
- **WHEN** ha exatamente limit resultados a partir do offset
- **THEN** a API devolve todos os itens da pagina, nextOffset null e truncated false

#### Scenario: Pagina parcial
- **WHEN** ha menos resultados que limit e pelo menos um a partir do offset
- **THEN** a API devolve os itens disponiveis, nextOffset null e truncated false

#### Scenario: Proximo offset exatamente 100000
- **WHEN** a query tem offset=99950 e limit=50 e ha resultado adicional
- **THEN** a API devolve 50 itens, nextOffset 100000 e truncated false

#### Scenario: Proximo offset excede 100000
- **WHEN** a query tem offset=99999 e limit=2 e ha resultado adicional
- **THEN** a API devolve os dois itens, nextOffset null e truncated true

#### Scenario: Offset 100000 com resultados adicionais
- **WHEN** offset e 100000 e ha mais resultados que limit a partir desse offset
- **THEN** a API devolve limit itens, nextOffset null e truncated true

#### Scenario: Offset 100000 sem resultados adicionais
- **WHEN** offset e 100000 e ha no maximo limit resultados a partir desse offset
- **THEN** a API devolve os itens disponiveis, inclusive uma lista vazia quando aplicavel, nextOffset null e truncated false

#### Scenario: Paginas consecutivas com dados estaveis
- **WHEN** o cliente segue nextOffset com o mesmo limit e as tarefas permanecem estaveis entre requisicoes
- **THEN** as paginas consecutivas mantem a ordem e nao repetem nem omitem itens entre os offsets acessiveis

A paginacao por offset nao oferece garantia de snapshot consistente entre requisicoes sob escritas concorrentes.

### Requirement: Erros de listagem e diagnosticos seguros
A API MUST manter os envelopes HTTP 503 e 500 existentes para indisponibilidade reconhecida e falha inesperada, respectivamente. Resultados invalidos MUST produzir 500 sem resposta parcial. A API MUST preservar identificador de requisicao e logging sanitizado. Respostas e logs MUST NOT expor SQL, credenciais, stack traces, dados internos ou entradas invalidas do cliente. A listagem MUST NOT repetir consultas automaticamente.

#### Scenario: Indisponibilidade reconhecida
- **WHEN** uma query valida encontra indisponibilidade reconhecida do PostgreSQL
- **THEN** a API retorna HTTP 503 com {"error":{"code":"DATABASE_UNAVAILABLE","message":"Database unavailable"}}

#### Scenario: Falha inesperada
- **WHEN** a leitura falha por um motivo nao classificado como indisponibilidade
- **THEN** a API retorna HTTP 500 com {"error":{"code":"INTERNAL_ERROR","message":"Internal server error"}}

#### Scenario: Resultado invalido
- **WHEN** a persistencia retorna um resultado invalido, inclusive uma pagina que mistura registros validos e invalidos
- **THEN** a API retorna o mesmo HTTP 500 integral, sem devolver itens nem resposta parcial de sucesso

#### Scenario: Diagnostico sanitizado e sem retry
- **WHEN** uma query invalida ou falha de listagem gera diagnostico
- **THEN** a resposta permanece sanitizada e o log mantem o identificador da requisicao sem incluir SQL, credenciais, stack traces, dados internos ou entradas invalidas
- **AND** uma consulta que falha nao e repetida automaticamente

### Requirement: Escopo HTTP e preservacao da criacao
A API MUST desabilitar HEAD automatico exclusivamente para GET /tasks. HEAD /tasks MUST NOT consultar o repositorio. A listagem MUST NOT modificar tarefas persistidas. POST /tasks MUST preservar integralmente os requisitos canonicos de task-creation e seus contratos de sucesso e erro.

#### Scenario: HEAD sem listagem
- **WHEN** o cliente envia HEAD /tasks
- **THEN** a API nao oferece HEAD automatico para a rota de listagem nem consulta o repositorio

#### Scenario: Listagem sem escrita
- **WHEN** o cliente lista tarefas
- **THEN** a listagem nao modifica tarefas persistidas

#### Scenario: Contrato de criacao preservado
- **WHEN** o cliente envia POST /tasks apos a introducao da listagem
- **THEN** os requisitos canonicos de task-creation e os contratos existentes de sucesso e erro continuam aplicaveis
