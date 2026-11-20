/**
 * Report contracts — REPORTING_AND_ANALYTICS.md §3, §5; API_DOCUMENTATION.md §4.17.
 */
import type { Queryable } from '../../core/db/transaction.js';
import type { ExportColumn, ExportSheet } from '../../lib/export/index.js';
import type { AuthContext } from '../rbac/permission.service.js';
import type { ReportParams } from './reports.params.js';

/** Canonical report keys (API_DOCUMENTATION.md §4.17, PROJECT_CONTEXT §8.1). */
export const REPORT_KEYS = [
  'sales',
  'orders',
  'order-status',
  'product-sales',
  'category-sales',
  'brand-sales',
  'best-sellers',
  'inventory-valuation',
  'low-stock',
  'customers-new-returning',
  'top-customers',
  'coupons',
  'promotions',
  'gst-summary',
  'gst-hsn',
  'gst-b2c',
  'gst-b2b',
  'gst-credit-notes',
  'payments',
  'refunds',
] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

export function isReportKey(value: string): value is ReportKey {
  return (REPORT_KEYS as readonly string[]).includes(value);
}

export type ReportColumn = ExportColumn;
export type Row = Record<string, unknown>;

/** Resolved IST business-day range: `[start, end)` in UTC; `from`/`to` inclusive IST dates. */
export interface ReportRange {
  readonly from: string;
  readonly to: string;
  readonly start: Date;
  readonly end: Date;
  readonly days: number;
}

export interface Paging {
  readonly skip: number;
  readonly take: number;
}

export type Viewer = Pick<AuthContext, 'permissions' | 'isSuperadmin'>;

export interface ReportContext {
  readonly db: Queryable;
  readonly params: ReportParams;
  /** Null for current-state reports (inventory-valuation, low-stock). */
  readonly range: ReportRange | null;
  readonly viewer: Viewer;
  readonly now: Date;
  /** Row window for list reports (time-series reports always return every bucket). */
  readonly paging: Paging;
}

export interface ReportOutput {
  readonly columns: readonly ReportColumn[];
  /** Normalised rows (money as 2-dp strings, datetimes ISO UTC). */
  readonly rows: Row[];
  /** Totals over the full filtered set (G8), not just the page. */
  readonly totals: Row | null;
  readonly totalItems: number;
  /** True when `rows` is a page of `totalItems` (list reports). */
  readonly paginated: boolean;
  readonly notices?: readonly string[];
  /** Report-specific blocks (summary, comparison, state-wise …) added to `data`. */
  readonly extra?: Readonly<Record<string, unknown>>;
  /** Additional export sections (XLSX sheets / CSV & PDF sections). */
  readonly extraSheets?: readonly ExportSheet[];
}

export type DateMode = 'required' | 'optional' | 'none';

export interface ReportDefinition {
  readonly key: ReportKey;
  readonly title: string;
  /** Bumped on any formula change (A12). */
  readonly version: string;
  /** Domain permissions required on top of `reports.view` (R-14 / OQ-68). */
  readonly domainPermissions: readonly string[];
  readonly dateMode: DateMode;
  /** Max on-screen range in days (detail lists 366; time series 3 years). */
  readonly maxRangeDays: number;
  readonly timeSeries: boolean;
  /** Customer-data export (R-15): also `customers.export` + re-auth. */
  readonly customerData: boolean;
  /** Whether the output contains unmasked customer PII for this viewer (§10 `containsPii`). */
  readonly containsPii: (viewer: Viewer) => boolean;
  /** Mandatory export footer (GST). */
  readonly footer?: string;
  run(ctx: ReportContext): Promise<ReportOutput>;
}
