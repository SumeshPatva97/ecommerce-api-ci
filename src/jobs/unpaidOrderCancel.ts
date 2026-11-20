/**
 * Unpaid order auto-cancel job — BACKEND_STRUCTURE.md §14 (`unpaid-order-cancel`, every 5 min),
 * API_DOCUMENTATION.md §3.9 retry-payment, PROJECT_CONTEXT §15 R-06.
 *
 * PROVISIONAL (OQ-58): an ONLINE order still `PENDING_PAYMENT` / `PAYMENT_FAILED` is cancelled
 * once the retry window (60 min from placement) has closed, or earlier when it is
 * `PAYMENT_FAILED` with all 3 payment attempts used. Exported function only (not scheduled):
 *
 *   const summary = await runUnpaidOrderCancel(container, { limit: 200 });
 *
 * Per order, in its own transaction (order row locked first):
 * - skipped when a payment is captured, or while an unexpired ACTIVE reservation exists (a capture
 *   may still be in flight; the reservation-expiry job runs first);
 * - PENDING_PAYMENT → PAYMENT_FAILED → CANCELLED (both edges via the state machine), remaining
 *   reservations released, coupon usage released, PENDING payments → CANCELLED;
 * - ORDER_CANCELLED notification.
 */
import type { AppContainer } from '../container.js';
import { withTransaction } from '../core/db/transaction.js';
import { addMinutes } from '../lib/time.js';
import {
  captureDepsFor,
  loadOrderCore,
  lockOrder,
  MAX_PAYMENT_ATTEMPTS,
  notifyOrder,
  RETRY_WINDOW_MINUTES,
  SYSTEM_ORDER_ACTOR,
  transitionOrder,
} from '../modules/payments/index.js';

export interface UnpaidOrderCancelOptions {
  readonly limit?: number;
}

export interface UnpaidOrderCancelSummary {
  readonly scanned: number;
  readonly cancelled: number;
  readonly skipped: number;
  readonly failed: number;
}

const CAPTURED = ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'] as const;

export async function runUnpaidOrderCancel(
  container: AppContainer,
  options: UnpaidOrderCancelOptions = {},
): Promise<UnpaidOrderCancelSummary> {
  const { db, clock, logger } = container;
  const deps = captureDepsFor(container);
  const now = clock();
  const limit = options.limit ?? 200;
  const cutoff = addMinutes(now, -RETRY_WINDOW_MINUTES);

  const [windowClosed, failedEarly] = await Promise.all([
    db.order.findMany({
      where: {
        paymentMethod: 'ONLINE',
        status: { in: ['PENDING_PAYMENT', 'PAYMENT_FAILED'] },
        placedAt: { lte: cutoff },
      },
      select: { id: true },
      orderBy: { placedAt: 'asc' },
      take: limit,
    }),
    db.order.findMany({
      where: { paymentMethod: 'ONLINE', status: 'PAYMENT_FAILED', placedAt: { gt: cutoff } },
      select: { id: true, payments: { select: { status: true } } },
      orderBy: { placedAt: 'asc' },
      take: limit,
    }),
  ]);
  const exhausted = failedEarly.filter(
    (o) =>
      o.payments.length >= MAX_PAYMENT_ATTEMPTS && !o.payments.some((p) => p.status === 'PENDING'),
  );
  const ids = [...new Set([...windowClosed, ...exhausted].map((o) => o.id))];

  let cancelled = 0;
  let skipped = 0;
  let failed = 0;
  for (const orderId of ids) {
    try {
      const outcome = await withTransaction(
        db,
        async ({ tx }) => {
          await lockOrder(tx, orderId);
          const order = await loadOrderCore(tx, orderId);
          if (order === null) return 'skipped' as const;
          if (order.status !== 'PENDING_PAYMENT' && order.status !== 'PAYMENT_FAILED') {
            return 'skipped' as const;
          }
          const [captured, inFlight] = await Promise.all([
            tx.payment.count({ where: { orderId, status: { in: [...CAPTURED] } } }),
            tx.stockReservation.count({
              where: { orderId, status: 'ACTIVE', expiresAt: { gt: now } },
            }),
          ]);
          if (captured > 0 || inFlight > 0) return 'skipped' as const;

          let from = order.status;
          if (from === 'PENDING_PAYMENT') {
            await transitionOrder(tx, {
              orderId,
              from,
              to: 'PAYMENT_FAILED',
              actor: SYSTEM_ORDER_ACTOR,
              now,
              note: 'Payment window closed.',
              isCustomerVisible: false,
            });
            from = 'PAYMENT_FAILED';
          }
          await deps.inventory.releaseReservation(tx, orderId, 'CANCELLED');
          await deps.coupons.release(tx, orderId, 'PAYMENT_FAILED');
          await tx.payment.updateMany({
            where: { orderId, status: 'PENDING' },
            data: { status: 'CANCELLED', failureCode: 'PAYMENT_WINDOW_CLOSED' },
          });
          await transitionOrder(tx, {
            orderId,
            from,
            to: 'CANCELLED',
            actor: SYSTEM_ORDER_ACTOR,
            now,
            note: 'Cancelled automatically: payment was not completed in time.',
            data: {
              cancelledAt: now,
              cancellationReason: 'PAYMENT_NOT_COMPLETED',
              paymentStatus: order.paymentStatus === 'FAILED' ? 'FAILED' : 'CANCELLED',
            },
          });
          await notifyOrder(tx, deps.notify, order, 'ORDER_CANCELLED', {
            variables: { reason: 'Payment was not completed in time.' },
          });
          return 'cancelled' as const;
        },
        { retryOnDeadlock: true },
      );
      if (outcome === 'cancelled') cancelled += 1;
      else skipped += 1;
    } catch (error) {
      failed += 1;
      logger.error({ err: error, orderId, job: 'unpaid-order-cancel' }, 'auto-cancel failed');
    }
  }
  const summary = { scanned: ids.length, cancelled, skipped, failed };
  if (ids.length > 0) logger.info({ job: 'unpaid-order-cancel', ...summary }, 'auto-cancel run');
  return summary;
}
