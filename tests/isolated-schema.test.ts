import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  query: vi.fn(), connect: vi.fn(), release: vi.fn(), end: vi.fn(),
  construct: vi.fn(), on: vi.fn(), migrate: vi.fn(), randomBytes: vi.fn(),
}));
vi.mock('node:crypto', () => ({ randomBytes: fake.randomBytes }));
vi.mock('../src/migrations', () => ({ runTestMigrations: fake.migrate }));
vi.mock('pg', () => ({
  Pool: class {
    constructor(config: unknown) { fake.construct(config); }
    connect = fake.connect;
    end = fake.end;
    on = fake.on;
  },
}));
import { withIsolatedSchema } from './support/isolated-schema';

const variables = {
  TEST_DATABASE_URL: 'postgresql://taskflow_app:example@localhost:5432/taskflow_test',
};
const name = 'taskflow_test_' + 'a'.repeat(32);

beforeEach(() => {
  vi.resetAllMocks();
  fake.randomBytes.mockReturnValue(Buffer.from('aa'.repeat(16), 'hex'));
  fake.connect.mockResolvedValue({ query: fake.query, release: fake.release });
  fake.end.mockResolvedValue(undefined);
  fake.migrate.mockResolvedValue(['0001']);
  fake.query.mockImplementation(async (sql: string) => {
    if (sql.includes('current_database')) return { rows: [{ database: 'taskflow_test' }] };
    if (sql.includes('pg_namespace')) return { rows: [{ oid: 123 }] };
    return { rows: [] };
  });
});

const statements = () => fake.query.mock.calls.map(([sql]) => sql as string);

describe('isolated schema ownership without real network', () => {
  it('creates a random schema, freezes its context and drops only its captured name', async () => {
    await withIsolatedSchema(async (context) => {
      expect(fake.randomBytes).toHaveBeenCalledWith(16);
      expect(context.schema).toBe(name);
      expect(Object.isFrozen(context)).toBe(true);
      expect(statements()[0]).toContain('current_database');
      expect(statements()[1]).toBe('CREATE SCHEMA "' + name + '"');
      expect(statements()[1]).not.toContain('IF NOT EXISTS');
      await context.migrate();
    }, variables);
    expect(fake.migrate).toHaveBeenCalledWith({ schema: name, variables });
    expect(statements().at(-1)).toBe('DROP SCHEMA "' + name + '" CASCADE');
    expect(fake.release).toHaveBeenCalledWith(true);
    expect(fake.end).toHaveBeenCalledOnce();
  });

  it('never adopts or drops a schema when CREATE collides', async () => {
    const previous = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('CREATE SCHEMA')) throw new Error('already exists private');
      return previous(sql);
    });
    const operation = vi.fn();
    await expect(withIsolatedSchema(operation, variables)).rejects.toThrow('ISOLATED_SCHEMA_OPERATION_FAILED');
    expect(operation).not.toHaveBeenCalled();
    expect(statements().some((s) => s.startsWith('DROP'))).toBe(false);
    expect(statements()).not.toContain('ROLLBACK');
    expect(fake.end).toHaveBeenCalledOnce();
  });

  it('cleans up after callback failure without leaking the failure details', async () => {
    await expect(withIsolatedSchema(async () => {
      throw new Error('SENTINEL_PASSWORD');
    }, variables)).rejects.toThrow('ISOLATED_SCHEMA_OPERATION_FAILED');
    expect(statements().at(-1)).toBe('DROP SCHEMA "' + name + '" CASCADE');
    expect(fake.end).toHaveBeenCalledOnce();
  });

  it('refuses cleanup if the captured namespace identity changed', async () => {
    let reads = 0;
    const previous = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_namespace')) return { rows: [{ oid: ++reads === 1 ? 123 : 456 }] };
      return previous(sql);
    });
    await expect(withIsolatedSchema(async () => {}, variables))
      .rejects.toThrow('ISOLATED_SCHEMA_OWNERSHIP_LOST');
    expect(statements().some((s) => s.startsWith('DROP'))).toBe(false);
    expect(fake.end).toHaveBeenCalledOnce();
  });

  it('does not drop anything when creation succeeded but ownership capture failed', async () => {
    const previous = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (sql: string) =>
      sql.includes('pg_namespace') ? { rows: [] } : previous(sql));
    await expect(withIsolatedSchema(async () => {}, variables))
      .rejects.toThrow('ISOLATED_SCHEMA_IDENTITY_MISSING');
    expect(statements().some((s) => s.startsWith('DROP'))).toBe(false);
  });

  it('refuses all writes on the wrong real database', async () => {
    fake.query.mockResolvedValue({ rows: [{ database: 'wrong_database' }] });
    await expect(withIsolatedSchema(async () => {}, variables))
      .rejects.toThrow('ISOLATED_DATABASE_REJECTED');
    expect(fake.query).toHaveBeenCalledOnce();
    expect(fake.end).toHaveBeenCalledOnce();
  });

  it('does not clean up if database confirmation changes before teardown', async () => {
    let checks = 0;
    const previous = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (sql: string) =>
      sql.includes('current_database')
        ? { rows: [{ database: ++checks === 1 ? 'taskflow_test' : 'other' }] }
        : previous(sql));
    await expect(withIsolatedSchema(async () => {}, variables))
      .rejects.toThrow('ISOLATED_DATABASE_REJECTED');
    expect(statements().some((s) => s.startsWith('DROP'))).toBe(false);
  });

  it('rejects an invalid generated identifier before any pool construction', async () => {
    fake.randomBytes.mockReturnValue({ toString: () => 'public' });
    await expect(withIsolatedSchema(async () => {}, variables))
      .rejects.toThrow('ISOLATED_SCHEMA_NAME_REJECTED');
    expect(fake.construct).not.toHaveBeenCalled();
  });

  it('does not use a schema supplied through variables', async () => {
    await withIsolatedSchema(async ({ schema }) => {
      expect(schema).toBe(name);
    }, { ...variables, schema: 'public' });
    expect(statements().some((s) => s.includes('"public"'))).toBe(false);
  });

  it('requires TEST_DATABASE_URL before any connection and has no fallback', async () => {
    await expect(withIsolatedSchema(async () => {}, { DATABASE_URL: variables.TEST_DATABASE_URL }))
      .rejects.toThrow('ISOLATED_SCHEMA_OPERATION_FAILED');
    expect(fake.connect).not.toHaveBeenCalled();
    expect(fake.construct).not.toHaveBeenCalled();
  });

  it('ends the pool after connection failure without attempting cleanup', async () => {
    fake.connect.mockRejectedValue(new Error('private connection details'));
    await expect(withIsolatedSchema(async () => {}, variables)).rejects.toThrow();
    expect(fake.query).not.toHaveBeenCalled();
    expect(fake.end).toHaveBeenCalledOnce();
  });

  it('reports cleanup failure safely and still releases resources', async () => {
    const previous = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('DROP')) throw new Error('SENTINEL_PASSWORD');
      return previous(sql);
    });
    await expect(withIsolatedSchema(async () => {}, variables))
      .rejects.toThrow('ISOLATED_SCHEMA_CLEANUP_FAILED');
    expect(fake.release).toHaveBeenCalledWith(true);
    expect(fake.end).toHaveBeenCalledOnce();
  });
});

describe('required external closure before schema removal', () => {
  it('awaits external closure once before ownership revalidation and DROP', async () => {
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => { complete = resolve; });
    const beforeDrop = vi.fn(() => pending);
    const operation = withIsolatedSchema(async () => {}, variables, { beforeDrop });
    try {
      await vi.waitFor(() => expect(beforeDrop).toHaveBeenCalledOnce());
      expect(statements().filter((sql) => sql.includes('current_database'))).toHaveLength(1);
      expect(statements().filter((sql) => sql.includes('pg_namespace'))).toHaveLength(1);
      expect(statements()).not.toContain('ROLLBACK');
      expect(statements().some((sql) => sql.startsWith('DROP'))).toBe(false);
      complete();
      await operation;
      expect(statements().filter((sql) => sql.includes('current_database'))).toHaveLength(2);
      expect(statements().filter((sql) => sql.includes('pg_namespace'))).toHaveLength(2);
      expect(statements().filter((sql) => sql.startsWith('DROP')))
        .toEqual(['DROP SCHEMA "' + name + '" CASCADE']);
      expect(beforeDrop).toHaveBeenCalledOnce();
      expect(fake.release).toHaveBeenCalledExactlyOnceWith(true);
      expect(fake.end).toHaveBeenCalledOnce();
    } finally { complete(); await operation; }
  });

  it.each(['throw', 'reject'])('blocks DROP on external %s and releases administrative resources', async (mode) => {
    const beforeDrop = vi.fn((): Promise<void> => {
      if (mode === 'throw') throw new Error('SENTINEL_PASSWORD_SQL_STACK_CAUSE');
      return Promise.reject(new Error('SENTINEL_PASSWORD_SQL_STACK_CAUSE'));
    });
    const result = withIsolatedSchema(async () => {}, variables, { beforeDrop });
    await expect(result).rejects.toThrow('ISOLATED_EXTERNAL_CLOSE_FAILED_SCHEMA_MAY_REMAIN');
    await expect(result).rejects.not.toThrow('SENTINEL');
    expect(beforeDrop).toHaveBeenCalledOnce();
    expect(statements().some((sql) => sql.startsWith('DROP'))).toBe(false);
    expect(statements().filter((sql) => sql.includes('pg_namespace'))).toHaveLength(1);
    expect(fake.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(fake.end).toHaveBeenCalledOnce();
  });

  it('runs mandatory closure after callback failure and still cleans up when closure succeeds', async () => {
    const beforeDrop = vi.fn(async () => {});
    await expect(withIsolatedSchema(async () => {
      throw new Error('SENTINEL_PRIVATE_CALLBACK');
    }, variables, { beforeDrop })).rejects.toThrow('ISOLATED_SCHEMA_OPERATION_FAILED');
    expect(beforeDrop).toHaveBeenCalledOnce();
    expect(statements().filter((sql) => sql.startsWith('DROP'))).toHaveLength(1);
    expect(fake.end).toHaveBeenCalledOnce();
  });

  it('retains the OID guard after successful external closure', async () => {
    let reads = 0;
    const previous = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (sql: string) =>
      sql.includes('pg_namespace') ? { rows: [{ oid: ++reads === 1 ? 123 : 456 }] } : previous(sql));
    const beforeDrop = vi.fn(async () => {});
    await expect(withIsolatedSchema(async () => {}, variables, { beforeDrop }))
      .rejects.toThrow('ISOLATED_SCHEMA_OWNERSHIP_LOST');
    expect(beforeDrop).toHaveBeenCalledOnce();
    expect(statements().some((sql) => sql.startsWith('DROP'))).toBe(false);
    expect(fake.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(fake.end).toHaveBeenCalledOnce();
  });

  it('never adopts or removes a preexisting schema with the optional closure enabled', async () => {
    const previous = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('CREATE SCHEMA')) throw new Error('synthetic collision');
      return previous(sql);
    });
    const operation = vi.fn();
    const beforeDrop = vi.fn(async () => {});
    await expect(withIsolatedSchema(operation, variables, { beforeDrop }))
      .rejects.toThrow('ISOLATED_SCHEMA_OPERATION_FAILED');
    expect(operation).not.toHaveBeenCalled();
    expect(beforeDrop).toHaveBeenCalledOnce();
    expect(statements().some((sql) => sql.startsWith('DROP'))).toBe(false);
    expect(fake.end).toHaveBeenCalledOnce();
  });
});
