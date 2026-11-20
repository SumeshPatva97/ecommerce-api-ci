/**
 * Payment capture / failure — the single domain service behind `POST /payments/verify`, the payment
 * webhook and (later) reconciliation. BACKEND_STRUCTURE.md §7 ("Payment captured"), §16.4 (race),
 * SECURITY_GUIDELINES.md §10.
 *
 * Race safety: every path runs inside ONE transaction that first locks the `orders` row FOR UPDATE.
 * Whichever of verify / webhook arrives first applies the capture; the other finds the payment
 * already CAPTURED and is a no-op (`ALREADY_CAPTURED`).
 *
 * Amount check: the gateway-reported amount (paise) and currency must equal the payment row
 * (= order grand total, server-computed). A mismatch never confirms the order: it is logged on
 * `payment_transactions` (`AMOUNT_MISMATCH`) for staff review and reported to the caller.
 *
 * PROVISIONAL (OQ-59): capture after the reservation expired → re-take stock if still free and
 * confirm; otherwise cancel the order and auto-refund in full. The refund is created through
 * `CaptureDeps.lateCaptureRefund` (wired by `captureDepsFor` to the refunds module's
 * `createRefundForOrder` + `prepareGatewayRefund`, status APPROVED by SYSTEM); the hook returns a
 * gateway job that the caller executes AFTER commit (`CaptureResult.refundJob`). Without a hook —
 * and always for a duplicate capture on an already-paid order — the requirement is recorded as a
 * `payment_transactions` row (`errorCode = REFUND_REQUIRED`) plus an error log flagged
 * `staffReview`; no money is moved automatically.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import type { PaymentTxnType } from '../../generated/prisma/enums.js';
import type { Queryable, TxClient } from '../../core/db/transaction.js';
import { AppError } from '../../core/errors/AppError.js';
import type { Logger } from '../../core/logger/logger.js';
import { dec, toMinorUnits, toMoneyString, type Decimal } from '../../lib/money.js';
import { redact } from '../../lib/redact.js';
import type { CouponsService } from '../coupons/index.js';
import type { InventoryService } from '../inventory/index.js';
import {
  loadOrderCore,
  lockOrder,
  notifyOrder,
  transitionOrder,
  type NotifyContext,
  type OrderActor,
  type OrderCore,
} from './payments.orders.js';
import { RETRY_WINDOW_MINUTES, retryWindowEnd } from './payments.policy.js';

export type CaptureSource = 'VERIFY' | 'WEBHOOK' | 'RECONCILIATION';

export type RefundReasonCode =
  'LATE_CAPTURE_STOCK_UNAVAILABLE' | 'CAPTURE_ON_CANCELLED_ORDER' | 'DUPLICATE_CAPTURE';

/** Post-commit gateway refund work (shape of the refunds module's `GatewayRefundJob`). */
export interface RefundJob {
  readonly refundId: string;
  readonly paymentId: string;
  readonly providerPaymentId: string;
  readonly amount: Decimal;
  readonly reason: string;
}

/**
 * Hook for the refunds module (OQ-59 auto-refund). Runs inside the capture transaction and returns
 * the gateway job to execute after commit (or `null` when no gateway call applies).
 */
export type LateCaptureRefundHook = (
  tx: TxClient,
  args: {
    readonly orderId: string;
    readonly paymentId: string;
    readonly amount: Decimal;
    readonly reasonCode: Exclude<RefundReasonCode, 'DUPLICATE_CAPTURE'>;
    readonly now: Date;
  },
) => Promise<RefundJob | null>;

export interface CaptureDeps {
  readonly clock: () => Date;
  readonly logger: Logger;
  readonly inventory: InventoryService;
  readonly coupons: CouponsService;
  readonly notify: NotifyContext;
  readonly lateCaptureRefund?: LateCaptureRefundHook | undefined;
}

export interface CaptureInput {
  readonly orderId: string;
  readonly providerOrderId: string;
  readonly providerPaymentId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly method?: string | null | undefined;
  readonly provider: string;
  readonly source: CaptureSource;
  readonly actor: OrderActor;
}

export type CaptureOutcome =
  | 'CAPTURED'
  | 'ALREADY_CAPTURED'
  | 'AMOUNT_MISMATCH'
  | 'PAYMENT_NOT_FOUND'
  | 'LATE_CAPTURE_CANCELLED'
  | 'CAPTURED_ON_CANCELLED_ORDER';

export interface PaymentStateView {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly orderStatus: OrderCore['status'];
  readonly paymentStatus: OrderCore['paymentStatus'];
  readonly grandTotal: Decimal;
  readonly placedAt: Date;
  readonly paidAt: Date | null;
}

export interface CaptureResult {
  readonly outcome: CaptureOutcome;
  readonly refundRequired: boolean;
  /** Gateway refund to run AFTER commit (refunds module `executeGatewayRefund`). */
  readonly refundJob: RefundJob | null;
  readonly state: PaymentStateView;
}

export interface FailureInput {
  readonly orderId: string;
  readonly providerOrderId: string;
  readonly providerPaymentId?: string | null | undefined;
  readonly errorCode: string | null;
  readonly errorDescription: string | null;
  readonly provider: string;
  readonly source: CaptureSource;
  readonly actor: OrderActor;
}

export type FailureOutcome = 'FAILED' | 'ALREADY_FAILED' | 'ALREADY_CAPTURED' | 'PAYMENT_NOT_FOUND';

export interface FailureResult {
  readonly outcome: FailureOutcome;
  readonly state: PaymentStateView;
}

const paymentSelect = {
  id: true,
  attemptNo: true,
  status: true,
  provider: true,
  providerOrderId: true,
  providerPaymentId: true,
  amount: true,
  capturedAt: true,
} satisfies Prisma.PaymentSelect;

type PaymentRow = Prisma.PaymentGetPayload<{ select: typeof paymentSelect }>;

const CAPTURED_STATES = new Set(['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED']);

export interface TxnRecord {
  readonly paymentId: string;
  readonly type: PaymentTxnType;
  readonly provider: string | null;
  readonly providerEventId?: string | null | undefined;
  readonly providerReference?: string | null | undefined;
  readonly providerStatus?: string | null | undefined;
  readonly amount?: Decimal | null | undefined;
  readonly signatureVerified?: boolean;
  readonly errorCode?: string | null | undefined;
  readonly errorMessage?: string | null | undefined;
  readonly requestPayload?: unknown;
  readonly responsePayload?: unknown;
  readonly now: Date;
}

function json(value: unknown): Prisma.InputJsonValue | undefined {
  return value === undefined || value === null
    ? undefined
    : (redact(value) as Prisma.InputJsonValue);
}

/** Appends one `payment_transactions` row (payloads redacted — no secrets or instrument data). */
export async function recordPaymentTxn(tx: Queryable, r: TxnRecord): Promise<void> {
  const request = json(r.requestPayload);
  const response = json(r.responsePayload);
  await tx.paymentTransaction.create({
    data: {
      paymentId: r.paymentId,
      type: r.type,
      provider: r.provider?.slice(0, 30) ?? null,
      providerEventId: r.providerEventId ?? null,
      providerReference: r.providerReference?.slice(0, 100) ?? null,
      providerStatus: r.providerStatus?.slice(0, 40) ?? null,
      amount: r.amount ?? null,
      signatureVerified: r.signatureVerified ?? false,
      errorCode: r.errorCode?.slice(0, 60) ?? null,
      errorMessage: r.errorMessage?.slice(0, 500) ?? null,
      ...(request === undefined ? {} : { requestPayload: request }),
      ...(response === undefined ? {} : { responsePayload: response }),
      createdAt: r.now,
    },
  });
}

function minorToDecimal(minor: number): Decimal {
  return dec(minor).dividedBy(100);
}

async function stateOf(tx: Queryable, orderId: string): Promise<PaymentStateView> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      paymentStatus: true,
      grandTotal: true,
      placedAt: true,
      payments: {
        where: { status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'] } },
        select: { capturedAt: true },
        orderBy: { attemptNo: 'desc' },
        take: 1,
      },
    },
  });
  if (order === null) throw new AppError('NOT_FOUND', 'Order not found.');
  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    orderStatus: order.status,
    paymentStatus: order.paymentStatus,
    grandTotal: order.grandTotal,
    placedAt: order.placedAt,
    paidAt: order.payments[0]?.capturedAt ?? null,
  };
}

/**
 * Commits ACTIVE reservations; lines no longer reserved (released by expiry) are deducted directly
 * when stock is still free. Throws `INSUFFICIENT_STOCK` when a released line cannot be re-taken.
 */
async function takeStock(deps: CaptureDeps, tx: Queryable, order: OrderCore): Promise<void> {
  const active = await tx.stockReservation.findMany({
    where: { orderId: order.id, status: 'ACTIVE' },
    select: { variantId: true, quantity: true },
  });
  await deps.inventory.commitReservation(tx, order.id);
  const covered = new Map(active.map((r) => [r.variantId, r.quantity]));
  const missing = order.items
    .map((item) => ({
      variantId: item.variantId,
      sku: item.sku,
      quantity: item.quantity - (covered.get(item.variantId) ?? 0),
    }))
    .filter((line) => line.quantity > 0);
  if (missing.length > 0) await deps.inventory.deductDirect(tx, missing, order.id);
}

/** Coupon REDEEMED; a usage released by expiry is re-reserved first (tolerant on late capture). */
async function redeemCoupon(
  deps: CaptureDeps,
  tx: Queryable,
  order: OrderCore,
  late: boolean,
): Promise<void> {
  if (order.couponId === null) return;
  try {
    if (late) {
      await deps.coupons.reserveUsage(
        tx,
        order.couponId,
        order.userId,
        order.id,
        order.couponDiscountTotal,
      );
    }
    await deps.coupons.redeem(tx, order.id);
  } catch (error) {
    if (!late || !(error instanceof AppError)) throw error;
    // The customer already paid the discounted total — never fail the capture over the coupon.
    deps.logger.warn(
      { orderId: order.id, couponId: order.couponId, code: error.code, staffReview: true },
      'late capture: coupon could not be re-redeemed',
    );
  }
}

async function requireRefund(
  deps: CaptureDeps,
  tx: TxClient,
  args: {
    order: OrderCore;
    payment: PaymentRow;
    provider: string;
    reasonCode: RefundReasonCode;
    now: Date;
  },
): Promise<RefundJob | null> {
  const hook = deps.lateCaptureRefund;
  if (hook !== undefined && args.reasonCode !== 'DUPLICATE_CAPTURE') {
    return hook(tx, {
      orderId: args.order.id,
      paymentId: args.payment.id,
      amount: args.payment.amount,
      reasonCode: args.reasonCode,
      now: args.now,
    });
  }
  await recordPaymentTxn(tx, {
    paymentId: args.payment.id,
    type: 'REFUND',
    provider: args.provider,
    providerStatus: 'refund_required',
    amount: args.payment.amount,
    errorCode: 'REFUND_REQUIRED',
    errorMessage: `${args.reasonCode}: full refund must be issued by staff.`,
    now: args.now,
  });
  deps.logger.error(
    {
      orderId: args.order.id,
      orderNumber: args.order.orderNumber,
      paymentId: args.payment.id,
      reasonCode: args.reasonCode,
      staffReview: true,
    },
    'captured payment needs a manual refund',
  );
  return null;
}

async function loadLocked(
  tx: Queryable,
  orderId: string,
): Promise<{ order: OrderCore; payments: PaymentRow[] }> {
  await lockOrder(tx, orderId);
  const order = await loadOrderCore(tx, orderId);
  if (order === null) throw new AppError('NOT_FOUND', 'Order not found.');
  const payments = await tx.payment.findMany({
    where: { orderId },
    select: paymentSelect,
    orderBy: { attemptNo: 'asc' },
  });
  return { order, payments };
}

/**
 * Applies a gateway-confirmed capture. Must be called inside a transaction; idempotent.
 * The caller has already verified the signature and fetched the state from the gateway.
 */
export async function capturePayment(
  deps: CaptureDeps,
  tx: TxClient,
  input: CaptureInput,
): Promise<CaptureResult> {
  const now = deps.clock();
  const { order, payments } = await loadLocked(tx, input.orderId);
  const payment = payments.find((p) => p.providerOrderId === input.providerOrderId);
  if (payment === undefined) {
    return {
      outcome: 'PAYMENT_NOT_FOUND',
      refundRequired: false,
      refundJob: null,
      state: await stateOf(tx, order.id),
    };
  }
  if (CAPTURED_STATES.has(payment.status)) {
    return {
      outcome: 'ALREADY_CAPTURED',
      refundRequired: false,
      refundJob: null,
      state: await stateOf(tx, order.id),
    };
  }

  const reported = minorToDecimal(input.amountMinor);
  if (input.amountMinor !== toMinorUnits(payment.amount) || input.currency !== 'INR') {
    // D2: a mismatch leaves the payment PENDING, so verify retries, webhook redeliveries and every
    // reconciliation run would see it again. Record it ONCE per (payment, gateway payment id).
    const alreadyRecorded = await tx.paymentTransaction.findFirst({
      where: {
        paymentId: payment.id,
        providerReference: input.providerPaymentId,
        errorCode: 'AMOUNT_MISMATCH',
      },
      select: { id: true },
    });
    if (alreadyRecorded !== null) {
      return {
        outcome: 'AMOUNT_MISMATCH',
        refundRequired: false,
        refundJob: null,
        state: await stateOf(tx, order.id),
      };
    }
    await recordPaymentTxn(tx, {
      paymentId: payment.id,
      type: 'CAPTURE',
      provider: input.provider,
      providerReference: input.providerPaymentId,
      providerStatus: 'captured',
      amount: reported,
      signatureVerified: true,
      errorCode: 'AMOUNT_MISMATCH',
      errorMessage: `Expected ${toMoneyString(payment.amount)} INR, gateway reported ${toMoneyString(reported)} ${input.currency}.`,
      responsePayload: { source: input.source, currency: input.currency },
      now,
    });
    deps.logger.error(
      { orderId: order.id, paymentId: payment.id, source: input.source, security: true },
      'payment amount mismatch — not confirming the order',
    );
    return {
      outcome: 'AMOUNT_MISMATCH',
      refundRequired: false,
      refundJob: null,
      state: await stateOf(tx, order.id),
    };
  }

  await tx.payment.update({
    where: { id: payment.id },
    data: {
      status: 'CAPTURED',
      providerPaymentId: input.providerPaymentId,
      capturedAt: now,
      failureCode: null,
      failureReason: null,
      ...(input.method === null || input.method === undefined
        ? {}
        : { instrumentType: input.method.slice(0, 30) }),
    },
    select: { id: true },
  });
  await recordPaymentTxn(tx, {
    paymentId: payment.id,
    type: 'CAPTURE',
    provider: input.provider,
    providerReference: input.providerPaymentId,
    providerStatus: 'captured',
    amount: reported,
    signatureVerified: true,
    responsePayload: { source: input.source, method: input.method ?? null },
    now,
  });

  const otherCaptured = payments.some((p) => p.id !== payment.id && CAPTURED_STATES.has(p.status));
  if (otherCaptured || order.status === 'CANCELLED') {
    // Money arrived for an order that is already paid or cancelled → full refund required.
    if (order.status === 'CANCELLED') {
      await tx.order.update({
        where: { id: order.id },
        data: { paymentStatus: 'CAPTURED' },
        select: { id: true },
      });
    }
    const refundJob = await requireRefund(deps, tx, {
      order,
      payment,
      provider: input.provider,
      reasonCode: otherCaptured ? 'DUPLICATE_CAPTURE' : 'CAPTURE_ON_CANCELLED_ORDER',
      now,
    });
    return {
      outcome: 'CAPTURED_ON_CANCELLED_ORDER',
      refundRequired: true,
      refundJob,
      state: await stateOf(tx, order.id),
    };
  }

  const confirmData = { paymentStatus: 'CAPTURED' as const, confirmedAt: now };
  if (order.status === 'PENDING_PAYMENT') {
    await takeStock(deps, tx, order);
    await redeemCoupon(deps, tx, order, false);
    await transitionOrder(tx, {
      orderId: order.id,
      from: 'PENDING_PAYMENT',
      to: 'CONFIRMED',
      actor: input.actor,
      now,
      note: 'Payment captured.',
      data: confirmData,
    });
  } else if (order.status === 'PAYMENT_FAILED') {
    // PROVISIONAL (OQ-59): late capture — confirm if stock is still free.
    let stockTaken = true;
    try {
      await takeStock(deps, tx, order);
    } catch (error) {
      if (!(error instanceof AppError && error.code === 'INSUFFICIENT_STOCK')) throw error;
      stockTaken = false;
    }
    if (!stockTaken) {
      await deps.inventory.restoreCancellation(tx, order.id);
      await deps.coupons.release(tx, order.id, 'PAYMENT_FAILED');
      await transitionOrder(tx, {
        orderId: order.id,
        from: 'PAYMENT_FAILED',
        to: 'CANCELLED',
        actor: input.actor,
        now,
        note: 'Payment received after the reservation expired and stock is no longer available.',
        data: {
          paymentStatus: 'CAPTURED',
          cancelledAt: now,
          cancellationReason: 'LATE_CAPTURE_STOCK_UNAVAILABLE',
        },
      });
      const refundJob = await requireRefund(deps, tx, {
        order,
        payment,
        provider: input.provider,
        reasonCode: 'LATE_CAPTURE_STOCK_UNAVAILABLE',
        now,
      });
      await notifyOrder(tx, deps.notify, order, 'ORDER_CANCELLED', {
        discriminator: payment.id,
        variables: {
          reason: 'Items became unavailable before your payment was received.',
          refundNote: 'A full refund will be issued to your original payment method.',
        },
      });
      return {
        outcome: 'LATE_CAPTURE_CANCELLED',
        refundRequired: true,
        refundJob,
        state: await stateOf(tx, order.id),
      };
    }
    await redeemCoupon(deps, tx, order, true);
    await transitionOrder(tx, {
      orderId: order.id,
      from: 'PAYMENT_FAILED',
      to: 'PENDING_PAYMENT',
      actor: input.actor,
      now,
      note: 'Late payment capture received.',
      isCustomerVisible: false,
    });
    await transitionOrder(tx, {
      orderId: order.id,
      from: 'PENDING_PAYMENT',
      to: 'CONFIRMED',
      actor: input.actor,
      now,
      note: 'Payment captured.',
      data: confirmData,
    });
  } else {
    await tx.order.update({
      where: { id: order.id },
      data: { paymentStatus: 'CAPTURED' },
      select: { id: true },
    });
  }

  await notifyOrder(tx, deps.notify, order, 'PAYMENT_SUCCEEDED', { discriminator: payment.id });
  await notifyOrder(tx, deps.notify, order, 'ORDER_CONFIRMED');
  return {
    outcome: 'CAPTURED',
    refundRequired: false,
    refundJob: null,
    state: await stateOf(tx, order.id),
  };
}

/**
 * Applies a gateway-confirmed failure: payment FAILED, order PENDING_PAYMENT → PAYMENT_FAILED.
 * Reservations and coupon usage are KEPT until the TTL so the customer can retry (API §5).
 */
export async function failPayment(
  deps: CaptureDeps,
  tx: Queryable,
  input: FailureInput,
): Promise<FailureResult> {
  const now = deps.clock();
  const { order, payments } = await loadLocked(tx, input.orderId);
  const payment = payments.find((p) => p.providerOrderId === input.providerOrderId);
  if (payment === undefined) {
    return { outcome: 'PAYMENT_NOT_FOUND', state: await stateOf(tx, order.id) };
  }
  if (CAPTURED_STATES.has(payment.status)) {
    return { outcome: 'ALREADY_CAPTURED', state: await stateOf(tx, order.id) };
  }
  if (payment.status === 'FAILED') {
    return { outcome: 'ALREADY_FAILED', state: await stateOf(tx, order.id) };
  }
  await tx.payment.update({
    where: { id: payment.id },
    data: {
      status: 'FAILED',
      failedAt: now,
      failureCode: input.errorCode?.slice(0, 60) ?? 'PAYMENT_FAILED',
      failureReason: input.errorDescription?.slice(0, 500) ?? null,
      ...(input.providerPaymentId === null || input.providerPaymentId === undefined
        ? {}
        : { providerPaymentId: input.providerPaymentId }),
    },
    select: { id: true },
  });
  await recordPaymentTxn(tx, {
    paymentId: payment.id,
    type: 'FAIL',
    provider: input.provider,
    providerReference: input.providerPaymentId ?? null,
    providerStatus: 'failed',
    signatureVerified: true,
    errorCode: input.errorCode,
    errorMessage: input.errorDescription,
    responsePayload: { source: input.source },
    now,
  });
  if (order.status === 'PENDING_PAYMENT') {
    await transitionOrder(tx, {
      orderId: order.id,
      from: 'PENDING_PAYMENT',
      to: 'PAYMENT_FAILED',
      actor: input.actor,
      now,
      note: 'Payment failed.',
      data: { paymentStatus: 'FAILED' },
    });
    await notifyOrder(tx, deps.notify, order, 'PAYMENT_FAILED', {
      discriminator: payment.id,
      variables: {
        retryMinutes: RETRY_WINDOW_MINUTES,
        holdUntil: retryWindowEnd(order.placedAt).toISOString(),
      },
    });
  }
  return { outcome: 'FAILED', state: await stateOf(tx, order.id) };
}
