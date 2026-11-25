import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { startServer } from '../src/server-runtime';
import { Pool } from 'pg';

const sensitive = 'SQL_PASSWORD_STACK_CAUSE_SENTINEL';
const row = {
  id: 'e63878c0-cb1a-449c-9057-752a48c455df', title: 'Task', description: null,
  status: 'pending', created_at: new Date('2026-01-01T12:00:00.000Z'),
};
function setup() {
  const order: string[] = [];
  const client = {
    query: vi.fn(async () => ({ rows: [row] })), release: vi.fn(),
    on: vi.fn(), removeListener: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => client),
    end: vi.fn(async () => { order.push('pool'); }),
  };
  let app: ReturnType<typeof buildApp>;
  const buildApplication = vi.fn((options: Parameters<typeof buildApp>[0]) => {
    app = buildApp({ ...options, logger: false });
    vi.spyOn(app, 'listen').mockImplementation((async () => 'simulated') as typeof app.listen);
    const close = app.close.bind(app);
    vi.spyOn(app, 'close').mockImplementation((async () => { order.push('app'); await close(); }) as typeof app.close);
    return app;
  });
  const signals = new EventEmitter();
  const report = vi.fn();
  const onFailure = vi.fn();
  const createPool = vi.fn(() => pool);
  const options = { createPool, buildApplication, signals, report, onFailure, variables: {} };
  return { pool, client, order, signals, report, onFailure, createPool, buildApplication, options,
    get app() { return app; } };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('operational server composition without PostgreSQL', () => {
  it('imports runtime and entrypoint without starting a server or acquiring a client', async () => {
    vi.resetModules();
    const connect = vi.spyOn(Pool.prototype, 'connect');
    const query = vi.spyOn(Pool.prototype, 'query');
    const listen = vi.spyOn(require('node:net').Server.prototype, 'listen');
    await import('../src/server-runtime.js');
    await import('../src/server.js');
    expect(connect).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  it('injects the real repository/executor chain and registers POST /tasks lazily', async () => {
    const s = setup();
    const runtime = await startServer(s.options);
    expect(runtime).toBeDefined();
    try {
      expect(s.createPool).toHaveBeenCalledExactlyOnceWith('development', s.options.variables);
      expect(s.buildApplication).toHaveBeenCalledOnce();
      expect(s.buildApplication.mock.calls[0]?.[0]?.taskRepository).toBeDefined();
      expect(s.pool.connect).not.toHaveBeenCalled();
      const response = await runtime!.app.inject({ method: 'POST', url: '/tasks', payload: { title: ' Task ' } });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({
        id: row.id, title: 'Task', description: null, status: 'pending', createdAt: row.created_at.toISOString(),
      });
      expect(s.pool.connect).toHaveBeenCalledOnce();
      expect(s.client.query).toHaveBeenCalledOnce();
      expect(s.client.query.mock.calls[0]).toEqual([
        expect.stringMatching(/^INSERT INTO "public"\.tasks/), ['Task', null],
      ]);
      expect(s.client.release).toHaveBeenCalledOnce();
    } finally { await runtime?.shutdown(); }
    expect(s.order).toEqual(['app', 'pool']);
    expect(s.pool.end).toHaveBeenCalledOnce();
  });

  it.each([
    [{}, { host: '127.0.0.1', port: 3000 }],
    [{ HOST: 'localhost', PORT: '4567' }, { host: 'localhost', port: 4567 }],
  ])('preserves listening options %j without opening a socket', async (variables, expected) => {
    const s = setup();
    const runtime = await startServer({ ...s.options, variables });
    try { expect(s.app.listen).toHaveBeenCalledExactlyOnceWith(expected); }
    finally { await runtime?.shutdown(); }
  });

  it('cleans up after listen failure, without retry or raw error logging', async () => {
    const s = setup();
    const build = s.options.buildApplication;
    s.options.buildApplication = vi.fn((options) => {
      const app = build(options);
      vi.mocked(app.listen).mockRejectedValue(new Error(sensitive));
      return app;
    });
    expect(await startServer(s.options)).toBeUndefined();
    expect(s.app.listen).toHaveBeenCalledOnce();
    expect(s.order).toEqual(['app', 'pool']);
    expect(s.pool.end).toHaveBeenCalledOnce();
    expect(s.onFailure).toHaveBeenCalledOnce();
    expect(s.report.mock.calls).toEqual([[{ category: 'STARTUP_FAILED' }, 'Server operation failed']]);
    expect(JSON.stringify(s.report.mock.calls)).not.toContain(sensitive);
    expect(s.signals.listenerCount('SIGINT')).toBe(0);
  });

  it('closes the pool if application construction fails', async () => {
    const s = setup();
    const runtime = await startServer({ ...s.options, buildApplication: () => { throw new Error(sensitive); } });
    expect(runtime).toBeUndefined();
    expect(s.pool.end).toHaveBeenCalledOnce();
    expect(s.pool.connect).not.toHaveBeenCalled();
    expect(s.report.mock.calls).toEqual([[{ category: 'STARTUP_FAILED' }, 'Server operation failed']]);
  });

  it('shares shutdown across repeated signals while pool closure is pending', async () => {
    const s = setup();
    let finish!: () => void;
    s.pool.end.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const runtime = await startServer(s.options);
    try {
      s.signals.emit('SIGINT');
      s.signals.emit('SIGTERM');
      s.signals.emit('SIGINT');
      const first = runtime!.shutdown();
      expect(runtime!.shutdown()).toBe(first);
      await vi.waitFor(() => expect(s.pool.end).toHaveBeenCalledOnce());
      expect(s.app.close).toHaveBeenCalledOnce();
      finish();
      await first;
      expect(s.signals.listenerCount('SIGINT')).toBe(0);
      expect(s.signals.listenerCount('SIGTERM')).toBe(0);
      expect(s.pool.end).toHaveBeenCalledOnce();
    } finally { finish?.(); await runtime?.shutdown(); }
  });

  it('still attempts pool closure when application close fails', async () => {
    const s = setup();
    const runtime = await startServer(s.options);
    vi.mocked(s.app.close).mockRejectedValue(new Error(sensitive));
    try {
      await runtime!.shutdown();
      expect(s.pool.end).toHaveBeenCalledOnce();
      expect(s.report.mock.calls).toEqual([[{ category: 'SHUTDOWN_FAILED' }, 'Server operation failed']]);
      expect(s.onFailure).toHaveBeenCalledOnce();
    } finally {
      // The actual test app still needs closing after the deliberately simulated failure.
      vi.mocked(s.app.close).mockRestore();
      await s.app.close();
    }
  });

  it('does not retry a failing pool close or expose its error', async () => {
    const s = setup();
    s.pool.end.mockRejectedValue(new Error(sensitive));
    const runtime = await startServer(s.options);
    await runtime!.shutdown();
    await runtime!.shutdown();
    expect(s.pool.end).toHaveBeenCalledOnce();
    expect(s.report.mock.calls).toEqual([[{ category: 'SHUTDOWN_FAILED' }, 'Server operation failed']]);
    expect(JSON.stringify(s.report.mock.calls)).not.toContain(sensitive);
  });

  it('preserves HTTP 400 without acquiring a client', async () => {
    const s = setup();
    const runtime = await startServer(s.options);
    try {
      const response = await runtime!.app.inject({ method: 'POST', url: '/tasks', payload: {} });
      expect(response.statusCode).toBe(400);
      expect(s.pool.connect).not.toHaveBeenCalled();
    } finally { await runtime?.shutdown(); }
  });

  it.each([
    [{ code: 'ECONNREFUSED', message: sensitive }, 503, 'DATABASE_UNAVAILABLE', 'Database unavailable'],
    [new Error(sensitive), 500, 'INTERNAL_ERROR', 'Internal server error'],
  ])('preserves persistence classification without retry: %j', async (error, status, code, message) => {
    const s = setup();
    s.client.query.mockRejectedValue(error);
    const runtime = await startServer(s.options);
    try {
      const response = await runtime!.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Task' } });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({ error: { code, message } });
      expect(s.client.query).toHaveBeenCalledOnce();
      expect(s.pool.connect).toHaveBeenCalledOnce();
    } finally { await runtime?.shutdown(); }
  });

  it('handles pool construction failure with a fixed diagnostic and no retry', async () => {
    const s = setup();
    s.createPool.mockImplementation(() => { throw new Error(sensitive); });
    expect(await startServer(s.options)).toBeUndefined();
    expect(s.createPool).toHaveBeenCalledOnce();
    expect(s.buildApplication).not.toHaveBeenCalled();
    expect(s.report.mock.calls).toEqual([[{ category: 'STARTUP_FAILED' }, 'Server operation failed']]);
    expect(s.onFailure).toHaveBeenCalledOnce();
  });

  it('completes cleanup even if the operational log destination throws', async () => {
    const s = setup();
    s.pool.end.mockRejectedValue(new Error(sensitive));
    s.report.mockImplementation(() => { throw new Error(sensitive); });
    const runtime = await startServer(s.options);
    await expect(runtime!.shutdown()).resolves.toBeUndefined();
    expect(s.pool.end).toHaveBeenCalledOnce();
    expect(s.report).toHaveBeenCalledOnce();
    expect(s.onFailure).toHaveBeenCalledOnce();
    expect(s.signals.listenerCount('SIGTERM')).toBe(0);
  });
  it('never falls back to TEST_DATABASE_URL when DATABASE_URL is absent', async () => {
    const s = setup();
    const { createPool: unused, ...options } = s.options;
    expect(await startServer({ ...options, variables: { TEST_DATABASE_URL: 'synthetic-test-only' } })).toBeUndefined();
    expect(s.buildApplication).not.toHaveBeenCalled();
    expect(s.report.mock.calls).toEqual([[{ category: 'STARTUP_FAILED' }, 'Server operation failed']]);
    expect(s.onFailure).toHaveBeenCalledOnce();
  });
});
