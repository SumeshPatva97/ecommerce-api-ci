/**
 * Admin refund schemas — API_DOCUMENTATION.md §4.11, ADMIN_WORKFLOWS.md §11. Strict bodies; money
 * as decimal strings.
 *
 * `bankDetails` (OQ-63, OPEN) is deliberately NOT accepted: the approved schema has no encrypted
 * column for payout bank details, so they are never received or stored. COD bank-transfer payouts
 * are arranged by finance outside the system and closed with `POST …/complete { utr }`.
 */
import { z } from 'zod';

import { PAGE_LIMITS, paginationQuery } from '../../core/http/pagination.js';
import { MONEY_PATTERN } from '../../lib/money.js';

const idSchema = z.uuid({ message: 'Must be a valid id.' });
const money = z.string().trim().regex(MONEY_PATTERN, 'Use a decimal amount, e.g. "499.00".');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

export const REFUND_STATUSES = [
  'REQUESTED',
  'APPROVED',
  'REJECTED',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
] as const;
export const REFUND_METHODS = ['ORIGINAL_PAYMENT_METHOD', 'BANK_TRANSFER', 'STORE_CREDIT'] as const;

export const RefundIdParams = z.object({ refundId: idSchema });

export const RefundListQuery = paginationQuery(PAGE_LIMITS.adminList).extend({
  q: z.string().trim().min(1).max(100).optional(),
  status: z
    .string()
    .transform((v) => v.split(',').map((s) => s.trim()))
    .pipe(z.array(z.enum(REFUND_STATUSES)).min(1))
    .optional(),
  method: z.enum(REFUND_METHODS).optional(),
  orderId: idSchema.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type RefundListQueryInput = z.output<typeof RefundListQuery>;

export const CreateRefundBody = z.strictObject({
  orderId: idSchema,
  items: z
    .array(
      z.strictObject({
        orderItemId: idSchema,
        quantity: z.number().int().min(1),
        restock: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(100)
    .optional(),
  shippingRefund: money.optional(),
  amount: money.optional(),
  method: z.enum(REFUND_METHODS).optional(),
  reasonCode: z
    .string()
    .trim()
    .regex(/^[A-Z_]{2,40}$/, 'Use an UPPER_SNAKE_CASE reason code.')
    .default('OTHER'),
  reason: z.string().trim().min(1).max(500),
});
export type CreateRefundInput = z.output<typeof CreateRefundBody>;

export const ApproveRefundBody = z.strictObject({
  note: z.string().trim().min(1).max(500).optional(),
});
export type ApproveRefundInput = z.output<typeof ApproveRefundBody>;

export const RejectRefundBody = z.strictObject({
  reason: z.string().trim().min(1).max(500),
});

export const RetryRefundBody = z.strictObject({
  note: z.string().trim().min(1).max(500).optional(),
});

export const CompleteRefundBody = z.strictObject({
  utr: z.string().trim().min(1).max(40),
  transferredAt: z.iso
    .datetime({ offset: true, message: 'Must be an ISO-8601 date-time.' })
    .transform((v) => new Date(v)),
  note: z.string().trim().min(1).max(500).optional(),
});
export type CompleteRefundInput = z.output<typeof CompleteRefundBody>;
