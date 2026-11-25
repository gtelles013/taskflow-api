import { errorCodes } from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getPostgresUnavailableMetadata } from './postgres-task-repository';
import type { PostgresUnavailableMetadata } from './postgres-task-repository';

import { TaskQueryValidationError } from './task-query';

type PublicField = 'title' | 'description' | 'body';

const detailMessages = {
  title: 'Invalid title',
  description: 'Invalid description',
  body: 'Invalid request body',
} as const;

// Only the request-validation boundary creates this error.
export class RequestValidationError extends Error {
  readonly field: PublicField;

  constructor(field: string) {
    super('Invalid task input');
    this.name = 'RequestValidationError';
    this.field = field === 'title' || field === 'description' ? field : 'body';
  }
}

// Never retain the original error, cause, status, headers or message.
export class InternalHttpError extends Error {
  constructor() {
    super('Internal server error');
    this.name = 'InternalHttpError';
  }
}

const unavailableHttpMetadata = new WeakMap<object, Readonly<PostgresUnavailableMetadata>>();

/** Private identity lookup for future diagnostics; never reads raw error properties. */
export function getDatabaseUnavailableHttpMetadata(error: unknown): Readonly<PostgresUnavailableMetadata> | undefined {
  return typeof error === 'object' && error !== null ? unavailableHttpMetadata.get(error) : undefined;
}

// Constructed only when the route recognizes a registered persistence failure.
export class DatabaseUnavailableHttpError extends Error {
  constructor(persistenceFailure?: unknown) {
    super('Database unavailable');
    this.name = 'DatabaseUnavailableHttpError';
    const metadata = getPostgresUnavailableMetadata(persistenceFailure);
    if (metadata !== undefined) unavailableHttpMetadata.set(this, metadata);
  }
}

// Called only by the central handler. Logging failure must not change the HTTP result.
function recordHttpFailure(
  request: FastifyRequest,
  statusCode: 400 | 500 | 503,
  metadata?: Readonly<PostgresUnavailableMetadata>,
): void {
  try {
    const category = statusCode === 400 ? 'VALIDATION_ERROR'
      : statusCode === 503 ? 'DATABASE_UNAVAILABLE' : 'INTERNAL_ERROR';
    const event = {
      statusCode, category,
      ...(statusCode === 503 && metadata?.databaseCode !== undefined
        ? { databaseCode: metadata.databaseCode } : {}),
    };
    // reqId is already bound by Fastify; never pass request/error objects to Pino.
    if (statusCode === 400) request.log.warn(event, 'HTTP request failed');
    else request.log.error(event, 'HTTP request failed');
  } catch { /* No retry or fallback log, even when the destination throws. */ }
}

export function registerHttpErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof DatabaseUnavailableHttpError) {
      recordHttpFailure(request, 503, getDatabaseUnavailableHttpMetadata(error));
      return reply.code(503).send({
        error: { code: 'DATABASE_UNAVAILABLE', message: 'Database unavailable' },
      });
    }

    if (error instanceof TaskQueryValidationError) {
      recordHttpFailure(request, 400);
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid task query',
          details: [{ field: 'query', message: 'Invalid query parameters' }],
        },
      });
    }

    if (error instanceof RequestValidationError ||
        error instanceof errorCodes.FST_ERR_CTP_INVALID_JSON_BODY ||
        error instanceof errorCodes.FST_ERR_CTP_EMPTY_JSON_BODY ||
        error instanceof errorCodes.FST_ERR_CTP_INVALID_CONTENT_LENGTH) {
      const field = error instanceof RequestValidationError ? error.field : 'body';
      recordHttpFailure(request, 400);
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid task input',
          details: [{ field, message: detailMessages[field] }],
        },
      });
    }

    // Preserve framework transport statuses without reflecting its raw messages.
    if (error instanceof errorCodes.FST_ERR_CTP_BODY_TOO_LARGE) {
      return reply.code(413).send({
        statusCode: 413, error: 'Payload Too Large',
        code: 'FST_ERR_CTP_BODY_TOO_LARGE', message: 'Request body is too large',
      });
    }
    if (error instanceof errorCodes.FST_ERR_CTP_INVALID_MEDIA_TYPE) {
      return reply.code(415).send({
        statusCode: 415, error: 'Unsupported Media Type',
        code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE', message: 'Unsupported Media Type',
      });
    }

    recordHttpFailure(request, 500);
    return reply.code(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  });
}
