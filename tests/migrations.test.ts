import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const fake = vi.hoisted(() => ({
  construct: vi.fn(), query: vi.fn(), connect: vi.fn(),
  release: vi.fn(), end: vi.fn(), on: vi.fn(),
}));
vi.mock('pg', () => ({
  Pool: class {
    constructor(config: unknown) { fake.construct(config); }
    connect = fake.connect;
    end = fake.end;
    on = fake.on;
  },
}));
import { loadMigrations, runTestMigrations, MigrationError } from '../src/migrations';

const variables = {
  TEST_DATABASE_URL: 'postgresql://taskflow_app:example@localhost:5432/taskflow_test',
};
const options = { schema: 'taskflow_test_run1', variables };

beforeEach(() => {
  vi.resetAllMocks();
  fake.connect.mockResolvedValue({ query: fake.query, release: fake.release });
  fake.end.mockResolvedValue(undefined);
  fake.query.mockImplementation(async (sql: string) => {
    if (sql.includes('current_database')) return { rows: [{ database: 'taskflow_test' }] };
    if (sql.includes('pg_try_advisory')) return { rows: [{ locked: true }] };
    if (sql.includes('pg_namespace')) return { rows: [{ exists: 1 }] };
    return { rows: [] };
  });
});

function statements(): string[] {
  return fake.query.mock.calls.map((args) => args[0] as string);
}

describe('migration files', () => {
  it('loads the versioned SQL with SHA-256 of the exact file bytes', async () => {
    const migrations = await loadMigrations();
    const bytes = await readFile('migrations/0001_create_tasks.sql');
    expect(migrations).toHaveLength(1);
    expect(migrations[0]).toMatchObject({
      version: '0001', name: '0001_create_tasks.sql',
      checksum: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(migrations[0]!.sql).toContain('timestamptz(3)');
    expect(migrations[0]!.sql).toContain("DEFAULT 'pending'");
  });
});

describe('migration execution using mocked pg only', () => {
  it('uses one client, locks before history, commits SQL and history together', async () => {
    await expect(runTestMigrations(options)).resolves.toEqual(['0001']);
    const sql = statements();
    expect(fake.connect).toHaveBeenCalledOnce();
    expect(sql[0]).toContain('current_database');
    expect(sql[1]).toBe('BEGIN');
    expect(sql[2]).toContain('pg_try_advisory_xact_lock');
    expect(sql.findIndex((s) => s.includes('CREATE TABLE IF NOT EXISTS'))).toBeGreaterThan(2);
    expect(sql.find((s) => s.startsWith('CREATE TABLE "taskflow_test_run1".tasks')))
      .toBeDefined();
    const insert = fake.query.mock.calls.find(([s]) => s.startsWith('INSERT INTO'));
    expect(insert?.[1]).toEqual(['0001', '0001_create_tasks.sql', expect.stringMatching(/^[a-f0-9]{64}$/)]);
    expect(sql.at(-1)).toBe('COMMIT');
    expect(fake.release).toHaveBeenCalledOnce();
    expect(fake.end).toHaveBeenCalledOnce();
  });

  it('skips an already applied matching version', async () => {
    const migration = (await loadMigrations())[0]!;
    const previous = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (sql: string) =>
      sql.startsWith('SELECT version') ? { rows: [migration] } : previous(sql));
    await expect(runTestMigrations(options)).resolves.toEqual([]);
    expect(statements().some((s) => s.startsWith('CREATE TABLE "'))).toBe(false);
    expect(statements().some((s) => s.startsWith('INSERT INTO'))).toBe(false);
  });

  it.each(['checksum', 'name', 'version'])('rejects changed historical %s', async (field) => {
    const migration = (await loadMigrations())[0]!;
    const previous = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (sql: string) =>
      sql.startsWith('SELECT version')
        ? { rows: [{ ...migration, [field]: 'changed' }] } : previous(sql));
    await expect(runTestMigrations(options)).rejects.toMatchObject({
      code: 'MIGRATION_HISTORY_MISMATCH',
    });
    expect(statements().at(-1)).toBe('ROLLBACK');
    expect(statements()).not.toContain('COMMIT');
  });

  it('rejects a busy advisory lock before touching history', async () => {
    const previous = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (sql: string) =>
      sql.includes('pg_try_advisory') ? { rows: [{ locked: false }] } : previous(sql));
    await expect(runTestMigrations(options)).rejects.toMatchObject({ code: 'MIGRATION_LOCKED' });
    expect(statements().some((s) => s.includes('taskflow_schema_migrations'))).toBe(false);
    expect(statements().at(-1)).toBe('ROLLBACK');
  });

  it('rejects wrong actual database before BEGIN or any write', async () => {
    fake.query.mockResolvedValue({ rows: [{ database: 'wrong_database' }] });
    await expect(runTestMigrations(options)).rejects.toMatchObject({
      code: 'MIGRATION_DESTINATION_REJECTED',
    });
    expect(fake.query).toHaveBeenCalledOnce();
    expect(fake.release).toHaveBeenCalledOnce();
    expect(fake.end).toHaveBeenCalledOnce();
  });

  it('rejects missing schema rather than creating it', async () => {
    const previous = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (sql: string) =>
      sql.includes('pg_namespace') ? { rows: [] } : previous(sql));
    await expect(runTestMigrations(options)).rejects.toMatchObject({
      code: 'MIGRATION_SCHEMA_MISSING',
    });
    expect(statements().some((s) => s.startsWith('CREATE SCHEMA'))).toBe(false);
  });

  it.each(['public;DROP SCHEMA public', 'other_schema', 'taskflow_test_foo.bar', '', 'taskflow_test_' + 'a'.repeat(60)])(
    'rejects unsafe schema %# before constructing pool', async (schema) => {
      await expect(runTestMigrations({ ...options, schema })).rejects.toBeInstanceOf(MigrationError);
      expect(fake.construct).not.toHaveBeenCalled();
    },
  );

  it('never falls back to development URL', async () => {
    await expect(runTestMigrations({
      schema: 'public', variables: { DATABASE_URL: variables.TEST_DATABASE_URL },
    })).rejects.toMatchObject({ code: 'MIGRATION_CONFIG_INVALID' });
    expect(fake.construct).not.toHaveBeenCalled();
  });

  it.each(['CREATE TABLE "taskflow', 'INSERT INTO', 'BEGIN'])(
    'sanitizes failure and closes resources at %s', async (prefix) => {
      const previous = fake.query.getMockImplementation()!;
      fake.query.mockImplementation(async (sql: string) => {
        if (sql.startsWith(prefix)) throw new Error('SENTINEL_PASSWORD raw driver SQL');
        return previous(sql);
      });
      let failure: unknown;
      try { await runTestMigrations(options); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(MigrationError);
      expect(String(failure)).not.toContain('SENTINEL_PASSWORD');
      expect((failure as Error).cause).toBeUndefined();
      expect(statements()).not.toContain('COMMIT');
      if (prefix !== 'BEGIN') expect(statements().at(-1)).toBe('ROLLBACK');
      expect(fake.release).toHaveBeenCalledOnce();
      expect(fake.end).toHaveBeenCalledOnce();
    },
  );

  it('closes pool when acquiring client fails', async () => {
    fake.connect.mockRejectedValue(new Error('private driver message'));
    await expect(runTestMigrations(options)).rejects.toMatchObject({ phase: 'connection' });
    expect(fake.release).not.toHaveBeenCalled();
    expect(fake.end).toHaveBeenCalledOnce();
  });

  it('discards client if rollback fails and preserves original error', async () => {
    const previous = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('INSERT INTO') || sql === 'ROLLBACK') throw new Error('private');
      return previous(sql);
    });
    await expect(runTestMigrations(options)).rejects.toMatchObject({ phase: 'migration 0001' });
    expect(fake.release).toHaveBeenCalledWith(true);
    expect(fake.end).toHaveBeenCalledOnce();
  });

  it('reports uncertain commit without retrying', async () => {
    const previous = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (sql: string) => {
      if (sql === 'COMMIT') throw new Error('connection lost');
      return previous(sql);
    });
    await expect(runTestMigrations(options)).rejects.toMatchObject({
      code: 'MIGRATION_COMMIT_UNCERTAIN',
    });
    expect(statements().filter((s) => s === 'COMMIT')).toHaveLength(1);
    expect(fake.end).toHaveBeenCalledOnce();
  });

  it('still ends pool if release fails', async () => {
    fake.release.mockImplementation(() => { throw new Error('private'); });
    await expect(runTestMigrations(options)).rejects.toMatchObject({
      code: 'MIGRATION_CLEANUP_FAILED',
    });
    expect(fake.end).toHaveBeenCalledOnce();
  });

  it('sanitizes pool shutdown failure', async () => {
    fake.end.mockRejectedValue(new Error('private'));
    await expect(runTestMigrations(options)).rejects.toMatchObject({
      code: 'MIGRATION_CLEANUP_FAILED',
    });
  });
});
