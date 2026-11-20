/**
 * Export writers (CSV / XLSX / PDF) — REPORTING_AND_ANALYTICS.md §8. Pure: no I/O besides
 * building the file in memory.
 */
import { buildCsv } from './csv.js';
import { buildPdf } from './pdf.js';
import { buildXlsx } from './xlsx.js';
import {
  CONTENT_TYPES,
  type ExportDocument,
  type ExportFormatKey,
  type RenderedExport,
} from './types.js';

export * from './types.js';
export { buildCsv, csvTextCell, csvTypedCell } from './csv.js';
export { buildXlsx, xlsxCell, MONEY_FORMAT } from './xlsx.js';
export { buildPdf, PDF_MAX_ROWS } from './pdf.js';
export { formatIndian, formatIstDateTime, guardText } from './format.js';

export async function renderExport(
  format: ExportFormatKey,
  doc: ExportDocument,
  options: { includeHeader?: boolean } = {},
): Promise<RenderedExport> {
  const body =
    format === 'csv'
      ? buildCsv(doc, options)
      : format === 'xlsx'
        ? await buildXlsx(doc)
        : await buildPdf(doc);
  return { body, contentType: CONTENT_TYPES[format], extension: format };
}
