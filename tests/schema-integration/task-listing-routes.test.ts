import { expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import type { Pool } from 'pg';
import { buildApp } from '../../src/app';
import { createIntegrationWritePool, withDatabasePool } from '../../src/database';
import { PostgresQueryExecutor } from '../../src/postgres-query-executor';
import { PostgresTaskRepository } from '../../src/postgres-task-repository';
import type { TaskCreationResponse, TaskListResponse } from '../../src/task-response';
import { withIsolatedSchema } from '../support/isolated-schema';
import type { IsolatedSchemaContext } from '../support/isolated-schema';

type App = ReturnType<typeof buildApp>;
type HttpSchema = IsolatedSchemaContext & { readonly app: App };

// Discovered only by the schema-integration config. No connection, migration or SQL on import.
// Each test owns a fresh schema; public and all preexisting schemas remain outside its SQL.
async function withHttpSchema(operation: (context: HttpSchema) => Promise<void>): Promise<void> {
  // Explicit integration variables only: never copy/use DATABASE_URL or development runtime.
  const variables = { TEST_DATABASE_URL: process.env.TEST_DATABASE_URL };
  let app: App | undefined;
  let httpPool: Pool | undefined;
  const removedSchema = await withIsolatedSchema(async (context) => {
    await context.client.query('SET search_path = pg_catalog');
    const encoding = await context.client.query('SHOW server_encoding');
    expect(encoding.rows[0].server_encoding).toBe('UTF8');
    await context.migrate();
    // The helper holds its own administrative client. Never acquire from that occupied pool.
    httpPool = createIntegrationWritePool('persistence-test', variables);
    const writePool = httpPool;
    const executor = new PostgresQueryExecutor({
      connect: async () => {
        const client = await writePool.connect();
        let clientFailed = false;
        const onError = () => { clientFailed = true; };
        client.on('error', onError);
        try {
          const destination = await client.query('SELECT pg_catalog.current_database() AS database');
          if (destination.rows[0]?.database !== 'taskflow_test') {
            throw new Error('HTTP_INTEGRATION_DATABASE_REJECTED');
          }
          // Apply on every checkout, including clients recreated after an idle timeout.
          await client.query('SET search_path = pg_catalog');
          if (clientFailed) throw new Error('HTTP_INTEGRATION_CLIENT_PREPARATION_FAILED');
        } catch {
          try { client.release(true); }
          finally { client.removeListener('error', onError); }
          throw new Error('HTTP_INTEGRATION_CLIENT_PREPARATION_FAILED');
        }
        client.removeListener('error', onError);
        return client;
      },
    });
    const repository = new PostgresTaskRepository(executor, context.schema);
    app = buildApp({ taskRepository: repository });
    await operation({ ...context, app });
    return context.schema;
  }, variables, {
    beforeDrop: async () => {
      // The helper runs this once even on assertion/setup failure, before ownership checks/DROP.
      let failed = false;
      try { await app?.close(); } catch { failed = true; }
      try { await httpPool?.end(); } catch { failed = true; }
      if (failed) throw new Error('HTTP_INTEGRATION_CLOSE_FAILED');
    },
  });

  // Independent read-only confirmation after administrative and HTTP resources were closed.
  await withDatabasePool('integration', async (pool) => {
    const destination = await pool.query('SELECT pg_catalog.current_database() AS database');
    expect(destination.rows[0]?.database).toBe('taskflow_test');
    const namespace = await pool.query(
      'SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $1', [removedSchema],
    );
    expect(namespace.rows).toHaveLength(0);
  }, variables);
}

type StoredTask = Omit<TaskCreationResponse, 'createdAt'> & { created_at: Date };

async function readTasks(context: HttpSchema): Promise<StoredTask[]> {
  const result = await context.client.query<StoredTask>(
    'SELECT id, title, description, status, created_at FROM ' + context.qualified + '.tasks ORDER BY id ASC',
  );
  return result.rows;
}

function publicTask({ created_at, ...fields }: StoredTask): TaskCreationResponse {
  return { ...fields, createdAt: created_at.toISOString() };
}

async function expectPage(
  context: HttpSchema,
  url: string,
  items: TaskCreationResponse[],
  nextOffset: number | null,
): Promise<void> {
  const response = await context.app.inject({ method: 'GET', url });
  expect(response.statusCode).toBe(200);
  expect(response.json<TaskListResponse>()).toEqual({ items, nextOffset, truncated: false });
}

const older = '2026-11-20T10:00:00.111Z';
const tied = '2026-11-20T10:00:01.222Z';
const newest = '2026-11-20T10:00:02.333Z';
const fixtures: readonly TaskCreationResponse[] = [
  { id: '00000000-0000-4000-8000-000000000005', title: 'Oldest', description: null, status: 'pending', createdAt: older },
  { id: '00000000-0000-4000-8000-000000000002', title: 'Tie low', description: '', status: 'pending', createdAt: tied },
  { id: '00000000-0000-4000-8000-000000000001', title: 'Newest \u{1F600}', description: '  e\u0301 \u{1F600}  ', status: 'pending', createdAt: newest },
  { id: '00000000-0000-4000-8000-000000000004', title: 'Tie high', description: '   ', status: 'pending', createdAt: tied },
  { id: '00000000-0000-4000-8000-000000000003', title: 'Tie middle', description: 'Text', status: 'pending', createdAt: tied },
];

async function seedTasks(context: HttpSchema): Promise<void> {
  for (const { id, title, description, status, createdAt } of fixtures) {
    await context.client.query(
      'INSERT INTO ' + context.qualified + '.tasks (id, title, description, status, created_at) ' +
      'VALUES ($1, $2, $3, $4, $5::timestamptz)', [id, title, description, status, createdAt],
    );
  }
}

it('returns an exact empty page from a migrated empty schema without writing tasks', async () => {
  await withHttpSchema(async (context) => {
    const before = await readTasks(context);
    expect(before).toEqual([]);
    await expectPage(context, '/tasks', [], null);
    expect(await readTasks(context)).toEqual(before);
  });
});

it('returns the persisted public fields in timestamp and UUID descending order', async () => {
  await withHttpSchema(async (context) => {
    await seedTasks(context);
    const before = await readTasks(context);
    expect(before.map(publicTask)).toEqual([fixtures[2], fixtures[1], fixtures[4], fixtures[3], fixtures[0]]);
    // The independently read snapshot is ordered by UUID only.
    const ordered = [before[0]!, before[3]!, before[2]!, before[1]!, before[4]!].map(publicTask);
    expect(ordered).toEqual([fixtures[2], fixtures[3], fixtures[4], fixtures[1], fixtures[0]]);
    await expectPage(context, '/tasks', ordered, null);
    expect(await readTasks(context)).toEqual(before);
  });
});

it('paginates stable rows without repeats, omissions or writes', async () => {
  await withHttpSchema(async (context) => {
    await seedTasks(context);
    const before = await readTasks(context);
    expect(before).toHaveLength(5);

    let offset: number | null = 0;
    const returned: TaskCreationResponse[] = [];
    for (const expected of [
      { items: [fixtures[2], fixtures[3]], nextOffset: 2 },
      { items: [fixtures[4], fixtures[1]], nextOffset: 4 },
      { items: [fixtures[0]], nextOffset: null },
    ]) {
      expect(offset).not.toBeNull();
      const response: LightMyRequestResponse = await context.app.inject({ method: 'GET', url: '/tasks?limit=2&offset=' + offset });
      expect(response.statusCode).toBe(200);
      const page = response.json<TaskListResponse>();
      expect(page).toEqual({ ...expected, truncated: false });
      returned.push(...page.items);
      offset = page.nextOffset;
    }

    expect(new Set(returned.map(({ id }) => id)).size).toBe(before.length);
    expect([...returned].sort((a, b) => a.id.localeCompare(b.id))).toEqual(before.map(publicTask));
    await expectPage(context, '/tasks?limit=2&offset=3', [fixtures[1]!, fixtures[0]!], null);
    await expectPage(context, '/tasks?limit=2&offset=6', [], null);
    expect(await readTasks(context)).toEqual(before);
  });
});

it('lists a task created through POST without changing the persisted row', async () => {
  await withHttpSchema(async (context) => {
    const description = '  Persisted e\u0301 \u{1F600}  ';
    const response = await context.app.inject({
      method: 'POST', url: '/tasks', payload: { title: '  Create then list  ', description },
    });
    expect(response.statusCode).toBe(201);
    const created = response.json<TaskCreationResponse>();
    expect(created).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
      title: 'Create then list', description, status: 'pending',
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    });
    const before = await readTasks(context);
    expect(before.map(publicTask)).toEqual([created]);
    await expectPage(context, '/tasks', [created], null);
    expect(await readTasks(context)).toEqual(before);
  });
});
