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
