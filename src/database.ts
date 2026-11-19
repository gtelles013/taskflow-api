import { Pool } from 'pg';
import type { PoolConfig } from 'pg';

export type DatabaseEnvironment = 'development' | 'integration';
export type IntegrationWritePurpose = 'migration' | 'persistence-test';
type EnvironmentVariables = Readonly<Record<string, string | undefined>>;

export function databasePoolConfig(
  environment: DatabaseEnvironment,
  variables: EnvironmentVariables = process.env,
): PoolConfig {
  if (environment !== 'development' && environment !== 'integration') {
    throw new Error('Unknown database environment');
  }
  const key = environment === 'integration' ? 'TEST_DATABASE_URL' : 'DATABASE_URL';
  const expectedDatabase = environment === 'integration' ? 'taskflow_test' : 'taskflow_dev';
  const raw = variables[key];
  if (!raw?.trim()) {
    throw new Error(key + ' is required; no database fallback is allowed');
  }

  let url: URL;
  try {
    url = new URL(raw);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.hostname !== 'localhost' ||
      (url.port || '5432') !== '5432' ||
      url.pathname !== '/' + expectedDatabase ||
      decodeURIComponent(url.username) !== 'taskflow_app' ||
      !url.password ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      throw new Error('Invalid destination');
    }
    return {
      host: 'localhost',
      port: 5432,
      database: expectedDatabase,
      user: 'taskflow_app',
      password: decodeURIComponent(url.password),
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 1000,
      max: environment === 'integration' ? 1 : 10,
      application_name: 'taskflow-' + environment,
      ...(environment === 'integration'
        ? { options: '-c default_transaction_read_only=on', statement_timeout: 3000 }
        : {}),
    };
  } catch {
    // Never include the supplied URL or parser error in diagnostics.
    throw new Error(key + ' must target the approved local ' + expectedDatabase + ' database');
  }
}

// Construction is lazy: no socket is opened until query/connect is called.
export function createDatabasePool(
  environment: DatabaseEnvironment,
  variables: EnvironmentVariables = process.env,
): Pool {
  return poolFromConfig(databasePoolConfig(environment, variables));
}

function poolFromConfig(config: PoolConfig): Pool {
  const pool = new Pool(config);
  pool.on('error', () => {
    console.error('PostgreSQL idle connection error; connection details omitted');
  });
  return pool;
}

export async function withDatabasePool<T>(
  environment: DatabaseEnvironment,
  operation: (pool: Pool) => Promise<T>,
  variables: EnvironmentVariables = process.env,
): Promise<T> {
  const pool = createDatabasePool(environment, variables);
  try {
    return await operation(pool);
  } finally {
    await pool.end();
  }
}

/**
 * Explicit write access for future migrations/persistence tests.
 * Destination validation is identical to the read-only integration path.
 */
export function integrationWritePoolConfig(
  purpose: IntegrationWritePurpose,
  variables: EnvironmentVariables = process.env,
): PoolConfig {
  if (purpose !== 'migration' && purpose !== 'persistence-test') {
    throw new Error('Unknown integration write purpose');
  }

  return {
    ...databasePoolConfig('integration', variables),
    options: '-c default_transaction_read_only=off',
    application_name: 'taskflow-integration-' + purpose,
  };
}

// No query or connect call: the caller must explicitly acquire/use a connection.
export function createIntegrationWritePool(
  purpose: IntegrationWritePurpose,
  variables: EnvironmentVariables = process.env,
): Pool {
  return poolFromConfig(integrationWritePoolConfig(purpose, variables));
}
