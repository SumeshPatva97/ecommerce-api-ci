/**
 * GST seller settings stored as typed rows of `settings` (group `tax`) — TAX_AND_GST_WORKFLOWS.md
 * §4, API_DOCUMENTATION.md §4.10. Missing/invalid rows fall back to the documented working
 * assumptions (all PROVISIONAL, reversible by the owner):
 *
 * - PROVISIONAL (OQ-20): single seller GSTIN/state — unset until configured (checkout blocked).
 * - PROVISIONAL (OQ-21): `pricesIncludeTax = true`.
 * - PROVISIONAL (OQ-22): `shippingTaxTreatment = PROPORTIONAL`.
 * - PROVISIONAL (OQ-23): `roundingMode = PER_LINE_HALF_UP`, `invoiceRoundOff = true`.
 * - PROVISIONAL (OQ-48): `invoiceTrigger = ON_SHIPPED`.
 * - PROVISIONAL (OQ-26): prefixes `INV` / `CN`.
 */
import { z } from 'zod';

import { Prisma } from '../../generated/prisma/client.js';
import type { ValueType } from '../../generated/prisma/enums.js';
import type { Queryable } from '../../core/db/transaction.js';
import { INVOICE_TRIGGERS, SHIPPING_TREATMENTS, sellerAddressSchema } from './tax.schemas.js';

export type SellerAddress = z.output<typeof sellerAddressSchema>;

export interface TaxSettings {
  sellerGstin: string | null;
  sellerStateCode: string | null;
  sellerLegalName: string | null;
  sellerAddress: SellerAddress | null;
  pricesIncludeTax: boolean;
  shippingTaxTreatment: (typeof SHIPPING_TREATMENTS)[number];
  shippingFixedTaxRateId: string | null;
  roundingMode: 'PER_LINE_HALF_UP';
  invoiceRoundOff: boolean;
  invoiceTrigger: (typeof INVOICE_TRIGGERS)[number];
  invoicePrefix: string;
  creditNotePrefix: string;
}

export const TAX_SETTING_DEFAULTS: Readonly<TaxSettings> = Object.freeze({
  sellerGstin: null,
  sellerStateCode: null,
  sellerLegalName: null,
  sellerAddress: null,
  pricesIncludeTax: true,
  shippingTaxTreatment: 'PROPORTIONAL',
  shippingFixedTaxRateId: null,
  roundingMode: 'PER_LINE_HALF_UP',
  invoiceRoundOff: true,
  invoiceTrigger: 'ON_SHIPPED',
  invoicePrefix: 'INV',
  creditNotePrefix: 'CN',
});

interface FieldSpec {
  readonly key: string;
  readonly valueType: ValueType;
  readonly schema: z.ZodType;
  readonly description: string;
}

const nullableString = z.string().nullable();

export const TAX_SETTING_FIELDS: Readonly<Record<keyof TaxSettings, FieldSpec>> = {
  sellerGstin: {
    key: 'tax.seller_gstin',
    valueType: 'STRING',
    schema: nullableString,
    description: 'Seller GSTIN (OQ-20)',
  },
  sellerStateCode: {
    key: 'tax.seller_state_code',
    valueType: 'STRING',
    schema: z
      .string()
      .regex(/^\d{2}$/)
      .nullable(),
    description: 'Seller GST state code (OQ-20)',
  },
  sellerLegalName: {
    key: 'tax.seller_legal_name',
    valueType: 'STRING',
    schema: nullableString,
    description: 'Seller legal name',
  },
  sellerAddress: {
    key: 'tax.seller_address',
    valueType: 'JSON',
    schema: sellerAddressSchema.nullable(),
    description: 'Seller registered address',
  },
  pricesIncludeTax: {
    key: 'tax.prices_include_tax',
    valueType: 'BOOLEAN',
    schema: z.boolean(),
    description: 'Prices include GST (OQ-21)',
  },
  shippingTaxTreatment: {
    key: 'tax.shipping_tax_mode',
    valueType: 'STRING',
    schema: z.enum(SHIPPING_TREATMENTS),
    description: 'Shipping tax treatment (OQ-22)',
  },
  shippingFixedTaxRateId: {
    key: 'tax.shipping_fixed_rate_id',
    valueType: 'STRING',
    schema: nullableString,
    description: 'Tax rate used when shipping treatment is FIXED_RATE (OQ-22)',
  },
  roundingMode: {
    key: 'tax.rounding_mode',
    valueType: 'STRING',
    schema: z.literal('PER_LINE_HALF_UP'),
    description: 'Tax rounding mode (OQ-23)',
  },
  invoiceRoundOff: {
    key: 'tax.invoice_round_off',
    valueType: 'BOOLEAN',
    schema: z.boolean(),
    description: 'Round invoice total to nearest rupee (OQ-23)',
  },
  invoiceTrigger: {
    key: 'tax.invoice_trigger',
    valueType: 'STRING',
    schema: z.enum(INVOICE_TRIGGERS),
    description: 'Invoice generation trigger (OQ-48)',
  },
  invoicePrefix: {
    key: 'tax.invoice_prefix',
    valueType: 'STRING',
    schema: z.string(),
    description: 'Invoice number prefix (OQ-26)',
  },
  creditNotePrefix: {
    key: 'tax.credit_note_prefix',
    valueType: 'STRING',
    schema: z.string(),
    description: 'Credit note number prefix (OQ-26)',
  },
};

const FIELD_NAMES = Object.keys(TAX_SETTING_FIELDS) as (keyof TaxSettings)[];

/** Reads all tax settings (defaults for missing or malformed rows). */
export async function loadTaxSettings(db: Queryable): Promise<TaxSettings> {
  const rows = await db.setting.findMany({
    where: { settingKey: { in: FIELD_NAMES.map((f) => TAX_SETTING_FIELDS[f].key) } },
    select: { settingKey: true, value: true },
  });
  const byKey = new Map(rows.map((r) => [r.settingKey, r.value]));
  const out: Record<string, unknown> = { ...TAX_SETTING_DEFAULTS };
  for (const field of FIELD_NAMES) {
    const spec = TAX_SETTING_FIELDS[field];
    if (!byKey.has(spec.key)) continue;
    const parsed = spec.schema.safeParse(byKey.get(spec.key));
    if (parsed.success) out[field] = parsed.data;
  }
  return out as unknown as TaxSettings;
}

/** Upserts the given fields (one row each). */
export async function saveTaxSettings(
  db: Queryable,
  changes: Partial<TaxSettings>,
  updatedById: string | null,
): Promise<void> {
  for (const field of FIELD_NAMES) {
    if (!(field in changes)) continue;
    const spec = TAX_SETTING_FIELDS[field];
    const raw = changes[field];
    const value: Prisma.InputJsonValue | typeof Prisma.JsonNull = raw ?? Prisma.JsonNull;
    await db.setting.upsert({
      where: { settingKey: spec.key },
      create: {
        settingKey: spec.key,
        groupKey: 'tax',
        value,
        valueType: spec.valueType,
        isPublic: false,
        description: spec.description,
        updatedById,
      },
      update: { value, version: { increment: 1 }, updatedById },
    });
  }
}
