/** Zod schemas for `/admin/inventory/*` — API_DOCUMENTATION.md §4.5. */
import { z } from 'zod';

import { PAGE_LIMITS, paginationQuery } from '../../core/http/pagination.js';
import { MONEY_PATTERN } from '../../lib/money.js';
import { BARCODE_PATTERN, SKU_PATTERN, normalizeCode } from '../../lib/normalize.js';
import { InventoryTxnType } from '../../generated/prisma/enums.js';
import { MANUAL_MOVEMENT_TYPES, MOVEMENT_REASON_CODES } from './inventory.rules.js';

const uuid = z.uuid({ message: 'Must be a valid id.' });
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const REFERENCE_PATTERN = /^[A-Za-z0-9 _\-/.#]{1,64}$/;

export const VariantIdParams = z.object({ variantId: uuid });

export const ListInventoryQuery = paginationQuery(PAGE_LIMITS.adminList).extend({
  lowStock: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  sku: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .transform((v) => normalizeCode(v))
    .optional(),
  q: z.string().trim().min(1).max(100).optional(),
  categoryId: uuid.optional(),
  brandId: uuid.optional(),
  stock: z.enum(['in_stock', 'low_stock', 'out_of_stock']).optional(),
  sort: z.enum(['available', '-available', 'sku', '-sku']).default('sku'),
});

export const LookupQuery = z.object({
  sku: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .transform((v) => normalizeCode(v))
    .pipe(z.string().regex(BARCODE_PATTERN, 'Not a valid SKU or barcode.')),
});

const MovementItem = z
  .strictObject({
    variantId: uuid.optional(),
    sku: z
      .string()
      .trim()
      .transform((v) => normalizeCode(v))
      .pipe(z.string().regex(SKU_PATTERN, 'Not a valid SKU.'))
      .optional(),
    quantity: z.number().int('Must be a whole number.').min(1).max(100_000),
    unitCost: z.string().trim().regex(MONEY_PATTERN, 'Must be an amount like "510.00".').optional(),
  })
  .refine((i) => (i.variantId === undefined) !== (i.sku === undefined), {
    message: 'Provide either variantId or sku.',
  });

export const MovementBody = z
  .strictObject({
    type: z.enum(MANUAL_MOVEMENT_TYPES, {
      message: 'Must be STOCK_IN, STOCK_OUT, ADJUSTMENT_INCREASE or ADJUSTMENT_DECREASE.',
    }),
    reasonCode: z.enum(MOVEMENT_REASON_CODES),
    note: z.string().trim().min(1).max(500).optional(),
    reference: z.string().trim().regex(REFERENCE_PATTERN, 'Up to 64 characters.').optional(),
    items: z.array(MovementItem).min(1).max(500),
  })
  .superRefine((body, ctx) => {
    const needsNote = body.type.startsWith('ADJUSTMENT_') || body.reasonCode === 'OTHER';
    if (needsNote && body.note === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['note'],
        message: 'A note is required for adjustments and reason OTHER.',
      });
    }
    if (body.reference !== undefined && (body.note?.length ?? 0) + body.reference.length > 490) {
      ctx.addIssue({
        code: 'custom',
        path: ['note'],
        message: 'Note and reference together must not exceed 490 characters.',
      });
    }
    body.items.forEach((item, index) => {
      if (item.unitCost !== undefined && body.type !== 'STOCK_IN') {
        ctx.addIssue({
          code: 'custom',
          path: ['items', index, 'unitCost'],
          message: 'unitCost is only accepted for STOCK_IN.',
        });
      }
    });
  });

const istDate = z.string().regex(DATE_PATTERN, 'Must be a date (YYYY-MM-DD).');

export const TransactionsQuery = paginationQuery(PAGE_LIMITS.adminList).extend({
  type: z
    .string()
    .trim()
    .transform((v) => v.split(',').map((s) => s.trim().toUpperCase()))
    .pipe(z.array(z.enum(InventoryTxnType, { message: 'Unknown transaction type.' })).min(1))
    .optional(),
  from: istDate.optional(),
  to: istDate.optional(),
  /** FR-INV-006: only rows created by this staff user (`inventory_transactions.created_by_id`). */
  actorId: uuid.optional(),
});

export const ThresholdBody = z.strictObject({
  lowStockThreshold: z.number().int().min(0).max(10_000).nullable(),
});

export type ListInventoryInput = z.output<typeof ListInventoryQuery>;
export type MovementInput = z.output<typeof MovementBody>;
export type TransactionsInput = z.output<typeof TransactionsQuery>;
