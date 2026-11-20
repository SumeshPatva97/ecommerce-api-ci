/**
 * Report registry: reportKey → definition (domain permission, query, columns) —
 * REPORTING_AND_ANALYTICS.md §12 ("a report-key → required-permissions map in ecommerce-api,
 * checked before query execution").
 *
 * PROVISIONAL (OQ-68 / R-14): module-level `reports.view` plus the domain permission per family
 * (`tax.view` for GST, `payments.view` / `refunds.view`, `inventory.view` for valuation and low
 * stock, `customers.view` for customer reports); finer per-report access deferred.
 */
import { CUSTOMER_REPORTS } from './reports.customers.js';
import { GST_REPORTS } from './reports.gst.js';
import { INVENTORY_REPORTS } from './reports.inventory.js';
import { MARKETING_REPORTS } from './reports.marketing.js';
import { PAYMENT_REPORTS } from './reports.payments.js';
import { PRODUCT_REPORTS } from './reports.products.js';
import { SALES_REPORTS } from './reports.sales.js';
import {
  REPORT_KEYS,
  isReportKey,
  type ReportDefinition,
  type ReportKey,
} from './reports.types.js';

const ALL: readonly ReportDefinition[] = [
  ...SALES_REPORTS,
  ...PRODUCT_REPORTS,
  ...INVENTORY_REPORTS,
  ...CUSTOMER_REPORTS,
  ...MARKETING_REPORTS,
  ...GST_REPORTS,
  ...PAYMENT_REPORTS,
];

export const REPORT_REGISTRY: Readonly<Record<ReportKey, ReportDefinition>> = Object.freeze(
  Object.fromEntries(ALL.map((d) => [d.key, d])) as Record<ReportKey, ReportDefinition>,
);

// Fail fast at startup if a canonical key has no definition (or a duplicate slipped in).
if (ALL.length !== REPORT_KEYS.length || REPORT_KEYS.some((k) => !(k in REPORT_REGISTRY))) {
  throw new Error('Report registry does not cover every canonical report key exactly once.');
}

export function findReport(key: string): ReportDefinition | undefined {
  return isReportKey(key) ? REPORT_REGISTRY[key] : undefined;
}

/** Every permission a viewer needs for the report (`view`) or its export. */
export function requiredPermissions(def: ReportDefinition, action: 'view' | 'export'): string[] {
  const keys = ['reports.view', ...def.domainPermissions];
  if (action === 'export') {
    keys.push('reports.export');
    if (def.customerData) keys.push('customers.export');
  }
  return keys;
}
