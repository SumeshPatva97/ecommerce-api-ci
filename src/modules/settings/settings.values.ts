/**
 * Setting value validation and presentation — pure.
 *
 * Each value is checked against the row's `value_type` and, for known keys, a stricter rule
 * (DATABASE_DESIGN.md §25.5 defaults). Secrets are never stored in settings (§13.11); values whose
 * key looks secret are nevertheless masked by the shared redaction rules on output and in audit.
 */
import { z } from 'zod';

import type { ValueType } from '../../generated/prisma/enums.js';
import { PHONE_E164_IN } from '../../lib/normalize.js';
import { REDACTED, redact } from '../../lib/redact.js';

const MONEY = /^\d{1,10}\.\d{2}$/;

const int = (min: number, max: number): z.ZodType => z.number().int().min(min).max(max);
const blankOr = (schema: z.ZodType): z.ZodType => z.union([z.literal(''), schema]);

/** Stricter rules for known keys (others are validated by `value_type` only). */
export const KNOWN_SETTING_RULES: Readonly<Record<string, z.ZodType>> = {
  'store.name': z.string().trim().min(1).max(120),
  'store.legal_name': z.string().max(200),
  // Seller GST registration is NOT a store setting: the canonical keys are tax.seller_gstin /
  // tax.seller_state_code, edited only via PATCH /admin/tax/settings (tax.update + re-auth) — D-57.
  'store.support_email': blankOr(z.email()),
  'store.support_phone': blankOr(
    z.string().regex(PHONE_E164_IN, { message: 'Use +91XXXXXXXXXX.' }),
  ),
  'checkout.reservation_ttl_minutes': int(5, 120),
  'checkout.max_qty_per_line': int(1, 99),
  'cart.abandon_after_days': int(1, 365), // RD-08

  'customer.max_addresses_per_customer': int(1, 100),
  'shipping.free_shipping_threshold': z
    .string()
    .regex(MONEY, { message: 'Use a decimal string, e.g. "999.00".' }),
  'inventory.low_stock_threshold_default': int(0, 100_000),
  'catalog.page_size_default': int(1, 100),
  'catalog.new_arrival_days': int(1, 365),
  'catalog.best_seller_window_days': int(1, 730),
  'recently_viewed.max_items': int(1, 100),
  'reviews.moderation_mode': z.enum(['PRE', 'POST']),
  'reports.sync_export_max_rows': int(1, 100_000),
  'security.staff_reauth_window_minutes': int(1, 60),
  'audit.retention_years': int(1, 50),
};

const BY_TYPE: Readonly<Record<ValueType, z.ZodType>> = {
  STRING: z.string().max(2000),
  NUMBER: z.number().refine(Number.isFinite, { message: 'Must be a finite number.' }),
  BOOLEAN: z.boolean(),
  JSON: z.union([z.record(z.string(), z.json()), z.array(z.json())]),
};

/** Returns an error message, or `undefined` when the value is acceptable. */
export function validateSettingValue(
  key: string,
  valueType: ValueType,
  value: unknown,
): string | undefined {
  const typed = BY_TYPE[valueType].safeParse(value);
  if (!typed.success) return `Expected a ${valueType.toLowerCase()} value.`;
  const rule = KNOWN_SETTING_RULES[key];
  if (rule === undefined) return undefined;
  const checked = rule.safeParse(value);
  return checked.success ? undefined : (checked.error.issues[0]?.message ?? 'Invalid value.');
}

/** Masks a value when its key matches the shared secret denylist (defence in depth). */
export function presentValue(key: string, value: unknown): unknown {
  const leaf = key.split('.').pop() ?? key;
  const masked = redact({ [leaf]: value }) as Record<string, unknown>;
  // Only secret-looking keys are masked here (phone/address masking is for audit rows).
  return masked[leaf] === REDACTED ? REDACTED : value;
}

/** `checkout.max_qty_per_line` in group `checkout` → `maxQtyPerLine`. */
export function publicFieldName(key: string, groupKey: string): string {
  const rest = key.startsWith(`${groupKey}.`) ? key.slice(groupKey.length + 1) : key;
  return rest.replace(/[._]([a-z0-9])/g, (_m, ch: string) => ch.toUpperCase());
}
