/**
 * Cart persistence (Prisma only). Every read is scoped by `userId` so a foreign cart item is
 * indistinguishable from a missing one (→ 404, API §3.4).
 */
import type { Prisma } from '../../generated/prisma/client.js';
import type { Queryable } from '../../core/db/transaction.js';

const imageSelect = { cloudinaryPublicId: true, altText: true } as const;

export const cartItemSelect = {
  id: true,
  variantId: true,
  quantity: true,
  unitPriceAtAdd: true,
  createdAt: true,
  variant: {
    select: {
      id: true,
      sku: true,
      name: true,
      mrp: true,
      sellingPrice: true,
      status: true,
      deletedAt: true,
      productId: true,
      inventory: {
        select: { quantityOnHand: true, quantityReserved: true, lowStockThreshold: true },
      },
      images: {
        where: { mediaType: 'IMAGE' },
        select: imageSelect,
        orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
        take: 1,
      },
      product: {
        select: {
          id: true,
          slug: true,
          name: true,
          status: true,
          deletedAt: true,
          publishedAt: true,
          images: {
            where: { mediaType: 'IMAGE', variantId: null },
            select: imageSelect,
            orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
            take: 1,
          },
        },
      },
    },
  },
} satisfies Prisma.CartItemSelect;

export const cartSelect = {
  id: true,
  userId: true,
  couponId: true,
  couponCode: true,
  items: { select: cartItemSelect, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.CartSelect;

export type CartRow = Prisma.CartGetPayload<{ select: typeof cartSelect }>;
export type CartItemRow = CartRow['items'][number];

/** What add/update/merge need to validate a variant. */
export const variantCheckSelect = {
  id: true,
  sku: true,
  name: true,
  status: true,
  deletedAt: true,
  sellingPrice: true,
  product: { select: { name: true, status: true, deletedAt: true, publishedAt: true } },
  inventory: { select: { quantityOnHand: true, quantityReserved: true } },
} satisfies Prisma.ProductVariantSelect;
export type VariantCheckRow = Prisma.ProductVariantGetPayload<{
  select: typeof variantCheckSelect;
}>;

export function createCartRepository() {
  return {
    findActiveCart(db: Queryable, userId: string): Promise<CartRow | null> {
      return db.cart.findFirst({
        where: { userId, status: 'ACTIVE' },
        orderBy: { createdAt: 'asc' },
        select: cartSelect,
      });
    },

    findActiveCartRef(
      db: Queryable,
      userId: string,
    ): Promise<{ id: string; couponId: string | null } | null> {
      return db.cart.findFirst({
        where: { userId, status: 'ACTIVE' },
        orderBy: { createdAt: 'asc' },
        select: { id: true, couponId: true },
      });
    },

    /** RD-08: the customer's most recently abandoned cart (reactivation candidate), or null. */
    findNewestAbandonedCartRef(db: Queryable, userId: string): Promise<{ id: string } | null> {
      return db.cart.findFirst({
        where: { userId, status: 'ABANDONED' },
        orderBy: [{ abandonedAt: 'desc' }, { lastActivityAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });
    },

    /**
     * RD-08: ABANDONED → ACTIVE as a compare-and-set (items are kept). Returns false when the cart
     * is no longer ABANDONED (a concurrent request reactivated it, or the purge removed it).
     * Throws Prisma P2002 when the customer already has an ACTIVE cart: the database's unique
     * `uq_carts_active_owner` (generated `active_owner_key`) allows only one.
     */
    async reactivateCart(db: Queryable, id: string, now: Date): Promise<boolean> {
      const { count } = await db.cart.updateMany({
        where: { id, status: 'ABANDONED' },
        data: { status: 'ACTIVE', abandonedAt: null, lastActivityAt: now },
      });
      return count === 1;
    },

    /**
     * M1: first statement of a cart-mutating transaction. An UPDATE is a MySQL *current read*: it
     * locks the cart row and evaluates the condition against the latest committed state (not the
     * transaction's REPEATABLE READ snapshot). Returns false when the cart is no longer this
     * customer's ACTIVE cart (converted, abandoned or replaced since it was resolved).
     */
    async claimActiveCart(db: Queryable, id: string, userId: string, now: Date): Promise<boolean> {
      const { count } = await db.cart.updateMany({
        where: { id, userId, status: 'ACTIVE' },
        data: { lastActivityAt: now },
      });
      return count === 1;
    },

    createCart(db: Queryable, id: string, userId: string, now: Date): Promise<CartRow> {
      return db.cart.create({
        data: { id, userId, status: 'ACTIVE', lastActivityAt: now },
        select: cartSelect,
      });
    },

    /** Item of the user's ACTIVE cart, or null (also for another customer's item). */
    findOwnedItem(
      db: Queryable,
      userId: string,
      itemId: string,
    ): Promise<{ id: string; cartId: string; variantId: string; quantity: number } | null> {
      return db.cartItem.findFirst({
        where: { id: itemId, cart: { userId, status: 'ACTIVE' } },
        select: { id: true, cartId: true, variantId: true, quantity: true },
      });
    },

    findItemByVariant(
      db: Queryable,
      cartId: string,
      variantId: string,
    ): Promise<{ id: string; quantity: number } | null> {
      return db.cartItem.findUnique({
        where: { cartId_variantId: { cartId, variantId } },
        select: { id: true, quantity: true },
      });
    },

    listItems(
      db: Queryable,
      cartId: string,
    ): Promise<{ id: string; variantId: string; quantity: number }[]> {
      return db.cartItem.findMany({
        where: { cartId },
        select: { id: true, variantId: true, quantity: true },
      });
    },

    countItems(db: Queryable, cartId: string): Promise<number> {
      return db.cartItem.count({ where: { cartId } });
    },

    findVariant(db: Queryable, variantId: string): Promise<VariantCheckRow | null> {
      return db.productVariant.findUnique({ where: { id: variantId }, select: variantCheckSelect });
    },

    findVariants(db: Queryable, variantIds: readonly string[]): Promise<VariantCheckRow[]> {
      return db.productVariant.findMany({
        where: { id: { in: [...variantIds] } },
        select: variantCheckSelect,
      });
    },

    async createItem(db: Queryable, data: Prisma.CartItemUncheckedCreateInput): Promise<void> {
      await db.cartItem.create({ data, select: { id: true } });
    },

    async updateItem(
      db: Queryable,
      id: string,
      data: Prisma.CartItemUncheckedUpdateInput,
    ): Promise<void> {
      await db.cartItem.update({ where: { id }, data, select: { id: true } });
    },

    async deleteItem(db: Queryable, id: string): Promise<void> {
      await db.cartItem.delete({ where: { id }, select: { id: true } });
    },

    async updateCart(
      db: Queryable,
      id: string,
      data: Prisma.CartUncheckedUpdateInput,
    ): Promise<void> {
      await db.cart.update({ where: { id }, data, select: { id: true } });
    },
  };
}

export type CartRepository = ReturnType<typeof createCartRepository>;
