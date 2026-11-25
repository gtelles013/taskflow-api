import type { TaskQueryExecutor } from './postgres-task-repository';
import { classifyPostgresFailure, createPostgresAcquisitionTimeoutError, PostgresOperationError } from './postgres-errors';

export interface PostgresQueryClient {
  query(text: string, values: (string | null)[]): Promise<unknown>;
  release(error?: Error | boolean): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
  removeListener(event: 'error', listener: (error: Error) => void): unknown;
}
export interface PostgresClientPool { connect(): Promise<PostgresQueryClient>; }
export const ACQUISITION_TIMEOUT_MILLIS = 2500;

/** Borrows a pool; construction is lazy and never changes pool configuration. */
export class PostgresQueryExecutor implements TaskQueryExecutor {
  constructor(private readonly pool: PostgresClientPool) {}

  private acquire(): Promise<{ client: PostgresQueryClient; deadline: number }> {
    return new Promise((resolve, reject) => {
      let pending = true;
      const deadline = performance.now() + ACQUISITION_TIMEOUT_MILLIS;
      const timeout = () => {
        if (!pending) return;
        pending = false;
        clearTimeout(timer);
        reject(createPostgresAcquisitionTimeoutError());
      };
      const timer = setTimeout(timeout, ACQUISITION_TIMEOUT_MILLIS);
      try {
        // The timer is installed before connect. Always observe late settlement.
        this.pool.connect().then((client) => {
          if (pending && performance.now() >= deadline) timeout();
          if (!pending) {
            try { client.release(); } catch { /* No query was sent; already failed safely. */ }
            return;
          }
          pending = false;
          clearTimeout(timer);
          resolve({ client, deadline });
        }, (error: unknown) => {
          if (!pending) return;
          pending = false;
          clearTimeout(timer);
          reject(classifyPostgresFailure(error));
        });
      } catch (error) {
        pending = false;
        clearTimeout(timer);
        reject(classifyPostgresFailure(error));
      }
    });
  }

  async query(text: string, values: (string | null)[]): Promise<unknown> {
    const { client, deadline } = await this.acquire();
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (failed: boolean, value: unknown) => {
        if (finished) return;
        finished = true;
        let failure = failed ? classifyPostgresFailure(value) : undefined;
        try {
          // Keep the listener through release; pg restores its idle listener there.
          client.release(failed ? new Error('PostgreSQL operation failed') : undefined);
        } catch {
          // Cleanup exceptions are internal, not fresh evidence of database unavailability.
          failure ??= new PostgresOperationError('internal', undefined);
        }
        try {
          client.removeListener('error', onError);
        } catch {
          // Cleanup exceptions are internal, not fresh evidence of database unavailability.
          failure ??= new PostgresOperationError('internal', undefined);
        }
        if (failure) reject(failure); else resolve(value);
      };
      const onError = (error: Error) => finish(true, error);
      try {
        client.on('error', onError);
        if (finished) return;
        // Recheck after the await boundary, immediately before dispatch.
        if (performance.now() >= deadline) {
          finish(true, createPostgresAcquisitionTimeoutError());
          return;
        }
        // No acquisition deadline applies after the query has started. No retry.
        client.query(text, values).then(
          (result) => finish(false, result), (error: unknown) => finish(true, error),
        );
      } catch (error) { finish(true, error); }
    });
  }
}
