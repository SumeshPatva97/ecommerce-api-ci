/**
 * Report request parameters — REPORTING_AND_ANALYTICS.md §3, API_DOCUMENTATION.md §4.17.
 *
 * One shared filter schema for every report (query string on GET, `filters` object on export);
 * report-specific enum lists (`status`, `method`) are validated by the report itself so unknown
 * values return 422 with the field name.
 */
import { z } from 'zod';

import { AppError } from '../../core/errors/AppError.js';
import { PAGE_LIMITS } from '../../core/http/pagination.js';
import { addDays, istDayRange, istParts } from '../../lib/time.js';
import type { DateMode, ReportRange } from './reports.types.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const isoDate = z
  .string()
  .regex(ISO_DATE, { message: 'Use YYYY-MM-DD (IST).' })
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && validCalendarDate(v), {
    message: 'Not a valid calendar date.',
  });

function validCalendarDate(value: string): boolean {
  const d = new Date(`${value}T00:00:00Z`);
  return d.toISOString().slice(0, 10) === value;
}

const bool = z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]);

/** `a,b` or `['a','b']` → upper-case tokens. */
const tokenList = z
  .union([z.string(), z.array(z.string())])
  .transform((value) =>
    (Array.isArray(value) ? value : value.split(','))
      .map((v) => v.trim().toUpperCase())
      .filter((v) => v !== ''),
  )
  .pipe(
    z
      .array(z.string().regex(/^[A-Z_]{2,40}$/))
      .min(1)
      .max(20),
  );

export const GROUP_BY = ['day', 'week', 'month', 'quarter', 'fy', 'year', 'none'] as const;
export type GroupBy = (typeof GROUP_BY)[number];

export const reportFilterShape = {
  from: isoDate.optional(),
  to: isoDate.optional(),
  /** GST return period `YYYY-MM` (alternative to from/to). */
  period: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
  groupBy: z.enum(GROUP_BY).optional(),
  basis: z.enum(['transaction', 'current']).default('transaction'),
  compare: z.enum(['previous_period', 'previous_year']).optional(),
  paymentMethod: z.enum(['ONLINE', 'COD']).optional(),
  paymentStatus: tokenList.optional(),
  status: tokenList.optional(),
  method: tokenList.optional(),
  provider: z.string().trim().min(1).max(30).optional(),
  reason: z.string().trim().min(1).max(40).optional(),
  categoryId: z.uuid().optional(),
  brandId: z.uuid().optional(),
  collectionId: z.uuid().optional(),
  productId: z.uuid().optional(),
  variantId: z.uuid().optional(),
  couponId: z.uuid().optional(),
  promotionId: z.uuid().optional(),
  stateCode: z
    .string()
    .regex(/^\d{2}$/)
    .optional(),
  supplyType: z.enum(['INTRA_STATE', 'INTER_STATE']).optional(),
  rate: z
    .string()
    .regex(/^\d{1,2}(\.\d{1,2})?$/)
    .optional(),
  hsn: z
    .string()
    .regex(/^\d{4,8}$/)
    .optional(),
  level: z.enum(['product', 'variant']).default('product'),
  metric: z.enum(['units', 'revenue', 'orders']).optional(),
  mode: z.enum(['snapshot', 'transitions']).default('snapshot'),
  dateField: z
    .enum([
      'placed',
      'confirmed',
      'delivered',
      'cancelled',
      'created',
      'captured',
      'requested',
      'completed',
    ])
    .optional(),
  scope: z.enum(['PRODUCT', 'CATEGORY', 'BRAND', 'COLLECTION']).optional(),
  section: z.enum(['b2cl', 'b2cs']).optional(),
  depth: z.coerce.number().int().min(1).max(3).optional(),
  includeZero: bool.default(false),
  includeEmpty: bool.default(false),
  includeOutOfStock: bool.default(true),
  missingCostOnly: bool.default(false),
  reconcile: bool.default(false),
  q: z.string().trim().min(1).max(254).optional(),
  sort: z
    .string()
    .regex(/^[a-z_]{1,30}$/)
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  /** Page size (default 25, R-20); top-N size for best-sellers (20) / top-customers (50). */
  limit: z.coerce.number().int().min(1).max(PAGE_LIMITS.max).optional(),
};

export const ReportQuery = z.object(reportFilterShape);
export type ReportParams = z.output<typeof ReportQuery>;

export const ReportKeyParams = z.object({ reportKey: z.string().min(1).max(60) });

export const ExportBody = z.strictObject({
  format: z.enum(['csv', 'xlsx', 'pdf']).default('csv'),
  filters: z.object(reportFilterShape).default(ReportQuery.parse({})),
  columns: z
    .array(z.string().regex(/^[A-Za-z0-9_]{1,60}$/))
    .min(1)
    .max(60)
    .optional(),
  /** CSV only: `false` omits the `#` header block for machine import (§8.2). */
  includeHeader: bool.default(true),
  /** `print` routes printing through export so the server logs `PRINT` (§8.3). */
  purpose: z.enum(['download', 'print']).default('download'),
});
export type ExportBody = z.output<typeof ExportBody>;

export const ExportIdParams = z.object({ exportId: z.uuid() });

/** Validates a report-specific token list against an enum; 422 on unknown values. */
export function enumList<T extends string>(
  values: readonly string[] | undefined,
  allowed: readonly T[],
  field: string,
): T[] | undefined {
  if (values === undefined) return undefined;
  const bad = values.filter((v) => !(allowed as readonly string[]).includes(v));
  if (bad.length > 0) {
    throw new AppError('VALIDATION_ERROR', undefined, {
      details: [
        {
          field,
          message: `Unknown value(s): ${bad.join(', ')}. Allowed: ${allowed.join(', ')}.`,
        },
      ],
    });
  }
  return values as T[];
}

function invalid(field: string, message: string): AppError {
  return new AppError('VALIDATION_ERROR', undefined, { details: [{ field, message }] });
}

/** Today's IST business date. */
export function istToday(now: Date): string {
  const { year, month, day } = istParts(now);
  return `${String(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Adds calendar days to a `YYYY-MM-DD` string. */
export function shiftDate(isoDate: string, days: number): string {
  return addDays(new Date(`${isoDate}T00:00:00.000Z`), days)
    .toISOString()
    .slice(0, 10);
}

export function daysBetweenInclusive(from: string, to: string): number {
  return (
    Math.round(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / (24 * 3600 * 1000),
    ) + 1
  );
}

export function makeRange(from: string, to: string): ReportRange {
  return {
    from,
    to,
    start: istDayRange(from).start,
    end: istDayRange(to).end,
    days: daysBetweenInclusive(from, to),
  };
}

/** Default window when `from`/`to` are optional (best-sellers: last 90 days, §5.7). */
export const OPTIONAL_RANGE_DEFAULT_DAYS = 90;

/**
 * Resolves `from`/`to` (or GST `period`) to an IST range — REPORTING §2 G1, §3:
 * required unless the report is current-state; `to ≥ from`; at most `maxDays`.
 */
export function resolveReportRange(
  params: Pick<ReportParams, 'from' | 'to' | 'period'>,
  options: { dateMode: DateMode; maxDays: number; now: Date },
): ReportRange | null {
  if (options.dateMode === 'none') return null;
  let { from, to } = params;
  if (params.period !== undefined && from === undefined && to === undefined) {
    const [y, m] = params.period.split('-').map(Number) as [number, number];
    from = `${params.period}-01`;
    to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  }
  if (from === undefined || to === undefined) {
    if (options.dateMode === 'required') {
      const details = [];
      if (from === undefined) details.push({ field: 'from', message: '`from` is required.' });
      if (to === undefined) details.push({ field: 'to', message: '`to` is required.' });
      throw new AppError('VALIDATION_ERROR', undefined, { details });
    }
    to ??= istToday(options.now);
    from ??= shiftDate(to, -(OPTIONAL_RANGE_DEFAULT_DAYS - 1));
  }
  if (to < from) throw invalid('to', '`to` must be on or after `from`.');
  const days = daysBetweenInclusive(from, to);
  if (days > options.maxDays) {
    throw invalid(
      'to',
      `The range may span at most ${String(options.maxDays)} days. Use export for larger ranges.`,
    );
  }
  return makeRange(from, to);
}
