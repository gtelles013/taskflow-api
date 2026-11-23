import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { Client, Pool } from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app';
import { getDatabaseUnavailableHttpMetadata } from '../../src/http-errors';
import { ACQUISITION_TIMEOUT_MILLIS, PostgresQueryExecutor } from '../../src/postgres-query-executor';
import {
  getPostgresUnavailableMetadata,
  isPostgresRepositoryUnavailable,
  PostgresTaskRepository,
} from '../../src/postgres-task-repository';

// No environment/configuration loading and no sockets or pools on import.
// This proves real TCP + stalled PostgreSQL acquisition, not ECONNREFUSED or a stopped database.
afterEach(() => { vi.restoreAllMocks(); });

it('returns trusted HTTP 503 when a real TCP endpoint never completes the PostgreSQL handshake', async () => {
  expect(ACQUISITION_TIMEOUT_MILLIS).toBe(2500);
  const sockets = new Set<Socket>();
  const socketClosures: Promise<void>[] = [];
  let acceptedConnections = 0;
  let startupBytes = 0;
  let cleaning = false;
  let transportFailed = false;
  let safetyExpired = false;
  let cleanupFailed = false;
  let serverClosed = false;
  let successfulAcquisitions = 0;
  let acquisitionSucceeded = false;
  let acquisitionRejected = false;
  let app: ReturnType<typeof buildApp> | undefined;
  let pool: Pool | undefined;
  let observeAcquisition: () => Promise<void> = async () => {};
  const server = createServer((socket) => {
    acceptedConnections++;
    sockets.add(socket);
    socket.on('error', () => { if (!cleaning) transportFailed = true; });
    // Register before destruction is possible; retain resolved Promises for already-closed sockets.
    socketClosures.push(new Promise<void>((resolve) => {
      socket.once('close', () => { sockets.delete(socket); resolve(); });
    }));
    // Consume bytes without recording their contents or replying to the startup packet.
    socket.on('data', (chunk: Buffer) => { startupBytes += chunk.length; });
  });
  server.on('error', () => { if (!cleaning) transportFailed = true; });
  // Failure-only guard; never the mechanism that is allowed to make this test pass.
  // 6s leaves cleanup time inside the existing integration testTimeout of 10s.
  const safety = setTimeout(() => {
    safetyExpired = true;
    for (const socket of sockets) {
      try { socket.destroy(); } catch { cleanupFailed = true; }
    }
  }, 6000);
  safety.unref();

  try {
    await new Promise<void>((resolve, reject) => {
      const onListenError = () => { reject(new Error('CONTROLLED_TCP_LISTEN_FAILED')); };
      server.once('error', onListenError);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
        server.removeListener('error', onListenError);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === 'string' || address.address !== '127.0.0.1' ||
        address.port === 5432 || address.port <= 0 || address.port > 65535) {
      throw new Error('CONTROLLED_TCP_DESTINATION_REJECTED');
    }
    expect(server.listening).toBe(true);
    const synthetic = {
      host: '127.0.0.1', port: address.port,
      user: 'synthetic_unavailability_user', password: 'SYNTHETIC_PASSWORD_SENTINEL',
      database: 'synthetic_unavailability_database', application_name: 'synthetic_unavailability_test',
      ssl: false, max: 1, connectionTimeoutMillis: 3000, idleTimeoutMillis: 1000,
      options: '-c default_transaction_read_only=on -c statement_timeout=3000',
    };
    // Only the still-bound endpoint owned above is reachable from this test pool.
    pool = new Pool(synthetic);
    pool.on('error', () => { if (!cleaning) transportFailed = true; });
    pool.on('connect', () => { successfulAcquisitions++; });
    const connect = vi.spyOn(pool, 'connect');
    const clientQuery = vi.spyOn(Client.prototype, 'query');
    const poolQuery = vi.spyOn(pool, 'query');
    observeAcquisition = async () => {
      for (const result of connect.mock.results) {
        const value: unknown = result.type === 'return' ? result.value : undefined;
        if (!(value instanceof Promise)) throw new Error('CONTROLLED_ACQUISITION_NOT_OBSERVABLE');
        await value.then(
          () => { acquisitionSucceeded = true; },
          () => { acquisitionRejected = true; },
        );
      }
    };
    const executor = new PostgresQueryExecutor(pool);
    const query = vi.spyOn(executor, 'query');
    const repository = new PostgresTaskRepository(executor, 'taskflow_test_unavailability_probe');
    const create = vi.spyOn(repository, 'create');
    app = buildApp({ taskRepository: repository });
    const metadata: Array<ReturnType<typeof getDatabaseUnavailableHttpMetadata>> = [];
    app.addHook('onError', async (_request, _reply, error) => {
      metadata.push(getDatabaseUnavailableHttpMetadata(error));
    });
    const input = { title: 'SYNTHETIC_SQL_SENTINEL', description: 'SYNTHETIC_PARAM_SENTINEL' };
    const response = await app.inject({ method: 'POST', url: '/tasks', payload: input });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: { code: 'DATABASE_UNAVAILABLE', message: 'Database unavailable' },
    });
    expect(create).toHaveBeenCalledExactlyOnceWith(input);
    expect(connect).toHaveBeenCalledExactlyOnceWith();
    expect(acceptedConnections).toBe(1);
    expect(startupBytes).toBeGreaterThan(0);
    expect(server.listening).toBe(true);
    expect(transportFailed).toBe(false);
    expect(safetyExpired).toBe(false);
    expect(successfulAcquisitions).toBe(0);
    expect(clientQuery).not.toHaveBeenCalled();
    expect(poolQuery).not.toHaveBeenCalled();
    // One logical INSERT reaches the executor; no SQL reaches a PostgreSQL client.
    expect(query).toHaveBeenCalledExactlyOnceWith(
      'INSERT INTO "taskflow_test_unavailability_probe".tasks (title, description) ' +
      'VALUES ($1, $2) RETURNING id, title, description, status, created_at',
      [input.title, input.description],
    );
    const result = create.mock.results[0];
    if (!result || result.type !== 'return') throw new Error('CONTROLLED_REPOSITORY_RESULT_MISSING');
    const failure: unknown = await result.value.then(() => undefined, (error: unknown) => error);
    expect(isPostgresRepositoryUnavailable(failure)).toBe(true);
    expect(getPostgresUnavailableMetadata(failure)).toEqual({});
    expect(metadata).toEqual([{}]); // Identity-controlled acquisition timeout, without a driver code.
    for (const value of [synthetic.user, synthetic.password, synthetic.database, synthetic.application_name,
      input.title, input.description, '127.0.0.1', 'INSERT INTO', 'ECONNREFUSED', 'ETIMEDOUT', 'Error:']) {
      expect(response.body).not.toContain(value);
    }
    expect(response.body).not.toMatch(/"(?:stack|cause|databaseCode|sql|parameters|password)"/);
  } finally {
    cleaning = true;
    // Attempt every cleanup step; never await server.close while owned sockets are still open.
    try { await app?.close(); } catch { cleanupFailed = true; }
    let closingServer: Promise<void> | undefined;
    try {
      if (server.listening) {
        closingServer = new Promise<void>((resolve) => {
          try {
            server.close((error) => {
              if (error) cleanupFailed = true;
              else serverClosed = true;
              resolve();
            });
          } catch { cleanupFailed = true; resolve(); }
        });
      } else { serverClosed = true; }
    } catch { cleanupFailed = true; }
    for (const socket of sockets) {
      try { socket.destroy(); } catch { cleanupFailed = true; }
    }
    try { await pool?.end(); } catch { cleanupFailed = true; }
    // The executor already handles late settlement; observe the original driver Promise as well.
    try { await observeAcquisition(); } catch { cleanupFailed = true; }
    try { await closingServer; } catch { cleanupFailed = true; }
    // Server closure can precede socket.close. Await each event, not just destroyed state.
    let socketCloseTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(socketClosures),
        new Promise<never>((_resolve, reject) => {
          socketCloseTimeout = setTimeout(() => {
            reject(new Error('CONTROLLED_SOCKET_CLOSE_TIMEOUT'));
          }, 1000);
        }),
      ]);
    } catch { cleanupFailed = true; }
    finally { clearTimeout(socketCloseTimeout); }
    clearTimeout(safety);
    if (cleanupFailed) throw new Error('CONTROLLED_UNAVAILABILITY_CLEANUP_FAILED');
  }
  expect(acquisitionSucceeded).toBe(false);
  expect(acquisitionRejected).toBe(true);
  expect(serverClosed).toBe(true);
  expect(server.listening).toBe(false);
  expect(sockets.size).toBe(0);
  expect(pool?.totalCount).toBe(0);
  expect(pool?.idleCount).toBe(0);
  expect(pool?.waitingCount).toBe(0);
  expect(safetyExpired).toBe(false);
});
