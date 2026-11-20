/**
 * API process entrypoint (HTTP only).
 *
 * D-61 / Batch 9: scheduled background jobs run ONLY in the dedicated worker process
 * (`src/worker.ts`, `npm run start:worker`). The API never creates or starts the job scheduler; a
 * `JOBS_ENABLED=true` seen here is ignored with a warning (`warnIfJobsEnabledForApi`).
 */
import { createApp } from './app.js';
import {
  assertRuntimeOrExit,
  connectDatabaseOrContinue,
  createProcessRuntime,
  loadConfigOrExit,
  warnIfJobsEnabledForApi,
} from './bootstrap.js';
import { Readiness } from './core/health/readiness.js';
import { registerGracefulShutdown, startHttpServer } from './core/lifecycle/httpServer.js';

async function main(): Promise<void> {
  assertRuntimeOrExit();
  const config = loadConfigOrExit();
  const runtime = createProcessRuntime(config, 'api');
  const { logger, database, container } = runtime;
  const readiness = new Readiness();

  // Readiness reports database availability accurately once B0-b Part 2 DB is configured.
  // In environments without a reachable MySQL instance, this check will fail (by design).
  readiness.register('database', async () => {
    await database.ping();
  });

  const app = createApp({ config, logger, readiness, container });
  await connectDatabaseOrContinue(runtime);
  warnIfJobsEnabledForApi(config, logger);

  try {
    const server = await startHttpServer(app, config.port, logger);
    registerGracefulShutdown({
      server,
      readiness,
      logger,
      onClose: async () => {
        await database.disconnect();
      },
    });
    logger.info(
      { port: config.port, nodeEnv: config.nodeEnv, apiBaseUrl: config.apiBaseUrl },
      'ecommerce-api listening',
    );
  } catch (error) {
    // e.g. EADDRINUSE / EACCES from the server's `error` event.
    logger.fatal({ err: error, port: config.port }, 'failed to start HTTP server');
    await database.disconnect().catch(() => undefined);
    logger.flush();
    process.exit(1);
  }
}

void main();
