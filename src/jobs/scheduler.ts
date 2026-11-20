/**
 * In-process job scheduler — interim implementation of BACKEND_STRUCTURE.md §14 while Redis/BullMQ
 * is deferred (D-38 / OQ-35).
 *
 * - Disabled unless `JOBS_ENABLED=true`.
 * - **One dedicated worker process (D-61)**: there is no distributed lock, so exactly one worker
 *   process may run the scheduler; running several would execute each job once per process (the jobs
 *   are idempotent, but work and logs would duplicate). Multi-server job execution (e.g. BullMQ
 *   repeatable jobs with Redis locks) is deferred.
 * - Each job is overlap-protected (a run is skipped while the previous one is still in flight), errors are
 *   logged and never crash the process — including a synchronous throw from `run()` (IMP-09), which is
 *   logged as a failed run — and `stop()` waits for in-flight runs (graceful shutdown).
 * - Cooperative stop (Batch 9, WP-O2): every run receives an `AbortSignal`. `stop()` aborts it before
 *   waiting, so long jobs that check it between items finish their CURRENT item and then return early;
 *   jobs that ignore it simply run to completion. Nothing is interrupted halfway through an item.
 * - Host process (D-61, Batch 9): started only by the dedicated worker (`src/worker.ts`), never by
 *   the API process.
 * - Fixed intervals, not IST cron times: the daily `token-cleanup` runs every 24 h from start-up rather
 *   than at 03:00 IST (documented deviation).
 */
import type { Logger } from '../core/logger/logger.js';

export interface ScheduledJob {
  readonly name: string;
  readonly intervalMs: number;
  /** Delay before the first run (default: one interval). */
  readonly initialDelayMs?: number;
  /** `signal` is aborted when the scheduler stops; long jobs check it between items (WP-O2). */
  run(signal: AbortSignal): Promise<unknown>;
}

export interface JobScheduler {
  start(): void;
  /** Stops timers and waits for in-flight runs. */
  stop(): Promise<void>;
  /** Runs one job now (skipped and returns `false` while it is already running). */
  runNow(name: string): Promise<boolean>;
  readonly jobs: readonly string[];
}

export function createJobScheduler(jobs: readonly ScheduledJob[], logger: Logger): JobScheduler {
  const names = new Set<string>();
  for (const job of jobs) {
    if (names.has(job.name)) throw new Error(`Duplicate job name: ${job.name}`);
    if (!Number.isInteger(job.intervalMs) || job.intervalMs < 1000) {
      throw new Error(`Job ${job.name}: intervalMs must be an integer >= 1000.`);
    }
    names.add(job.name);
  }

  const timers: NodeJS.Timeout[] = [];
  const inFlight = new Map<string, Promise<void>>();
  const stopController = new AbortController();
  let started = false;
  let stopping = false;

  const execute = (job: ScheduledJob): Promise<boolean> => {
    if (stopping || inFlight.has(job.name)) return Promise.resolve(false);
    const startedAt = Date.now();
    // IMP-09: the async wrapper still calls `run()` synchronously, but turns a synchronous throw
    // into a rejected run (logged below as `job run failed`) instead of an uncaught exception.
    const run = (async () => job.run(stopController.signal))();
    const promise = run
      .then((summary) => {
        logger.info({ job: job.name, ms: Date.now() - startedAt, summary }, 'job run finished');
      })
      .catch((error: unknown) => {
        logger.error({ err: error, job: job.name }, 'job run failed');
      })
      .finally(() => {
        inFlight.delete(job.name);
      });
    inFlight.set(job.name, promise);
    return promise.then(() => true);
  };

  return {
    jobs: [...names],

    start() {
      if (started) return;
      started = true;
      for (const job of jobs) {
        const first = setTimeout(() => {
          void execute(job);
          const repeat = setInterval(() => void execute(job), job.intervalMs);
          repeat.unref();
          timers.push(repeat);
        }, job.initialDelayMs ?? job.intervalMs);
        first.unref();
        timers.push(first);
      }
      logger.info(
        { jobs: [...names] },
        'in-process job scheduler started (single dedicated worker process — D-61)',
      );
    },

    async stop() {
      if (!stopping) {
        stopping = true;
        stopController.abort(); // long jobs stop after their current item (WP-O2)
      }
      for (const timer of timers) {
        clearTimeout(timer);
        clearInterval(timer);
      }
      timers.length = 0;
      await Promise.allSettled([...inFlight.values()]);
    },

    runNow(name) {
      const job = jobs.find((j) => j.name === name);
      if (job === undefined) return Promise.reject(new Error(`Unknown job: ${name}`));
      return execute(job);
    },
  };
}
