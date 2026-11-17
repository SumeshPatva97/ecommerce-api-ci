import { createApp } from './app.js';
import { ConfigError, loadConfigFromProcess, type AppConfig } from './core/config/index.js';
import { createDatabase } from './core/db/prisma.js';
import { Readiness } from './core/health/readiness.js';
import { registerGracefulShutdown, startHttpServer } from './core/lifecycle/httpServer.js';
import { createLogger } from './core/logger/logger.js';

function loadConfigOrExit(): AppConfig {
  try {
    return loadConfigFromProcess();
  } catch (error) {
    // Logger is not available yet: write a plain message (variable names only, never values).
    const message = error instanceof ConfigError ? error.message : 'Failed to load configuration.';
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const config = loadConfigOrExit();
  const logger = createLogger(config);
  const readiness = new Readiness();
  const database = createDatabase(config, logger);

  // Readiness reports database availability accurately once B0-b Part 2 DB is configured.
  // In environments without a reachable MySQL instance, this check will fail (by design).
  readiness.register('database', async () => {
    await database.ping();
  });

  const app = createApp({ config, logger, readiness });

  try {
    await database.connect();
  } catch (error) {
    // Do not claim DB-backed functionality complete until MySQL is installed/configured and verified.
    logger.error(
      { err: error },
      'database connection failed during startup (continuing to serve; readiness will reflect DB state)',
    );
  }

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
