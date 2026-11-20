/**
 * Job registry — the BACKEND_STRUCTURE.md §14 jobs that have implementations, with their documented
 * intervals. Jobs not listed here are not implemented yet (see docs/PHASE4-JOBS-AND-SCHEDULING.md).
 */
import type { AppContainer } from '../container.js';
import { runAbandonedCarts } from './abandonedCarts.js';
import { runBestSellerRefresh, runRatingAggregate } from './catalogAggregates.js';
import { runNotificationDispatch } from './notificationDispatcher.js';
import { runPaymentReconciliation } from './paymentReconciliation.js';
import { runPromotionActivation } from './promotionActivation.js';
import { runReservationExpiry } from './reservationExpiry.js';
import type { ScheduledJob } from './scheduler.js';
import { runShipmentTrackingPoll } from './shipmentTrackingPoll.js';
import { runTokenCleanup } from './tokenCleanup.js';
import { runUnpaidOrderCancel } from './unpaidOrderCancel.js';

const MINUTE = 60_000;

export function buildScheduledJobs(container: AppContainer): ScheduledJob[] {
  // D3 / D4 fairness cursors: kept in memory between runs (single process, D-38); a restart simply
  // starts the rotation from the beginning again.
  let reconciliationCursor: string | undefined;
  let trackingCursor: Readonly<Record<string, string>> = {};
  return [
    {
      name: 'reservation-expiry',
      intervalMs: MINUTE,
      run: () => runReservationExpiry(container),
    },
    {
      name: 'unpaid-order-cancel',
      intervalMs: 5 * MINUTE,
      run: () => runUnpaidOrderCancel(container),
    },
    {
      // Dispatches due notifications and retries failed ones with remaining attempts
      // (covers `notification-retries`).
      name: 'notification-dispatch',
      intervalMs: 15_000,
      run: (signal) => runNotificationDispatch(container, { signal }),
    },
    {
      name: 'payment-reconciliation',
      intervalMs: 15 * MINUTE,
      run: async (signal) => {
        const summary = await runPaymentReconciliation(container, {
          after: reconciliationCursor,
          signal,
        });
        reconciliationCursor = summary.nextCursor ?? undefined;
        return summary;
      },
    },
    {
      // No-op unless an adapter implements `getTracking` (couriers without webhooks).
      name: 'shipment-tracking-poll',
      intervalMs: 30 * MINUTE,
      run: async (signal) => {
        const summary = await runShipmentTrackingPoll(container, {
          after: trackingCursor,
          signal,
        });
        trackingCursor = summary.nextCursor;
        return summary;
      },
    },
    {
      name: 'promotion-activation',
      intervalMs: MINUTE,
      run: () => runPromotionActivation(container),
    },
    {
      // §14 "nightly 02:00 IST": fixed 24 h interval from start-up (documented deviation).
      name: 'best-seller-refresh',
      intervalMs: 24 * 60 * MINUTE,
      initialDelayMs: 20 * MINUTE,
      run: () => runBestSellerRefresh(container),
    },
    {
      name: 'rating-aggregate',
      intervalMs: 24 * 60 * MINUTE,
      initialDelayMs: 30 * MINUTE,
      run: () => runRatingAggregate(container),
    },
    {
      // RD-08 option B: abandon after cart.abandon_after_days (30), purge 90 days later (§14 hourly).
      name: 'abandoned-carts',
      intervalMs: 60 * MINUTE,
      initialDelayMs: 15 * MINUTE,
      run: () => runAbandonedCarts(container),
    },
    {
      name: 'token-cleanup',
      intervalMs: 24 * 60 * MINUTE,
      initialDelayMs: 10 * MINUTE,
      run: () => runTokenCleanup({ db: container.db, clock: container.clock }),
    },
  ];
}
