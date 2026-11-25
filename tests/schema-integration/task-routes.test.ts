import { expect, it } from 'vitest';
import type { Pool } from 'pg';
import { buildApp } from '../../src/app';
import { createIntegrationWritePool, withDatabasePool } from '../../src/database';
import { PostgresQueryExecutor } from '../../src/postgres-query-executor';
import { PostgresTaskRepository } from '../../src/postgres-task-repository';
import type { TaskCreationResponse } from '../../src/task-response';
import { withIsolatedSchema } from '../support/isolated-schema';
import type { IsolatedSchemaContext } from '../support/isolated-schema';

type App = ReturnType<typeof buildApp>;
type HttpSchema = IsolatedSchemaContext & { readonly app: App };
type Input = { title: string; description?: string };
type Expected = { title: string; description: string | null };

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

async function createAndVerify(context: HttpSchema, payload: Input, expected: Expected) {
  const response = await context.app.inject({ method: 'POST', url: '/tasks', payload });
  expect(response.statusCode).toBe(201);
  const body = response.json<TaskCreationResponse>();
  expect(body).toEqual({
    id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
    title: expected.title, description: expected.description, status: 'pending',
    createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  });
  expect(new Date(body.createdAt).toISOString()).toBe(body.createdAt);
  const stored = await context.client.query(
    'SELECT id, title, description, status, created_at, ' +
    'pg_catalog.char_length(title) AS title_length, ' +
    'pg_catalog.char_length(description) AS description_length ' +
    'FROM ' + context.qualified + '.tasks WHERE id = $1', [body.id],
  );
  expect(stored.rows).toHaveLength(1);
  const row = stored.rows[0];
  expect(row.created_at).toBeInstanceOf(Date);
  expect(row).toEqual({
    id: body.id, title: expected.title, description: expected.description, status: 'pending',
    created_at: new Date(body.createdAt),
    title_length: Array.from(expected.title).length,
    description_length: expected.description === null ? null : Array.from(expected.description).length,
  });
  expect(Date.parse(body.createdAt)).toBe(row.created_at.getTime());
  return body;
}

async function countTasks(context: HttpSchema): Promise<number> {
  const result = await context.client.query('SELECT count(*)::int AS count FROM ' + context.qualified + '.tasks');
  return result.rows[0].count;
}

it('creates minimal/complete tasks via HTTP and preserves absent, empty and whitespace descriptions', async () => {
  await withHttpSchema(async (context) => {
    await createAndVerify(context, { title: ' a ' }, { title: 'a', description: null });
    await createAndVerify(context,
      { title: '  Complete task  ', description: '  Unicode \u{1F600} e\u0301 \n ' },
      { title: 'Complete task', description: '  Unicode \u{1F600} e\u0301 \n ' });
    await createAndVerify(context,
      { title: 'Empty', description: '' }, { title: 'Empty', description: '' });
    await createAndVerify(context,
      { title: 'Spaces', description: '   ' }, { title: 'Spaces', description: '   ' });
    expect(await countTasks(context)).toBe(4);
  });
});

it('checks HTTP Unicode boundaries against real rows without normalizing combining sequences', async () => {
  await withHttpSchema(async (context) => {
    const valid = [
      { title: 'a'.repeat(120), description: 'b'.repeat(500) },
      { title: '\u{1F600}'.repeat(120), description: '\u{1F600}'.repeat(500) },
      { title: 'e\u0301'.repeat(60), description: 'e\u0301'.repeat(250) },
    ];
    for (const expected of valid) {
      expect(Array.from(expected.title)).toHaveLength(120);
      expect(Array.from(expected.description)).toHaveLength(500);
      await createAndVerify(context, { ...expected, title: '  ' + expected.title + '  ' }, expected);
    }
    expect(await countTasks(context)).toBe(3);
    const invalid = [
      { title: 'a'.repeat(121) },
      { title: '\u{1F600}'.repeat(121) },
      { title: 'e\u0301'.repeat(60) + 'e' },
      { title: 'Valid', description: 'b'.repeat(501) },
      { title: 'Valid', description: '\u{1F600}'.repeat(501) },
      { title: 'Valid', description: 'e\u0301'.repeat(250) + 'e' },
    ];
    for (const payload of invalid) {
      const before = await countTasks(context);
      const response = await context.app.inject({ method: 'POST', url: '/tasks', payload });
      expect(response.statusCode).toBe(400);
      expect(await countTasks(context)).toBe(before);
    }
  });
});

it('creates duplicate titles through two HTTP requests with distinct database UUIDs and exactly two rows', async () => {
  await withHttpSchema(async (context) => {
    const expected = { title: 'Duplicate', description: null };
    const first = await createAndVerify(context, { title: ' Duplicate ' }, expected);
    const second = await createAndVerify(context, { title: 'Duplicate' }, expected);
    expect(first.id).not.toBe(second.id);
    const stored = await context.client.query(
      'SELECT id FROM ' + context.qualified + '.tasks WHERE title = $1 ORDER BY id', [expected.title],
    );
    expect(stored.rows.map((row) => row.id).sort()).toEqual([first.id, second.id].sort());
    expect(await countTasks(context)).toBe(2);
  });
});
