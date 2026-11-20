/**
 * Cart schemas — API_DOCUMENTATION.md §3.4. Bodies are strict; a user id is never accepted (the
 * cart always belongs to the authenticated customer).
 *
 * `quantity` is bounded here by a hard ceiling (99, the settings validator's maximum); the
 * configurable per-line cap (`checkout.max_qty_per_line`, PROVISIONAL OQ-57 default 5) is enforced
 * by the service with `code: MAX_QTY_PER_LINE`.
 */
import { z } from 'zod';

import { COUPON_PATTERN, normalizeCode } from '../../lib/normalize.js';

export const HARD_MAX_QTY = 99;
/** API §3.4: max 50 distinct lines per cart / per merge request. */
export const MAX_CART_LINES = 50;

const idSchema = z.uuid({ message: 'Must be a valid id.' });
const quantitySchema = z
  .number({ message: 'Must be a whole number.' })
  .int('Must be a whole number.')
  .min(1, 'Must be at least 1.')
  .max(HARD_MAX_QTY, `Must be at most ${HARD_MAX_QTY}.`);

export const CartItemParams = z.object({ itemId: idSchema });

export const AddCartItemBody = z.strictObject({ variantId: idSchema, quantity: quantitySchema });
export type AddCartItemInput = z.output<typeof AddCartItemBody>;

export const UpdateCartItemBody = z.strictObject({ quantity: quantitySchema });
export type UpdateCartItemInput = z.output<typeof UpdateCartItemBody>;

export const MergeCartBody = z.strictObject({
  items: z
    .array(z.strictObject({ variantId: idSchema, quantity: quantitySchema }))
    .max(MAX_CART_LINES, `At most ${MAX_CART_LINES} items can be merged.`),
});
export type MergeCartInput = z.output<typeof MergeCartBody>;

export const couponCodeSchema = z
  .string()
  .max(64)
  .transform(normalizeCode)
  .pipe(z.string().regex(COUPON_PATTERN, 'Use 3–32 letters, numbers, hyphens or underscores.'));

export const ApplyCouponBody = z.strictObject({ code: couponCodeSchema });
export type ApplyCouponInput = z.output<typeof ApplyCouponBody>;
