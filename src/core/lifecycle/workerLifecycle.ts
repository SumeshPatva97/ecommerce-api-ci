/**
 * Graceful shutdown for the dedicated background worker (D-61, Batch 9 WP2). The worker has no
 * HTTP server, so this is the HTTP-free counterpart of `registerGracefulShutdown` (httpServer.ts):
 *
 * 1. on SIGTERM / SIGINT (or a fatal error): run `onClose` once, which stops scheduling, asks long
 *    jobs to stop after their current item, waits for in-flight runs and disconnects the database;
 * 2. exit 0, or 1 if `onClose` failed or the shutdown was caused by a fatal error;
 * 3. a second signal while shutting down is logged and ignored (no duplicate cleanup);
 * 4. forced exit with code 1 after `hardExitMs` (approved: 60 s) if cleanup hangs.
 */
import type { Logger } from '../logger/logger.js';
import type { ProcessLike } from './httpServer.js';

/** Approved forced-exit limit for the worker (Batch 9, owner decision 2026-11-20). */
export const WORKER_HARD_EXIT_MS = 60_000;

export interface WorkerShutdownOptions {
  readonly logger: Logger;
  /** Stops the scheduler (waits for in-flight runs) and closes connections. Called once. */
  readonly onClose: () => Promise<void>;
  readonly processLike?: ProcessLike;
  readonly exit?: (code: number) => void;
  readonly hardExitMs?: number;
}

export function registerWorkerShutdown(
  options: WorkerShutdownOptions,
): (reason: string, exitCode: number) => void {
  const {
    logger,
    onClose,
    processLike = process,
    exit = (code: number) => process.exit(code),
    hardExitMs = WORKER_HARD_EXIT_MS,
  } = options;
  let shuttingDown = false;
  let exited = false;

  const exitOnce = (code: number): void => {
    if (exited) return;
    exited = true;
    logger.flush();
    exit(code);
  };

  const shutdown = (reason: string, exitCode: number): void => {
    if (shuttingDown) {
      logger.warn({ reason }, 'worker shutdown already in progress; signal ignored');
      return;
    }
    shuttingDown = true;
    logger.info({ reason }, 'worker shutdown started: waiting for running jobs');

    const hardExit = setTimeout(() => {
      logger.error({ hardExitMs }, 'worker shutdown timed out; forcing exit');
      exitOnce(1);
    }, hardExitMs);
    hardExit.unref();

    onClose().then(
      () => {
        clearTimeout(hardExit);
        logger.info({ exitCode }, 'worker shutdown complete');
        exitOnce(exitCode);
      },
      (error: unknown) => {
        clearTimeout(hardExit);
        logger.error({ err: error }, 'error in worker shutdown hook');
        exitOnce(1);
      },
    );
  };

  processLike.on('SIGTERM', () => {
    shutdown('SIGTERM', 0);
  });
  processLike.on('SIGINT', () => {
    shutdown('SIGINT', 0);
  });
  processLike.on('unhandledRejection', (reason: unknown) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection');
    shutdown('unhandledRejection', 1);
  });
  processLike.on('uncaughtException', (error: Error) => {
    logger.fatal({ err: error }, 'uncaught exception');
    shutdown('uncaughtException', 1);
  });

  return shutdown;
}
