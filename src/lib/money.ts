/**
 * Money helpers — PROJECT_CONTEXT.md §3.3 (DECIMAL(12,2), never float), §8 (money in JSON as
 * strings with 2 decimals). Uses Prisma's bundled Decimal (decimal.js). Pure.
 */
import { Prisma } from '../generated/prisma/client.js';

export type Decimal = Prisma.Decimal;
export const Decimal = Prisma.Decimal;
export type DecimalInput = Prisma.Decimal | string | number;

export const ZERO = new Prisma.Decimal(0);

export function dec(value: DecimalInput): Prisma.Decimal {
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

/** Half-up to 2 decimals (₹0.01) — OQ-23 per-line rounding. */
export function roundMoney(value: DecimalInput): Prisma.Decimal {
  return dec(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/** `"1499.00"` — the only money representation allowed in API JSON. */
export function toMoneyString(value: DecimalInput): string {
  return roundMoney(value).toFixed(2);
}

/** Nullable variant for optional money columns. */
export function toMoneyStringOrNull(value: DecimalInput | null | undefined): string | null {
  return value === null || value === undefined ? null : toMoneyString(value);
}

export function sum(values: readonly DecimalInput[]): Prisma.Decimal {
  return values.reduce<Prisma.Decimal>((acc, v) => acc.plus(dec(v)), ZERO);
}

export function maxDec(a: DecimalInput, b: DecimalInput): Prisma.Decimal {
  return Prisma.Decimal.max(dec(a), dec(b));
}

export function minDec(a: DecimalInput, b: DecimalInput): Prisma.Decimal {
  return Prisma.Decimal.min(dec(a), dec(b));
}

/** Money string schema helper: `"1499"`, `"1499.5"`, `"1499.50"` → valid; ≤ 10 integer digits. */
export const MONEY_PATTERN = /^\d{1,10}(\.\d{1,2})?$/;

/** Rupees → paise (integer) for gateway APIs. */
export function toMinorUnits(value: DecimalInput): number {
  return roundMoney(value).times(100).toNumber();
}
