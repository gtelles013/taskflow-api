import type { FastifyInstance } from 'fastify';
import { DatabaseUnavailableHttpError, InternalHttpError, RequestValidationError } from './http-errors';
import { isPostgresRepositoryUnavailable } from './postgres-task-repository';
import type { Task, TaskRepository } from './task-repository';
import { taskCreationResponseSchema } from './task-response';
import type { TaskCreationResponse } from './task-response';
import { TaskValidationError, validateTaskInput } from './task-validation';
import type { ValidatedTaskInput } from './task-validation';

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

    let task: Task;
    try {
      task = await repository.create(input);
    } catch (error) {
      if (isPostgresRepositoryUnavailable(error)) throw new DatabaseUnavailableHttpError();
      throw new InternalHttpError();
    }

    // Response mapping/serialization failures never become database-unavailable responses.
    try {
      return reply.code(201).send({
        id: task.id,
        title: task.title,
        description: task.description,
        status: task.status,
        createdAt: task.createdAt.toISOString(),
      } satisfies TaskCreationResponse);
    } catch {
      // Repository errors never become request-validation errors, regardless of their type/status.
      throw new InternalHttpError();
    }
  });
}
