/** resolveRates (checkout API) — MOCKED DB. */
import { describe, expect, it } from 'vitest';

import { Decimal } from '../../../../src/lib/money.js';
import { istDayRange } from '../../../../src/lib/time.js';
import { resolveRates } from '../../../../src/modules/tax/index.js';
import { createMockDb } from '../../../helpers/mockDb.js';

const AT = new Date('2026-11-19T06:30:00.000Z');
const from = istDayRange('2026-04-01').start;
const rate = (isActive = true) => ({ id: 'r3', name: 'GST 3%', rate: new Decimal('3'), isActive });

describe('resolveRates', () => {
  it('returns an empty map without querying for no products', async () => {
    const { db, m } = createMockDb();
    expect((await resolveRates(db, [], AT)).size).toBe(0);
    expect(m.product.findMany).not.toHaveBeenCalled();
  });

  it('walks category ancestors and reports every failure reason', async () => {
    const { db, m } = createMockDb();
    m.product.findMany.mockResolvedValue([
      { id: 'p-anc', categoryId: 'leaf', hsnCode: '7117' },
      { id: 'p-none', categoryId: 'other', hsnCode: null },
      { id: 'p-inactive', categoryId: 'other', hsnCode: '7117' },
      { id: 'p-nohsn', categoryId: 'other', hsnCode: null },
    ]);
    m.category.findMany
      .mockResolvedValueOnce([
        { id: 'leaf', parentId: 'mid' },
        { id: 'other', parentId: null },
      ])
      .mockResolvedValueOnce([{ id: 'mid', parentId: 'root' }])
      .mockResolvedValueOnce([{ id: 'root', parentId: null }]);
    const base = { taxRateId: 'r3', effectiveFrom: from, effectiveTo: null, taxRate: rate() };
    m.productTaxAssignment.findMany.mockResolvedValue([
      {
        ...base,
        id: 'root-a',
        targetType: 'CATEGORY',
        productId: null,
        categoryId: 'root',
        hsnCode: null,
      },
      {
        ...base,
        id: 'inactive',
        targetType: 'PRODUCT',
        productId: 'p-inactive',
        categoryId: null,
        hsnCode: '7117',
        taxRate: rate(false),
      },
      {
        ...base,
        id: 'nohsn',
        targetType: 'PRODUCT',
        productId: 'p-nohsn',
        categoryId: null,
        hsnCode: null,
      },
    ]);

    const out = await resolveRates(
      db,
      ['p-anc', 'p-none', 'p-inactive', 'p-nohsn', 'p-gone', 'p-anc'],
      AT,
    );
    expect(out.get('p-anc')).toMatchObject({
      ok: true,
      hsnCode: '7117',
      source: 'CATEGORY',
      sourceCategoryId: 'root',
      assignmentId: 'root-a',
      taxRateName: 'GST 3%',
    });
    expect(out.get('p-none')).toEqual({ ok: false, productId: 'p-none', reason: 'NO_ASSIGNMENT' });
    expect(out.get('p-inactive')).toMatchObject({ ok: false, reason: 'RATE_INACTIVE' });
    expect(out.get('p-nohsn')).toMatchObject({ ok: false, reason: 'HSN_MISSING' });
    expect(out.get('p-gone')).toMatchObject({ ok: false, reason: 'PRODUCT_NOT_FOUND' });
    expect(m.category.findMany).toHaveBeenCalledTimes(3);

    const where = m.productTaxAssignment.findMany.mock.calls[0]?.[0].where;
    expect(where.effectiveFrom).toEqual({ lte: AT });
    expect([...(where.AND[0].OR[1].categoryId.in as string[])].sort()).toEqual([
      'leaf',
      'mid',
      'other',
      'root',
    ]);
  });
});
