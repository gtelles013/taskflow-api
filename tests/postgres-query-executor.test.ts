import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { ACQUISITION_TIMEOUT_MILLIS, PostgresQueryExecutor } from '../src/postgres-query-executor';
import type { PostgresClientPool, PostgresQueryClient } from '../src/postgres-query-executor';
import { PostgresOperationError } from '../src/postgres-errors';
import { PostgresTaskRepository } from '../src/postgres-task-repository';

// Compile-time check only. No pg Pool or Client is constructed.
const acceptsPool = (pool: Pool) => new PostgresQueryExecutor(pool);
void acceptsPool;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function fixture() {
  const events = new EventEmitter();
  const query = vi.fn().mockResolvedValue({ rows: [] });
  const release = vi.fn();
  const client = Object.assign(events, { query, release });
  const connect = vi.fn().mockResolvedValue(client);
  const end = vi.fn();
  const pool = { connect, end };
  const executor = new PostgresQueryExecutor(pool as PostgresClientPool);
  return { client, query, release, connect, end, executor };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('PostgresQueryExecutor with fake clients only', () => {
  it('constructs lazily without connecting or closing the borrowed pool', () => {
    const f = fixture();
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.end).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('installs the deadline before connect and queries once before releasing', async () => {
    const f = fixture();
    f.connect.mockImplementation(() => {
      expect(vi.getTimerCount()).toBe(1);
      return Promise.resolve(f.client);
    });
    const values = ['Title', null];
    await expect(f.executor.query('INSERT mock', values)).resolves.toEqual({ rows: [] });
    expect(f.query).toHaveBeenCalledExactlyOnceWith('INSERT mock', values);
    expect(f.release).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(f.client.listenerCount('error')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.end).not.toHaveBeenCalled();
  });

  it('expires at 2500ms, releases a late client once and never queries it', async () => {
    const f = fixture();
    const acquisition = deferred<PostgresQueryClient>();
    f.connect.mockReturnValue(acquisition.promise);
    const outcome = f.executor.query('INSERT mock', []).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2499);
    expect(f.release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({ category: 'unavailable', databaseCode: undefined });
    acquisition.resolve(f.client as PostgresQueryClient);
    await Promise.resolve();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.query).not.toHaveBeenCalled();
    expect(f.connect).toHaveBeenCalledOnce();
    expect(f.end).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('observes a rejection after timeout without an unhandled rejection', async () => {
    const f = fixture();
    const acquisition = deferred<PostgresQueryClient>();
    f.connect.mockReturnValue(acquisition.promise);
    const outcome = f.executor.query('INSERT mock', []).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(ACQUISITION_TIMEOUT_MILLIS);
    expect(await outcome).toBeInstanceOf(PostgresOperationError);
    acquisition.reject(new Error('PRIVATE late failure'));
    await Promise.resolve();
    expect(f.query).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
  });

  it('consumes failure of late release without retry or closing the pool', async () => {
    const f = fixture();
    const acquisition = deferred<PostgresQueryClient>();
    f.connect.mockReturnValue(acquisition.promise);
    const outcome = f.executor.query('INSERT mock', []).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2500);
    await outcome;
    f.release.mockImplementation(() => { throw new Error('PRIVATE release'); });
    acquisition.resolve(f.client as PostgresQueryClient);
    await Promise.resolve();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.query).not.toHaveBeenCalled();
    expect(f.end).not.toHaveBeenCalled();
  });

  it.each([2499, 2500])('settles a boundary race at %i ms without double release', async (delay) => {
    const f = fixture();
    const acquisition = deferred<PostgresQueryClient>();
    f.connect.mockImplementation(() => {
      setTimeout(() => acquisition.resolve(f.client as PostgresQueryClient), delay);
      return acquisition.promise;
    });
    const outcome = f.executor.query('INSERT mock', []).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2500);
    const result = await outcome;
    if (delay < 2500) expect(result).toEqual({ rows: [] });
    else expect(result).toMatchObject({ category: 'unavailable' });
    expect(f.query).toHaveBeenCalledTimes(delay < 2500 ? 1 : 0);
    expect(f.release).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not send a query if the clock passes the deadline before its timer callback', async () => {
    const f = fixture();
    const acquisition = deferred<PostgresQueryClient>();
    f.connect.mockReturnValue(acquisition.promise);
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValueOnce(0).mockReturnValue(2501);
    try {
      const outcome = f.executor.query('INSERT mock', []).catch((error: unknown) => error);
      acquisition.resolve(f.client as PostgresQueryClient);
      expect(await outcome).toMatchObject({ category: 'unavailable' });
      expect(f.query).not.toHaveBeenCalled();
      expect(f.release).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { now.mockRestore(); }
  });

  it('does not time out an INSERT already in progress', async () => {
    const f = fixture();
    const insertion = deferred<unknown>();
    f.query.mockReturnValue(insertion.promise);
    const result = f.executor.query('INSERT mock', []);
    await Promise.resolve(); await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.release).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    insertion.resolve({ rows: [] });
    await expect(result).resolves.toEqual({ rows: [] });
    expect(f.query).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it.each([false, true])('sanitizes connect failures (synchronous=%s)', async (synchronous) => {
    const f = fixture();
    const error = new Error('PRIVATE timeout configuration');
    if (synchronous) f.connect.mockImplementation(() => { throw error; });
    else f.connect.mockRejectedValue(error);
    const result = await f.executor.query('INSERT mock', []).catch((error: unknown) => error);
    expect(result).toMatchObject({ category: 'internal' });
    expect(String(result) + JSON.stringify(result)).not.toContain('PRIVATE');
    expect(f.query).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])('releases once on query failure (synchronous=%s)', async (synchronous) => {
    const f = fixture();
    const error = Object.assign(new Error('PRIVATE SQL'), { code: 'ECONNRESET' });
    if (synchronous) f.query.mockImplementation(() => { throw error; });
    else f.query.mockRejectedValue(error);
    const result = await f.executor.query('INSERT mock', []).catch((error: unknown) => error);
    expect(result).toMatchObject({ category: 'unavailable', databaseCode: 'ECONNRESET' });
    expect(String(result) + JSON.stringify(result)).not.toContain('PRIVATE');
    expect(f.query).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
    expect(f.client.listenerCount('error')).toBe(0);
  });

  it.each(['resolve', 'reject'])('handles client error then late query %s safely', async (settlement) => {
    const f = fixture();
    const insertion = deferred<unknown>();
    f.query.mockReturnValue(insertion.promise);
    const outcome = f.executor.query('INSERT mock', []).catch((error: unknown) => error);
    await Promise.resolve(); await Promise.resolve();
    // pg installs an idle error listener while releasing a client.
    const idleListener = vi.fn();
    f.release.mockImplementation(() => f.client.on('error', idleListener));
    f.client.emit('error', Object.assign(new Error('PRIVATE event'), { code: 'ECONNRESET' }));
    expect(await outcome).toMatchObject({ category: 'unavailable' });
    f.client.emit('error', new Error('later idle event'));
    expect(idleListener).toHaveBeenCalledOnce();
    if (settlement === 'resolve') insertion.resolve({ rows: [] });
    else insertion.reject(new Error('PRIVATE late query'));
    await Promise.resolve();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.query).toHaveBeenCalledOnce();
    expect(f.client.listenerCount('error')).toBe(1);
    f.client.removeListener('error', idleListener);
  });

  it('does not replace the primary failure if release also throws', async () => {
    const f = fixture();
    f.query.mockRejectedValue({ code: '23514' });
    f.release.mockImplementation(() => { throw Object.assign(new Error('PRIVATE'), { code: 'ECONNRESET' }); });
    await expect(f.executor.query('INSERT mock', [])).rejects.toMatchObject({
      category: 'internal', databaseCode: '23514',
    });
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.client.listenerCount('error')).toBe(0);
  });

  it('reports release failure after query success without retrying the insertion', async () => {
    const f = fixture();
    f.release.mockImplementation(() => { throw new Error('PRIVATE'); });
    await expect(f.executor.query('INSERT mock', [])).rejects.toMatchObject({ category: 'internal' });
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.query).toHaveBeenCalledOnce();
  });

  it('carries acquisition timeout through the real repository without sending an INSERT', async () => {
    const f = fixture();
    const acquisition = deferred<PostgresQueryClient>();
    f.connect.mockReturnValue(acquisition.promise);
    const repository = new PostgresTaskRepository(f.executor);
    const outcome = repository.create({ title: 'Task', description: null }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2500);
    expect(await outcome).toMatchObject({ category: 'unavailable', code: 'TASK_REPOSITORY_QUERY_FAILED' });
    expect(f.query).not.toHaveBeenCalled();
    expect(f.connect).toHaveBeenCalledOnce();
    acquisition.resolve(f.client);
    await Promise.resolve();
    expect(f.release).toHaveBeenCalledOnce();
  });
});


describe('acquisition dispatch and defensive cleanup regressions', () => {
  it('rechecks the deadline between acquisition resolution and query dispatch', async () => {
    const f = fixture();
    const clock = vi.spyOn(performance, 'now');
    clock.mockReturnValueOnce(0).mockReturnValueOnce(2499).mockReturnValue(2501);
    try {
      await expect(f.executor.query('INSERT mock', [])).rejects.toMatchObject({
        category: 'unavailable', databaseCode: undefined,
      });
      expect(clock).toHaveBeenCalledTimes(3);
      expect(f.connect).toHaveBeenCalledOnce();
      expect(f.query).not.toHaveBeenCalled();
      expect(f.release).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      expect(f.end).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it.each(['success', 'query failure', 'client error', 'release failure'])(
    'settles safely when removeListener throws after %s', async (scenario) => {
      const f = fixture();
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      const remove = vi.spyOn(f.client, 'removeListener').mockImplementation(() => {
        throw Object.assign(new Error('PRIVATE cleanup'), { code: 'ECONNRESET' });
      });
      const insertion = deferred<unknown>();
      if (scenario === 'query failure') f.query.mockRejectedValue({ code: '23514' });
      if (scenario === 'release failure') {
        f.release.mockImplementation(() => { throw new Error('PRIVATE release'); });
      }
      if (scenario === 'client error') f.query.mockReturnValue(insertion.promise);
      try {
        const result = f.executor.query('INSERT mock', []).catch((error: unknown) => error);
        if (scenario === 'client error') {
          await Promise.resolve(); await Promise.resolve();
          f.client.emit('error', Object.assign(new Error('PRIVATE driver'), { code: '57P01' }));
          insertion.reject(new Error('PRIVATE late query'));
        }
        const failure = await result;
        expect(failure).toBeInstanceOf(PostgresOperationError);
        if (scenario === 'query failure') {
          expect(failure).toMatchObject({ category: 'internal', databaseCode: '23514' });
        } else if (scenario === 'release failure') {
          expect(failure).toMatchObject({ category: 'internal', databaseCode: undefined });
        } else if (scenario === 'success') {
          expect(failure).toMatchObject({ category: 'internal', databaseCode: undefined });
        } else if (scenario === 'client error') {
          expect(failure).toMatchObject({ category: 'unavailable', databaseCode: '57P01' });
        }
        expect(String(failure) + JSON.stringify(failure)).not.toContain('PRIVATE');
        await vi.advanceTimersByTimeAsync(0);
        expect(unhandled).not.toHaveBeenCalled();
        expect(f.query).toHaveBeenCalledOnce();
        expect(f.release).toHaveBeenCalledOnce();
        expect(remove).toHaveBeenCalledOnce();
        expect(f.end).not.toHaveBeenCalled();
      } finally {
        remove.mockRestore();
        f.client.removeAllListeners('error');
        process.removeListener('unhandledRejection', unhandled);
      }
    },
  );
});
