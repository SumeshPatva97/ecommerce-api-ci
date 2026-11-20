/**
 * Review schemas — API_DOCUMENTATION.md §3.3 (`GET /products/:slug/reviews`), §3.7, §4.13.
 * Text + rating only (OQ-31 / D-21: no photo reviews in v1).
 */
import { z } from 'zod';

import { PAGE_LIMITS, paginationQuery } from '../../core/http/pagination.js';
import { SLUG_MAX_LENGTH } from '../../lib/slug.js';

const id = z.uuid({ message: 'Must be a valid id.' });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

export const ProductIdParams = z.object({ productId: id });
export const ProductSlugParams = z.object({ slug: z.string().trim().min(1).max(SLUG_MAX_LENGTH) });
export const ReviewIdParams = z.object({ reviewId: id });

/** Length rules are re-checked after HTML stripping in the service. */
export const CreateReviewBody = z.strictObject({
  rating: z.number().int().min(1).max(5),
  title: z.string().trim().min(3).max(100).optional(),
  body: z.string().trim().min(10).max(2000),
  orderItemId: id.optional(),
});
export type CreateReviewInput = z.infer<typeof CreateReviewBody>;

export const PublicReviewsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  sort: z.enum(['newest', 'rating_desc', 'rating_asc']).default('newest'),
  rating: z.coerce.number().int().min(1).max(5).optional(),
});
export type PublicReviewsQueryInput = z.infer<typeof PublicReviewsQuery>;

export const MyReviewsQuery = paginationQuery(PAGE_LIMITS.adminList);
export type MyReviewsQueryInput = z.infer<typeof MyReviewsQuery>;

export const AdminReviewsQuery = paginationQuery(PAGE_LIMITS.adminList).extend({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'ALL']).default('PENDING'),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  productId: id.optional(),
  q: z.string().trim().min(2).max(100).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type AdminReviewsQueryInput = z.infer<typeof AdminReviewsQuery>;

export const RejectReviewBody = z.strictObject({
  reason: z.string().trim().min(3).max(300),
  shareWithCustomer: z.boolean().default(false),
});
export type RejectReviewInput = z.infer<typeof RejectReviewBody>;
