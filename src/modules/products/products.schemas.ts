/**
 * Admin product/variant/image schemas — API_DOCUMENTATION.md §4.3. Admin bodies are strict
 * (SECURITY_GUIDELINES.md §5): unknown keys → 422.
 */
import { z } from 'zod';

import { paginationQuery, PAGE_LIMITS } from '../../core/http/pagination.js';
import { dec, MONEY_PATTERN } from '../../lib/money.js';
import { BARCODE_PATTERN, normalizeCode, SKU_PATTERN } from '../../lib/normalize.js';
import { SLUG_MAX_LENGTH, SLUG_PATTERN } from '../../lib/slug.js';
import { PUBLIC_ID_PATTERN } from '../media/cloudinary.js';

// ----------------------------------------------------------------------------- primitives
export const Money = z
  .string()
  .trim()
  .regex(MONEY_PATTERN, 'Must be a money string such as "1499.00".');
const PositiveMoney = Money.refine((v) => dec(v).gt(0), 'Must be greater than 0.');
const Weight = z
  .string()
  .trim()
  .regex(/^\d{1,7}(\.\d{1,3})?$/, 'Must be grams with up to 3 decimals, e.g. "4.250".')
  .refine((v) => dec(v).gt(0), 'Must be greater than 0.');
export const Sku = z
  .string()
  .transform(normalizeCode)
  .pipe(
    z
      .string()
      .regex(SKU_PATTERN, 'SKU must be 1–32 characters of A–Z, 0–9, "-" or "_" (no spaces).'),
  );
export const Barcode = z
  .string()
  .transform(normalizeCode)
  .pipe(
    z
      .string()
      .regex(
        BARCODE_PATTERN,
        'Barcode must be 1–64 characters of A–Z, 0–9, "-" or "_" (no spaces).',
      ),
  );
const Dimension = z.number().int().min(0).max(100_000).nullable().optional();
const Count = z.number().int().min(0).max(1_000_000);
const NullableText = (max: number) => z.string().trim().max(max).nullable().optional();

// ----------------------------------------------------------------------------- params
export const ProductIdParams = z.object({ productId: z.uuid() });
export const VariantIdParams = z.object({ variantId: z.uuid() });
export const ImageParams = z.object({ productId: z.uuid(), imageId: z.uuid() });

// ----------------------------------------------------------------------------- variants
const variantShape = {
  sku: Sku,
  barcode: Barcode.nullable().optional(),
  mrp: PositiveMoney,
  sellingPrice: PositiveMoney,
  compareAtPrice: Money.nullable().optional(),
  costPrice: Money.nullable().optional(),
  weightGrams: Weight.nullable().optional(),
  lengthMm: Dimension,
  widthMm: Dimension,
  heightMm: Dimension,
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
  /** Not applied by this module (stock moves only via inventory movements) → warning. */
  initialStock: Count.optional(),
  lowStockThreshold: Count.optional(),
};

interface PriceFields {
  mrp?: string | undefined;
  sellingPrice?: string | undefined;
  compareAtPrice?: string | null | undefined;
}

/** `0 < sellingPrice ≤ mrp`; `compareAtPrice ≥ sellingPrice` (workflow §10). */
export function checkPrices(v: PriceFields, ctx: z.RefinementCtx): void {
  if (v.mrp !== undefined && v.sellingPrice !== undefined && dec(v.sellingPrice).gt(dec(v.mrp))) {
    ctx.addIssue({
      code: 'custom',
      path: ['sellingPrice'],
      message: 'Selling price cannot be greater than MRP.',
    });
  }
  if (
    v.compareAtPrice !== undefined &&
    v.compareAtPrice !== null &&
    v.sellingPrice !== undefined &&
    dec(v.compareAtPrice).lt(dec(v.sellingPrice))
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['compareAtPrice'],
      message: 'Compare-at price cannot be lower than the selling price.',
    });
  }
}

export const SimpleVariantBody = z.strictObject(variantShape).superRefine(checkPrices);
export const AxisVariantBody = z
  .strictObject({
    ...variantShape,
    attributeValueIds: z.array(z.uuid()).min(1).max(3),
  })
  .superRefine(checkPrices);
export type SimpleVariantInput = z.output<typeof SimpleVariantBody>;
export type AxisVariantInput = z.output<typeof AxisVariantBody>;

export const UpdateVariantBody = z
  .strictObject({
    sku: Sku.optional(),
    barcode: Barcode.nullable().optional(),
    mrp: PositiveMoney.optional(),
    sellingPrice: PositiveMoney.optional(),
    compareAtPrice: Money.nullable().optional(),
    costPrice: Money.nullable().optional(),
    weightGrams: Weight.nullable().optional(),
    lengthMm: Dimension,
    widthMm: Dimension,
    heightMm: Dimension,
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
    sortOrder: z.number().int().min(0).max(100_000).optional(),
    expectedUpdatedAt: z.iso.datetime().optional(),
  })
  .superRefine(checkPrices)
  .refine(
    (b) => Object.keys(b).some((k) => k !== 'expectedUpdatedAt'),
    'Provide at least one field to update.',
  );
export type UpdateVariantInput = z.output<typeof UpdateVariantBody>;

// ----------------------------------------------------------------------------- products
const commonShape = {
  name: z.string().trim().min(2).max(150),
  slug: z
    .string()
    .trim()
    .max(SLUG_MAX_LENGTH)
    .regex(SLUG_PATTERN, 'Use lower-case letters, digits and single hyphens.')
    .optional(),
  categoryId: z.uuid(),
  brandId: z.uuid().nullable().optional(),
  collectionIds: z.array(z.uuid()).max(20).optional(),
  shortDescription: NullableText(300),
  description: z.string().max(20_000).nullable().optional(),
  careInstructions: NullableText(5_000),
  searchKeywords: NullableText(500),
  attributeValueIds: z.array(z.uuid()).max(100).optional(),
  hsnCode: z
    .string()
    .trim()
    .regex(/^\d{4,8}$/, 'HSN code must be 4–8 digits.')
    .nullable()
    .optional(),
  isFeatured: z.boolean().optional(),
  isNewArrival: z.boolean().optional(),
  isBestSellerPinned: z.boolean().optional(),
  seo: z.strictObject({ title: NullableText(70), description: NullableText(160) }).optional(),
  legal: z
    .strictObject({
      countryOfOrigin: NullableText(80),
      manufacturerName: NullableText(150),
      manufacturerAddress: NullableText(1_000),
      importerName: NullableText(150),
      importerAddress: NullableText(1_000),
    })
    .optional(),
};

const CreateStatus = z.enum(['DRAFT', 'ACTIVE', 'INACTIVE']).default('DRAFT');

const uniqueIds = (ids: readonly string[] | undefined): boolean =>
  ids === undefined || new Set(ids).size === ids.length;

export const CreateProductBody = z
  .discriminatedUnion('productType', [
    z.strictObject({
      productType: z.literal('SIMPLE'),
      ...commonShape,
      status: CreateStatus,
      variant: SimpleVariantBody,
    }),
    z.strictObject({
      productType: z.literal('VARIABLE'),
      ...commonShape,
      status: CreateStatus,
      variantAxes: z.array(z.uuid()).min(1).max(3).optional(),
      variants: z.array(AxisVariantBody).max(200).optional(),
    }),
  ])
  .superRefine((body, ctx) => {
    if (!uniqueIds(body.collectionIds)) {
      ctx.addIssue({ code: 'custom', path: ['collectionIds'], message: 'Duplicate IDs.' });
    }
    if (!uniqueIds(body.attributeValueIds)) {
      ctx.addIssue({ code: 'custom', path: ['attributeValueIds'], message: 'Duplicate IDs.' });
    }
    if (body.productType === 'VARIABLE') {
      if (!uniqueIds(body.variantAxes)) {
        ctx.addIssue({ code: 'custom', path: ['variantAxes'], message: 'Duplicate axes.' });
      }
      if ((body.variants?.length ?? 0) > 0 && body.variantAxes === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['variantAxes'],
          message: 'variantAxes is required when variants are supplied.',
        });
      }
    }
  });
export type CreateProductInput = z.output<typeof CreateProductBody>;

const { categoryId: _categoryId, name: _name, ...optionalCommon } = commonShape;
export const UpdateProductBody = z
  .strictObject({
    ...optionalCommon,
    name: commonShape.name.optional(),
    categoryId: commonShape.categoryId.optional(),
    expectedUpdatedAt: z.iso.datetime().optional(),
  })
  .superRefine((body, ctx) => {
    if (!uniqueIds(body.collectionIds)) {
      ctx.addIssue({ code: 'custom', path: ['collectionIds'], message: 'Duplicate IDs.' });
    }
    if (!uniqueIds(body.attributeValueIds)) {
      ctx.addIssue({ code: 'custom', path: ['attributeValueIds'], message: 'Duplicate IDs.' });
    }
  })
  .refine(
    (b) => Object.keys(b).some((k) => k !== 'expectedUpdatedAt'),
    'Provide at least one field to update.',
  );
export type UpdateProductInput = z.output<typeof UpdateProductBody>;

export const ProductStatusBody = z.strictObject({
  status: z.enum(['DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED']),
  reason: z.string().trim().min(1).max(500).optional(),
});
export type ProductStatusInput = z.output<typeof ProductStatusBody>;

export const AdminProductListQuery = paginationQuery(PAGE_LIMITS.productListing).extend({
  q: z.string().trim().min(1).max(100).optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED']).optional(),
  productType: z.enum(['SIMPLE', 'VARIABLE']).optional(),
  categoryId: z.uuid().optional(),
  brandId: z.uuid().optional(),
  collectionId: z.uuid().optional(),
  stock: z.enum(['in_stock', 'low_stock', 'out_of_stock']).optional(),
  sort: z
    .enum(['-createdAt', 'createdAt', 'name', '-updatedAt', 'price', '-price'])
    .default('-createdAt'),
});
export type AdminProductListInput = z.output<typeof AdminProductListQuery>;

export const CheckDuplicateQuery = z
  .object({
    field: z.enum(['name', 'slug', 'sku', 'barcode']),
    value: z.string().trim().min(1).max(200),
    categoryId: z.uuid().optional(),
    excludeId: z.uuid().optional(),
  })
  .refine((q) => q.field !== 'name' || q.categoryId !== undefined, {
    path: ['categoryId'],
    message: 'categoryId is required when field=name (OQ-04 per-category scope).',
  });
export type CheckDuplicateInput = z.output<typeof CheckDuplicateQuery>;

// ----------------------------------------------------------------------------- generate
export const GenerateModeQuery = z.object({ mode: z.enum(['preview', 'commit']) });

export const GenerateVariantsBody = z
  .strictObject({
    axes: z
      .array(
        z.strictObject({
          attributeId: z.uuid(),
          valueIds: z.array(z.uuid()).min(1).max(30),
        }),
      )
      .min(1)
      .max(3),
    defaults: z
      .strictObject({
        mrp: PositiveMoney,
        sellingPrice: PositiveMoney,
        compareAtPrice: Money.nullable().optional(),
        costPrice: Money.nullable().optional(),
        weightGrams: Weight.nullable().optional(),
        status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
        lowStockThreshold: Count.optional(),
      })
      .superRefine(checkPrices),
    skuPattern: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^(?:\{[A-Za-z0-9_-]+\}|[A-Za-z0-9_-])+$/, 'Only tokens, A–Z, 0–9, "-" and "_".')
      .optional(),
    skuBase: z
      .string()
      .trim()
      .transform((v) => v.toUpperCase())
      .pipe(z.string().regex(/^[A-Z0-9-]{2,16}$/, 'skuBase must match ^[A-Z0-9-]{2,16}$.'))
      .optional(),
    overrides: z
      .array(
        z
          .strictObject({
            combinationKey: z.string().min(1).max(400),
            sku: Sku.optional(),
            barcode: Barcode.nullable().optional(),
            mrp: PositiveMoney.optional(),
            sellingPrice: PositiveMoney.optional(),
            initialStock: Count.optional(),
            skip: z.literal(true).optional(),
          })
          .superRefine(checkPrices),
      )
      .max(200)
      .optional(),
    previewToken: z.string().min(1).max(100).optional(),
  })
  .superRefine((body, ctx) => {
    const attrs = body.axes.map((a) => a.attributeId);
    if (new Set(attrs).size !== attrs.length) {
      ctx.addIssue({ code: 'custom', path: ['axes'], message: 'Each attribute may appear once.' });
    }
    body.axes.forEach((axis, i) => {
      if (!uniqueIds(axis.valueIds)) {
        ctx.addIssue({ code: 'custom', path: ['axes', i, 'valueIds'], message: 'Duplicate IDs.' });
      }
    });
    const keys = (body.overrides ?? []).map((o) => o.combinationKey);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['overrides'],
        message: 'Each combinationKey may appear once.',
      });
    }
  });
export type GenerateVariantsInput = z.output<typeof GenerateVariantsBody>;

// ----------------------------------------------------------------------------- images
const ImageItem = z.strictObject({
  publicId: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(PUBLIC_ID_PATTERN, 'publicId must be a Cloudinary public ID path.'),
  variantId: z.uuid().nullable().optional(),
  altText: z.string().trim().min(1).max(160),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  isPrimary: z.boolean().optional(),
});
export type ImageItemInput = z.output<typeof ImageItem>;

export const AddImagesBody = z
  .union([z.strictObject({ images: z.array(ImageItem).min(1).max(20) }), ImageItem])
  .transform((body) => ('images' in body ? body.images : [body]))
  .superRefine((items, ctx) => {
    const ids = items.map((i) => i.publicId);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', path: ['images'], message: 'Duplicate publicId in request.' });
    }
    if (items.filter((i) => i.isPrimary === true).length > 1) {
      ctx.addIssue({ code: 'custom', path: ['images'], message: 'Only one image can be primary.' });
    }
  });

export const UpdateImageBody = z
  .strictObject({
    altText: z.string().trim().min(1).max(160).optional(),
    variantId: z.uuid().nullable().optional(),
    isPrimary: z.literal(true).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Provide at least one field to update.');
export type UpdateImageInput = z.output<typeof UpdateImageBody>;

export const ImageOrderBody = z
  .strictObject({ imageIds: z.array(z.uuid()).min(1).max(100) })
  .refine((b) => uniqueIds(b.imageIds), { path: ['imageIds'], message: 'Duplicate IDs.' });
