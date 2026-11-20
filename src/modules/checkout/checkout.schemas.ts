/** Checkout request schemas — API_DOCUMENTATION.md §3.9 (strict bodies; amounts never accepted). */
import { z } from 'zod';

import { isValidGstin } from '../../lib/tax/index.js';

const id = z.uuid({ message: 'Must be a valid id.' });

const buyerGstin = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isValidGstin, 'Enter a valid 15-character GSTIN.')
  .nullable()
  .optional();

const quoteFields = {
  shippingAddressId: id,
  billingAddressId: id.optional(),
  shippingMethodId: id.optional(),
  paymentMethod: z.enum(['ONLINE', 'COD']),
  buyerGstin,
};

export const CheckoutSummaryBody = z.strictObject(quoteFields);
export type CheckoutSummaryInput = z.output<typeof CheckoutSummaryBody>;

export const QUOTE_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

export const PlaceOrderBody = z.strictObject({
  ...quoteFields,
  shippingMethodId: id,
  quoteHash: z.string().trim().regex(QUOTE_HASH_PATTERN, 'Invalid quote hash.'),
  customerNote: z
    .string()
    .max(500)
    .transform((v) =>
      v
        .replace(/<[^>]*>/g, '')
        .replace(/\p{Cc}/gu, (c) => (c === '\n' ? c : ''))
        .trim(),
    )
    .optional(),
  acceptTerms: z.literal(true, { message: 'You must accept the terms to place the order.' }),
});
export type PlaceOrderInput = z.output<typeof PlaceOrderBody>;
