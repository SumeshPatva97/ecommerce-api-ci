/**
 * Job registry wiring (WP10-1 / IMP-01, audit M-2): the registry — not the jobs — keeps the D3 / D4
 * fairness cursors between runs and hands the scheduler's stop signal to the long jobs (WP-O2).
 * The job modules are MOCKED: only `src/jobs/registry.ts` and the real scheduler run here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppContainer } from '../../../src/container.js';
import { createLogger } from '../../../src/core/logger/logger.js';
import { runNotificationDispatch } from '../../../src/jobs/notificationDispatcher.js';
import { runPaymentReconciliation } from '../../../src/jobs/paymentReconciliation.js';
import { buildScheduledJobs } from '../../../src/jobs/registry.js';
import { createJobScheduler } from '../../../src/jobs/scheduler.js';
import { runShipmentTrackingPoll } from '../../../src/jobs/shipmentTrackingPoll.js';
import { testConfig } from '../../helpers/testApp.js';

vi.mock('../../../src/jobs/paymentReconciliation.js', () => ({
  runPaymentReconciliation: vi.fn(),
}));
vi.mock('../../../src/jobs/shipmentTrackingPoll.js', () => ({
  runShipmentTrackingPoll: vi.fn(),
}));
vi.mock('../../../src/jobs/notificationDispatcher.js', () => ({
  runNotificationDispatch: vi.fn(),
}));

const reconcile = vi.mocked(runPaymentReconciliation);
const trackingPoll = vi.mocked(runShipmentTrackingPoll);
const dispatch = vi.mocked(runNotificationDispatch);

/** The mocked jobs never touch the container; a sentinel proves it is passed through unchanged. */
const container = { sentinel: 'container' } as unknown as AppContainer;
const logger = createLogger(testConfig());

/** Only the fields the registry reads matter; the rest of the summary is opaque to it. */
const reconSummary = (nextCursor: string | null) =>
  ({ nextCursor }) as unknown as Awaited<ReturnType<typeof runPaymentReconciliation>>;
const trackingSummary = (nextCursor: Readonly<Record<string, string>>) =>
  ({ nextCursor }) as unknown as Awaited<ReturnType<typeof runShipmentTrackingPoll>>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('registry cursor carry-over (D3 / D4)', () => {
  it('payment-reconciliation: run N+1 receives the nextCursor returned by run N', async () => {
    reconcile
      .mockResolvedValueOnce(reconSummary('pay-100'))
      .mockResolvedValueOnce(reconSummary('pay-200'))
      .mockResolvedValueOnce(reconSummary(null))
      .mockResolvedValueOnce(reconSummary(null));
    const scheduler = createJobScheduler(buildScheduledJobs(container), logger);
    for (let i = 0; i < 4; i += 1) {
      await expect(scheduler.runNow('payment-reconciliation')).resolves.toBe(true);
    }
    const afters = reconcile.mock.calls.map((c) => c[1]?.after);
    // First run starts from the beginning; a null cursor (rotation finished) restarts it.
    expect(afters).toEqual([undefined, 'pay-100', 'pay-200', undefined]);
    expect(reconcile.mock.calls.every((c) => c[0] === container)).toBe(true);
    await scheduler.stop();
  });

  it('shipment-tracking-poll: run N+1 receives the per-courier cursor map returned by run N', async () => {
    const first = { shiprocket: 'shp-10' };
    const second = { shiprocket: 'shp-20', delhivery: 'dlv-5' };
    trackingPoll
      .mockResolvedValueOnce(trackingSummary(first))
      .mockResolvedValueOnce(trackingSummary(second))
      .mockResolvedValueOnce(trackingSummary({}));
    const scheduler = createJobScheduler(buildScheduledJobs(container), logger);
    for (let i = 0; i < 3; i += 1) {
      await expect(scheduler.runNow('shipment-tracking-poll')).resolves.toBe(true);
    }
    const afters = trackingPoll.mock.calls.map((c) => c[1]?.after);
    expect(afters).toEqual([{}, first, second]);
    expect(afters[1]).toBe(first); // the exact object returned, not a reset
    expect(trackingPoll.mock.calls.every((c) => c[0] === container)).toBe(true);
    await scheduler.stop();
  });

  it('each buildScheduledJobs call has its own cursors (no leakage between registries)', async () => {
    reconcile.mockResolvedValue(reconSummary('pay-999'));
    const a = buildScheduledJobs(container).find((j) => j.name === 'payment-reconciliation');
    const b = buildScheduledJobs(container).find((j) => j.name === 'payment-reconciliation');
    const signal = new AbortController().signal;
    await a?.run(signal);
    await b?.run(signal);
    expect(reconcile.mock.calls.map((c) => c[1]?.after)).toEqual([undefined, undefined]);
  });
});

describe('registry stop-signal hand-off (WP-O2)', () => {
  it("the scheduler's AbortSignal reaches the three long jobs and is aborted by stop()", async () => {
    reconcile.mockResolvedValue(reconSummary(null));
    trackingPoll.mockResolvedValue(trackingSummary({}));
    dispatch.mockResolvedValue(undefined as unknown as Awaited<ReturnType<typeof dispatch>>);
    const scheduler = createJobScheduler(buildScheduledJobs(container), logger);
    await scheduler.runNow('notification-dispatch');
    await scheduler.runNow('payment-reconciliation');
    await scheduler.runNow('shipment-tracking-poll');

    const signals = [
      dispatch.mock.calls[0]?.[1]?.signal,
      reconcile.mock.calls[0]?.[1]?.signal,
      trackingPoll.mock.calls[0]?.[1]?.signal,
    ];
    for (const signal of signals) {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
    }
    // One scheduler-wide signal, shared by all three.
    expect(signals[1]).toBe(signals[0]);
    expect(signals[2]).toBe(signals[0]);
    expect(dispatch.mock.calls[0]?.[0]).toBe(container);

    await scheduler.stop();
    for (const signal of signals) expect(signal?.aborted).toBe(true);
  });

  it('passes exactly the signal given to run() (direct registry call)', async () => {
    reconcile.mockResolvedValue(reconSummary(null));
    trackingPoll.mockResolvedValue(trackingSummary({}));
    dispatch.mockResolvedValue(undefined as unknown as Awaited<ReturnType<typeof dispatch>>);
    const jobs = buildScheduledJobs(container);
    const controller = new AbortController();
    for (const name of [
      'notification-dispatch',
      'payment-reconciliation',
      'shipment-tracking-poll',
    ]) {
      await jobs.find((j) => j.name === name)?.run(controller.signal);
    }
    expect(dispatch.mock.calls[0]?.[1]).toEqual({ signal: controller.signal });
    expect(reconcile.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    expect(trackingPoll.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });
});
