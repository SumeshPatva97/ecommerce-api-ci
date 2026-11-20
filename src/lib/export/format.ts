/**
 * Cell formatting helpers shared by the export writers. Pure.
 */
import type { ColumnType, ExportColumn } from './types.js';

const IST_OFFSET_MS = 330 * 60_000;
const NUMERIC = /^-?\d+(\.\d+)?$/;

/** Columns whose values are numbers (never subject to the formula-injection guard). */
export function isNumericType(type: ColumnType): boolean {
  return type === 'int' || type === 'money' || type === 'decimal' || type === 'percent';
}

/**
 * Formula-injection guard (OWASP CSV injection): text beginning with = + - @ TAB or CR is
 * prefixed with `'` so spreadsheet tools never evaluate it.
 */
export function guardText(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

/** `2026-11-19T06:30:00.000Z` → `2026-11-19 12:00:00` (IST, no DST). */
export function formatIstDateTime(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 19);
}

/** Header label; datetime columns carry the timezone (`Placed at (IST)`). */
export function columnHeader(column: ExportColumn): string {
  if (column.type === 'datetime') return `${column.label} (IST)`;
  if (column.type === 'percent') return `${column.label} (%)`;
  return column.label;
}

/** True when a normalised numeric value can be emitted as a number. */
export function isNumericString(value: string): boolean {
  return NUMERIC.test(value);
}

/**
 * Plain-text rendering of a normalised cell (CSV, PDF). Numbers stay plain (`4320.00`); datetimes
 * are shown in IST; booleans as Yes/No; objects as JSON. Text is NOT guarded here.
 */
export function plainCell(column: ExportColumn, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (column.type === 'datetime' && (typeof value === 'string' || value instanceof Date)) {
    return formatIstDateTime(value);
  }
  if (column.type === 'boolean') return value === true ? 'Yes' : 'No';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

/** Indian digit grouping: `432000.00` → `4,32,000.00`; `-1234567.5` → `-12,34,567.5`. */
export function formatIndian(value: string): string {
  if (!isNumericString(value)) return value;
  const negative = value.startsWith('-');
  const [intPart = '', frac] = (negative ? value.slice(1) : value).split('.');
  let grouped = intPart;
  if (intPart.length > 3) {
    const head = intPart.slice(0, -3);
    const tail = intPart.slice(-3);
    grouped = `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${tail}`;
  }
  return `${negative ? '-' : ''}${grouped}${frac === undefined ? '' : `.${frac}`}`;
}
