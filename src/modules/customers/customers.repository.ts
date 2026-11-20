/**
 * Customer persistence — Prisma queries only.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import type { OrderStatus } from '../../generated/prisma/enums.js';
import type { Queryable } from '../../core/db/transaction.js';
import { istDayRange } from '../../lib/time.js';

/** Orders that count toward `orderCount` / `totalSpent` (placed and not cancelled/returned). */
export const COUNTED_ORDER_STATUSES: readonly OrderStatus[] = [
  'CONFIRMED',
  'PROCESSING',
  'PACKED',
  'SHIPPED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'CANCELLATION_REQUESTED',
  'RETURN_REQUESTED',
];

export const customerListSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  status: true,
  emailVerifiedAt: true,
  phoneVerifiedAt: true,
  lastLoginAt: true,
  createdAt: true,
} as const satisfies Prisma.UserSelect;

export type CustomerListRow = Prisma.UserGetPayload<{ select: typeof customerListSelect }>;

export const customerDetailSelect = {
  ...customerListSelect,
  anonymizedAt: true,
  updatedAt: true,
  addresses: {
    select: {
      id: true,
      label: true,
      fullName: true,
      phone: true,
      line1: true,
      line2: true,
      landmark: true,
      city: true,
      district: true,
      stateCode: true,
      postalCode: true,
      countryCode: true,
      companyName: true,
      gstin: true,
      isDefault: true,
      createdAt: true,
    },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  },
  notificationPrefs: {
    select: {
      channel: true,
      category: true,
      isOptedIn: true,
      consentSource: true,
      consentTextVersion: true,
      consentedAt: true,
      optedOutAt: true,
    },
  },
} as const satisfies Prisma.UserSelect;

export type CustomerDetailRow = Prisma.UserGetPayload<{ select: typeof customerDetailSelect }>;

export function customerWhere(filters: {
  q?: string | undefined;
  status?: Prisma.UserWhereInput['status'];
  from?: string | undefined;
  to?: string | undefined;
}): Prisma.UserWhereInput {
  const where: Prisma.UserWhereInput = { accountType: 'CUSTOMER', deletedAt: null };
  if (filters.status !== undefined) where.status = filters.status;
  if (filters.from !== undefined || filters.to !== undefined) {
    where.createdAt = {
      ...(filters.from === undefined ? {} : { gte: istDayRange(filters.from).start }),
      ...(filters.to === undefined ? {} : { lt: istDayRange(filters.to).end }),
    };
  }
  if (filters.q !== undefined) {
    const q = filters.q;
    const digits = q.replace(/\D/g, '');
    where.OR = [
      { firstName: { contains: q } },
      { lastName: { contains: q } },
      { emailNormalized: { contains: q.toLowerCase() } },
      ...(digits.length >= 4 ? [{ phone: { contains: digits } }] : []),
    ];
  }
  return where;
}

export interface OrderStats {
  orderCount: number;
  totalSpent: string;
  lastOrderAt: Date | null;
}

const ZERO_STATS: OrderStats = { orderCount: 0, totalSpent: '0.00', lastOrderAt: null };

export async function orderStatsFor(
  db: Queryable,
  userIds: readonly string[],
): Promise<Map<string, OrderStats>> {
  if (userIds.length === 0) return new Map();
  const rows = await db.order.groupBy({
    by: ['userId'],
    where: { userId: { in: [...userIds] }, status: { in: [...COUNTED_ORDER_STATUSES] } },
    _count: { _all: true },
    _sum: { grandTotal: true },
    _max: { placedAt: true },
  });
  return new Map(
    rows.map((r) => [
      r.userId,
      {
        orderCount: r._count._all,
        totalSpent: r._sum.grandTotal?.toFixed(2) ?? '0.00',
        lastOrderAt: r._max.placedAt,
      },
    ]),
  );
}

export function statsOf(map: ReadonlyMap<string, OrderStats>, id: string): OrderStats {
  return map.get(id) ?? ZERO_STATS;
}

/** Customer ids with at least `min` counted orders. */
export async function idsWithMinOrders(db: Queryable, min: number): Promise<string[]> {
  const rows = await db.order.groupBy({
    by: ['userId'],
    where: { status: { in: [...COUNTED_ORDER_STATUSES] } },
    having: { userId: { _count: { gte: min } } },
  });
  return rows.map((r) => r.userId);
}

/** Customer ids (within `where`) ranked by spend or order count; customers without orders excluded. */
export async function rankedCustomerIds(
  db: Queryable,
  where: Prisma.UserWhereInput,
  by: 'totalSpent' | 'orderCount',
): Promise<string[]> {
  const rows = await db.order.groupBy({
    by: ['userId'],
    where: { status: { in: [...COUNTED_ORDER_STATUSES] }, user: where },
    orderBy:
      by === 'totalSpent'
        ? [{ _sum: { grandTotal: 'desc' } }, { userId: 'asc' }]
        : [{ _count: { userId: 'desc' } }, { userId: 'asc' }],
  });
  return rows.map((r) => r.userId);
}
