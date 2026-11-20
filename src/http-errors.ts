import { errorCodes } from 'fastify';
import type { FastifyInstance } from 'fastify';

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

export function registerHttpErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof RequestValidationError ||
        error instanceof errorCodes.FST_ERR_CTP_INVALID_JSON_BODY ||
        error instanceof errorCodes.FST_ERR_CTP_EMPTY_JSON_BODY ||
        error instanceof errorCodes.FST_ERR_CTP_INVALID_CONTENT_LENGTH) {
      const field = error instanceof RequestValidationError ? error.field : 'body';
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

    return reply.code(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  });
}
