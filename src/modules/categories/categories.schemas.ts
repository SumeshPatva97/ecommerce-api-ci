/**
 * Category schemas — API_DOCUMENTATION.md §4.4 (Categories, Category attributes), §3.3.
 * `name` 2–80 unique per parent (normalized); `slug` global; `parentId` (depth ≤ 3).
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
import { MAX_CATEGORY_DEPTH } from './categories.tree.js';

export const MAX_CATEGORY_ATTRIBUTES = 100;
export const MAX_REORDER = 500;

export const CategoryIdParams = z.object({ categoryId: idSchema });
export const CategorySlugParams = z.object({ slug: slugSchema });

export const CategoryListQuery = adminListQuery(['sortOrder', 'name', 'depth', 'createdAt']).extend(
  {
    view: z.enum(['flat', 'tree']).default('flat'),
    parentId: z.union([z.literal('root'), idSchema]).optional(),
  },
);
export type CategoryListQueryInput = z.infer<typeof CategoryListQuery>;

export const PublicCategoryTreeQuery = z.object({
  depth: z.coerce.number().int().min(1).max(MAX_CATEGORY_DEPTH).default(MAX_CATEGORY_DEPTH),
});
export type PublicCategoryTreeQueryInput = z.infer<typeof PublicCategoryTreeQuery>;

const categoryFields = {
  name: nameSchema(80),
  slug: slugSchema.optional(),
  parentId: idSchema.nullable().optional(),
  description: descriptionSchema.optional(),
  image: imageSchema.optional(),
  bannerImage: imageSchema.optional(),
  sortOrder: sortOrderSchema.optional(),
  status: statusSchema.optional(),
  showInMenu: z.boolean().optional(),
  seo: seoSchema.optional(),
};

export const CreateCategoryBody = z.strictObject(categoryFields);
export type CreateCategoryInput = z.infer<typeof CreateCategoryBody>;

export const UpdateCategoryBody = z
  .strictObject(categoryFields)
  .partial()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Provide at least one field to update.',
  });
export type UpdateCategoryInput = z.infer<typeof UpdateCategoryBody>;

function uniqueIds(
  ids: readonly string[],
  ctx: z.RefinementCtx,
  path: (i: number) => PropertyKey[],
) {
  const seen = new Set<string>();
  ids.forEach((id, index) => {
    if (seen.has(id)) ctx.addIssue({ code: 'custom', message: 'Duplicate id.', path: path(index) });
    seen.add(id);
  });
}

/** Sibling reorder (drag & drop): the full ordered list of a parent's live children. */
export const ReorderCategoriesBody = z
  .strictObject({
    parentId: idSchema.nullable(),
    categoryIds: z.array(idSchema).min(1).max(MAX_REORDER),
  })
  .superRefine((body, ctx) => {
    uniqueIds(body.categoryIds, ctx, (i) => ['categoryIds', i]);
  });
export type ReorderCategoriesInput = z.infer<typeof ReorderCategoriesBody>;

export const ReplaceCategoryAttributesBody = z
  .strictObject({
    attributes: z
      .array(
        z.strictObject({
          attributeId: idSchema,
          isRequired: z.boolean().default(false),
          isVariantAxisDefault: z.boolean().default(false),
          inheritToChildren: z.boolean().default(true),
          sortOrder: sortOrderSchema.optional(),
        }),
      )
      .max(MAX_CATEGORY_ATTRIBUTES),
  })
  .superRefine((body, ctx) => {
    uniqueIds(
      body.attributes.map((a) => a.attributeId),
      ctx,
      (i) => ['attributes', i, 'attributeId'],
    );
  });
export type ReplaceCategoryAttributesInput = z.infer<typeof ReplaceCategoryAttributesBody>;
