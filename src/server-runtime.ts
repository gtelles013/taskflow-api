import { buildApp } from './app';
import { createDatabasePool } from './database';
import { PostgresQueryExecutor } from './postgres-query-executor';
import type { PostgresClientPool } from './postgres-query-executor';
import { PostgresTaskRepository } from './postgres-task-repository';

interface OwnedPool extends PostgresClientPool { end(): Promise<void>; }
type Variables = Readonly<Record<string, string | undefined>>;
interface Signals {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  removeListener(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}
interface ServerOptions {
  variables?: Variables;
  createPool?: (environment: 'development', variables: Variables) => OwnedPool;
  buildApplication?: typeof buildApp;
  signals?: Signals;
  onFailure?: () => void;
  report?: (event: { category: 'STARTUP_FAILED' | 'SHUTDOWN_FAILED' }, message: string) => void;
}

/** Importing this module neither constructs a pool nor starts a server. */
export async function startServer(options: ServerOptions = {}) {
  const variables = options.variables ?? process.env;
  const signals = options.signals ?? process;
  const onFailure = options.onFailure ?? (() => { process.exitCode = 1; });
  const report = options.report ?? ((event, message) => { console.error(event, message); });
  const failure = (category: 'STARTUP_FAILED' | 'SHUTDOWN_FAILED') => {
    onFailure();
    try { report({ category }, 'Server operation failed'); } catch { /* No fallback or raw error. */ }
  };
  let pool: OwnedPool | undefined;
  let poolClosing: Promise<void> | undefined;
  const closePool = () => poolClosing ??= Promise.resolve().then(async () => { await pool?.end(); });
  let app: ReturnType<typeof buildApp> | undefined;
  let closing: Promise<void> | undefined;
  const shutdown = (): Promise<void> => closing ??= Promise.resolve().then(async () => {
    let failed = false;
    try { await app?.close(); } catch { failed = true; }
    // Also covers application construction/close failure before its onClose hook.
    try { await closePool(); } catch { failed = true; }
    signals.removeListener('SIGINT', handleSignal);
    signals.removeListener('SIGTERM', handleSignal);
    if (failed) failure('SHUTDOWN_FAILED');
  });
  const handleSignal = () => { void shutdown(); };

  try {
    pool = (options.createPool ?? createDatabasePool)('development', variables);
    const repository = new PostgresTaskRepository(new PostgresQueryExecutor(pool));
    app = (options.buildApplication ?? buildApp)({
      logger: true,
      taskRepository: { create: (input) => repository.create(input), close: closePool },
    });
    signals.on('SIGINT', handleSignal);
    signals.on('SIGTERM', handleSignal);
    await app.listen({ port: Number(variables.PORT ?? 3000), host: variables.HOST ?? '127.0.0.1' });
    return { app, shutdown };
  } catch {
    failure('STARTUP_FAILED');
    await shutdown();
    return undefined;
  }
}
