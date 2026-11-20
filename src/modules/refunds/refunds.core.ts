/**
 * Refund primitives shared by the refunds admin service, order cancellation and the checkout /
 * payments module (late capture, OQ-59) — API_DOCUMENTATION.md §4.11, ADMIN_WORKFLOWS.md §11,
 * ORDER_PAYMENT_AND_REFUND_DATABASE_DESIGN.md §7.
 *
 * - `createRefundForOrder(tx, …)`: computes amounts server-side from the order snapshot (line
 *   totals already net of promotion/coupon — §11.3) and inserts `refunds` + `refund_items` with a
 *   `RFD-YYMMDD-NNNNN` number. `status: 'APPROVED'` is the auto-approval path (customer
 *   self-cancel of a CONFIRMED prepaid order — R-16; late capture — OQ-59).
 * - `prepareGatewayRefund(tx, …)` marks a refund PROCESSING inside the caller's transaction and
 *   returns the gateway job; `executeGatewayRefund(…)` runs the provider call AFTER commit and a
 *   second transaction records the result (no network call inside a DB transaction).
 * - `markRefundCompleted(tx, …)`: COMPLETED + `payments.amount_refunded` / status,
 *   `orders.refunded_total` / `payment_status`, `order_items.quantity_refunded`,
 *   `REFUND_COMPLETED` notification. Idempotent (the payments webhook may call it).
 *
 * PROVISIONAL (OQ-13): STORE_CREDIT is rejected; COD orders refund by BANK_TRANSFER only.
 * PROVISIONAL (OQ-63): no bank details are received or stored (no encrypted column exists).
 * Refund-level `taxable_value`/`tax_amount` cover goods lines only; the shipping share's tax is
 * reversed through the credit note (when invoiced).
 */
import { randomUUID } from 'node:crypto';

import { allocateNumber } from '../../core/db/sequences.js';
import { withTransaction, type DbClient, type TxClient } from '../../core/db/transaction.js';
import { AppError } from '../../core/errors/AppError.js';
import type { Logger } from '../../core/logger/logger.js';
import type { ActorType, RefundMethod, RefundStatus } from '../../generated/prisma/enums.js';
import type {
  PaymentProviderAdapter,
  PaymentRefundResult,
} from '../../integrations/payments/paymentProvider.js';
import {
  ZERO,
  dec,
  maxDec,
  roundMoney,
  sum,
  toMinorUnits,
  toMoneyString,
  type Decimal,
} from '../../lib/money.js';
import {
  METHOD_LABELS,
  ORDER_CONTACT_SELECT,
  notifyOrderEvent,
  type NotifyContext,
} from './refunds.notify.js';

const PAID_PAYMENT_STATUSES = ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'] as const;

export interface RefundLineRequest {
  readonly orderItemId: string;
  readonly quantity: number;
  readonly restock?: boolean | undefined;
}

export interface CreateRefundForOrderInput {
  readonly orderId: string;
  readonly now: Date;
  readonly requestedBy: { readonly type: ActorType; readonly userId?: string | null | undefined };
  /** `APPROVED` = auto-approved (R-16 self-cancel, OQ-59 late capture); default `REQUESTED`. */
  readonly status?: 'REQUESTED' | 'APPROVED';
  readonly method?: RefundMethod | undefined;
  readonly reasonCode: string;
  readonly reasonText?: string | null | undefined;
  /** Omitted = full refund of everything still refundable. */
  readonly items?: readonly RefundLineRequest[] | undefined;
  /** Partial refunds only: shipping/charges amount to add. */
  readonly shippingAmount?: Decimal | undefined;
  /** Client-sent amount; must equal the computed amount (422 `AMOUNT_MISMATCH`). */
  readonly expectedAmount?: Decimal | undefined;
  /** Refund against this payment attempt (late capture, OQ-59); default: latest paid attempt. */
  readonly paymentId?: string | undefined;
}

export interface CreatedRefund {
  readonly id: string;
  readonly refundNumber: string;
  readonly status: RefundStatus;
  readonly method: RefundMethod;
  readonly amount: Decimal;
  readonly paymentId: string | null;
}

function invalid(code: string, message: string, field?: string): AppError {
  return new AppError('VALIDATION_ERROR', message, {
    details: [{ ...(field === undefined ? {} : { field }), code, message }],
  });
}

interface PlannedLine {
  orderItemId: string;
  quantity: number;
  amount: Decimal;
  taxAmount: Decimal;
}

/** Creates a refund (and its lines) inside the caller's transaction. */
export async function createRefundForOrder(
  tx: TxClient,
  input: CreateRefundForOrderInput,
): Promise<CreatedRefund> {
  const order = await tx.order.findUnique({
    where: { id: input.orderId },
    select: {
      id: true,
      status: true,
      paymentMethod: true,
      paymentStatus: true,
      grandTotal: true,
      items: {
        select: { id: true, quantity: true, lineTotal: true, taxAmount: true },
        orderBy: { lineNo: 'asc' },
      },
      payments: {
        where: { status: { in: [...PAID_PAYMENT_STATUSES] } },
        orderBy: { attemptNo: 'desc' },
        select: { id: true, amount: true },
      },
    },
  });
  if (order === null) throw new AppError('NOT_FOUND', 'Order not found.');

  const paidPayments =
    input.paymentId === undefined
      ? order.payments
      : order.payments.filter((p) => p.id === input.paymentId);
  const codPaid =
    order.paymentMethod === 'COD' &&
    (PAID_PAYMENT_STATUSES as readonly string[]).includes(order.paymentStatus);
  if (paidPayments.length === 0 && !codPaid) {
    throw invalid('ORDER_NOT_PAID', 'This order has no captured payment to refund.', 'orderId');
  }
  const paidCap =
    paidPayments.length > 0 ? sum(paidPayments.map((p) => p.amount)) : dec(order.grandTotal);

  // Method (OQ-13).
  const method: RefundMethod =
    input.method ?? (order.paymentMethod === 'COD' ? 'BANK_TRANSFER' : 'ORIGINAL_PAYMENT_METHOD');
  if (method === 'STORE_CREDIT') {
    throw invalid('METHOD_NOT_SUPPORTED', 'Store credit refunds are not available.', 'method');
  }
  if (order.paymentMethod === 'COD' && method !== 'BANK_TRANSFER') {
    throw invalid('METHOD_NOT_ALLOWED', 'COD orders are refunded by bank transfer.', 'method');
  }

  const prior = await tx.refund.findMany({
    where: { orderId: order.id, status: { not: 'REJECTED' } },
    select: {
      amount: true,
      shippingAmount: true,
      items: { select: { orderItemId: true, quantity: true, amount: true, taxAmount: true } },
    },
  });
  const priorTotal = sum(prior.map((r) => r.amount));
  const priorShipping = sum(prior.map((r) => r.shippingAmount));
  const priorLines = prior.flatMap((r) => r.items);
  const priorOf = (itemId: string) => {
    const rows = priorLines.filter((l) => l.orderItemId === itemId);
    return {
      quantity: rows.reduce((acc, l) => acc + l.quantity, 0),
      amount: sum(rows.map((l) => l.amount)),
      taxAmount: sum(rows.map((l) => l.taxAmount)),
    };
  };
  const refundableTotal = paidCap.minus(priorTotal);
  const itemsTotal = sum(order.items.map((i) => i.lineTotal));
  const shippingCap = maxDec(ZERO, maxDec(ZERO, paidCap.minus(itemsTotal)).minus(priorShipping));

  const lines: PlannedLine[] = [];
  let shippingAmount: Decimal;
  if (input.items === undefined) {
    for (const item of order.items) {
      const p = priorOf(item.id);
      const remainingQty = item.quantity - p.quantity;
      if (remainingQty <= 0) continue;
      lines.push({
        orderItemId: item.id,
        quantity: remainingQty,
        amount: dec(item.lineTotal).minus(p.amount),
        taxAmount: dec(item.taxAmount).minus(p.taxAmount),
      });
    }
    shippingAmount = maxDec(ZERO, refundableTotal.minus(sum(lines.map((l) => l.amount))));
  } else {
    const seen = new Set<string>();
    input.items.forEach((req, index) => {
      const field = `items[${String(index)}]`;
      if (seen.has(req.orderItemId)) {
        throw invalid('DUPLICATE_LINE', 'Each order line may appear once.', field);
      }
      seen.add(req.orderItemId);
      const item = order.items.find((i) => i.id === req.orderItemId);
      if (item === undefined) {
        throw invalid('UNKNOWN_ORDER_ITEM', 'The line does not belong to this order.', field);
      }
      const p = priorOf(item.id);
      const remainingQty = item.quantity - p.quantity;
      if (req.quantity > remainingQty) {
        throw new AppError('VALIDATION_ERROR', 'Quantity exceeds the refundable quantity.', {
          details: [
            {
              field: `${field}.quantity`,
              code: 'QUANTITY_EXCEEDS_REFUNDABLE',
              message: 'Quantity exceeds the refundable quantity.',
              meta: { refundable: remainingQty },
            },
          ],
        });
      }
      const final = req.quantity === remainingQty;
      const fraction = dec(req.quantity).dividedBy(item.quantity);
      lines.push({
        orderItemId: item.id,
        quantity: req.quantity,
        amount: final
          ? dec(item.lineTotal).minus(p.amount)
          : roundMoney(dec(item.lineTotal).times(fraction)),
        taxAmount: final
          ? dec(item.taxAmount).minus(p.taxAmount)
          : roundMoney(dec(item.taxAmount).times(fraction)),
      });
    });
    shippingAmount = roundMoney(input.shippingAmount ?? ZERO);
    if (shippingAmount.greaterThan(shippingCap)) {
      throw invalid(
        'SHIPPING_EXCEEDS_CHARGED',
        `Shipping refund cannot exceed ${toMoneyString(shippingCap)}.`,
        'shippingRefund',
      );
    }
  }

  const itemsAmount = sum(lines.map((l) => l.amount));
  const amount = itemsAmount.plus(shippingAmount);
  if (!amount.greaterThan(0)) {
    throw invalid('NOTHING_TO_REFUND', 'Nothing is left to refund on this order.', 'orderId');
  }
  if (amount.greaterThan(refundableTotal)) {
    throw invalid(
      'REFUND_EXCEEDS_PAID',
      `Refunds cannot exceed the amount paid (${toMoneyString(refundableTotal)} left).`,
      'amount',
    );
  }
  if (input.expectedAmount !== undefined && !roundMoney(input.expectedAmount).equals(amount)) {
    throw new AppError('VALIDATION_ERROR', 'The amount does not match the computed refund.', {
      details: [
        {
          field: 'amount',
          code: 'AMOUNT_MISMATCH',
          message: 'The amount does not match the computed refund.',
          meta: { computed: toMoneyString(amount) },
        },
      ],
    });
  }
  const taxAmount = sum(lines.map((l) => l.taxAmount));
  const status = input.status ?? 'REQUESTED';
  const id = randomUUID();
  const refundNumber = await allocateNumber(tx, 'REFUND', input.now);
  const paymentId = paidPayments[0]?.id ?? null;
  await tx.refund.create({
    data: {
      id,
      refundNumber,
      orderId: order.id,
      paymentId,
      status,
      method,
      reasonCode: input.reasonCode.slice(0, 40),
      reasonText: input.reasonText?.slice(0, 1000) ?? null,
      itemsAmount,
      shippingAmount,
      amount,
      taxableValue: itemsAmount.minus(taxAmount),
      taxAmount,
      // Informational only: a refund never moves stock (ADMIN_WORKFLOWS §11.3).
      restock: input.items?.some((l) => l.restock === true) ?? false,
      requestedByType: input.requestedBy.type,
      requestedById: input.requestedBy.userId ?? null,
      ...(status === 'APPROVED' ? { approvedAt: input.now } : {}),
      createdAt: input.now,
    },
  });
  if (lines.length > 0) {
    await tx.refundItem.createMany({
      data: lines.map((l) => ({
        id: randomUUID(),
        refundId: id,
        orderItemId: l.orderItemId,
        quantity: l.quantity,
        amount: l.amount,
        taxableValue: l.amount.minus(l.taxAmount),
        taxAmount: l.taxAmount,
      })),
    });
  }
  return { id, refundNumber, status, method, amount, paymentId };
}

export interface GatewayRefundJob {
  readonly refundId: string;
  readonly paymentId: string;
  readonly providerPaymentId: string;
  readonly amount: Decimal;
  readonly reason: string;
}

/**
 * APPROVED (or FAILED on retry) → PROCESSING for gateway refunds (original method with a captured
 * provider payment). Returns `null` when no gateway call applies (bank transfer / no provider id).
 */
export async function prepareGatewayRefund(
  tx: TxClient,
  refundId: string,
  now: Date,
): Promise<GatewayRefundJob | null> {
  const refund = await tx.refund.findUnique({
    where: { id: refundId },
    select: {
      id: true,
      status: true,
      method: true,
      amount: true,
      reasonCode: true,
      payment: { select: { id: true, providerPaymentId: true } },
    },
  });
  if (refund === null) return null;
  if (refund.method !== 'ORIGINAL_PAYMENT_METHOD') return null;
  if (refund.status !== 'APPROVED' && refund.status !== 'FAILED') return null;
  const providerPaymentId = refund.payment?.providerPaymentId ?? null;
  if (refund.payment === null || providerPaymentId === null) return null;
  await tx.refund.update({
    where: { id: refund.id },
    data: { status: 'PROCESSING', processingAt: now, failureReason: null },
  });
  return {
    refundId: refund.id,
    paymentId: refund.payment.id,
    providerPaymentId,
    amount: dec(refund.amount),
    reason: refund.reasonCode,
  };
}

export interface RefundCompletion {
  readonly refundId: string;
  readonly now: Date;
  readonly providerRefundId?: string | null | undefined;
  /** UTR / payout reference for manual completion (R-13). */
  readonly payoutReference?: string | null | undefined;
}

/** Marks a refund COMPLETED and rolls the amount up to payment and order. Idempotent. */
export async function markRefundCompleted(
  tx: TxClient,
  ctx: NotifyContext,
  input: RefundCompletion,
): Promise<boolean> {
  const refund = await tx.refund.findUnique({
    where: { id: input.refundId },
    select: {
      id: true,
      refundNumber: true,
      status: true,
      method: true,
      amount: true,
      orderId: true,
      paymentId: true,
      items: { select: { orderItemId: true, quantity: true } },
    },
  });
  if (refund === null) throw new AppError('NOT_FOUND', 'Refund not found.');
  if (refund.status === 'COMPLETED') return false;
  await tx.refund.update({
    where: { id: refund.id },
    data: {
      status: 'COMPLETED',
      completedAt: input.now,
      failureReason: null,
      ...(input.providerRefundId == null ? {} : { providerRefundId: input.providerRefundId }),
      ...(input.payoutReference == null ? {} : { payoutReference: input.payoutReference }),
    },
  });
  const amount = dec(refund.amount);
  if (refund.paymentId !== null) {
    const payment = await tx.payment.findUnique({
      where: { id: refund.paymentId },
      select: { amount: true, amountRefunded: true },
    });
    if (payment !== null) {
      const refunded = dec(payment.amountRefunded).plus(amount);
      await tx.payment.update({
        where: { id: refund.paymentId },
        data: {
          amountRefunded: refunded,
          status: refunded.greaterThanOrEqualTo(payment.amount) ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
        },
      });
    }
  }
  const order = await tx.order.findUnique({
    where: { id: refund.orderId },
    select: { ...ORDER_CONTACT_SELECT, refundedTotal: true },
  });
  if (order === null) throw new AppError('NOT_FOUND', 'Order not found.');
  const orderRefunded = dec(order.refundedTotal).plus(amount);
  await tx.order.update({
    where: { id: order.id },
    data: {
      refundedTotal: orderRefunded,
      paymentStatus: orderRefunded.greaterThanOrEqualTo(order.grandTotal)
        ? 'REFUNDED'
        : 'PARTIALLY_REFUNDED',
    },
  });
  for (const item of refund.items) {
    await tx.orderItem.update({
      where: { id: item.orderItemId },
      data: { quantityRefunded: { increment: item.quantity } },
    });
  }
  await notifyOrderEvent(
    tx,
    ctx,
    order,
    'REFUND_COMPLETED',
    {
      refundNumber: refund.refundNumber,
      amount: toMoneyString(amount),
      methodLabel: METHOD_LABELS[refund.method] ?? refund.method,
      reference: input.payoutReference ?? input.providerRefundId ?? null,
    },
    refund.id,
  );
  return true;
}

export interface GatewayDeps extends NotifyContext {
  readonly db: DbClient;
  readonly provider: PaymentProviderAdapter;
  readonly clock: () => Date;
  readonly logger: Logger;
}

/**
 * Calls the gateway (post-commit) and records the outcome in a second transaction. The refund id is
 * the gateway idempotency key, so a retry never double-refunds. Never throws for gateway errors:
 * the refund becomes FAILED (retry via `POST /admin/refunds/:refundId/retry`).
 */
export async function executeGatewayRefund(
  deps: GatewayDeps,
  job: GatewayRefundJob,
): Promise<PaymentRefundResult> {
  let result: PaymentRefundResult;
  try {
    result = await deps.provider.refund({
      providerPaymentId: job.providerPaymentId,
      amountMinor: toMinorUnits(job.amount),
      currency: 'INR',
      refundId: job.refundId,
      reason: job.reason,
    });
  } catch (error) {
    deps.logger.error({ err: error, refundId: job.refundId }, 'gateway refund call failed');
    result = { provider: deps.provider.name, status: 'FAILED', reason: 'Gateway call failed.' };
  }
  const now = deps.clock();
  await withTransaction(deps.db, async ({ tx }) => {
    await tx.paymentTransaction.create({
      data: {
        id: randomUUID(),
        paymentId: job.paymentId,
        refundId: job.refundId,
        type: 'REFUND',
        provider: result.provider.slice(0, 30),
        providerReference: result.providerRefundId?.slice(0, 100) ?? null,
        providerStatus: result.status,
        amount: job.amount,
        errorMessage: result.reason?.slice(0, 500) ?? null,
        createdAt: now,
      },
    });
    if (result.status === 'COMPLETED') {
      await markRefundCompleted(tx, deps, {
        refundId: job.refundId,
        now,
        providerRefundId: result.providerRefundId ?? null,
      });
    } else if (result.status === 'FAILED') {
      await tx.refund.update({
        where: { id: job.refundId },
        data: {
          status: 'FAILED',
          failedAt: now,
          failureReason: (result.reason ?? 'Refund failed at the gateway.').slice(0, 500),
        },
      });
    } else if (result.providerRefundId !== undefined) {
      await tx.refund.update({
        where: { id: job.refundId },
        data: { providerRefundId: result.providerRefundId.slice(0, 100) },
      });
    }
  });
  return result;
}
