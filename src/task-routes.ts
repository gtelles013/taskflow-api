import type { FastifyInstance } from 'fastify';
import { DatabaseUnavailableHttpError, InternalHttpError, RequestValidationError } from './http-errors';
import { isPostgresRepositoryUnavailable } from './postgres-task-repository';
import type { TaskRepository } from './task-repository';
import { MAX_TASK_OFFSET, validateTaskQuery } from './task-query';
import { taskCreationResponseSchema, taskListResponseSchema, toTaskResponse } from './task-response';
import type { TaskCreationResponse, TaskListResponse } from './task-response';
import { TaskValidationError, validateTaskInput } from './task-validation';
import type { ValidatedTaskInput } from './task-validation';

async function runRepositoryOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isPostgresRepositoryUnavailable(error)) throw new DatabaseUnavailableHttpError(error);
    throw new InternalHttpError();
  }
}

export function registerTaskRoutes(app: FastifyInstance, repository: TaskRepository): void {
  app.post<{
    Reply: {
      201: TaskCreationResponse;
    };
  }>('/tasks', {
    schema: { response: { 201: taskCreationResponseSchema } },
  }, async (request, reply) => {
    let input: ValidatedTaskInput;
    try {
      input = validateTaskInput(request.body);
    } catch (error) {
      if (error instanceof TaskValidationError) {
        throw new RequestValidationError(error.field);
      }
      throw new InternalHttpError();
    }

    const task = await runRepositoryOperation(() => repository.create(input));

    // Response mapping/serialization failures never become database-unavailable responses.
    try {
      return reply.code(201).send(toTaskResponse(task));
    } catch {
      // Repository errors never become request-validation errors, regardless of their type/status.
      throw new InternalHttpError();
    }
  });

  app.get<{ Reply: { 200: TaskListResponse } }>('/tasks', {
    exposeHeadRoute: false,
    schema: { response: { 200: taskListResponseSchema } },
  }, async (request, reply) => {
    const input = validateTaskQuery(request.raw.url);
    const page = await runRepositoryOperation(() => repository.list(input));

    try {
      if (typeof page !== 'object' || page === null || Array.isArray(page)) {
        throw new InternalHttpError();
      }

      const { items, hasMore } = page;
      if (!Array.isArray(items) || typeof hasMore !== 'boolean' ||
          items.length > input.limit || (hasMore && items.length !== input.limit)) {
        throw new InternalHttpError();
      }

      const candidate = input.offset + input.limit;
      const truncated = hasMore && candidate > MAX_TASK_OFFSET;
      return reply.code(200).send({
        items: items.map(toTaskResponse),
        nextOffset: hasMore && !truncated ? candidate : null,
        truncated,
      });
    } catch {
      throw new InternalHttpError();
    }
  });
}
