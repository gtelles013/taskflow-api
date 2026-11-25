# task-creation Specification

## Purpose
Definir a criacao de tarefas da TaskFlow API com entrada estrita, persistencia PostgreSQL e respostas HTTP previsiveis para clientes.

## Requirements

### Requirement: Corpo HTTP estrito
O endpoint POST /tasks MUST aceitar somente um objeto JSON com title e, opcionalmente, description. Campos desconhecidos MUST causar HTTP 400, sem criacao de tarefa. id, status e createdAt MUST ser rejeitados quando enviados pelo cliente, independentemente de seu valor.

#### Scenario: Campos desconhecidos
- **WHEN** um objeto valido inclui qualquer campo adicional, como priority ou dueDate
- **THEN** a API retorna 400 e nenhuma tarefa e persistida

#### Scenario: Campos controlados pelo sistema
- **WHEN** o cliente inclui id, status ou createdAt, individualmente ou em conjunto, mesmo com valor aparentemente valido ou null
- **THEN** a API retorna 400 e nenhuma tarefa e persistida

#### Scenario: Corpo invalido
- **WHEN** o corpo esta ausente, contem JSON malformado, ou e uma lista, string, numero, booleano ou null
- **THEN** a API retorna 400 e nenhuma tarefa e persistida

### Requirement: Titulo normalizado e validado
title MUST ser uma string obrigatoria. A API MUST aplicar trim antes de validar e persistir o titulo. O resultado MUST conter de 1 a 120 pontos de codigo Unicode, inclusive, sem contagem por unidades UTF-16 ou grafemas. A API MUST rejeitar U+0000 e substitutos UTF-16 isolados. Dentro das demais regras, a API MUST aceitar e preservar Unicode valido, inclusive pares substitutos validos e U+FFFD fornecido pelo cliente, sem normalizar, remover ou substituir caracteres alem do trim previsto.

#### Scenario: Trim antes do limite
- **WHEN** title contem espacos nas extremidades e exatamente 120 pontos de codigo apos trim
- **THEN** a API retorna 201 e persiste e retorna somente o titulo apos trim

#### Scenario: Menor titulo valido
- **WHEN** title contem exatamente um ponto de codigo apos trim
- **THEN** a API retorna 201

#### Scenario: Titulo invalido
- **WHEN** title esta ausente, e null, numero, booleano, objeto, lista, vazio, apenas espacos ou tem 121 pontos de codigo apos trim
- **THEN** a API retorna 400 e nenhuma tarefa e persistida

#### Scenario: Pontos de codigo suplementares
- **WHEN** title contem 120 emojis U+1F600, cada um representado por um par substituto UTF-16
- **THEN** a API aceita o titulo e retorna 201

#### Scenario: Limite Unicode excedido
- **WHEN** title contem 121 emojis U+1F600
- **THEN** a API retorna 400 e nenhuma tarefa e persistida

#### Scenario: Sem contagem por grafemas
- **WHEN** title contem 60 repeticoes da sequencia U+0065 U+0301
- **THEN** a API conta 120 pontos de codigo e preserva a sequencia sem normalizacao Unicode

#### Scenario: NUL no titulo
- **WHEN** title contem U+0000, inclusive quando e composto apenas por esse caractere
- **THEN** a API retorna 400 com o envelope VALIDATION_ERROR existente e detalhe para title, sem chamar o repositorio nem tentar persistir

#### Scenario: Substitutos isolados no titulo
- **WHEN** title contem uma unidade substituta UTF-16 alta ou baixa sem seu par valido
- **THEN** a API retorna 400 com o envelope VALIDATION_ERROR existente e detalhe para title, sem chamar o repositorio nem tentar persistir

### Requirement: Descricao opcional preservada
description MUST aceitar somente string quando presente, com no maximo 500 pontos de codigo Unicode. A API MUST preservar espacos e nao aplicar trim ou normalizacao Unicode. Ausencia MUST ser persistida como NULL e retornada como null; string vazia MUST permanecer vazia. A API MUST rejeitar U+0000 e substitutos UTF-16 isolados. A API MUST aceitar e preservar Unicode valido, incluindo U+FFFD explicito, sem remocao ou substituicao.

#### Scenario: Descricao ausente
- **WHEN** uma requisicao valida omite description
- **THEN** a API retorna 201 com description null e persiste NULL

#### Scenario: Descricao vazia
- **WHEN** description e uma string vazia e o titulo e valido
- **THEN** a API retorna 201 e preserva a string vazia no banco e na resposta

#### Scenario: Espacos preservados
- **WHEN** description contem espacos iniciais e finais, inclusive uma string apenas de espacos dentro do limite
- **THEN** a API retorna 201 e preserva exatamente esses espacos

#### Scenario: Limite da descricao
- **WHEN** description contem exatamente 500 pontos de codigo, inclusive emojis suplementares
- **THEN** a API retorna 201 e preserva o conteudo

#### Scenario: Descricao invalida
- **WHEN** description e null, numero, booleano, objeto, lista ou string com 501 pontos de codigo
- **THEN** a API retorna 400 e nenhuma tarefa e persistida

#### Scenario: NUL na descricao
- **WHEN** description contem U+0000, inclusive quando e composta apenas por esse caractere
- **THEN** a API retorna 400 com o envelope VALIDATION_ERROR existente e detalhe para description, sem chamar o repositorio nem tentar persistir

#### Scenario: Substitutos isolados na descricao
- **WHEN** description contem uma unidade substituta UTF-16 alta ou baixa sem seu par valido
- **THEN** a API retorna 400 com o envelope VALIDATION_ERROR existente e detalhe para description, sem chamar o repositorio nem tentar persistir

#### Scenario: Preservacao de Unicode valido nos campos de texto
- **WHEN** title ou description contem pares substitutos validos, emojis, sequencias combinantes ou U+FFFD fornecido explicitamente, dentro das demais regras de validacao
- **THEN** a API retorna 201 e preserva esses caracteres na persistencia e na resposta, com apenas o trim previsto para title

### Requirement: Criacao persistida com campos gerados
A API MUST persistir cada tarefa no PostgreSQL com id UUID gerado pelo sistema, title validado, description, status pending e createdAt gerado pelo sistema. MUST retornar 201 somente apos confirmacao da persistencia, com objeto JSON contendo id, title, description, status e createdAt. createdAt MUST ser UTC em ISO 8601.

#### Scenario: Criacao completa
- **WHEN** POST /tasks recebe title valido e description valida
- **THEN** retorna 201 com a tarefa completa, UUID valido, status pending e createdAt UTC ISO 8601
- **AND** uma consulta ao PostgreSQL confirma os mesmos valores, comparando createdAt pelo instante representado

#### Scenario: Criacao minima
- **WHEN** POST /tasks recebe somente title valido
- **THEN** retorna 201 com UUID gerado, titulo normalizado, description null, status pending e createdAt gerado
- **AND** a tarefa existe no PostgreSQL

#### Scenario: Titulos duplicados
- **WHEN** duas requisicoes validas usam o mesmo titulo
- **THEN** ambas retornam 201 e criam duas linhas com UUIDs distintos

### Requirement: Tratamento de erros
A API MUST retornar 400 para entradas invalidas, 503 para indisponibilidade identificavel do PostgreSQL e 500 para falhas inesperadas. Respostas de erro MUST ter codigo e mensagem estaveis; erros de validacao MUST incluir detalhes por campo quando aplicavel. Respostas MUST NOT expor SQL, credenciais, stack traces ou mensagens internas do banco.

#### Scenario: Validacao sem acesso de escrita
- **WHEN** uma entrada invalida e recebida
- **THEN** a API retorna 400 com codigo, mensagem e detalhes aplicaveis, sem tentar inserir uma tarefa

#### Scenario: Banco indisponivel
- **WHEN** uma requisicao valida encontra indisponibilidade identificavel do PostgreSQL
- **THEN** a API retorna 503, nunca 201, e nao expoe detalhes internos

#### Scenario: Falha inesperada
- **WHEN** uma requisicao encontra erro inesperado, incluindo falha de insercao nao classificada como indisponibilidade
- **THEN** a API retorna 500, nunca 201, e nao expoe detalhes internos
