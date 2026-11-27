/**
 * Shared process start-up for the two runtime processes (D-61): the API (`src/server.ts`) and the
 * dedicated background worker (`src/worker.ts`). Batch 9, WP1.
 *
 * Steps shared by both: Node.js runtime guard → validated configuration → logger tagged with the
 * process role → database client (not yet connected) → application container. Each entrypoint then
 * adds only its own responsibilities (HTTP server or job scheduler).
 */
import { createContainer, type AppContainer } from './container.js';
import { ConfigError, loadConfigFromProcess, type AppConfig } from './core/config/index.js';
import { createDatabase, type Database } from './core/db/prisma.js';
import { createLogger, type Logger } from './core/logger/logger.js';
import { assertSupportedNode } from './core/runtime/nodeVersion.js';

export type ProcessRole = 'api' | 'worker';

export interface ProcessRuntime {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly database: Database;
  readonly container: AppContainer;
}

/** Exits with a clear message on an unsupported Node.js version (native argon2 would crash). */
export function assertRuntimeOrExit(): void {
  try {
    assertSupportedNode();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Unsupported runtime.'}\n`);
    process.exit(1);
  }
}

/** Loads configuration or exits, naming invalid variables only (values are never printed). */
export function loadConfigOrExit(): AppConfig {
  try {
    return loadConfigFromProcess();
  } catch (error) {
    // Logger is not available yet: write a plain message (variable names only, never values).
    const message = error instanceof ConfigError ? error.message : 'Failed to load configuration.';
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}

/**
 * Logger, database client and container for one process; no connection is opened here.
 *
 * A configuration the container refuses (e.g. the mock payment provider in production, PW-08)
 * stops the process with exit code 1, for the API and for the worker. The log line names
 * variables only, never values.
 */
export function createProcessRuntime(config: AppConfig, role: ProcessRole): ProcessRuntime {
  const logger = createLogger(config).child({ process: role });
  const database = createDatabase(config, logger);
  let container: AppContainer;
  try {
    container = createContainer(config, logger, database.client);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    logger.fatal({ problems: error.problems }, 'start-up refused: invalid configuration');
    logger.flush();
    process.exit(1);
  }
  return { config, logger, database, container };
}

/**
 * B2 (Batch 9): the API never runs scheduled jobs, whatever `JOBS_ENABLED` says. Logs a clear
 * warning when it is set for the API process. Returns whether it warned.
 */
export function warnIfJobsEnabledForApi(config: Pick<AppConfig, 'jobs'>, logger: Logger): boolean {
  if (!config.jobs.enabled) return false;
  logger.warn(
    { jobsEnabled: true },
    'JOBS_ENABLED=true is ignored by the API process: scheduled jobs run only in the dedicated ' +
      'worker process (D-61; start it with `npm run start:worker`)',
  );
  return true;
}

/**
 * Connects the database. A failure is logged and the process keeps running: the API's readiness
 * probe reports it, and the worker's job runs fail and are retried on their next interval.
 */
export async function connectDatabaseOrContinue(runtime: ProcessRuntime): Promise<void> {
  try {
    await runtime.database.connect();
  } catch (error) {
    runtime.logger.error(
      { err: error },
      'database connection failed during startup (continuing; state is reported and retried)',
    );
  }
}
