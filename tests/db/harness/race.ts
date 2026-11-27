/**
 * DEC-12 — concurrency helpers: barrier-started `Promise.all` races, outcome classification and a
 * secret-free evidence line per case (TESTING_STRATEGY §8: "Promise.all of N parallel requests
 * with a barrier to maximise overlap").
 */
import { AppError } from '../../../src/core/errors/AppError.js';
import { isPrismaKnownError } from '../../../src/core/errors/prismaErrorMapper.js';

export type Settled<T> =
  | { readonly ok: true; readonly value: T; readonly ms: number }
  | { readonly ok: false; readonly error: unknown; readonly ms: number };

/**
 * Starts `n` operations at the same instant (all wait on one gate, released after every task is
 * scheduled) and settles them all — rejections are captured, never thrown.
 */
export async function race<T>(n: number, op: (index: number) => Promise<T>): Promise<Settled<T>[]> {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const tasks = Array.from({ length: n }, async (_unused, index): Promise<Settled<T>> => {
    await gate;
    const started = performance.now();
    try {
      const value = await op(index);
      return { ok: true, value, ms: Math.round(performance.now() - started) };
    } catch (error) {
      return { ok: false, error, ms: Math.round(performance.now() - started) };
    }
  });
  open();
  return Promise.all(tasks);
}

/** Runs heterogeneous operations through the same barrier. */
export async function raceAll(
  ops: readonly (() => Promise<unknown>)[],
): Promise<Settled<unknown>[]> {
  return race(ops.length, (i) => {
    const op = ops[i];
    if (op === undefined) throw new Error('race index out of range');
    return op();
  });
}

/** Stable, secret-free label for an outcome: AppError code, `PRISMA_<code>`, or the error name. */
export function errorLabel(error: unknown): string {
  if (error instanceof AppError) return error.code;
  if (isPrismaKnownError(error)) return `PRISMA_${error.code}`;
  if (error instanceof Error) return error.name;
  return 'UNKNOWN';
}

export function detailCode(error: unknown): string | undefined {
  return error instanceof AppError ? error.details?.[0]?.code : undefined;
}

/** `{ ok: 1, INSUFFICIENT_STOCK: 9 }` */
export function tally(results: readonly Settled<unknown>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of results) {
    const key = r.ok ? 'ok' : errorLabel(r.error);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

export function fulfilled<T>(results: readonly Settled<T>[]): T[] {
  return results.flatMap((r) => (r.ok ? [r.value] : []));
}

export function rejected(results: readonly Settled<unknown>[]): unknown[] {
  return results.flatMap((r) => (r.ok ? [] : [r.error]));
}

/**
 * One evidence line per case/iteration on stdout: `[DEC-12][TC-030] {...}`. Callers pass counts,
 * statuses and generated ids only — never URLs, credentials, tokens or personal data.
 */
export function evidence(tc: string, payload: Record<string, unknown>): void {
  process.stdout.write(`[DEC-12][${tc}] ${JSON.stringify(payload)}\n`);
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `check` until it returns true or `timeoutMs` elapses (returns the last result). */
export async function eventually(
  check: () => Promise<boolean>,
  timeoutMs = 5_000,
  intervalMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}
