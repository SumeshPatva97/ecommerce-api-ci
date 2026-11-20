/** Tax master rows → API DTOs (rates as 2-dp strings, dates as IST `YYYY-MM-DD`). */
import type { Decimal } from '../../lib/money.js';
import { isEffectiveOn, toIstDateString } from '../../lib/tax/resolution.js';

const rate = (value: Decimal): string => value.toFixed(2);

export interface TaxRateRow {
  id: string;
  name: string;
  rate: Decimal;
  cgstRate: Decimal;
  sgstRate: Decimal;
  utgstRate: Decimal;
  igstRate: Decimal;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  _count?: { assignments: number; hsnCodes: number } | undefined;
}

export function toTaxRateDto(row: TaxRateRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    ratePercent: rate(row.rate),
    components: {
      cgst: rate(row.cgstRate),
      sgst: rate(row.sgstRate),
      utgst: rate(row.utgstRate),
      igst: rate(row.igstRate),
    },
    status: row.isActive ? 'ACTIVE' : 'INACTIVE',
    isActive: row.isActive,
    ...(row._count === undefined
      ? {}
      : { usage: { assignments: row._count.assignments, hsnDefaults: row._count.hsnCodes } }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface HsnRow {
  id: string;
  hsnCode: string;
  description: string | null;
  defaultTaxRateId: string | null;
  createdAt: Date;
  updatedAt: Date;
  defaultTaxRate?: { id: string; name: string; rate: Decimal } | null;
}

export function toHsnDto(row: HsnRow): Record<string, unknown> {
  return {
    id: row.id,
    hsnCode: row.hsnCode,
    description: row.description,
    defaultTaxRateId: row.defaultTaxRateId,
    defaultTaxRate:
      row.defaultTaxRate === undefined || row.defaultTaxRate === null
        ? null
        : {
            id: row.defaultTaxRate.id,
            name: row.defaultTaxRate.name,
            ratePercent: rate(row.defaultTaxRate.rate),
          },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface AssignmentRow {
  id: string;
  targetType: 'PRODUCT' | 'CATEGORY';
  productId: string | null;
  categoryId: string | null;
  taxRateId: string;
  hsnCode: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  createdAt: Date;
  updatedAt: Date;
  taxRate: { id: string; name: string; rate: Decimal; isActive: boolean };
  hsn: { id: string; hsnCode: string } | null;
  product?: { id: string; name: string } | null;
  category?: { id: string; name: string } | null;
}

export function toAssignmentDto(row: AssignmentRow, now: Date): Record<string, unknown> {
  const targetName =
    row.targetType === 'PRODUCT' ? (row.product?.name ?? null) : (row.category?.name ?? null);
  return {
    id: row.id,
    targetType: row.targetType,
    targetId: row.targetType === 'PRODUCT' ? row.productId : row.categoryId,
    targetName,
    taxRate: {
      id: row.taxRate.id,
      name: row.taxRate.name,
      ratePercent: rate(row.taxRate.rate),
      status: row.taxRate.isActive ? 'ACTIVE' : 'INACTIVE',
    },
    hsnCodeId: row.hsn?.id ?? null,
    hsnCode: row.hsnCode,
    effectiveFrom: toIstDateString(row.effectiveFrom),
    effectiveTo: row.effectiveTo === null ? null : toIstDateString(row.effectiveTo),
    isCurrentlyEffective: isEffectiveOn(row, now),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
