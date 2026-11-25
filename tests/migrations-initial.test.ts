import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  query: vi.fn(), connect: vi.fn(), release: vi.fn(), end: vi.fn(),
  construct: vi.fn(), on: vi.fn(), names: vi.fn(), read: vi.fn(),
}));
vi.mock('pg', () => ({
  Pool: class {
    constructor(config: unknown) { fake.construct(config); }
    connect = fake.connect;
    end = fake.end;
    on = fake.on;
  },
}));
vi.mock('node:fs/promises', () => ({ readdir: fake.names, readFile: fake.read }));
import { runTestMigrations } from '../src/migrations';

const variables = {
  TEST_DATABASE_URL: 'postgresql://taskflow_app:example@localhost:5432/taskflow_test',
};
const options = { schema: 'public', mode: 'initial-installation' as const, variables };

beforeEach(() => {
  vi.resetAllMocks();
  fake.names.mockResolvedValue(['0001_create_tasks.sql']);
  fake.read.mockResolvedValue(Buffer.from('CREATE TABLE {{schema}}.tasks (id uuid);\n'));
  fake.connect.mockResolvedValue({ query: fake.query, release: fake.release });
  fake.end.mockResolvedValue(undefined);
  fake.query.mockImplementation(async (sql: string) => {
    if (sql.includes('current_database')) return { rows: [{ database: 'taskflow_test' }] };
    if (sql.includes('pg_try_advisory')) return { rows: [{ locked: true }] };
    if (sql.startsWith('SELECT 1 FROM pg_catalog.pg_namespace')) return { rows: [{ exists: 1 }] };
    return { rows: [] };
  });
});

const statements = () => fake.query.mock.calls.map(([sql]) => sql as string);
const ddl = () => statements().filter((sql) => sql.startsWith('CREATE'));

describe('explicit initial installation using mocked pg only', () => {
  it('checks absence after lock and before every CREATE on the same client', async () => {
    await expect(runTestMigrations(options)).resolves.toEqual(['0001']);
    const sql = statements();
    expect(fake.connect).toHaveBeenCalledOnce();
    expect(sql[0]).toContain('current_database');
    expect(sql[1]).toBe('BEGIN');
    expect(sql[2]).toContain('pg_try_advisory_xact_lock');
    expect(fake.query.mock.calls[2]?.[1]).toEqual([194865, 1]);
    const check = sql.findIndex((s) => s.includes('FROM pg_catalog.pg_class'));
    expect(check).toBeGreaterThan(2);
    expect(fake.query.mock.calls[check]?.[1]).toEqual([
      'public', ['tasks', 'taskflow_schema_migrations'],
    ]);
    expect(sql[check]).toContain('FROM pg_catalog.pg_type');
    expect(sql.findIndex((s) => s.startsWith('CREATE'))).toBeGreaterThan(check);
    expect(ddl()).toHaveLength(2);
    expect(ddl()[0]).toContain('CREATE TABLE "public"."taskflow_schema_migrations"');
    expect(ddl().some((s) => s.includes('IF NOT EXISTS'))).toBe(false);
    expect(sql.filter((s) => s.startsWith('INSERT'))).toHaveLength(1);
    expect(sql.at(-1)).toBe('COMMIT');
    expect(fake.release).toHaveBeenCalledOnce();
    expect(fake.end).toHaveBeenCalledOnce();
  });

  it.each(['tasks', 'taskflow_schema_migrations'])(
    'rejects existing %s without any CREATE', async (name) => {
      const previous = fake.query.getMockImplementation()!;
      fake.query.mockImplementation(async (sql: string) =>
        sql.includes('FROM pg_catalog.pg_class') ? { rows: [{ name }] } : previous(sql));
      await expect(runTestMigrations(options)).rejects.toMatchObject({
        code: 'MIGRATION_INITIAL_OBJECT_EXISTS',
      });
      expect(ddl()).toEqual([]);
      expect(statements().at(-1)).toBe('ROLLBACK');
      expect(statements()).not.toContain('COMMIT');
      expect(fake.release).toHaveBeenCalledOnce();
      expect(fake.end).toHaveBeenCalledOnce();
    },
  );

  it('rejects both existing objects without reuse or removal', async () => {
    const previous = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (sql: string) =>
      sql.includes('FROM pg_catalog.pg_class')
        ? { rows: [{ name: 'tasks' }, { name: 'taskflow_schema_migrations' }] } : previous(sql));
    await expect(runTestMigrations(options)).rejects.toMatchObject({
      code: 'MIGRATION_INITIAL_OBJECT_EXISTS',
    });
    expect(ddl()).toEqual([]);
    expect(statements().some((s) => /^(DROP|ALTER|DELETE|TRUNCATE)/.test(s))).toBe(false);
  });

  it.each([
    ['0001_create_tasks.sql', '0002_other.sql'],
    ['0002_other.sql'],
    ['0001_renamed.sql'],
  ])('rejects an unexpected migration set %# before connecting', async (...names) => {
    fake.names.mockResolvedValue(names);
    await expect(runTestMigrations(options)).rejects.toMatchObject({
      code: 'MIGRATION_INITIAL_FILES_INVALID',
    });
    expect(fake.construct).not.toHaveBeenCalled();
  });

  it('rejects an empty migration directory before connecting', async () => {
    fake.names.mockResolvedValue([]);
    await expect(runTestMigrations(options)).rejects.toMatchObject({ code: 'MIGRATION_FILES_INVALID' });
    expect(fake.construct).not.toHaveBeenCalled();
  });

  it.each(['taskflow_test_run1', 'other_schema'])(
    'restricts initial installation to public (%s)', async (schema) => {
      await expect(runTestMigrations({ ...options, schema })).rejects.toMatchObject({
        code: 'MIGRATION_CONFIG_INVALID',
      });
      expect(fake.construct).not.toHaveBeenCalled();
    },
  );

  it('rejects an invalid runtime mode before connecting', async () => {
    await expect(runTestMigrations({ ...options, mode: 'unknown' as never }))
      .rejects.toMatchObject({ code: 'MIGRATION_CONFIG_INVALID' });
    expect(fake.construct).not.toHaveBeenCalled();
  });

  it('does not use DATABASE_URL as a fallback', async () => {
    await expect(runTestMigrations({
      ...options, variables: { DATABASE_URL: variables.TEST_DATABASE_URL },
    })).rejects.toMatchObject({ code: 'MIGRATION_CONFIG_INVALID' });
    expect(fake.construct).not.toHaveBeenCalled();
  });

  it('rejects wrong actual database before BEGIN', async () => {
    fake.query.mockResolvedValue({ rows: [{ database: 'wrong_database' }] });
    await expect(runTestMigrations(options)).rejects.toMatchObject({
      code: 'MIGRATION_DESTINATION_REJECTED',
    });
    expect(fake.query).toHaveBeenCalledOnce();
    expect(ddl()).toEqual([]);
    expect(fake.end).toHaveBeenCalledOnce();
  });

  it('rejects busy lock before object check or DDL', async () => {
    const previous = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (sql: string) =>
      sql.includes('pg_try_advisory') ? { rows: [{ locked: false }] } : previous(sql));
    await expect(runTestMigrations(options)).rejects.toMatchObject({ code: 'MIGRATION_LOCKED' });
    expect(statements().some((s) => s.includes('FROM pg_catalog.pg_class'))).toBe(false);
    expect(ddl()).toEqual([]);
    expect(statements().at(-1)).toBe('ROLLBACK');
  });

  it.each(['SELECT c.relname', 'CREATE TABLE "public"."taskflow_schema_migrations"',
    'CREATE TABLE "public".tasks', 'INSERT INTO'])(
    'rolls back and sanitizes failure at %s', async (prefix) => {
      const previous = fake.query.getMockImplementation()!;
      fake.query.mockImplementation(async (sql: string) => {
        if (sql.startsWith(prefix)) throw new Error('SENTINEL_PASSWORD private SQL');
        return previous(sql);
      });
      let failure: unknown;
      try { await runTestMigrations(options); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: 'MIGRATION_FAILED' });
      expect(String(failure)).not.toContain('SENTINEL_PASSWORD');
      expect(statements().at(-1)).toBe('ROLLBACK');
      expect(statements()).not.toContain('COMMIT');
      expect(fake.release).toHaveBeenCalledOnce();
      expect(fake.end).toHaveBeenCalledOnce();
    },
  );

  it('treats failed commit as uncertain without retry', async () => {
    const previous = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (sql: string) => {
      if (sql === 'COMMIT') throw new Error('private');
      return previous(sql);
    });
    await expect(runTestMigrations(options)).rejects.toMatchObject({
      code: 'MIGRATION_COMMIT_UNCERTAIN',
    });
    expect(statements().filter((s) => s === 'COMMIT')).toHaveLength(1);
    expect(fake.release).toHaveBeenCalledOnce();
    expect(fake.end).toHaveBeenCalledOnce();
  });

  it('discards client on rollback failure and still closes pool', async () => {
    const previous = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('INSERT INTO') || sql === 'ROLLBACK') throw new Error('private');
      return previous(sql);
    });
    await expect(runTestMigrations(options)).rejects.toMatchObject({ code: 'MIGRATION_FAILED' });
    expect(fake.release).toHaveBeenCalledWith(true);
    expect(fake.end).toHaveBeenCalledOnce();
  });
});
