/**
 * Reservation expiry job — BACKEND_STRUCTURE.md §7 ("Reservation expiry"), §14 (`reservation-expiry`,
 * every 1 min), PROJECT_CONTEXT §5 note 9. PROVISIONAL (OQ-17): 15-minute TTL.
 *
 * Exported function only — nothing is scheduled here (no Redis/BullMQ, D-38 / OQ-35):
 *
 *   const summary = await runReservationExpiry(container, { limit: 200 });
 *
 * Per order, in its own transaction (lock order row → inventory rows ascending):
 * - skipped when any payment of the order is captured (the capture path commits the stock);
 * - ACTIVE reservations past `expires_at` → EXPIRED + `RESERVATION_RELEASE` ledger rows;
 * - coupon usage RESERVED → RELEASED (`RESERVATION_EXPIRED`);
 * - PENDING payments → CANCELLED; order PENDING_PAYMENT → PAYMENT_FAILED (+ history, SYSTEM);
 * - PAYMENT_FAILED notification (deduped per payment attempt — not re-sent after a failure).
 *
 * GAP: the doc asks to query the gateway for a late capture before releasing; there is no
 * gateway "fetch by order" call yet (OQ-06). A late capture arriving afterwards is handled by the
 * capture service (OQ-59). Concurrent runs are safe (row lock + compare-and-set).
 */
import type { AppContainer } from '../container.js';
import { withTransaction } from '../core/db/transaction.js';
import {
  captureDepsFor,
  loadOrderCore,
  lockOrder,
  notifyOrder,
  RETRY_WINDOW_MINUTES,
  retryWindowEnd,
  SYSTEM_ORDER_ACTOR,
  transitionOrder,
} from '../modules/payments/index.js';

export interface ReservationExpiryOptions {
  /** Max orders per run (batch 200 per §14). */
  readonly limit?: number;
}

export interface ReservationExpirySummary {
  readonly scanned: number;
  readonly expired: number;
  readonly skippedCaptured: number;
  readonly failed: number;
}

export async function runReservationExpiry(
  container: AppContainer,
  options: ReservationExpiryOptions = {},
): Promise<ReservationExpirySummary> {
  const { db, clock, logger } = container;
  const deps = captureDepsFor(container);
  const now = clock();
  const due = await db.stockReservation.findMany({
    where: { status: 'ACTIVE', expiresAt: { lt: now } },
    select: { orderId: true },
    distinct: ['orderId'],
    orderBy: { expiresAt: 'asc' },
    take: options.limit ?? 200,
  });

  let expired = 0;
  let skippedCaptured = 0;
  let failed = 0;
  for (const { orderId } of due) {
    try {
      const outcome = await withTransaction(
        db,
        async ({ tx }) => {
          await lockOrder(tx, orderId);
          const order = await loadOrderCore(tx, orderId);
          if (order === null) return 'missing' as const;
          const captured = await tx.payment.count({
            where: { orderId, status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'] } },
          });
          if (captured > 0) return 'captured' as const;
          const stillDue = await tx.stockReservation.count({
            where: { orderId, status: 'ACTIVE', expiresAt: { lt: now } },
          });
          if (stillDue === 0) return 'noop' as const;

          await deps.inventory.releaseReservation(tx, orderId, 'EXPIRED');
          await deps.coupons.release(tx, orderId, 'RESERVATION_EXPIRED');
          await tx.payment.updateMany({
            where: { orderId, status: 'PENDING' },
            data: { status: 'CANCELLED', failureCode: 'RESERVATION_EXPIRED' },
          });
          if (order.status === 'PENDING_PAYMENT') {
            await transitionOrder(tx, {
              orderId,
              from: 'PENDING_PAYMENT',
              to: 'PAYMENT_FAILED',
              actor: SYSTEM_ORDER_ACTOR,
              now,
              note: 'Payment not received before the reservation expired.',
              data: { paymentStatus: 'CANCELLED' },
            });
            const latest = await tx.payment.findFirst({
              where: { orderId },
              select: { id: true },
              orderBy: { attemptNo: 'desc' },
            });
            await notifyOrder(tx, deps.notify, order, 'PAYMENT_FAILED', {
              discriminator: latest?.id,
              variables: {
                retryMinutes: RETRY_WINDOW_MINUTES,
                holdUntil: retryWindowEnd(order.placedAt).toISOString(),
              },
            });
          }
          return 'expired' as const;
        },
        { retryOnDeadlock: true },
      );
      if (outcome === 'expired') expired += 1;
      else if (outcome === 'captured') skippedCaptured += 1;
    } catch (error) {
      failed += 1;
      logger.error({ err: error, orderId, job: 'reservation-expiry' }, 'reservation expiry failed');
    }
  }
  const summary = { scanned: due.length, expired, skippedCaptured, failed };
  if (due.length > 0)
    logger.info({ job: 'reservation-expiry', ...summary }, 'reservation expiry run');
  return summary;
}
