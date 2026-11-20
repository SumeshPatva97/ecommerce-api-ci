/**
 * Tax-ledger row builders (pure) — TAX_AND_GST_WORKFLOWS.md §10, §16.2, §18.4, §19.
 *
 * Rows are grouped per (order item, line type): a group carries the taxable value (repeated on
 * every component row in `tax_transactions`) and one amount per GST component. Reports compute
 * taxable totals only from `CGST`/`IGST` rows (§19), so every group emits exactly one of those.
 *
 * `rate` on a ledger row is the LINE's total GST rate (reports group by
 * `COALESCE(order_items.tax_rate, tax_transactions.rate)`).
 *
 * Shipping (OQ-22, PROVISIONAL): the order snapshot keeps goods tax per item and only the ORDER
 * totals include shipping tax, so shipping rows are derived as `order totals − Σ items`. When the
 * residual matches a PROPORTIONAL re-allocation of the net shipping charge (the working assumption)
 * it is split per item; otherwise one residual row set is written at the effective rate.
 */
import type { TaxComponent, TaxLineType } from '../../generated/prisma/enums.js';
import { ZERO, dec, roundMoney, sum, type Decimal, type DecimalInput } from '../../lib/money.js';
import { allocateProRata, computeRowTax, type ComponentPair } from '../../lib/tax/index.js';

export interface LedgerComponent {
  readonly component: TaxComponent;
  readonly amount: Decimal;
}

export interface LedgerGroup {
  readonly orderItemId: string | null;
  readonly lineType: TaxLineType;
  readonly hsnCode: string;
  /** Line total GST rate (percent). */
  readonly rate: Decimal;
  readonly taxableValue: Decimal;
  readonly components: readonly LedgerComponent[];
}

export interface LedgerItemSnapshot {
  readonly id: string;
  readonly hsnCode: string;
  readonly quantity: number;
  readonly taxRate: DecimalInput;
  readonly taxableValue: DecimalInput;
  readonly lineTotal: DecimalInput;
  readonly utgstRate: DecimalInput;
  readonly cgstAmount: DecimalInput;
  readonly sgstAmount: DecimalInput;
  readonly utgstAmount: DecimalInput;
  readonly igstAmount: DecimalInput;
}

export interface LedgerOrderSnapshot {
  readonly supplyType: 'INTRA_STATE' | 'INTER_STATE';
  readonly pricesIncludeTax: boolean;
  readonly shippingCharge: DecimalInput;
  readonly shippingDiscount: DecimalInput;
  readonly taxableTotal: DecimalInput;
  readonly cgstTotal: DecimalInput;
  readonly sgstTotal: DecimalInput;
  readonly utgstTotal: DecimalInput;
  readonly igstTotal: DecimalInput;
  readonly items: readonly LedgerItemSnapshot[];
}

export function groupTax(group: LedgerGroup): Decimal {
  return sum(group.components.map((c) => c.amount));
}

export function orderComponentPair(order: LedgerOrderSnapshot): ComponentPair {
  if (order.supplyType === 'INTER_STATE') return ['IGST'];
  const ut =
    dec(order.utgstTotal).greaterThan(0) ||
    order.items.some((i) => dec(i.utgstRate).greaterThan(0));
  return ut ? ['CGST', 'UTGST'] : ['CGST', 'SGST'];
}

function itemComponents(item: LedgerItemSnapshot, pair: ComponentPair): LedgerComponent[] {
  const amountOf: Record<TaxComponent, Decimal> = {
    CGST: dec(item.cgstAmount),
    SGST: dec(item.sgstAmount),
    UTGST: dec(item.utgstAmount),
    IGST: dec(item.igstAmount),
  };
  return pair.map((component) => ({ component, amount: amountOf[component] }));
}

function residualShipping(order: LedgerOrderSnapshot, pair: ComponentPair): LedgerGroup[] {
  const items = order.items;
  const taxable = dec(order.taxableTotal).minus(sum(items.map((i) => i.taxableValue)));
  const totals: Record<TaxComponent, Decimal> = {
    CGST: dec(order.cgstTotal).minus(sum(items.map((i) => i.cgstAmount))),
    SGST: dec(order.sgstTotal).minus(sum(items.map((i) => i.sgstAmount))),
    UTGST: dec(order.utgstTotal).minus(sum(items.map((i) => i.utgstAmount))),
    IGST: dec(order.igstTotal).minus(sum(items.map((i) => i.igstAmount))),
  };
  const residualTax = sum(pair.map((c) => totals[c]));
  if (taxable.isZero() && residualTax.isZero()) return [];
  if (taxable.isNegative() || pair.some((c) => totals[c].isNegative())) {
    throw new Error('Order tax snapshot is inconsistent: shipping residual is negative.');
  }

  // Try the PROPORTIONAL re-allocation (OQ-22 working assumption).
  const net = dec(order.shippingCharge).minus(dec(order.shippingDiscount));
  if (net.greaterThan(0) && items.length > 0) {
    const weights = items.map((i) => (order.pricesIncludeTax ? i.lineTotal : i.taxableValue));
    const shares = allocateProRata(net, weights);
    const groups: LedgerGroup[] = [];
    items.forEach((item, index) => {
      const share = shares[index] ?? ZERO;
      if (share.isZero()) return;
      const row = computeRowTax(share, item.taxRate, order.pricesIncludeTax, pair);
      groups.push({
        orderItemId: item.id,
        lineType: 'SHIPPING',
        hsnCode: item.hsnCode,
        rate: dec(item.taxRate),
        taxableValue: row.taxableValue,
        components: pair.map((component) => ({
          component,
          amount: row.components.find((c) => c.component === component)?.amount ?? ZERO,
        })),
      });
    });
    const matches =
      sum(groups.map((g) => g.taxableValue)).equals(taxable) &&
      pair.every((c) =>
        sum(groups.map((g) => g.components.find((x) => x.component === c)?.amount ?? ZERO)).equals(
          totals[c],
        ),
      );
    if (matches) return groups;
  }

  // Fallback: one residual group at the effective rate.
  const first = items[0];
  return [
    {
      orderItemId: null,
      lineType: 'SHIPPING',
      hsnCode: first?.hsnCode ?? '0000',
      rate: taxable.isZero() ? ZERO : roundMoney(residualTax.times(100).dividedBy(taxable)),
      taxableValue: taxable,
      components: pair.map((component) => ({ component, amount: totals[component] })),
    },
  ];
}

/** Tax-invoice groups (goods per item + shipping) from the immutable order snapshot. */
export function invoiceGroups(order: LedgerOrderSnapshot): LedgerGroup[] {
  const pair = orderComponentPair(order);
  const goods: LedgerGroup[] = order.items.map((item) => ({
    orderItemId: item.id,
    lineType: 'ITEM',
    hsnCode: item.hsnCode,
    rate: dec(item.taxRate),
    taxableValue: dec(item.taxableValue),
    components: itemComponents(item, pair),
  }));
  return [...goods, ...residualShipping(order, pair)];
}

/** Key identifying the same group across an invoice and its credit notes. */
export function groupKey(g: Pick<LedgerGroup, 'orderItemId' | 'lineType'>): string {
  return `${g.lineType}:${g.orderItemId ?? '-'}`;
}

/** `original − Σ credited` per group (amounts compared as absolute values). */
export function remainingGroups(
  original: readonly LedgerGroup[],
  credited: readonly LedgerGroup[],
): LedgerGroup[] {
  return original.map((g) => {
    const prior = credited.filter((c) => groupKey(c) === groupKey(g));
    const priorTaxable = sum(prior.map((p) => p.taxableValue.abs()));
    return {
      ...g,
      taxableValue: g.taxableValue.minus(priorTaxable),
      components: g.components.map((c) => ({
        component: c.component,
        amount: c.amount.minus(
          sum(
            prior.flatMap((p) =>
              p.components.filter((x) => x.component === c.component).map((x) => x.amount.abs()),
            ),
          ),
        ),
      })),
    };
  });
}

/**
 * Pro-rated share (§18.4) of a remaining group: `total = R(N × f)`, `component = R(c × f)`,
 * `taxable = total − Σ components`; `final` takes the whole remainder.
 */
export function prorateGroup(
  original: LedgerGroup,
  remaining: LedgerGroup,
  fraction: Decimal,
  final: boolean,
): LedgerGroup {
  if (final || fraction.greaterThanOrEqualTo(1)) return remaining;
  const components = original.components.map((c) => {
    const left = remaining.components.find((x) => x.component === c.component)?.amount ?? ZERO;
    return { component: c.component, amount: minOf(roundMoney(c.amount.times(fraction)), left) };
  });
  const gross = original.taxableValue.plus(groupTax(original));
  const total = roundMoney(gross.times(fraction));
  const taxable = minOf(total.minus(sum(components.map((c) => c.amount))), remaining.taxableValue);
  return { ...original, taxableValue: taxable, components };
}

function minOf(a: Decimal, b: Decimal): Decimal {
  return a.lessThan(b) ? a : b;
}

export function isEmptyGroup(g: LedgerGroup): boolean {
  return g.taxableValue.isZero() && g.components.every((c) => c.amount.isZero());
}

/** Groups → `tax_transactions` row values (credit notes are stored NEGATIVE, §19). */
export function ledgerRows(
  groups: readonly LedgerGroup[],
  sign: 1 | -1,
): {
  orderItemId: string | null;
  lineType: TaxLineType;
  component: TaxComponent;
  hsnCode: string;
  rate: Decimal;
  taxableValue: Decimal;
  amount: Decimal;
}[] {
  return groups.flatMap((g) =>
    g.components.map((c) => ({
      orderItemId: g.orderItemId,
      lineType: g.lineType,
      component: c.component,
      hsnCode: g.hsnCode,
      rate: g.rate,
      taxableValue: sign === 1 ? g.taxableValue : g.taxableValue.negated(),
      amount: sign === 1 ? c.amount : c.amount.negated(),
    })),
  );
}

export function documentTotals(groups: readonly LedgerGroup[]): {
  taxableTotal: Decimal;
  taxTotal: Decimal;
} {
  return {
    taxableTotal: sum(groups.map((g) => g.taxableValue)),
    taxTotal: sum(groups.map(groupTax)),
  };
}

/** Rebuilds groups from stored ledger rows (absolute values). */
export function groupsFromRows(
  rows: readonly {
    orderItemId: string | null;
    lineType: TaxLineType;
    component: TaxComponent;
    hsnCode: string;
    rate: DecimalInput;
    taxableValue: DecimalInput;
    amount: DecimalInput;
  }[],
): LedgerGroup[] {
  const byKey = new Map<string, { group: LedgerGroup; components: LedgerComponent[] }>();
  for (const r of rows) {
    const key = groupKey(r);
    let entry = byKey.get(key);
    if (entry === undefined) {
      const components: LedgerComponent[] = [];
      entry = {
        components,
        group: {
          orderItemId: r.orderItemId,
          lineType: r.lineType,
          hsnCode: r.hsnCode,
          rate: dec(r.rate),
          taxableValue: dec(r.taxableValue).abs(),
          components,
        },
      };
      byKey.set(key, entry);
    }
    entry.components.push({ component: r.component, amount: dec(r.amount).abs() });
  }
  return [...byKey.values()].map((e) => e.group);
}
