import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { createIntegrationWritePool } from './database';

export type MigrationCode =
  | 'MIGRATION_CONFIG_INVALID' | 'MIGRATION_FILES_INVALID'
  | 'MIGRATION_DESTINATION_REJECTED' | 'MIGRATION_SCHEMA_MISSING'
  | 'MIGRATION_LOCKED' | 'MIGRATION_HISTORY_MISMATCH'
  | 'MIGRATION_FAILED' | 'MIGRATION_COMMIT_UNCERTAIN'
  | 'MIGRATION_CLEANUP_FAILED'
  | 'MIGRATION_INITIAL_OBJECT_EXISTS' | 'MIGRATION_INITIAL_FILES_INVALID';

export class MigrationError extends Error {
  constructor(
    public readonly code: MigrationCode,
    public readonly phase: string,
  ) {
    super(code + ' during ' + phase);
    this.name = 'MigrationError';
  }
}

interface Migration {
  version: string;
  name: string;
  checksum: string;
  sql: string;
}

export interface MigrationOptions {
  mode?: 'versioned' | 'initial-installation';
  // Isolated schemas must already exist and use this reserved prefix.
  schema: string;
  variables?: Readonly<Record<string, string | undefined>>;
}

function quotedSchema(schema: unknown): string {
  if (typeof schema !== 'string' ||
      (schema !== 'public' && !/^taskflow_test_[a-z0-9_]+$/.test(schema)) ||
      schema.length > 63) {
    throw new MigrationError('MIGRATION_CONFIG_INVALID', 'schema validation');
  }
  return '"' + schema + '"';
}

// Only repository-owned migration files are loaded; no SQL is executed on import.
export async function loadMigrations(): Promise<Migration[]> {
  try {
    const directory = join(__dirname, '..', 'migrations');
    const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
    if (names.length === 0) throw new Error();
    const versions = new Set<string>();
    const result: Migration[] = [];
    for (const name of names) {
      const match = /^(\d{4})_[a-z][a-z0-9_]*\.sql$/.exec(name);
      if (!match || versions.has(match[1]!)) throw new Error();
      versions.add(match[1]!);
      const bytes = await readFile(join(directory, name));
      const sql = bytes.toString('utf8');
      if (!sql.trim() || !sql.includes('{{schema}}')) throw new Error();
      result.push({
        version: match[1]!, name,
        checksum: createHash('sha256').update(bytes).digest('hex'),
        sql,
      });
    }
    return result;
  } catch {
    throw new MigrationError('MIGRATION_FILES_INVALID', 'file loading');
  }
}

interface HistoryRow {
  version: string;
  name: string;
  checksum: string;
}

/**
 * Explicit invocation only. Currently restricted to the approved test database.
 * Owns one pool/client and never creates or drops schemas.
 */
export async function runTestMigrations(options: MigrationOptions): Promise<string[]> {
  const schema = quotedSchema(options?.schema);
  const mode = options?.mode ?? 'versioned';
  if (mode !== 'versioned' && mode !== 'initial-installation') {
    throw new MigrationError('MIGRATION_CONFIG_INVALID', 'mode validation');
  }
  const initialInstallation = mode === 'initial-installation';
  if (initialInstallation && options.schema !== 'public') {
    throw new MigrationError('MIGRATION_CONFIG_INVALID', 'initial schema validation');
  }

  const migrations = await loadMigrations();
  if (initialInstallation &&
      (migrations.length !== 1 || migrations[0]?.version !== '0001' ||
       migrations[0]?.name !== '0001_create_tasks.sql')) {
    throw new MigrationError('MIGRATION_INITIAL_FILES_INVALID', 'initial file validation');
  }

  let pool: Pool | undefined;
  let client: PoolClient | undefined;
  let transaction = false;
  let discardClient = false;
  let phase = 'configuration';
  let failure: MigrationError | undefined;
  const applied: string[] = [];

  try {
    try {
      pool = createIntegrationWritePool('migration', options.variables);
    } catch {
      throw new MigrationError('MIGRATION_CONFIG_INVALID', phase);
    }
    phase = 'connection';
    client = await pool.connect();
    phase = 'destination verification';
    const destination = await client.query<{ database: string }>(
      'SELECT pg_catalog.current_database() AS database',
    );
    if (destination.rows[0]?.database !== 'taskflow_test') {
      throw new MigrationError('MIGRATION_DESTINATION_REJECTED', phase);
    }

    phase = 'transaction start';
    await client.query('BEGIN');
    transaction = true;
    phase = 'advisory lock';
    // Fixed TaskFlow key; transaction-scoped and shared across schemas in this DB.
    const lock = await client.query<{ locked: boolean }>(
      'SELECT pg_catalog.pg_try_advisory_xact_lock($1, $2) AS locked',
      [194865, 1],
    );
    if (lock.rows[0]?.locked !== true) {
      throw new MigrationError('MIGRATION_LOCKED', phase);
    }

    phase = 'schema verification';
    const namespace = await client.query(
      'SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1',
      [options.schema],
    );
    if (namespace.rows.length !== 1) {
      throw new MigrationError('MIGRATION_SCHEMA_MISSING', phase);
    }

    if (initialInstallation) {
      phase = 'initial object verification';
      // Check relations of every kind and standalone types before any DDL.
      // This is deliberately inside the transaction, after the advisory lock.
      const conflicts = await client.query(
        `SELECT c.relname AS name FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = ANY($2::text[])
         UNION ALL
         SELECT t.typname AS name FROM pg_catalog.pg_type t
         JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = $1 AND t.typname = ANY($2::text[])`,
        ['public', ['tasks', 'taskflow_schema_migrations']],
      );
      if (conflicts.rows.length !== 0) {
        throw new MigrationError('MIGRATION_INITIAL_OBJECT_EXISTS', phase);
      }
    }
    // All objects are schema-qualified. No user/public objects resolve via search_path.
    await client.query("SET LOCAL search_path = pg_catalog");
    phase = 'history initialization';
    const history = schema + '."taskflow_schema_migrations"';
    const createHistory = initialInstallation ? 'CREATE TABLE' : 'CREATE TABLE IF NOT EXISTS';
    await client.query(`${createHistory} ${history} (
      version text PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    phase = 'history validation';
    const records = await client.query<HistoryRow>(
      `SELECT version, name, checksum FROM ${history} ORDER BY version`,
    );
    if (initialInstallation && records.rows.length !== 0) {
      throw new MigrationError('MIGRATION_INITIAL_OBJECT_EXISTS', phase);
    }
    // Applied history must be an exact prefix of this repository's migration list.
    if (records.rows.length > migrations.length) {
      throw new MigrationError('MIGRATION_HISTORY_MISMATCH', phase);
    }
    for (const [index, record] of records.rows.entries()) {
      const migration = migrations[index]!;
      if (record.version !== migration.version ||
          record.name !== migration.name ||
          record.checksum !== migration.checksum) {
        throw new MigrationError('MIGRATION_HISTORY_MISMATCH', phase);
      }
    }

    for (const migration of migrations.slice(records.rows.length)) {
      phase = 'migration ' + migration.version;
      await client.query(migration.sql.replaceAll('{{schema}}', schema));
      await client.query(
        `INSERT INTO ${history} (version, name, checksum) VALUES ($1, $2, $3)`,
        [migration.version, migration.name, migration.checksum],
      );
      applied.push(migration.version);
    }

    phase = 'commit';
    await client.query('COMMIT');
    transaction = false;
  } catch (error) {
    failure = error instanceof MigrationError ? error
      : new MigrationError(phase === 'commit'
        ? 'MIGRATION_COMMIT_UNCERTAIN' : 'MIGRATION_FAILED', phase);
    if (transaction && client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        discardClient = true;
        // Preserve the original sanitized failure; destroy the unusable client.
      }
    }
  } finally {
    if (client) {
      try {
        client.release(discardClient);
      } catch {
        failure ??= new MigrationError('MIGRATION_CLEANUP_FAILED', 'client release');
      }
    }
    if (pool) {
      try {
        await pool.end();
      } catch {
        failure ??= new MigrationError('MIGRATION_CLEANUP_FAILED', 'pool shutdown');
      }
    }
  }

  if (failure) throw failure;
  return applied;
}
