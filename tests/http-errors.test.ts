import { DatabaseUnavailableHttpError, getDatabaseUnavailableHttpMetadata } from '../src/http-errors';
import { getPostgresUnavailableMetadata } from '../src/postgres-task-repository';
import { PostgresTaskRepository, TaskRepositoryError, isPostgresRepositoryUnavailable } from '../src/postgres-task-repository';
import { PostgresQueryExecutor } from '../src/postgres-query-executor';
import { PostgresOperationError, createPostgresAcquisitionTimeoutError } from '../src/postgres-errors';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorCodes } from 'fastify';
import { buildApp } from '../src/app';
import type { Task, TaskRepository } from '../src/task-repository';
import * as validation from '../src/task-validation';

const internalEnvelope = { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } };

function validationEnvelope(field: 'title' | 'description' | 'body') {
  const messages = { title: 'Invalid title', description: 'Invalid description', body: 'Invalid request body' };
  return {
    error: {
      code: 'VALIDATION_ERROR', message: 'Invalid task input',
      details: [{ field, message: messages[field] }],
    },
  };
}

function repositoryMock() {
  const task: Task = {
    id: '550e8400-e29b-41d4-a716-446655440000', title: 'Example', description: null,
    status: 'pending', createdAt: new Date('2026-11-19T15:30:45.123Z'),
  };
  return { create: vi.fn<TaskRepository['create']>().mockResolvedValue(task), close: vi.fn(async () => {}) };
}

function expectSanitized(body: string) {
  expect(body).not.toContain('SENSITIVE_SENTINEL');
  expect(body).not.toContain('SELECT private_data');
  expect(body).not.toContain('postgresql://');
  expect(body).not.toMatch(/"(?:stack|cause|sql|password|headers)"\s*:/);
}

afterEach(() => vi.restoreAllMocks());

describe('central HTTP error handling', () => {
  it.each([
    { name: 'missing title', body: {}, field: 'title' },
    { name: 'wrong title type', body: { title: 123 }, field: 'title' },
    { name: 'blank title', body: { title: '  ' }, field: 'title' },
    { name: 'null description', body: { title: 'Example', description: null }, field: 'description' },
    { name: 'overlong description', body: { title: 'Example', description: 'a'.repeat(501) }, field: 'description' },
    { name: 'unknown sensitive property', body: { title: 'Example', SENSITIVE_SENTINEL: 'SELECT private_data' }, field: 'body' },
    { name: 'generated properties', body: { title: 'Example', id: 'SENSITIVE_SENTINEL', status: 'pending' }, field: 'body' },
    { name: 'sensitive invalid value', body: { title: { password: 'SENSITIVE_SENTINEL' } }, field: 'title' },
  ] as const)('returns the exact controlled 400 envelope for $name', async ({ body, field }) => {
    const repository = repositoryMock();
    const app = buildApp({ taskRepository: repository });
    try {
      const response = await app.inject({ method: 'POST', url: '/tasks', payload: body });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual(validationEnvelope(field));
      expectSanitized(response.body);
      expect(repository.create).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
    expect(repository.close).toHaveBeenCalledOnce();
  });

  it.each([
    { name: 'malformed JSON', payload: '{"title":"SENSITIVE_SENTINEL",' },
    { name: 'empty JSON', payload: '' },
  ])('maps $name to the exact body-validation envelope before the handler', async ({ payload }) => {
    const validate = vi.spyOn(validation, 'validateTaskInput');
    const repository = repositoryMock();
    const app = buildApp({ taskRepository: repository });
    try {
      const response = await app.inject({
        method: 'POST', url: '/tasks', headers: { 'content-type': 'application/json' }, payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual(validationEnvelope('body'));
      expectSanitized(response.body);
      expect(validate).not.toHaveBeenCalled();
      expect(repository.create).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each([
    { name: 'absent body', request: { method: 'POST' as const, url: '/tasks' } },
    { name: 'JSON null', request: { method: 'POST' as const, url: '/tasks', headers: { 'content-type': 'application/json' }, payload: 'null' } },
  ])('returns controlled body details for $name', async ({ request }) => {
    const repository = repositoryMock();
    const app = buildApp({ taskRepository: repository });
    try {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual(validationEnvelope('body'));
      expect(repository.create).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each([
    { name: 'unexpected Error', error: new Error('SENSITIVE_SENTINEL SELECT private_data') },
    { name: 'validation-like error', error: new validation.TaskValidationError('title', 'SENSITIVE_SENTINEL') },
    { name: 'arbitrary status 400', error: Object.assign(new Error('SENSITIVE_SENTINEL'), { statusCode: 400 }) },
    { name: 'spoofed parser code', error: { code: 'FST_ERR_CTP_INVALID_JSON_BODY', statusCode: 400, message: 'SENSITIVE_SENTINEL' } },
    { name: 'actual parser error from repository', error: new errorCodes.FST_ERR_CTP_EMPTY_JSON_BODY() },
    { name: 'actual transport error from repository', error: new errorCodes.FST_ERR_CTP_BODY_TOO_LARGE() },
    { name: 'unclassified database failure', error: { code: 'ECONNREFUSED', statusCode: 503, message: 'SENSITIVE_SENTINEL' } },
    { name: 'non-Error rejection', error: 'SENSITIVE_SENTINEL' },
  ])('keeps repository $name as 500 without details or retry', async ({ error }) => {
    const repository = repositoryMock();
    repository.create.mockRejectedValueOnce(error);
    const app = buildApp({ taskRepository: repository });
    try {
      const response = await app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Example' } });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual(internalEnvelope);
      expectSanitized(response.body);
      expect(repository.create).toHaveBeenCalledExactlyOnceWith({ title: 'Example', description: null });
    } finally {
      await app.close();
    }
  });

  it('sanitizes unexpected validation failures regardless of their status or headers', async () => {
    vi.spyOn(validation, 'validateTaskInput').mockImplementationOnce(() => {
      throw Object.assign(new Error('SENSITIVE_SENTINEL'), {
        statusCode: 400, headers: { 'x-private': 'SENSITIVE_SENTINEL' },
      });
    });
    const repository = repositoryMock();
    const app = buildApp({ taskRepository: repository });
    try {
      const response = await app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Example' } });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual(internalEnvelope);
      expect(response.headers).not.toHaveProperty('x-private');
      expectSanitized(response.body);
      expect(repository.create).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('handles an async handler exception centrally without trusting arbitrary statusCode', async () => {
    const app = buildApp();
    app.get('/probe-error', async () => {
      throw Object.assign(new Error('SENSITIVE_SENTINEL'), { statusCode: 400 });
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/probe-error' });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual(internalEnvelope);
      expectSanitized(response.body);
    } finally {
      await app.close();
    }
  });

  it('preserves the framework 404 for an unregistered route', async () => {
    const repository = repositoryMock();
    const app = buildApp({ taskRepository: repository });
    try {
      const response = await app.inject({ method: 'GET', url: '/missing' });
      expect(response.statusCode).toBe(404);
      expect(repository.create).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('preserves framework 413 before validation and persistence', async () => {
    const validate = vi.spyOn(validation, 'validateTaskInput');
    const repository = repositoryMock();
    const app = buildApp({ taskRepository: repository });
    try {
      const response = await app.inject({
        method: 'POST', url: '/tasks', headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ title: 'Example', description: 'x'.repeat(1024 * 1024 + 1) }),
      });
      expect(response.statusCode).toBe(413);
      expect(response.json().code).toBe('FST_ERR_CTP_BODY_TOO_LARGE');
      expectSanitized(response.body);
      expect(validate).not.toHaveBeenCalled();
      expect(repository.create).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('preserves framework 415 without reflecting the unsupported media type', async () => {
    const validate = vi.spyOn(validation, 'validateTaskInput');
    const repository = repositoryMock();
    const app = buildApp({ taskRepository: repository });
    try {
      const response = await app.inject({
        method: 'POST', url: '/tasks', headers: { 'content-type': 'application/x-SENSITIVE_SENTINEL' },
        payload: 'SENSITIVE_SENTINEL',
      });
      expect(response.statusCode).toBe(415);
      expect(response.json().code).toBe('FST_ERR_CTP_INVALID_MEDIA_TYPE');
      expectSanitized(response.body);
      expect(validate).not.toHaveBeenCalled();
      expect(repository.create).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});


const unavailableEnvelope = { error: { code: 'DATABASE_UNAVAILABLE', message: 'Database unavailable' } };
const sensitiveInput = { title: 'SENSITIVE_SENTINEL', description: 'PARAM_SENTINEL' };
const expectedInsert = 'INSERT INTO "public".tasks (title, description) VALUES ($1, $2) ' +
  'RETURNING id, title, description, status, created_at';

function assertPublicFailure(response: { statusCode: number; body: string; json(): unknown }, status: 500 | 503) {
  expect(response.statusCode).toBe(status);
  expect(response.json()).toEqual(status === 503 ? unavailableEnvelope : internalEnvelope);
  expectSanitized(response.body);
  expect(response.body).not.toContain('PARAM_SENTINEL');
  expect(response.body).not.toContain('DRIVER_STACK_SENTINEL');
}

describe('PostgreSQL persistence identity to HTTP translation without a database', () => {
  it.each([
    '08000', '08001', '08003', '08004', '08006', '08007', '08P01',
    '57P01', '57P02', '57P03', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT',
  ])('returns exact 503 for driver code %s through the real repository', async (code) => {
    const error = Object.assign(new Error('SENSITIVE_SENTINEL SELECT private_data'), {
      code, sql: 'SELECT private_data', parameters: ['PARAM_SENTINEL'], password: 'SENSITIVE_SENTINEL',
      stack: 'DRIVER_STACK_SENTINEL', cause: new Error('SENSITIVE_SENTINEL'),
    });
    const query = vi.fn().mockRejectedValue(error);
    const repository = new PostgresTaskRepository({ query });
    const create = vi.spyOn(repository, 'create');
    const app = buildApp({ taskRepository: repository });
    const transported = captureUnavailableMetadata(app);
    try {
      const response = await app.inject({ method: 'POST', url: '/tasks', payload: sensitiveInput });
      assertPublicFailure(response, 503);
      expect(transported).toEqual([{ databaseCode: code }]);
      expect(create).toHaveBeenCalledExactlyOnceWith(sensitiveInput);
      expect(query).toHaveBeenCalledExactlyOnceWith(expectedInsert, ['SENSITIVE_SENTINEL', 'PARAM_SENTINEL']);
    } finally { await app.close(); }
  });

  it.each([
    { name: 'unknown INSERT failure', error: new Error('SENSITIVE_SENTINEL connection timeout') },
    { name: 'unknown code', error: { code: 'UNKNOWN', message: 'SENSITIVE_SENTINEL' } },
    { name: 'authentication', error: { code: '28P01' } },
    { name: 'authorization', error: { code: '28000' } },
    { name: 'permission', error: { code: '42501' } },
    { name: 'check constraint', error: { code: '23514' } },
    { name: 'not-null constraint', error: { code: '23502' } },
    { name: 'unique constraint', error: { code: '23505' } },
    { name: 'statement cancellation', error: { code: '57014' } },
    { name: 'programming error', error: { code: '42601' } },
  ])('returns exact 500 for $name through the real repository', async ({ error }) => {
    const query = vi.fn().mockRejectedValue(error);
    const repository = new PostgresTaskRepository({ query });
    const create = vi.spyOn(repository, 'create');
    const app = buildApp({ taskRepository: repository });
    const transported = captureUnavailableMetadata(app);
    try {
      const response = await app.inject({ method: 'POST', url: '/tasks', payload: sensitiveInput });
      assertPublicFailure(response, 500);
      expect(transported).toEqual([undefined]);
      expect(create).toHaveBeenCalledExactlyOnceWith(sensitiveInput);
      expect(query).toHaveBeenCalledExactlyOnceWith(expectedInsert, ['SENSITIVE_SENTINEL', 'PARAM_SENTINEL']);
    } finally { await app.close(); }
  });

  it.each([
    { rows: [] },
    { rows: [{ id: 'bad', category: 'unavailable', code: 'ECONNRESET' }] },
  ])('keeps invalid RETURNING result %# as 500 after one INSERT', async (result) => {
    const query = vi.fn().mockResolvedValue(result);
    const app = buildApp({ taskRepository: new PostgresTaskRepository({ query }) });
    const transported = captureUnavailableMetadata(app);
    try {
      assertPublicFailure(await app.inject({ method: 'POST', url: '/tasks', payload: sensitiveInput }), 500);
      expect(transported).toEqual([undefined]);
      expect(query).toHaveBeenCalledExactlyOnceWith(expectedInsert, ['SENSITIVE_SENTINEL', 'PARAM_SENTINEL']);
    } finally { await app.close(); }
  });

  it.each([
    ['status only', { statusCode: 503, message: 'SENSITIVE_SENTINEL' }],
    ['transport code', { code: 'ECONNREFUSED' }],
    ['databaseCode', { databaseCode: 'ECONNREFUSED' }],
    ['category', { category: 'unavailable' }],
    ['all properties', { statusCode: 503, code: 'ECONNREFUSED', databaseCode: '08006', category: 'unavailable' }],
    ['timeout message', new Error('SENSITIVE_SENTINEL connection timeout')],
    ['forged repository instance', new TaskRepositoryError('TASK_REPOSITORY_QUERY_FAILED', 'ECONNRESET', 'unavailable')],
    ['malformed repository prototype', Object.create(TaskRepositoryError.prototype)],
    ['operation instance', new PostgresOperationError('unavailable', 'ECONNRESET')],
    ['timeout instance outside persistence', createPostgresAcquisitionTimeoutError()],
  ])('keeps raw mock failure %s as exact 500', async (_name, error) => {
    const repository = repositoryMock();
    repository.create.mockRejectedValue(error);
    const app = buildApp({ taskRepository: repository });
    const transported = captureUnavailableMetadata(app);
    try {
      assertPublicFailure(await app.inject({ method: 'POST', url: '/tasks', payload: sensitiveInput }), 500);
      expect(transported).toEqual([undefined]);
      expect(repository.create).toHaveBeenCalledExactlyOnceWith(sensitiveInput);
      expect(isPostgresRepositoryUnavailable(error)).toBe(false);
    } finally { await app.close(); }
  });

  it('does not grant identity to a clone of a registered persistence failure', async () => {
    const query = vi.fn().mockRejectedValue({ code: 'ECONNRESET' });
    const original = await new PostgresTaskRepository({ query }).create(sensitiveInput).catch((error: unknown) => error);
    expect(isPostgresRepositoryUnavailable(original)).toBe(true);
    const clone = Object.assign(Object.create(TaskRepositoryError.prototype), original);
    expect(isPostgresRepositoryUnavailable(clone)).toBe(false);
    const repository = repositoryMock();
    repository.create.mockRejectedValue(clone);
    const app = buildApp({ taskRepository: repository });
    const transported = captureUnavailableMetadata(app);
    try {
      assertPublicFailure(await app.inject({ method: 'POST', url: '/tasks', payload: sensitiveInput }), 500);
      expect(transported).toEqual([undefined]);
      expect(repository.create).toHaveBeenCalledOnce();
      expect(query).toHaveBeenCalledOnce();
    } finally { await app.close(); }
  });

  it('does not translate a registered error thrown later during response mapping to 503', async () => {
    const query = vi.fn().mockRejectedValue({ code: 'ECONNRESET' });
    const original = await new PostgresTaskRepository({ query }).create(sensitiveInput).catch((error: unknown) => error);
    expect(isPostgresRepositoryUnavailable(original)).toBe(true);
    const repository = repositoryMock();
    const date = Object.assign(new Date(), { toISOString: () => { throw original; } });
    repository.create.mockResolvedValue({
      id: '550e8400-e29b-41d4-a716-446655440000', title: 'Example', description: null,
      status: 'pending', createdAt: date,
    });
    const app = buildApp({ taskRepository: repository });
    const transported = captureUnavailableMetadata(app);
    try {
      assertPublicFailure(await app.inject({ method: 'POST', url: '/tasks', payload: sensitiveInput }), 500);
      expect(transported).toEqual([undefined]);
      expect(repository.create).toHaveBeenCalledExactlyOnceWith(sensitiveInput);
    } finally { await app.close(); }
  });

  it('returns exact 503 for a controlled acquisition timeout through executor and repository', async () => {
    let started!: () => void;
    const acquisitionStarted = new Promise<void>((resolve) => { started = resolve; });
    let rejectAcquisition!: (error: unknown) => void;
    const acquisition = new Promise<never>((_resolve, reject) => { rejectAcquisition = reject; });
    const connect = vi.fn(() => { started(); return acquisition; });
    const executor = new PostgresQueryExecutor({ connect });
    const query = vi.spyOn(executor, 'query');
    const repository = new PostgresTaskRepository(executor);
    const create = vi.spyOn(repository, 'create');
    const app = buildApp({ taskRepository: repository });
    const transported = captureUnavailableMetadata(app);
    await app.ready();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const pendingResponse = app.inject({ method: 'POST', url: '/tasks', payload: sensitiveInput })
        .then((response) => response);
      await acquisitionStarted;
      await vi.advanceTimersByTimeAsync(2500);
      assertPublicFailure(await pendingResponse, 503);
      expect(transported).toEqual([{}]);
      expect(connect).toHaveBeenCalledOnce();
      expect(query).toHaveBeenCalledExactlyOnceWith(expectedInsert, ['SENSITIVE_SENTINEL', 'PARAM_SENTINEL']);
      expect(create).toHaveBeenCalledExactlyOnceWith(sensitiveInput);
    } finally {
      rejectAcquisition(new Error('SENSITIVE_SENTINEL late acquisition'));
      await Promise.resolve();
      vi.useRealTimers();
      await app.close();
    }
  });
});


// A test-only observer: captures controlled metadata without emitting any logs.
function captureUnavailableMetadata(app: ReturnType<typeof buildApp>) {
  const snapshots: Array<ReturnType<typeof getDatabaseUnavailableHttpMetadata>> = [];
  app.addHook('onError', async (_request, _reply, error) => {
    snapshots.push(getDatabaseUnavailableHttpMetadata(error));
  });
  return snapshots;
}

describe('private unavailability metadata snapshots', () => {
  it.each(['ECONNREFUSED', '08006', '57P03', undefined])(
    'transports only sanitized code %s despite later mutation or getters on the source', async (code) => {
      const driverFailure = code === undefined ? createPostgresAcquisitionTimeoutError()
        : Object.assign(new Error('SENSITIVE_SENTINEL'), { code, sql: 'SENSITIVE_SENTINEL', cause: new Error('SENSITIVE_SENTINEL') });
      const query = vi.fn().mockRejectedValue(driverFailure);
      const original = await new PostgresTaskRepository({ query }).create(sensitiveInput)
        .catch((error: unknown) => error);
      expect(isPostgresRepositoryUnavailable(original)).toBe(true);
      const getter = vi.fn(() => { throw new Error('SENSITIVE_SENTINEL'); });
      for (const key of ['code', 'databaseCode', 'category', 'message', 'cause', 'stack']) {
        Object.defineProperty(original as object, key, { configurable: true, get: getter });
      }
      const httpError = new DatabaseUnavailableHttpError(original);
      const expected = code === undefined ? {} : { databaseCode: code };
      expect(getPostgresUnavailableMetadata(original)).toEqual(expected);
      expect(getDatabaseUnavailableHttpMetadata(httpError)).toEqual(expected);
      expect(Object.isFrozen(getDatabaseUnavailableHttpMetadata(httpError))).toBe(true);
      expect(getDatabaseUnavailableHttpMetadata({ ...httpError })).toBeUndefined();
      expect(getDatabaseUnavailableHttpMetadata(Object.assign(Object.create(DatabaseUnavailableHttpError.prototype), httpError)))
        .toBeUndefined();
      expect(JSON.stringify(getDatabaseUnavailableHttpMetadata(httpError))).not.toContain('SENSITIVE_SENTINEL');
      expect(httpError.cause).toBeUndefined();
      expect(Object.hasOwn(httpError, 'databaseCode')).toBe(false);
      expect(getter).not.toHaveBeenCalled();
      expect(query).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { databaseCode: 'ECONNREFUSED', category: 'unavailable' },
    new TaskRepositoryError('TASK_REPOSITORY_QUERY_FAILED', 'ECONNREFUSED', 'unavailable'),
    new PostgresOperationError('unavailable', 'ECONNREFUSED'),
    createPostgresAcquisitionTimeoutError(),
    Object.defineProperty({}, 'databaseCode', { get: () => { throw new Error('SENSITIVE_SENTINEL'); } }),
    null,
  ])('does not create trusted HTTP metadata from forged or unrelated source %#', (source) => {
    expect(getPostgresUnavailableMetadata(source)).toBeUndefined();
    expect(getDatabaseUnavailableHttpMetadata(new DatabaseUnavailableHttpError(source))).toBeUndefined();
  });
});
