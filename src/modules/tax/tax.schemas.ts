/**
 * Zod schemas for `/admin/tax/*` — API_DOCUMENTATION.md §4.10, TAX_AND_GST_WORKFLOWS.md §4, §23.
 * Admin bodies are strict (unknown keys → 422).
 */
import { z } from 'zod';

import { PAGE_LIMITS, paginationQuery } from '../../core/http/pagination.js';
import { MONEY_PATTERN } from '../../lib/money.js';

const uuid = z.uuid({ message: 'Must be a valid id.' });
const RATE_PATTERN = /^\d{1,3}(\.\d{1,2})?$/;
export const HSN_PATTERN = /^\d{4,8}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const ratePercentSchema = z
  .string()
  .trim()
  .regex(RATE_PATTERN, 'Must be a percentage like "3.00".')
  .refine((v) => Number(v) <= 100, 'Must be between 0.00 and 100.00.');

/** IST calendar date `YYYY-MM-DD` (validated as a real date). */
export const istDateSchema = z
  .string()
  .regex(DATE_PATTERN, 'Must be a date (YYYY-MM-DD).')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
  }, 'Must be a valid calendar date.');

const statusSchema = z.enum(['ACTIVE', 'INACTIVE']);

export const IdParams = z.object({ id: uuid });

// ── Rates ─────────────────────────────────────────────────────────────────────────────────────
export const ListRatesQuery = paginationQuery(PAGE_LIMITS.adminList).extend({
  q: z.string().trim().min(1).max(100).optional(),
  status: statusSchema.optional(),
});

export const CreateRateBody = z.strictObject({
  name: z.string().trim().min(2).max(100),
  ratePercent: ratePercentSchema,
  status: statusSchema.default('ACTIVE'),
});

export const UpdateRateBody = z
  .strictObject({
    name: z.string().trim().min(2).max(100).optional(),
    ratePercent: ratePercentSchema.optional(),
    status: statusSchema.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Provide at least one field to update.');

// ── HSN codes ─────────────────────────────────────────────────────────────────────────────────
export const ListHsnQuery = paginationQuery(PAGE_LIMITS.adminList).extend({
  q: z.string().trim().min(1).max(100).optional(),
});

const hsnCodeSchema = z.string().trim().regex(HSN_PATTERN, 'HSN code must be 4–8 digits.');

export const CreateHsnBody = z.strictObject({
  hsnCode: hsnCodeSchema,
  description: z.string().trim().max(255).nullable().optional(),
  defaultTaxRateId: uuid.nullable().optional(),
});

export const UpdateHsnBody = z
  .strictObject({
    hsnCode: hsnCodeSchema.optional(),
    description: z.string().trim().max(255).nullable().optional(),
    defaultTaxRateId: uuid.nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Provide at least one field to update.');

// ── Assignments ───────────────────────────────────────────────────────────────────────────────
export const ListAssignmentsQuery = paginationQuery(PAGE_LIMITS.adminList).extend({
  targetType: z.enum(['PRODUCT', 'CATEGORY']).optional(),
  targetId: uuid.optional(),
  taxRateId: uuid.optional(),
  activeOn: istDateSchema.optional(),
});

export const CreateAssignmentBody = z
  .strictObject({
    targetType: z.enum(['PRODUCT', 'CATEGORY']),
    targetId: uuid,
    hsnCodeId: uuid,
    taxRateId: uuid,
    effectiveFrom: istDateSchema,
    effectiveTo: istDateSchema.nullable().optional(),
  })
  .refine(
    (b) =>
      b.effectiveTo === undefined || b.effectiveTo === null || b.effectiveTo >= b.effectiveFrom,
    {
      path: ['effectiveTo'],
      message: 'Must be on or after effectiveFrom.',
    },
  );

export const UpdateAssignmentBody = z
  .strictObject({
    hsnCodeId: uuid.optional(),
    taxRateId: uuid.optional(),
    effectiveFrom: istDateSchema.optional(),
    effectiveTo: istDateSchema.nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Provide at least one field to update.');

// ── Settings ──────────────────────────────────────────────────────────────────────────────────
export const SHIPPING_TREATMENTS = ['PROPORTIONAL', 'FIXED_RATE', 'EXEMPT'] as const;
export const INVOICE_TRIGGERS = ['ON_SHIPPED', 'ON_CONFIRMED'] as const;

export const sellerAddressSchema = z.strictObject({
  line1: z.string().trim().min(3).max(150),
  line2: z.string().trim().max(150).nullable().optional(),
  city: z.string().trim().min(2).max(80),
  pincode: z.string().regex(/^[1-9][0-9]{5}$/, 'Must be a 6-digit pincode.'),
});

const prefixSchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{2,8}$/, 'Must be 2–8 uppercase letters.');

export const UpdateTaxSettingsBody = z
  .strictObject({
    sellerGstin: z
      .string()
      .trim()
      .transform((v) => v.toUpperCase())
      .nullable()
      .optional(),
    sellerStateCode: z
      .string()
      .regex(/^\d{2}$/, 'Must be a 2-digit GST state code.')
      .nullable()
      .optional(),
    sellerLegalName: z.string().trim().min(2).max(200).nullable().optional(),
    sellerAddress: sellerAddressSchema.nullable().optional(),
    pricesIncludeTax: z.boolean().optional(),
    shippingTaxTreatment: z.enum(SHIPPING_TREATMENTS).optional(),
    shippingFixedTaxRateId: uuid.nullable().optional(),
    roundingMode: z.literal('PER_LINE_HALF_UP').optional(),
    invoiceRoundOff: z.boolean().optional(),
    invoiceTrigger: z.enum(INVOICE_TRIGGERS).optional(),
    invoicePrefix: prefixSchema.optional(),
    creditNotePrefix: prefixSchema.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Provide at least one setting to update.');

// ── Preview ───────────────────────────────────────────────────────────────────────────────────
const moneySchema = z.string().trim().regex(MONEY_PATTERN, 'Must be an amount like "1499.00".');

export const PreviewLine = z
  .strictObject({
    variantId: uuid.optional(),
    hsnCode: hsnCodeSchema.optional(),
    ratePercent: ratePercentSchema.optional(),
    netLineValue: moneySchema,
  })
  .refine(
    (l) =>
      (l.variantId !== undefined && l.hsnCode === undefined && l.ratePercent === undefined) ||
      (l.variantId === undefined && l.hsnCode !== undefined && l.ratePercent !== undefined),
    'Provide either variantId or both hsnCode and ratePercent.',
  );

export const PreviewBody = z.strictObject({
  lines: z.array(PreviewLine).min(1).max(100),
  shippingCharge: moneySchema.optional(),
  destinationStateCode: z.string().regex(/^\d{2}$/, 'Must be a 2-digit GST state code.'),
  /** Resolution date (IST); defaults to today. */
  at: istDateSchema.optional(),
});

export type CreateRateInput = z.output<typeof CreateRateBody>;
export type UpdateRateInput = z.output<typeof UpdateRateBody>;
export type CreateHsnInput = z.output<typeof CreateHsnBody>;
export type UpdateHsnInput = z.output<typeof UpdateHsnBody>;
export type CreateAssignmentInput = z.output<typeof CreateAssignmentBody>;
export type UpdateAssignmentInput = z.output<typeof UpdateAssignmentBody>;
export type UpdateTaxSettingsInput = z.output<typeof UpdateTaxSettingsBody>;
export type PreviewInput = z.output<typeof PreviewBody>;
export type ListRatesInput = z.output<typeof ListRatesQuery>;
export type ListHsnInput = z.output<typeof ListHsnQuery>;
export type ListAssignmentsInput = z.output<typeof ListAssignmentsQuery>;
