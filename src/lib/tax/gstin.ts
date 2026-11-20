/**
 * GSTIN validation — TAX_AND_GST_WORKFLOWS.md §23.1 (format + mod-36 checksum; verify against
 * GSTN documentation). Pure.
 */
export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Check character for the first 14 characters of a GSTIN. */
export function gstinCheckChar(first14: string): string {
  let total = 0;
  for (let i = 0; i < 14; i += 1) {
    const value = CHARS.indexOf(first14.charAt(i));
    const product = value * (i % 2 === 0 ? 1 : 2);
    total += Math.floor(product / 36) + (product % 36);
  }
  return CHARS.charAt((36 - (total % 36)) % 36);
}

export function isValidGstin(value: string): boolean {
  if (!GSTIN_PATTERN.test(value)) return false;
  return value.charAt(14) === gstinCheckChar(value.slice(0, 14));
}

export function gstinStateCode(gstin: string): string {
  return gstin.slice(0, 2);
}
