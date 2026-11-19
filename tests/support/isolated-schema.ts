import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { createIntegrationWritePool } from '../../src/database';
import { runTestMigrations } from '../../src/migrations';

type Variables = Readonly<Record<string, string | undefined>>;

export interface IsolatedSchemaContext {
  readonly schema: string;
  readonly qualified: string;
  readonly client: PoolClient;
  readonly migrate: () => Promise<string[]>;
}

export class IsolatedSchemaError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'IsolatedSchemaError';
  }
}

function assertGeneratedName(name: string): void {
  // Exact length also rejects a trailing newline accepted by a bare regex $.
  if (name.length !== 46 || !/^taskflow_test_[a-f0-9]{32}$/.test(name)) {
    throw new IsolatedSchemaError('ISOLATED_SCHEMA_NAME_REJECTED');
  }
}

async function assertTestDatabase(client: PoolClient): Promise<void> {
  const result = await client.query<{ database: string }>(
    'SELECT pg_catalog.current_database() AS database',
  );
  if (result.rows[0]?.database !== 'taskflow_test') {
    throw new IsolatedSchemaError('ISOLATED_DATABASE_REJECTED');
  }
}

/**
 * No external schema argument. Creation is explicit, not performed on import.
 * Only a confirmed CREATE plus the captured namespace OID grants cleanup rights.
 */
export async function withIsolatedSchema<T>(
  operation: (context: IsolatedSchemaContext) => Promise<T>,
  variables: Variables = process.env,
): Promise<T> {
  const schema = 'taskflow_test_' + randomBytes(16).toString('hex');
  assertGeneratedName(schema);
  const qualified = '"' + schema + '"';
  let pool: Pool | undefined;
  let client: PoolClient | undefined;
  let createdByThisRun = false;
  let ownedOid: number | undefined;
  let failure: IsolatedSchemaError | undefined;
  let value: T | undefined;

  try {
    pool = createIntegrationWritePool('persistence-test', variables);
    client = await pool.connect();
    await assertTestDatabase(client);
    // No IF NOT EXISTS: a collision must fail, never adopt a preexisting schema.
    await client.query('CREATE SCHEMA ' + qualified);
    createdByThisRun = true;
    const identity = await client.query<{ oid: number }>(
      'SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $1', [schema],
    );
    const capturedOid = identity.rows[0]?.oid;
    if (!Number.isInteger(capturedOid) || !capturedOid) {
      throw new IsolatedSchemaError('ISOLATED_SCHEMA_IDENTITY_MISSING');
    }
    ownedOid = capturedOid;
    const context: IsolatedSchemaContext = Object.freeze({
      schema, qualified, client,
      migrate: () => runTestMigrations({ schema, variables }),
    });
    value = await operation(context);
  } catch (error) {
    failure = error instanceof IsolatedSchemaError ? error
      : new IsolatedSchemaError('ISOLATED_SCHEMA_OPERATION_FAILED');
  } finally {
    if (client && createdByThisRun && ownedOid !== undefined) {
      try {
        // Clear any transaction left by the test, without committing its writes.
        await client.query('ROLLBACK');
        await assertTestDatabase(client);
        assertGeneratedName(schema);
        const identity = await client.query<{ oid: number }>(
          'SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $1', [schema],
        );
        if (identity.rows[0]?.oid !== ownedOid) {
          throw new IsolatedSchemaError('ISOLATED_SCHEMA_OWNERSHIP_LOST');
        }
        await client.query('DROP SCHEMA ' + qualified + ' CASCADE');
      } catch (error) {
        // Ownership loss / cleanup failure must remain visible even after a test failure.
        failure = error instanceof IsolatedSchemaError ? error
          : new IsolatedSchemaError('ISOLATED_SCHEMA_CLEANUP_FAILED');
      }
    }
    if (client) {
      try { client.release(true); }
      catch { failure ??= new IsolatedSchemaError('ISOLATED_CLIENT_RELEASE_FAILED'); }
    }
    if (pool) {
      try { await pool.end(); }
      catch { failure ??= new IsolatedSchemaError('ISOLATED_POOL_CLOSE_FAILED'); }
    }
  }
  if (failure) throw failure;
  return value as T;
}
