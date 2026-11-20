/**
 * Order/refund notification helper shared by the refunds and orders modules
 * (NOTIFICATION_WORKFLOWS.md §3.1; variables per `EVENT_SPECS`). Enqueued inside the caller's
 * transaction (outbox) — rows exist iff the business change commits.
 */
import type { Queryable } from '../../core/db/transaction.js';
import type { NotificationEvent } from '../../generated/prisma/enums.js';
import { toMoneyString, type DecimalInput } from '../../lib/money.js';
import type { NotificationService } from '../notifications/index.js';
import type { TemplateValue } from '../notifications/notifications.render.js';

export const ORDER_CONTACT_SELECT = {
  id: true,
  orderNumber: true,
  userId: true,
  grandTotal: true,
  paymentMethod: true,
  customerPhoneSnapshot: true,
  user: { select: { firstName: true, email: true, phone: true } },
} as const;

export interface OrderContact {
  readonly id: string;
  readonly orderNumber: string;
  readonly userId: string;
  readonly grandTotal: DecimalInput;
  readonly paymentMethod: string;
  readonly customerPhoneSnapshot: string | null;
  readonly user: { firstName: string; email: string; phone: string | null };
}

export interface NotifyContext {
  readonly notifications: NotificationService;
  readonly storefrontUrl: string;
}

export async function notifyOrderEvent(
  tx: Queryable,
  ctx: NotifyContext,
  order: OrderContact,
  event: NotificationEvent,
  extra: Readonly<Record<string, TemplateValue>> = {},
  discriminator?: string,
): Promise<void> {
  await ctx.notifications.enqueue(tx, {
    event,
    channels: ['EMAIL', 'WHATSAPP'],
    recipientUserId: order.userId,
    to: { email: order.user.email, phone: order.user.phone ?? order.customerPhoneSnapshot },
    entityType: 'ORDER',
    entityId: order.id,
    ...(discriminator === undefined ? {} : { discriminator }),
    variables: {
      firstName: order.user.firstName,
      orderNumber: order.orderNumber,
      orderUrl: `${ctx.storefrontUrl.replace(/\/+$/, '')}/orders/${order.orderNumber}`,
      amount: toMoneyString(order.grandTotal),
      paymentMethod: order.paymentMethod,
      ...extra,
    },
  });
}

export const METHOD_LABELS: Readonly<Record<string, string>> = {
  ORIGINAL_PAYMENT_METHOD: 'original payment method',
  BANK_TRANSFER: 'bank transfer',
  STORE_CREDIT: 'store credit',
};
