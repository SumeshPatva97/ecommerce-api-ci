/** Payments request schemas — API_DOCUMENTATION.md §3.9 (verify, retry-payment), §4.11 (admin). */
import { z } from 'zod';

import { PAGE_LIMITS, paginationQuery } from '../../core/http/pagination.js';

export const ORDER_NUMBER_PATTERN = /^ORD-\d{6}-\d{5}$/;

const orderNumber = z.string().trim().regex(ORDER_NUMBER_PATTERN, 'Invalid order number.');
const providerRef = z
  .string()
  .trim()
  .min(1, 'Required.')
  .max(100)
  .regex(/^[A-Za-z0-9_.:-]+$/, 'Invalid reference.');

export const VerifyPaymentBody = z.strictObject({
  orderNumber,
  providerOrderId: providerRef,
  providerPaymentId: providerRef,
  providerSignature: z.string().trim().min(1, 'Required.').max(512),
  /** Provider-specific extras — accepted but never trusted (status is fetched server-side). */
  providerPayload: z.record(z.string(), z.unknown()).optional(),
});
export type VerifyPaymentInput = z.output<typeof VerifyPaymentBody>;

export const OrderNumberParams = z.object({ orderNumber });

export const PaymentIdParams = z.object({ paymentId: z.uuid({ message: 'Must be a valid id.' }) });

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

export const AdminPaymentListQuery = paginationQuery(PAGE_LIMITS.adminList)
  .extend({
    q: z.string().trim().min(1).max(100).optional(),
    status: z
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
    method: z.enum(['ONLINE', 'COD']).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .refine((v) => v.from === undefined || v.to === undefined || v.from <= v.to, {
    message: '`from` must not be after `to`.',
    path: ['from'],
  });
export type AdminPaymentListQueryInput = z.output<typeof AdminPaymentListQuery>;
