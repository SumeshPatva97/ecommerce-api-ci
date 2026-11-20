/**
 * Tiny in-memory "world" over the MOCKED DB for payment flows: one order with one or more payment
 * attempts whose rows are mutated by the mocked `update`/`updateMany` calls, so sequential calls
 * (verify after webhook, retry after failure, jobs) observe each other's effects. No SQL runs.
 */
import { Prisma } from '../../../../src/generated/prisma/client.js';
import { MockPaymentProviderAdapter } from '../../../../src/integrations/payments/paymentProvider.js';
import type { MockModels } from '../../../helpers/mockDb.js';
import { IDS, sqlOf } from '../checkout/fixtures.js';

const D = (v: string | number) => new Prisma.Decimal(v);

export const PROVIDER_ORDER_ID = MockPaymentProviderAdapter.providerOrderIdFor('seed-1', 349600);
export const ORDER_NUMBER = 'ORD-261113-00042';
export const PLACED_AT = new Date('2026-11-13T09:46:03.120Z');

export interface PaymentRow {
  id: string;
  attemptNo: number;
  status: string;
  provider: string | null;
  providerOrderId: string | null;
  providerPaymentId: string | null;
  amount: Prisma.Decimal;
  capturedAt: Date | null;
}

export interface Reservation {
  id: string;
  variantId: string;
  quantity: number;
  status: string;
  expiresAt: Date;
}

export interface WorldOptions {
  readonly status?: string;
  readonly paymentStatus?: string;
  readonly userId?: string;
  readonly couponId?: string | null;
  readonly payments?: Partial<PaymentRow>[];
  readonly reservations?: Partial<Reservation>[];
  /** Inventory rows for the FOR UPDATE lock: variantId → [onHand, reserved]. */
  readonly inventory?: Record<string, [number, number]>;
  readonly placedAt?: Date;
}

export function buildWorld(m: MockModels, o: WorldOptions = {}) {
  const order = {
    id: IDS.order,
    orderNumber: ORDER_NUMBER,
    userId: o.userId ?? IDS.user,
    status: o.status ?? 'PENDING_PAYMENT',
    paymentMethod: 'ONLINE',
    paymentStatus: o.paymentStatus ?? 'PENDING',
    grandTotal: D('3496.00'),
    currency: 'INR',
    couponId: o.couponId === undefined ? null : o.couponId,
    couponDiscountTotal: D('300.00'),
    placedAt: o.placedAt ?? PLACED_AT,
    reservationExpiresAt: new Date(PLACED_AT.getTime() + 15 * 60_000),
    customerNameSnapshot: 'Ananya Rao',
    customerEmailSnapshot: 'ananya@example.com',
    customerPhoneSnapshot: '+919812345678',
    items: [
      { variantId: IDS.v1, quantity: 2, sku: 'EAR-MEERA-GLD-S' },
      { variantId: IDS.v2, quantity: 1, sku: 'RNG-TARA-SLV-7' },
    ],
  };
  const payments: PaymentRow[] = (o.payments ?? [{}]).map((p, i) => ({
    id: i === 0 ? IDS.payment : `pay-${String(i + 1)}`,
    attemptNo: i + 1,
    status: 'PENDING',
    provider: 'mock',
    providerOrderId: i === 0 ? PROVIDER_ORDER_ID : `${PROVIDER_ORDER_ID}-${String(i + 1)}`,
    providerPaymentId: null,
    amount: D('3496.00'),
    capturedAt: null,
    ...p,
  }));
  const reservations: Reservation[] = (
    o.reservations ?? [
      { variantId: IDS.v1, quantity: 2 },
      { variantId: IDS.v2, quantity: 1 },
    ]
  ).map((r, i) => ({
    id: `res-${String(i + 1)}`,
    variantId: IDS.v1,
    quantity: 1,
    status: 'ACTIVE',
    expiresAt: order.reservationExpiresAt,
    ...r,
  }));
  const inventory = o.inventory ?? { [IDS.v1]: [20, 2], [IDS.v2]: [20, 1] };
  const captured = () =>
    payments.filter((p) => ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(p.status));

  const orderView = () => ({
    ...order,
    payments: captured().map((p) => ({ capturedAt: p.capturedAt })),
  });
  m.order.findFirst.mockImplementation(() => Promise.resolve(orderView()));
  m.order.findUnique.mockImplementation(() => Promise.resolve(orderView()));
  m.order.updateMany.mockImplementation(
    (args: { where: { status?: string }; data: Record<string, unknown> }) => {
      if (args.where.status !== undefined && args.where.status !== order.status) {
        return Promise.resolve({ count: 0 });
      }
      Object.assign(order, args.data);
      return Promise.resolve({ count: 1 });
    },
  );
  m.order.update.mockImplementation((args: { data: Record<string, unknown> }) => {
    Object.assign(order, args.data);
    return Promise.resolve({ id: order.id });
  });

  const matches = (p: PaymentRow, where: Record<string, unknown>) =>
    (where.providerOrderId === undefined || p.providerOrderId === where.providerOrderId) &&
    (where.id === undefined || p.id === where.id) &&
    (typeof where.status !== 'string' || p.status === where.status);
  m.payment.findFirst.mockImplementation((args: { where: Record<string, unknown> }) =>
    Promise.resolve(payments.filter((p) => matches(p, args.where)).at(-1) ?? null),
  );
  m.payment.findMany.mockImplementation(() => Promise.resolve(payments.map((p) => ({ ...p }))));
  m.payment.count.mockImplementation((args: { where: { status?: { in?: string[] } } }) =>
    Promise.resolve(
      payments.filter((p) => args.where.status?.in?.includes(p.status) ?? true).length,
    ),
  );
  m.payment.update.mockImplementation(
    (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const p = payments.find((x) => x.id === args.where.id);
      if (p !== undefined) Object.assign(p, args.data);
      return Promise.resolve({ id: args.where.id });
    },
  );
  m.payment.updateMany.mockImplementation(
    (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hit = payments.filter((p) => matches(p, args.where));
      for (const p of hit) Object.assign(p, args.data);
      return Promise.resolve({ count: hit.length });
    },
  );
  m.payment.create.mockImplementation((args: { data: Record<string, unknown> }) => {
    const row: PaymentRow = {
      id: `pay-${String(payments.length + 1)}`,
      attemptNo: Number(args.data.attemptNo),
      status: String(args.data.status),
      provider: null,
      providerOrderId: null,
      providerPaymentId: null,
      amount: args.data.amount as Prisma.Decimal,
      capturedAt: null,
    };
    payments.push(row);
    return Promise.resolve({ id: row.id });
  });

  m.stockReservation.findMany.mockImplementation(
    (args: { where: { status?: string; variantId?: unknown } }) =>
      Promise.resolve(
        reservations
          .filter((r) => args.where.status === undefined || r.status === args.where.status)
          .map((r) => ({ ...r })),
      ),
  );
  m.stockReservation.count.mockImplementation(
    (args: { where: { status?: string; expiresAt?: { lt?: Date; gt?: Date } } }) =>
      Promise.resolve(
        reservations.filter(
          (r) =>
            (args.where.status === undefined || r.status === args.where.status) &&
            (args.where.expiresAt?.lt === undefined || r.expiresAt < args.where.expiresAt.lt) &&
            (args.where.expiresAt?.gt === undefined || r.expiresAt > args.where.expiresAt.gt),
        ).length,
      ),
  );
  m.stockReservation.updateMany.mockImplementation(
    (args: { where: { id: string; status?: string }; data: Record<string, unknown> }) => {
      const r = reservations.find(
        (x) =>
          x.id === args.where.id &&
          (args.where.status === undefined || x.status === args.where.status),
      );
      if (r === undefined) return Promise.resolve({ count: 0 });
      Object.assign(r, args.data);
      return Promise.resolve({ count: 1 });
    },
  );
  m.stockReservation.update.mockImplementation(
    (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const r = reservations.find((x) => x.id === args.where.id);
      if (r !== undefined) Object.assign(r, args.data);
      return Promise.resolve({ id: args.where.id });
    },
  );
  m.inventoryTransaction.findMany.mockResolvedValue([]);
  m.$queryRaw.mockImplementation((first: unknown) => {
    const sql = sqlOf(first);
    if (sql.includes('FROM inventory')) {
      return Promise.resolve(
        Object.entries(inventory).map(([variantId, [onHand, reserved]]) => ({
          variantId,
          onHand,
          reserved,
          lowStockThreshold: null,
          lowStockAlertedAt: null,
        })),
      );
    }
    if (sql.includes('number_sequences')) return Promise.resolve([{ next_value: 7 }]);
    return Promise.resolve([]);
  });
  m.setting.findUnique.mockResolvedValue(null);
  m.couponUsage.findUnique.mockResolvedValue(null);
  m.notification.findUnique.mockResolvedValue(null);
  m.paymentTransaction.findFirst.mockResolvedValue(null);
  m.idempotencyKey.create.mockResolvedValue({ id: 'idem-row' });
  m.idempotencyKey.update.mockResolvedValue({});
  return { order, payments, reservations };
}
