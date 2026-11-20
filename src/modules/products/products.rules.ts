/**
 * Pure catalog rules for products/variants — PRODUCT_VARIANT_AND_INVENTORY_WORKFLOWS.md §3–§12,
 * PROJECT_CONTEXT.md §3.5–§3.6. No I/O (BACKEND_STRUCTURE.md §6 rule 5).
 *
 * Shared-lib candidate: `combinationKey`/`cartesian` belong in `src/lib/` once that is opened up;
 * kept here because this increment may not edit `src/lib/**`.
 */
import { createHash } from 'node:crypto';

import type { ProductStatus } from '../../generated/prisma/enums.js';
import { dec, Decimal, type DecimalInput } from '../../lib/money.js';
import { normalizeCode, SKU_PATTERN } from '../../lib/normalize.js';

/** SIMPLE default variant key (workflow §5, [PROPOSED constant]). */
export const DEFAULT_COMBINATION_KEY = 'DEFAULT';
/** PROVISIONAL (workflow §7.7 / API §4.3): 200 variants per product, 100 per generate request. */
export const MAX_VARIANTS_PER_PRODUCT = 200;
export const MAX_COMBINATIONS_PER_REQUEST = 100;
/** PROVISIONAL (API §4.3 "max 30 images/product (proposed)"). */
export const MAX_IMAGES_PER_PRODUCT = 30;
/** PROVISIONAL (OQ-47): global low-stock default when the variant has no own threshold. */
export const DEFAULT_LOW_STOCK_THRESHOLD = 5;
/** PROVISIONAL (OQ-57): `settings.maxQtyPerLine` default. */
export const MAX_QTY_PER_LINE = 5;

/** `combination_key` = attribute_value IDs sorted lexicographically, joined by `|` [CONFIRMED]. */
export function combinationKey(valueIds: readonly string[]): string {
  return [...valueIds].sort().join('|');
}

/** Cartesian product of the value lists (in axis order). */
export function cartesian<T>(lists: readonly (readonly T[])[]): T[][] {
  return lists.reduce<T[][]>(
    (acc, list) => acc.flatMap((prefix) => list.map((item) => [...prefix, item])),
    [[]],
  );
}

/** Value code for SKU tokens: upper-cased slug without separators, max 6 chars (API §4.3). */
export function valueCode(slug: string): string {
  return slug
    .replace(/[^a-z0-9]/gi, '')
    .toUpperCase()
    .slice(0, 6);
}

export interface SkuAxisToken {
  /** Lower-case keys the pattern may use for this axis (attribute code, slugified name). */
  readonly keys: readonly string[];
  /** Value code for the current combination. */
  readonly code: string;
}

export function defaultSkuPattern(axisCount: number): string {
  return ['{BASE}', ...Array.from({ length: axisCount }, (_, i) => `{axis${String(i + 1)}}`)].join(
    '-',
  );
}

export type SkuBuildResult =
  { readonly ok: true; readonly sku: string } | { readonly ok: false; readonly token: string };

/** Expands `{BASE}`, `{axisN}` and `{<attribute code>}` tokens. */
export function buildSku(
  pattern: string,
  base: string | undefined,
  axes: readonly SkuAxisToken[],
): SkuBuildResult {
  let unknown: string | undefined;
  const raw = pattern.replace(/\{([^{}]+)\}/g, (_match, inner: string) => {
    const token = inner.trim().toLowerCase();
    if (token === 'base') {
      if (base === undefined) unknown ??= inner;
      return base ?? '';
    }
    const positional = /^axis([1-3])$/.exec(token);
    const axis =
      positional === null
        ? axes.find((a) => a.keys.includes(token))
        : axes[Number(positional[1]) - 1];
    if (axis === undefined) {
      unknown ??= inner;
      return '';
    }
    return axis.code;
  });
  if (unknown !== undefined) return { ok: false, token: unknown };
  return { ok: true, sku: normalizeCode(raw) };
}

export function isValidSku(sku: string): boolean {
  return SKU_PATTERN.test(sku);
}

// ---------------------------------------------------------------------------------------------
// Status lifecycle (workflow §4): DRAFT → ACTIVE ↔ INACTIVE → ARCHIVED; ARCHIVED → DRAFT (restore)
// ---------------------------------------------------------------------------------------------
const TRANSITIONS: Readonly<Record<ProductStatus, readonly ProductStatus[]>> = {
  DRAFT: ['ACTIVE', 'ARCHIVED'],
  ACTIVE: ['INACTIVE', 'ARCHIVED'],
  INACTIVE: ['ACTIVE', 'ARCHIVED'],
  ARCHIVED: ['DRAFT'],
};

export function canTransition(from: ProductStatus, to: ProductStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: ProductStatus): readonly ProductStatus[] {
  return TRANSITIONS[from];
}

// ---------------------------------------------------------------------------------------------
// Category attribute rules (workflow §3.2): ancestors overlaid by the category's own rows.
// ---------------------------------------------------------------------------------------------
export interface CategoryRuleRow {
  readonly categoryId: string;
  readonly attributeId: string;
  readonly isRequired: boolean;
  readonly isVariantAxisDefault: boolean;
  readonly inheritToChildren: boolean;
  readonly sortOrder: number;
}

/** `chainRootFirst` = [root, …, leaf]. Ancestor rows apply only when `inheritToChildren`. */
export function effectiveCategoryRules(
  chainRootFirst: readonly string[],
  rows: readonly CategoryRuleRow[],
): Map<string, CategoryRuleRow> {
  const effective = new Map<string, CategoryRuleRow>();
  const leaf = chainRootFirst[chainRootFirst.length - 1];
  for (const categoryId of chainRootFirst) {
    for (const row of rows) {
      if (row.categoryId !== categoryId) continue;
      if (categoryId !== leaf && !row.inheritToChildren) continue;
      effective.set(row.attributeId, row);
    }
  }
  return effective;
}

/**
 * Required attributes not satisfied. An attribute is satisfied by a product-level value or — when
 * it is a variant axis of a VARIABLE product — by every non-deleted variant carrying a value.
 */
export function missingRequiredAttributes(
  rules: ReadonlyMap<string, CategoryRuleRow>,
  productAttributeIds: ReadonlySet<string>,
  variantAttributeSets: readonly ReadonlySet<string>[],
): string[] {
  const missing: string[] = [];
  for (const [attributeId, rule] of rules) {
    if (!rule.isRequired) continue;
    if (productAttributeIds.has(attributeId)) continue;
    const viaVariants =
      variantAttributeSets.length > 0 && variantAttributeSets.every((s) => s.has(attributeId));
    if (!viaVariants) missing.push(attributeId);
  }
  return missing;
}

// ---------------------------------------------------------------------------------------------
// Publish gate (workflow §4, API §4.3)
// ---------------------------------------------------------------------------------------------
export interface PublishGateInput {
  readonly categoryActive: boolean;
  readonly variants: readonly {
    readonly status: string;
    readonly mrp: DecimalInput;
    readonly sellingPrice: DecimalInput;
  }[];
  readonly imageCount: number;
  readonly missingRequiredAttributes: readonly { readonly id: string; readonly name: string }[];
  readonly taxResolvable: boolean;
}

export interface UnmetRequirement {
  readonly requirement:
    | 'ACTIVE_VARIANT_REQUIRED'
    | 'IMAGE_REQUIRED'
    | 'REQUIRED_ATTRIBUTE_MISSING'
    | 'TAX_UNRESOLVED'
    | 'CATEGORY_INACTIVE';
  readonly field: string;
  readonly message: string;
  readonly meta?: Record<string, unknown>;
}

export function evaluatePublishGate(input: PublishGateInput): UnmetRequirement[] {
  const unmet: UnmetRequirement[] = [];
  const sellable = input.variants.some((v) => {
    if (v.status !== 'ACTIVE') return false;
    const sp = dec(v.sellingPrice);
    return sp.gt(0) && sp.lte(dec(v.mrp));
  });
  if (!sellable) {
    unmet.push({
      requirement: 'ACTIVE_VARIANT_REQUIRED',
      field: 'variants',
      message: 'At least one ACTIVE variant with a selling price above 0 and not above MRP.',
    });
  }
  if (input.imageCount < 1) {
    unmet.push({
      requirement: 'IMAGE_REQUIRED',
      field: 'images',
      message: 'Add at least one image before publishing.',
    });
  }
  for (const attribute of input.missingRequiredAttributes) {
    unmet.push({
      requirement: 'REQUIRED_ATTRIBUTE_MISSING',
      field: 'attributeValueIds',
      message: `Required attribute "${attribute.name}" has no value.`,
      meta: { attributeId: attribute.id },
    });
  }
  if (!input.taxResolvable) {
    unmet.push({
      requirement: 'TAX_UNRESOLVED',
      field: 'hsnCode',
      message: 'No tax rate resolves for this product (product HSN or category tax assignment).',
    });
  }
  if (!input.categoryActive) {
    unmet.push({
      requirement: 'CATEGORY_INACTIVE',
      field: 'categoryId',
      message: 'The product category is inactive or deleted.',
    });
  }
  return unmet;
}

// ---------------------------------------------------------------------------------------------
// Pricing display helpers
// ---------------------------------------------------------------------------------------------
/** Whole-number discount percent `(mrp − price) / mrp × 100`, half-up; 0 when mrp ≤ 0. */
export function discountPercent(mrp: DecimalInput, price: DecimalInput): number {
  const m = dec(mrp);
  if (m.lte(0)) return 0;
  const pct = m.minus(dec(price)).div(m).times(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  return Math.max(0, pct.toNumber());
}

/** Fingerprint binding a generate preview to its inputs and the product's existing keys. */
export function previewFingerprint(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

// HTML sanitising (API §4.3, SECURITY_GUIDELINES §5): vetted `sanitize-html` allowlist in src/lib.
export { sanitizeRichText as sanitizeHtml } from '../../lib/sanitizeHtml.js';
