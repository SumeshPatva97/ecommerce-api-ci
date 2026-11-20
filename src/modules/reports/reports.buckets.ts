/**
 * Time buckets (IST) — REPORTING_AND_ANALYTICS.md §2.1. SQL always groups by IST calendar day
 * (`DATE_FORMAT(CONVERT_TZ(col,'+00:00','+05:30'),'%Y-%m-%d')`, A8); days are rolled up to
 * week (ISO-8601, Monday start, ISO week-year labels — R12), month, quarter, Indian FY, year or a
 * single `none` bucket here, with zero-fill and `isPartial` flags at the range edges. Pure.
 */
import { Decimal, ZERO } from '../../lib/money.js';
import { shiftDate, type GroupBy } from './reports.params.js';
import type { ReportRange } from './reports.types.js';

/** Default grouping: `day` for ranges ≤ 62 days, else `month` (§3). */
export function defaultGroupBy(days: number): GroupBy {
  return days <= 62 ? 'day' : 'month';
}

export function enumerateDays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = shiftDate(d, 1)) out.push(d);
  return out;
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

function parts(day: string): { y: number; m: number; d: number } {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return { y, m, d };
}

function lastDayOfMonth(y: number, m: number): string {
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** ISO-8601 week of a calendar day: `{ label: '2026-W46', weekStart: '2026-11-09' }`. */
export function isoWeek(day: string): { label: string; weekStart: string; weekEnd: string } {
  const date = new Date(`${day}T00:00:00.000Z`);
  const weekday = (date.getUTCDay() + 6) % 7; // Monday = 0
  const weekStart = shiftDate(day, -weekday);
  const thursday = new Date(`${shiftDate(weekStart, 3)}T00:00:00.000Z`);
  const isoYear = thursday.getUTCFullYear();
  const ordinal = Math.floor((thursday.getTime() - Date.UTC(isoYear, 0, 1)) / 86_400_000) + 1;
  const week = Math.floor((ordinal - 1) / 7) + 1;
  return { label: `${String(isoYear)}-W${pad(week)}`, weekStart, weekEnd: shiftDate(weekStart, 6) };
}

export interface Bucket {
  readonly key: string;
  /** First and last IST day of the natural bucket (before clipping to the range). */
  readonly naturalStart: string;
  readonly naturalEnd: string;
  /** Bucket clipped to the requested range. */
  readonly start: string;
  readonly end: string;
  readonly isPartial: boolean;
  readonly weekStart?: string;
}

function natural(
  day: string,
  groupBy: GroupBy,
  range: ReportRange,
): { key: string; start: string; end: string; weekStart?: string } {
  const { y, m } = parts(day);
  switch (groupBy) {
    case 'day':
      return { key: day, start: day, end: day };
    case 'week': {
      const w = isoWeek(day);
      return { key: w.label, start: w.weekStart, end: w.weekEnd, weekStart: w.weekStart };
    }
    case 'month':
      return {
        key: `${String(y)}-${pad(m)}`,
        start: `${String(y)}-${pad(m)}-01`,
        end: lastDayOfMonth(y, m),
      };
    case 'quarter': {
      const q = Math.floor((m - 1) / 3) + 1;
      const startMonth = (q - 1) * 3 + 1;
      return {
        key: `${String(y)}-Q${String(q)}`,
        start: `${String(y)}-${pad(startMonth)}-01`,
        end: lastDayOfMonth(y, startMonth + 2),
      };
    }
    case 'fy': {
      const startYear = m >= 4 ? y : y - 1;
      return {
        key: `FY${String(startYear)}-${pad((startYear + 1) % 100)}`,
        start: `${String(startYear)}-04-01`,
        end: `${String(startYear + 1)}-03-31`,
      };
    }
    case 'year':
      return { key: String(y), start: `${String(y)}-01-01`, end: `${String(y)}-12-31` };
    case 'none':
      return { key: `${range.from}..${range.to}`, start: range.from, end: range.to };
  }
}

/** Ordered buckets covering the range plus a day → bucket-key index. */
export function buildBuckets(
  range: ReportRange,
  groupBy: GroupBy,
): { buckets: Bucket[]; dayToBucket: Map<string, string> } {
  const buckets: Bucket[] = [];
  const byKey = new Map<string, Bucket>();
  const dayToBucket = new Map<string, string>();
  for (const day of enumerateDays(range.from, range.to)) {
    const n = natural(day, groupBy, range);
    dayToBucket.set(day, n.key);
    if (byKey.has(n.key)) continue;
    const start = n.start < range.from ? range.from : n.start;
    const end = n.end > range.to ? range.to : n.end;
    const bucket: Bucket = {
      key: n.key,
      naturalStart: n.start,
      naturalEnd: n.end,
      start,
      end,
      isPartial: start !== n.start || end !== n.end,
      ...(n.weekStart === undefined ? {} : { weekStart: n.weekStart }),
    };
    byKey.set(n.key, bucket);
    buckets.push(bucket);
  }
  return { buckets, dayToBucket };
}

export type Metrics<K extends string> = Record<K, Decimal>;

export function zeroMetrics<K extends string>(keys: readonly K[]): Metrics<K> {
  const out = {} as Metrics<K>;
  for (const k of keys) out[k] = ZERO;
  return out;
}

export function addMetrics<K extends string>(
  target: Metrics<K>,
  source: Partial<Record<K, Decimal>>,
  keys: readonly K[],
): void {
  for (const k of keys) {
    const v = source[k];
    if (v !== undefined) target[k] = target[k].plus(v);
  }
}

/** Rolls per-day metrics up into zero-filled buckets; also returns range totals. */
export function rollUp<K extends string>(
  perDay: ReadonlyMap<string, Partial<Record<K, Decimal>>>,
  keys: readonly K[],
  range: ReportRange,
  groupBy: GroupBy,
): { series: { bucket: Bucket; values: Metrics<K> }[]; totals: Metrics<K> } {
  const { buckets, dayToBucket } = buildBuckets(range, groupBy);
  const values = new Map<string, Metrics<K>>(buckets.map((b) => [b.key, zeroMetrics(keys)]));
  const totals = zeroMetrics(keys);
  for (const [day, metrics] of perDay) {
    const key = dayToBucket.get(day);
    if (key === undefined) continue; // outside the range (defensive)
    const target = values.get(key);
    if (target === undefined) continue;
    addMetrics(target, metrics, keys);
    addMetrics(totals, metrics, keys);
  }
  return {
    series: buckets.map((bucket) => ({
      bucket,
      values: values.get(bucket.key) ?? zeroMetrics(keys),
    })),
    totals,
  };
}

/** Range for the comparison period (`compare`, §3). */
export function comparisonRange(
  range: ReportRange,
  compare: 'previous_period' | 'previous_year',
): { from: string; to: string } {
  if (compare === 'previous_period') {
    return { from: shiftDate(range.from, -range.days), to: shiftDate(range.from, -1) };
  }
  const minusYear = (day: string): string => {
    const { y, m, d } = parts(day);
    const last = Number(lastDayOfMonth(y - 1, m).slice(8));
    return `${String(y - 1)}-${pad(m)}-${pad(Math.min(d, last))}`;
  };
  return { from: minusYear(range.from), to: minusYear(range.to) };
}

/** `(current − previous) / previous × 100`, 2 dp; null when previous is 0. */
export function changePercent(current: Decimal, previous: Decimal): string | null {
  if (previous.isZero()) return null;
  return current
    .minus(previous)
    .div(previous.abs())
    .times(100)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toFixed(2);
}
