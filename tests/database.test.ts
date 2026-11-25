import { describe, expect, it, vi, beforeEach } from 'vitest';

const fake = vi.hoisted(() => ({
  end: vi.fn(async () => {}),
  on: vi.fn(),
  construct: vi.fn(),
  connect: vi.fn(),
  query: vi.fn(),
}));
vi.mock('pg', () => ({
  Pool: class {
    constructor(config: unknown) { fake.construct(config); }
    end = fake.end;
    on = fake.on;
    connect = fake.connect;
    query = fake.query;
  },
}));

import { databasePoolConfig, createDatabasePool, withDatabasePool, integrationWritePoolConfig, createIntegrationWritePool } from '../src/database';

const testUrl = 'postgresql://taskflow_app:example@localhost:5432/taskflow_test';
const devUrl = 'postgresql://taskflow_app:example@localhost:5432/taskflow_dev';

beforeEach(() => vi.clearAllMocks());

describe('explicit database configuration without network access', () => {
  it('requires TEST_DATABASE_URL even when DATABASE_URL is supplied', () => {
    expect(() => createDatabasePool('integration', { DATABASE_URL: devUrl }))
      .toThrow('TEST_DATABASE_URL is required');
    expect(fake.construct).not.toHaveBeenCalled();
  });

  it.each([
    '', 'not-a-url', devUrl,
    testUrl.replace('taskflow_test', 'credit_risk_db'),
    testUrl.replace('localhost', 'remote.example'),
    testUrl.replace('5432', '5433'),
    testUrl.replace('taskflow_app', 'other_user'),
    testUrl + '?dbname=other',
    testUrl + '?options=-csearch_path=other',
    testUrl + '#fragment',
    testUrl.replace(':example@', '@'),
  ])('rejects unsafe or missing integration destination %# before constructing pool', (url) => {
    expect(() => createDatabasePool('integration', { TEST_DATABASE_URL: url }))
      .toThrow();
    expect(fake.construct).not.toHaveBeenCalled();
  });

  it('uses only the integration variable with finite timeouts and read-only sessions', () => {
    const config = databasePoolConfig('integration', {
      TEST_DATABASE_URL: testUrl,
      DATABASE_URL: 'invalid',
    });
    expect(config).toMatchObject({
      database: 'taskflow_test', host: 'localhost', port: 5432,
      connectionTimeoutMillis: 3000, idleTimeoutMillis: 1000,
      max: 1, options: '-c default_transaction_read_only=on',
      statement_timeout: 3000,
    });
  });

  it('requires an explicit development destination', () => {
    expect(databasePoolConfig('development', { DATABASE_URL: devUrl }).database)
      .toBe('taskflow_dev');
    expect(() => databasePoolConfig('development', { TEST_DATABASE_URL: testUrl }))
      .toThrow('DATABASE_URL is required');
    expect(() => databasePoolConfig('development', { DATABASE_URL: testUrl }))
      .toThrow();
  });

  it('decodes escaped passwords without including them in errors', () => {
    expect(databasePoolConfig('integration', {
      TEST_DATABASE_URL: testUrl.replace('example', 'example%40secret'),
    }).password).toBe('example@secret');
    let message = '';
    try {
      databasePoolConfig('integration', { TEST_DATABASE_URL: 'invalid-secret-value' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain('invalid-secret-value');
  });

  it('closes the pool after successful work', async () => {
    await expect(withDatabasePool('integration', async () => 'done', {
      TEST_DATABASE_URL: testUrl,
    })).resolves.toBe('done');
    expect(fake.end).toHaveBeenCalledOnce();
  });

  it('closes the pool even when work fails', async () => {
    await expect(withDatabasePool('integration', async () => {
      throw new Error('probe failed');
    }, { TEST_DATABASE_URL: testUrl })).rejects.toThrow('probe failed');
    expect(fake.end).toHaveBeenCalledOnce();
  });
});

describe('runtime guards and explicit integration write access', () => {
  it.each([undefined, null, '', 'production', 'INTEGRATION', 1, {}])(
    'rejects unknown runtime environment %# before pool construction',
    (environment) => {
      expect(() => createDatabasePool(environment as never, {
        DATABASE_URL: devUrl, TEST_DATABASE_URL: testUrl,
      })).toThrow('Unknown database environment');
      expect(fake.construct).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null, '', 'development', 'integration', 'read-only', 1, {}])(
    'rejects unknown runtime write purpose %# before pool construction',
    (purpose) => {
      expect(() => createIntegrationWritePool(purpose as never, {
        TEST_DATABASE_URL: testUrl,
      })).toThrow('Unknown integration write purpose');
      expect(fake.construct).not.toHaveBeenCalled();
    },
  );

  it.each(['migration', 'persistence-test'] as const)(
    'requires TEST_DATABASE_URL for %s without fallback',
    (purpose) => {
      expect(() => createIntegrationWritePool(purpose, { DATABASE_URL: devUrl }))
        .toThrow('TEST_DATABASE_URL is required');
      expect(fake.construct).not.toHaveBeenCalled();
    },
  );

  it.each([
    '', '  ', 'not-a-url', devUrl,
    testUrl.replace('taskflow_test', 'unapproved_database'),
    testUrl.replace('postgresql:', 'https:'),
    testUrl.replace('localhost', '127.0.0.1'),
    testUrl.replace('localhost', 'remote.example'),
    testUrl.replace('5432', '5433'),
    testUrl.replace('taskflow_app', 'other_user'),
    testUrl.replace('taskflow_app', ''),
    testUrl.replace(':example@', '@'),
    testUrl.replace('example', '%ZZ'),
    testUrl.replace('taskflow_app', '%ZZ'),
    testUrl + '?database=taskflow_dev',
    testUrl + '?options=-csearch_path=other',
    testUrl + '#fragment',
  ])('rejects invalid write destination %# without constructing a pool', (url) => {
    expect(() => createIntegrationWritePool('migration', { TEST_DATABASE_URL: url }))
      .toThrow();
    expect(fake.construct).not.toHaveBeenCalled();
  });

  it.each(['migration', 'persistence-test'] as const)(
    'keeps %s configuration isolated from read-only and development settings',
    (purpose) => {
      const variables = { TEST_DATABASE_URL: testUrl, DATABASE_URL: devUrl };
      const readOnly = databasePoolConfig('integration', variables);
      const write = integrationWritePoolConfig(purpose, variables);
      expect(readOnly.options).toBe('-c default_transaction_read_only=on');
      expect(write).toMatchObject({
        database: 'taskflow_test', host: 'localhost', port: 5432,
        user: 'taskflow_app', max: 1,
        options: '-c default_transaction_read_only=off',
        connectionTimeoutMillis: 3000, statement_timeout: 3000,
        application_name: 'taskflow-integration-' + purpose,
      });
      expect(databasePoolConfig('integration', variables)).toEqual(readOnly);
      expect(databasePoolConfig('development', variables).database).toBe('taskflow_dev');
    },
  );

  it('constructs write pool lazily without connect or query', async () => {
    const pool = createIntegrationWritePool('migration', { TEST_DATABASE_URL: testUrl });
    expect(fake.construct).toHaveBeenCalledOnce();
    expect(fake.connect).not.toHaveBeenCalled();
    expect(fake.query).not.toHaveBeenCalled();
    await pool.end();
    expect(fake.end).toHaveBeenCalledOnce();
  });

  it.each(['read', 'write'] as const)('sanitizes %s configuration errors', (mode) => {
    const sentinel = 'SENTINEL_PASSWORD';
    const raw = testUrl.replace('example', sentinel).replace('localhost', 'wrong-host');
    let caught: unknown;
    try {
      if (mode === 'write') integrationWritePoolConfig('migration', { TEST_DATABASE_URL: raw });
      else databasePoolConfig('integration', { TEST_DATABASE_URL: raw });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const diagnostic = String(caught) + (caught as Error).stack;
    expect(diagnostic).not.toContain(raw);
    expect(diagnostic).not.toContain(sentinel);
  });
});
