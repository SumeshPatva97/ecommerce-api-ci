/**
 * Normalization for duplicate prevention — PROJECT_CONTEXT.md §3.5 (canonical). Pure.
 */

/** `lower(collapse_internal_whitespace(trim(NFC(s))))` — "  Gold   Plated  Ring " → "gold plated ring". */
export function normalizeText(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Email: trimmed, NFC, lower-cased (stored in `users.email_normalized`). */
export function normalizeEmail(value: string): string {
  return value.normalize('NFC').trim().toLowerCase();
}

export const SKU_PATTERN = /^[A-Z0-9_-]{1,32}$/;
export const BARCODE_PATTERN = /^[A-Z0-9_-]{1,64}$/;
export const COUPON_PATTERN = /^[A-Z0-9_-]{3,32}$/;

/** SKU/barcode/coupon: `upper(trim(s))`; internal whitespace is rejected by the patterns above. */
export function normalizeCode(value: string): string {
  return value.normalize('NFC').trim().toUpperCase();
}

/** Indian mobile in E.164: `+91` + 10 digits starting 6–9 (AUTHENTICATION_AUTHORIZATION §5). */
export const PHONE_E164_IN = /^\+91[6-9]\d{9}$/;

/** Accepts `98765 43210`, `+91-9876543210`, `09876543210` and returns `+919876543210` or `undefined`. */
export function normalizePhone(value: string): string | undefined {
  const digits = value.replace(/[\s()-]/g, '');
  let candidate = digits;
  if (/^0[6-9]\d{9}$/.test(digits)) candidate = `+91${digits.slice(1)}`;
  else if (/^[6-9]\d{9}$/.test(digits)) candidate = `+91${digits}`;
  else if (/^91[6-9]\d{9}$/.test(digits)) candidate = `+${digits}`;
  return PHONE_E164_IN.test(candidate) ? candidate : undefined;
}
