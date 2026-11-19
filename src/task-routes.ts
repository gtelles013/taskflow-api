import type { FastifyInstance } from 'fastify';
import type { TaskRepository } from './task-repository';
import { taskCreationResponseSchema } from './task-response';
import type { TaskCreationResponse } from './task-response';
import { TaskValidationError, validateTaskInput } from './task-validation';
import type { ValidatedTaskInput } from './task-validation';

export function registerTaskRoutes(app: FastifyInstance, repository: TaskRepository): void {
  app.post<{
    Reply: {
      201: TaskCreationResponse;
      400: { message: string };
      500: { message: string };
    };
  }>('/tasks', {
    schema: { response: { 201: taskCreationResponseSchema } },
  }, async (request, reply) => {
    let input: ValidatedTaskInput;
    try {
      input = validateTaskInput(request.body);
    } catch (error) {
      if (!(error instanceof TaskValidationError)) {
        return reply.code(500).send({ message: 'Internal server error' });
      }
      return reply.code(400).send({ message: 'Invalid task input' });
    }

    try {
      const task = await repository.create(input);
      return reply.code(201).send({
        id: task.id,
        title: task.title,
        description: task.description,
        status: task.status,
        createdAt: task.createdAt.toISOString(),
      } satisfies TaskCreationResponse);
    } catch {
      // Provisional response; centralized error classification belongs to section 5.
      return reply.code(500).send({ message: 'Internal server error' });
    }
  });
}
