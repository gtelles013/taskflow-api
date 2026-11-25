import { expect, it } from 'vitest';
import { withDatabasePool } from '../../src/database';
import {
  PostgresTaskRepository,
  TaskRepositoryError,
} from '../../src/postgres-task-repository';
import type { Task } from '../../src/task-repository';
import { withIsolatedSchema } from '../support/isolated-schema';

// Loaded only by vitest.schema-integration.config.mts.
// All connections, migrations and writes occur inside test callbacks.
// Always supply the schema owned by the helper; never use the default public.

it('persists RETURNING values with database defaults and safely removes the owned schema', async () => {
  const removedSchema = await withIsolatedSchema(async ({ schema, qualified, client, migrate }) => {
    await migrate();
    let insertAttempts = 0;
    const repository = new PostgresTaskRepository({
      query: async (text, values) => {
        insertAttempts++;
        expect(text).toBe(
          'INSERT INTO "' + schema + '".tasks (title, description) VALUES ($1, $2) ' +
          'RETURNING id, title, description, status, created_at',
        );
        expect(values).toEqual(['Persisted task', null]);
        return client.query(text, values);
      },
    }, schema);

    const task = await repository.create({ title: 'Persisted task', description: null });
    expect(insertAttempts).toBe(1);
    expect(task.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(task.status).toBe('pending');
    expect(task.createdAt).toBeInstanceOf(Date);
    expect(Number.isFinite(task.createdAt.getTime())).toBe(true);
    expect(task.createdAt.toISOString()).toMatch(/Z$/);

    const stored = await client.query(
      'SELECT id, title, description, status, created_at FROM ' + qualified + '.tasks WHERE id = $1',
      [task.id],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toEqual({
      id: task.id, title: task.title, description: task.description,
      status: task.status, created_at: task.createdAt,
    });
    return schema;
  });

  // Read-only verification after helper teardown; never deletes by this name.
  await withDatabasePool('integration', async (pool) => {
    const identity = await pool.query('SELECT pg_catalog.current_database() AS database');
    expect(identity.rows[0].database).toBe('taskflow_test');
    const namespaces = await pool.query(
      'SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $1', [removedSchema],
    );
    expect(namespaces.rows).toHaveLength(0);
  });
});

it('preserves null, empty and whitespace descriptions in storage', async () => {
  await withIsolatedSchema(async ({ schema, qualified, client, migrate }) => {
    await migrate();
    const repository = new PostgresTaskRepository(client, schema);
    for (const description of [null, '', '  description \n ', '   ']) {
      const task = await repository.create({ title: 'Description case', description });
      expect(task.description).toBe(description);
      const result = await client.query(
        'SELECT description FROM ' + qualified + '.tasks WHERE id = $1', [task.id],
      );
      expect(result.rows[0].description).toBe(description);
    }
  });
});

it('allows duplicate titles with different database-generated UUIDs', async () => {
  await withIsolatedSchema(async ({ schema, qualified, client, migrate }) => {
    await migrate();
    const repository = new PostgresTaskRepository(client, schema);
    const first = await repository.create({ title: 'Duplicate', description: null });
    const second = await repository.create({ title: 'Duplicate', description: null });
    expect(first.id).not.toBe(second.id);
    const stored = await client.query(
      'SELECT id FROM ' + qualified + '.tasks WHERE title = $1 ORDER BY id', ['Duplicate'],
    );
    expect(stored.rows.map((row) => row.id).sort()).toEqual([first.id, second.id].sort());
  });
});

it('preserves Unicode and accepts exact title/description code-point boundaries', async () => {
  await withIsolatedSchema(async ({ schema, qualified, client, migrate }) => {
    await migrate();
    const repository = new PostgresTaskRepository(client, schema);
    const cases = [
      { title: 'a', description: '' },
      { title: 'a'.repeat(120), description: 'b'.repeat(500) },
      { title: '\u{1F600}'.repeat(120), description: '\u{1F600}'.repeat(500) },
      { title: 'e\u0301'.repeat(60), description: 'e\u0301'.repeat(250) },
      { title: 'Unicode \u{1F600} e\u0301', description: '  Unicode \u{1F600} e\u0301  ' },
    ];
    for (const input of cases) {
      const task: Task = await repository.create(input);
      expect(task.title).toBe(input.title);
      expect(task.description).toBe(input.description);
      const stored = await client.query(
        'SELECT title, description FROM ' + qualified + '.tasks WHERE id = $1', [task.id],
      );
      expect(stored.rows[0]).toEqual(input);
    }
  });
});

it('does not retry actual constraint failures or persist rejected inputs', async () => {
  await withIsolatedSchema(async ({ schema, qualified, client, migrate }) => {
    await migrate();
    let attempts = 0;
    const repository = new PostgresTaskRepository({
      query: async (text, values) => {
        attempts++;
        return client.query(text, values);
      },
    }, schema);
    const cases = [
      { title: 'a'.repeat(121), description: null },
      { title: '\u{1F600}'.repeat(121), description: null },
      { title: 'valid', description: 'a'.repeat(501) },
      { title: 'valid', description: '\u{1F600}'.repeat(501) },
    ];
    for (const input of cases) {
      const before = attempts;
      await expect(repository.create(input)).rejects.toMatchObject({
        code: 'TASK_REPOSITORY_QUERY_FAILED', databaseCode: '23514',
      });
      expect(attempts).toBe(before + 1);
    }
    const stored = await client.query('SELECT count(*)::int AS count FROM ' + qualified + '.tasks');
    expect(stored.rows[0].count).toBe(0);
  });
});

it('does not duplicate a committed insert when its result is lost at the executor boundary', async () => {
  await withIsolatedSchema(async ({ schema, qualified, client, migrate }) => {
    await migrate();
    let attempts = 0;
    const repository = new PostgresTaskRepository({
      query: async (text, values) => {
        attempts++;
        await client.query(text, values); // Real insert completes in autocommit.
        // Controlled simulation, without disrupting the real shared connection.
        throw Object.assign(new Error('Controlled result loss'), { code: 'ECONNRESET' });
      },
    }, schema);
    await expect(repository.create({ title: 'Uncertain outcome', description: null }))
      .rejects.toBeInstanceOf(TaskRepositoryError);
    expect(attempts).toBe(1);
    const stored = await client.query('SELECT count(*)::int AS count FROM ' + qualified + '.tasks');
    expect(stored.rows[0].count).toBe(1);
  });
});
