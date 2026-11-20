/**
 * Payment retry policy — API_DOCUMENTATION.md §3.9, PROJECT_CONTEXT §15 R-06.
 *
 * PROVISIONAL (OQ-58): retry allowed for 60 minutes from placement, at most 3 payment attempts per
 * order (the first attempt is created at placement); afterwards the order is auto-cancelled by
 * `src/jobs/unpaidOrderCancel.ts`.
 */
import { addMinutes } from '../../lib/time.js';

export const RETRY_WINDOW_MINUTES = 60;
export const MAX_PAYMENT_ATTEMPTS = 3;

/** Gateway calls (initiate / fetch) time out after 10 s (BACKEND_STRUCTURE §15). */
export const GATEWAY_TIMEOUT_MS = 10_000;

export function retryWindowEnd(placedAt: Date): Date {
  return addMinutes(placedAt, RETRY_WINDOW_MINUTES);
}

export function isRetryWindowOpen(placedAt: Date, now: Date): boolean {
  return now.getTime() <= retryWindowEnd(placedAt).getTime();
}

/** Rejects after `ms` (the underlying call is not aborted — adapters must be idempotent). */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number = GATEWAY_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Payment gateway timeout.'));
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
