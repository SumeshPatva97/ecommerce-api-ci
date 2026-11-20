/**
 * Brand schemas — API_DOCUMENTATION.md §4.4 (Brands), §3.3 (`GET /brands`).
 * `name` 2–80, globally unique (normalized); `slug` global.
 */
import { z } from 'zod';

import {
  adminListQuery,
  descriptionSchema,
  idSchema,
  imageSchema,
  nameSchema,
  seoSchema,
  slugSchema,
  sortOrderSchema,
  statusSchema,
} from '../catalog-common/catalog.schemas.js';

export const BrandIdParams = z.object({ brandId: idSchema });

export const BrandListQuery = adminListQuery(['sortOrder', 'name', 'createdAt', 'updatedAt']);
export type BrandListQueryInput = z.infer<typeof BrandListQuery>;

export const CreateBrandBody = z.strictObject({
  name: nameSchema(80),
  slug: slugSchema.optional(),
  description: descriptionSchema.optional(),
  logo: imageSchema.optional(),
  isFeatured: z.boolean().optional(),
  sortOrder: sortOrderSchema.optional(),
  status: statusSchema.optional(),
  seo: seoSchema.optional(),
});
export type CreateBrandInput = z.infer<typeof CreateBrandBody>;

export const UpdateBrandBody = CreateBrandBody.partial().refine(
  (body) => Object.keys(body).length > 0,
  { message: 'Provide at least one field to update.' },
);
export type UpdateBrandInput = z.infer<typeof UpdateBrandBody>;
