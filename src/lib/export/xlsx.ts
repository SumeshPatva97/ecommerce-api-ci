/**
 * XLSX writer (exceljs) — REPORTING_AND_ANALYTICS.md §8.2: sheet "Report" with frozen header row
 * and auto-filter; money/numeric cells are real numbers with a 2-dp format; datetimes are true
 * Excel dates shown in IST (header suffix `(IST)`); bold totals row; sheet "Filters & Info" with
 * the header block; extra sections as their own sheets. Text cells get the formula-injection guard.
 *
 * Money format is `#,##0.00` (Western grouping) — Excel number formats cannot express Indian
 * lakh/crore grouping for all magnitudes and signs with one code.
 */
import ExcelJS from 'exceljs';

import { columnHeader, guardText, isNumericString, isNumericType, plainCell } from './format.js';
import type { ExportColumn, ExportDocument, ExportRow, ExportSheet } from './types.js';

const IST_OFFSET_MS = 330 * 60_000;
export const MONEY_FORMAT = '#,##0.00';
const DATE_FORMAT = 'yyyy-mm-dd';
const DATETIME_FORMAT = 'yyyy-mm-dd hh:mm:ss';

type CellValue = string | number | boolean | Date | null;

/** Converts a normalised value into an Excel cell value (+ number format). */
export function xlsxCell(
  column: ExportColumn,
  value: unknown,
): { value: CellValue; numFmt?: string } {
  if (value === null || value === undefined) return { value: null };
  if (isNumericType(column.type)) {
    const text = typeof value === 'number' ? String(value) : plainCell(column, value);
    if (isNumericString(text)) {
      return column.type === 'int'
        ? { value: Number(text), numFmt: '0' }
        : { value: Number(text), numFmt: MONEY_FORMAT };
    }
    return { value: guardText(text) };
  }
  if (column.type === 'datetime' && (typeof value === 'string' || value instanceof Date)) {
    const date = typeof value === 'string' ? new Date(value) : value;
    // Excel has no timezone: write the IST wall-clock time.
    return { value: new Date(date.getTime() + IST_OFFSET_MS), numFmt: DATETIME_FORMAT };
  }
  if (column.type === 'date' && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { value: new Date(`${value}T00:00:00.000Z`), numFmt: DATE_FORMAT };
  }
  if (column.type === 'boolean') return { value: value === true };
  return { value: guardText(plainCell(column, value)) };
}

function sheetName(name: string, used: Set<string>): string {
  const base = name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet';
  let candidate = base;
  let n = 2;
  while (used.has(candidate)) {
    const suffix = ` ${String(n)}`;
    candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    n += 1;
  }
  used.add(candidate);
  return candidate;
}

function writeSheet(workbook: ExcelJS.Workbook, name: string, sheet: ExportSheet): void {
  const ws = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = sheet.columns.map((c) => ({
    header: guardText(columnHeader(c)),
    key: c.key,
    width: Math.min(40, Math.max(12, columnHeader(c).length + 2)),
  }));
  ws.getRow(1).font = { bold: true };
  const addRow = (row: ExportRow, bold: boolean): void => {
    const added = ws.addRow([]);
    sheet.columns.forEach((column, i) => {
      const cell = added.getCell(i + 1);
      const { value, numFmt } = xlsxCell(column, row[column.key]);
      cell.value = value;
      if (numFmt !== undefined) cell.numFmt = numFmt;
    });
    if (bold) added.font = { bold: true };
  };
  for (const row of sheet.rows) addRow(row, false);
  if (sheet.totals !== undefined && sheet.totals !== null) {
    const first = sheet.columns[0];
    const totals: Record<string, unknown> = { ...sheet.totals };
    if (first !== undefined && (totals[first.key] === undefined || totals[first.key] === null)) {
      totals[first.key] = first.type === 'string' || first.type === 'date' ? 'Total' : null;
    }
    addRow(totals, true);
  }
  if (sheet.columns.length > 0) {
    ws.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: sheet.columns.length },
    };
  }
}

export async function buildXlsx(doc: ExportDocument): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.created = doc.generatedAt;
  workbook.creator = 'ecommerce-api';
  const used = new Set<string>();
  writeSheet(workbook, sheetName('Report', used), doc.main);
  for (const sheet of doc.extraSheets ?? [])
    writeSheet(workbook, sheetName(sheet.name, used), sheet);

  const info = workbook.addWorksheet(sheetName('Filters & Info', used));
  info.columns = [
    { header: 'Field', key: 'label', width: 24 },
    { header: 'Value', key: 'value', width: 80 },
  ];
  info.getRow(1).font = { bold: true };
  info.addRow({ label: 'Report', value: guardText(doc.title) });
  for (const [label, value] of doc.headerLines) {
    info.addRow({ label: guardText(label), value: guardText(value) });
  }
  for (const notice of doc.notices ?? []) info.addRow({ label: 'Note', value: guardText(notice) });
  if (doc.footer !== undefined) info.addRow({ label: 'Footer', value: guardText(doc.footer) });

  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}
