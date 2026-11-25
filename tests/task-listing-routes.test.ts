import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { PostgresTaskRepository, TaskRepositoryError } from '../src/postgres-task-repository';
import type { Task, TaskListResult, TaskRepository } from '../src/task-repository';

const task: Task = {
  id: 'e63878c0-cb1a-449c-9057-752a48c455df',
  title: 'Task',
  description: null,
  status: 'pending',
  createdAt: new Date('2026-01-01T13:00:00.123+01:00'),
};
const publicTask = { ...task, createdAt: '2026-01-01T12:00:00.123Z' };

function repositoryFixture() {
  return {
    create: vi.fn<TaskRepository['create']>().mockResolvedValue(task),
    list: vi.fn<TaskRepository['list']>().mockResolvedValue({ items: [], hasMore: false }),
  };
}

const invalidQuery = {
  error: {
    code: 'VALIDATION_ERROR',
    message: 'Invalid task query',
    details: [{ field: 'query', message: 'Invalid query parameters' }],
  },
};

describe('GET /tasks in memory', () => {
  it.each([
    ['', 50, 0], ['?', 50, 0], ['?limit=2', 2, 0], ['?offset=3', 50, 3],
    ['?limit=1&offset=0', 1, 0], ['?limit=100&offset=100000', 100, 100000],
    ['?l%69mit=%35%30', 50, 0],
  ])('accepts %s and returns an exact empty envelope', async (suffix, limit, offset) => {
    const repository = repositoryFixture();
    const app = buildApp({ taskRepository: repository });
    try {
      const response = await app.inject({ method: 'GET', url: '/tasks' + suffix });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ items: [], nextOffset: null, truncated: false });
      expect(repository.list).toHaveBeenCalledExactlyOnceWith({ limit, offset });
    } finally { await app.close(); }
  });

  it.each([
    [2, 0, 2, true, 2, false], [2, 0, 2, false, null, false],
    [3, 4, 1, false, null, false], [3, 9, 0, false, null, false],
    [50, 99950, 50, true, 100000, false], [2, 99999, 2, true, null, true],
    [2, 100000, 2, true, null, true], [2, 100000, 2, false, null, false],
    [2, 100000, 0, false, null, false],
  ])('paginates limit %i at offset %i with %i items and hasMore=%s',
    async (limit, offset, count, hasMore, nextOffset, truncated) => {
      const repository = repositoryFixture();
      repository.list.mockResolvedValue({ items: Array.from({ length: count }, () => task), hasMore });
      const app = buildApp({ taskRepository: repository });
      try {
        const response = await app.inject({ method: 'GET', url: '/tasks?limit=' + limit + '&offset=' + offset });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          items: Array.from({ length: count }, () => publicTask), nextOffset, truncated,
        });
        expect(repository.list).toHaveBeenCalledExactlyOnceWith({ limit, offset });
      } finally { await app.close(); }
    });

  it('preserves public fields and coexists with successful and invalid POST', async () => {
    const repository = repositoryFixture();
    const items = [null, '', '  spaces  '].map((description) => ({ ...task, description, privateField: 'internal' }));
    repository.list.mockResolvedValue({ items, hasMore: false });
    const app = buildApp({ taskRepository: repository });
    try {
      const listed = await app.inject({ method: 'GET', url: '/tasks' });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toEqual({
        items: items.map(({ description }) => ({ ...publicTask, description })),
        nextOffset: null, truncated: false,
      });
      expect(repository.create).not.toHaveBeenCalled();

      const created = await app.inject({ method: 'POST', url: '/tasks', payload: { title: ' Task ' } });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toEqual(publicTask);
      expect(repository.create).toHaveBeenCalledExactlyOnceWith({ title: 'Task', description: null });

      const invalid = await app.inject({ method: 'POST', url: '/tasks', payload: { title: '' } });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toEqual({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid task input', details: [{ field: 'title', message: 'Invalid title' }] },
      });
      expect(repository.create).toHaveBeenCalledOnce();
      expect(repository.list).toHaveBeenCalledOnce();
    } finally { await app.close(); }
  });

  it.each([
    'limit=+5', 'limit=%2B5', 'limit=1%26offset%3D0', 'limit=%2531', 'limit=%ZZ', 'limit=%FF',
    'limit=1&&offset=0', 'limit=1&l%69mit=1', '__proto__=1', 'constructor=1', 'prototype=1',
    'Limit=1', 'limit%5B%5D=1', 'limit%5Bx%5D=1', 'limit=1%0A',
    'limit=1%00', 'limit=1%0D', 'limit', 'limit=',
    'limit=101', 'offset=100001', 'sort=createdAt', 'limit=QUERY_SECRET_SENTINEL',
  ])('rejects invalid query %# before persistence with a sanitized diagnostic', async (query) => {
    const repository = repositoryFixture();
    const logs: string[] = [];
    const app = buildApp({ taskRepository: repository, logger: true, loggerStream: { write: (line) => logs.push(line) } });
    try {
      const response = await app.inject({
        method: 'GET', url: '/tasks?' + query, headers: { 'request-id': 'UNTRUSTED_REQ_ID' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual(invalidQuery);
      expect(repository.list).not.toHaveBeenCalled();
      expect(repository.create).not.toHaveBeenCalled();
      expect(logs.map((line) => JSON.parse(line))).toEqual([
        expect.objectContaining({ reqId: expect.any(String), category: 'VALIDATION_ERROR', statusCode: 400 }),
      ]);
      for (const marker of ['/tasks?', query, 'UNTRUSTED_REQ_ID', 'QUERY_SECRET_SENTINEL']) {
        expect(logs.join('')).not.toContain(marker);
        expect(response.body).not.toContain(marker);
      }
    } finally { await app.close(); }
  });

  it('disables automatic HEAD only for task listing', async () => {
    const repository = repositoryFixture();
    const app = buildApp({ taskRepository: repository });
    app.get('/probe', async () => ({}));
    try {
      expect((await app.inject({ method: 'HEAD', url: '/tasks' })).statusCode).toBe(404);
      expect((await app.inject({ method: 'HEAD', url: '/probe' })).statusCode).toBe(200);
      expect(repository.list).not.toHaveBeenCalled();
      expect(repository.create).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});

describe('task listing error boundary', () => {
  const secret = 'SYNTHETIC_SQL_PASSWORD_STACK';
  const unavailable = { error: { code: 'DATABASE_UNAVAILABLE', message: 'Database unavailable' } };
  const internal = { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } };

  it.each([
    ['recognized PostgreSQL failure', Object.assign(new Error(secret), { code: 'ECONNRESET' }), 503, unavailable],
    ['unexpected failure', new Error(secret), 500, internal],
  ])('sanitizes %s and executes a single query', async (_label, failure, status, expected) => {
    const query = vi.fn().mockRejectedValue(failure);
    const logs: string[] = [];
    const app = buildApp({
      taskRepository: new PostgresTaskRepository({ query }),
      logger: true, loggerStream: { write: (line) => logs.push(line) },
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/tasks?limit=2' });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual(expected);
      expect(query).toHaveBeenCalledOnce();
      expect(logs.map((line) => JSON.parse(line))).toEqual([
        expect.objectContaining({ reqId: expect.any(String), category: expected.error.code, statusCode: status }),
      ]);
      for (const marker of [secret, '/tasks?', 'SELECT', '"stack"']) {
        expect(logs.join('')).not.toContain(marker);
        expect(response.body).not.toContain(marker);
      }
    } finally { await app.close(); }
  });

  it.each([
    { name: 'empty page with more items', page: { items: [], hasMore: true } },
    { name: 'short page with more items', page: { items: [task], hasMore: true } },
    { name: 'oversized final page', page: { items: [task, task, task], hasMore: false } },
    { name: 'oversized page with more items', page: { items: [task, task, task], hasMore: true } },
    { name: 'non-array items', page: { items: { 0: task, length: 1 }, hasMore: false } },
    { name: 'non-boolean hasMore', page: { items: [task, task], hasMore: 'true' } },
    { name: 'null result', page: null },
  ])('rejects an invalid repository page ($name) without retrying', async ({ page }) => {
    const marker = 'INVALID_PAGE_SENTINEL';
    const repository = repositoryFixture();
    // Simulate an adapter returning data that violates its declared contract.
    const result: unknown = page === null ? null : { ...page, internal: marker };
    repository.list.mockResolvedValue(result as TaskListResult);
    const logs: string[] = [];
    const app = buildApp({
      taskRepository: repository,
      logger: true, loggerStream: { write: (line) => logs.push(line) },
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/tasks?limit=2' });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual(internal);
      expect(repository.list).toHaveBeenCalledExactlyOnceWith({ limit: 2, offset: 0 });
      expect(repository.create).not.toHaveBeenCalled();
      expect(logs.map((line) => JSON.parse(line))).toEqual([
        expect.objectContaining({ reqId: expect.any(String), category: 'INTERNAL_ERROR', statusCode: 500 }),
      ]);
      expect(response.body).not.toContain(marker);
      expect(logs.join('')).not.toContain(marker);
    } finally { await app.close(); }
  });

  it('returns no partial page when the probe row is invalid', async () => {
    const marker = 'INVALID_PROBE_ROW_SENTINEL';
    const query = vi.fn().mockResolvedValue({ rows: [
      { ...task, created_at: task.createdAt },
      { ...task, title: marker, created_at: null },
    ] });
    const logs: string[] = [];
    const app = buildApp({
      taskRepository: new PostgresTaskRepository({ query }),
      logger: true, loggerStream: { write: (line) => logs.push(line) },
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/tasks?limit=1' });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual(internal);
      expect(query).toHaveBeenCalledOnce();
      expect(logs.map((line) => JSON.parse(line))).toEqual([
        expect.objectContaining({ reqId: expect.any(String), category: 'INTERNAL_ERROR', statusCode: 500 }),
      ]);
      expect(response.body).not.toContain(marker);
      expect(logs.join('')).not.toContain(marker);
    } finally { await app.close(); }
  });

  it('does not trust a fabricated repository error returned by an injected adapter', async () => {
    const repository = repositoryFixture();
    repository.list.mockRejectedValue(new TaskRepositoryError('TASK_REPOSITORY_QUERY_FAILED', 'ECONNRESET', 'unavailable'));
    const app = buildApp({ taskRepository: repository });
    try {
      const response = await app.inject({ method: 'GET', url: '/tasks' });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual(internal);
      expect(repository.list).toHaveBeenCalledOnce();
    } finally { await app.close(); }
  });
});
