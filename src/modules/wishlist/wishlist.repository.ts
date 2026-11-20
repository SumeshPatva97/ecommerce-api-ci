/**
 * Wishlist persistence (Prisma only). Items are always reached through the owner's wishlist, so a
 * foreign item is indistinguishable from a missing one (→ 404).
 */
import { randomUUID } from 'node:crypto';

import type { Prisma } from '../../generated/prisma/client.js';
import type { Queryable } from '../../core/db/transaction.js';
import { cardSelect, visibleWhere } from '../catalog/catalog.repository.js';

export const wishlistItemSelect = {
  id: true,
  productId: true,
  variantId: true,
  createdAt: true,
  product: {
    select: { ...cardSelect, status: true, deletedAt: true },
  },
} satisfies Prisma.WishlistItemSelect;
export type WishlistItemRow = Prisma.WishlistItemGetPayload<{ select: typeof wishlistItemSelect }>;

export function createWishlistRepository() {
  return {
    async findWishlistId(db: Queryable, userId: string): Promise<string | null> {
      const row = await db.wishlist.findUnique({ where: { userId }, select: { id: true } });
      return row?.id ?? null;
    },

    async ensureWishlist(db: Queryable, userId: string): Promise<string> {
      const row = await db.wishlist.upsert({
        where: { userId },
        create: { id: randomUUID(), userId },
        update: {},
        select: { id: true },
      });
      return row.id;
    },

    async list(
      db: Queryable,
      wishlistId: string,
      skip: number,
      take: number,
    ): Promise<{ rows: WishlistItemRow[]; total: number }> {
      const where = { wishlistId };
      const [rows, total] = await Promise.all([
        db.wishlistItem.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          skip,
          take,
          select: wishlistItemSelect,
        }),
        db.wishlistItem.count({ where }),
      ]);
      return { rows, total };
    },

    count(db: Queryable, wishlistId: string): Promise<number> {
      return db.wishlistItem.count({ where: { wishlistId } });
    },

    findDuplicate(
      db: Queryable,
      wishlistId: string,
      productId: string,
      variantId: string | null,
    ): Promise<{ id: string } | null> {
      return db.wishlistItem.findFirst({
        where: { wishlistId, productId, variantId },
        select: { id: true },
      });
    },

    findVisibleProduct(
      db: Queryable,
      productId: string,
      now: Date,
    ): Promise<{ id: string; productType: string } | null> {
      return db.product.findFirst({
        where: { id: productId, ...visibleWhere(now) },
        select: { id: true, productType: true },
      });
    },

    findActiveVariant(
      db: Queryable,
      productId: string,
      variantId: string,
    ): Promise<{ id: string } | null> {
      return db.productVariant.findFirst({
        where: { id: variantId, productId, status: 'ACTIVE', deletedAt: null },
        select: { id: true },
      });
    },

    findDefaultVariant(db: Queryable, productId: string): Promise<{ id: string } | null> {
      return db.productVariant.findFirst({
        where: { productId, status: 'ACTIVE', deletedAt: null },
        orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
        select: { id: true },
      });
    },

    create(db: Queryable, data: Prisma.WishlistItemUncheckedCreateInput): Promise<WishlistItemRow> {
      return db.wishlistItem.create({ data, select: wishlistItemSelect });
    },

    findOwnedItem(
      db: Queryable,
      userId: string,
      itemId: string,
    ): Promise<{
      id: string;
      productId: string;
      variantId: string | null;
      product: { productType: string };
    } | null> {
      return db.wishlistItem.findFirst({
        where: { id: itemId, wishlist: { userId } },
        select: {
          id: true,
          productId: true,
          variantId: true,
          product: { select: { productType: true } },
        },
      });
    },

    async delete(db: Queryable, id: string): Promise<void> {
      await db.wishlistItem.delete({ where: { id }, select: { id: true } });
    },
  };
}

export type WishlistRepository = ReturnType<typeof createWishlistRepository>;
