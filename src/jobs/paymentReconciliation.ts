/**
 * Payment reconciliation job — BACKEND_STRUCTURE.md §14 (`payment-reconciliation`, every 15 min),
 * §16.4. PROVISIONAL (OQ-06): only the mock gateway exists; never run against a real gateway.
 *
 * Finds `payments` still `PENDING` more than 20 minutes after creation (lost client callback and
 * lost webhook), asks the gateway for the truth and applies it through the SAME capture / failure
 * service as `POST /payments/verify` and the webhook (`capturePayment` / `failPayment`, source
 * `RECONCILIATION`, actor SYSTEM). Order row lock + compare-and-set make it race-safe with a
 * webhook arriving at the same moment, and re-running it is a no-op (`ALREADY_CAPTURED`).
 *
 * - Known `providerPaymentId` → `fetchPayment`; otherwise `fetchOrderPayments` (optional adapter
 *   method). Neither available → counted `unverifiable`, left untouched.
 * - Any gateway payment CAPTURED → capture (amount check, OQ-59 late-capture refund). A refund job
 *   is executed only after commit.
 * - All gateway payments FAILED → fail. Nothing at the gateway, or PENDING/AUTHORIZED → untouched.
 * - One payment's error (gateway timeout, DB error) never stops the run.
 *
 * RD-10 (option B, approved 2026-11-20): `reservation-expiry` cancels PENDING payments when the
 * 15-minute reservation lapses, so a capture that reaches the gateway afterwards would otherwise be
 * found only by its webhook. The job therefore ALSO re-checks payments that are CANCELLED and were
 * last updated within the past 24 hours. `payments` has no `cancelled_at` column; `updated_at` is
 * the proxy (no schema change), so a later update of the row moves it inside or outside the window.
 * For those rows only a gateway CAPTURE is applied, through the existing late-capture path of
 * `capturePayment` (PAYMENT_FAILED order → confirm if stock is still free, else cancel + full
 * refund; CANCELLED order → full refund). A gateway FAILED / PENDING never changes them.
 *
 * D3 fairness: rows are read in id order after a cursor (`after`), returned as `nextCursor` and kept
 * by the registry between runs, so payments that stay unresolved (unverifiable, amount mismatch,
 * still processing) cannot starve newer ones. A short page resets the cursor (next run starts over).
 * D2: an amount mismatch is recorded once per gateway payment (capture service), not on every run.
 */
import type { AppContainer } from '../container.js';
import { withTransaction } from '../core/db/transaction.js';
import {
  isVerifiablePaymentProvider,
  type ProviderPaymentState,
  type VerifiablePaymentProvider,
} from '../integrations/payments/paymentProvider.js';
import {
  capturePayment,
  captureDepsFor,
  failPayment,
  SYSTEM_ORDER_ACTOR,
} from '../modules/payments/index.js';
import { withTimeout } from '../modules/payments/payments.policy.js';
import { runRefundJob } from '../modules/payments/payments.refunds.js';

/** §14: payments PENDING for longer than this are reconciled. */
export const RECONCILIATION_MIN_AGE_MINUTES = 20;
export const RECONCILIATION_BATCH = 100;
/** RD-10: CANCELLED payments updated within this window are re-checked for a late capture. */
export const LATE_CAPTURE_LOOKBACK_HOURS = 24;

export interface PaymentReconciliationOptions {
  readonly limit?: number;
  /** Resume after this payment id (D3 fairness cursor). */
  readonly after?: string | undefined;
  /** Cooperative stop (Batch 9, WP-O2): checked before each payment; the current one finishes. */
  readonly signal?: AbortSignal | undefined;
}

export interface PaymentReconciliationSummary {
  readonly scanned: number;
  /** Capture applied to a PENDING payment (includes OQ-59 outcomes). */
  readonly captured: number;
  /** RD-10: capture found at the gateway for a recently CANCELLED payment (late-capture path). */
  readonly lateCaptured: number;
  /** RD-10: recently CANCELLED payments with no capture at the gateway (left untouched). */
  readonly cancelledNoCapture: number;
  readonly failed: number;
  /** Gateway amount ≠ our amount: recorded once for staff review, order not confirmed. */
  readonly amountMismatch: number;
  /** A webhook/verify got there first (idempotent no-op). */
  readonly alreadySettled: number;
  readonly stillPending: number;
  readonly unverifiable: number;
  readonly errors: number;
  /** Cursor for the next run; `null` = start from the beginning. */
  readonly nextCursor: string | null;
}

interface DuePayment {
  readonly id: string;
  readonly orderId: string;
  readonly status: string;
  readonly providerOrderId: string | null;
  readonly providerPaymentId: string | null;
}

async function gatewayStates(
  gateway: VerifiablePaymentProvider,
  payment: DuePayment & { readonly providerOrderId: string },
): Promise<readonly ProviderPaymentState[] | null> {
  if (payment.providerPaymentId !== null) {
    return [
      await withTimeout(
        gateway.fetchPayment({
          providerOrderId: payment.providerOrderId,
          providerPaymentId: payment.providerPaymentId,
        }),
      ),
    ];
  }
  if (gateway.fetchOrderPayments === undefined) return null;
  return withTimeout(gateway.fetchOrderPayments(payment.providerOrderId));
}

export async function runPaymentReconciliation(
  container: AppContainer,
  options: PaymentReconciliationOptions = {},
): Promise<PaymentReconciliationSummary> {
  const { db, clock, logger } = container;
  const counts = {
    scanned: 0,
    captured: 0,
    lateCaptured: 0,
    cancelledNoCapture: 0,
    failed: 0,
    amountMismatch: 0,
    alreadySettled: 0,
    stillPending: 0,
    unverifiable: 0,
    errors: 0,
    nextCursor: null as string | null,
  };
  const gateway = container.providers.payment;
  if (!isVerifiablePaymentProvider(gateway)) {
    logger.warn('payment reconciliation skipped: the payment adapter cannot fetch payment status');
    return counts;
  }
  const deps = captureDepsFor(container);
  const now = clock();
  const cutoff = new Date(now.getTime() - RECONCILIATION_MIN_AGE_MINUTES * 60_000);
  const lookback = new Date(now.getTime() - LATE_CAPTURE_LOOKBACK_HOURS * 60 * 60_000);
  const limit = options.limit ?? RECONCILIATION_BATCH;
  const due: DuePayment[] = await db.payment.findMany({
    where: {
      provider: gateway.name,
      providerOrderId: { not: null },
      OR: [
        { status: 'PENDING', createdAt: { lt: cutoff } },
        { status: 'CANCELLED', updatedAt: { gte: lookback } },
      ],
      ...(options.after === undefined ? {} : { id: { gt: options.after } }),
    },
    select: {
      id: true,
      orderId: true,
      status: true,
      providerOrderId: true,
      providerPaymentId: true,
    },
    orderBy: { id: 'asc' },
    take: limit,
  });
  counts.nextCursor = due.length === limit ? (due.at(-1)?.id ?? null) : null;

  for (const payment of due) {
    if (options.signal?.aborted === true) {
      logger.info(
        { processed: counts.scanned, remaining: due.length - counts.scanned },
        'payment reconciliation stopping early (shutdown)',
      );
      break;
    }
    counts.scanned += 1;
    const providerOrderId = payment.providerOrderId;
    if (providerOrderId === null) continue;
    try {
      const states = await gatewayStates(gateway, { ...payment, providerOrderId });
      if (states === null) {
        counts.unverifiable += 1;
        continue;
      }
      const mine = states.filter((s) => s.providerOrderId === providerOrderId);
      const captured = mine.find((s) => s.status === 'CAPTURED');
      if (captured !== undefined) {
        const result = await withTransaction(
          db,
          async ({ tx }) =>
            capturePayment(deps, tx, {
              orderId: payment.orderId,
              providerOrderId,
              providerPaymentId: captured.providerPaymentId,
              amountMinor: captured.amountMinor,
              currency: captured.currency,
              method: captured.method,
              provider: gateway.name,
              source: 'RECONCILIATION',
              actor: SYSTEM_ORDER_ACTOR,
            }),
          { retryOnDeadlock: true },
        );
        await runRefundJob(container, result.refundJob);
        if (result.outcome === 'AMOUNT_MISMATCH') counts.amountMismatch += 1;
        else if (result.outcome === 'ALREADY_CAPTURED' || result.outcome === 'PAYMENT_NOT_FOUND') {
          counts.alreadySettled += 1;
        } else if (payment.status === 'CANCELLED') counts.lateCaptured += 1;
        else counts.captured += 1;
        continue;
      }
      if (payment.status === 'CANCELLED') {
        // RD-10: only a capture matters for a cancelled payment.
        counts.cancelledNoCapture += 1;
        continue;
      }
      const lastFailure = mine.at(-1);
      if (lastFailure !== undefined && mine.every((s) => s.status === 'FAILED')) {
        const result = await withTransaction(
          db,
          async ({ tx }) =>
            failPayment(deps, tx, {
              orderId: payment.orderId,
              providerOrderId,
              providerPaymentId: lastFailure.providerPaymentId,
              errorCode: lastFailure.errorCode,
              errorDescription: lastFailure.errorDescription,
              provider: gateway.name,
              source: 'RECONCILIATION',
              actor: SYSTEM_ORDER_ACTOR,
            }),
          { retryOnDeadlock: true },
        );
        if (result.outcome === 'FAILED') counts.failed += 1;
        else counts.alreadySettled += 1;
        continue;
      }
      counts.stillPending += 1;
    } catch (error) {
      counts.errors += 1;
      logger.error(
        { err: error, paymentId: payment.id, orderId: payment.orderId },
        'payment reconciliation failed for one payment (will retry next run)',
      );
    }
  }
  return counts;
}
