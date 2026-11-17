import { z } from 'zod';

/**
 * Offset pagination (PROJECT_CONTEXT.md §8, §15 R-20; API_DOCUMENTATION.md §2.4).
 * Product listings default to 30, other admin lists to 25, max 100 everywhere.
 * Values above the maximum are rejected with 422 (not silently clamped).
 */
export const PAGE_LIMITS = {
  productListing: 30,
  adminList: 25,
  max: 100,
} as const;

export function paginationQuery(defaultLimit: number) {
  return z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(PAGE_LIMITS.max).default(defaultLimit),
  });
}

export interface PageMeta {
  page: number;
  limit: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

/** Builds list `meta`. A page beyond the last returns empty data with correct meta (not 404). */
export function buildPageMeta(page: number, limit: number, totalItems: number): PageMeta {
  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / limit);
  return {
    page,
    limit,
    totalItems,
    totalPages,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
  };
}

/** Prisma-style `skip`/`take` for a page. */
export function toSkipTake(page: number, limit: number): { skip: number; take: number } {
  return { skip: (page - 1) * limit, take: limit };
}
