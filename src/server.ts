import { buildApp } from './app';

async function main() {
  // PostgreSQL composition will be added with the persistence tasks.
  const app = buildApp({ logger: true });
  const shutdown = async () => {
    try {
      await app.close();
    } catch (error) {
      app.log.error(error);
      process.exitCode = 1;
    }
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  try {
    await app.listen({
      port: Number(process.env.PORT ?? 3000),
      host: process.env.HOST ?? '127.0.0.1',
    });
  } catch (error) {
    app.log.error(error);
    await shutdown();
    process.exitCode = 1;
  }
}

void main();
