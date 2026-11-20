/**
 * Audit redaction & diff — ROLE_PERMISSION_AND_AUDIT_LOGS.md §11, BACKEND_STRUCTURE.md §12.2. Pure.
 *
 * - Denylisted key names (case-insensitive, any depth) are dropped and replaced by
 *   `"***REDACTED***"` so the change is visible without the value.
 * - Phone numbers are masked `+91******3210`.
 * - Address street lines are masked.
 * - Decimal/Date values are serialised to strings.
 */
import { Prisma } from '../generated/prisma/client.js';

const SECRET_KEY =
  /pass(word)?|secret|token|otp|cvv|card|vpa|authorization|cookie|pepper|hash|apikey|api_key|signature|recovery|captcha|ifsc|account_?number/i;
const PHONE_KEY = /phone|mobile/i;
const STREET_KEY = /^(line1|line2|addressLine1|addressLine2|street|landmark)$/i;

export const REDACTED = '***REDACTED***';

export function maskPhone(value: string): string {
  if (value.length <= 4) return '****';
  const tail = value.slice(-4);
  const head = value.startsWith('+91') ? '+91' : '';
  return `${head}${'*'.repeat(Math.max(0, value.length - head.length - 4))}${tail}`;
}

/** `riya@example.com` → `r***@example.com`. */
export function maskEmail(value: string): string {
  const [local = '', domain = ''] = value.split('@');
  if (domain === '') return '***';
  return `${local.slice(0, 1)}***@${domain}`;
}

function toPlain(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  // Prisma Decimal (decimal.js) — serialise as string, never as float.
  if (Prisma.Decimal.isDecimal(value)) return value.toString();
  return value;
}

export function redact(value: unknown, depth = 0): unknown {
  const plain = toPlain(value);
  if (depth > 6 || plain === null || typeof plain !== 'object') return plain;
  if (Array.isArray(plain)) return plain.map((item) => redact(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(plain as Record<string, unknown>)) {
    if (SECRET_KEY.test(key)) {
      out[key] = REDACTED;
    } else if (PHONE_KEY.test(key) && typeof raw === 'string') {
      out[key] = maskPhone(raw);
    } else if (STREET_KEY.test(key) && typeof raw === 'string') {
      out[key] = raw.length > 0 ? '***' : raw;
    } else {
      out[key] = redact(raw, depth + 1);
    }
  }
  return out;
}

export interface DiffResult {
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly changedFields: readonly string[];
}

const DEFAULT_IGNORE = new Set(['updatedAt', 'updatedById', 'createdAt', 'createdById', 'version']);

/**
 * Field-level diff of two flat-ish records. Only changed fields (plus `id`) are kept; values are
 * redacted. `before` null = create; `after` null = delete.
 */
export function computeDiff(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  ignore: ReadonlySet<string> = DEFAULT_IGNORE,
): DiffResult {
  const b = (before === null || before === undefined ? null : redact(before)) as Record<
    string,
    unknown
  > | null;
  const a = (after === null || after === undefined ? null : redact(after)) as Record<
    string,
    unknown
  > | null;
  if (b === null || a === null) {
    return {
      before: b,
      after: a,
      changedFields: Object.keys(b ?? a ?? {}).filter((k) => !ignore.has(k)),
    };
  }
  const changed: string[] = [];
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  for (const key of keys) {
    if (ignore.has(key)) continue;
    if (JSON.stringify(b[key]) !== JSON.stringify(a[key])) changed.push(key);
  }
  const pick = (record: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    if ('id' in record) out.id = record.id;
    for (const key of changed) out[key] = record[key] ?? null;
    return out;
  };
  return { before: pick(b), after: pick(a), changedFields: changed };
}
