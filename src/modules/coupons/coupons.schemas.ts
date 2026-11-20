/**
 * Admin coupon schemas — API_DOCUMENTATION.md §4.9 (`POST /admin/coupons` rule table). Strict
 * bodies; money as decimal strings; dates ISO-8601. Cross-field rules live in `coupons.rules.ts`
 * so PATCH can re-run them on the merged row.
 */
import { z } from 'zod';

import { PAGE_LIMITS, paginationQuery } from '../../core/http/pagination.js';
import { MONEY_PATTERN } from '../../lib/money.js';
import { COUPON_PATTERN, normalizeCode } from '../../lib/normalize.js';
import { MESSAGES, couponRuleIssues } from './coupons.rules.js';

const idSchema = z.uuid({ message: 'Must be a valid id.' });
export const CouponIdParams = z.object({ couponId: idSchema });

const money = z.string().trim().regex(MONEY_PATTERN, 'Use a decimal amount, e.g. "499.00".');
const dateTime = z.iso
  .datetime({ offset: true, message: 'Must be an ISO-8601 date-time.' })
  .transform((v) => new Date(v));

export const couponCode = z
  .string()
  .max(64)
  .transform(normalizeCode)
  .pipe(z.string().regex(COUPON_PATTERN, MESSAGES.code));

const MAX_TARGETS = 500;
const idList = z.array(idSchema).max(MAX_TARGETS, `At most ${MAX_TARGETS} ids.`).optional();

export const applicabilitySchema = z.strictObject({
  includeProductIds: idList,
  includeCategoryIds: idList,
  includeBrandIds: idList,
  includeCollectionIds: idList,
  excludeProductIds: idList,
  excludeCategoryIds: idList,
  excludeBrandIds: idList,
  excludeCollectionIds: idList,
});
export type ApplicabilityInput = z.output<typeof applicabilitySchema>;

const fields = {
  code: couponCode,
  description: z.string().trim().max(200).nullable().optional(),
  discountType: z.enum(['PERCENTAGE', 'FIXED_AMOUNT']),
  discountValue: money,
  maxDiscountAmount: money.nullable().optional(),
  minOrderValue: money.nullable().optional(),
  startsAt: dateTime,
  expiresAt: dateTime,
  usageLimitEnabled: z.boolean(),
  usageLimit: z.number({ message: MESSAGES.wholeNumber }).nullable().optional(),
  perCustomerLimit: z
    .number({ message: MESSAGES.wholeNumber })
    .int(MESSAGES.wholeNumber)
    .min(1, MESSAGES.wholeNumber)
    .max(1_000_000)
    .nullable()
    .optional(),
  firstOrderOnly: z.boolean().optional(),
  isCombinableWithPromotions: z.boolean().optional(),
  isPublic: z.boolean().optional(),
  applicability: applicabilitySchema.optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
};

export const CreateCouponBody = z.strictObject(fields).superRefine((v, ctx) => {
  for (const issue of couponRuleIssues(v)) {
    ctx.addIssue({ code: 'custom', path: [issue.field], message: issue.message });
  }
});
export type CreateCouponInput = z.output<typeof CreateCouponBody>;

export const UpdateCouponBody = z
  .strictObject(fields)
  .partial()
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: 'Provide at least one field to update.',
  });
export type UpdateCouponInput = z.output<typeof UpdateCouponBody>;

export const CouponListQuery = paginationQuery(PAGE_LIMITS.adminList).extend({
  q: z.string().trim().min(1).max(100).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  validity: z.enum(['active', 'scheduled', 'expired']).optional(),
  discountType: z.enum(['PERCENTAGE', 'FIXED_AMOUNT']).optional(),
});
export type CouponListQueryInput = z.output<typeof CouponListQuery>;

export const CouponUsageQuery = paginationQuery(PAGE_LIMITS.adminList).extend({
  status: z.enum(['RESERVED', 'REDEEMED', 'RELEASED']).optional(),
});
export type CouponUsageQueryInput = z.output<typeof CouponUsageQuery>;
