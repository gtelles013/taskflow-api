# Migracoes PostgreSQL

## Estado atual e escopo

A migracao migrations/0001_create_tasks.sql foi implementada e aplicada persistentemente em taskflow_test.public, com commit e registro da versao 0001 verificados. Ela cria tasks; o executor cria taskflow_schema_migrations no mesmo schema.

Nao ha comprovacao de aplicacao em taskflow_dev. O executor atual aceita exclusivamente taskflow_test, por TEST_DATABASE_URL. Nao existe CLI dedicado ou script npm de migracao. O servidor nao executa migracoes automaticamente no startup.

O repositorio PostgreSQL teve seus seis testes reais aprovados em schemas temporarios. A rota POST /tasks ja esta implementada na fabrica Fastify quando TaskRepository e injetado. A composicao operacional no entrypoint permanece pendente na secao 6; npm start ainda nao disponibiliza esse endpoint.

## Pre-requisitos

- Node.js >= 22.12.0 e dependencias instaladas conforme o README.
- PostgreSQL compativel com pg_catalog.gen_random_uuid(); o README estabelece PostgreSQL 14 ou superior e a instalacao local confirmada e 18.6.
- Banco UTF8, acessivel em localhost:5432 pelo usuario taskflow_app.
- Permissoes para conectar, usar o schema escolhido e criar os objetos da migracao. Testes isolados exigem tambem permissao para criar seus schemas.
- Schema de destino previamente existente; runTestMigrations nao cria schemas.

A disponibilidade de pg_catalog.gen_random_uuid() e uma precondicao: a migracao usa essa funcao para gerar o UUID, sem instalar extensoes. Em uma sessao previamente confirmada como read-only em taskflow_test, as seguintes consultas podem verificar o ambiente, sem instalar ou modificar objetos:

```sql
SELECT pg_catalog.current_database(),
       pg_catalog.current_setting('server_encoding'),
       pg_catalog.current_setting('transaction_read_only');

SELECT pg_catalog.to_regprocedure('pg_catalog.gen_random_uuid()') IS NOT NULL
       AS uuid_function_available;
```

Confirmar taskflow_test, UTF8 e transaction_read_only = on antes das demais verificacoes. Uma funcao ausente requer revisao do ambiente; nao alterar extensoes ou instalacao automaticamente.

## Configuracao local sem credenciais nos comandos

Na raiz C:\Squid\taskflow, use o .env local preenchido manualmente a partir de .env.example. Nao versione esse arquivo, imprima seu conteudo ou copie senhas para comandos. Senhas com caracteres reservados precisam de percent-encoding no componente de senha.

| Variavel | Uso atual |
| --- | --- |
| DATABASE_URL | Configuracao do pool de desenvolvimento para taskflow_dev; nao e fallback de migracao. |
| TEST_DATABASE_URL | Unica variavel utilizada pelo executor e pelos testes PostgreSQL em taskflow_test. |

O carregamento e explicito com node --env-file=.env. Variaveis ja presentes no CMD prevalecem sobre o arquivo. A validacao exige localhost:5432, taskflow_app e banco correto, rejeitando parametros extras e fragmentos.

No CMD, estes comandos apenas verificam presenca e protecao; nao abrem conexao:

```bat
git check-ignore .env
git ls-files -- .env
node --env-file=.env -p "Boolean(process.env.TEST_DATABASE_URL)"
```

O primeiro deve listar .env; o segundo nao deve listar nada; o terceiro deve retornar true. Presenca nao comprova senha, destino ou conectividade.

## Formato, LF e checksums

Os arquivos ficam em migrations e seguem o formato 0001_create_tasks.sql: quatro digitos de versao, nome com letras minusculas/numeros/underscores e extensao .sql. O loader ordena nomes, rejeita versoes duplicadas e exige SQL nao vazio com o marcador {{schema}}.

.gitattributes define migrations/*.sql text eol=lf. O checksum SHA-256 usa os bytes exatos do arquivo, antes da substituicao do schema. Alterar conteudo ou terminacoes de linha altera o checksum. Nao editar uma migracao aplicada; evolucoes devem usar novos arquivos versionados.

O executor substitui {{schema}} pelo identificador validado e delimitado. Os arquivos SQL sao codigo confiavel do repositorio, sujeitos a revisao: o loader nao e um sandbox de SQL. Eles nao devem controlar BEGIN/COMMIT ou escapar do schema autorizado. A migracao atual qualifica tasks pelo marcador e usa funcoes de pg_catalog.

## Modos do executor e invocacao real

A funcao exportada em src/migrations.ts e:

```ts
runTestMigrations({
  schema: 'public',
  mode: 'initial-installation',
});
```

Ela abre conexao quando chamada; importar o modulo nao executa consultas. A conexao usa apenas TEST_DATABASE_URL e confirma o banco real antes de escrever.

| Modo | Comportamento |
| --- | --- |
| versioned, padrao se omitido | Valida historico como prefixo exato dos arquivos locais, pula versoes correspondentes e aplica todas as pendentes. |
| initial-installation | Exige public, somente 0001_create_tasks.sql/versao 0001 e ausencia das duas relacoes/tipos de destino apos o lock; nao reaproveita historico existente. |

O modo versioned admite public ou schemas taskflow_test_* ja existentes. O modo inicial nao serve para reaplicacao nem para schemas temporarios.

Abaixo esta a forma de invocar a funcao pelo Node no CMD, somente em uma operacao de instalacao inicial previamente autorizada. Este comando escreve no banco e NAO deve ser executado como verificacao de rotina:

```bat
node --env-file=.env --import tsx -e "const {runTestMigrations,MigrationError}=require('./src/migrations');runTestMigrations({schema:'public',mode:'initial-installation'}).then(v=>console.log(v)).catch(e=>{console.error(e instanceof MigrationError?e.code:'MIGRATION_FAILED');process.exitCode=1;})"
```

O destino atual taskflow_test.public ja esta instalado: repetir esse comando deve falhar com MIGRATION_INITIAL_OBJECT_EXISTS, antes de qualquer CREATE TABLE. Nao remover os objetos nem o historico para tornar a instalacao inicial executavel novamente.

Chamadas futuras do modo versioned tambem escrevem se houver arquivos pendentes. Seu uso exige revisao das versoes e autorizacao do destino; nao substitui uma verificacao read-only.

## Transacao, lock e historico

Uma execucao utiliza um cliente adquirido de um pool proprio:

1. Carrega e valida os arquivos; no modo inicial, restringe o conjunto a 0001.
2. Valida TEST_DATABASE_URL, conecta e confirma current_database() = taskflow_test.
3. Executa BEGIN e tenta pg_try_advisory_xact_lock com a chave (194865, 1).
4. Confirma que o schema existe. No modo inicial, consulta pg_class e pg_type para recusar tasks ou taskflow_schema_migrations preexistentes em public.
5. Restringe search_path a pg_catalog e cria o historico no schema escolhido. O modo inicial usa CREATE TABLE sem IF NOT EXISTS; o versionado permite historico existente.
6. Confere versao, nome e checksum; executa as migracoes pendentes e insere os registros na mesma transacao.
7. Executa COMMIT; libera cliente e encerra pool.

O historico taskflow_schema_migrations possui version (chave primaria), name, checksum e applied_at. Seu nome e sempre qualificado pelo schema. O lock e transacional e comum aos schemas dentro do mesmo banco: outro executor cooperativo recebe MIGRATION_LOCKED sem aguardar. Ele nao impede DDL manual por processos que ignorem o protocolo.

No modo versionado, o executor nao faz uma auditoria completa da estrutura de um historico preexistente. O operador deve revisar conflitos; nao assumir que IF NOT EXISTS comprova compatibilidade.

## Verificacoes posteriores somente de leitura

Apos uma aplicacao autorizada, conectar ao banco correto, taskflow_test, preferencialmente com uma conta de permissoes minimas para as consultas necessarias. Antes das consultas, estabelecer explicitamente uma transacao read-only conforme o procedimento abaixo; o mesmo procedimento deve envolver as consultas de pre-requisitos deste documento.

Executar BEGIN TRANSACTION READ ONLY e SHOW transaction_read_only; conferir que o retorno e on. Confirmar current_database() = taskflow_test antes de continuar com as demais consultas. A protecao read-only nao substitui a conferencia do destino nem as permissoes do usuario. Se o destino ou a protecao nao corresponder ao esperado, interromper as verificacoes, encerrar a transacao com ROLLBACK e fechar a conexao.

Exemplo completo para a instalacao persistente ja realizada, executado em etapas com essas conferencias:

```sql
BEGIN TRANSACTION READ ONLY;

SHOW transaction_read_only;

SELECT pg_catalog.current_database();

-- Prosseguir somente apos confirmar on e taskflow_test.
SELECT pg_catalog.to_regclass('public.tasks') AS tasks,
       pg_catalog.to_regclass('public.taskflow_schema_migrations') AS history;

SELECT version, name, checksum, applied_at
FROM public.taskflow_schema_migrations
ORDER BY version;

SELECT column_name, data_type, is_nullable, column_default, datetime_precision
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'tasks'
ORDER BY ordinal_position;

SELECT con.conname, con.contype, pg_catalog.pg_get_constraintdef(con.oid)
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class rel ON rel.oid = con.conrelid
JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
WHERE ns.nspname = 'public' AND rel.relname = 'tasks';

SELECT count(*) FROM public.tasks;

COMMIT;
```

Encerrar a transacao com COMMIT apos as verificacoes bem-sucedidas e fechar a conexao ao terminar. Em caso de erro, encerrar com ROLLBACK e fechar a conexao. Comandos que criam schemas ou aplicam migracoes sao operacoes de escrita: nao devem ser executados nessa transacao read-only e exigem um procedimento separado e autorizado.

Conferir versao unica 0001, nome 0001_create_tasks.sql, data preenchida e checksum igual aos bytes locais. No PowerShell, o hash pode ser calculado sem banco:

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath migrations/0001_create_tasks.sql
```

A comparacao deve ignorar apenas maiusculas/minusculas da representacao hexadecimal. Conferir UUID/default, title obrigatorio com comprimento 1..120, description nullable ate 500, pending/default e created_at com timezone e precisao 3. Nao ha unicidade de titulo.

A contagem de linhas e informativa: nao inserir dados de teste em public nem apagar linhas para obter contagem zero. As consultas acima leem metadados e contagem; nao alteram dados.

## Testes de migracao em schemas temporarios

A suite read-only existente continua acessivel por npm.cmd run test:integration. Ela nao aplica migracoes.

Os testes de escrita sao separados. Quando houver autorizacao especifica para criar e remover schemas temporarios, executar apenas o arquivo de migracoes no CMD:

```bat
node --env-file=.env node_modules/vitest/vitest.mjs run --config vitest.schema-integration.config.mts tests/schema-integration/migrations.test.ts --bail=1
```

Esse comando executa tres testes reais: aplicacao/historico e reaplicacao, defaults/constraints/Unicode/duplicados e rollback do historico diante de conflito criado pelo proprio teste. Ele escreve no banco e nao deve ser incluido em build ou startup.

O helper tests/support/isolated-schema.ts:
- Gera internamente um nome taskflow_test_ com 16 bytes aleatorios criptograficos.
- Confirma taskflow_test e cria o schema sem IF NOT EXISTS.
- Registra criacao bem-sucedida e OID em memoria; nunca adota schema preexistente.
- Aplica a migracao somente no schema novo e qualifica as consultas.
- Antes de limpar, encerra transacao pendente com rollback, reconfirma banco, nome e OID.
- Remove exclusivamente o schema comprovadamente criado pela execucao e seus objetos, liberando cliente e pool.
- Nao tenta remover schema cuja criacao falhou. Sem identidade confiavel, deixa o objeto para revisao; nao busca nem limpa schemas antigos.

A limpeza destrutiva e restrita ao helper autorizado e aos objetos descartaveis que ele criou. Nao e rollback operacional da aplicacao nem procedimento de manutencao de public.

### Decisao de escopo aceita para a tarefa 3.4

As verificacoes anteriores utilizaram schemas temporarios, aleatorios e exclusivos dentro do banco persistente taskflow_test. Nao foi criado e descartado um banco inteiro para essas verificacoes.

A tarefa 3.4 menciona literalmente "verificar migracao em banco descartavel"; sua redacao original no OpenSpec permanece inalterada. Para o escopo atual do projeto, foi aceita explicitamente pelo responsavel a evidencia dos testes ja executados em schemas novos, exclusivos e descartaveis dentro de taskflow_test.

Essa decisao nao equipara schemas a um banco inteiro descartavel: nenhum banco PostgreSQL inteiro descartavel foi criado ou testado. A verificacao em um banco inteiramente descartavel permanece uma possibilidade futura, caso seja exigido isolamento nesse nivel. A tarefa 3.4 foi concluida, com aceitacao explicita da verificacao em schemas descartaveis para o escopo atual, sem realizacao de teste em um banco PostgreSQL inteiro descartavel.

## Falhas e diagnosticos seguros

MigrationError apresenta code e phase controlados, sem mensagem bruta do driver, SQL completo, parametros ou credenciais. Nao imprimir objetos de configuracao, process.env ou causas brutas para diagnosticar.

- MIGRATION_CONFIG_INVALID / MIGRATION_FILES_INVALID: revisar configuracao ou arquivos antes de conectar novamente.
- MIGRATION_INITIAL_FILES_INVALID: o conjunto de arquivos nao e exclusivamente a instalacao inicial esperada.
- MIGRATION_INITIAL_OBJECT_EXISTS: destino inicial ocupado; nao reaproveitar, substituir ou remover objetos.
- MIGRATION_DESTINATION_REJECTED / MIGRATION_SCHEMA_MISSING: interromper e revisar destino.
- MIGRATION_LOCKED: outro executor cooperativo esta ativo; nao forcar o lock.
- MIGRATION_HISTORY_MISMATCH: preservar historico e arquivos para investigacao, sem editar checksums manualmente.
- MIGRATION_FAILED: erro na fase indicada; o executor tenta rollback se a transacao foi iniciada.
- MIGRATION_COMMIT_UNCERTAIN: o commit pode ter sido efetivado. Nao repetir automaticamente; confirmar estado por consultas read-only e aguardar revisao.
- MIGRATION_CLEANUP_FAILED: falha na liberacao ou encerramento; avaliar separadamente do resultado da transacao.

O executor tenta rollback em falhas anteriores ao commit e tambem apos falha de commit, sem transformar resultado incerto em garantia de reversao. Se rollback falhar, descarta o cliente e preserva o erro original sanitizado. Uma falha de fechamento pode ocorrer depois de commit confirmado; nao concluir que nada foi aplicado apenas porque a chamada terminou com erro.

Nao ha retry automatico de migracoes ou insercoes com resultado incerto.

## Rollback operacional preservando dados

Rollback operacional significa interromper a aplicacao ou restaurar uma versao anterior compativel com o schema existente, mantendo tasks, taskflow_schema_migrations e seus dados.

1. Interromper novas escritas pela aplicacao.
2. Avaliar compatibilidade da versao anterior com o schema atual.
3. Reverter somente a versao da aplicacao por procedimento autorizado; nao reverter automaticamente a migracao.
4. Verificar disponibilidade e integridade por leitura, preservando o registro de versoes.
5. Para uma correcao de schema, planejar uma nova migracao revisada.

Nao ha migracao down nem exclusao automatica de tabelas neste projeto. Remocao de objetos persistentes ou restauracao de backup exige plano especifico, avaliacao de perda de dados e autorizacao separada; nao e procedimento padrao. A limpeza de schemas exclusivos dos testes nao se aplica a public nem a dados preexistentes.
