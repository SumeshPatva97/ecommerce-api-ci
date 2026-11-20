/**
 * Admin promotion schemas — API_DOCUMENTATION.md §4.9 (Promotions). Strict bodies.
 *
 * Deviation (schema-bound): the approved `promotions` table has no `description` /
 * `banner_label` columns, so those request fields are not accepted; the promotion `name` is the
 * badge label (DATABASE_DESIGN §11.4 "badge fallback"). `includeDescendants` (CATEGORY scope,
 * default true) maps to `promotion_categories.include_descendants`.
 */
import { z } from 'zod';

import { PAGE_LIMITS, paginationQuery } from '../../core/http/pagination.js';
import { MONEY_PATTERN } from '../../lib/money.js';
import { promotionRuleIssues } from './promotions.rules.js';

const idSchema = z.uuid({ message: 'Must be a valid id.' });
export const PromotionIdParams = z.object({ promotionId: idSchema });

const money = z.string().trim().regex(MONEY_PATTERN, 'Use a decimal amount, e.g. "499.00".');
const dateTime = z.iso
  .datetime({ offset: true, message: 'Must be an ISO-8601 date-time.' })
  .transform((v) => new Date(v));
export const SCOPES = ['PRODUCT', 'CATEGORY', 'BRAND', 'COLLECTION'] as const;

const fields = {
  name: z
    .string()
    .trim()
    .min(3, 'Must be at least 3 characters.')
    .max(100, 'Must be at most 100 characters.'),
  scope: z.enum(SCOPES),
  targetIds: z
    .array(idSchema)
    .min(1, 'Select at least one target.')
    .max(500, 'At most 500 targets.'),
  includeDescendants: z.boolean().optional(),
  discountType: z.enum(['PERCENTAGE', 'FIXED_AMOUNT']),
  discountValue: money,
  maxDiscountAmount: money.nullable().optional(),
  startsAt: dateTime,
  endsAt: dateTime,
  priority: z.number().int('Must be a whole number.').min(1).max(100).optional(),
  status: z.enum(['DRAFT', 'SCHEDULED']).optional(),
};

export const CreatePromotionBody = z.strictObject(fields).superRefine((v, ctx) => {
  for (const issue of promotionRuleIssues(v)) {
    ctx.addIssue({ code: 'custom', path: [issue.field], message: issue.message });
  }
});
export type CreatePromotionInput = z.output<typeof CreatePromotionBody>;

export const UpdatePromotionBody = z
  .strictObject(fields)
  .partial()
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: 'Provide at least one field to update.',
  });
export type UpdatePromotionInput = z.output<typeof UpdatePromotionBody>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD (IST).');

export const PromotionListQuery = paginationQuery(PAGE_LIMITS.adminList).extend({
  q: z.string().trim().min(1).max(100).optional(),
  status: z.enum(['DRAFT', 'SCHEDULED', 'ACTIVE', 'PAUSED', 'EXPIRED']).optional(),
  scope: z.enum(SCOPES).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type PromotionListQueryInput = z.output<typeof PromotionListQuery>;
