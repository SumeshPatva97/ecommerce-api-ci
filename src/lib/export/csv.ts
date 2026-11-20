/**
 * CSV writer — REPORTING_AND_ANALYTICS.md §8.2: UTF-8 with BOM, RFC 4180 quoting, header block as
 * leading `#` comment lines (omitted with `includeHeader=false`), money as plain decimals, datetimes
 * in IST (`(IST)` header suffix), formula-injection guard on every text cell. Same guard as the
 * audit-log export (`src/modules/audit/audit.mapper.ts`).
 */
import { columnHeader, guardText, isNumericString, isNumericType, plainCell } from './format.js';
import type { ExportColumn, ExportDocument, ExportRow, ExportSheet } from './types.js';

const UTF8_BOM = String.fromCharCode(0xfeff);

function quote(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One text cell, guarded and quoted. */
export function csvTextCell(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ''
      : typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
          ? String(value)
          : JSON.stringify(value);
  return quote(guardText(text));
}

/** A typed cell: validated numbers are emitted raw; everything else goes through the guard. */
export function csvTypedCell(column: ExportColumn, value: unknown): string {
  const text = plainCell(column, value);
  if (isNumericType(column.type) && isNumericString(text)) return text;
  return quote(guardText(text));
}

function sheetLines(sheet: ExportSheet): string[] {
  const lines = [sheet.columns.map((c) => csvTextCell(columnHeader(c))).join(',')];
  const renderRow = (row: ExportRow): string =>
    sheet.columns.map((c) => csvTypedCell(c, row[c.key])).join(',');
  for (const row of sheet.rows) lines.push(renderRow(row));
  if (sheet.totals !== undefined && sheet.totals !== null) {
    const first = sheet.columns[0];
    const totals: Record<string, unknown> = { ...sheet.totals };
    if (first !== undefined && (totals[first.key] === undefined || totals[first.key] === null)) {
      totals[first.key] = 'Total';
    }
    lines.push(
      sheet.columns
        .map((c, i) =>
          i === 0 && totals[c.key] === 'Total'
            ? csvTextCell('Total')
            : csvTypedCell(c, totals[c.key]),
        )
        .join(','),
    );
  }
  return lines;
}

export function buildCsv(doc: ExportDocument, options: { includeHeader?: boolean } = {}): Buffer {
  const lines: string[] = [];
  const includeHeader = options.includeHeader ?? true;
  if (includeHeader) {
    lines.push(csvTextCell(`# ${doc.title}`));
    for (const [label, value] of doc.headerLines) lines.push(csvTextCell(`# ${label}: ${value}`));
    for (const notice of doc.notices ?? []) lines.push(csvTextCell(`# Note: ${notice}`));
  }
  lines.push(...sheetLines(doc.main));
  for (const sheet of doc.extraSheets ?? []) {
    lines.push('', csvTextCell(`# ${sheet.name}`), ...sheetLines(sheet));
  }
  if (includeHeader && doc.footer !== undefined) lines.push('', csvTextCell(`# ${doc.footer}`));
  return Buffer.from(`${UTF8_BOM}${lines.join('\r\n')}\r\n`, 'utf8');
}
