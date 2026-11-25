import Fastify, { LogController } from 'fastify';
import { registerHttpErrorHandler } from './http-errors';
import { registerTaskRoutes } from './task-routes';
import { strictValidationOptions } from './task-validation';
import type { TaskRepository } from './task-repository';

declare module 'fastify' {
  interface FastifyInstance {
    taskRepository: TaskRepository | null;
  }
}

export interface AppOptions {
  taskRepository?: TaskRepository;
  logger?: boolean;
  loggerStream?: { write(message: string): void };
}

// An injected repository belongs to this app and is closed with it.
export function buildApp(options: AppOptions = {}) {
  const app = Fastify({
    logger: options.logger ? { ...(options.loggerStream ? { stream: options.loggerStream } : {}) } : false,
    // Keep request IDs and child loggers, but suppress automatic request data/error logs.
    logController: new LogController({ disableRequestLogging: true }),
    requestIdHeader: false,
    ajv: { customOptions: strictValidationOptions },
  });
  registerHttpErrorHandler(app);
  app.decorate('taskRepository', options.taskRepository ?? null);

  // Keep the route unavailable until a repository is explicitly provided.
  if (options.taskRepository) {
    registerTaskRoutes(app, options.taskRepository);
  }

  app.addHook('onClose', async () => {
    await options.taskRepository?.close?.();
  });

  return app;
}
