/**
 * Payments & refunds — REPORTING_AND_ANALYTICS.md §5.19, §5.20. `payments` needs `payments.view`,
 * `refunds` needs `refunds.view` (R-14).
 *
 * Never shows card numbers, UPI IDs/VPAs, bank accounts or gateway secrets (not stored). Provider
 * payment ids are masked to the last 6 characters unless the viewer holds `payments.update`.
 * PROVISIONAL (OQ-13): refund SLA from setting `refunds.sla_hours` (default 168 h = 7 days).
 */
import { Prisma } from '../../generated/prisma/client.js';
import {
  PaymentMethod,
  PaymentStatus,
  RefundMethod,
  RefundStatus,
} from '../../generated/prisma/enums.js';
import { Decimal } from '../../lib/money.js';
import { hasPermission } from '../rbac/permission.service.js';
import { enumList } from './reports.params.js';
import {
  and,
  normalizeRow,
  pagedQuery,
  rangeOf,
  ratio,
  toDec,
  toInt,
  toIso,
  toStr,
} from './reports.sql.js';
import type {
  ReportColumn,
  ReportContext,
  ReportDefinition,
  ReportOutput,
  Row,
} from './reports.types.js';

const never = (): boolean => false;

export function maskProviderId(id: string | null): string | null {
  if (id === null) return null;
  return id.length <= 6 ? id : `${'*'.repeat(Math.min(8, id.length - 6))}${id.slice(-6)}`;
}

/** Provider failure text without control characters, capped (sanitised provider code/message). */
export function sanitizeFailure(code: string | null, reason: string | null): string | null {
  const text = [code, reason].filter((v): v is string => v !== null && v !== '').join(': ');
  if (text === '') return null;
  return Array.from(text)
    .map((ch) => ((ch.codePointAt(0) ?? 0) < 0x20 ? ' ' : ch))
    .join('')
    .slice(0, 200);
}

// payments -------------------------------------------------------------------------------------

const PAYMENT_COLUMNS: readonly ReportColumn[] = [
  { key: 'paymentId', label: 'Payment ID', type: 'string' },
  { key: 'orderNumber', label: 'Order number', type: 'string' },
  { key: 'provider', label: 'Provider', type: 'string' },
  { key: 'providerPaymentId', label: 'Provider payment ID', type: 'string' },
  { key: 'method', label: 'Method', type: 'string' },
  { key: 'amount', label: 'Amount', type: 'money' },
  { key: 'status', label: 'Status', type: 'string' },
  { key: 'createdAt', label: 'Created at', type: 'datetime' },
  { key: 'capturedAt', label: 'Captured at', type: 'datetime' },
  { key: 'refundedAmount', label: 'Refunded', type: 'money' },
  { key: 'failureReason', label: 'Failure reason', type: 'string' },
];

async function runPayments(ctx: ReportContext): Promise<ReportOutput> {
  const range = rangeOf(ctx.range);
  const p = ctx.params;
  const statuses = enumList(p.status, Object.values(PaymentStatus), 'status');
  const methods = enumList(p.method, Object.values(PaymentMethod), 'method');
  const dateCol =
    p.dateField === 'captured' ? Prisma.sql`pm.captured_at` : Prisma.sql`pm.created_at`;
  const where: Prisma.Sql[] = [
    Prisma.sql`${dateCol} >= ${range.start} AND ${dateCol} < ${range.end}`,
  ];
  if (statuses !== undefined) where.push(Prisma.sql`pm.status IN (${Prisma.join(statuses)})`);
  if (methods !== undefined) where.push(Prisma.sql`pm.payment_method IN (${Prisma.join(methods)})`);
  if (p.provider !== undefined) where.push(Prisma.sql`pm.provider = ${p.provider}`);
  const from = Prisma.sql`FROM payments pm JOIN orders o ON o.id = pm.order_id WHERE ${and(where)}`;
  const base = Prisma.sql`
    SELECT pm.id AS paymentId, o.order_number AS orderNumber, pm.provider AS provider,
           pm.provider_payment_id AS providerPaymentId, pm.payment_method AS method,
           pm.amount AS amount, pm.status AS status, pm.created_at AS createdAt,
           pm.captured_at AS capturedAt, pm.amount_refunded AS refundedAmount,
           pm.failure_code AS failureCode, pm.failure_reason AS failureReason
    ${from}`;
  const [{ rows, totalItems, sums }, byStatus] = await Promise.all([
    pagedQuery(
      ctx.db,
      base,
      Prisma.sql`x.createdAt DESC, x.paymentId ASC`,
      ['amount', 'refundedAmount'],
      ctx.paging,
    ),
    ctx.db.$queryRaw<Row[]>(
      Prisma.sql`SELECT pm.status AS status, COUNT(*) AS count, SUM(pm.amount) AS amount ${from} GROUP BY pm.status`,
    ),
  ]);
  const unmaskIds = hasPermission(ctx.viewer, 'payments.update');
  const countOf = (s: string): number => toInt(byStatus.find((r) => toStr(r.status) === s)?.count);
  const captured = countOf('CAPTURED') + countOf('PARTIALLY_REFUNDED') + countOf('REFUNDED');
  const failed = countOf('FAILED');
  return {
    columns: PAYMENT_COLUMNS,
    rows: rows.map((r) =>
      normalizeRow(PAYMENT_COLUMNS, {
        ...r,
        providerPaymentId: unmaskIds
          ? r.providerPaymentId
          : maskProviderId(toStr(r.providerPaymentId)),
        failureReason: sanitizeFailure(toStr(r.failureCode), toStr(r.failureReason)),
      }),
    ),
    totals: normalizeRow(PAYMENT_COLUMNS, sums),
    totalItems,
    paginated: true,
    extra: {
      summary: {
        byStatus: byStatus.map((r) => ({
          status: toStr(r.status),
          count: toInt(r.count),
          amount: toDec(r.amount).toFixed(2),
        })),
        // Captured includes payments later (partially) refunded — they were captured.
        successRate:
          ratio(new Decimal(captured), new Decimal(captured + failed), 100)?.toFixed(2) ?? null,
      },
    },
  };
}

// refunds --------------------------------------------------------------------------------------

export const REFUND_SLA_SETTING_KEY = 'refunds.sla_hours';
export const DEFAULT_REFUND_SLA_HOURS = 168;
const OPEN_REFUND = ['REQUESTED', 'APPROVED', 'PROCESSING'];

const REFUND_COLUMNS: readonly ReportColumn[] = [
  { key: 'refundNumber', label: 'Refund number', type: 'string' },
  { key: 'orderNumber', label: 'Order number', type: 'string' },
  { key: 'amount', label: 'Amount', type: 'money' },
  { key: 'method', label: 'Method', type: 'string' },
  { key: 'status', label: 'Status', type: 'string' },
  { key: 'reason', label: 'Reason', type: 'string' },
  { key: 'requestedAt', label: 'Requested at', type: 'datetime' },
  { key: 'approvedBy', label: 'Approved by', type: 'string' },
  { key: 'approvedAt', label: 'Approved at', type: 'datetime' },
  { key: 'completedAt', label: 'Completed at', type: 'datetime' },
  { key: 'ageHours', label: 'Age (hours, open)', type: 'decimal' },
  { key: 'creditNoteNumber', label: 'Credit note', type: 'string' },
  { key: 'taxReversed', label: 'Tax reversed', type: 'money' },
];

async function refundSlaHours(ctx: ReportContext): Promise<number> {
  const row = await ctx.db.setting.findUnique({
    where: { settingKey: REFUND_SLA_SETTING_KEY },
    select: { value: true },
  });
  const v = row?.value;
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : DEFAULT_REFUND_SLA_HOURS;
}

async function runRefunds(ctx: ReportContext): Promise<ReportOutput> {
  const range = rangeOf(ctx.range);
  const p = ctx.params;
  const statuses = enumList(p.status, Object.values(RefundStatus), 'status');
  const methods = enumList(p.method, Object.values(RefundMethod), 'method');
  const dateCol =
    p.dateField === 'completed' ? Prisma.sql`r.completed_at` : Prisma.sql`r.created_at`;
  const where: Prisma.Sql[] = [
    Prisma.sql`${dateCol} >= ${range.start} AND ${dateCol} < ${range.end}`,
  ];
  if (statuses !== undefined) where.push(Prisma.sql`r.status IN (${Prisma.join(statuses)})`);
  if (methods !== undefined) where.push(Prisma.sql`r.method IN (${Prisma.join(methods)})`);
  if (p.reason !== undefined) where.push(Prisma.sql`r.reason_code = ${p.reason.toUpperCase()}`);
  const from = Prisma.sql`FROM refunds r JOIN orders o ON o.id = r.order_id WHERE ${and(where)}`;
  const base = Prisma.sql`
    SELECT r.id AS refundId, r.refund_number AS refundNumber, o.order_number AS orderNumber,
           r.amount AS amount, r.method AS method, r.status AS status, r.reason_code AS reason,
           r.created_at AS requestedAt,
           (SELECT TRIM(CONCAT(au.first_name, ' ', COALESCE(au.last_name, '')))
              FROM users au WHERE au.id = r.approved_by_id) AS approvedBy,
           r.approved_at AS approvedAt, r.completed_at AS completedAt,
           (SELECT cn.invoice_number FROM invoice_records cn
             WHERE cn.refund_id = r.id AND cn.invoice_type = 'CREDIT_NOTE'
             ORDER BY cn.created_at ASC LIMIT 1) AS creditNoteNumber,
           r.tax_amount AS taxReversed
    ${from}`;
  const sla = await refundSlaHours(ctx);
  const [{ rows, totalItems, sums }, byStatus, timing] = await Promise.all([
    pagedQuery(
      ctx.db,
      base,
      Prisma.sql`x.requestedAt DESC, x.refundNumber DESC`,
      ['amount', 'taxReversed'],
      ctx.paging,
    ),
    ctx.db.$queryRaw<Row[]>(
      Prisma.sql`SELECT r.status AS status, COUNT(*) AS count, SUM(r.amount) AS amount ${from} GROUP BY r.status`,
    ),
    ctx.db.$queryRaw<Row[]>(Prisma.sql`
      SELECT AVG(TIMESTAMPDIFF(SECOND, r.created_at, r.approved_at)) / 3600 AS meanApprovalHours,
             AVG(TIMESTAMPDIFF(SECOND, r.created_at, r.completed_at)) / 3600 AS meanCompletionHours,
             SUM(CASE WHEN r.completed_at IS NOT NULL THEN 1 ELSE 0 END) AS completed,
             SUM(CASE WHEN r.completed_at IS NOT NULL
                       AND TIMESTAMPDIFF(SECOND, r.created_at, r.completed_at) <= ${sla * 3600}
                      THEN 1 ELSE 0 END) AS withinSla
      ${from}`),
  ]);
  const t = timing[0] ?? {};
  const hours = (v: unknown): string | null =>
    v === null || v === undefined
      ? null
      : toDec(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  return {
    columns: REFUND_COLUMNS,
    rows: rows.map((r) => {
      const requested = toIso(r.requestedAt);
      const open = OPEN_REFUND.includes(toStr(r.status) ?? '');
      return normalizeRow(REFUND_COLUMNS, {
        ...r,
        ageHours:
          open && requested !== null
            ? new Decimal(ctx.now.getTime() - Date.parse(requested)).div(3_600_000)
            : null,
      });
    }),
    totals: normalizeRow(REFUND_COLUMNS, sums),
    totalItems,
    paginated: true,
    extra: {
      summary: {
        byStatus: byStatus.map((r) => ({
          status: toStr(r.status),
          count: toInt(r.count),
          amount: toDec(r.amount).toFixed(2),
        })),
        meanApprovalHours: hours(t.meanApprovalHours),
        meanCompletionHours: hours(t.meanCompletionHours),
        slaHours: sla,
        completedWithinSlaPercent:
          ratio(toDec(t.withinSla), toDec(t.completed), 100)?.toFixed(2) ?? null,
      },
    },
  };
}

export const PAYMENT_REPORTS: readonly ReportDefinition[] = [
  {
    key: 'payments',
    title: 'Payments',
    version: '1.0',
    domainPermissions: ['payments.view'],
    dateMode: 'required',
    maxRangeDays: 366,
    timeSeries: false,
    customerData: false,
    containsPii: never,
    run: runPayments,
  },
  {
    key: 'refunds',
    title: 'Refunds',
    version: '1.0',
    domainPermissions: ['refunds.view'],
    dateMode: 'required',
    maxRangeDays: 366,
    timeSeries: false,
    customerData: false,
    containsPii: never,
    run: runRefunds,
  },
];
