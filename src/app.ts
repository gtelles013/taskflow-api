import Fastify from 'fastify';
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
}

// An injected repository belongs to this app and is closed with it.
export function buildApp(options: AppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? false, ajv: { customOptions: strictValidationOptions } });
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
