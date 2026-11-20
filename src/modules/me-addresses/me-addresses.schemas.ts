/**
 * Customer address + recently-viewed schemas — API_DOCUMENTATION.md §2.10 (Address request DTO
 * and validation), §3.2, §3.6. Strict bodies; never a user id.
 *
 * - PROVISIONAL (OQ-37): India only (`country` = `IN`).
 * - PROVISIONAL (OQ-24): optional buyer GSTIN; its state prefix must equal `stateCode`.
 * - `addressType` (HOME|WORK|OTHER, added detail) is stored in `user_addresses.label`.
 */
import { z } from 'zod';

import { isValidGstin } from '../../lib/tax/gstin.js';
import { phoneSchema } from '../auth/auth.schemas.js';

const idSchema = z.uuid({ message: 'Must be a valid id.' });
export const AddressIdParams = z.object({ addressId: idSchema });

export const PIN_PATTERN = /^[1-9][0-9]{5}$/;
export const ADDRESS_TYPES = ['HOME', 'WORK', 'OTHER'] as const;

const text = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min, `Must be at least ${min} characters.`)
    .max(max, `Must be at most ${max} characters.`);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Must be at most ${max} characters.`)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

const gstinSchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isValidGstin, 'Enter a valid 15-character GSTIN.')
  .nullable()
  .optional();

const addressFields = {
  fullName: text(2, 100),
  phone: phoneSchema,
  line1: text(3, 150),
  line2: optionalText(150),
  landmark: optionalText(120),
  city: text(2, 80),
  district: optionalText(100),
  stateCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[0-9A-Z]{2}$/, 'Use the 2-character state code.'),
  pincode: z.string().trim().regex(PIN_PATTERN, 'Enter a valid 6-digit PIN code.'),
  country: z.literal('IN', { message: 'Only addresses in India are supported.' }).optional(),
  addressType: z.enum(ADDRESS_TYPES).optional(),
  companyName: optionalText(150),
  gstin: gstinSchema,
};

export const GSTIN_STATE_MESSAGE = 'GSTIN state code must match the address state.';

export const CreateAddressBody = z
  .strictObject({ ...addressFields, isDefault: z.boolean().optional() })
  .superRefine((v, ctx) => {
    if (typeof v.gstin === 'string' && v.gstin.slice(0, 2) !== v.stateCode) {
      ctx.addIssue({ code: 'custom', path: ['gstin'], message: GSTIN_STATE_MESSAGE });
    }
  });
export type CreateAddressInput = z.output<typeof CreateAddressBody>;

export const UpdateAddressBody = z
  .strictObject({
    ...addressFields,
    // Clearing the default is done by choosing another default address.
    isDefault: z.literal(true, { message: 'Choose another default address instead.' }),
  })
  .partial()
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: 'Provide at least one field to update.',
  });
export type UpdateAddressInput = z.output<typeof UpdateAddressBody>;

/** OQ-33: keep the last 20 products per customer. */
export const RECENTLY_VIEWED_MAX = 20;

export const RecentlyViewedQuery = z.object({
  limit: z.coerce.number().int().min(1).max(RECENTLY_VIEWED_MAX).default(RECENTLY_VIEWED_MAX),
});
export type RecentlyViewedQueryInput = z.output<typeof RecentlyViewedQuery>;

export const RecordViewBody = z.strictObject({ productId: idSchema });
export type RecordViewInput = z.output<typeof RecordViewBody>;

export const MergeViewsBody = z.strictObject({
  items: z
    .array(
      z.strictObject({
        productId: idSchema,
        viewedAt: z.iso
          .datetime({ offset: true, message: 'Must be an ISO-8601 date-time.' })
          .transform((v) => new Date(v)),
      }),
    )
    .max(RECENTLY_VIEWED_MAX, `At most ${RECENTLY_VIEWED_MAX} items.`),
});
export type MergeViewsInput = z.output<typeof MergeViewsBody>;
