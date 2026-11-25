/** Internal metadata only: never retain driver messages, causes or query data. */
export type PostgresFailureCategory = 'unavailable' | 'internal';

const transportCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT']);
const shutdownCodes = new Set(['57P01', '57P02', '57P03']);
const internalCodes = new Set(['28P01', '28000', '23502', '23503', '23505', '23514', '42501', '42P01']);
// Identity is module-private; a public string or an instance alone cannot forge a timeout.
const acquisitionTimeouts = new WeakSet<object>();

export class PostgresOperationError extends Error {
  constructor(
    public readonly category: PostgresFailureCategory,
    public readonly databaseCode: string | undefined,
  ) { super('PostgreSQL operation failed'); }
}

export function createPostgresAcquisitionTimeoutError(): PostgresOperationError {
  const error = new PostgresOperationError('unavailable', undefined);
  acquisitionTimeouts.add(error);
  return error;
}

export function classifyPostgresFailure(error: unknown): PostgresOperationError {
  let code: unknown;
  try {
    if (typeof error === 'object' && error !== null) {
      if (acquisitionTimeouts.has(error)) return createPostgresAcquisitionTimeoutError();
      if (error instanceof PostgresOperationError) {
        const category: unknown = Object.getOwnPropertyDescriptor(error, 'category')?.value;
        if (category !== 'internal' && category !== 'unavailable') {
          return new PostgresOperationError('internal', undefined);
        }
        code = Object.getOwnPropertyDescriptor(error, 'databaseCode')?.value;
      } else {
        code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
      }
    }
  } catch { /* Unknown objects remain internal failures; do not invoke getters. */ }
  const unavailable = typeof code === 'string' &&
    (/^08[A-Z0-9]{3}$/.exec(code)?.[0] === code || transportCodes.has(code) || shutdownCodes.has(code));
  const safeCode = typeof code === 'string' && (unavailable || internalCodes.has(code))
    ? code : undefined;
  // Reconstruct even previously classified errors: never trust arbitrary metadata or causes.
  return new PostgresOperationError(unavailable ? 'unavailable' : 'internal', safeCode);
}
