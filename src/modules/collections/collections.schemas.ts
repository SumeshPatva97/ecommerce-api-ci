/**
 * Collection schemas — API_DOCUMENTATION.md §4.4 (Collections), §3.3 (public reads).
 * `name` globally unique (normalized); `slug` global; optional visibility window
 * (`ck_collections_window`: endsAt > startsAt).
 */
import { z } from 'zod';

import {
  adminListQuery,
  booleanQuery,
  descriptionSchema,
  idSchema,
  imageSchema,
  nameSchema,
  seoSchema,
  slugSchema,
  sortOrderSchema,
  statusSchema,
} from '../catalog-common/catalog.schemas.js';

export const MAX_COLLECTION_PRODUCTS = 500;

export const CollectionIdParams = z.object({ collectionId: idSchema });
export const CollectionSlugParams = z.object({ slug: slugSchema });

export const CollectionListQuery = adminListQuery(['sortOrder', 'name', 'createdAt', 'updatedAt']);
export type CollectionListQueryInput = z.infer<typeof CollectionListQuery>;

export const PublicCollectionListQuery = z.object({ featured: booleanQuery.optional() });
export type PublicCollectionListQueryInput = z.infer<typeof PublicCollectionListQuery>;

const dateTime = z.iso
  .datetime({ offset: true, message: 'Must be an ISO-8601 date-time.' })
  .transform((v) => new Date(v))
  .nullable();

const collectionFields = {
  name: nameSchema(80),
  slug: slugSchema.optional(),
  description: descriptionSchema.optional(),
  heroImage: imageSchema.optional(),
  isFeatured: z.boolean().optional(),
  startsAt: dateTime.optional(),
  endsAt: dateTime.optional(),
  sortOrder: sortOrderSchema.optional(),
  status: statusSchema.optional(),
  seo: seoSchema.optional(),
};

function windowValid(body: {
  startsAt?: Date | null | undefined;
  endsAt?: Date | null | undefined;
}): boolean {
  const { startsAt, endsAt } = body;
  if (startsAt === undefined || startsAt === null || endsAt === undefined || endsAt === null) {
    return true;
  }
  return endsAt.getTime() > startsAt.getTime();
}

const WINDOW_ERROR = { message: 'Must be after startsAt.', path: ['endsAt'] };

export const CreateCollectionBody = z
  .strictObject(collectionFields)
  .refine(windowValid, WINDOW_ERROR);
export type CreateCollectionInput = z.infer<typeof CreateCollectionBody>;

export const UpdateCollectionBody = z
  .strictObject(collectionFields)
  .partial()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Provide at least one field to update.',
  })
  .refine(windowValid, WINDOW_ERROR);
export type UpdateCollectionInput = z.infer<typeof UpdateCollectionBody>;

export const ReplaceCollectionProductsBody = z
  .strictObject({
    productIds: z.array(idSchema).max(MAX_COLLECTION_PRODUCTS),
    sortMode: z.literal('MANUAL').default('MANUAL'),
  })
  .superRefine((body, ctx) => {
    const seen = new Set<string>();
    body.productIds.forEach((id, index) => {
      if (seen.has(id)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Duplicate product id.',
          path: ['productIds', index],
        });
      }
      seen.add(id);
    });
  });
export type ReplaceCollectionProductsInput = z.infer<typeof ReplaceCollectionProductsBody>;
