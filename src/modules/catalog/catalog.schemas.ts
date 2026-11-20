/**
 * Public catalog query schemas — API_DOCUMENTATION.md §2.4, §3.3. Unknown filter keys are ignored
 * (forward-compatible, `z.object` strips them); invalid values → 422.
 */
import { z } from 'zod';

import { paginationQuery, PAGE_LIMITS } from '../../core/http/pagination.js';
import { dec, MONEY_PATTERN } from '../../lib/money.js';
import { SLUG_PATTERN } from '../../lib/slug.js';

function splitCsv(v: string | undefined): string[] {
  if (v === undefined) return [];
  return [
    ...new Set(
      v
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  ];
}

const SlugItem = z.string().max(160).regex(SLUG_PATTERN, 'Invalid slug.');
const SlugList = z
  .string()
  .max(4_000)
  .optional()
  .transform(splitCsv)
  .pipe(z.array(SlugItem).max(50));
const UuidList = z
  .string()
  .max(4_000)
  .optional()
  .transform(splitCsv)
  .pipe(z.array(z.uuid()).max(100));
const Bool = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true'));
const Price = z
  .string()
  .trim()
  .regex(MONEY_PATTERN, 'Must be a decimal string ≥ 0, e.g. "500" or "499.50".')
  .optional();

/** `plating:gold-plated;occasion:bridal|festive` → `{ plating: [...], occasion: [...] }`. */
const AttributesParam = z
  .string()
  .max(2_000)
  .optional()
  .transform((raw, ctx) => {
    const out: Record<string, string[]> = {};
    if (raw === undefined || raw.trim() === '') return out;
    for (const part of raw.split(';')) {
      if (part.trim() === '') continue;
      const [code = '', values = ''] = part.split(':');
      const slugs = values
        .split('|')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const key = code.trim().toLowerCase();
      if (
        !/^[a-z0-9_-]{1,50}$/.test(key) ||
        slugs.length === 0 ||
        !slugs.every((s) => SLUG_PATTERN.test(s))
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'Use attrCode:valueSlug|valueSlug;attrCode2:valueSlug.',
        });
        return z.NEVER;
      }
      out[key] = [...new Set([...(out[key] ?? []), ...slugs])];
    }
    return out;
  });

export const PUBLIC_SORTS = [
  'relevance',
  'newest',
  'price_asc',
  'price_desc',
  'best_selling',
  'rating_desc',
  'name_asc',
] as const;
export type PublicSort = (typeof PUBLIC_SORTS)[number];

export const ProductFilterQuery = z
  .object({
    category: SlugItem.optional(),
    brand: SlugList,
    collection: SlugList,
    material: SlugList,
    gemstone: SlugList,
    attributes: AttributesParam,
    minPrice: Price,
    maxPrice: Price,
    availability: z.enum(['in_stock', 'all']).default('all'),
    q: z.string().trim().min(2).max(100).optional(),
    isFeatured: Bool,
    isNewArrival: Bool,
  })
  .refine(
    (q) =>
      q.minPrice === undefined || q.maxPrice === undefined || dec(q.minPrice).lte(dec(q.maxPrice)),
    { path: ['minPrice'], message: 'minPrice must be less than or equal to maxPrice.' },
  );
export type ProductFilterInput = z.output<typeof ProductFilterQuery>;

export const ProductListQuery = z
  .object({
    ...paginationQuery(PAGE_LIMITS.productListing).shape,
    category: SlugItem.optional(),
    brand: SlugList,
    collection: SlugList,
    material: SlugList,
    gemstone: SlugList,
    attributes: AttributesParam,
    minPrice: Price,
    maxPrice: Price,
    availability: z.enum(['in_stock', 'all']).default('all'),
    q: z.string().trim().min(2).max(100).optional(),
    isFeatured: Bool,
    isNewArrival: Bool,
    sort: z.enum(PUBLIC_SORTS).optional(),
    ids: UuidList,
    variantIds: UuidList,
  })
  .refine(
    (q) =>
      q.minPrice === undefined || q.maxPrice === undefined || dec(q.minPrice).lte(dec(q.maxPrice)),
    { path: ['minPrice'], message: 'minPrice must be less than or equal to maxPrice.' },
  );
export type ProductListInput = z.output<typeof ProductListQuery>;

export const SlugParams = z.object({ slug: SlugItem });
export const DetailQuery = z.object({ variant: z.string().trim().min(1).max(64).optional() });
export const RelatedQuery = z.object({
  limit: z.coerce.number().int().min(1).max(24).default(12),
});
export const AutocompleteQuery = z.object({ q: z.string().trim().min(2).max(100) });
