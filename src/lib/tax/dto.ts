/**
 * JSON shape of a `TaxResult` — money as 2-dp strings, rates as 2-dp strings (API_DOCUMENTATION
 * §2.9). Mirrors the `tax` blocks of `POST /checkout/summary` (§3.9). Pure.
 */
import { toMoneyString } from '../money.js';
import type { Decimal } from '../money.js';
import type {
  LineTaxResult,
  ShippingAllocation,
  TaxBreakdown,
  TaxComponentCode,
  TaxResult,
} from './engine.js';

export const toRateString = (rate: Decimal): string => rate.toFixed(2);

export interface TaxBlockDto {
  ratePercent: string;
  taxableValue: string;
  components: { component: TaxComponentCode; ratePercent: string; amount: string }[];
  taxAmount: string;
}

export function toTaxBlockDto(row: TaxBreakdown): TaxBlockDto {
  return {
    ratePercent: toRateString(row.ratePercent),
    taxableValue: toMoneyString(row.taxableValue),
    components: row.components.map((c) => ({
      component: c.component,
      ratePercent: toRateString(c.ratePercent),
      amount: toMoneyString(c.amount),
    })),
    taxAmount: toMoneyString(row.taxAmount),
  };
}

export interface LineTaxDto {
  lineId: string;
  hsnCode: string | null;
  netLineValue: string;
  tax: TaxBlockDto;
  lineTotal: string;
}

export function toLineTaxDto(line: LineTaxResult): LineTaxDto {
  return {
    lineId: line.lineId,
    hsnCode: line.hsnCode,
    netLineValue: toMoneyString(line.netLineValue),
    tax: toTaxBlockDto(line),
    lineTotal: toMoneyString(line.total),
  };
}

function toAllocationDto(a: ShippingAllocation): Record<string, unknown> {
  return { lineId: a.lineId, share: toMoneyString(a.share), ...toTaxBlockDto(a) };
}

export function toTaxResultDto(result: TaxResult): Record<string, unknown> {
  const t = result.totals;
  return {
    computedAt: result.computedAt.toISOString(),
    supplyType: result.supplyType,
    pricesIncludeTax: result.pricesIncludeTax,
    lines: result.lines.map(toLineTaxDto),
    shipping: {
      treatment: result.shipping.treatment,
      netCharge: toMoneyString(result.shipping.netCharge),
      tax: {
        treatment: result.shipping.treatment,
        taxableValue: toMoneyString(result.shipping.taxableValue),
        components: result.shipping.components.map((c) => ({
          component: c.component,
          amount: toMoneyString(c.amount),
        })),
        taxAmount: toMoneyString(result.shipping.taxAmount),
      },
      total: toMoneyString(result.shipping.total),
      allocations: result.shipping.allocations.map(toAllocationDto),
    },
    totals: {
      taxableTotal: toMoneyString(t.taxableTotal),
      cgstTotal: toMoneyString(t.cgstTotal),
      sgstTotal: toMoneyString(t.sgstTotal),
      utgstTotal: toMoneyString(t.utgstTotal),
      igstTotal: toMoneyString(t.igstTotal),
      taxTotal: toMoneyString(t.taxTotal),
      totalBeforeRoundOff: toMoneyString(t.totalBeforeRoundOff),
      roundOff: toMoneyString(t.roundOff),
      grandTotal: toMoneyString(t.grandTotal),
    },
  };
}
