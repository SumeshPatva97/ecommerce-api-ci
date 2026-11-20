/**
 * Order schemas — API_DOCUMENTATION.md §3.10 (customer) and §4.7 (admin). Strict bodies.
 */
import { z } from 'zod';

import { PAGE_LIMITS, paginationQuery } from '../../core/http/pagination.js';
import { MONEY_PATTERN } from '../../lib/money.js';

const idSchema = z.uuid({ message: 'Must be a valid id.' });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const money = z.string().trim().regex(MONEY_PATTERN, 'Use a decimal amount, e.g. "499.00".');

export const ORDER_STATUSES = [
  'PENDING_PAYMENT',
  'PAYMENT_FAILED',
  'CONFIRMED',
  'PROCESSING',
  'PACKED',
  'SHIPPED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'CANCELLATION_REQUESTED',
  'CANCELLED',
  'RETURN_REQUESTED',
  'RETURNED',
] as const;

const statusList = z
  .string()
  .transform((v) => v.split(',').map((s) => s.trim()))
  .pipe(z.array(z.enum(ORDER_STATUSES)).min(1));

export const OrderNumberParams = z.object({
  orderNumber: z.string().regex(/^ORD-\d{6}-\d{5}$/, 'Unknown order number.'),
});
export const OrderIdParams = z.object({ orderId: idSchema });

/** Customer list: default 10, max 50 (§3.10). */
export const MyOrdersQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  status: statusList.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type MyOrdersQueryInput = z.output<typeof MyOrdersQuery>;

export const CUSTOMER_CANCEL_REASONS = [
  'CHANGED_MIND',
  'ORDERED_BY_MISTAKE',
  'FOUND_BETTER_PRICE',
  'DELIVERY_TOO_LATE',
  'OTHER',
] as const;

export const CustomerCancelBody = z
  .strictObject({
    reasonCode: z.enum(CUSTOMER_CANCEL_REASONS),
    comment: z.string().trim().min(1).max(500).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.reasonCode === 'OTHER' && v.comment === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['comment'],
        message: 'Required when reason is OTHER.',
      });
    }
  });
export type CustomerCancelInput = z.output<typeof CustomerCancelBody>;

export const DocumentQuery = z.object({
  type: z.enum(['TAX_INVOICE', 'CREDIT_NOTE']).default('TAX_INVOICE'),
  invoiceNumber: z
    .string()
    .regex(/^[A-Z]{2,8}\/\d{4}\/\d{6}$/, 'Unknown document number.')
    .optional(),
});
export type DocumentQueryInput = z.output<typeof DocumentQuery>;

export const AdminOrdersQuery = paginationQuery(PAGE_LIMITS.adminList).extend({
  q: z.string().trim().min(1).max(100).optional(),
  status: statusList.optional(),
  paymentStatus: z
    .enum([
      'PENDING',
      'AUTHORIZED',
      'CAPTURED',
      'FAILED',
      'CANCELLED',
      'PARTIALLY_REFUNDED',
      'REFUNDED',
    ])
    .optional(),
  paymentMethod: z.enum(['ONLINE', 'COD']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  minTotal: money.optional(),
  maxTotal: money.optional(),
  sort: z.enum(['-placedAt', 'placedAt', '-grandTotal']).default('-placedAt'),
});
export type AdminOrdersQueryInput = z.output<typeof AdminOrdersQuery>;

export const ADMIN_STATUS_TARGETS = [
  'PROCESSING',
  'PACKED',
  'SHIPPED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
] as const;

export const AdminStatusBody = z.strictObject({
  status: z.enum(ADMIN_STATUS_TARGETS),
  note: z.string().trim().min(1).max(1000).optional(),
  shipmentId: idSchema.optional(),
});
export type AdminStatusInput = z.output<typeof AdminStatusBody>;

export const ADMIN_CANCEL_REASONS = [
  'OUT_OF_STOCK',
  'CUSTOMER_REQUEST',
  'SUSPECTED_FRAUD',
  'ADDRESS_UNSERVICEABLE',
  'PAYMENT_ISSUE',
  'OTHER',
] as const;

const refundOption = z
  .strictObject({
    initiate: z.boolean().default(true),
    method: z.enum(['ORIGINAL_PAYMENT_METHOD', 'BANK_TRANSFER']).optional(),
  })
  .default({ initiate: true });

export const AdminCancelBody = z.strictObject({
  reasonCode: z.enum(ADMIN_CANCEL_REASONS),
  comment: z.string().trim().min(1).max(500),
  refund: refundOption,
  restock: z.boolean().default(true),
  notifyCustomer: z.boolean().default(true),
});
export type AdminCancelInput = z.output<typeof AdminCancelBody>;

export const ApproveCancellationBody = z.strictObject({
  comment: z.string().trim().min(1).max(500).optional(),
  refund: refundOption,
});
export type ApproveCancellationInput = z.output<typeof ApproveCancellationBody>;

export const RejectCancellationBody = z.strictObject({
  reason: z.string().trim().min(1).max(500),
});

export const AddNoteBody = z.strictObject({
  note: z.string().trim().min(1).max(1000),
  visibility: z.literal('INTERNAL').default('INTERNAL'),
});
