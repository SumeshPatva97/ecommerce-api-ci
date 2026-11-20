/**
 * Notification dispatcher job — NOTIFICATION_WORKFLOWS.md §2, BACKEND_STRUCTURE.md §13–§14.
 *
 * Nothing runs at import time. The process entrypoint (or an operator script) decides when to run:
 *
 *   await runNotificationDispatch(container, { limit: 50 });          // one pass
 *   const job = createNotificationDispatchJob(container, { intervalMs: 15_000 });
 *   job.start(); … job.stop();                                         // in-process poller
 *
 * LIMITATION (D-38 / OQ-35): no Redis/BullMQ — polling the `notifications` table is the queue and
 * the recovery sweep at once. Single instance only; concurrent runs are nevertheless safe because
 * each row is claimed with a compare-and-set update (QUEUED → SENDING).
 */
import type { AppContainer } from '../container.js';
import { notificationDispatcherFor, type DispatchSummary } from '../modules/notifications/index.js';

export interface DispatchRunOptions {
  readonly limit?: number;
  /** Cooperative stop (Batch 9, WP-O2): checked between notifications. */
  readonly signal?: AbortSignal | undefined;
}

/** One dispatch pass over due notifications. */
export async function runNotificationDispatch(
  container: AppContainer,
  options: DispatchRunOptions = {},
): Promise<DispatchSummary> {
  return notificationDispatcherFor(container).dispatchPending(options.limit ?? 50, options.signal);
}

export interface NotificationDispatchJob {
  start(): void;
  stop(): void;
  /** Runs one pass now (skipped while a pass is in flight). */
  tick(): Promise<DispatchSummary | undefined>;
}

export function createNotificationDispatchJob(
  container: AppContainer,
  options: DispatchRunOptions & { readonly intervalMs?: number } = {},
): NotificationDispatchJob {
  const dispatcher = notificationDispatcherFor(container);
  const intervalMs = options.intervalMs ?? 15_000;
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  async function tick(): Promise<DispatchSummary | undefined> {
    if (running) return undefined;
    running = true;
    try {
      return await dispatcher.dispatchPending(options.limit ?? 50);
    } catch (error) {
      container.logger.error({ err: error }, 'notification dispatch pass failed');
      return undefined;
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        void tick();
      }, intervalMs);
      timer.unref();
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
    tick,
  };
}
