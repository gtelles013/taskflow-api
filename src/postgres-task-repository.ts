import type { Task, TaskRepository } from './task-repository';
import { classifyPostgresFailure } from './postgres-errors';
import type { PostgresFailureCategory } from './postgres-errors';

export interface TaskQueryExecutor {
  query(text: string, values: (string | null)[]): Promise<unknown>;
}

export type TaskRepositoryErrorCode =
  | 'TASK_REPOSITORY_SCHEMA_INVALID'
  | 'TASK_REPOSITORY_QUERY_FAILED'
  | 'TASK_REPOSITORY_RESULT_INVALID';

// Only the query-failure boundary below registers final repository errors.
const unavailableRepositoryErrors = new WeakSet<object>();
export interface PostgresUnavailableMetadata { readonly databaseCode?: string; }
const unavailableMetadata = new WeakMap<object, Readonly<PostgresUnavailableMetadata>>();

/** Reads only a private snapshot; never inspects properties of the supplied error. */
export function getPostgresUnavailableMetadata(error: unknown): Readonly<PostgresUnavailableMetadata> | undefined {
  return typeof error === 'object' && error !== null ? unavailableMetadata.get(error) : undefined;
}

export function isPostgresRepositoryUnavailable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && unavailableRepositoryErrors.has(error);
}

export class TaskRepositoryError extends Error {
  constructor(
    public readonly code: TaskRepositoryErrorCode,
    public readonly databaseCode?: string,
    public readonly category: PostgresFailureCategory = 'internal',
  ) {
    super(code);
    this.name = 'TaskRepositoryError';
  }
}

function quoteSchema(schema: unknown): string {
  if (typeof schema !== 'string' || schema.length > 63 ||
      /^(?:public|taskflow_test_[a-z0-9_]+)$/.exec(schema)?.[0] !== schema) {
    throw new TaskRepositoryError('TASK_REPOSITORY_SCHEMA_INVALID');
  }
  return '"' + schema + '"';
}

function mapResult(result: unknown): Task {
  if (typeof result !== 'object' || result === null ||
      !('rows' in result) || !Array.isArray(result.rows) || result.rows.length !== 1) {
    throw new TaskRepositoryError('TASK_REPOSITORY_RESULT_INVALID');
  }
  const row: unknown = result.rows[0];
  if (typeof row !== 'object' || row === null ||
      !('id' in row) || typeof row.id !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(row.id) ||
      !('title' in row) || typeof row.title !== 'string' ||
      !('description' in row) || (row.description !== null && typeof row.description !== 'string') ||
      !('status' in row) || row.status !== 'pending' ||
      !('created_at' in row) || !(row.created_at instanceof Date) ||
      !Number.isFinite(row.created_at.getTime())) {
    throw new TaskRepositoryError('TASK_REPOSITORY_RESULT_INVALID');
  }
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    createdAt: new Date(row.created_at.getTime()),
  };
}

/**
 * Borrows the executor: never connects, releases, closes or retries it.
 * Input is already normalized by the application boundary, not the HTTP schema.
 */
export class PostgresTaskRepository implements TaskRepository {
  private readonly insertSql: string;

  constructor(private readonly executor: TaskQueryExecutor, schema: string = 'public') {
    const qualifiedSchema = quoteSchema(schema);
    this.insertSql = 'INSERT INTO ' + qualifiedSchema + '.tasks (title, description) ' +
      'VALUES ($1, $2) RETURNING id, title, description, status, created_at';
  }

  async create(input: { title: string; description: string | null }): Promise<Task> {
    let result: unknown;
    try {
      result = await this.executor.query(this.insertSql, [input.title, input.description]);
    } catch (error) {
      // Do not retain cause, raw driver messages, SQL, parameters or connection settings.
      const failure = classifyPostgresFailure(error);
      const repositoryError = new TaskRepositoryError('TASK_REPOSITORY_QUERY_FAILED', failure.databaseCode, failure.category);
      if (failure.category === 'unavailable') {
        unavailableRepositoryErrors.add(repositoryError);
        unavailableMetadata.set(repositoryError, Object.freeze(
          failure.databaseCode === undefined ? {} : { databaseCode: failure.databaseCode },
        ));
      }
      throw repositoryError;
    }
    return mapResult(result);
  }
}
