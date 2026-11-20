/**
 * Admin customers — zod schemas (API_DOCUMENTATION.md §4.8).
 */
import { z } from 'zod';

import { PAGE_LIMITS, paginationQuery } from '../../core/http/pagination.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Use YYYY-MM-DD (IST).' });

export const CustomerIdParams = z.strictObject({ customerId: z.uuid() });

export const ListCustomersQuery = paginationQuery(PAGE_LIMITS.adminList)
  .extend({
    q: z.string().trim().min(1).max(100).optional(),
    status: z.enum(['PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DISABLED']).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    minOrders: z.coerce.number().int().min(0).max(100_000).optional(),
    sort: z.enum(['-createdAt', 'createdAt', '-totalSpent', '-orderCount']).default('-createdAt'),
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
    message: '`from` must not be after `to`.',
    path: ['from'],
  });
export type ListCustomersQuery = z.output<typeof ListCustomersQuery>;

export const SetCustomerStatusBody = z.strictObject({
  status: z.enum(['ACTIVE', 'SUSPENDED', 'DISABLED']),
  reason: z.string().trim().min(1).max(500),
});
export type SetCustomerStatusBody = z.output<typeof SetCustomerStatusBody>;
