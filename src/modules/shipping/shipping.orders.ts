/**
 * Shipment status flow and the NARROW order-status effect of shipments.
 *
 * Order side — PROJECT_CONTEXT §5.1 canonical state machine, ADMIN_WORKFLOWS §7 rows 7–9 / §8:
 * shipments drive the forward fulfilment path only
 *
 *   PROCESSING → PACKED → SHIPPED → OUT_FOR_DELIVERY → DELIVERED
 *
 * - shipment SHIPPED / IN_TRANSIT → order SHIPPED (first shipment, PROPOSED split rule);
 * - shipment OUT_FOR_DELIVERY     → order OUT_FOR_DELIVERY;
 * - shipment DELIVERED            → order DELIVERED only when every non-cancelled shipment is
 *   delivered and every order line is fully shipped (or cancelled).
 * Skipped intermediate states are walked one canonical edge at a time (each edge writes its own
 * `order_status_history` row + audit `STATUS_CHANGE`), e.g. SHIPPED → OUT_FOR_DELIVERY → DELIVERED
 * when a courier never reports OFD. Orders outside the path (CANCELLED, CANCELLATION_REQUESTED, …)
 * or already beyond the target are left unchanged (idempotent, out-of-order safe).
 *
 * Every edge is validated with `canTransition` (lib/orderStateMachine — the canonical table owned
 * by the orders module). When the order reaches SHIPPED the tax invoice is issued in the same
 * transaction via `issueInvoiceForOrder` (PROVISIONAL OQ-48 / OQ-67: one invoice per order, on
 * SHIPPED; idempotent).
 */
import { randomUUID } from 'node:crypto';

import type { TxClient } from '../../core/db/transaction.js';
import type { OrderStatus, ShipmentStatus } from '../../generated/prisma/enums.js';
import { AppError } from '../../core/errors/AppError.js';
import { toMoneyString } from '../../lib/money.js';
import { canTransition } from '../../lib/orderStateMachine.js';
import type { AuditActor, AuditService } from '../audit/audit.service.js';
import { issueInvoiceForOrder } from '../invoices/index.js';
import type { NotificationService } from '../notifications/index.js';

export const SHIPMENT_TRANSITIONS: Readonly<Record<ShipmentStatus, readonly ShipmentStatus[]>> = {
  PENDING: ['READY_TO_SHIP', 'SHIPPED', 'CANCELLED'],
  READY_TO_SHIP: ['SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'],
  SHIPPED: ['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'DELIVERY_FAILED', 'RTO_INITIATED'],
  IN_TRANSIT: ['OUT_FOR_DELIVERY', 'DELIVERED', 'DELIVERY_FAILED', 'RTO_INITIATED'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'DELIVERY_FAILED', 'RTO_INITIATED'],
  DELIVERY_FAILED: ['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'RTO_INITIATED'],
  RTO_INITIATED: ['RTO_DELIVERED'],
  RTO_DELIVERED: [],
  DELIVERED: [],
  CANCELLED: [],
};

export function canTransitionShipment(from: ShipmentStatus, to: ShipmentStatus): boolean {
  return SHIPMENT_TRANSITIONS[from].includes(to);
}

/** Statuses meaning the parcel has left the warehouse. */
export const DISPATCHED_STATUSES: ReadonlySet<ShipmentStatus> = new Set([
  'SHIPPED',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'DELIVERY_FAILED',
  'RTO_INITIATED',
  'RTO_DELIVERED',
]);

export const FULFILMENT_PATH: readonly OrderStatus[] = [
  'PROCESSING',
  'PACKED',
  'SHIPPED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
];

export function orderTargetFor(status: ShipmentStatus): OrderStatus | undefined {
  switch (status) {
    case 'SHIPPED':
    case 'IN_TRANSIT':
      return 'SHIPPED';
    case 'OUT_FOR_DELIVERY':
      return 'OUT_FOR_DELIVERY';
    case 'DELIVERED':
      return 'DELIVERED';
    default:
      return undefined;
  }
}

/** Canonical edges from `current` to `target` (empty: already there/beyond; null: off-path). */
export function orderPathTo(current: OrderStatus, target: OrderStatus): OrderStatus[] | null {
  const from = FULFILMENT_PATH.indexOf(current);
  const to = FULFILMENT_PATH.indexOf(target);
  if (from < 0 || to < 0) return null;
  if (to <= from) return [];
  return FULFILMENT_PATH.slice(from + 1, to + 1);
}

export interface AdvanceOrderDeps {
  readonly audit: AuditService;
  readonly notifications: NotificationService;
  readonly storefrontUrl: string;
}

export interface AdvanceOrderArgs {
  readonly orderId: string;
  /** New status of the shipment (already persisted by the caller). */
  readonly shipmentStatus: ShipmentStatus;
  readonly actor: AuditActor;
  readonly now: Date;
  readonly note?: string | undefined;
}

export type AdvanceSkipReason =
  'NO_ORDER_EFFECT' | 'OFF_PATH' | 'ALREADY_BEYOND' | 'NOT_ALL_DELIVERED';

export interface AdvanceOrderResult {
  readonly from: OrderStatus;
  readonly to: OrderStatus;
  readonly steps: readonly OrderStatus[];
  readonly skipped?: AdvanceSkipReason;
}

/**
 * Applies the order effect of a shipment status change inside the caller's transaction (row lock
 * `FOR UPDATE` on the order). Writes `orders.status` (+ `shipped_at` / `delivered_at`),
 * `order_status_history` rows, audit `STATUS_CHANGE` rows, and enqueues `ORDER_DELIVERED`.
 */
export async function advanceOrderForShipment(
  tx: TxClient,
  deps: AdvanceOrderDeps,
  args: AdvanceOrderArgs,
): Promise<AdvanceOrderResult> {
  await tx.$queryRaw`SELECT id FROM orders WHERE id = ${args.orderId} FOR UPDATE`;
  const order = await tx.order.findUnique({
    where: { id: args.orderId },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      userId: true,
      grandTotal: true,
      paymentMethod: true,
      shippedAt: true,
      customerEmailSnapshot: true,
      customerPhoneSnapshot: true,
      user: { select: { firstName: true, email: true, phone: true } },
      items: { select: { quantity: true, quantityShipped: true, quantityCancelled: true } },
      shipments: { select: { status: true } },
    },
  });
  if (order === null) throw new Error(`Order ${args.orderId} not found for shipment.`);

  const unchanged = (skipped: AdvanceSkipReason): AdvanceOrderResult => ({
    from: order.status,
    to: order.status,
    steps: [],
    skipped,
  });
  const target = orderTargetFor(args.shipmentStatus);
  if (target === undefined) return unchanged('NO_ORDER_EFFECT');
  if (target === 'DELIVERED') {
    const allShipmentsDelivered = order.shipments
      .filter((s) => s.status !== 'CANCELLED')
      .every((s) => s.status === 'DELIVERED');
    const allLinesShipped = order.items.every(
      (i) => i.quantityShipped + i.quantityCancelled >= i.quantity,
    );
    if (!allShipmentsDelivered || !allLinesShipped) return unchanged('NOT_ALL_DELIVERED');
  }
  const steps = orderPathTo(order.status, target);
  if (steps === null) return unchanged('OFF_PATH');
  if (steps.length === 0) return unchanged('ALREADY_BEYOND');

  let edgeFrom = order.status;
  for (const to of steps) {
    if (!canTransition(edgeFrom, to)) {
      throw new AppError(
        'INVALID_STATE_TRANSITION',
        `Order cannot move from ${edgeFrom} to ${to}.`,
      );
    }
    edgeFrom = to;
  }

  let from = order.status;
  for (const to of steps) {
    await tx.orderStatusHistory.create({
      data: {
        id: randomUUID(),
        orderId: order.id,
        eventType: 'STATUS_CHANGE',
        fromStatus: from,
        toStatus: to,
        note: args.note?.slice(0, 1000) ?? null,
        isCustomerVisible: true,
        actorType: args.actor.type,
        actorUserId: args.actor.userId ?? null,
        createdAt: args.now,
      },
    });
    await deps.audit.record(tx, args.actor, {
      action: 'STATUS_CHANGE',
      module: 'orders',
      entityType: 'Order',
      entityId: order.id,
      before: { status: from },
      after: { status: to },
      eventKey: 'order.status_changed',
      metadata: { entityLabel: order.orderNumber, source: 'shipment' },
    });
    from = to;
  }
  await tx.order.update({
    where: { id: order.id },
    data: {
      status: target,
      ...(steps.includes('SHIPPED') && order.shippedAt === null ? { shippedAt: args.now } : {}),
      ...(target === 'DELIVERED' ? { deliveredAt: args.now } : {}),
    },
  });
  if (steps.includes('SHIPPED')) {
    await issueInvoiceForOrder(tx, order.id, args.now, {
      storefrontUrl: deps.storefrontUrl,
      audit: { service: deps.audit, actor: args.actor },
    });
  }
  if (target === 'DELIVERED') {
    await deps.notifications.enqueue(tx, {
      event: 'ORDER_DELIVERED',
      channels: ['EMAIL', 'WHATSAPP'],
      recipientUserId: order.userId,
      to: {
        email: order.user.email,
        phone: order.user.phone ?? order.customerPhoneSnapshot,
      },
      entityType: 'ORDER',
      entityId: order.id,
      variables: {
        firstName: order.user.firstName,
        orderNumber: order.orderNumber,
        orderUrl: `${deps.storefrontUrl}/orders/${order.orderNumber}`,
        amount: toMoneyString(order.grandTotal),
        deliveredAt: args.now.toISOString(),
      },
    });
  }
  return { from: order.status, to: target, steps };
}
