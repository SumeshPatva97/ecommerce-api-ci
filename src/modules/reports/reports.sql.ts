/**
 * Shared SQL fragments and value converters for the report queries.
 *
 * Every query is a `Prisma.sql` tagged template — user input only ever travels as a bound
 * parameter; the only `Prisma.raw` fragments are compile-time constants from this module
 * (column names, aliases) checked against `IDENTIFIER`. Never `$queryRawUnsafe`.
 *
 * Read-only (G7): no report runs INSERT/UPDATE/DELETE.
 */
import { Prisma } from '../../generated/prisma/client.js';
import type { Queryable } from '../../core/db/transaction.js';
import { Decimal, ZERO, dec, toMoneyString } from '../../lib/money.js';
import type { ColumnType } from '../../lib/export/index.js';
import type { Paging, ReportColumn, ReportRange, Row } from './reports.types.js';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.]*$/;

/** Raw identifier (constant column/alias names only — never user input). */
export function ident(name: string): Prisma.Sql {
  if (!IDENTIFIER.test(name)) throw new Error(`Unsafe SQL identifier: ${name}`);
  return Prisma.raw(name);
}

/** Back-quoted alias for camelCase result columns. */
export function alias(name: string): Prisma.Sql {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Unsafe SQL alias: ${name}`);
  return Prisma.raw(`\`${name}\``);
}

/** IST calendar day of a UTC DATETIME column (A8 — IST has no DST). */
export function istDay(column: string): Prisma.Sql {
  return Prisma.sql`DATE_FORMAT(CONVERT_TZ(${ident(column)}, '+00:00', '+05:30'), '%Y-%m-%d')`;
}

/** Orders never counted as sales (G4). */
export const NON_SALE_STATUSES = ['PENDING_PAYMENT', 'PAYMENT_FAILED'] as const;

/**
 * Sales-order predicate S (§4.2) on alias `o`, recognised on `confirmed_at` in the IST range.
 * PROVISIONAL (OQ-54): recognition date = `confirmed_at`; `basis=current` also drops orders whose
 * current status is CANCELLED (§4.3).
 */
export function salesOrderWhere(
  range: { start: Date; end: Date },
  basis: 'transaction' | 'current',
  a = 'o',
): Prisma.Sql {
  const col = (c: string): Prisma.Sql => ident(`${a}.${c}`);
  return Prisma.sql`${col('confirmed_at')} >= ${range.start} AND ${col('confirmed_at')} < ${range.end}
    AND ${col('status')} NOT IN ('PENDING_PAYMENT', 'PAYMENT_FAILED')
    ${basis === 'current' ? Prisma.sql`AND ${col('status')} <> 'CANCELLED'` : Prisma.empty}`;
}

/** `column IN (category + descendants)` using the materialised path `/root/child/self/`. */
export function inCategoryTree(column: string, categoryId: string): Prisma.Sql {
  return Prisma.sql`${ident(column)} IN (
    SELECT cd.id FROM categories cd
    WHERE cd.path LIKE CONCAT((SELECT cr.path FROM categories cr WHERE cr.id = ${categoryId}), '%'))`;
}

/** AND-joins fragments (empty → TRUE). */
export function and(conditions: readonly Prisma.Sql[]): Prisma.Sql {
  return conditions.length === 0 ? Prisma.sql`TRUE` : Prisma.join(conditions, ' AND ');
}

export function rangeOf(range: ReportRange | null): ReportRange {
  if (range === null) throw new Error('This report needs a date range.');
  return range;
}

// Value converters (MySQL driver returns Decimal / bigint / number / string / Date) ----------

export function toDec(value: unknown): Decimal {
  if (value === null || value === undefined) return ZERO;
  if (value instanceof Decimal) return value;
  if (typeof value === 'bigint') return dec(value.toString());
  if (typeof value === 'number' || typeof value === 'string') return dec(value);
  if (typeof value === 'object' && typeof (value as { toFixed?: unknown }).toFixed === 'function') {
    return dec((value as Decimal).toString());
  }
  return ZERO;
}

export function toDecOrNull(value: unknown): Decimal | null {
  return value === null || value === undefined ? null : toDec(value);
}

export function toInt(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Math.trunc(value);
  if (typeof value === 'bigint') return Number(value);
  return Math.trunc(toDec(value).toNumber());
}

export function toStr(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

export function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (!(value instanceof Date) && typeof value !== 'string' && typeof value !== 'number')
    return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** DATE column (returned as UTC-midnight Date or string) → `YYYY-MM-DD`. */
export function toIsoDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const iso = toIso(value);
  return iso === null ? null : iso.slice(0, 10);
}

export function toBool(value: unknown): boolean {
  return value === true || value === 1 || value === 1n || value === '1' || value === 'true';
}

/** a / b × factor, half-up 2 dp; null when b is 0 (ratios computed last, G3). */
export function ratio(a: Decimal, b: Decimal, factor = 1): Decimal | null {
  if (b.isZero()) return null;
  return a.times(factor).div(b).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

function normalizeCell(type: ColumnType, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'money':
      return toMoneyString(toDec(value));
    case 'decimal':
    case 'percent':
      return toDec(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
    case 'int':
      return toInt(value);
    case 'datetime':
      return toIso(value);
    case 'date':
      return toIsoDate(value);
    case 'boolean':
      return toBool(value);
    case 'string':
      return toStr(value);
  }
}

/** Projects a raw/derived row onto the report columns with canonical value formats. */
export function normalizeRow(columns: readonly ReportColumn[], row: Row): Row {
  const out: Row = {};
  for (const column of columns) out[column.key] = normalizeCell(column.type, row[column.key]);
  return out;
}

/**
 * Generic paged list over a SELECT (`base`): one query for the page, one for COUNT + SUM totals of
 * `sumKeys` over the full filtered set (G8).
 */
export async function pagedQuery(
  db: Queryable,
  base: Prisma.Sql,
  orderBy: Prisma.Sql,
  sumKeys: readonly string[],
  paging: Paging,
): Promise<{ rows: Row[]; totalItems: number; sums: Row }> {
  const sums =
    sumKeys.length === 0
      ? Prisma.empty
      : Prisma.sql`, ${Prisma.join(
          sumKeys.map((k) => Prisma.sql`SUM(x.${alias(k)}) AS ${alias(k)}`),
          ', ',
        )}`;
  const [rows, agg] = await Promise.all([
    db.$queryRaw<Row[]>(
      Prisma.sql`SELECT x.* FROM (${base}) x ORDER BY ${orderBy} LIMIT ${paging.take} OFFSET ${paging.skip}`,
    ),
    db.$queryRaw<Row[]>(Prisma.sql`SELECT COUNT(*) AS totalItems${sums} FROM (${base}) x`),
  ]);
  const first = agg[0] ?? {};
  return { rows, totalItems: toInt(first.totalItems), sums: first };
}

/** Slices an in-memory list (reports aggregated in Node). */
export function pageOf<T>(items: readonly T[], paging: Paging): T[] {
  return items.slice(paging.skip, paging.skip + paging.take);
}
