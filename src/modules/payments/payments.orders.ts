/**
 * Narrow order effects owned by checkout/payments (B6): row lock, state transition + history,
 * customer notifications. Every status change passes the canonical state machine
 * (`src/lib/orderStateMachine.ts`); nothing here invents transitions.
 *
 * Lock order (BACKEND_STRUCTURE.md §7): the `orders` row FOR UPDATE first, then inventory rows
 * ascending (inside the inventory service) — the same order everywhere (verify, webhook, expiry,
 * retry, auto-cancel) so they serialize instead of deadlocking.
 */
import type { ActorType, OrderStatus } from '../../generated/prisma/enums.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { Queryable } from '../../core/db/transaction.js';
import { AppError } from '../../core/errors/AppError.js';
import { toMoneyString } from '../../lib/money.js';
import { canTransition } from '../../lib/orderStateMachine.js';
import type { NotificationEvent } from '../../generated/prisma/enums.js';
import type { NotificationService } from '../notifications/index.js';

export interface OrderActor {
  readonly type: ActorType;
  readonly userId?: string | null | undefined;
}

export const SYSTEM_ORDER_ACTOR: OrderActor = Object.freeze({ type: 'SYSTEM' });
export const WEBHOOK_ORDER_ACTOR: OrderActor = Object.freeze({ type: 'WEBHOOK' });

/** Columns the payment flows need (locked re-read after `lockOrder`). */
export const orderCoreSelect = {
  id: true,
  orderNumber: true,
  userId: true,
  status: true,
  paymentMethod: true,
  paymentStatus: true,
  grandTotal: true,
  currency: true,
  couponId: true,
  couponDiscountTotal: true,
  placedAt: true,
  reservationExpiresAt: true,
  customerNameSnapshot: true,
  customerEmailSnapshot: true,
  customerPhoneSnapshot: true,
  items: {
    select: { variantId: true, quantity: true, sku: true },
    orderBy: { lineNo: 'asc' },
  },
} satisfies Prisma.OrderSelect;

export type OrderCore = Prisma.OrderGetPayload<{ select: typeof orderCoreSelect }>;

/** `SELECT … FOR UPDATE` on the order row (serializes verify / webhook / jobs / retry). */
export async function lockOrder(tx: Queryable, orderId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`;
}

export async function loadOrderCore(tx: Queryable, orderId: string): Promise<OrderCore | null> {
  return tx.order.findUnique({ where: { id: orderId }, select: orderCoreSelect });
}

export function invalidTransition(from: OrderStatus, to: OrderStatus): AppError {
  return new AppError('INVALID_STATE_TRANSITION', `This order cannot move from ${from} to ${to}.`, {
    details: [
      { code: 'INVALID_STATE_TRANSITION', message: 'Refresh the order.', meta: { from, to } },
    ],
  });
}

export interface TransitionArgs {
  readonly orderId: string;
  readonly from: OrderStatus;
  readonly to: OrderStatus;
  readonly actor: OrderActor;
  readonly now: Date;
  readonly note?: string | undefined;
  readonly isCustomerVisible?: boolean;
  readonly data?: Prisma.OrderUncheckedUpdateManyInput;
}

/**
 * Compare-and-set status change (only from `from`) + `order_status_history` row. Throws
 * `INVALID_STATE_TRANSITION` when the state machine forbids the edge.
 */
export async function transitionOrder(tx: Queryable, args: TransitionArgs): Promise<void> {
  if (!canTransition(args.from, args.to)) throw invalidTransition(args.from, args.to);
  const result = await tx.order.updateMany({
    where: { id: args.orderId, status: args.from },
    data: { ...args.data, status: args.to },
  });
  if (result.count !== 1) {
    throw new AppError('CONFLICT', 'The order changed concurrently. Please retry.');
  }
  await tx.orderStatusHistory.create({
    data: {
      orderId: args.orderId,
      eventType: 'STATUS_CHANGE',
      fromStatus: args.from,
      toStatus: args.to,
      note: args.note ?? null,
      isCustomerVisible: args.isCustomerVisible ?? true,
      actorType: args.actor.type,
      actorUserId: args.actor.userId ?? null,
      createdAt: args.now,
    },
  });
}

export interface NotifyContext {
  readonly notifications: NotificationService;
  readonly storefrontUrl: string;
}

/** Customer notification for an order event (EMAIL + WHATSAPP; deduped by the outbox). */
export async function notifyOrder(
  tx: Queryable,
  ctx: NotifyContext,
  order: Pick<
    OrderCore,
    | 'id'
    | 'orderNumber'
    | 'userId'
    | 'grandTotal'
    | 'paymentMethod'
    | 'customerNameSnapshot'
    | 'customerEmailSnapshot'
    | 'customerPhoneSnapshot'
  >,
  event: NotificationEvent,
  options: {
    readonly discriminator?: string | undefined;
    readonly variables?: Readonly<Record<string, string | number | boolean | null>>;
  } = {},
): Promise<void> {
  const base = ctx.storefrontUrl.replace(/\/+$/, '');
  await ctx.notifications.enqueue(tx, {
    event,
    channels: ['EMAIL', 'WHATSAPP'],
    recipientUserId: order.userId,
    to: { email: order.customerEmailSnapshot, phone: order.customerPhoneSnapshot },
    entityType: 'ORDER',
    entityId: order.id,
    discriminator: options.discriminator,
    variables: {
      firstName: order.customerNameSnapshot.split(' ')[0] ?? order.customerNameSnapshot,
      orderNumber: order.orderNumber,
      orderUrl: `${base}/account/orders/${order.orderNumber}`,
      amount: toMoneyString(order.grandTotal),
      paymentMethod: order.paymentMethod,
      ...options.variables,
    },
  });
}
