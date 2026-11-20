/**
 * Order cancellation effects — one transaction, order row locked FIRST (BACKEND_STRUCTURE.md §7
 * "Cancel order"; API_DOCUMENTATION.md §3.10, §4.7; ADMIN_WORKFLOWS.md §9–§10):
 *
 * 1. transition validated with `canTransition(status, 'CANCELLED')` (lib/orderStateMachine);
 * 2. stock: `restoreCancellation` (releases ACTIVE reservations + restores net deductions,
 *    `CANCELLATION_RESTORE`) or, with `restock: false`, only `releaseReservation`;
 * 3. coupon `release(…, 'ORDER_CANCELLED_BEFORE_SHIPMENT')` — PROVISIONAL (OQ-15): restored only
 *    when cancelled before shipment and the coupon is still valid (the state machine never allows
 *    a cancellation from SHIPPED onward, so every cancellation here is "before shipment");
 * 4. refund record if paid: auto-APPROVED full refund for a customer self-cancel of a CONFIRMED
 *    prepaid order (R-16), otherwise REQUESTED with SYSTEM as maker (any checker may approve);
 * 5. credit note if a tax invoice exists (TAX_AND_GST §18.1);
 * 6. `order_status_history`, audit `STATUS_CHANGE`, `ORDER_CANCELLED` (+ `REFUND_INITIATED`).
 * The gateway refund (auto-approved case) is prepared here and executed by the caller after commit.
 */
import { randomUUID } from 'node:crypto';

import type { TxClient } from '../../core/db/transaction.js';
import { AppError } from '../../core/errors/AppError.js';
import type { ActorType, OrderStatus, RefundMethod } from '../../generated/prisma/enums.js';
import { toMoneyString } from '../../lib/money.js';
import { canTransition } from '../../lib/orderStateMachine.js';
import type { AuditActor, AuditService } from '../audit/audit.service.js';
import type { CouponsService } from '../coupons/index.js';
import type { InventoryService } from '../inventory/index.js';
import { issueCreditNote } from '../invoices/index.js';
import {
  METHOD_LABELS,
  createRefundForOrder,
  notifyOrderEvent,
  prepareGatewayRefund,
  type GatewayRefundJob,
  type NotifyContext,
  type OrderContact,
} from '../refunds/index.js';

export interface CancelDeps extends NotifyContext {
  readonly audit: AuditService;
  readonly inventory: InventoryService;
  readonly coupons: CouponsService;
}

export interface LockedOrder extends OrderContact {
  readonly status: OrderStatus;
  readonly paymentStatus: string;
  readonly couponCodeSnapshot: string | null;
}

export const LOCKED_ORDER_SELECT = {
  id: true,
  orderNumber: true,
  userId: true,
  status: true,
  paymentMethod: true,
  paymentStatus: true,
  grandTotal: true,
  couponCodeSnapshot: true,
  customerPhoneSnapshot: true,
  user: { select: { firstName: true, email: true, phone: true } },
} as const;

export interface CancelArgs {
  readonly order: LockedOrder;
  readonly actor: AuditActor;
  readonly now: Date;
  readonly reasonCode: string;
  readonly comment?: string | undefined;
  readonly restock: boolean;
  readonly refund: {
    readonly initiate: boolean;
    /** R-16: customer self-cancel of a CONFIRMED prepaid order. */
    readonly autoApprove: boolean;
    readonly method?: RefundMethod | undefined;
  };
  readonly notifyCustomer: boolean;
  readonly eventKey: string;
}

export interface CancelResult {
  readonly orderNumber: string;
  readonly previousStatus: OrderStatus;
  readonly status: 'CANCELLED';
  readonly cancelledAt: string;
  readonly stock: { restored: boolean; transactionType: string | null };
  readonly coupon: { code: string | null; redemptionRestored: boolean } | null;
  readonly refund: {
    id: string;
    refundNumber: string;
    status: string;
    amount: string;
    method: RefundMethod;
  } | null;
  readonly creditNote: { invoiceNumber: string } | null;
}

const PAID = new Set(['CAPTURED', 'PARTIALLY_REFUNDED']);

function isNothingToRefund(error: unknown): boolean {
  return (
    error instanceof AppError && error.details?.some((d) => d.code === 'NOTHING_TO_REFUND') === true
  );
}

export function invalidTransition(
  current: OrderStatus,
  allowedFrom: readonly OrderStatus[],
  message: string,
): AppError {
  return new AppError('INVALID_STATE_TRANSITION', message, {
    details: [{ field: 'status', message, meta: { currentStatus: current, allowedFrom } }],
  });
}

export async function lockOrderRow(tx: TxClient, orderId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`;
}

/** Applies every cancellation effect inside the caller's transaction (order row already locked). */
export async function cancelOrderInTx(
  tx: TxClient,
  deps: CancelDeps,
  args: CancelArgs,
): Promise<{ result: CancelResult; gatewayJob: GatewayRefundJob | null }> {
  const { order, now } = args;
  if (!canTransition(order.status, 'CANCELLED')) {
    throw invalidTransition(order.status, [], 'This order can no longer be cancelled.');
  }
  const actorUserId = args.actor.userId ?? null;
  const stockOptions = { actorUserId: args.actor.type === 'STAFF' ? actorUserId : null };
  const stock = args.restock
    ? await deps.inventory.restoreCancellation(tx, order.id, stockOptions)
    : await deps.inventory.releaseReservation(tx, order.id, 'CANCELLED', stockOptions);
  const restored = stock.ledger.some((l) => l.type === 'CANCELLATION_RESTORE');
  const released = stock.ledger.some((l) => l.type === 'RESERVATION_RELEASE');

  const coupon = await deps.coupons.release(tx, order.id, 'ORDER_CANCELLED_BEFORE_SHIPMENT');

  const reasonText = [args.reasonCode, args.comment].filter(Boolean).join(': ').slice(0, 500);
  await tx.order.update({
    where: { id: order.id },
    data: {
      status: 'CANCELLED',
      cancelledAt: now,
      cancelledById: actorUserId,
      cancellationReason: reasonText,
    },
  });
  await tx.orderStatusHistory.create({
    data: {
      id: randomUUID(),
      orderId: order.id,
      eventType: 'STATUS_CHANGE',
      fromStatus: order.status,
      toStatus: 'CANCELLED',
      note: reasonText,
      isCustomerVisible: true,
      actorType: args.actor.type,
      actorUserId,
      createdAt: now,
    },
  });

  let refund: Awaited<ReturnType<typeof createRefundForOrder>> | null = null;
  if (args.refund.initiate && PAID.has(order.paymentStatus)) {
    const requestedBy: { type: ActorType; userId: string | null } = args.refund.autoApprove
      ? { type: 'CUSTOMER', userId: order.userId }
      : { type: 'SYSTEM', userId: null };
    try {
      refund = await createRefundForOrder(tx, {
        orderId: order.id,
        now,
        requestedBy,
        status: args.refund.autoApprove ? 'APPROVED' : 'REQUESTED',
        method: args.refund.method,
        reasonCode: 'ORDER_CANCELLED',
        reasonText,
      });
    } catch (error) {
      if (!isNothingToRefund(error)) throw error;
    }
  }

  const creditNote = await issueCreditNote(tx, {
    orderId: order.id,
    refundId: refund?.id ?? null,
    scope: { kind: 'FULL' },
    now,
  });

  await deps.audit.record(tx, args.actor, {
    action: 'STATUS_CHANGE',
    module: 'orders',
    entityType: 'Order',
    entityId: order.id,
    before: { status: order.status },
    after: { status: 'CANCELLED' },
    reason: reasonText,
    eventKey: args.eventKey,
    metadata: {
      entityLabel: order.orderNumber,
      refund: refund?.refundNumber ?? null,
      refundAutoApproved: refund !== null && args.refund.autoApprove,
      creditNote: creditNote?.invoiceNumber ?? null,
      couponReleased: coupon.status === 'RELEASED' && coupon.changed,
    },
  });
  if (refund !== null && args.refund.autoApprove) {
    // R-16: auto-approval by the system, audited separately from the cancellation.
    await deps.audit.record(
      tx,
      { type: 'SYSTEM', loginType: 'SYSTEM' },
      {
        action: 'REFUND_APPROVE',
        module: 'refunds',
        entityType: 'Refund',
        entityId: refund.id,
        after: { status: 'APPROVED', amount: toMoneyString(refund.amount) },
        diff: false,
        eventKey: 'refunds.auto_approved',
        metadata: { entityLabel: refund.refundNumber, rule: 'R-16 customer self-cancel' },
      },
    );
  }

  if (args.notifyCustomer) {
    await notifyOrderEvent(tx, deps, order, 'ORDER_CANCELLED', {
      reason: args.comment ?? args.reasonCode,
      refundNote:
        refund === null
          ? null
          : `A refund of ${toMoneyString(refund.amount)} has been ${
              args.refund.autoApprove ? 'initiated' : 'requested'
            }.`,
    });
    if (refund !== null && args.refund.autoApprove) {
      await notifyOrderEvent(
        tx,
        deps,
        order,
        'REFUND_INITIATED',
        {
          refundNumber: refund.refundNumber,
          amount: toMoneyString(refund.amount),
          methodLabel: METHOD_LABELS[refund.method] ?? refund.method,
        },
        refund.id,
      );
    }
  }

  const gatewayJob =
    refund !== null && args.refund.autoApprove
      ? await prepareGatewayRefund(tx, refund.id, now)
      : null;

  return {
    gatewayJob,
    result: {
      orderNumber: order.orderNumber,
      previousStatus: order.status,
      status: 'CANCELLED',
      cancelledAt: now.toISOString(),
      stock: {
        restored: restored || released,
        transactionType: restored
          ? 'CANCELLATION_RESTORE'
          : released
            ? 'RESERVATION_RELEASE'
            : null,
      },
      coupon:
        coupon.status === 'NO_COUPON'
          ? null
          : {
              code: order.couponCodeSnapshot,
              redemptionRestored: coupon.status === 'RELEASED' && coupon.changed,
            },
      refund:
        refund === null
          ? null
          : {
              id: refund.id,
              refundNumber: refund.refundNumber,
              status: gatewayJob === null ? refund.status : 'PROCESSING',
              amount: toMoneyString(refund.amount),
              method: refund.method,
            },
      creditNote: creditNote === null ? null : { invoiceNumber: creditNote.invoiceNumber },
    },
  };
}
