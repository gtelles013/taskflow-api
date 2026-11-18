# Design

## Context

Ver proposal.md para motivacao e specs/task-creation/spec.md para requisitos aprovados. O repositorio possui package.json e tsconfig.json iniciais, TypeScript, tsx e tipos Node; nao possui servidor, repositorio de dados ou testes de aplicacao. O script test atual e um placeholder. Fastify, driver PostgreSQL e Vitest serao adicionados somente na implementacao. Este design e necessario pela nova arquitetura e pelo novo modelo persistente.

## Goals / Non-Goals

**Goals:** separar validacao HTTP e persistencia, manter o contrato estrito e permitir testes HTTP sem abrir portas e integracao com PostgreSQL real.

**Non-Goals:** autenticacao, prioridade, prazo, outros endpoints, unicidade de titulo, idempotencia e camadas genericas de dominio. Nenhuma mudanca de requisitos ou codigo nesta etapa.

## Decisions

### Arquitetura e configuracao

Adotar uma fabrica de aplicacao Fastify separada do entrypoint que escuta a porta. A fabrica registra POST /tasks e recebe o repositorio de tarefas como dependencia; o entrypoint configura o pool PostgreSQL e encerra servidor/pool no shutdown.

Fluxo: JSON -> validacao de estrutura/tipos -> trim e limites Unicode -> repositorio -> INSERT RETURNING -> resposta 201.

Usar um modulo de validacao e um repositorio pequeno com operacao create. Evitar ORM e camada de servico sem logica adicional: driver pg com SQL parametrizado torna o mapeamento e o comportamento de insercao explicitos. Manter a organizacao modular existente do pacote, ajustando TypeScript para tipos Node e execucao/build consistentes; nao migrar para ESM sem necessidade. Configurar conexao por DATABASE_URL e banco de testes separado por TEST_DATABASE_URL, sem credenciais no repositorio.

### Contrato HTTP e validacoes

POST /tasks recebe objeto JSON com title string obrigatoria e description string opcional. Retorna 201 com objeto direto contendo id, title, description, status e createdAt, serializado como JSON; a resposta usa valores retornados pelo banco, nao valores presumidos antes da insercao.

Aplicar String.prototype.trim ao titulo antes da verificacao de comprimento. Contar pontos de codigo com iteracao Unicode (por exemplo Array.from), nunca String.length. Aceitar 1..120 no titulo e 0..500 na descricao. Nao aplicar normalizacao NFC/NFD nem trim na descricao. Distinguir propriedade ausente de null: ausencia vira SQL NULL; null e invalido; string vazia permanece vazia.

Validar estrutura/tipos por schema e os limites por validacao explicita apos trim. Configurar o validador para nao remover propriedades adicionais e nao converter tipos ou inserir defaults no corpo: additionalProperties false, removeAdditional false, coerceTypes false e useDefaults false. Isto evita aceitar silenciosamente campos extras ou converter numeros em strings. Campos id, status e createdAt nao pertencem ao schema de entrada e sao rejeitados mesmo com null ou valores aparentemente corretos.

JSON malformado, corpo ausente e valores JSON que nao sejam objetos retornam 400. A validacao ocorre antes de qualquer insercao. Nenhuma restricao de unicidade e aplicada ao titulo. Schemas de resposta incluem description nullable e todos os campos gerados.

### Persistencia PostgreSQL

Usar banco UTF-8 e migracao SQL versionada para tabela tasks:

| Coluna | Tipo e protecao |
| --- | --- |
| id | uuid, chave primaria, default gen_random_uuid() |
| title | text NOT NULL, CHECK char_length(title) entre 1 e 120 |
| description | text nullable, CHECK ausente ou char_length <= 500 |
| status | text NOT NULL default 'pending', CHECK status = 'pending' nesta versao |
| created_at | timestamptz NOT NULL default CURRENT_TIMESTAMP |

Usar PostgreSQL com gen_random_uuid() disponivel nativamente e documentar essa precondicao. text com CHECK explicito evita truncamento e deixa limites visiveis. A aplicacao faz o trim de acordo com JavaScript; nao duplicar esse trim com btrim SQL, cuja definicao de espaco pode divergir. PostgreSQL char_length em UTF-8 reforca a contagem de pontos de codigo. Testar paridade para emojis e caracteres combinantes.

O repositorio insere somente title e description usando parametros, omitindo campos gerados para acionar defaults. Usar INSERT ... RETURNING id, title, description, status, created_at. Uma instrucao em autocommit e atomica; nao adicionar transacao explicita para essa unica insercao. Mapear created_at para createdAt e serializar em UTC ISO 8601. Adotar precisao de milissegundos no armazenamento da data para alinhar PostgreSQL e Date do Node e evitar perda de precisao na resposta.

Nao usar persistencia em memoria como substituta em execucao. Default no banco garante que id, pending e data sejam gerados mesmo com outros consumidores internos.

### Tratamento de erros

Centralizar o formato HTTP em um handler de erros. Como detalhe tecnico do envelope aprovado, usar objeto error com code e message; em validacao, details contem field e message quando aplicavel. Codigos propostos: VALIDATION_ERROR (400), DATABASE_UNAVAILABLE (503), INTERNAL_ERROR (500). Mensagens publicas sao fixas por categoria; detalhes de campo sao controlados pela aplicacao. JSON malformado tambem e mapeado para 400.

Classificar indisponibilidade por codigos estruturados do driver/rede e SQLSTATE, nunca por texto de mensagem: exemplos incluem ECONNREFUSED, ENOTFOUND, ETIMEDOUT, erros de conexao SQLSTATE classe 08 e estados 57P01/57P02/57P03. Configurar timeout finito de conexao e reconhecer somente erros de timeout conhecidos do pool. Falhas de autenticacao/configuracao, constraints inesperadas e demais erros desconhecidos permanecem 500. Um erro nao classificado nao deve ser automaticamente tratado como indisponibilidade.

Registrar diagnosticos internos com identificador da requisicao, sem retornar SQL, stack traces, credenciais ou mensagens internas. Nao fazer retry automatico de INSERT: se a conexao cair depois de um commit, o resultado pode ser incerto. Nessa situacao retornar erro, nunca sucesso presumido; nao prometer ausencia da linha apos uma falha de infraestrutura.

### Estrategia de testes

Usar Vitest com tres niveis:
- Testes de validacao: tabela de tipos invalidos, title 1/120/121 apos trim, espacos, emojis suplementares, sequencias combinantes e description 0/500/501, ausente/null e preservacao exata.
- Testes HTTP com Fastify.inject: contrato completo de sucesso, formatos 400/503/500, JSON malformado/corpo nao objeto, rejeicao de cada campo gerado e de campos extras. Dependencia substituivel permite provar que entradas invalidas nao chamam create e simular erros classificados/inesperados.
- Integracao com PostgreSQL real: aplicar migracao em banco dedicado, criar via HTTP, consultar linha, comparar UUID/status/textos e instante de createdAt, testar duplicados e defaults/CHECKs diretamente. Cobrir contagem Unicode e erro de conexao real controlado, alem de simulacoes deterministicas.

Isolar dados de testes e fechar pool/aplicacao em teardown. Nao usar banco de desenvolvimento/producao para limpeza. A suite de integracao exige TEST_DATABASE_URL e deve falhar claramente se seu ambiente dedicado nao estiver disponivel, sem substituir o banco por mocks. Executar verificacao TypeScript e suite completa na implementacao.

## Risks / Trade-offs

- [Defaults permissivos do validador] -> configurar rejeicao sem remocao/coercao e testar campos extras explicitamente.
- [Contagem Unicode diverge entre camadas] -> usar iteracao por pontos de codigo e testes contra PostgreSQL UTF-8; grafemas compostos continuam contando varios pontos conforme aprovado.
- [Falha de conexao apos commit] -> documentar resultado incerto e evitar retries automaticos; idempotencia fora do escopo.
- [Testes dependem de banco externo] -> banco dedicado, migracoes reproduziveis e instrucoes locais para Windows.
- [Sem autenticacao] -> nenhuma propriedade de usuario e introduzida nesta versao.

## Migration Plan

1. Na implementacao, configurar runtime, dependencias, variaveis e PostgreSQL compativel em ambiente de teste.
2. Aplicar migracao versionada de criacao de tasks e verificar tipos, defaults e CHECKs.
3. Executar testes e publicar o servidor somente apos o schema existir.
4. Para rollback operacional, retirar a nova rota/versao mantendo a tabela e os dados. Reversao destrutiva da migracao somente em banco descartavel ou com autorizacao e backup; nao apagar tarefas em rollback automatico.

