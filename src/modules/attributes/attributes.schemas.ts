/**
 * Attribute & attribute-value schemas — API_DOCUMENTATION.md §4.4, DATABASE_DESIGN.md §7.9–§7.10.
 *
 * - Attribute `name` 2–80 globally unique (normalized); `code` (`^[a-z0-9_]+$`, ≤ 50) is the URL
 *   filter key, immutable after create, never a reserved listing query parameter.
 *   (§4.4 calls it `slug`; the approved schema column is `code` — the API uses `code`.)
 * - Value `value` 1–100 unique per attribute (normalized); `slug` per attribute;
 *   `hexColor` `#RRGGBB` (stored upper-case) only for SWATCH attributes.
 */
import { z } from 'zod';

import { AttributeDisplayType } from '../../generated/prisma/enums.js';
import {
  adminListQuery,
  booleanQuery,
  idSchema,
  nameSchema,
  slugSchema,
  sortOrderSchema,
  statusSchema,
} from '../catalog-common/catalog.schemas.js';

/** Listing query keys an attribute code must never shadow (API_DOCUMENTATION.md §2.4). */
export const RESERVED_ATTRIBUTE_CODES: ReadonlySet<string> = new Set([
  'page',
  'limit',
  'sort',
  'q',
  'category',
  'brand',
  'collection',
  'availability',
  'attributes',
  'ids',
]);

export const ATTRIBUTE_CODE_PATTERN = /^[a-z0-9_]+$/;

export const AttributeIdParams = z.object({ attributeId: idSchema });
export const AttributeValueParams = z.object({ attributeId: idSchema, valueId: idSchema });

export const AttributeListQuery = adminListQuery(['sortOrder', 'name', 'createdAt']).extend({
  isVariantAxis: booleanQuery.optional(),
  isFilterable: booleanQuery.optional(),
});
export type AttributeListQueryInput = z.infer<typeof AttributeListQuery>;

export const AttributeValueListQuery = adminListQuery(['sortOrder', 'value', 'createdAt']);
export type AttributeValueListQueryInput = z.infer<typeof AttributeValueListQuery>;

const codeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(50)
  .regex(ATTRIBUTE_CODE_PATTERN, 'Use lowercase letters, digits and underscores.')
  .refine((code) => !RESERVED_ATTRIBUTE_CODES.has(code), {
    message: 'This code is reserved by the product listing API.',
  });

const attributeFields = {
  name: nameSchema(80),
  displayType: z.enum(AttributeDisplayType).optional(),
  isVariantAxis: z.boolean().optional(),
  isFilterable: z.boolean().optional(),
  isVisibleOnPdp: z.boolean().optional(),
  unit: z.string().trim().min(1).max(20).nullable().optional(),
  sortOrder: sortOrderSchema.optional(),
  status: statusSchema.optional(),
};

export const CreateAttributeBody = z.strictObject({
  ...attributeFields,
  code: codeSchema.optional(),
});
export type CreateAttributeInput = z.infer<typeof CreateAttributeBody>;

/** `code` is immutable (storefront filter URLs depend on it). */
export const UpdateAttributeBody = z
  .strictObject(attributeFields)
  .partial()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Provide at least one field to update.',
  });
export type UpdateAttributeInput = z.infer<typeof UpdateAttributeBody>;

const valueFields = {
  value: z.string().trim().min(1).max(100),
  slug: slugSchema.max(120).optional(),
  hexColor: z
    .string()
    .trim()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'Use the #RRGGBB format.')
    .transform((v) => v.toUpperCase())
    .nullable()
    .optional(),
  swatchImageUrl: z
    .url({ protocol: /^https$/, message: 'Must be an https URL.' })
    .max(500)
    .nullable()
    .optional(),
  sortOrder: sortOrderSchema.optional(),
  status: statusSchema.optional(),
};

export const CreateAttributeValueBody = z.strictObject(valueFields);
export type CreateAttributeValueInput = z.infer<typeof CreateAttributeValueBody>;

export const UpdateAttributeValueBody = z
  .strictObject(valueFields)
  .partial()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Provide at least one field to update.',
  });
export type UpdateAttributeValueInput = z.infer<typeof UpdateAttributeValueBody>;
