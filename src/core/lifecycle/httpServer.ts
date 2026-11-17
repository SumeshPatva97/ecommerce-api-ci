import { createServer, type RequestListener, type Server } from 'node:http';

import type { Readiness } from '../health/readiness.js';
import type { Logger } from '../logger/logger.js';

const IDLE_SWEEP_MS = 100;

/**
 * Starts the HTTP server. Startup failures (EADDRINUSE, EACCES, …) are taken from the server's
 * `error` event — the listen callback is only used as the success signal. Errors emitted after
 * the server is listening are logged; they do not reject the (already settled) promise.
 */
export function startHttpServer(
  handler: RequestListener,
  port: number,
  logger: Logger,
  host?: string,
): Promise<Server> {
  const server = createServer(handler);
  return new Promise<Server>((resolve, reject) => {
    const onStartupError = (error: Error): void => {
      reject(error);
    };
    server.once('error', onStartupError);
    const onListening = (): void => {
      server.off('error', onStartupError);
      server.on('error', (error: Error) => {
        logger.error({ err: error }, 'HTTP server error');
      });
      resolve(server);
    };
    if (host === undefined) server.listen(port, onListening);
    else server.listen(port, host, onListening);
  });
}

/** Minimal surface of `process` used for shutdown wiring (injectable for tests). */
export interface ProcessLike {
  on(event: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
  on(event: 'uncaughtException', listener: (error: Error) => void): unknown;
}

export interface ShutdownOptions {
  server: Server;
  readiness: Readiness;
  logger: Logger;
  processLike?: ProcessLike;
  exit?: (code: number) => void;
  /** Close in-flight connections after this long (BACKEND_STRUCTURE.md §22: 25 s). */
  drainTimeoutMs?: number;
  /** Force exit with code 1 after this long (BACKEND_STRUCTURE.md §22: 30 s). */
  hardExitMs?: number;
  /** Disconnect hooks (Prisma, Redis) registered by later increments; run after HTTP drain. */
  onClose?: () => Promise<void>;
}

/**
 * Graceful shutdown — BACKEND_STRUCTURE.md §22:
 * 1. mark not-ready, 2. stop accepting connections and let in-flight requests finish (≤ 25 s),
 * 3. run disconnect hooks, 4. exit 0 (or 1 after a fatal error); hard exit after 30 s.
 * Returns the `shutdown` function so callers/tests can trigger it directly.
 */
export function registerGracefulShutdown(
  options: ShutdownOptions,
): (reason: string, exitCode: number) => void {
  const {
    server,
    readiness,
    logger,
    processLike = process,
    exit = (code: number) => process.exit(code),
    drainTimeoutMs = 25_000,
    hardExitMs = 30_000,
    onClose,
  } = options;
  let shuttingDown = false;

  const shutdown = (reason: string, exitCode: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ reason }, 'shutdown started');
    readiness.markShuttingDown();

    const hardExit = setTimeout(() => {
      logger.error('shutdown timed out; forcing exit');
      logger.flush();
      exit(1);
    }, hardExitMs);
    hardExit.unref();

    const drainTimer = setTimeout(() => {
      logger.warn('drain timeout reached; closing remaining connections');
      server.closeAllConnections();
    }, drainTimeoutMs);
    drainTimer.unref();

    // Keep-alive sockets become idle only after their in-flight response finishes; close them as
    // soon as they do, otherwise shutdown would wait for the full drain timeout.
    const idleSweep = setInterval(() => {
      server.closeIdleConnections();
    }, IDLE_SWEEP_MS);
    idleSweep.unref();

    server.close((closeError) => {
      clearTimeout(drainTimer);
      clearInterval(idleSweep);
      if (closeError) logger.error({ err: closeError }, 'error while closing HTTP server');
      const finish = (code: number): void => {
        clearTimeout(hardExit);
        logger.info({ exitCode: code }, 'shutdown complete');
        logger.flush();
        exit(code);
      };
      if (onClose === undefined) {
        finish(exitCode);
        return;
      }
      onClose().then(
        () => {
          finish(exitCode);
        },
        (hookError: unknown) => {
          logger.error({ err: hookError }, 'error in shutdown hook');
          finish(1);
        },
      );
    });
    server.closeIdleConnections();
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
