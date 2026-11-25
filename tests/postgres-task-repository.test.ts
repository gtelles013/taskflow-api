import { classifyPostgresFailure, createPostgresAcquisitionTimeoutError, PostgresOperationError } from '../src/postgres-errors';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import type { TaskRepository } from '../src/task-repository';
import {
  PostgresTaskRepository, TaskRepositoryError,
} from '../src/postgres-task-repository';

// Compile-time compatibility with real pg types; never constructs or connects them.
function acceptsPgExecutors(pool: Pool, client: PoolClient): void {
  const first: TaskRepository = new PostgresTaskRepository(pool);
  const second: TaskRepository = new PostgresTaskRepository(client, 'taskflow_test_example');
  void first; void second;
}
void acceptsPgExecutors;

const query = vi.fn();
const executor = { query, connect: vi.fn(), end: vi.fn(), release: vi.fn() };
const instant = new Date('2026-11-19T10:20:30.123Z');
const row = () => ({
  id: '12345678-1234-4123-8123-123456789abc',
  title: 'Returned title',
  description: null as string | null,
  status: 'pending',
  created_at: new Date(instant),
});

beforeEach(() => {
  vi.resetAllMocks();
  query.mockResolvedValue({ rows: [row()] });
});

describe('PostgresTaskRepository using a borrowed mock executor', () => {
  it('uses a single parameterized INSERT with a quoted default schema', async () => {
    const repository: TaskRepository = new PostgresTaskRepository(executor);
    const input = Object.freeze({ title: "Example ' ; --", description: null });
    await repository.create(input);
    expect(query).toHaveBeenCalledExactlyOnceWith(
      'INSERT INTO "public".tasks (title, description) VALUES ($1, $2) ' +
      'RETURNING id, title, description, status, created_at',
      [input.title, input.description],
    );
  });

  it('quotes an explicitly configured isolated schema', async () => {
    await new PostgresTaskRepository(executor, 'taskflow_test_example')
      .create({ title: 'Example', description: null });
    expect(query.mock.calls[0]?.[0]).toContain('INSERT INTO "taskflow_test_example".tasks');
  });

  it('maps only RETURNING fields, including generated values and a valid Date', async () => {
    const returned = { ...row(), ignored: 'not part of Task' };
    query.mockResolvedValue({ rows: [returned] });
    const task = await new PostgresTaskRepository(executor)
      .create({ title: 'Input title', description: 'Input description' });
    expect(task).toEqual({
      id: returned.id, title: returned.title, description: returned.description,
      status: 'pending', createdAt: instant,
    });
    expect(task.createdAt).toBeInstanceOf(Date);
    expect(Number.isFinite(task.createdAt.getTime())).toBe(true);
    expect(task.createdAt).not.toBe(returned.created_at);
    expect(task.createdAt.toISOString()).toBe('2026-11-19T10:20:30.123Z');
  });

  it.each([null, '', '   ', '  description \n ', '\u{1F600} e\u0301'])(
    'preserves description %# without HTTP revalidation or normalization', async (description) => {
      query.mockResolvedValue({ rows: [{ ...row(), description }] });
      const input = Object.freeze({ title: 'Normalized', description });
      const task = await new PostgresTaskRepository(executor).create(input);
      expect(query.mock.calls[0]?.[1]).toEqual(['Normalized', description]);
      expect(task.description).toBe(description);
      expect(input).toEqual({ title: 'Normalized', description });
    },
  );

  it('does not connect, query or close anything during construction', () => {
    const repository = new PostgresTaskRepository(executor);
    expect(query).not.toHaveBeenCalled();
    expect(executor.connect).not.toHaveBeenCalled();
    expect(executor.end).not.toHaveBeenCalled();
    expect(executor.release).not.toHaveBeenCalled();
    expect('close' in repository).toBe(false);
  });

  it.each([
    '', 'public\n', 'public\r\n', 'PUBLIC', 'other_schema', 'pg_catalog',
    'public.tasks', 'public;DROP TABLE tasks', 'taskflow_test_x"',
    'taskflow_test_x\n', 'taskflow_test_' + 'a'.repeat(60), null, 1, {},
  ])('rejects invalid schema %# before any query', (schema) => {
    expect(() => new PostgresTaskRepository(executor, schema as string))
      .toThrow('TASK_REPOSITORY_SCHEMA_INVALID');
    expect(query).not.toHaveBeenCalled();
    expect(executor.connect).not.toHaveBeenCalled();
  });

  it.each([
    undefined, null, {}, { rows: null }, { rows: [] },
    { rows: [null] }, { rows: ['not an object'] },
    { rows: [row(), row()] },
  ])('rejects malformed result %#', async (result) => {
    query.mockResolvedValue(result);
    await expect(new PostgresTaskRepository(executor).create({ title: 'Example', description: null }))
      .rejects.toMatchObject({ code: 'TASK_REPOSITORY_RESULT_INVALID' });
    expect(query).toHaveBeenCalledOnce();
  });

  it.each(['id', 'title', 'description', 'status', 'created_at'])(
    'rejects missing RETURNING field %s', async (field) => {
      const incomplete: Record<string, unknown> = { ...row() };
      delete incomplete[field];
      query.mockResolvedValue({ rows: [incomplete] });
      await expect(new PostgresTaskRepository(executor).create({ title: 'Example', description: null }))
        .rejects.toThrow(TaskRepositoryError);
    },
  );

  it.each([
    { id: 123 }, { id: 'invalid-uuid' }, { title: null }, { title: 123 },
    { description: undefined }, { description: 123 }, { status: 'done' },
    { created_at: '2026-11-19T10:20:30.123Z' }, { created_at: null },
    { created_at: new Date(NaN) },
  ])('rejects an invalid row field %#', async (patch) => {
    query.mockResolvedValue({ rows: [{ ...row(), ...patch }] });
    await expect(new PostgresTaskRepository(executor).create({ title: 'Example', description: null }))
      .rejects.toMatchObject({ code: 'TASK_REPOSITORY_RESULT_INVALID' });
  });

  it.each(['ECONNREFUSED', '23514', undefined])(
    'encapsulates driver failure %# safely with no retry or close', async (code) => {
      const driverError = Object.assign(new Error('SENTINEL_PASSWORD private SQL'), { code });
      query.mockRejectedValue(driverError);
      let caught: unknown;
      try {
        await new PostgresTaskRepository(executor).create({ title: 'Example', description: null });
      } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(TaskRepositoryError);
      expect(caught).toMatchObject({ code: 'TASK_REPOSITORY_QUERY_FAILED', databaseCode: code });
      expect((caught as Error).cause).toBeUndefined();
      expect(String(caught) + (caught as Error).stack + JSON.stringify(caught))
        .not.toContain('SENTINEL_PASSWORD');
      expect(query).toHaveBeenCalledOnce();
      expect(executor.end).not.toHaveBeenCalled();
      expect(executor.release).not.toHaveBeenCalled();
    },
  );

  it('does not expose an unknown driver code', async () => {
    query.mockRejectedValue({ code: 'SENTINEL_PASSWORD', message: 'private' });
    await expect(new PostgresTaskRepository(executor).create({ title: 'Example', description: null }))
      .rejects.toMatchObject({ databaseCode: undefined });
  });

  it('never closes or releases its borrowed executor after success', async () => {
    await new PostgresTaskRepository(executor).create({ title: 'Example', description: null });
    expect(executor.end).not.toHaveBeenCalled();
    expect(executor.release).not.toHaveBeenCalled();
    expect(executor.connect).not.toHaveBeenCalled();
  });
});


describe('PostgreSQL failure classification at the repository boundary', () => {
  it.each([
    '08000', '08001', '08003', '08004', '08006', '08007', '08P01', '08ZZZ',
    '57P01', '57P02', '57P03', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT',
  ])('classifies structured code %s as unavailable with one INSERT', async (code) => {
    query.mockRejectedValue(Object.assign(new Error('PRIVATE SQL password'), { code }));
    const failure = await new PostgresTaskRepository(executor)
      .create({ title: 'Task', description: null }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TaskRepositoryError);
    expect(failure).toMatchObject({ category: 'unavailable', databaseCode: code });
    expect(String(failure) + JSON.stringify(failure)).not.toContain('PRIVATE');
    expect(query).toHaveBeenCalledOnce();
  });

  it.each([
    '28000', '28P01', '42501', '23502', '23503', '23505', '23514', '42P01',
    '42601', '57014', '53300', 'UNKNOWN', '08', '08P01\n', '08p01', '', undefined,
  ])('keeps code %s internal with no retry', async (code) => {
    query.mockRejectedValue(Object.assign(new Error('timeout connection PRIVATE'), { code, statusCode: 503 }));
    const failure = await new PostgresTaskRepository(executor)
      .create({ title: 'Task', description: null }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ category: 'internal' });
    expect(String(failure) + JSON.stringify(failure)).not.toContain('PRIVATE');
    expect(query).toHaveBeenCalledOnce();
  });

  it.each([null, undefined, 1, 'connection timeout', { category: 'unavailable', statusCode: 503 }])(
    'does not trust arbitrary failure metadata %#', async (failure) => {
      query.mockRejectedValue(failure);
      await expect(new PostgresTaskRepository(executor).create({ title: 'Task', description: null }))
        .rejects.toMatchObject({ category: 'internal', databaseCode: undefined });
      expect(query).toHaveBeenCalledOnce();
    },
  );

  it('does not invoke an arbitrary code getter', async () => {
    const getter = vi.fn(() => { throw new Error('PRIVATE'); });
    query.mockRejectedValue(Object.defineProperty({}, 'code', { get: getter }));
    await expect(new PostgresTaskRepository(executor).create({ title: 'Task', description: null }))
      .rejects.toMatchObject({ category: 'internal' });
    expect(getter).not.toHaveBeenCalled();
  });

  it('never classifies mapping failures as unavailability', async () => {
    query.mockResolvedValue({ rows: [], code: 'ECONNRESET' });
    await expect(new PostgresTaskRepository(executor).create({ title: 'Task', description: null }))
      .rejects.toMatchObject({ category: 'internal', code: 'TASK_REPOSITORY_RESULT_INVALID' });
    expect(query).toHaveBeenCalledOnce();
  });
});


describe('normalization of previously classified failures', () => {
  it.each([
    ['invalid runtime category', new PostgresOperationError('invalid' as 'internal', 'ECONNRESET'), 'internal', undefined],
    ['sensitive databaseCode', new PostgresOperationError('unavailable', 'PRIVATE SQL password'), 'internal', undefined],
    ['approved code', new PostgresOperationError('unavailable', 'ECONNRESET'), 'unavailable', 'ECONNRESET'],
    ['authentication', new PostgresOperationError('unavailable', '28P01'), 'internal', '28P01'],
    ['invalid SQLSTATE suffix', new PostgresOperationError('unavailable', '08P01\n'), 'internal', undefined],
    ['unbranded unavailable instance', new PostgresOperationError('unavailable', undefined), 'internal', undefined],
    ['forged string marker', { code: 'ACQUISITION_TIMEOUT', category: 'unavailable' }, 'internal', undefined],
    ['forged error name', { name: 'PostgresAcquisitionTimeoutError', message: 'timeout' }, 'internal', undefined],
  ])('normalizes %s without retaining raw metadata', async (_name, error, category, code) => {
    Object.assign(error as object, { cause: new Error('PRIVATE cause') });
    const normalized = classifyPostgresFailure(error);
    expect(normalized).not.toBe(error);
    expect(normalized).toMatchObject({ category, databaseCode: code });
    expect(normalized.cause).toBeUndefined();
    expect(String(normalized) + normalized.stack + JSON.stringify(normalized)).not.toContain('PRIVATE');
    query.mockRejectedValue(error);
    const failure = await new PostgresTaskRepository(executor)
      .create({ title: 'Task', description: null }).catch((caught: unknown) => caught);
    expect(failure).toMatchObject({ category, databaseCode: code });
    expect(String(failure) + JSON.stringify(failure)).not.toContain('PRIVATE');
    expect(query).toHaveBeenCalledOnce();
  });

  it('preserves legitimate timeout identity across repeated reconstruction', async () => {
    const original = createPostgresAcquisitionTimeoutError();
    const first = classifyPostgresFailure(original);
    const second = classifyPostgresFailure(first);
    expect(first).not.toBe(original);
    expect(second).not.toBe(first);
    expect(second).toMatchObject({ category: 'unavailable', databaseCode: undefined });
    query.mockRejectedValue(second);
    await expect(new PostgresTaskRepository(executor).create({ title: 'Task', description: null }))
      .rejects.toMatchObject({ category: 'unavailable', databaseCode: undefined });
    expect(query).toHaveBeenCalledOnce();
  });

  it.each(['category', 'databaseCode'])('does not invoke a classified error %s getter', (field) => {
    const error = new PostgresOperationError('unavailable', 'ECONNRESET');
    const getter = vi.fn(() => { throw new Error('PRIVATE getter'); });
    Object.defineProperty(error, field, { get: getter });
    expect(classifyPostgresFailure(error)).toMatchObject({ category: 'internal', databaseCode: undefined });
    expect(getter).not.toHaveBeenCalled();
  });
});
