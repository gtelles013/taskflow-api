# TaskFlow API

Base Node.js/TypeScript com Fastify, driver pg e Vitest. A infraestrutura PostgreSQL e a migracao versionada 0001 estao implementadas. A migracao foi aplicada em taskflow_test.public, onde a tabela tasks existe; nao ha comprovacao de aplicacao em taskflow_dev. O repositorio PostgreSQL foi implementado e validado por seis testes reais em schemas temporarios de taskflow_test. O entrypoint cria o pool PostgreSQL e injeta o repositorio na fabrica Fastify. As rotas POST /tasks e GET /tasks ficam disponiveis quando o servidor inicia com a configuracao descrita abaixo.

Contratos e exemplos HTTP: [Criacao de tarefas](docs/task-creation.md) e [Listagem de tarefas](docs/task-listing.md).

## Requisitos

- Node.js >= 22.12.0 e npm.
- Para a infraestrutura PostgreSQL e a persistencia: PostgreSQL 14 ou superior, banco com server_encoding UTF8 e gen_random_uuid() disponivel.
- Os testes unitarios nao precisam de PostgreSQL; a suite de integracao exige TEST_DATABASE_URL.

## Comandos no CMD do Windows

Execute na raiz do projeto:

```bat
npm.cmd ci
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd start
```

Para desenvolvimento com reinicio ao editar arquivos: npm.cmd run dev.
Para testes em modo watch: npm.cmd run test:watch.

O servidor usa HOST=127.0.0.1 e PORT=3000 por padrao. Para alterar no CMD:

```bat
set HOST=127.0.0.1
set PORT=3001
npm.cmd run dev
```

O comando npm.cmd start executa dist/server.js, gerado pelo build. O entrypoint src/server.ts chama startServer, que cria o pool PostgreSQL, monta o repositorio com o executor de consultas e o injeta na fabrica em src/app.ts antes de chamar listen. O pool abre conexoes sob demanda para criar e listar tarefas. SIGINT (Ctrl+C) e SIGTERM encerram a aplicacao e o pool.

## Configuracao do PostgreSQL

Procedimento operacional, modos do executor, verificacoes e rollback preservando dados: [Migracoes PostgreSQL](docs/migrations.md).

PostgreSQL local confirmado: 18.6, localhost:5432, bancos taskflow_dev e taskflow_test com encoding UTF8 e proprietario taskflow_app.

| Variavel | Finalidade |
| --- | --- |
| DATABASE_URL | Banco taskflow_dev da aplicacao. |
| TEST_DATABASE_URL | Banco taskflow_test dedicado aos testes de integracao. |

### Arquivo local e carregamento explicito

No CMD, na raiz do projeto, copie o exemplo somente se .env ainda nao existir:

```bat
if not exist .env copy .env.example .env
```

Edite .env localmente no seu editor, substituindo CHANGE_ME pela senha correta. Nao cole senhas em comandos, logs ou conversas. Caracteres reservados da senha devem ser codificados para URL (percent-encoding). .env e ignorado pelo Git; .env.example contem somente valores ilustrativos e pode ser versionado.

Nos comandos com --env-file=.env, o Node carrega o arquivo explicitamente e preserva as variaveis ja definidas no ambiente. A suite unitaria desativa a descoberta automatica de arquivos de ambiente pelo Vite com envDir: false. Nas configuracoes de integracao, o Vite pode descobrir esses arquivos, inclusive sem --env-file=.env. Entre as variaveis que o Vite expoe pelo prefixo configurado, os valores ja definidos em process.env tem precedencia. Para carregar .env explicitamente ao iniciar a aplicacao, use o recurso nativo do Node:

```bat
node --env-file=.env --import tsx --watch src/server.ts
```

Ou, depois de npm.cmd run build:

```bat
node --env-file=.env dist/server.js
```

O Node disponibiliza as variaveis em process.env antes de iniciar a aplicacao. Variaveis ja definidas no CMD tem precedencia sobre o arquivo. Para remover valores antigos da sessao, sem exibi-los:

```bat
set "DATABASE_URL="
set "TEST_DATABASE_URL="
```

Use o carregamento explicito acima para evitar digitar credenciais na linha de comando. Para iniciar o servidor, DATABASE_URL deve estar definida para taskflow_dev em localhost:5432, com o usuario taskflow_app e senha. Para persistir tarefas, o PostgreSQL deve estar acessivel e a migracao 0001 deve ter sido aplicada nesse banco. A fabrica de pools e o executor de migracoes ja estao implementados; a migracao 0001 foi aplicada em taskflow_test.public. Migracoes nao sao executadas automaticamente no startup. A suite de verificacao read-only esta descrita abaixo.

### Validacao sem revelar credenciais

Confira a protecao do arquivo local:

```bat
git check-ignore .env
git ls-files -- .env
```

O primeiro comando deve mostrar .env; o segundo nao deve mostrar nada. Para conferir somente a presenca das variaveis carregadas, sem imprimir valores ou conectar ao PostgreSQL:

```bat
node --env-file=.env -e "for (const key of ['DATABASE_URL','TEST_DATABASE_URL']) console.log(key + ': ' + (process.env[key] ? 'definida' : 'ausente'))"
```

Esse comando confirma carregamento, nao valida senha ou conectividade. Nao use echo das URLs, set sem argumento ou impressao de process.env para fazer essa verificacao.

## Testes iniciais

Vitest usa Fastify.inject sem abrir porta. A suite verifica injeção e isolamento do repositorio, fechamento de recursos e POST /tasks com repositorio simulado: criacao, contrato de resposta, validacao e titulos duplicados. Sem repositorio injetado, a rota continua sem registro. npm.cmd run typecheck inclui src e tests; npm.cmd run build emite somente src para dist.

## Verificacao PostgreSQL (tarefa 3.1)

A fabrica em src/database.ts recebe explicitamente development ou integration. Ela usa somente DATABASE_URL ou TEST_DATABASE_URL, respectivamente, sem fallback. Antes de criar o pool, exige PostgreSQL local em localhost:5432, usuario taskflow_app e banco taskflow_dev ou taskflow_test conforme o ambiente. Parametros extras na URL sao rejeitados para impedir substituicao do destino.

O timeout de conexao e 3000 ms e conexoes ociosas expiram apos 1000 ms. Os pools de integracao definidos em src/database.ts tem no maximo uma conexao por pool e statement timeout de 3000 ms. O diagnostico usa sessoes read-only via withDatabasePool, que executa pool.end() em finally. pool.query gerencia a liberacao dos clientes. Ao usar a fabrica diretamente, o chamador deve fechar o pool em finally.

O helper de isolamento e o executor de migracoes usam pools com escrita habilitada para criar, migrar e limpar os schemas descartaveis da propria execucao. Os testes HTTP de persistencia real usam um pool de escrita separado para inserir no schema proprio. A suite qualifica o SQL de persistencia e migracao com o schema descartavel e fecha o pool HTTP antes de remover esse schema.

No CMD:

```bat
npm.cmd run typecheck
npm.cmd run build
npm.cmd test
npm.cmd run test:integration
```

npm.cmd test e npm.cmd run test:watch executam a suite unitaria e HTTP em memoria via Fastify.inject. Os acessos ao PostgreSQL sao simulados, e a configuracao unitaria desativa o carregamento automatico de arquivos .env pelo Vite.

npm.cmd run test:integration carrega .env explicitamente via Node e executa os dois testes em tests/integration:

- database.test.ts exige TEST_DATABASE_URL e confirma uma conexao real a taskflow_test, com server_encoding = UTF8 e transaction_read_only = on.
- postgres-unavailability.test.ts usa o driver pg real contra um servidor TCP proprio em loopback e porta efemera. O servidor deixa o handshake sem resposta, e o teste verifica HTTP 503 sem conectar a uma instancia PostgreSQL.

A suite de integracao real em tests/schema-integration usa vitest.schema-integration.config.mts e roda separadamente de test:integration. Ela usa TEST_DATABASE_URL para aplicar migracoes e validar persistencia em schemas descartaveis criados e removidos pela propria execucao. Os cenarios de GET /tasks incluem ordenacao, paginacao e preservacao dos registros.

Nao ha fallback para DATABASE_URL: ausencia, URL invalida ou destino diferente falham antes de construir o pool. Erros de conexao da integracao sao reportados sem URL, senha ou mensagem bruta do driver. Variaveis previamente definidas no CMD continuam tendo precedencia sobre .env.

O [teste unitario de configuracao do banco](tests/database.test.ts#L28) verifica a ausencia de TEST_DATABASE_URL com pg simulado e variaveis fornecidas pelo proprio teste. Mesmo com DATABASE_URL presente, a configuracao de integracao falha com TEST_DATABASE_URL is required antes de criar um pool. A omissao de --env-file=.env ainda permite que o Vite descubra arquivos de ambiente na configuracao de integracao. Sem filtro, essa configuracao tambem seleciona o teste TCP controlado. A migracao 0001 e a tabela tasks ja estao disponiveis em taskflow_test.public. Os testes de migracao em schemas isolados foram executados separadamente; o repositorio PostgreSQL tambem foi validado por seis testes reais em schemas temporarios.
