/**
 * Admin customer use-cases — API_DOCUMENTATION.md §4.8, AUTHENTICATION_AUTHORIZATION.md §3.
 * Status changes require a reason, revoke every session of the customer and are audited
 * (`STATUS_CHANGE`). Never returns password hashes or token material.
 */
import type { AppContainer } from '../../container.js';
import { AppError } from '../../core/errors/AppError.js';
import { buildPageMeta, type PageMeta } from '../../core/http/pagination.js';
import { withTransaction } from '../../core/db/transaction.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { AuditActor } from '../audit/audit.service.js';
import { revokeUserSessions } from '../auth/sessions.js';
import {
  COUNTED_ORDER_STATUSES,
  customerDetailSelect,
  customerListSelect,
  customerWhere,
  idsWithMinOrders,
  orderStatsFor,
  rankedCustomerIds,
  statsOf,
  type CustomerListRow,
} from './customers.repository.js';
import type { ListCustomersQuery, SetCustomerStatusBody } from './customers.schemas.js';

export interface CustomerListItem {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  status: string;
  emailVerified: boolean;
  orderCount: number;
  totalSpent: string;
  lastOrderAt: string | null;
  createdAt: string;
}

function fullName(row: { firstName: string; lastName: string | null }): string {
  return row.lastName === null || row.lastName === ''
    ? row.firstName
    : `${row.firstName} ${row.lastName}`;
}

export function createCustomersService(c: AppContainer) {
  const { db, audit, clock, permissions } = c;

  async function pageIds(
    where: Prisma.UserWhereInput,
    sort: ListCustomersQuery['sort'],
    page: number,
    limit: number,
  ): Promise<string[]> {
    const skip = (page - 1) * limit;
    if (sort === '-createdAt' || sort === 'createdAt') {
      const rows = await db.user.findMany({
        where,
        select: { id: true },
        orderBy: [{ createdAt: sort === '-createdAt' ? 'desc' : 'asc' }, { id: 'asc' }],
        skip,
        take: limit,
      });
      return rows.map((r) => r.id);
    }
    // Ranked customers first (by spend / order count), then customers without counted orders.
    const ranked = await rankedCustomerIds(
      db,
      where,
      sort === '-totalSpent' ? 'totalSpent' : 'orderCount',
    );
    const ids = ranked.slice(skip, skip + limit);
    if (ids.length < limit) {
      const rest = await db.user.findMany({
        where: { AND: [where, { id: { notIn: ranked } }] },
        select: { id: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: Math.max(0, skip - ranked.length),
        take: limit - ids.length,
      });
      ids.push(...rest.map((r) => r.id));
    }
    return ids;
  }

  return {
    async list(query: ListCustomersQuery): Promise<{ data: CustomerListItem[]; meta: PageMeta }> {
      const base = customerWhere(query);
      const where: Prisma.UserWhereInput =
        query.minOrders !== undefined && query.minOrders > 0
          ? { AND: [base, { id: { in: await idsWithMinOrders(db, query.minOrders) } }] }
          : base;
      const [total, ids] = await Promise.all([
        db.user.count({ where }),
        pageIds(where, query.sort, query.page, query.limit),
      ]);
      const [rows, stats] = await Promise.all([
        ids.length === 0
          ? Promise.resolve([] as CustomerListRow[])
          : db.user.findMany({ where: { id: { in: ids } }, select: customerListSelect }),
        orderStatsFor(db, ids),
      ]);
      const byId = new Map(rows.map((r) => [r.id, r]));
      const data = ids.flatMap((id) => {
        const row = byId.get(id);
        if (row === undefined) return [];
        const s = statsOf(stats, id);
        return [
          {
            id: row.id,
            name: fullName(row),
            email: row.email,
            phone: row.phone,
            status: row.status,
            emailVerified: row.emailVerifiedAt !== null,
            orderCount: s.orderCount,
            totalSpent: s.totalSpent,
            lastOrderAt: s.lastOrderAt?.toISOString() ?? null,
            createdAt: row.createdAt.toISOString(),
          },
        ];
      });
      return { data, meta: buildPageMeta(query.page, query.limit, total) };
    },

    async get(customerId: string) {
      const row = await db.user.findFirst({
        where: { id: customerId, accountType: 'CUSTOMER', deletedAt: null },
        select: customerDetailSelect,
      });
      if (row === null) throw new AppError('NOT_FOUND', 'Customer not found.');
      const [stats, recentOrders, reviewCount] = await Promise.all([
        db.order.aggregate({
          where: { userId: customerId, status: { in: [...COUNTED_ORDER_STATUSES] } },
          _count: { _all: true },
          _sum: { grandTotal: true },
          _max: { placedAt: true },
        }),
        db.order.findMany({
          where: { userId: customerId },
          select: {
            id: true,
            orderNumber: true,
            status: true,
            paymentStatus: true,
            itemCount: true,
            grandTotal: true,
            placedAt: true,
          },
          orderBy: { placedAt: 'desc' },
          take: 10,
        }),
        db.review.count({ where: { userId: customerId, deletedAt: null } }),
      ]);
      const consents = row.notificationPrefs.filter((p) => p.consentedAt !== null);
      return {
        id: row.id,
        name: fullName(row),
        firstName: row.firstName,
        lastName: row.lastName,
        email: row.email,
        phone: row.phone,
        status: row.status,
        emailVerified: row.emailVerifiedAt !== null,
        phoneVerified: row.phoneVerifiedAt !== null,
        lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        anonymizedAt: row.anonymizedAt?.toISOString() ?? null,
        addresses: row.addresses.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() })),
        orderSummary: {
          orderCount: stats._count._all,
          totalSpent: stats._sum.grandTotal?.toFixed(2) ?? '0.00',
          lastOrderAt: stats._max.placedAt?.toISOString() ?? null,
          recentOrders: recentOrders.map((o) => ({
            ...o,
            grandTotal: o.grandTotal.toFixed(2),
            placedAt: o.placedAt.toISOString(),
          })),
        },
        reviewCount,
        notificationPreferences: row.notificationPrefs.map((p) => ({
          channel: p.channel,
          category: p.category,
          isOptedIn: p.isOptedIn,
          optedOutAt: p.optedOutAt?.toISOString() ?? null,
        })),
        consents: consents.map((p) => ({
          channel: p.channel,
          category: p.category,
          source: p.consentSource,
          textVersion: p.consentTextVersion,
          consentedAt: p.consentedAt?.toISOString() ?? null,
        })),
      };
    },

    async setStatus(
      actor: AuditActor,
      customerId: string,
      body: SetCustomerStatusBody,
    ): Promise<{ id: string; status: string; sessionsRevoked: number }> {
      const row = await db.user.findFirst({
        where: { id: customerId, accountType: 'CUSTOMER', deletedAt: null },
        select: { id: true, status: true },
      });
      if (row === null) throw new AppError('NOT_FOUND', 'Customer not found.');
      if (row.status === body.status) {
        throw new AppError('INVALID_STATE_TRANSITION', `The account is already ${body.status}.`);
      }
      if (row.status === 'PENDING_VERIFICATION' && body.status === 'ACTIVE') {
        throw new AppError(
          'INVALID_STATE_TRANSITION',
          'An unverified account becomes active when the customer verifies their email.',
        );
      }
      const now = clock();
      const sessionsRevoked = await withTransaction(db, async ({ tx, ...ctx }) => {
        await tx.user.update({
          where: { id: customerId },
          data: { status: body.status, updatedById: actor.userId ?? null },
        });
        const revoked = await revokeUserSessions(tx, customerId, 'STATUS_CHANGED', now);
        await audit.record(tx, actor, {
          action: 'STATUS_CHANGE',
          module: 'customers',
          entityType: 'User',
          entityId: customerId,
          before: { id: customerId, status: row.status },
          after: { id: customerId, status: body.status },
          reason: body.reason,
          eventKey: 'customers.status_changed',
          metadata: { sessionsRevoked: revoked },
        });
        ctx.afterCommit(() => {
          permissions.invalidateUser(customerId);
        });
        return revoked;
      });
      return { id: customerId, status: body.status, sessionsRevoked };
    },
  };
}

export type CustomersService = ReturnType<typeof createCustomersService>;
