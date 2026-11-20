/**
 * Dedicated background worker runtime (D-61, Batch 9 WP3). Used by `src/worker.ts`; separated so it
 * can be tested with injected dependencies.
 *
 * - Runs ONLY when `JOBS_ENABLED=true` (B1). Otherwise it logs that jobs are disabled and returns
 *   without connecting anything; the entrypoint then exits 0.
 * - Registers every job from `buildScheduledJobs` exactly once in ONE scheduler.
 * - Never creates an HTTP server.
 * - Single worker by deployment discipline (B3): exactly one worker process may run; stop the old
 *   worker before starting a replacement. There is no distributed lock (multi-server deferred, D-61).
 * - Heartbeat log line every minute. Its timer also keeps the process alive, because the scheduler's
 *   own timers are `unref()`'d.
 */
import type { ProcessRuntime } from './bootstrap.js';
import { connectDatabaseOrContinue } from './bootstrap.js';
import type { ProcessLike } from './core/lifecycle/httpServer.js';
import { registerWorkerShutdown } from './core/lifecycle/workerLifecycle.js';
import { buildScheduledJobs } from './jobs/registry.js';
import { createJobScheduler, type ScheduledJob } from './jobs/scheduler.js';

export const WORKER_HEARTBEAT_MS = 60_000;

export interface RunWorkerOptions {
  readonly runtime: ProcessRuntime;
  /** Defaults to the production registry (10 jobs). */
  readonly buildJobs?: (container: ProcessRuntime['container']) => ScheduledJob[];
  readonly processLike?: ProcessLike;
  readonly exit?: (code: number) => void;
  readonly hardExitMs?: number;
  readonly heartbeatMs?: number;
}

export interface WorkerHandle {
  /** false when `JOBS_ENABLED` is not true (nothing started, nothing connected). */
  readonly started: boolean;
  readonly jobs: readonly string[];
  /** Same function the signal handlers call (exposed for tests and operators). */
  readonly shutdown: (reason: string, exitCode: number) => void;
}

const NOOP_SHUTDOWN = (): void => undefined;

export async function runWorker(options: RunWorkerOptions): Promise<WorkerHandle> {
  const { runtime } = options;
  const { config, logger, database, container } = runtime;

  if (!config.jobs.enabled) {
    logger.info(
      'JOBS_ENABLED is not true: no scheduled jobs to run; worker exiting (D-61 — set JOBS_ENABLED=true for the worker process only)',
    );
    return { started: false, jobs: [], shutdown: NOOP_SHUTDOWN };
  }

  await connectDatabaseOrContinue(runtime);
  const scheduler = createJobScheduler(
    (options.buildJobs ?? buildScheduledJobs)(container),
    logger,
  );
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    logger.info(
      { jobs: scheduler.jobs.length, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) },
      'worker heartbeat',
    );
  }, options.heartbeatMs ?? WORKER_HEARTBEAT_MS);

  const shutdown = registerWorkerShutdown({
    logger,
    ...(options.processLike === undefined ? {} : { processLike: options.processLike }),
    ...(options.exit === undefined ? {} : { exit: options.exit }),
    ...(options.hardExitMs === undefined ? {} : { hardExitMs: options.hardExitMs }),
    onClose: async () => {
      clearInterval(heartbeat);
      await scheduler.stop(); // aborts the stop signal, then waits for in-flight runs
      await database.disconnect();
    },
  });

  scheduler.start();
  logger.info(
    { pid: process.pid, jobs: scheduler.jobs },
    'background worker started: exactly ONE worker process must run (D-61); stop the old worker before starting a replacement',
  );
  return { started: true, jobs: scheduler.jobs, shutdown };
}
