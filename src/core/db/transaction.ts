/**
 * Transaction helper — BACKEND_STRUCTURE.md §7.
 *
 * - Interactive Prisma transaction (timeout 10 s, maxWait 5 s by default).
 * - `afterCommit(cb)` collects side effects (emails, gateway calls, cache busts) that must run only
 *   after a successful commit — no network call ever runs inside a DB transaction.
 * - Deadlock / write-conflict (P2034, MySQL 1213) is retried up to 3 times with jitter when the
 *   caller marks the use-case idempotent; otherwise surfaced as `CONFLICT`.
 */
import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../errors/AppError.js';

export type DbClient = PrismaClient;
export type TxClient = Prisma.TransactionClient;
/** Anything a repository can run queries on. */
export type Queryable = DbClient | TxClient;

export interface TxContext {
  readonly tx: TxClient;
  /** Property (not method) signature so it can be destructured without unbound-method lint. */
  readonly afterCommit: (callback: () => Promise<void> | void) => void;
}

export interface TransactionOptions {
  readonly timeoutMs?: number;
  readonly maxWaitMs?: number;
  readonly isolationLevel?: Prisma.TransactionIsolationLevel;
  /** Retry on deadlock (only for idempotent use-cases: stock movements, payment capture). */
  readonly retryOnDeadlock?: boolean;
  /** Receives errors thrown by after-commit callbacks (they never fail the request). */
  readonly onAfterCommitError?: (error: unknown) => void;
}

export function isDeadlock(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === 'P2034') return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && /deadlock|1213|lock wait timeout|1205/i.test(message);
}

const MAX_ATTEMPTS = 3;

export async function withTransaction<T>(
  db: DbClient,
  fn: (ctx: TxContext) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const callbacks: (() => Promise<void> | void)[] = [];
    try {
      const result = await db.$transaction(
        async (tx) =>
          fn({
            tx,
            afterCommit: (cb) => {
              callbacks.push(cb);
            },
          }),
        {
          timeout: options.timeoutMs ?? 10_000,
          maxWait: options.maxWaitMs ?? 5_000,
          ...(options.isolationLevel === undefined
            ? {}
            : { isolationLevel: options.isolationLevel }),
        },
      );
      for (const cb of callbacks) {
        try {
          await cb();
        } catch (error) {
          options.onAfterCommitError?.(error);
        }
      }
      return result;
    } catch (error) {
      if (isDeadlock(error)) {
        if (options.retryOnDeadlock === true && attempt < MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 20 + Math.floor(Math.random() * 80)));
          continue;
        }
        throw new AppError('CONFLICT', 'The resource is busy. Please retry.', { cause: error });
      }
      throw error;
    }
  }
}
