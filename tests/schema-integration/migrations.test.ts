import { expect, it } from 'vitest';
import { loadMigrations } from '../../src/migrations';
import { withIsolatedSchema } from '../support/isolated-schema';

// Registered only by the separate schema-integration config.
// No database access or migration execution at module import.

it('applies migration/history exclusively in a fresh schema and is repeatable', async () => {
  await withIsolatedSchema(async ({ qualified, migrate, client }) => {
    const migration = (await loadMigrations())[0]!;
    expect(await migrate()).toEqual(['0001']);
    expect(await migrate()).toEqual([]);
    const history = await client.query(
      'SELECT version, name, checksum, applied_at FROM ' + qualified + '.taskflow_schema_migrations',
    );
    expect(history.rows).toHaveLength(1);
    expect(history.rows[0]).toMatchObject({
      version: migration.version, name: migration.name, checksum: migration.checksum,
    });
    expect(history.rows[0].applied_at).toBeInstanceOf(Date);
    const tables = await client.query(
      'SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = $1 ORDER BY tablename',
      [qualified.slice(1, -1)],
    );
    expect(tables.rows.map((r) => r.tablename)).toEqual(['taskflow_schema_migrations', 'tasks']);
  });
});

it('checks defaults, constraints, Unicode, descriptions and duplicate titles', async () => {
  await withIsolatedSchema(async ({ qualified, migrate, client }) => {
    await migrate();
    await client.query('BEGIN');
    try {
      const insert = (title: string, description: string | null = null) =>
        client.query('INSERT INTO ' + qualified + '.tasks (title, description) VALUES ($1, $2) RETURNING *',
          [title, description]);
      const first = (await insert('duplicate')).rows[0];
      const second = (await insert('duplicate')).rows[0];
      expect(first.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(second.id).not.toBe(first.id);
      expect(first.status).toBe('pending');
      expect(first.description).toBeNull();
      expect(first.created_at).toBeInstanceOf(Date);
      const precision = await client.query(
        'SELECT datetime_precision FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3',
        [qualified.slice(1, -1), 'tasks', 'created_at'],
      );
      expect(precision.rows[0].datetime_precision).toBe(3);
      for (const title of ['a', 'a'.repeat(120), '\u{1F600}'.repeat(120), 'e\u0301'.repeat(60)]) {
        expect((await insert(title)).rows[0].title).toBe(title);
      }
      for (const description of ['', '   ', '  text  ', 'a'.repeat(500), '\u{1F600}'.repeat(500), 'e\u0301'.repeat(250)]) {
        expect((await insert('valid', description)).rows[0].description).toBe(description);
      }
      const invalid = async (sql: string, values: unknown[], code: string) => {
        await client.query('SAVEPOINT invalid_case');
        try {
          await expect(client.query(sql, values)).rejects.toMatchObject({ code });
        } finally {
          await client.query('ROLLBACK TO SAVEPOINT invalid_case');
          await client.query('RELEASE SAVEPOINT invalid_case');
        }
      };
      const textInsert = 'INSERT INTO ' + qualified + '.tasks (title, description) VALUES ($1, $2)';
      for (const title of ['', 'a'.repeat(121), '\u{1F600}'.repeat(121)]) {
        await invalid(textInsert, [title, null], '23514');
      }
      await invalid(textInsert, [null, null], '23502');
      for (const description of ['a'.repeat(501), '\u{1F600}'.repeat(501)]) {
        await invalid(textInsert, ['valid', description], '23514');
      }
      await invalid('INSERT INTO ' + qualified + '.tasks (title, status) VALUES ($1, $2)', ['valid', 'done'], '23514');
      await invalid('INSERT INTO ' + qualified + '.tasks (title, status) VALUES ($1, $2)', ['valid', null], '23502');
      await invalid('INSERT INTO ' + qualified + '.tasks (id, title) VALUES ($1, $2)', [null, 'valid'], '23502');
      await invalid('INSERT INTO ' + qualified + '.tasks (title, created_at) VALUES ($1, $2)', ['valid', null], '23502');
    } finally {
      await client.query('ROLLBACK');
    }
    expect((await client.query('SELECT count(*)::int AS count FROM ' + qualified + '.tasks')).rows[0].count).toBe(0);
  });
});

it('rolls back migration history on conflict without modifying the conflicting object', async () => {
  await withIsolatedSchema(async ({ qualified, migrate, client }) => {
    // Deliberate conflict belongs only to this newly created schema.
    await client.query('CREATE TABLE ' + qualified + '.tasks (probe integer)');
    await client.query('INSERT INTO ' + qualified + '.tasks (probe) VALUES ($1)', [42]);
    await expect(migrate()).rejects.toMatchObject({ code: 'MIGRATION_FAILED' });
    const history = await client.query('SELECT pg_catalog.to_regclass($1) AS object',
      [qualified + '.taskflow_schema_migrations']);
    expect(history.rows[0].object).toBeNull();
    expect((await client.query('SELECT probe FROM ' + qualified + '.tasks')).rows).toEqual([{ probe: 42 }]);
  });
});
