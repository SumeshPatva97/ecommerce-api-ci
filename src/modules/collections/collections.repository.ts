/**
 * Collection persistence (Prisma only, no business rules).
 */
import type { Collection, Prisma } from '../../generated/prisma/client.js';
import type { Queryable } from '../../core/db/transaction.js';

export type CollectionRow = Collection;
export type CollectionWithCount = Collection & { _count: { products: number } };

/** Membership rows counted on collections: product ACTIVE and not deleted. */
const ACTIVE_MEMBERS = {
  where: { product: { status: 'ACTIVE', deletedAt: null } },
} as const;
const WITH_COUNT = { _count: { select: { products: ACTIVE_MEMBERS } } } as const;

/** Storefront visibility: active, not deleted, inside the optional window. */
export function publicCollectionWhere(now: Date): Prisma.CollectionWhereInput {
  return {
    isActive: true,
    deletedAt: null,
    AND: [
      { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
      { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
    ],
  };
}

export function createCollectionsRepository() {
  return {
    findById(db: Queryable, id: string): Promise<CollectionRow | null> {
      return db.collection.findUnique({ where: { id } });
    },

    findByIdWithCount(db: Queryable, id: string): Promise<CollectionWithCount | null> {
      return db.collection.findUnique({ where: { id }, include: WITH_COUNT });
    },

    /** Includes soft-deleted rows (PROVISIONAL OQ-39: names/slugs stay reserved). */
    findByNameNormalized(db: Queryable, nameNormalized: string): Promise<CollectionRow | null> {
      return db.collection.findUnique({ where: { nameNormalized } });
    },

    findBySlug(db: Queryable, slug: string): Promise<CollectionRow | null> {
      return db.collection.findUnique({ where: { slug } });
    },

    async list(
      db: Queryable,
      where: Prisma.CollectionWhereInput,
      orderBy: Prisma.CollectionOrderByWithRelationInput[],
      skip: number,
      take: number,
    ): Promise<{ rows: CollectionWithCount[]; total: number }> {
      const [rows, total] = await Promise.all([
        db.collection.findMany({ where, orderBy, skip, take, include: WITH_COUNT }),
        db.collection.count({ where }),
      ]);
      return { rows, total };
    },

    create(db: Queryable, data: Prisma.CollectionUncheckedCreateInput): Promise<CollectionRow> {
      return db.collection.create({ data });
    },

    update(
      db: Queryable,
      id: string,
      data: Prisma.CollectionUncheckedUpdateInput,
    ): Promise<CollectionRow> {
      return db.collection.update({ where: { id }, data });
    },

    countActiveProducts(db: Queryable, collectionId: string): Promise<number> {
      return db.collectionProduct.count({ where: { collectionId, ...ACTIVE_MEMBERS.where } });
    },

    async memberIds(db: Queryable, collectionId: string): Promise<string[]> {
      const rows = await db.collectionProduct.findMany({
        where: { collectionId },
        orderBy: [{ sortOrder: 'asc' }, { addedAt: 'asc' }],
        select: { productId: true },
      });
      return rows.map((r) => r.productId);
    },

    async existingProductIds(db: Queryable, ids: readonly string[]): Promise<Set<string>> {
      if (ids.length === 0) return new Set();
      const rows = await db.product.findMany({
        where: { id: { in: [...ids] }, deletedAt: null },
        select: { id: true },
      });
      return new Set(rows.map((r) => r.id));
    },

    async replaceMembers(
      db: Queryable,
      collectionId: string,
      productIds: readonly string[],
      addedById: string | null,
      addedAt: Date,
    ): Promise<void> {
      await db.collectionProduct.deleteMany({ where: { collectionId } });
      if (productIds.length === 0) return;
      await db.collectionProduct.createMany({
        data: productIds.map((productId, index) => ({
          collectionId,
          productId,
          sortOrder: index,
          addedById,
          addedAt,
        })),
      });
    },

    listPublic(
      db: Queryable,
      now: Date,
      featured: boolean | undefined,
    ): Promise<CollectionWithCount[]> {
      return db.collection.findMany({
        where: {
          ...publicCollectionWhere(now),
          ...(featured === undefined ? {} : { isFeatured: featured }),
          // FR-SF-004: only collections with ≥ 1 active product (same rule as `productCount`).
          products: { some: ACTIVE_MEMBERS.where },
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        include: WITH_COUNT,
      });
    },

    findPublicBySlug(db: Queryable, slug: string, now: Date): Promise<CollectionWithCount | null> {
      return db.collection.findFirst({
        where: { slug, ...publicCollectionWhere(now) },
        include: WITH_COUNT,
      });
    },
  };
}

export type CollectionsRepository = ReturnType<typeof createCollectionsRepository>;
