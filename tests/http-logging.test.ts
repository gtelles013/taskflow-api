import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import type { Task, TaskRepository } from '../src/task-repository';
import { createPostgresAcquisitionTimeoutError, PostgresOperationError } from '../src/postgres-errors';
import { DatabaseUnavailableHttpError } from '../src/http-errors';
import { PostgresTaskRepository, TaskRepositoryError } from '../src/postgres-task-repository';

function memoryLog() {
  const chunks: string[] = [];
  // Only a destination is injected: no serializers, bindings, redaction or transports.
  const stream = { write: vi.fn((chunk: string) => { chunks.push(chunk); }) };
  return { stream, text: () => chunks.join(''), records: () => chunks.join('').trim().split('\n')
    .filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) };
}
function returnedTask(title = 'Example'): Task {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000', title, description: null,
    status: 'pending', createdAt: new Date('2026-11-19T15:30:45.123Z'),
  };
}
function repositoryMock() {
  return { create: vi.fn<TaskRepository['create']>().mockResolvedValue(returnedTask()), list: vi.fn<TaskRepository['list']>(), close: vi.fn(async () => {}) };
}
const secret = 'SENSITIVE_LOG_SENTINEL';
function expectNoSensitiveLogs(text: string) {
  expect(text).not.toContain(secret);
  expect(text).not.toContain('/tasks');
  expect(text).not.toContain('authorization');
  expect(text).not.toMatch(/"(?:req|headers|body|url|query|sql|parameters|password|stack|cause)"\s*:/);
  expect(text).not.toContain('incoming request');
  expect(text).not.toContain('request completed');
  expect(text).not.toContain('request errored');
}

describe('request logging policy with an in-memory JSON destination', () => {
  it.each(['default', 'explicitly disabled'] as const)('keeps the logger disabled when %s despite a stream', async (mode) => {
    const log = memoryLog();
    const repository = repositoryMock();
    const app = buildApp({ taskRepository: repository, loggerStream: log.stream,
      ...(mode === 'explicitly disabled' ? { logger: false } : {}) });
    const ids: string[] = [];
    app.addHook('onRequest', async (request) => {
      ids.push(request.id);
      // Test-only probes verify that a disabled logger still produces no output.
      request.log.info('test-only request probe');
    });
    try {
      app.log.info('test-only root probe');
      const response = await app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Example' } });
      expect(response.statusCode).toBe(201);
      expect(ids).toHaveLength(1);
      expect(ids[0]).toMatch(/^req-/);
      expect(log.stream.write).not.toHaveBeenCalled();
    } finally { await app.close(); }
    expect(repository.close).toHaveBeenCalledOnce();
    expect(log.records()).toEqual([]);
  });

  it('enables JSON logging to the supplied stream only when requested', async () => {
    const log = memoryLog();
    const app = buildApp({ logger: true, loggerStream: log.stream });
    try {
      app.log.info('test-only enabled probe');
      expect(log.records()).toHaveLength(1);
      expect(log.records()[0]).toMatchObject({ level: 30, msg: 'test-only enabled probe' });
      expect(app.initialConfig.requestIdHeader).toBe(false);
    } finally { await app.close(); }
  });

  it('keeps request.log correlated with generated IDs for overlapping requests', async () => {
    const log = memoryLog();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const bothStarted = new Promise<void>((resolve) => { started = resolve; });
    let count = 0;
    const repository = repositoryMock();
    repository.create.mockImplementation(async (input) => {
      count++;
      if (count === 2) started();
      await barrier;
      return returnedTask(input.title);
    });
    const app = buildApp({ taskRepository: repository, logger: true, loggerStream: log.stream });
    const observations: Array<{ id: string; probeIndex: number }> = [];
    app.addHook('onRequest', async (request) => {
      const probeIndex = observations.length;
      observations.push({ id: request.id, probeIndex });
      // Only this test hook emits probes to observe the child logger binding.
      request.log.info({ probeIndex }, 'test-only correlation probe');
    });
    const responses = Promise.all(['First', 'Second'].map((title) => app.inject({
      method: 'POST', url: '/tasks?secret=' + secret,
      headers: { 'x-request-id': secret, 'request-id': secret, authorization: 'Bearer ' + secret },
      payload: { title },
    }).then((response) => response)));
    try {
      await bothStarted;
      expect(repository.create).toHaveBeenCalledTimes(2);
      expect(observations).toHaveLength(2);
      expect(new Set(observations.map(({ id }) => id)).size).toBe(2);
      for (const { id, probeIndex } of observations) {
        expect(id).toMatch(/^req-/);
        expect(id).not.toBe(secret);
        expect(log.records().find((record) => record.probeIndex === probeIndex))
          .toMatchObject({ reqId: id, msg: 'test-only correlation probe' });
      }
      release();
      expect((await responses).map((response) => response.statusCode)).toEqual([201, 201]);
      expect(log.records()).toHaveLength(2); // Only explicit test probes, no automatic lines.
      expectNoSensitiveLogs(log.text());
    } finally {
      release();
      try { await responses; } finally { await app.close(); }
    }
    expect(repository.close).toHaveBeenCalledOnce();
  });

  it.each([
    { name: '201 success', body: { title: '  Example  ', description: secret }, status: 201 },
    { name: '400 validation', body: { title: secret, forbidden: secret }, status: 400 },
  ])('does not automatically log sensitive request data for $name', async ({ body, status }) => {
    const log = memoryLog();
    const repository = repositoryMock();
    const app = buildApp({ taskRepository: repository, logger: true, loggerStream: log.stream });
    try {
      const response = await app.inject({ method: 'POST', url: '/tasks?token=' + secret,
        headers: { authorization: 'Bearer ' + secret, 'x-sensitive': secret }, payload: body });
      expect(response.statusCode).toBe(status);
      if (status === 201) {
        expect(response.json()).toEqual({ ...returnedTask(), createdAt: '2026-11-19T15:30:45.123Z' });
        expect(repository.create).toHaveBeenCalledExactlyOnceWith({ title: 'Example', description: secret });
      } else {
        expect(response.json()).toEqual({ error: { code: 'VALIDATION_ERROR', message: 'Invalid task input',
          details: [{ field: 'body', message: 'Invalid request body' }] } });
        expect(repository.create).not.toHaveBeenCalled();
      }
      expectNoSensitiveLogs(log.text());
      if (status === 400) expectDiagnostic(log, 400, 'VALIDATION_ERROR');
      else expect(log.records()).toEqual([]);
    } finally { await app.close(); }
    expect(repository.close).toHaveBeenCalledOnce();
    expect(log.stream.write).toHaveBeenCalledTimes(status === 400 ? 1 : 0);
  });

  it.each([
    { code: 'ECONNREFUSED', status: 503, publicCode: 'DATABASE_UNAVAILABLE', message: 'Database unavailable' },
    { code: '08006', status: 503, publicCode: 'DATABASE_UNAVAILABLE', message: 'Database unavailable' },
    { code: '28P01', status: 500, publicCode: 'INTERNAL_ERROR', message: 'Internal server error' },
    { code: undefined, status: 500, publicCode: 'INTERNAL_ERROR', message: 'Internal server error' },
  ])('preserves sanitized $status without automatic raw error logs for $code', async ({ code, status, publicCode, message }) => {
    const log = memoryLog();
    const query = vi.fn().mockRejectedValue(Object.assign(new Error(secret), {
      code, stack: secret, cause: new Error(secret), sql: secret, password: secret,
    }));
    const repository = new PostgresTaskRepository({ query });
    const app = buildApp({ taskRepository: repository, logger: true, loggerStream: log.stream });
    try {
      const response = await app.inject({ method: 'POST', url: '/tasks?token=' + secret,
        headers: { authorization: 'Bearer ' + secret }, payload: { title: secret } });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({ error: { code: publicCode, message } });
      expect(response.body).not.toContain(secret);
      expect(query).toHaveBeenCalledOnce();
      expectNoSensitiveLogs(log.text());
      expectDiagnostic(log, status, publicCode, status === 503 ? code : undefined);
    } finally { await app.close(); }
    expect(log.stream.write).toHaveBeenCalledOnce();
  });

  it('suppresses malformed JSON and not-found automatic logs with sensitive URLs', async () => {
    const log = memoryLog();
    const repository = repositoryMock();
    const app = buildApp({ taskRepository: repository, logger: true, loggerStream: log.stream });
    try {
      const invalid = await app.inject({ method: 'POST', url: '/tasks?token=' + secret,
        headers: { 'content-type': 'application/json' }, payload: '{"title":"' + secret + '",' });
      expect(invalid.statusCode).toBe(400);
      const missing = await app.inject({ method: 'GET', url: '/missing/' + secret + '?token=' + secret });
      expect(missing.statusCode).toBe(404);
      expect(repository.create).not.toHaveBeenCalled();
      expectDiagnostic(log, 400, 'VALIDATION_ERROR');
      expectNoSensitiveLogs(log.text());
    } finally { await app.close(); }
    expect(repository.close).toHaveBeenCalledOnce();
  });
});


function expectDiagnostic(log: ReturnType<typeof memoryLog>, statusCode: number, category: string, databaseCode?: string) {
  const records = log.records();
  expect(records).toHaveLength(1);
  const record = records[0]!;
  expect(record).toMatchObject({ statusCode, category, level: statusCode === 400 ? 40 : 50, msg: 'HTTP request failed' });
  expect(record.reqId).toMatch(/^req-/);
  expect(Object.keys(record).sort()).toEqual([
    'category', 'hostname', 'level', 'msg', 'pid', 'reqId', 'statusCode', 'time',
    ...(databaseCode === undefined ? [] : ['databaseCode']),
  ].sort());
  if (databaseCode !== undefined) expect(record.databaseCode).toBe(databaseCode);
  else expect(Object.hasOwn(record, 'databaseCode')).toBe(false);
  // Parsing JSON alone could conceal duplicate keys; inspect the raw line as well.
  expect(log.text().match(/"reqId":/g)).toHaveLength(1);
  expectNoSensitiveLogs(log.text());
}

describe('central controlled HTTP failure diagnostics', () => {
  it.each([
    { statusCode: 503, code: 'ECONNREFUSED', databaseCode: 'ECONNRESET', category: 'unavailable', message: secret },
    new TaskRepositoryError('TASK_REPOSITORY_QUERY_FAILED', 'ECONNRESET', 'unavailable'),
    new PostgresOperationError('unavailable', 'ECONNRESET'),
    new DatabaseUnavailableHttpError(),
    new Error('connection timeout ' + secret),
  ])('does not trust forged mock failure %# for status or diagnostic code', async (error) => {
    const log = memoryLog();
    const repository = repositoryMock();
    repository.create.mockRejectedValue(error);
    const app = buildApp({ taskRepository: repository, logger: true, loggerStream: log.stream });
    try {
      const response = await app.inject({ method: 'POST', url: '/tasks?token=' + secret, payload: { title: secret } });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
      expectDiagnostic(log, 500, 'INTERNAL_ERROR');
      expect(repository.create).toHaveBeenCalledExactlyOnceWith({ title: secret, description: null });
    } finally { await app.close(); }
  });

  it('emits a single 503 diagnostic without code for a controlled timeout', async () => {
    const log = memoryLog();
    const query = vi.fn().mockRejectedValue(createPostgresAcquisitionTimeoutError());
    const app = buildApp({ taskRepository: new PostgresTaskRepository({ query }), logger: true, loggerStream: log.stream });
    try {
      const response = await app.inject({ method: 'POST', url: '/tasks', payload: { title: secret } });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: { code: 'DATABASE_UNAVAILABLE', message: 'Database unavailable' } });
      expectDiagnostic(log, 503, 'DATABASE_UNAVAILABLE');
      expect(query).toHaveBeenCalledOnce();
    } finally { await app.close(); }
  });

  it('does not inherit diagnostic metadata when a registered error is cloned', async () => {
    const query = vi.fn().mockRejectedValue({ code: 'ECONNREFUSED' });
    const original = await new PostgresTaskRepository({ query }).create({ title: secret, description: null })
      .catch((error: unknown) => error);
    const clone = Object.assign(Object.create(TaskRepositoryError.prototype), original);
    const log = memoryLog();
    const repository = repositoryMock();
    repository.create.mockRejectedValue(clone);
    const app = buildApp({ taskRepository: repository, logger: true, loggerStream: log.stream });
    try {
      const response = await app.inject({ method: 'POST', url: '/tasks', payload: { title: secret } });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
      expectDiagnostic(log, 500, 'INTERNAL_ERROR');
      expect(repository.create).toHaveBeenCalledOnce();
      expect(query).toHaveBeenCalledOnce();
    } finally { await app.close(); }
  });

  it('keeps invalid INSERT RETURNING mapping internal with one diagnostic and no retry', async () => {
    const log = memoryLog();
    const query = vi.fn().mockResolvedValue({ rows: [], code: 'ECONNREFUSED' });
    const app = buildApp({ taskRepository: new PostgresTaskRepository({ query }), logger: true, loggerStream: log.stream });
    try {
      const response = await app.inject({ method: 'POST', url: '/tasks', payload: { title: secret } });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
      expectDiagnostic(log, 500, 'INTERNAL_ERROR');
      expect(query).toHaveBeenCalledOnce();
    } finally { await app.close(); }
  });

  it.each([400, 500, 503])('preserves exact HTTP %i when the log destination throws synchronously', async (status) => {
    const write = vi.fn((_message: string) => { throw new Error('LOGGER_FAILURE ' + secret); });
    const query = vi.fn().mockRejectedValue({ code: status === 503 ? 'ECONNREFUSED' : 'UNKNOWN' });
    const app = buildApp({ taskRepository: new PostgresTaskRepository({ query }), logger: true, loggerStream: { write } });
    try {
      const response = await app.inject({ method: 'POST', url: '/tasks', payload: status === 400 ? {} : { title: secret } });
      expect(response.statusCode).toBe(status);
      const expected = status === 400
        ? { code: 'VALIDATION_ERROR', message: 'Invalid task input', details: [{ field: 'title', message: 'Invalid title' }] }
        : status === 503 ? { code: 'DATABASE_UNAVAILABLE', message: 'Database unavailable' }
        : { code: 'INTERNAL_ERROR', message: 'Internal server error' };
      expect(response.json()).toEqual({ error: expected });
      expect(response.body).not.toContain(secret);
      expect(response.body).not.toContain('LOGGER_FAILURE');
      expect(write).toHaveBeenCalledOnce(); // No fallback or logging retry.
      expect(query).toHaveBeenCalledTimes(status === 400 ? 0 : 1);
    } finally { await app.close(); }
  });

  it('keeps disabled logging silent for 400, 500 and 503 failures', async () => {
    const log = memoryLog();
    const query = vi.fn().mockRejectedValueOnce(new Error(secret)).mockRejectedValueOnce({ code: 'ECONNREFUSED' });
    const app = buildApp({ taskRepository: new PostgresTaskRepository({ query }), loggerStream: log.stream });
    try {
      const responses = [];
      for (const body of [{}, { title: secret }, { title: secret }]) {
        responses.push(await app.inject({ method: 'POST', url: '/tasks', payload: body }));
      }
      expect(responses.map((response) => response.statusCode)).toEqual([400, 500, 503]);
      expect(query).toHaveBeenCalledTimes(2);
      expect(log.stream.write).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('correlates concurrent failures with each request ID exactly once', async () => {
    const log = memoryLog();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const bothStarted = new Promise<void>((resolve) => { started = resolve; });
    let calls = 0;
    const repository = repositoryMock();
    repository.create.mockImplementation(async () => {
      calls++;
      if (calls === 2) started();
      await gate;
      throw new Error(secret);
    });
    const app = buildApp({ taskRepository: repository, logger: true, loggerStream: log.stream });
    const ids: string[] = [];
    app.addHook('onRequest', async (request) => { ids.push(request.id); });
    const responses = Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: '/tasks', payload: { title: secret } })
      .then((response) => response)));
    try {
      await bothStarted;
      expect(log.records()).toEqual([]);
      release();
      const results = await responses;
      expect(results.map((response) => response.statusCode)).toEqual([500, 500]);
      for (const response of results) {
        expect(response.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
      }
      const records = log.records();
      expect(records).toHaveLength(2);
      expect(new Set(ids).size).toBe(2);
      expect(records.map((record) => record.reqId).sort()).toEqual([...ids].sort());
      for (const record of records) {
        expect(record).toMatchObject({ level: 50, statusCode: 500, category: 'INTERNAL_ERROR', msg: 'HTTP request failed' });
        expect(Object.hasOwn(record, 'databaseCode')).toBe(false);
      }
      expect(log.text().match(/"reqId":/g)).toHaveLength(2);
      expectNoSensitiveLogs(log.text());
      expect(repository.create).toHaveBeenCalledTimes(2);
    } finally {
      release();
      try { await responses; } finally { await app.close(); }
    }
    expect(repository.close).toHaveBeenCalledOnce();
  });
});
