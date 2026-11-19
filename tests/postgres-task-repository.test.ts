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
