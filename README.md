# TaskFlow API

Base Node.js/TypeScript com Fastify, driver pg e Vitest. A infraestrutura PostgreSQL e a migracao versionada 0001 estao implementadas. A migracao foi aplicada em taskflow_test.public, onde a tabela tasks existe; nao foi aplicada em taskflow_dev. O repositorio PostgreSQL foi implementado, mas ainda aguarda validacao por integracao real. O servidor inicia sem conexao com PostgreSQL e o endpoint POST /tasks ainda nao foi implementado.

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

Ctrl+C encerra o servidor. A fabrica em src/app.ts nao chama listen; src/server.ts e o entrypoint. A fabrica aceita taskRepository opcional e fecha seu metodo close, quando fornecido, junto com a aplicacao. O repositorio PostgreSQL implementado ainda aguarda validacao por integracao real e nao esta conectado ao entrypoint. Nao ha fallback em memoria.

## Configuracao do PostgreSQL

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

O projeto nao usa dotenv nem carrega .env automaticamente. Os scripts npm atuais continuam usando o ambiente herdado do CMD. Para carregar .env explicitamente, use o recurso nativo do Node:

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

Use o carregamento explicito acima para evitar digitar credenciais na linha de comando. O servidor ainda nao consome essas URLs nem conecta ao banco. A fabrica de pools e o executor de migracoes ja estao implementados; a migracao 0001 foi aplicada em taskflow_test.public. Migracoes nao sao executadas automaticamente no startup. A suite de verificacao read-only esta descrita abaixo.

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

Vitest usa Fastify.inject sem abrir porta. A suite verifica injeção e isolamento do repositorio, fechamento de recursos e que POST /tasks continua sem registro. npm.cmd run typecheck inclui src e tests; npm.cmd run build emite somente src para dist.

## Verificacao PostgreSQL (tarefa 3.1)

A fabrica em src/database.ts recebe explicitamente development ou integration. Ela usa somente DATABASE_URL ou TEST_DATABASE_URL, respectivamente, sem fallback. Antes de criar o pool, exige PostgreSQL local em localhost:5432, usuario taskflow_app e banco taskflow_dev ou taskflow_test conforme o ambiente. Parametros extras na URL sao rejeitados para impedir substituicao do destino.

O timeout de conexao e 3000 ms; conexoes ociosas expiram apos 1000 ms. O pool de integracao tem no maximo uma conexao e sessoes read-only, com statement timeout de 3000 ms. withDatabasePool executa pool.end() em finally; pool.query gerencia a liberacao dos clientes. Ao usar a fabrica diretamente, o chamador deve fechar o pool em finally. O servidor ainda nao instancia o pool.

No CMD:

```bat
npm.cmd run typecheck
npm.cmd run build
npm.cmd test
npm.cmd run test:integration
```

npm.cmd test e test:watch usam apenas testes unitarios, com pg simulado nos testes da fabrica; nao precisam de banco ou .env. test:integration carrega .env explicitamente via Node e executa somente tests/integration. A verificacao exige TEST_DATABASE_URL e confirma current_database() = taskflow_test, server_encoding = UTF8 e transaction_read_only = on. Nao cria tabelas nem executa migracoes ou escritas.

Nao ha fallback para DATABASE_URL: ausencia, URL invalida ou destino diferente falham antes de construir o pool. Erros de conexao da integracao sao reportados sem URL, senha ou mensagem bruta do driver. Variaveis previamente definidas no CMD continuam tendo precedencia sobre .env.

Para conferir a falha sem configurar a variavel (nao carrega .env), em um CMD separado:

```bat
set "TEST_DATABASE_URL="
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.mts
```

O resultado esperado e falha com TEST_DATABASE_URL is required, sem tentativa de conexao. A verificacao e somente de configuracao/conexao. A migracao 0001 e a tabela tasks ja estao disponiveis em taskflow_test.public. Os testes de migracao em schemas isolados foram executados separadamente; o repositorio PostgreSQL ainda aguarda sua propria validacao por integracao real. O endpoint POST /tasks permanece pendente.
