/**
 * In-process job scheduler and token-cleanup job. Fake timers; MOCKED DB — no SQL runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '../../../src/core/logger/logger.js';
import { buildScheduledJobs } from '../../../src/jobs/registry.js';
import { createJobScheduler } from '../../../src/jobs/scheduler.js';
import { TOKEN_CLEANUP_BATCH, runTokenCleanup } from '../../../src/jobs/tokenCleanup.js';
import { buildModuleTestApp } from '../../helpers/container.js';
import { createMockDb } from '../../helpers/mockDb.js';
import { testConfig } from '../../helpers/testApp.js';

const logger = createLogger(testConfig());

describe('job scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs each job on its interval, never overlapping, and survives job errors', async () => {
    let release: (() => void) | undefined;
    const slow = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const failing = vi.fn(() => Promise.reject(new Error('boom')));
    const scheduler = createJobScheduler(
      [
        { name: 'slow', intervalMs: 1000, run: slow },
        { name: 'failing', intervalMs: 1000, run: failing },
      ],
      logger,
    );
    scheduler.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(slow).toHaveBeenCalledTimes(1);
    expect(failing).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(slow).toHaveBeenCalledTimes(1); // still in flight → skipped, not stacked
    expect(failing).toHaveBeenCalledTimes(4); // errors logged, schedule continues
    release?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect(slow).toHaveBeenCalledTimes(2);
    // stop() waits for the in-flight run (graceful shutdown) and cancels all timers.
    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    release?.();
    await stopping;
    expect(stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(failing).toHaveBeenCalledTimes(5);
  });

  it('validates job definitions and supports runNow', async () => {
    expect(() =>
      createJobScheduler(
        [
          { name: 'a', intervalMs: 1000, run: () => Promise.resolve() },
          { name: 'a', intervalMs: 1000, run: () => Promise.resolve() },
        ],
        logger,
      ),
    ).toThrow(/Duplicate job name/);
    expect(() =>
      createJobScheduler([{ name: 'b', intervalMs: 10, run: () => Promise.resolve() }], logger),
    ).toThrow(/intervalMs/);
    const run = vi.fn(() => Promise.resolve());
    const scheduler = createJobScheduler([{ name: 'c', intervalMs: 60_000, run }], logger);
    await expect(scheduler.runNow('c')).resolves.toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    await expect(scheduler.runNow('missing')).rejects.toThrow(/Unknown job/);
  });

  it('registers the documented jobs with their §14 intervals', () => {
    const { container } = buildModuleTestApp([]);
    const jobs = buildScheduledJobs(container).map((j) => [j.name, j.intervalMs]);
    expect(jobs).toEqual([
      ['reservation-expiry', 60_000],
      ['unpaid-order-cancel', 300_000],
      ['notification-dispatch', 15_000],
      ['payment-reconciliation', 900_000],
      ['shipment-tracking-poll', 1_800_000],
      ['promotion-activation', 60_000],
      ['best-seller-refresh', 86_400_000],
      ['rating-aggregate', 86_400_000],
      ['abandoned-carts', 3_600_000],
      ['token-cleanup', 86_400_000],
    ]);
  });
});

describe('synchronous throw from run() (IMP-09)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is logged as a failed run, does not escape, and the schedule continues', async () => {
    const log = createLogger(testConfig());
    const logError = vi.spyOn(log, 'error');
    const logInfo = vi.spyOn(log, 'info');
    const syncThrow = vi.fn((): Promise<unknown> => {
      throw new Error('sync boom');
    });
    const healthy = vi.fn(() => Promise.resolve('ok'));
    const scheduler = createJobScheduler(
      [
        { name: 'sync-throw', intervalMs: 1000, run: syncThrow },
        { name: 'healthy', intervalMs: 1000, run: healthy },
      ],
      log,
    );
    // runNow resolves (true = the run happened) instead of throwing synchronously.
    await expect(scheduler.runNow('sync-throw')).resolves.toBe(true);
    expect(logError).toHaveBeenCalledTimes(1);
    const [fields, message] = logError.mock.calls[0] as unknown as [
      { err: Error; job: string },
      string,
    ];
    expect(message).toBe('job run failed');
    expect(fields.job).toBe('sync-throw');
    expect(fields.err.message).toBe('sync boom');

    scheduler.start();
    expect(logInfo).toHaveBeenCalledWith(
      { jobs: ['sync-throw', 'healthy'] },
      'in-process job scheduler started (single dedicated worker process — D-61)',
    );
    await vi.advanceTimersByTimeAsync(3000);
    expect(syncThrow).toHaveBeenCalledTimes(4); // not left "in flight"; keeps being scheduled
    expect(healthy).toHaveBeenCalledTimes(3); // other jobs unaffected
    expect(logError).toHaveBeenCalledTimes(4);
    await scheduler.stop();
  });
});

describe('cooperative stop (Batch 9, WP-O2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stop() raises the run signal; a job that checks it finishes the current item, then returns', async () => {
    const processed: number[] = [];
    let releaseItem!: () => void;
    const job = {
      name: 'items',
      intervalMs: 1000,
      run: async (signal: AbortSignal) => {
        for (const item of [1, 2, 3]) {
          if (signal.aborted) return;
          await new Promise<void>((resolve) => {
            releaseItem = resolve;
          });
          processed.push(item); // the item in progress always completes
        }
      },
    };
    const scheduler = createJobScheduler([job], logger);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(1000); // item 1 in progress
    const stopping = scheduler.stop();
    releaseItem();
    await stopping;
    expect(processed).toEqual([1]);
  });
});

describe('token-cleanup job', () => {
  it('deletes expired/revoked tokens and keys in batches with the documented cut-offs', async () => {
    const { db, m } = createMockDb();
    const now = new Date('2026-11-20T00:00:00.000Z');
    const full = Array.from({ length: TOKEN_CLEANUP_BATCH }, (_, i) => ({ id: `r${String(i)}` }));
    m.refreshToken.findMany.mockResolvedValueOnce(full).mockResolvedValueOnce([{ id: 'last' }]);
    m.refreshToken.deleteMany
      .mockResolvedValueOnce({ count: TOKEN_CLEANUP_BATCH })
      .mockResolvedValueOnce({ count: 1 });
    m.verificationToken.findMany.mockResolvedValueOnce([{ id: 'v1' }]);
    m.verificationToken.deleteMany.mockResolvedValueOnce({ count: 1 });
    m.idempotencyKey.findMany.mockResolvedValueOnce([]);

    const summary = await runTokenCleanup({ db, clock: () => now });
    expect(summary).toEqual({
      refreshTokens: TOKEN_CLEANUP_BATCH + 1,
      verificationTokens: 1,
      idempotencyKeys: 0,
    });
    const refreshWhere = m.refreshToken.findMany.mock.calls[0]?.[0].where;
    expect(refreshWhere).toEqual({
      OR: [
        { expiresAt: { lt: new Date('2026-10-21T00:00:00.000Z') } },
        { revokedAt: { lt: new Date('2026-10-21T00:00:00.000Z') } },
      ],
    });
    expect(m.verificationToken.findMany.mock.calls[0]?.[0].where.OR[0]).toEqual({
      expiresAt: { lt: new Date('2026-11-13T00:00:00.000Z') },
    });
    expect(m.idempotencyKey.findMany.mock.calls[0]?.[0].where).toEqual({
      expiresAt: { lt: now },
    });
    expect(m.idempotencyKey.deleteMany).not.toHaveBeenCalled();
    expect(m.auditLog.deleteMany).not.toHaveBeenCalled();
  });
});
