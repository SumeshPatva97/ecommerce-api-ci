/**
 * PDF writer (PDFKit) — REPORTING_AND_ANALYTICS.md §8.2: A4 landscape for wide reports (> 7
 * columns), portrait otherwise; full header block on page 1 and a compact header on following
 * pages; repeated table header; totals at the end; footer "Page n of N · Generated at …";
 * restrained styling (wine headings, neutral table); Indian digit grouping for amounts.
 *
 * The built-in PDF fonts (WinAnsi) have no ₹ glyph, so amounts are printed without the symbol and
 * the header states "Currency: INR". Row cap: `PDF_MAX_ROWS` (larger → CSV/XLSX).
 */
import PDFDocument from 'pdfkit';

import {
  columnHeader,
  formatIndian,
  formatIstDateTime,
  isNumericType,
  plainCell,
} from './format.js';
import type { ExportColumn, ExportDocument, ExportRow, ExportSheet } from './types.js';

export const PDF_MAX_ROWS = 5_000;

const WINE = '#6d1a36';
const GREY = '#555555';
const LINE = '#cccccc';
const MARGIN = 36;
const ROW_HEIGHT = 14;
const FONT_SIZE = 7;

function cellText(column: ExportColumn, value: unknown): string {
  const text = plainCell(column, value);
  return column.type === 'money' ? formatIndian(text) : text;
}

/** Strips characters outside WinAnsi that the standard fonts cannot draw. */
function printable(text: string): string {
  return Array.from(text)
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 63;
      if (code === 0x2013 || code === 0x2014) return '-';
      if (code === 0x2026) return '...';
      if (code === 0x20b9) return 'Rs.';
      return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) ? ch : '?';
    })
    .join('');
}

export async function buildPdf(doc: ExportDocument): Promise<Buffer> {
  const maxColumns = Math.max(
    doc.main.columns.length,
    ...(doc.extraSheets ?? []).map((s) => s.columns.length),
  );
  const pdf = new PDFDocument({
    size: 'A4',
    layout: maxColumns > 7 ? 'landscape' : 'portrait',
    margins: { top: MARGIN, bottom: MARGIN + 14, left: MARGIN, right: MARGIN },
    bufferPages: true,
    info: { Title: printable(doc.title), Creator: 'ecommerce-api' },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
    pdf.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    pdf.on('error', reject);
  });

  const left = MARGIN;
  const width = (): number => pdf.page.width - 2 * MARGIN;
  const bottom = (): number => pdf.page.height - pdf.page.margins.bottom;

  // Header block (page 1).
  pdf.fillColor(WINE).font('Helvetica-Bold').fontSize(14).text(printable(doc.title), left, MARGIN);
  pdf.moveDown(0.3).font('Helvetica').fontSize(8).fillColor(GREY);
  for (const [label, value] of doc.headerLines) pdf.text(printable(`${label}: ${value}`));
  for (const notice of doc.notices ?? []) pdf.text(printable(`Note: ${notice}`));
  pdf.moveDown(0.5);

  const compactHeader = (): void => {
    pdf
      .fillColor(WINE)
      .font('Helvetica-Bold')
      .fontSize(9)
      .text(printable(`${doc.title} (continued)`), left, MARGIN);
    pdf.moveDown(0.3);
  };

  const drawRow = (
    columns: readonly ExportColumn[],
    cells: readonly string[],
    options: { bold?: boolean; header?: boolean },
  ): void => {
    const colWidth = width() / Math.max(1, columns.length);
    const y = pdf.y;
    if (options.header === true) {
      pdf.rect(left, y - 2, width(), ROW_HEIGHT).fill('#f2ecee');
    }
    pdf
      .font(options.bold === true || options.header === true ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(FONT_SIZE)
      .fillColor('#000000');
    columns.forEach((column, i) => {
      const numeric = isNumericType(column.type);
      pdf.text(printable(cells[i] ?? ''), left + i * colWidth + 2, y, {
        width: colWidth - 4,
        height: ROW_HEIGHT,
        ellipsis: true,
        lineBreak: false,
        align: numeric && options.header !== true ? 'right' : 'left',
      });
    });
    pdf
      .moveTo(left, y + ROW_HEIGHT - 3)
      .lineTo(left + width(), y + ROW_HEIGHT - 3)
      .strokeColor(LINE)
      .lineWidth(0.5)
      .stroke();
    pdf.x = left;
    pdf.y = y + ROW_HEIGHT;
  };

  const drawSheet = (sheet: ExportSheet, title?: string): void => {
    const headerCells = sheet.columns.map((c) => columnHeader(c));
    if (title !== undefined) {
      if (pdf.y + 3 * ROW_HEIGHT > bottom()) {
        pdf.addPage();
        compactHeader();
      }
      pdf
        .moveDown(0.5)
        .fillColor(WINE)
        .font('Helvetica-Bold')
        .fontSize(10)
        .text(printable(title), left);
      pdf.moveDown(0.2);
    }
    drawRow(sheet.columns, headerCells, { header: true });
    const rows: { row: ExportRow; bold: boolean }[] = sheet.rows
      .slice(0, PDF_MAX_ROWS)
      .map((row) => ({ row, bold: false }));
    if (sheet.totals !== undefined && sheet.totals !== null) {
      const first = sheet.columns[0];
      const totals: Record<string, unknown> = { ...sheet.totals };
      if (first !== undefined && (totals[first.key] === undefined || totals[first.key] === null)) {
        totals[first.key] = 'Total';
      }
      rows.push({ row: totals, bold: true });
    }
    for (const { row, bold } of rows) {
      if (pdf.y + ROW_HEIGHT > bottom()) {
        pdf.addPage();
        compactHeader();
        drawRow(sheet.columns, headerCells, { header: true });
      }
      drawRow(
        sheet.columns,
        sheet.columns.map((c, i) =>
          bold && i === 0 && row[c.key] === 'Total' ? 'Total' : cellText(c, row[c.key]),
        ),
        { bold },
      );
    }
  };

  drawSheet(doc.main);
  for (const sheet of doc.extraSheets ?? []) drawSheet(sheet, sheet.name);
  if (doc.footer !== undefined) {
    pdf.moveDown(1).font('Helvetica-Oblique').fontSize(8).fillColor(GREY);
    pdf.text(printable(doc.footer), left);
  }

  // Footer on every page: "Page n of N · Generated at …".
  const range = pdf.bufferedPageRange();
  const generated = `Generated at ${formatIstDateTime(doc.generatedAt)} IST`;
  for (let i = range.start; i < range.start + range.count; i += 1) {
    pdf.switchToPage(i);
    const savedBottom = pdf.page.margins.bottom;
    pdf.page.margins.bottom = 0;
    pdf
      .font('Helvetica')
      .fontSize(7)
      .fillColor(GREY)
      .text(
        `Page ${String(i - range.start + 1)} of ${String(range.count)} - ${generated}`,
        left,
        pdf.page.height - MARGIN,
        { width: width(), align: 'center', lineBreak: false },
      );
    pdf.page.margins.bottom = savedBottom;
  }
  pdf.end();
  return done;
}
