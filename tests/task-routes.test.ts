import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { registerTaskRoutes } from '../src/task-routes';
import { taskCreationResponseSchema } from '../src/task-response';
import type { Task, TaskRepository } from '../src/task-repository';
import * as validation from '../src/task-validation';

function returnedTask(overrides: Partial<Task> = {}): Task {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    title: 'Example',
    description: null,
    status: 'pending',
    createdAt: new Date('2026-11-19T15:30:45.123Z'),
    ...overrides,
  };
}

function mockRepository(task = returnedTask()) {
  return {
    create: vi.fn<TaskRepository['create']>().mockResolvedValue(task),
    close: vi.fn(async () => {}),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /tasks with an injected repository', () => {
  it('creates a minimal task after validating once and converting omitted description to null', async () => {
    const validate = vi.spyOn(validation, 'validateTaskInput');
    const repository = mockRepository();
    const app = buildApp({ taskRepository: repository });
    try {
      const response = await app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Example' } });
      expect(response.statusCode).toBe(201);
      expect(response.headers['content-type']).toContain('application/json');
      const body = response.json();
      expect(Object.keys(body).sort()).toEqual(['createdAt', 'description', 'id', 'status', 'title']);
      expect(typeof body.id).toBe('string');
      expect(body.id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
      expect(typeof body.title).toBe('string');
      expect(body.description).toBeNull();
      expect(body.status).toBe('pending');
      expect(typeof body.createdAt).toBe('string');
      expect(body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(response.json()).toEqual({
        id: '550e8400-e29b-41d4-a716-446655440000',
        title: 'Example',
        description: null,
        status: 'pending',
        createdAt: '2026-11-19T15:30:45.123Z',
      });
      expect(validate).toHaveBeenCalledExactlyOnceWith({ title: 'Example' });
      expect(repository.create).toHaveBeenCalledExactlyOnceWith({ title: 'Example', description: null });
      expect(app.server.listening).toBe(false);
    } finally {
      await app.close();
    }
    expect(repository.close).toHaveBeenCalledOnce();
  });

  it('normalizes the title and preserves description spaces for complete creation', async () => {
    const task = returnedTask({ title: 'Complete', description: '  Keep these spaces  ' });
    const repository = mockRepository(task);
    const app = buildApp({ taskRepository: repository });
    try {
      const response = await app.inject({
        method: 'POST', url: '/tasks',
        payload: { title: '  Complete  ', description: '  Keep these spaces  ' },
      });
      expect(response.statusCode).toBe(201);
      expect(repository.create).toHaveBeenCalledExactlyOnceWith({
        title: 'Complete', description: '  Keep these spaces  ',
      });
      expect(response.json()).toEqual({ ...task, createdAt: task.createdAt.toISOString() });
    } finally {
      await app.close();
    }
  });

  it('builds all five response fields from the repository result, serializing its Date in UTC', async () => {
    const task = returnedTask({
      id: '123e4567-e89b-42d3-a456-426614174000',
      title: 'Repository result',
      description: 'Returned description',
      createdAt: new Date('2020-01-02T03:04:05.678+03:00'),
    });
    const repository = mockRepository(task);
    const app = buildApp({ taskRepository: repository });
    try {
      const response = await app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Input' } });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({
        id: task.id,
        title: 'Repository result',
        description: 'Returned description',
        status: task.status,
        createdAt: '2020-01-02T00:04:05.678Z',
      });
      expect(Date.parse(response.json().createdAt)).toBe(task.createdAt.getTime());
      expect(repository.create).toHaveBeenCalledExactlyOnceWith({ title: 'Input', description: null });
    } finally {
      await app.close();
    }
  });

  it('associates the creation response schema exclusively with status 201', async () => {
    const app = Fastify();
    let responseSchemas: unknown;
    app.addHook('onRoute', (options) => {
      if (options.method === 'POST' && options.url === '/tasks') {
        responseSchemas = options.schema?.response;
      }
    });
    try {
      registerTaskRoutes(app, mockRepository());
      await app.ready();
      expect(responseSchemas).toEqual({ 201: taskCreationResponseSchema });
      expect(taskCreationResponseSchema).toEqual({
        type: 'object',
        required: ['id', 'title', 'description', 'status', 'createdAt'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', format: 'uuid' },
          title: { type: 'string' },
          description: { type: ['string', 'null'] },
          status: { type: 'string', enum: ['pending'] },
          createdAt: { type: 'string', format: 'date-time' },
        },
      });
    } finally {
      await app.close();
    }
  });

  it('preserves an empty description as a string in the response', async () => {
    const task = returnedTask({ description: '' });
    const repository = mockRepository(task);
    const app = buildApp({ taskRepository: repository });
    try {
      const response = await app.inject({
        method: 'POST', url: '/tasks', payload: { title: 'Example', description: '' },
      });
      expect(response.statusCode).toBe(201);
      expect(repository.create).toHaveBeenCalledExactlyOnceWith({ title: 'Example', description: '' });
      expect(response.json()).toEqual({ ...task, createdAt: task.createdAt.toISOString() });
      expect(typeof response.json().description).toBe('string');
    } finally {
      await app.close();
    }
  });

  it('omits repository-only properties without modifying the returned object', async () => {
    const task = Object.freeze({ ...returnedTask(), internalNote: 'Repository-only metadata' });
    const original = { ...task };
    const originalDate = task.createdAt;
    const repository = mockRepository(task);
    const app = buildApp({ taskRepository: repository });
    try {
      const response = await app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Example' } });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({
        id: task.id,
        title: task.title,
        description: task.description,
        status: task.status,
        createdAt: task.createdAt.toISOString(),
      });
      expect(response.json()).not.toHaveProperty('internalNote');
      expect(response.body).not.toContain(task.internalNote);
      expect(task).toEqual(original);
      expect(task.createdAt).toBe(originalDate);
      expect(task.createdAt.getTime()).toBe(Date.parse('2026-11-19T15:30:45.123Z'));
      expect(task.internalNote).toBe('Repository-only metadata');
    } finally {
      await app.close();
    }
  });

  it('does not finish the HTTP response until create confirms persistence', async () => {
    const task = returnedTask();
    let complete!: (task: Task) => void;
    const pendingCreation = new Promise<Task>((resolve) => { complete = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const repository = mockRepository();
    repository.create.mockImplementation(() => {
      markStarted();
      return pendingCreation;
    });
    const app = buildApp({ taskRepository: repository });
    let finished = false;
    const responsePromise = app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Example' } })
      .then((response) => { finished = true; return response; });
    try {
      await started;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(finished).toBe(false);
      expect(repository.create).toHaveBeenCalledOnce();
      complete(task);
      const response = await responsePromise;
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ ...task, createdAt: task.createdAt.toISOString() });
    } finally {
      complete(task);
      try {
        await responsePromise;
      } finally {
        await app.close();
      }
    }
  });

  it('returns 400 before persistence for invalid input', async () => {
    const repository = mockRepository();
    const app = buildApp({ taskRepository: repository });
    try {
      const response = await app.inject({ method: 'POST', url: '/tasks', payload: { title: '   ' } });
      expect(response.statusCode).toBe(400);
      expect(repository.create).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('sanitizes an unexpected validator exception without attempting persistence', async () => {
    const internalError = new Error('Private validator diagnostic');
    const validate = vi.spyOn(validation, 'validateTaskInput').mockImplementationOnce(() => {
      throw internalError;
    });
    const repository = mockRepository();
    const app = buildApp({ taskRepository: repository });
    try {
      const response = await app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Example' } });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ message: 'Internal server error' });
      expect(response.body).not.toContain(internalError.message);
      expect(response.body).not.toContain('stack');
      expect(validate).toHaveBeenCalledExactlyOnceWith({ title: 'Example' });
      expect(repository.create).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
    expect(repository.close).toHaveBeenCalledOnce();
  });

  it.each([
    new Error('Private driver diagnostic'),
    new validation.TaskValidationError('title', 'Private repository diagnostic'),
  ])('sanitizes repository rejection without retry, including validation-like errors: %s', async (error) => {
    const repository = mockRepository();
    repository.create.mockRejectedValue(error);
    const app = buildApp({ taskRepository: repository });
    try {
      const response = await app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Example' } });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ message: 'Internal server error' });
      expect(response.body).not.toContain(error.message);
      expect(response.body).not.toContain('stack');
      expect(repository.create).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
    expect(repository.close).toHaveBeenCalledOnce();
  });

  it('keeps the route unregistered without a repository until production composition is implemented', async () => {
    const app = buildApp();
    try {
      const response = await app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Example' } });
      expect(response.statusCode).toBe(404);
      expect(app.hasRoute({ method: 'POST', url: '/tasks' })).toBe(false);
      expect(app.taskRepository).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('keeps HTTP requests and shutdown isolated between instances', async () => {
    const firstTask = returnedTask({ title: 'First' });
    const secondTask = returnedTask({
      id: '123e4567-e89b-42d3-a456-426614174000', title: 'Second',
    });
    const firstRepository = mockRepository(firstTask);
    const secondRepository = mockRepository(secondTask);
    const first = buildApp({ taskRepository: firstRepository });
    const second = buildApp({ taskRepository: secondRepository });
    try {
      const [firstResponse, secondResponse] = await Promise.all([
        first.inject({ method: 'POST', url: '/tasks', payload: { title: 'First' } }),
        second.inject({ method: 'POST', url: '/tasks', payload: { title: 'Second' } }),
      ]);
      expect(firstResponse.statusCode).toBe(201);
      expect(secondResponse.statusCode).toBe(201);
      expect(firstResponse.json().id).toBe(firstTask.id);
      expect(secondResponse.json().id).toBe(secondTask.id);
      expect(firstRepository.create).toHaveBeenCalledExactlyOnceWith({ title: 'First', description: null });
      expect(secondRepository.create).toHaveBeenCalledExactlyOnceWith({ title: 'Second', description: null });
      expect(first.server.listening).toBe(false);
      expect(second.server.listening).toBe(false);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
    expect(firstRepository.close).toHaveBeenCalledOnce();
    expect(secondRepository.close).toHaveBeenCalledOnce();
  });
});
