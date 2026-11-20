/**
 * Wishlist use-cases — API_DOCUMENTATION.md §3.5. One wishlist per customer (created lazily),
 * max 200 items, duplicates (same product + variant) → 409 `DUPLICATE_RESOURCE` (the FE treats it
 * as success). `move-to-cart` adds through the cart service (same stock / cap rules) and then
 * removes the wishlist item.
 */
import { randomUUID } from 'node:crypto';

import type { AppContainer } from '../../container.js';
import { withTransaction } from '../../core/db/transaction.js';
import { AppError } from '../../core/errors/AppError.js';
import { buildPageMeta, toSkipTake, type PageMeta } from '../../core/http/pagination.js';
import type { CartDto, CartService } from '../cart/index.js';
import { deliveryFromConfig } from '../media/cloudinary.js';
import { toWishlistItemDto, type WishlistItemDto } from './wishlist.mapper.js';
import { createWishlistRepository, type WishlistRepository } from './wishlist.repository.js';
import type {
  AddWishlistItemInput,
  MoveToCartInput,
  WishlistQueryInput,
} from './wishlist.schemas.js';

export const MAX_WISHLIST_ITEMS = 200;

export interface WishlistService {
  list(
    userId: string,
    query: WishlistQueryInput,
  ): Promise<{ items: WishlistItemDto[]; meta: PageMeta }>;
  add(userId: string, input: AddWishlistItemInput): Promise<WishlistItemDto>;
  remove(userId: string, itemId: string): Promise<{ id: string; deleted: true }>;
  moveToCart(
    userId: string,
    itemId: string,
    input: MoveToCartInput,
  ): Promise<{ cart: CartDto; wishlistItemRemoved: true }>;
}

const itemNotFound = (): AppError => new AppError('NOT_FOUND', 'Wishlist item not found.');

export function createWishlistService(
  container: AppContainer,
  cart: CartService,
  repo: WishlistRepository = createWishlistRepository(),
): WishlistService {
  const { db, clock } = container;
  const delivery = deliveryFromConfig(container.config.integrations.media);

  return {
    async list(userId, query) {
      const now = clock();
      const wishlistId = await repo.findWishlistId(db, userId);
      if (wishlistId === null) {
        return { items: [], meta: buildPageMeta(query.page, query.limit, 0) };
      }
      const { skip, take } = toSkipTake(query.page, query.limit);
      const { rows, total } = await repo.list(db, wishlistId, skip, take);
      return {
        items: rows.map((r) => toWishlistItemDto(r, delivery, now)),
        meta: buildPageMeta(query.page, query.limit, total),
      };
    },

    async add(userId, input) {
      const now = clock();
      return withTransaction(db, async ({ tx }) => {
        const product = await repo.findVisibleProduct(tx, input.productId, now);
        if (product === null) throw new AppError('NOT_FOUND', 'Product not found.');
        if (
          input.variantId !== undefined &&
          (await repo.findActiveVariant(tx, product.id, input.variantId)) === null
        ) {
          throw new AppError('NOT_FOUND', 'Variant not found.');
        }
        const wishlistId = await repo.ensureWishlist(tx, userId);
        const variantId = input.variantId ?? null;
        if ((await repo.findDuplicate(tx, wishlistId, product.id, variantId)) !== null) {
          const message = 'This item is already in your wishlist.';
          throw new AppError('DUPLICATE_RESOURCE', message, {
            details: [{ field: 'productId', message, code: 'ALREADY_WISHLISTED' }],
          });
        }
        if ((await repo.count(tx, wishlistId)) >= MAX_WISHLIST_ITEMS) {
          const message = `Your wishlist can hold at most ${MAX_WISHLIST_ITEMS} items.`;
          throw new AppError('VALIDATION_ERROR', message, {
            details: [{ field: 'productId', message, code: 'WISHLIST_LIMIT' }],
          });
        }
        const row = await repo.create(tx, {
          id: randomUUID(),
          wishlistId,
          productId: product.id,
          variantId,
          createdAt: now,
        });
        return toWishlistItemDto(row, delivery, now);
      });
    },

    async remove(userId, itemId) {
      const item = await repo.findOwnedItem(db, userId, itemId);
      if (item === null) throw itemNotFound();
      await repo.delete(db, item.id);
      return { id: item.id, deleted: true as const };
    },

    async moveToCart(userId, itemId, input) {
      const item = await repo.findOwnedItem(db, userId, itemId);
      if (item === null) throw itemNotFound();
      let variantId = input.variantId ?? item.variantId;
      if (input.variantId !== undefined) {
        if ((await repo.findActiveVariant(db, item.productId, input.variantId)) === null) {
          throw new AppError('NOT_FOUND', 'Variant not found.');
        }
      } else if (variantId === null) {
        if (item.product.productType !== 'SIMPLE') {
          const message = 'Choose a variant before moving this item to the cart.';
          throw new AppError('VALIDATION_ERROR', message, {
            details: [{ field: 'variantId', message, code: 'VARIANT_REQUIRED' }],
          });
        }
        variantId = (await repo.findDefaultVariant(db, item.productId))?.id ?? null;
      }
      if (variantId === null) throw new AppError('NOT_FOUND', 'This item is not available.');
      const cartDto = await cart.addItem(userId, { variantId, quantity: input.quantity });
      await repo.delete(db, item.id);
      return { cart: cartDto, wishlistItemRemoved: true as const };
    },
  };
}
