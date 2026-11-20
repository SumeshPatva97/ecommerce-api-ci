/**
 * Table-driven GST catalogue — TESTING_STRATEGY.md §6.2 "Tax engine — table-driven GST cases"
 * (GST-01 … GST-17). Seller state for the table: Maharashtra (27). All rates are illustrative —
 * verify with a qualified Indian tax professional. Rounding per OQ-23 working assumption (per-line
 * half-up ₹0.01; invoice round-off to ₹1 separate). The CGST/SGST odd-paisa rule is PROVISIONAL
 * (docs/PHASE4-REMAINING-DECISIONS.md RD-01).
 *
 * Pure: no DB, no clock, no network.
 */
import { describe, expect, it } from 'vitest';

import { dec, sum } from '../../../../src/lib/money.js';
import {
  computeTax,
  selectAssignment,
  type AssignmentCandidate,
  type TaxInput,
} from '../../../../src/lib/tax/index.js';
import {
  ledgerRows,
  prorateGroup,
  remainingGroups,
  type LedgerGroup,
} from '../../../../src/modules/invoices/invoices.ledger.js';

const NOW = new Date('2026-11-13T09:45:12.345Z');
const SELLER_MH = '27';

const s = (d: { toFixed(n: number): string }): string => d.toFixed(2);

function nth<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) throw new Error(`missing index ${String(index)}`);
  return value;
}

function input(overrides: Partial<TaxInput> = {}): TaxInput {
  return {
    lines: [],
    pricesIncludeTax: true,
    seller: { stateCode: SELLER_MH },
    placeOfSupply: { stateCode: SELLER_MH, isUnionTerritoryWithoutLegislature: false },
    rounding: { mode: 'PER_LINE_HALF_UP', invoiceRoundOffToRupee: true },
    now: NOW,
    ...overrides,
  };
}

interface SingleLineCase {
  readonly id: string;
  readonly title: string;
  readonly inclusive: boolean;
  readonly seller: string;
  readonly pos: string;
  readonly utWithoutLegislature: boolean;
  readonly rate: string;
  /** Net line value `N` passed to the engine (after any coupon allocation). */
  readonly net: string;
  readonly taxable: string;
  readonly components: readonly (readonly [string, string])[];
  readonly lineTotal: string;
}

const SINGLE_LINE_CASES: readonly SingleLineCase[] = [
  {
    id: 'GST-01',
    title: 'inclusive, intra-state 27 → 27, 3% on ₹1,030.00',
    inclusive: true,
    seller: SELLER_MH,
    pos: '27',
    utWithoutLegislature: false,
    rate: '3',
    net: '1030.00',
    taxable: '1000.00',
    components: [
      ['CGST', '15.00'],
      ['SGST', '15.00'],
    ],
    lineTotal: '1030.00',
  },
  {
    id: 'GST-02',
    title: 'inclusive, inter-state 27 → 29 Karnataka, 3% on ₹1,030.00',
    inclusive: true,
    seller: SELLER_MH,
    pos: '29',
    utWithoutLegislature: false,
    rate: '3',
    net: '1030.00',
    taxable: '1000.00',
    components: [['IGST', '30.00']],
    lineTotal: '1030.00',
  },
  {
    id: 'GST-03',
    title: 'exclusive, intra-state 27 → 27, 3% on ₹1,000.00',
    inclusive: false,
    seller: SELLER_MH,
    pos: '27',
    utWithoutLegislature: false,
    rate: '3',
    net: '1000.00',
    taxable: '1000.00',
    components: [
      ['CGST', '15.00'],
      ['SGST', '15.00'],
    ],
    lineTotal: '1030.00',
  },
  {
    id: 'GST-04',
    title: 'exclusive, inter-state 27 → 07 Delhi, 3% on ₹1,000.00',
    inclusive: false,
    seller: SELLER_MH,
    pos: '07',
    utWithoutLegislature: false,
    rate: '3',
    net: '1000.00',
    taxable: '1000.00',
    components: [['IGST', '30.00']],
    lineTotal: '1030.00',
  },
  {
    id: 'GST-05',
    title: 'inclusive, seller and buyer in 04 Chandigarh (UT without legislature), 3% on ₹1,030.00',
    inclusive: true,
    seller: '04',
    pos: '04',
    utWithoutLegislature: true,
    rate: '3',
    net: '1030.00',
    taxable: '1000.00',
    components: [
      ['CGST', '15.00'],
      ['UTGST', '15.00'],
    ],
    lineTotal: '1030.00',
  },
  {
    id: 'GST-06',
    title: 'inclusive, seller 04 Chandigarh → buyer 27, 3% on ₹1,030.00',
    inclusive: true,
    seller: '04',
    pos: '27',
    utWithoutLegislature: false,
    rate: '3',
    net: '1030.00',
    taxable: '1000.00',
    components: [['IGST', '30.00']],
    lineTotal: '1030.00',
  },
  {
    // 999 × 3 / 103 = 29.097… → tax 29.10; taxable = 999 − 29.10 = 969.90 (table: 999/1.03 →
    // 969.90). Even tax → equal halves. Σ = 999.00 exactly.
    id: 'GST-07',
    title: 'inclusive rounding, intra-state, 3% on ₹999.00',
    inclusive: true,
    seller: SELLER_MH,
    pos: '27',
    utWithoutLegislature: false,
    rate: '3',
    net: '999.00',
    taxable: '969.90',
    components: [
      ['CGST', '14.55'],
      ['SGST', '14.55'],
    ],
    lineTotal: '999.00',
  },
  {
    // Interpretation: the table lists "CGST ₹0.01 + SGST ₹0.02 (or documented split rule) — Σ
    // exact". The documented split rule (engine header, BACKEND_STRUCTURE §9 / API_DOCUMENTATION
    // §3.9 worked example 72.21 → 36.11 + 36.10, RD-01 PROVISIONAL) puts the odd paisa on CGST,
    // so the asserted split is CGST 0.02 + SGST 0.01. Taxable 0.97 and Σ = 1.00 are as tabled.
    id: 'GST-08',
    title: 'inclusive odd-paise split, intra-state, 3% on ₹1.00 (odd paisa → CGST per RD-01)',
    inclusive: true,
    seller: SELLER_MH,
    pos: '27',
    utWithoutLegislature: false,
    rate: '3',
    net: '1.00',
    taxable: '0.97',
    components: [
      ['CGST', '0.02'],
      ['SGST', '0.01'],
    ],
    lineTotal: '1.00',
  },
  {
    // Coupon is a pre-tax reduction of the inclusive price: N = 1030.00 − 103.00 = 927.00.
    id: 'GST-09',
    title: 'inclusive with ₹103.00 coupon, intra-state, 3% on ₹1,030.00',
    inclusive: true,
    seller: SELLER_MH,
    pos: '27',
    utWithoutLegislature: false,
    rate: '3',
    net: s(dec('1030.00').minus('103.00')),
    taxable: '900.00',
    components: [
      ['CGST', '13.50'],
      ['SGST', '13.50'],
    ],
    lineTotal: '927.00',
  },
];

describe('GST catalogue — TESTING_STRATEGY §6.2 single-line cases', () => {
  it.each(SINGLE_LINE_CASES)('$id $title', (c) => {
    const result = computeTax(
      input({
        pricesIncludeTax: c.inclusive,
        seller: { stateCode: c.seller },
        placeOfSupply: {
          stateCode: c.pos,
          isUnionTerritoryWithoutLegislature: c.utWithoutLegislature,
        },
        lines: [{ lineId: 'l1', hsnCode: '7117', ratePercent: c.rate, netLineValue: c.net }],
      }),
    );
    const line = nth(result.lines, 0);
    expect(result.supplyType).toBe(c.seller === c.pos ? 'INTRA_STATE' : 'INTER_STATE');
    expect(s(line.taxableValue)).toBe(c.taxable);
    expect(line.components.map((x) => [x.component, s(x.amount)])).toEqual(c.components);
    expect(s(line.total)).toBe(c.lineTotal);
    // Σ exact: taxable + Σ components = line total.
    expect(s(line.taxableValue.plus(sum(line.components.map((x) => x.amount))))).toBe(c.lineTotal);
  });
});

describe('GST catalogue — TESTING_STRATEGY §6.2 cart-level cases', () => {
  // Gift box at 18% is illustrative (table: "3% + 18% illustrative for gift box").
  const MIXED_LINES = [
    { lineId: 'jewel', hsnCode: '7117', ratePercent: '3', netLineValue: '1030.00' },
    { lineId: 'giftbox', hsnCode: '4819', ratePercent: '18', netLineValue: '118.00' },
  ] as const;

  it('GST-10 mixed-rate cart (3% + 18%), intra-state, lines ₹1,030 + ₹118', () => {
    const result = computeTax(input({ lines: MIXED_LINES }));
    const [a, b] = [nth(result.lines, 0), nth(result.lines, 1)];
    expect(s(a.taxableValue)).toBe('1000.00');
    expect(a.components.map((x) => [x.component, s(x.amount)])).toEqual([
      ['CGST', '15.00'],
      ['SGST', '15.00'],
    ]);
    expect(s(b.taxableValue)).toBe('100.00');
    expect(b.components.map((x) => [x.component, s(x.amount)])).toEqual([
      ['CGST', '9.00'],
      ['SGST', '9.00'],
    ]);
    // Invoice totals = Σ lines.
    expect(s(result.totals.taxableTotal)).toBe('1100.00');
    expect(s(result.totals.cgstTotal)).toBe('24.00');
    expect(s(result.totals.sgstTotal)).toBe('24.00');
    expect(s(result.totals.taxTotal)).toBe('48.00');
    expect(s(result.totals.totalBeforeRoundOff)).toBe('1148.00');
  });

  it('GST-11 shipping ₹100 incl. proportional (OQ-22) on the GST-10 cart, intra-state', () => {
    const result = computeTax(
      input({ lines: MIXED_LINES, shipping: { netCharge: '100.00', treatment: 'PROPORTIONAL' } }),
    );
    const allocations = result.shipping.allocations;
    // Shipping split by line value ratio 1030 : 118 → 89.7212… → 89.72 (half-up), remainder to last.
    expect(allocations.map((x) => [x.lineId, s(x.share)])).toEqual([
      ['jewel', '89.72'],
      ['giftbox', '10.28'],
    ]);
    // Components per rate: each share taxed at its line's rate (inclusive).
    // 89.72 × 3/103 = 2.6132… → 2.61 (CGST 1.31 + SGST 1.30); taxable 87.11.
    // 10.28 × 18/118 = 1.5681… → 1.57 (CGST 0.79 + SGST 0.78); taxable 8.71.
    expect(
      allocations.map((x) => [
        s(x.ratePercent),
        s(x.taxableValue),
        x.components.map((c) => [c.component, s(c.amount)]),
      ]),
    ).toEqual([
      [
        '3.00',
        '87.11',
        [
          ['CGST', '1.31'],
          ['SGST', '1.30'],
        ],
      ],
      [
        '18.00',
        '8.71',
        [
          ['CGST', '0.79'],
          ['SGST', '0.78'],
        ],
      ],
    ]);
    expect(s(result.shipping.taxableValue)).toBe('95.82');
    expect(s(result.shipping.taxAmount)).toBe('4.18');
    expect(s(result.shipping.total)).toBe('100.00');
  });

  it('GST-12 invoice round-off of grand total ₹1,234.56 (nearest ₹1 half-up → +0.44, ₹1,235)', () => {
    // Interpretation: the table offers "round_off = -0.56, payable ₹1,234.00 (or +0.44 → ₹1,235
    // per rule)". The documented rule (TAX_AND_GST_WORKFLOWS §11 "Invoice round-off": R0 = nearest
    // whole rupee half-up, OQ-23) yields +0.44 → ₹1,235.00, which is asserted here.
    const result = computeTax(
      input({
        lines: [{ lineId: 'l1', hsnCode: '7117', ratePercent: '3', netLineValue: '1234.56' }],
      }),
    );
    expect(s(result.totals.totalBeforeRoundOff)).toBe('1234.56');
    expect(s(result.totals.roundOff)).toBe('0.44');
    expect(s(result.totals.grandTotal)).toBe('1235.00');
    // Round-off is never allocated to lines or tax.
    expect(s(nth(result.lines, 0).total)).toBe('1234.56');
    expect(s(result.totals.taxTotal)).toBe(s(nth(result.lines, 0).taxAmount));
  });
});

describe('GST catalogue — TESTING_STRATEGY §6.2 rate resolution cases', () => {
  // IST calendar dates stored as the UTC instant of 00:00 IST (resolution.ts header).
  const IST_2026_04_01 = new Date('2026-04-01T00:00:00+05:30');
  const IST_2026_11_30 = new Date('2026-11-30T00:00:00+05:30');
  const IST_2026_12_01 = new Date('2026-12-01T00:00:00+05:30');

  function candidate(
    overrides: Partial<AssignmentCandidate> & Pick<AssignmentCandidate, 'id'>,
  ): AssignmentCandidate {
    return {
      targetType: 'PRODUCT',
      productId: 'prod-1',
      categoryId: null,
      taxRateId: 'rate-3',
      hsnCode: '7117',
      taxRate: { id: 'rate-3', rate: '3.00', isActive: true },
      effectiveFrom: IST_2026_04_01,
      effectiveTo: null,
      ...overrides,
    };
  }

  // Illustrative 3% → 5% change effective 2026-12-01 IST (old window inclusive to 2026-11-30 IST).
  const RATE_CHANGE = [
    candidate({ id: 'old', effectiveTo: IST_2026_11_30 }),
    candidate({
      id: 'new',
      taxRateId: 'rate-5',
      taxRate: { id: 'rate-5', rate: '5.00', isActive: true },
      effectiveFrom: IST_2026_12_01,
    }),
  ];

  it('GST-13 effective-dated rate change 3% → 5% from 2026-12-01 IST: order at 2026-11-30 23:59 IST uses old rate', () => {
    const placedAt = new Date('2026-11-30T23:59:00+05:30');
    const selected = selectAssignment(RATE_CHANGE, 'prod-1', [], placedAt);
    if (typeof selected === 'string') throw new Error(`unexpected ${selected}`);
    expect(selected.assignment.id).toBe('old');
    expect(s(dec(selected.assignment.taxRate.rate))).toBe('3.00');

    const result = computeTax(
      input({
        now: placedAt,
        lines: [
          {
            lineId: 'l1',
            hsnCode: selected.assignment.hsnCode,
            ratePercent: selected.assignment.taxRate.rate,
            netLineValue: '1030.00',
          },
        ],
      }),
    );
    expect(s(nth(result.lines, 0).taxableValue)).toBe('1000.00');
    expect(nth(result.lines, 0).components.map((x) => s(x.amount))).toEqual(['15.00', '15.00']);

    // Boundary in IST: 00:00 IST on 2026-12-01 (= 2026-11-30T18:30Z) switches to the new rate.
    const boundary = selectAssignment(RATE_CHANGE, 'prod-1', [], IST_2026_12_01);
    if (typeof boundary === 'string') throw new Error(`unexpected ${boundary}`);
    expect(boundary.assignment.id).toBe('new');
    const justBefore = selectAssignment(
      RATE_CHANGE,
      'prod-1',
      [],
      new Date(IST_2026_12_01.getTime() - 1),
    );
    if (typeof justBefore === 'string') throw new Error(`unexpected ${justBefore}`);
    expect(justBefore.assignment.id).toBe('old');
  });

  it('GST-14 product without HSN/assignment falls back to the category assignment', () => {
    const candidates = [
      candidate({
        id: 'cat-assign',
        targetType: 'CATEGORY',
        productId: null,
        categoryId: 'cat-earrings',
        hsnCode: '7117',
      }),
      // Unrelated product assignment must not be picked.
      candidate({ id: 'other-product', productId: 'prod-other', hsnCode: '7113' }),
    ];
    const selected = selectAssignment(candidates, 'prod-1', ['cat-earrings', 'cat-jewellery'], NOW);
    if (typeof selected === 'string') throw new Error(`unexpected ${selected}`);
    expect(selected.source).toBe('CATEGORY');
    expect(selected.categoryId).toBe('cat-earrings');
    expect(selected.assignment.id).toBe('cat-assign');
    expect(selected.assignment.hsnCode).toBe('7117');
  });

  it('GST-15 no tax assignment at all → resolution fails closed (NO_ASSIGNMENT, never a silent 0%)', () => {
    expect(selectAssignment([], 'prod-1', ['cat-earrings'], NOW)).toBe('NO_ASSIGNMENT');
    expect(
      selectAssignment(
        [candidate({ id: 'other', productId: 'prod-other' })],
        'prod-1',
        ['cat-earrings'],
        NOW,
      ),
    ).toBe('NO_ASSIGNMENT');
  });

  it.todo(
    'GST-15 (order placement blocked: 422 VALIDATION_ERROR, detail TAX_NOT_CONFIGURED, per checkout.quote.ts) — PENDING real-database execution (DEC-12): blocking happens in the DB-backed checkout quote',
  );
});

describe('GST catalogue — TESTING_STRATEGY §6.2 credit note / B2B cases', () => {
  it('GST-16 credit note for partial refund (1 of 2 qty), intra-state 3%, refund ₹1,030 → negative ledger rows', () => {
    // Original invoice: 2 × ₹1,030 inclusive at 3% → taxable 2000.00, CGST 30.00, SGST 30.00.
    const original: LedgerGroup = {
      orderItemId: 'item-1',
      lineType: 'ITEM',
      hsnCode: '7117',
      rate: dec('3'),
      taxableValue: dec('2000.00'),
      components: [
        { component: 'CGST', amount: dec('30.00') },
        { component: 'SGST', amount: dec('30.00') },
      ],
    };
    const remaining = nth(remainingGroups([original], []), 0);
    const credit = prorateGroup(original, remaining, dec(1).dividedBy(2), false);
    expect(s(credit.taxableValue.plus(sum(credit.components.map((c) => c.amount))))).toBe(
      '1030.00',
    );

    const rows = ledgerRows([credit], -1);
    expect(rows.map((r) => [r.component, s(r.taxableValue), s(r.amount)])).toEqual([
      ['CGST', '-1000.00', '-15.00'],
      ['SGST', '-1000.00', '-15.00'],
    ]);
  });

  it.todo(
    'GST-17 B2B with buyer GSTIN, inter-state 3% on ₹1,000 excl. → IGST ₹30, GSTIN on invoice, appears in gst-b2b — DEFERRED: B2B invoicing is disabled (OQ-24)',
  );
});
