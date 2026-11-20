/**
 * Pure GST engine — BACKEND_STRUCTURE.md §9, TAX_AND_GST_WORKFLOWS.md §6–§11,
 * GST_AND_INVOICE_DATABASE_DESIGN.md §4/§8. No I/O, no clock, no hard-coded rates: every rate,
 * setting and the computation instant are passed in by the caller (checkout, admin preview).
 *
 * Rules implemented (all configurable / PROVISIONAL — verify with a qualified Indian tax professional):
 * - Supply type: seller state === place-of-supply state → INTRA_STATE, else INTER_STATE.
 * - Components: INTRA → CGST + SGST, or CGST + UTGST when the place of supply is a Union Territory
 *   without legislature; INTER → IGST.
 * - PROVISIONAL (OQ-21): prices are GST-inclusive by default; exclusive mode is supported.
 * - PROVISIONAL (OQ-23): per-line half-up rounding to ₹0.01 of the line tax
 *   (inclusive: `tax = R(N × r / (100 + r))`, `taxable = N − tax`; exclusive: `tax = R(N × r / 100)`).
 *   The line tax is split equally between CGST and SGST/UTGST; an odd paisa goes to CGST
 *   (BACKEND_STRUCTURE §9 / API_DOCUMENTATION §3.9 worked example: 72.21 → 36.11 + 36.10).
 *   NOTE: TAX_AND_GST_WORKFLOWS §8.1 proposes a "component-first" variant (equal halves); the
 *   canonical API example uses tax-first, which is implemented here.
 * - PROVISIONAL (OQ-22): shipping treatment PROPORTIONAL (default) — net shipping is split across
 *   goods lines pro-rata to their net values (half-up, remainder to the last line) and each share is
 *   taxed at that line's rate; FIXED_RATE — whole charge at one configured rate; EXEMPT — untaxed.
 * - PROVISIONAL (OQ-23): invoice round-off of the grand total to the nearest ₹1 (half-up), shown
 *   as a separate `roundOff` amount and never allocated to lines or tax.
 */
import { Decimal, ZERO, dec, roundMoney, type DecimalInput } from '../money.js';

export type SupplyType = 'INTRA_STATE' | 'INTER_STATE';
export type TaxComponentCode = 'CGST' | 'SGST' | 'UTGST' | 'IGST';
export type ShippingTaxTreatment = 'PROPORTIONAL' | 'FIXED_RATE' | 'EXEMPT';
export type RoundingMode = 'PER_LINE_HALF_UP';
/** Components charged for one supply type. */
export type ComponentPair = readonly ['IGST'] | readonly ['CGST', 'SGST' | 'UTGST'];

export interface TaxLineInput {
  readonly lineId: string;
  readonly hsnCode: string | null;
  /** Total GST rate in percent (resolved, effective-dated, by the tax service). */
  readonly ratePercent: DecimalInput;
  /** Net line value after promotion and coupon allocation (`N`). */
  readonly netLineValue: DecimalInput;
}

export interface ShippingTaxInput {
  /** `shipping_charge − shipping_discount`. */
  readonly netCharge: DecimalInput;
  readonly treatment: ShippingTaxTreatment;
  /** Required when `treatment = FIXED_RATE`. */
  readonly fixedRatePercent?: DecimalInput | undefined;
}

export interface TaxInput {
  readonly lines: readonly TaxLineInput[];
  readonly shipping?: ShippingTaxInput | undefined;
  readonly pricesIncludeTax: boolean;
  readonly seller: { readonly stateCode: string };
  readonly placeOfSupply: {
    readonly stateCode: string;
    readonly isUnionTerritoryWithoutLegislature: boolean;
  };
  readonly rounding: { readonly mode: RoundingMode; readonly invoiceRoundOffToRupee: boolean };
  /** Computation instant (echoed for traceability; the engine never reads the clock). */
  readonly now: Date;
}

export interface TaxComponentAmount {
  readonly component: TaxComponentCode;
  readonly ratePercent: Decimal;
  readonly amount: Decimal;
}

export interface TaxBreakdown {
  readonly ratePercent: Decimal;
  readonly taxableValue: Decimal;
  readonly components: readonly TaxComponentAmount[];
  readonly taxAmount: Decimal;
  /** Amount payable for this row: inclusive → `N`; exclusive → taxable + tax. */
  readonly total: Decimal;
}

export interface LineTaxResult extends TaxBreakdown {
  readonly lineId: string;
  readonly hsnCode: string | null;
  readonly netLineValue: Decimal;
}

export interface ShippingAllocation extends TaxBreakdown {
  /** Goods line whose rate this shipping share follows (PROPORTIONAL) or `null`. */
  readonly lineId: string | null;
  readonly share: Decimal;
}

export interface ShippingTaxResult {
  readonly treatment: ShippingTaxTreatment;
  readonly netCharge: Decimal;
  readonly taxableValue: Decimal;
  readonly components: readonly { component: TaxComponentCode; amount: Decimal }[];
  readonly taxAmount: Decimal;
  readonly total: Decimal;
  readonly allocations: readonly ShippingAllocation[];
}

export interface TaxTotals {
  readonly taxableTotal: Decimal;
  readonly cgstTotal: Decimal;
  readonly sgstTotal: Decimal;
  readonly utgstTotal: Decimal;
  readonly igstTotal: Decimal;
  readonly taxTotal: Decimal;
  readonly totalBeforeRoundOff: Decimal;
  readonly roundOff: Decimal;
  readonly grandTotal: Decimal;
}

export interface TaxResult {
  readonly computedAt: Date;
  readonly supplyType: SupplyType;
  readonly componentPair: ComponentPair;
  readonly pricesIncludeTax: boolean;
  readonly lines: readonly LineTaxResult[];
  readonly shipping: ShippingTaxResult;
  readonly totals: TaxTotals;
}

export type TaxEngineErrorCode =
  | 'INVALID_RATE'
  | 'NEGATIVE_AMOUNT'
  | 'INVALID_STATE_CODE'
  | 'DUPLICATE_LINE'
  | 'MISSING_FIXED_RATE'
  | 'NO_LINES_FOR_PROPORTIONAL_SHIPPING';

/** Input that the engine refuses to compute (fail closed — never a silent 0 % tax). */
export class TaxEngineError extends Error {
  readonly code: TaxEngineErrorCode;
  constructor(code: TaxEngineErrorCode, message: string) {
    super(message);
    this.name = 'TaxEngineError';
    this.code = code;
  }
}

const HUNDRED = new Decimal(100);
const STATE_CODE = /^\d{2}$/;

export function determineSupplyType(sellerStateCode: string, posStateCode: string): SupplyType {
  return sellerStateCode === posStateCode ? 'INTRA_STATE' : 'INTER_STATE';
}

export function componentPair(
  supplyType: SupplyType,
  isUnionTerritoryWithoutLegislature: boolean,
): ComponentPair {
  if (supplyType === 'INTER_STATE') return ['IGST'];
  return isUnionTerritoryWithoutLegislature ? ['CGST', 'UTGST'] : ['CGST', 'SGST'];
}

function checkRate(rate: Decimal, label: string): void {
  if (rate.isNaN() || rate.isNegative() || rate.greaterThan(HUNDRED)) {
    throw new TaxEngineError('INVALID_RATE', `${label}: rate must be between 0 and 100.`);
  }
}

function checkAmount(value: Decimal, label: string): void {
  if (value.isNaN() || value.isNegative()) {
    throw new TaxEngineError('NEGATIVE_AMOUNT', `${label}: amount must not be negative.`);
  }
}

/**
 * Tax on one value at one rate. `value` is inclusive of tax when `inclusive`, else taxable.
 * Half-up per row; equal split with the odd paisa to CGST.
 */
export function computeRowTax(
  value: DecimalInput,
  ratePercent: DecimalInput,
  inclusive: boolean,
  pair: ComponentPair,
): TaxBreakdown {
  const amount = roundMoney(value);
  const rate = dec(ratePercent);
  const tax = inclusive
    ? roundMoney(amount.times(rate).dividedBy(HUNDRED.plus(rate)))
    : roundMoney(amount.times(rate).dividedBy(HUNDRED));
  const taxable = inclusive ? amount.minus(tax) : amount;
  const components: TaxComponentAmount[] = [];
  if (pair.length === 1) {
    components.push({ component: pair[0], ratePercent: rate, amount: tax });
  } else {
    const half = rate.dividedBy(2);
    const secondAmount = tax.dividedBy(2).toDecimalPlaces(2, Decimal.ROUND_DOWN);
    components.push(
      { component: pair[0], ratePercent: half, amount: tax.minus(secondAmount) },
      { component: pair[1], ratePercent: half, amount: secondAmount },
    );
  }
  return {
    ratePercent: rate,
    taxableValue: taxable,
    components,
    taxAmount: tax,
    total: taxable.plus(tax),
  };
}

/**
 * Splits `total` pro-rata to `weights` (half-up ₹0.01, remainder to the last entry). If the
 * remainder would make the last share negative, the deficit is taken from earlier shares
 * (largest first) so that no share is negative and Σ shares = total exactly.
 * All-zero weights put the whole amount on the last entry.
 */
export function allocateProRata(total: DecimalInput, weights: readonly DecimalInput[]): Decimal[] {
  return allocateItems(total, weights, (w) => w).map((a) => a.share);
}

function allocateItems<T>(
  total: DecimalInput,
  items: readonly T[],
  weightOf: (item: T) => DecimalInput,
): { item: T; share: Decimal }[] {
  const amount = roundMoney(total);
  const out = items.map((item) => ({ item, weight: dec(weightOf(item)), share: ZERO }));
  const last = out.at(-1);
  if (last === undefined) return [];
  const weightSum = out.reduce((acc, e) => acc.plus(e.weight), ZERO);
  if (weightSum.isZero()) {
    last.share = amount;
    return out;
  }
  const head = out.slice(0, -1);
  for (const e of head) e.share = roundMoney(amount.times(e.weight).dividedBy(weightSum));
  let rest = amount.minus(head.reduce((acc, e) => acc.plus(e.share), ZERO));
  if (rest.isNegative()) {
    let deficit = rest.negated();
    rest = ZERO;
    for (const e of [...head].sort((a, b) => b.share.comparedTo(a.share))) {
      if (deficit.isZero()) break;
      const take = Decimal.min(deficit, e.share);
      e.share = e.share.minus(take);
      deficit = deficit.minus(take);
    }
  }
  last.share = rest;
  return out;
}

function addComponents(
  into: Map<TaxComponentCode, Decimal>,
  components: readonly TaxComponentAmount[],
): void {
  for (const c of components) into.set(c.component, (into.get(c.component) ?? ZERO).plus(c.amount));
}

function computeShipping(
  input: TaxInput,
  lines: readonly LineTaxResult[],
  pair: ComponentPair,
): ShippingTaxResult {
  const shipping = input.shipping;
  const treatment = shipping?.treatment ?? 'PROPORTIONAL';
  const netCharge = roundMoney(shipping?.netCharge ?? 0);
  checkAmount(netCharge, 'shipping');
  const inclusive = input.pricesIncludeTax;

  let allocations: ShippingAllocation[] = [];
  if (!netCharge.isZero()) {
    if (treatment === 'EXEMPT') {
      allocations = [
        {
          lineId: null,
          share: netCharge,
          ratePercent: ZERO,
          taxableValue: netCharge,
          components: [],
          taxAmount: ZERO,
          total: netCharge,
        },
      ];
    } else if (treatment === 'FIXED_RATE') {
      if (shipping?.fixedRatePercent === undefined) {
        throw new TaxEngineError(
          'MISSING_FIXED_RATE',
          'shipping: FIXED_RATE treatment needs a fixed rate.',
        );
      }
      const rate = dec(shipping.fixedRatePercent);
      checkRate(rate, 'shipping');
      allocations = [
        { lineId: null, share: netCharge, ...computeRowTax(netCharge, rate, inclusive, pair) },
      ];
    } else {
      if (lines.length === 0) {
        throw new TaxEngineError(
          'NO_LINES_FOR_PROPORTIONAL_SHIPPING',
          'shipping: PROPORTIONAL treatment needs at least one goods line.',
        );
      }
      allocations = allocateItems(netCharge, lines, (l) => l.netLineValue).map(
        ({ item: line, share }) => ({
          lineId: line.lineId,
          share,
          ...computeRowTax(share, line.ratePercent, inclusive, pair),
        }),
      );
    }
  }

  const byComponent = new Map<TaxComponentCode, Decimal>();
  for (const a of allocations) addComponents(byComponent, a.components);
  const components =
    treatment === 'EXEMPT' || netCharge.isZero()
      ? []
      : pair.map((component) => ({
          component,
          amount: byComponent.get(component) ?? ZERO,
        }));
  const sumOf = (pick: (a: ShippingAllocation) => Decimal): Decimal =>
    allocations.reduce((acc, a) => acc.plus(pick(a)), ZERO);
  return {
    treatment,
    netCharge,
    taxableValue: sumOf((a) => a.taxableValue),
    components,
    taxAmount: sumOf((a) => a.taxAmount),
    total: sumOf((a) => a.total),
    allocations,
  };
}

/** Computes GST for a quote/order. Throws `TaxEngineError` for invalid input. */
export function computeTax(input: TaxInput): TaxResult {
  const sellerState = input.seller.stateCode;
  const posState = input.placeOfSupply.stateCode;
  if (!STATE_CODE.test(sellerState) || !STATE_CODE.test(posState)) {
    throw new TaxEngineError('INVALID_STATE_CODE', 'State codes must be 2 digits.');
  }
  const supplyType = determineSupplyType(sellerState, posState);
  const pair = componentPair(supplyType, input.placeOfSupply.isUnionTerritoryWithoutLegislature);

  const seen = new Set<string>();
  const lines: LineTaxResult[] = input.lines.map((line) => {
    if (seen.has(line.lineId)) {
      throw new TaxEngineError('DUPLICATE_LINE', `Duplicate line id ${line.lineId}.`);
    }
    seen.add(line.lineId);
    const rate = dec(line.ratePercent);
    checkRate(rate, line.lineId);
    const net = roundMoney(line.netLineValue);
    checkAmount(net, line.lineId);
    return {
      lineId: line.lineId,
      hsnCode: line.hsnCode,
      netLineValue: net,
      ...computeRowTax(net, rate, input.pricesIncludeTax, pair),
    };
  });

  const shipping = computeShipping(input, lines, pair);

  const byComponent = new Map<TaxComponentCode, Decimal>();
  for (const l of lines) addComponents(byComponent, l.components);
  for (const a of shipping.allocations) addComponents(byComponent, a.components);
  const component = (c: TaxComponentCode): Decimal => byComponent.get(c) ?? ZERO;

  const taxableTotal = lines
    .reduce((acc, l) => acc.plus(l.taxableValue), ZERO)
    .plus(shipping.taxableValue);
  const taxTotal = lines.reduce((acc, l) => acc.plus(l.taxAmount), ZERO).plus(shipping.taxAmount);
  const totalBeforeRoundOff = lines
    .reduce((acc, l) => acc.plus(l.total), ZERO)
    .plus(shipping.total);
  const grandTotal = input.rounding.invoiceRoundOffToRupee
    ? totalBeforeRoundOff.toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    : totalBeforeRoundOff;

  return {
    computedAt: input.now,
    supplyType,
    componentPair: pair,
    pricesIncludeTax: input.pricesIncludeTax,
    lines,
    shipping,
    totals: {
      taxableTotal,
      cgstTotal: component('CGST'),
      sgstTotal: component('SGST'),
      utgstTotal: component('UTGST'),
      igstTotal: component('IGST'),
      taxTotal,
      totalBeforeRoundOff,
      roundOff: grandTotal.minus(totalBeforeRoundOff),
      grandTotal,
    },
  };
}
