/**
 * Pure tax engine (no DB). Golden values from API_DOCUMENTATION.md §3.9 (checkout summary) and
 * TAX_AND_GST_WORKFLOWS.md §12–§14. All rates are illustrative.
 */
import { describe, expect, it } from 'vitest';

import {
  TaxEngineError,
  allocateProRata,
  componentPair,
  computeRowTax,
  computeTax,
  determineSupplyType,
  toTaxResultDto,
  type TaxInput,
} from '../../../../src/lib/tax/index.js';

const NOW = new Date('2026-11-13T09:45:12.345Z');

function input(overrides: Partial<TaxInput> = {}): TaxInput {
  return {
    lines: [],
    pricesIncludeTax: true,
    seller: { stateCode: '27' },
    placeOfSupply: { stateCode: '27', isUnionTerritoryWithoutLegislature: false },
    rounding: { mode: 'PER_LINE_HALF_UP', invoiceRoundOffToRupee: true },
    now: NOW,
    ...overrides,
  };
}

const s = (d: { toFixed(n: number): string }): string => d.toFixed(2);

function nth<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) throw new Error(`missing index ${String(index)}`);
  return value;
}

describe('computeTax — API_DOCUMENTATION §3.9 checkout example (intra-state, inclusive)', () => {
  const result = computeTax(
    input({
      lines: [
        { lineId: 'ci-1', hsnCode: '7117', ratePercent: '3.00', netLineValue: '2479.26' },
        { lineId: 'ci-2', hsnCode: '7113', ratePercent: '3', netLineValue: '917.94' },
      ],
      shipping: { netCharge: '99.00', treatment: 'PROPORTIONAL' },
    }),
  );

  it('computes line taxes with the odd paisa on CGST', () => {
    expect(result.supplyType).toBe('INTRA_STATE');
    expect(s(nth(result.lines, 0).taxableValue)).toBe('2407.05');
    expect(s(nth(result.lines, 0).taxAmount)).toBe('72.21');
    expect(
      nth(result.lines, 0).components.map((c) => [c.component, s(c.ratePercent), s(c.amount)]),
    ).toEqual([
      ['CGST', '1.50', '36.11'],
      ['SGST', '1.50', '36.10'],
    ]);
    expect(s(nth(result.lines, 0).total)).toBe('2479.26');
    expect(s(nth(result.lines, 1).taxableValue)).toBe('891.20');
    expect(nth(result.lines, 1).components.map((c) => s(c.amount))).toEqual(['13.37', '13.37']);
  });

  it('taxes shipping proportionally', () => {
    expect(s(result.shipping.taxableValue)).toBe('96.12');
    expect(s(result.shipping.taxAmount)).toBe('2.88');
    expect(result.shipping.components.map((c) => [c.component, s(c.amount)])).toEqual([
      ['CGST', '1.44'],
      ['SGST', '1.44'],
    ]);
    expect(result.shipping.allocations.map((a) => s(a.share))).toEqual(['72.25', '26.75']);
  });

  it('matches the documented totals and round-off', () => {
    const dto = toTaxResultDto(result);
    expect(dto.totals).toEqual({
      taxableTotal: '3394.37',
      cgstTotal: '50.92',
      sgstTotal: '50.91',
      utgstTotal: '0.00',
      igstTotal: '0.00',
      taxTotal: '101.83',
      totalBeforeRoundOff: '3496.20',
      roundOff: '-0.20',
      grandTotal: '3496.00',
    });
    expect(dto.computedAt).toBe(NOW.toISOString());
    expect((dto.lines as { tax: { ratePercent: string } }[])[0]?.tax.ratePercent).toBe('3.00');
  });

  it('inter-state variant moves everything to IGST with unchanged totals', () => {
    const inter = computeTax(
      input({
        lines: [
          { lineId: 'ci-1', hsnCode: '7117', ratePercent: '3', netLineValue: '2479.26' },
          { lineId: 'ci-2', hsnCode: '7113', ratePercent: '3', netLineValue: '917.94' },
        ],
        shipping: { netCharge: '99.00', treatment: 'PROPORTIONAL' },
        placeOfSupply: { stateCode: '29', isUnionTerritoryWithoutLegislature: false },
      }),
    );
    expect(inter.supplyType).toBe('INTER_STATE');
    expect(inter.lines.map((l) => l.components.map((c) => [c.component, s(c.amount)]))).toEqual([
      [['IGST', '72.21']],
      [['IGST', '26.74']],
    ]);
    expect(s(inter.shipping.taxAmount)).toBe('2.88');
    expect(s(inter.totals.igstTotal)).toBe('101.83');
    expect(s(inter.totals.cgstTotal)).toBe('0.00');
    expect(s(inter.totals.grandTotal)).toBe('3496.00');
  });
});

describe('computeTax — TAX_AND_GST_WORKFLOWS worked examples', () => {
  const lines = [
    { lineId: 'L1', hsnCode: '7113', ratePercent: '3', netLineValue: '1966.79' },
    { lineId: 'L2', hsnCode: '9999', ratePercent: '18', netLineValue: '2253.21' },
  ];

  it('example B (inter-state) matches exactly', () => {
    const r = computeTax(
      input({
        lines,
        shipping: { netCharge: '100', treatment: 'PROPORTIONAL' },
        placeOfSupply: { stateCode: '29', isUnionTerritoryWithoutLegislature: false },
      }),
    );
    expect(r.lines.map((l) => s(l.taxAmount))).toEqual(['57.29', '343.71']);
    expect(r.lines.map((l) => s(l.taxableValue))).toEqual(['1909.50', '1909.50']);
    expect(r.shipping.allocations.map((a) => [s(a.share), s(a.taxAmount)])).toEqual([
      ['46.61', '1.36'],
      ['53.39', '8.14'],
    ]);
    expect(s(r.totals.taxableTotal)).toBe('3909.50');
    expect(s(r.totals.igstTotal)).toBe('410.50');
    expect(s(r.totals.roundOff)).toBe('0.00');
    expect(s(r.totals.grandTotal)).toBe('4320.00');
  });

  it('example A (intra-state) keeps the documented taxable/tax/grand totals (tax-first split)', () => {
    const r = computeTax(
      input({ lines, shipping: { netCharge: '100', treatment: 'PROPORTIONAL' } }),
    );
    expect(s(r.totals.taxableTotal)).toBe('3909.50');
    expect(s(r.totals.taxTotal)).toBe('410.50');
    expect(s(r.totals.grandTotal)).toBe('4320.00');
    // Odd paisa to CGST (BACKEND_STRUCTURE §9) — differs from the workflow's component-first table.
    expect(s(r.totals.cgstTotal)).toBe('205.26');
    expect(s(r.totals.sgstTotal)).toBe('205.24');
    expect(r.totals.cgstTotal.plus(r.totals.sgstTotal).equals(r.totals.taxTotal)).toBe(true);
  });

  it('example C (exclusive) adds tax on top and rounds the invoice to ₹1', () => {
    const r = computeTax(
      input({
        pricesIncludeTax: false,
        lines: [
          { lineId: 'L1', hsnCode: '7113', ratePercent: '3', netLineValue: '999.00' },
          { lineId: 'L2', hsnCode: '9999', ratePercent: '18', netLineValue: '425.50' },
        ],
      }),
    );
    expect(r.lines.map((l) => s(l.taxableValue))).toEqual(['999.00', '425.50']);
    expect(r.lines.map((l) => s(l.taxAmount))).toEqual(['29.97', '76.59']);
    expect(r.lines.map((l) => s(l.total))).toEqual(['1028.97', '502.09']);
    expect(s(r.totals.totalBeforeRoundOff)).toBe('1531.06');
    expect(s(r.totals.roundOff)).toBe('-0.06');
    expect(s(r.totals.grandTotal)).toBe('1531.00');
    expect(s(r.shipping.total)).toBe('0.00');
    expect(r.shipping.components).toEqual([]);
  });
});

describe('computeTax — components, shipping treatments and options', () => {
  it('uses CGST + UTGST in a Union Territory without legislature', () => {
    const r = computeTax(
      input({
        seller: { stateCode: '04' },
        placeOfSupply: { stateCode: '04', isUnionTerritoryWithoutLegislature: true },
        lines: [{ lineId: 'a', hsnCode: null, ratePercent: '3', netLineValue: '1030' }],
      }),
    );
    expect(r.componentPair).toEqual(['CGST', 'UTGST']);
    expect(r.lines[0]?.components.map((c) => [c.component, s(c.amount)])).toEqual([
      ['CGST', '15.00'],
      ['UTGST', '15.00'],
    ]);
    expect(s(r.totals.utgstTotal)).toBe('15.00');
    expect(s(r.totals.sgstTotal)).toBe('0.00');
  });

  it('half-up rounds a component at exactly 0.005', () => {
    // 2253.21 × 9 / 118 = 171.855 → 171.86 (workflow §11 illustration) via exclusive check.
    const row = computeRowTax('100.50', '1', false, ['IGST']);
    expect(s(row.taxAmount)).toBe('1.01'); // 1.005 → 1.01
  });

  it('handles zero-rated lines and zero-value lines', () => {
    const r = computeTax(
      input({
        lines: [
          { lineId: 'z', hsnCode: '7117', ratePercent: '0', netLineValue: '500' },
          { lineId: 'free', hsnCode: '7117', ratePercent: '3', netLineValue: '0' },
        ],
      }),
    );
    expect(s(nth(r.lines, 0).taxAmount)).toBe('0.00');
    expect(s(nth(r.lines, 0).taxableValue)).toBe('500.00');
    expect(nth(r.lines, 0).components).toHaveLength(2);
    expect(s(nth(r.lines, 1).total)).toBe('0.00');
  });

  it('FIXED_RATE taxes the whole shipping at the configured rate', () => {
    const r = computeTax(
      input({
        lines: [{ lineId: 'a', hsnCode: '7117', ratePercent: '3', netLineValue: '1000' }],
        shipping: { netCharge: '118', treatment: 'FIXED_RATE', fixedRatePercent: '18' },
      }),
    );
    expect(r.shipping.allocations).toHaveLength(1);
    expect(r.shipping.allocations[0]?.lineId).toBeNull();
    expect(s(r.shipping.taxAmount)).toBe('18.00');
    expect(s(r.shipping.taxableValue)).toBe('100.00');
    expect(r.shipping.components.map((c) => s(c.amount))).toEqual(['9.00', '9.00']);
  });

  it('EXEMPT shipping adds the charge without tax', () => {
    const r = computeTax(
      input({
        lines: [{ lineId: 'a', hsnCode: '7117', ratePercent: '3', netLineValue: '1030' }],
        shipping: { netCharge: '50', treatment: 'EXEMPT' },
      }),
    );
    expect(s(r.shipping.taxAmount)).toBe('0.00');
    expect(s(r.shipping.total)).toBe('50.00');
    expect(r.shipping.components).toEqual([]);
    expect(s(r.totals.grandTotal)).toBe('1080.00');
    expect(s(r.totals.taxableTotal)).toBe('1050.00');
  });

  it('zero / absent shipping produces no allocation rows', () => {
    const r = computeTax(
      input({
        lines: [{ lineId: 'a', hsnCode: null, ratePercent: '3', netLineValue: '10' }],
        shipping: { netCharge: '0', treatment: 'PROPORTIONAL' },
      }),
    );
    expect(r.shipping.allocations).toEqual([]);
    expect(r.shipping.treatment).toBe('PROPORTIONAL');
  });

  it('can skip invoice round-off', () => {
    const r = computeTax(
      input({
        rounding: { mode: 'PER_LINE_HALF_UP', invoiceRoundOffToRupee: false },
        lines: [{ lineId: 'a', hsnCode: null, ratePercent: '3', netLineValue: '10.40' }],
      }),
    );
    expect(s(r.totals.roundOff)).toBe('0.00');
    expect(s(r.totals.grandTotal)).toBe('10.40');
  });

  it('rounds the grand total half-up to the rupee', () => {
    const r = computeTax(
      input({ lines: [{ lineId: 'a', hsnCode: null, ratePercent: '3', netLineValue: '10.50' }] }),
    );
    expect(s(r.totals.grandTotal)).toBe('11.00');
    expect(s(r.totals.roundOff)).toBe('0.50');
  });

  it('exposes supply-type helpers', () => {
    expect(determineSupplyType('27', '27')).toBe('INTRA_STATE');
    expect(determineSupplyType('27', '04')).toBe('INTER_STATE');
    expect(componentPair('INTER_STATE', true)).toEqual(['IGST']);
    expect(componentPair('INTRA_STATE', false)).toEqual(['CGST', 'SGST']);
  });
});

describe('computeTax — invalid input fails closed', () => {
  const line = { lineId: 'a', hsnCode: null, ratePercent: '3', netLineValue: '10' };
  const cases: [string, Partial<TaxInput>, string][] = [
    ['rate > 100', { lines: [{ ...line, ratePercent: '101' }] }, 'INVALID_RATE'],
    ['negative rate', { lines: [{ ...line, ratePercent: '-1' }] }, 'INVALID_RATE'],
    ['negative value', { lines: [{ ...line, netLineValue: '-0.01' }] }, 'NEGATIVE_AMOUNT'],
    ['duplicate line', { lines: [line, line] }, 'DUPLICATE_LINE'],
    ['bad seller state', { lines: [line], seller: { stateCode: 'MH' } }, 'INVALID_STATE_CODE'],
    [
      'bad pos state',
      {
        lines: [line],
        placeOfSupply: { stateCode: '7', isUnionTerritoryWithoutLegislature: false },
      },
      'INVALID_STATE_CODE',
    ],
    [
      'negative shipping',
      { lines: [line], shipping: { netCharge: '-1', treatment: 'PROPORTIONAL' } },
      'NEGATIVE_AMOUNT',
    ],
    [
      'missing fixed rate',
      { lines: [line], shipping: { netCharge: '10', treatment: 'FIXED_RATE' } },
      'MISSING_FIXED_RATE',
    ],
    [
      'invalid fixed rate',
      {
        lines: [line],
        shipping: { netCharge: '10', treatment: 'FIXED_RATE', fixedRatePercent: '200' },
      },
      'INVALID_RATE',
    ],
    [
      'proportional without lines',
      { lines: [], shipping: { netCharge: '10', treatment: 'PROPORTIONAL' } },
      'NO_LINES_FOR_PROPORTIONAL_SHIPPING',
    ],
  ];
  it.each(cases)('%s', (_name, overrides, code) => {
    let caught: unknown;
    try {
      computeTax(input(overrides));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TaxEngineError);
    expect((caught as TaxEngineError).code).toBe(code);
  });
});

describe('allocateProRata', () => {
  it('rounds half-up and puts the remainder on the last line', () => {
    expect(allocateProRata('100', ['1966.79', '2253.21']).map(s)).toEqual(['46.61', '53.39']);
  });

  it('returns [] for no weights and puts everything on the last line for zero weights', () => {
    expect(allocateProRata('10', [])).toEqual([]);
    expect(allocateProRata('10', ['0', '0']).map(s)).toEqual(['0.00', '10.00']);
  });

  it('never produces a negative last share (cascades the deficit)', () => {
    const shares = allocateProRata('0.01', ['1', '1', '0']);
    expect(shares.map(s)).toEqual(['0.00', '0.01', '0.00']);
    expect(shares.every((x) => !x.isNegative())).toBe(true);
  });

  it('cascades across several earlier shares when needed', () => {
    const shares = allocateProRata('0.02', ['1', '1', '1', '0']);
    // each 0.02/3 = 0.00667 → 0.01; Σ first three = 0.03 → last −0.01 → cascade
    expect(shares.reduce((a, b) => a.plus(b)).toFixed(2)).toBe('0.02');
    expect(shares.every((x) => !x.isNegative())).toBe(true);
  });
});
