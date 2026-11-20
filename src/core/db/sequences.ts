/**
 * Business number sequences — BACKEND_STRUCTURE.md §10, PROJECT_CONTEXT §3.2 (OQ-26/OQ-41
 * working assumptions, PROVISIONAL per decision 2026-11-19).
 *
 * | Kind        | Format            | Period   | Gap-free |
 * | ORDER       | ORD-YYMMDD-NNNNN  | IST day  | no  |
 * | INVOICE     | INV/2627/000001   | FY (IST) | yes |
 * | CREDIT_NOTE | CN/2627/000001    | FY (IST) | yes |
 * | REFUND      | RFD-YYMMDD-NNNNN  | IST day  | no  |
 * | SHIPMENT    | SHP-YYMMDD-NNNNN  | IST day  | no  |
 *
 * Must be called inside the transaction that inserts the numbered row (row lock `FOR UPDATE`),
 * which makes invoice/credit-note numbering gap-free.
 */
import type { TxClient } from './transaction.js';
import { financialYearCode, istDateKey } from '../../lib/time.js';
import { isPrismaKnownError } from '../errors/prismaErrorMapper.js';

export type SequenceKind = 'ORDER' | 'INVOICE' | 'CREDIT_NOTE' | 'REFUND' | 'SHIPMENT';

interface SequenceSpec {
  readonly prefix: string;
  readonly padding: number;
  readonly period: 'day' | 'fy';
  readonly gapFree: boolean;
  readonly format: (prefix: string, period: string, n: string) => string;
}

export const SEQUENCE_SPECS: Readonly<Record<SequenceKind, SequenceSpec>> = {
  ORDER: {
    prefix: 'ORD',
    padding: 5,
    period: 'day',
    gapFree: false,
    format: (p, d, n) => `${p}-${d}-${n}`,
  },
  REFUND: {
    prefix: 'RFD',
    padding: 5,
    period: 'day',
    gapFree: false,
    format: (p, d, n) => `${p}-${d}-${n}`,
  },
  SHIPMENT: {
    prefix: 'SHP',
    padding: 5,
    period: 'day',
    gapFree: false,
    format: (p, d, n) => `${p}-${d}-${n}`,
  },
  INVOICE: {
    prefix: 'INV',
    padding: 6,
    period: 'fy',
    gapFree: true,
    format: (p, fy, n) => `${p}/${fy}/${n}`,
  },
  CREDIT_NOTE: {
    prefix: 'CN',
    padding: 6,
    period: 'fy',
    gapFree: true,
    format: (p, fy, n) => `${p}/${fy}/${n}`,
  },
};

export function periodKeyFor(kind: SequenceKind, now: Date): string {
  return SEQUENCE_SPECS[kind].period === 'fy' ? financialYearCode(now) : istDateKey(now);
}

export function formatSequence(kind: SequenceKind, periodKey: string, value: number): string {
  const spec = SEQUENCE_SPECS[kind];
  return spec.format(spec.prefix, periodKey, String(value).padStart(spec.padding, '0'));
}

export async function allocateNumber(tx: TxClient, kind: SequenceKind, now: Date): Promise<string> {
  const spec = SEQUENCE_SPECS[kind];
  const periodKey = periodKeyFor(kind, now);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const rows = await tx.$queryRaw<{ next_value: number | bigint }[]>`
      SELECT next_value FROM number_sequences
      WHERE sequence_key = ${kind} AND period_key = ${periodKey}
      FOR UPDATE`;
    const current = rows[0];
    if (current !== undefined) {
      const value = Number(current.next_value);
      await tx.numberSequence.update({
        where: { sequenceKey_periodKey: { sequenceKey: kind, periodKey } },
        data: { nextValue: value + 1 },
      });
      return formatSequence(kind, periodKey, value);
    }
    try {
      await tx.numberSequence.create({
        data: {
          sequenceKey: kind,
          periodKey,
          prefix: spec.prefix,
          nextValue: 2,
          padding: spec.padding,
          isGapFree: spec.gapFree,
        },
      });
      return formatSequence(kind, periodKey, 1);
    } catch (error) {
      // Another transaction created the period row first — loop and lock it.
      if (!(isPrismaKnownError(error) && error.code === 'P2002')) throw error;
    }
  }
  throw new Error(`Could not allocate ${kind} number.`);
}
