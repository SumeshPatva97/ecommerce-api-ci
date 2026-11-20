/**
 * Coupon persistence (Prisma only). Soft-deleted coupons are hidden from admin reads; their
 * normalized code stays reserved by the unique index.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import type { Queryable } from '../../core/db/transaction.js';

export const adminCouponSelect = {
  id: true,
  code: true,
  codeNormalized: true,
  description: true,
  discountType: true,
  discountValue: true,
  maxDiscountAmount: true,
  minOrderValue: true,
  startsAt: true,
  expiresAt: true,
  usageLimitEnabled: true,
  usageLimit: true,
  perCustomerLimit: true,
  usedCount: true,
  isFirstOrderOnly: true,
  isCombinableWithPromotions: true,
  isPublic: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  applicabilities: {
    select: {
      ruleType: true,
      targetType: true,
      productId: true,
      categoryId: true,
      brandId: true,
      collectionId: true,
    },
  },
} satisfies Prisma.CouponSelect;
export type AdminCouponRow = Prisma.CouponGetPayload<{ select: typeof adminCouponSelect }>;

export const usageRowSelect = {
  id: true,
  status: true,
  discountAmount: true,
  reservedAt: true,
  redeemedAt: true,
  releasedAt: true,
  order: { select: { id: true, orderNumber: true } },
  user: { select: { id: true, firstName: true, lastName: true, email: true } },
} satisfies Prisma.CouponUsageSelect;
export type UsageRow = Prisma.CouponUsageGetPayload<{ select: typeof usageRowSelect }>;

export function createCouponsRepository() {
  return {
    /** Serialises redemptions and edits of one coupon (DATABASE_DESIGN §17.1 step 1). */
    async lock(db: Queryable, id: string): Promise<void> {
      await db.$queryRaw`SELECT id FROM coupons WHERE id = ${id} FOR UPDATE`;
    },

    findLive(db: Queryable, id: string): Promise<AdminCouponRow | null> {
      return db.coupon.findFirst({ where: { id, deletedAt: null }, select: adminCouponSelect });
    },

    /** Includes soft-deleted rows: codes stay reserved. */
    findByCode(db: Queryable, codeNormalized: string): Promise<{ id: string } | null> {
      return db.coupon.findUnique({ where: { codeNormalized }, select: { id: true } });
    },

    async list(
      db: Queryable,
      where: Prisma.CouponWhereInput,
      skip: number,
      take: number,
    ): Promise<{ rows: AdminCouponRow[]; total: number }> {
      const [rows, total] = await Promise.all([
        db.coupon.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          skip,
          take,
          select: adminCouponSelect,
        }),
        db.coupon.count({ where }),
      ]);
      return { rows, total };
    },

    create(db: Queryable, data: Prisma.CouponUncheckedCreateInput): Promise<AdminCouponRow> {
      return db.coupon.create({ data, select: adminCouponSelect });
    },

    update(
      db: Queryable,
      id: string,
      data: Prisma.CouponUncheckedUpdateInput,
    ): Promise<AdminCouponRow> {
      return db.coupon.update({ where: { id }, data, select: adminCouponSelect });
    },

    async replaceApplicability(
      db: Queryable,
      couponId: string,
      rows: Prisma.CouponApplicabilityCreateManyInput[],
    ): Promise<void> {
      await db.couponApplicability.deleteMany({ where: { couponId } });
      if (rows.length > 0) await db.couponApplicability.createMany({ data: rows });
    },

    async isUsed(db: Queryable, couponId: string): Promise<boolean> {
      const [usages, orders] = await Promise.all([
        db.couponUsage.count({ where: { couponId } }),
        db.order.count({ where: { couponId } }),
      ]);
      return usages > 0 || orders > 0;
    },

    async listUsage(
      db: Queryable,
      where: Prisma.CouponUsageWhereInput,
      skip: number,
      take: number,
    ): Promise<{ rows: UsageRow[]; total: number }> {
      const [rows, total] = await Promise.all([
        db.couponUsage.findMany({
          where,
          orderBy: [{ reservedAt: 'desc' }, { id: 'asc' }],
          skip,
          take,
          select: usageRowSelect,
        }),
        db.couponUsage.count({ where }),
      ]);
      return { rows, total };
    },

    usageSummary(db: Queryable, couponId: string) {
      return db.couponUsage.groupBy({
        by: ['status'],
        where: { couponId },
        _count: { _all: true },
        _sum: { discountAmount: true },
      });
    },

    /** Ids among `ids` that exist and are not soft-deleted, per target type. */
    async existingTargets(
      db: Queryable,
      type: 'PRODUCT' | 'CATEGORY' | 'BRAND' | 'COLLECTION',
      ids: readonly string[],
    ): Promise<Set<string>> {
      if (ids.length === 0) return new Set();
      const where = { id: { in: [...ids] }, deletedAt: null };
      const select = { id: true } as const;
      let rows: { id: string }[];
      switch (type) {
        case 'PRODUCT':
          rows = await db.product.findMany({ where, select });
          break;
        case 'CATEGORY':
          rows = await db.category.findMany({ where, select });
          break;
        case 'BRAND':
          rows = await db.brand.findMany({ where, select });
          break;
        case 'COLLECTION':
          rows = await db.collection.findMany({ where, select });
          break;
      }
      return new Set(rows.map((r) => r.id));
    },
  };
}

export type CouponsRepository = ReturnType<typeof createCouponsRepository>;
