# TaskFlow API

Base Node.js/TypeScript com Fastify, driver pg e Vitest. Nesta etapa o servidor inicia sem rotas de aplicacao e sem conexao com PostgreSQL. POST /tasks, migracoes e persistencia serao adicionados nas proximas tarefas.

## Requisitos

- Node.js >= 22.12.0 e npm.
- Para a futura persistencia: PostgreSQL 14 ou superior, banco com server_encoding UTF8 e gen_random_uuid() disponivel.
- Os testes atuais nao precisam de PostgreSQL ou variaveis de conexao.

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

Ctrl+C encerra o servidor. A fabrica em src/app.ts nao chama listen; src/server.ts e o entrypoint. A fabrica aceita taskRepository opcional e fecha seu metodo close, quando fornecido, junto com a aplicacao. Nao existe repositorio concreto ou fallback em memoria nesta etapa.

## Configuracao do PostgreSQL

Variaveis reservadas para a etapa de persistencia:

| Variavel | Finalidade |
| --- | --- |
| DATABASE_URL | Conexao do servidor com o banco da aplicacao. |
| TEST_DATABASE_URL | Conexao com banco dedicado e descartavel dos futuros testes de integracao. |

Formato: postgresql://USER:PASSWORD@HOST:5432/DATABASE. Substitua os placeholders localmente; nao versione credenciais. TEST_DATABASE_URL deve apontar para banco diferente do banco da aplicacao e nunca para producao.

Exemplo com placeholders no CMD (a configuracao ainda nao e consumida pelo servidor):

```bat
set DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/taskflow
set TEST_DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/taskflow_test
```

Essas variaveis valem somente para a sessao atual do CMD. Arquivos .env nao sao carregados automaticamente. Nao ha migracoes nem scripts de integracao nesta etapa.

## Testes iniciais

Vitest usa Fastify.inject sem abrir porta. A suite verifica injeção e isolamento do repositorio, fechamento de recursos e que POST /tasks continua sem registro. npm.cmd run typecheck inclui src e tests; npm.cmd run build emite somente src para dist.
