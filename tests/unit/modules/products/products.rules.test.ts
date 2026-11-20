/**
 * Pure product rules (no DB): combination keys, cartesian generation, SKU patterns, status
 * transitions, category rule inheritance, publish gate, HTML sanitising.
 */
import { describe, expect, it } from 'vitest';

import {
  buildSku,
  canTransition,
  cartesian,
  combinationKey,
  defaultSkuPattern,
  discountPercent,
  effectiveCategoryRules,
  evaluatePublishGate,
  missingRequiredAttributes,
  sanitizeHtml,
  valueCode,
  type CategoryRuleRow,
} from '../../../../src/modules/products/products.rules.js';

const A = '0b7c1f2a-0000-4000-8000-000000000001';
const B = '0b7c1f2a-0000-4000-8000-000000000002';
const C = '9f000000-0000-4000-8000-000000000003';

describe('combinationKey / cartesian', () => {
  it('sorts attribute_value IDs lexicographically and joins with |', () => {
    expect(combinationKey([C, A, B])).toBe(`${A}|${B}|${C}`);
    expect(combinationKey([B, A])).toBe(combinationKey([A, B])); // order-insensitive
  });

  it('builds the cartesian product in axis order', () => {
    expect(
      cartesian([
        ['g', 'r'],
        ['s', 'm'],
      ]),
    ).toEqual([
      ['g', 's'],
      ['g', 'm'],
      ['r', 's'],
      ['r', 'm'],
    ]);
    expect(cartesian([['x', 'y', 'z']])).toHaveLength(3);
  });
});

describe('SKU suggestion', () => {
  const axes = [
    { keys: ['metal-finish'], code: valueCode('rose-gold') },
    { keys: ['size'], code: valueCode('medium') },
  ];

  it('derives value codes from slugs (upper, no separators, max 6)', () => {
    expect(valueCode('rose-gold')).toBe('ROSEGO');
    expect(valueCode('7')).toBe('7');
  });

  it('expands {BASE}, {axisN} and attribute-code tokens', () => {
    expect(defaultSkuPattern(2)).toBe('{BASE}-{axis1}-{axis2}');
    expect(buildSku('{BASE}-{axis1}-{axis2}', 'EAR-MEERA', axes)).toEqual({
      ok: true,
      sku: 'EAR-MEERA-ROSEGO-MEDIUM',
    });
    expect(buildSku('{BASE}-{metal-finish}-{size}', 'ear-meera', axes)).toEqual({
      ok: true,
      sku: 'EAR-MEERA-ROSEGO-MEDIUM',
    });
  });

  it('reports unknown tokens and a missing base', () => {
    expect(buildSku('{BASE}-{colour}', 'X1', axes)).toEqual({ ok: false, token: 'colour' });
    expect(buildSku('{BASE}-{axis1}', undefined, axes)).toEqual({ ok: false, token: 'BASE' });
  });
});

describe('product status transitions (workflow §4)', () => {
  it.each([
    ['DRAFT', 'ACTIVE', true],
    ['DRAFT', 'ARCHIVED', true],
    ['ACTIVE', 'INACTIVE', true],
    ['INACTIVE', 'ACTIVE', true],
    ['ACTIVE', 'ARCHIVED', true],
    ['ARCHIVED', 'DRAFT', true],
    ['ACTIVE', 'DRAFT', false],
    ['ARCHIVED', 'ACTIVE', false],
    ['DRAFT', 'INACTIVE', false],
  ] as const)('%s → %s allowed=%s', (from, to, allowed) => {
    expect(canTransition(from, to)).toBe(allowed);
  });
});

describe('category attribute rules', () => {
  const rule = (o: Partial<CategoryRuleRow>): CategoryRuleRow => ({
    categoryId: 'root',
    attributeId: 'material',
    isRequired: true,
    isVariantAxisDefault: false,
    inheritToChildren: true,
    sortOrder: 0,
    ...o,
  });

  it('overlays ancestor rules with the child row and honours inheritToChildren', () => {
    const rows = [
      rule({ categoryId: 'root', attributeId: 'material' }),
      rule({ categoryId: 'root', attributeId: 'closure', inheritToChildren: false }),
      rule({ categoryId: 'root', attributeId: 'size' }),
      rule({ categoryId: 'leaf', attributeId: 'size', isRequired: false }),
    ];
    const effective = effectiveCategoryRules(['root', 'leaf'], rows);
    expect([...effective.keys()].sort()).toEqual(['material', 'size']);
    expect(effective.get('size')?.isRequired).toBe(false);
  });

  it('accepts product-level values or a value on every variant', () => {
    const rules = effectiveCategoryRules(
      ['c'],
      [
        rule({ categoryId: 'c', attributeId: 'material' }),
        rule({ categoryId: 'c', attributeId: 'size' }),
      ],
    );
    expect(missingRequiredAttributes(rules, new Set(['material']), [])).toEqual(['size']);
    expect(
      missingRequiredAttributes(rules, new Set(['material']), [
        new Set(['size']),
        new Set(['size']),
      ]),
    ).toEqual([]);
    expect(
      missingRequiredAttributes(rules, new Set(), [
        new Set(['size', 'material']),
        new Set(['size']),
      ]),
    ).toEqual(['material']);
  });
});

describe('publish gate', () => {
  it('lists every unmet requirement', () => {
    const unmet = evaluatePublishGate({
      categoryActive: false,
      variants: [{ status: 'INACTIVE', mrp: '100', sellingPrice: '90' }],
      imageCount: 0,
      missingRequiredAttributes: [{ id: 'a1', name: 'Material' }],
      taxResolvable: false,
    });
    expect(unmet.map((u) => u.requirement)).toEqual([
      'ACTIVE_VARIANT_REQUIRED',
      'IMAGE_REQUIRED',
      'REQUIRED_ATTRIBUTE_MISSING',
      'TAX_UNRESOLVED',
      'CATEGORY_INACTIVE',
    ]);
  });

  it('passes with a sellable variant, an image, attributes and tax', () => {
    expect(
      evaluatePublishGate({
        categoryActive: true,
        variants: [{ status: 'ACTIVE', mrp: '1799.00', sellingPrice: '1499.00' }],
        imageCount: 1,
        missingRequiredAttributes: [],
        taxResolvable: true,
      }),
    ).toEqual([]);
  });

  it('computes whole discount percentages with Decimal', () => {
    expect(discountPercent('1799.00', '1349.10')).toBe(25);
    expect(discountPercent('100', '100')).toBe(0);
    expect(discountPercent('0', '10')).toBe(0);
  });
});

describe('sanitizeHtml (allowlist)', () => {
  it('removes scripts, event handlers and javascript: links but keeps safe markup', () => {
    const dirty =
      '<p onclick="x()">Hi <strong>there</strong></p><script>alert(1)</script>' +
      '<a href="javascript:alert(1)">bad</a><a href="https://example.com/x">ok</a>' +
      '<img src=x onerror=alert(1)><!-- c --><iframe src="//evil"></iframe>';
    const clean = sanitizeHtml(dirty);
    expect(clean).toBe(
      '<p>Hi <strong>there</strong></p><a rel="noopener noreferrer">bad</a>' +
        '<a href="https://example.com/x" rel="noopener noreferrer">ok</a>',
    );
    expect(clean).not.toMatch(/script|onerror|onclick|javascript|iframe/i);
  });

  it('escapes stray angle brackets in text', () => {
    expect(sanitizeHtml('5 < 6 and 7 > 3')).toBe('5 &lt; 6 and 7 &gt; 3');
  });
});

describe('sanitizeRichText — SECURITY_GUIDELINES §5 extras', () => {
  it('keeps Cloudinary https images only and forces link rel', () => {
    expect(
      sanitizeHtml(
        '<img src="https://res.cloudinary.com/demo/image/upload/a.jpg" alt="a" onerror="x">' +
          '<img src="https://evil.example/a.jpg"><img src="http://res.cloudinary.com/a.jpg">' +
          '<a href="https://x.example" rel="opener" target="_blank">l</a><table><tr><td>t</td></tr></table>',
      ),
    ).toBe(
      '<img src="https://res.cloudinary.com/demo/image/upload/a.jpg" alt="a" />' +
        '<a href="https://x.example" rel="noopener noreferrer">l</a><table><tr><td>t</td></tr></table>',
    );
  });
});
