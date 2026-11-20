/**
 * Wishlist schemas — API_DOCUMENTATION.md §3.5. Strict bodies; never a user id.
 */
import { z } from 'zod';

import { PAGE_LIMITS, paginationQuery } from '../../core/http/pagination.js';
import { HARD_MAX_QTY } from '../cart/cart.schemas.js';

const idSchema = z.uuid({ message: 'Must be a valid id.' });

export const WishlistItemParams = z.object({ itemId: idSchema });
export const WishlistQuery = paginationQuery(PAGE_LIMITS.productListing);
export type WishlistQueryInput = z.output<typeof WishlistQuery>;

export const AddWishlistItemBody = z.strictObject({
  productId: idSchema,
  variantId: idSchema.optional(),
});
export type AddWishlistItemInput = z.output<typeof AddWishlistItemBody>;

export const MoveToCartBody = z.strictObject({
  variantId: idSchema.optional(),
  quantity: z
    .number({ message: 'Must be a whole number.' })
    .int('Must be a whole number.')
    .min(1, 'Must be at least 1.')
    .max(HARD_MAX_QTY, `Must be at most ${HARD_MAX_QTY}.`)
    .default(1),
});
export type MoveToCartInput = z.output<typeof MoveToCartBody>;
