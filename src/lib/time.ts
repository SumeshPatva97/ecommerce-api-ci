/**
 * IST business-day and financial-year helpers — PROJECT_CONTEXT.md §1 (Asia/Kolkata business
 * timezone, UTC storage), BACKEND_STRUCTURE.md §10 (FY code: FY 2026-27 → `2627`). Pure.
 *
 * IST has no DST, so a fixed +05:30 offset is exact.
 */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

export interface IstParts {
  readonly year: number;
  readonly month: number; // 1–12
  readonly day: number;
}

export function istParts(date: Date): IstParts {
  const shifted = new Date(date.getTime() + IST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** `YYMMDD` in IST (order/refund/shipment daily sequences). */
export function istDateKey(date: Date): string {
  const { year, month, day } = istParts(date);
  return `${String(year % 100).padStart(2, '0')}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
}

/** Indian FY (April–March, IST). 2026-11-13 → `2627`; 2027-03-31 → `2627`; 2027-04-01 → `2728`. */
export function financialYearCode(date: Date): string {
  const { year, month } = istParts(date);
  const startYear = month >= 4 ? year : year - 1;
  return `${String(startYear % 100).padStart(2, '0')}${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** UTC instant of 00:00 IST on the IST calendar day containing `date`. */
export function startOfIstDay(date: Date): Date {
  const { year, month, day } = istParts(date);
  return new Date(Date.UTC(year, month - 1, day) - IST_OFFSET_MS);
}

/** Parses `YYYY-MM-DD` as an IST calendar day → [start, endExclusive) in UTC. */
export function istDayRange(isoDate: string): { start: Date; end: Date } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (match === null) throw new Error('Expected YYYY-MM-DD.');
  const start = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - IST_OFFSET_MS,
  );
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export function addHours(date: Date, hours: number): Date {
  return addMinutes(date, hours * 60);
}

export function addDays(date: Date, days: number): Date {
  return addMinutes(date, days * 24 * 60);
}
