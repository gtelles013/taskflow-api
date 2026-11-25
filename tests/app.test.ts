import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import type { TaskRepository } from '../src/task-repository';

describe('application factory', () => {
  it('handles an injected request without opening a listening socket', async () => {
    const repository: TaskRepository = {
      create: vi.fn(),
      list: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const app = buildApp({ taskRepository: repository });
    // This route exists only in the test to exercise dependency injection.
    app.get('/probe', async (request) => ({
      injected: request.server.taskRepository === repository,
    }));

    try {
      const response = await app.inject({ method: 'GET', url: '/probe' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ injected: true });
      expect(app.server.listening).toBe(false);
      expect(repository.create).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
    expect(repository.close).toHaveBeenCalledOnce();
  });

  it('starts without a database and leaves task creation unregistered', async () => {
    const app = buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Example' },
      });
      expect(response.statusCode).toBe(404);
      expect(app.taskRepository).toBeNull();
      expect(app.server.listening).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('keeps injected repositories isolated between app instances', async () => {
    const repository: TaskRepository = { create: vi.fn(), list: vi.fn() };
    const first = buildApp({ taskRepository: repository });
    const second = buildApp();
    try {
      await Promise.all([first.ready(), second.ready()]);
      expect(first.taskRepository).toBe(repository);
      expect(second.taskRepository).toBeNull();
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });
});
