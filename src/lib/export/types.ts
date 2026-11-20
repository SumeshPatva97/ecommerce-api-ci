/**
 * Tabular export model shared by the CSV / XLSX / PDF writers — REPORTING_AND_ANALYTICS.md §8.
 *
 * Row values are already normalised by the producer:
 * - `money` / `decimal` / `percent` → 2-dp strings (`"4320.00"`, may be negative), or null
 * - `int` → number, `boolean` → boolean
 * - `datetime` → ISO-8601 UTC string (writers render it in IST with a `(IST)` header suffix)
 * - `date` → `YYYY-MM-DD` (IST business day)
 * - `string` → string or null
 */
export type ColumnType =
  'string' | 'int' | 'money' | 'decimal' | 'percent' | 'date' | 'datetime' | 'boolean';

export interface ExportColumn {
  readonly key: string;
  readonly label: string;
  readonly type: ColumnType;
}

export type ExportRow = Readonly<Record<string, unknown>>;

export interface ExportSheet {
  /** Sheet / section name (XLSX sheet name, ≤ 31 chars). */
  readonly name: string;
  readonly columns: readonly ExportColumn[];
  readonly rows: readonly ExportRow[];
  readonly totals?: ExportRow | null;
}

export interface ExportDocument {
  /** e.g. `[BRAND] — Sales summary`. */
  readonly title: string;
  /** Header block (§8.1) as label/value pairs. */
  readonly headerLines: readonly (readonly [label: string, value: string])[];
  readonly main: ExportSheet;
  /** Additional sections (e.g. GST state-wise / document-series summaries). */
  readonly extraSheets?: readonly ExportSheet[];
  readonly notices?: readonly string[];
  /** Mandatory footer text, e.g. the GST "verify before filing" note. */
  readonly footer?: string;
  readonly generatedAt: Date;
}

export type ExportFormatKey = 'csv' | 'xlsx' | 'pdf';

export interface RenderedExport {
  readonly body: Buffer;
  readonly contentType: string;
  readonly extension: ExportFormatKey;
}

export const CONTENT_TYPES: Readonly<Record<ExportFormatKey, string>> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

export const DISPLAY_TIMEZONE = 'Asia/Kolkata';
