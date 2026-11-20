/** Zod schemas for barcode routes — API_DOCUMENTATION.md §4.6. */
import { z } from 'zod';

import { LAYOUT_KEYS } from './barcodes.render.js';

const uuid = z.uuid({ message: 'Must be a valid id.' });

export const VariantIdParams = z.object({ variantId: uuid });

export const BarcodeImageQuery = z.object({
  format: z.enum(['svg', 'png']).default('svg'),
  scale: z.coerce.number().int().min(1).max(6).default(3),
  /** Bar height in millimetres. */
  height: z.coerce.number().min(5).max(50).default(10),
  includeText: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export const LabelFields = z.strictObject({
  productName: z.boolean().optional(),
  variantName: z.boolean().optional(),
  sku: z.boolean().optional(),
  mrp: z.boolean().optional(),
  sellingPrice: z.boolean().optional(),
  brandName: z.boolean().optional(),
});

const VariantItem = z.strictObject({
  variantId: uuid,
  copies: z.number().int().min(1).max(500).default(1),
});

const ProductItem = z.strictObject({
  productId: uuid,
  allVariants: z.literal(true),
  copiesEach: z.number().int().min(1).max(500).default(1),
});

export const LabelItem = z.union([VariantItem, ProductItem], {
  error: 'Provide { variantId, copies } or { productId, allVariants: true, copiesEach }.',
});

export const PreviewBody = z.strictObject({
  layout: z.enum(LAYOUT_KEYS).default('THERMAL_50x25'),
  items: z.array(LabelItem).min(1).max(200),
  fields: LabelFields.optional(),
});

export const LabelsBody = PreviewBody.extend({
  startPosition: z.number().int().min(1).max(65).default(1),
}).refine((b) => b.layout === 'A4_SHEET_65' || b.startPosition === 1, {
  path: ['startPosition'],
  message: 'startPosition applies to A4 sheet layouts only.',
});

export type LabelItemInput = z.output<typeof LabelItem>;
export type LabelFieldsInput = z.output<typeof LabelFields>;
export type PreviewInput = z.output<typeof PreviewBody>;
export type LabelsInput = z.output<typeof LabelsBody>;
export type BarcodeImageInput = z.output<typeof BarcodeImageQuery>;
