/**
 * Promotion persistence (Prisma only). Targets live in one child table per scope
 * (`promotion_products|categories|brands|collections`, R-11).
 */
import type { Prisma } from '../../generated/prisma/client.js';
import type { Queryable } from '../../core/db/transaction.js';

export const promotionSelect = {
  id: true,
  name: true,
  nameNormalized: true,
  scope: true,
  discountType: true,
  discountValue: true,
  maxDiscountAmount: true,
  startsAt: true,
  endsAt: true,
  status: true,
  priority: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  products: { select: { productId: true } },
  categories: { select: { categoryId: true, includeDescendants: true } },
  brands: { select: { brandId: true } },
  collections: { select: { collectionId: true } },
} satisfies Prisma.PromotionSelect;
export type PromotionRow = Prisma.PromotionGetPayload<{ select: typeof promotionSelect }>;

export type Scope = 'PRODUCT' | 'CATEGORY' | 'BRAND' | 'COLLECTION';

export function createPromotionsRepository() {
  return {
    async lock(db: Queryable, id: string): Promise<void> {
      await db.$queryRaw`SELECT id FROM promotions WHERE id = ${id} FOR UPDATE`;
    },

    findLive(db: Queryable, id: string): Promise<PromotionRow | null> {
      return db.promotion.findFirst({ where: { id, deletedAt: null }, select: promotionSelect });
    },

    /** Includes soft-deleted rows: names stay reserved. */
    findByName(db: Queryable, nameNormalized: string): Promise<{ id: string } | null> {
      return db.promotion.findUnique({ where: { nameNormalized }, select: { id: true } });
    },

    async list(
      db: Queryable,
      where: Prisma.PromotionWhereInput,
      skip: number,
      take: number,
    ): Promise<{ rows: PromotionRow[]; total: number }> {
      const [rows, total] = await Promise.all([
        db.promotion.findMany({
          where,
          orderBy: [{ startsAt: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
          skip,
          take,
          select: promotionSelect,
        }),
        db.promotion.count({ where }),
      ]);
      return { rows, total };
    },

    create(db: Queryable, data: Prisma.PromotionUncheckedCreateInput): Promise<PromotionRow> {
      return db.promotion.create({ data, select: promotionSelect });
    },

    update(
      db: Queryable,
      id: string,
      data: Prisma.PromotionUncheckedUpdateInput,
    ): Promise<PromotionRow> {
      return db.promotion.update({ where: { id }, data, select: promotionSelect });
    },

    async replaceTargets(
      db: Queryable,
      promotionId: string,
      scope: Scope,
      ids: readonly string[],
      includeDescendants: boolean,
    ): Promise<void> {
      await db.promotionProduct.deleteMany({ where: { promotionId } });
      await db.promotionCategory.deleteMany({ where: { promotionId } });
      await db.promotionBrand.deleteMany({ where: { promotionId } });
      await db.promotionCollection.deleteMany({ where: { promotionId } });
      switch (scope) {
        case 'PRODUCT':
          await db.promotionProduct.createMany({
            data: ids.map((productId) => ({ promotionId, productId })),
          });
          break;
        case 'CATEGORY':
          await db.promotionCategory.createMany({
            data: ids.map((categoryId) => ({ promotionId, categoryId, includeDescendants })),
          });
          break;
        case 'BRAND':
          await db.promotionBrand.createMany({
            data: ids.map((brandId) => ({ promotionId, brandId })),
          });
          break;
        case 'COLLECTION':
          await db.promotionCollection.createMany({
            data: ids.map((collectionId) => ({ promotionId, collectionId })),
          });
          break;
      }
    },

    countOrderItems(db: Queryable, promotionId: string): Promise<number> {
      return db.orderItem.count({ where: { promotionId } });
    },

    /** Ids among `ids` that exist and are not soft-deleted. */
    async existingTargets(
      db: Queryable,
      scope: Scope,
      ids: readonly string[],
    ): Promise<Set<string>> {
      const where = { id: { in: [...ids] }, deletedAt: null };
      const select = { id: true } as const;
      let rows: { id: string }[];
      switch (scope) {
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

export type PromotionsRepository = ReturnType<typeof createPromotionsRepository>;
