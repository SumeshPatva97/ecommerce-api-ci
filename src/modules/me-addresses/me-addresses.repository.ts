/**
 * Address & recently-viewed persistence (Prisma only). Every query is scoped by `userId`, so a
 * foreign address is indistinguishable from a missing one (→ 404).
 */
import type { Prisma } from '../../generated/prisma/client.js';
import type { Queryable } from '../../core/db/transaction.js';
import { cardSelect, visibleWhere } from '../catalog/catalog.repository.js';

export const addressSelect = {
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
  updatedAt: true,
  state: { select: { name: true } },
} satisfies Prisma.UserAddressSelect;
export type AddressRow = Prisma.UserAddressGetPayload<{ select: typeof addressSelect }>;

export const recentSelect = {
  viewedAt: true,
  product: { select: cardSelect },
} satisfies Prisma.RecentlyViewedProductSelect;
export type RecentRow = Prisma.RecentlyViewedProductGetPayload<{ select: typeof recentSelect }>;

export function createMeAddressesRepository() {
  return {
    /** Serialises a customer's address writes (limit + single default invariants). */
    async lockUser(db: Queryable, userId: string): Promise<void> {
      await db.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    },

    listAddresses(db: Queryable, userId: string): Promise<AddressRow[]> {
      return db.userAddress.findMany({
        where: { userId },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
        select: addressSelect,
      });
    },

    findAddress(db: Queryable, userId: string, id: string): Promise<AddressRow | null> {
      return db.userAddress.findFirst({ where: { id, userId }, select: addressSelect });
    },

    countAddresses(db: Queryable, userId: string): Promise<number> {
      return db.userAddress.count({ where: { userId } });
    },

    async stateExists(db: Queryable, code: string): Promise<boolean> {
      return (await db.state.findUnique({ where: { code }, select: { code: true } })) !== null;
    },

    async clearDefault(db: Queryable, userId: string, exceptId?: string): Promise<void> {
      await db.userAddress.updateMany({
        where: {
          userId,
          isDefault: true,
          ...(exceptId === undefined ? {} : { id: { not: exceptId } }),
        },
        data: { isDefault: false },
      });
    },

    createAddress(
      db: Queryable,
      data: Prisma.UserAddressUncheckedCreateInput,
    ): Promise<AddressRow> {
      return db.userAddress.create({ data, select: addressSelect });
    },

    updateAddress(
      db: Queryable,
      id: string,
      data: Prisma.UserAddressUncheckedUpdateInput,
    ): Promise<AddressRow> {
      return db.userAddress.update({ where: { id }, data, select: addressSelect });
    },

    async deleteAddress(db: Queryable, id: string): Promise<void> {
      await db.userAddress.delete({ where: { id }, select: { id: true } });
    },

    newestOtherAddress(
      db: Queryable,
      userId: string,
      exceptId: string,
    ): Promise<{ id: string } | null> {
      return db.userAddress.findFirst({
        where: { userId, id: { not: exceptId } },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        select: { id: true },
      });
    },

    // ── recently viewed ─────────────────────────────────────────────────────────────────────

    listRecent(db: Queryable, userId: string, now: Date, take: number): Promise<RecentRow[]> {
      return db.recentlyViewedProduct.findMany({
        where: { userId, product: visibleWhere(now) },
        orderBy: [{ viewedAt: 'desc' }, { id: 'asc' }],
        take,
        select: recentSelect,
      });
    },

    async visibleProductIds(
      db: Queryable,
      ids: readonly string[],
      now: Date,
    ): Promise<Set<string>> {
      if (ids.length === 0) return new Set();
      const rows = await db.product.findMany({
        where: { id: { in: [...ids] }, ...visibleWhere(now) },
        select: { id: true },
      });
      return new Set(rows.map((r) => r.id));
    },

    async upsertView(db: Queryable, id: string, userId: string, productId: string, now: Date) {
      await db.recentlyViewedProduct.upsert({
        where: { userId_productId: { userId, productId } },
        create: { id, userId, productId, viewedAt: now, viewCount: 1 },
        update: { viewedAt: now, viewCount: { increment: 1 } },
        select: { id: true },
      });
    },

    existingViews(
      db: Queryable,
      userId: string,
      productIds: readonly string[],
    ): Promise<{ id: string; productId: string; viewedAt: Date }[]> {
      return db.recentlyViewedProduct.findMany({
        where: { userId, productId: { in: [...productIds] } },
        select: { id: true, productId: true, viewedAt: true },
      });
    },

    async createView(db: Queryable, data: Prisma.RecentlyViewedProductUncheckedCreateInput) {
      await db.recentlyViewedProduct.create({ data, select: { id: true } });
    },

    async setViewedAt(db: Queryable, id: string, viewedAt: Date) {
      await db.recentlyViewedProduct.update({
        where: { id },
        data: { viewedAt },
        select: { id: true },
      });
    },

    /** Deletes everything beyond the newest `keep` rows (OQ-33). */
    async trim(db: Queryable, userId: string, keep: number): Promise<number> {
      const stale = await db.recentlyViewedProduct.findMany({
        where: { userId },
        orderBy: [{ viewedAt: 'desc' }, { id: 'asc' }],
        skip: keep,
        select: { id: true },
      });
      if (stale.length === 0) return 0;
      const { count } = await db.recentlyViewedProduct.deleteMany({
        where: { id: { in: stale.map((s) => s.id) } },
      });
      return count;
    },
  };
}

export type MeAddressesRepository = ReturnType<typeof createMeAddressesRepository>;
