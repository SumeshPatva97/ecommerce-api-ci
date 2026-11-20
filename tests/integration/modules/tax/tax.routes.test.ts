/**
 * /admin/tax/* through the real Express pipeline — MOCKED DB (no MySQL): verifies guards
 * (permission + re-auth on every tax mutation), validation, service rules, audit rows and the
 * preview calculation (API_DOCUMENTATION §3.9 numbers).
 */
import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { Decimal } from '../../../../src/lib/money.js';
import { gstinCheckChar } from '../../../../src/lib/tax/index.js';
import { istDayRange } from '../../../../src/lib/time.js';
import { createTaxModule } from '../../../../src/modules/tax/index.js';
import { buildModuleTestApp } from '../../../helpers/container.js';
import { expectAdminRoutesGuarded } from '../../../helpers/routeTable.js';

const BASE = '/api/v1/admin/tax';
const NOW = new Date('2026-11-19T06:30:00.000Z');
const day = (iso: string): Date => istDayRange(iso).start;

function setup() {
  const t = buildModuleTestApp([createTaxModule], { now: NOW });
  const viewer = t.staff({ permissions: ['tax.view'] });
  const editor = t.staff({
    permissions: ['tax.view', 'tax.create', 'tax.update', 'tax.delete'],
    reauthenticated: true,
  });
  const noReauth = t.staff({ permissions: ['tax.view', 'tax.create', 'tax.update', 'tax.delete'] });
  return { t, viewer, editor, noReauth };
}

function rateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    name: 'GST 3%',
    rate: new Decimal('3.00'),
    cgstRate: new Decimal('1.50'),
    sgstRate: new Decimal('1.50'),
    utgstRate: new Decimal('1.50'),
    igstRate: new Decimal('3.00'),
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function assignmentRow(overrides: Record<string, unknown> = {}) {
  const rate = rateRow();
  return {
    id: randomUUID(),
    targetType: 'PRODUCT',
    productId: randomUUID(),
    categoryId: null,
    taxRateId: rate.id,
    hsnCode: '7117',
    effectiveFrom: day('2026-04-01'),
    effectiveTo: null,
    createdAt: NOW,
    updatedAt: NOW,
    taxRate: { id: rate.id, name: rate.name, rate: rate.rate, isActive: true },
    hsn: { id: randomUUID(), hsnCode: '7117' },
    product: { id: randomUUID(), name: 'Meera Jhumka' },
    category: null,
    ...overrides,
  };
}

const p2002 = () => Object.assign(new Error('dup'), { code: 'P2002', clientVersion: '7.10.1' });

describe('tax routes — guards', () => {
  it('declares a permission on every route and re-auth on every critical one', () => {
    const { t } = setup();
    const routes = expectAdminRoutesGuarded(createTaxModule(t.container));
    expect(routes.length).toBe(18);
    const mutations = routes.filter((r) => r.method !== 'GET' && r.path !== '/tax/preview');
    expect(mutations.every((r) => r.reauth)).toBe(true);
  });

  it('requires tax.view to read and re-auth to write', async () => {
    const { t, viewer, noReauth } = setup();
    const other = t.staff({ permissions: ['products.view'] });
    expect((await request(t.app).get(`${BASE}/rates`).set(other.headers)).status).toBe(403);

    t.m.taxRate.findMany.mockResolvedValue([rateRow()]);
    t.m.taxRate.count.mockResolvedValue(1);
    const list = await request(t.app).get(`${BASE}/rates?status=ACTIVE&q=gst`).set(viewer.headers);
    expect(list.status).toBe(200);
    expect(list.body.data[0]).toMatchObject({
      ratePercent: '3.00',
      components: { cgst: '1.50', sgst: '1.50', utgst: '1.50', igst: '3.00' },
      status: 'ACTIVE',
    });
    expect(list.body.meta).toMatchObject({ page: 1, limit: 25, totalItems: 1 });

    const denied = await request(t.app)
      .post(`${BASE}/rates`)
      .set(viewer.headers)
      .send({ name: 'GST 3%', ratePercent: '3' });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('PERMISSION_DENIED');

    const reauth = await request(t.app)
      .post(`${BASE}/rates`)
      .set(noReauth.headers)
      .send({ name: 'GST 3%', ratePercent: '3' });
    expect(reauth.status).toBe(403);
    expect(reauth.body.error.code).toBe('REAUTH_REQUIRED');
    expect(t.m.taxRate.create).not.toHaveBeenCalled();
  });
});

describe('tax rates', () => {
  it('creates a rate with derived components and an audit row', async () => {
    const { t, editor } = setup();
    t.m.taxRate.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve(rateRow({ ...data, id: randomUUID() })),
    );
    const res = await request(t.app)
      .post(`${BASE}/rates`)
      .set(editor.headers)
      .send({ name: '  GST   3% ', ratePercent: '3' });
    expect(res.status).toBe(201);
    const data = t.m.taxRate.create.mock.calls[0]?.[0].data;
    expect(data.nameNormalized).toBe('gst 3%');
    expect(String(data.cgstRate)).toBe('1.5');
    expect(String(data.igstRate)).toBe('3');
    expect(t.m.auditLog.create).toHaveBeenCalledTimes(1);
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data).toMatchObject({
      action: 'CREATE',
      module: 'tax',
      entityType: 'TaxRate',
      actorUserId: editor.ctx.userId,
    });
  });

  it('validates rate values and unknown fields', async () => {
    const { t, editor } = setup();
    const half = await request(t.app)
      .post(`${BASE}/rates`)
      .set(editor.headers)
      .send({ name: 'Odd', ratePercent: '0.25' });
    expect(half.status).toBe(422);
    expect(half.body.error.details[0].field).toBe('ratePercent');
    const tooHigh = await request(t.app)
      .post(`${BASE}/rates`)
      .set(editor.headers)
      .send({ name: 'Bad', ratePercent: '100.01' });
    expect(tooHigh.status).toBe(422);
    const extra = await request(t.app)
      .post(`${BASE}/rates`)
      .set(editor.headers)
      .send({ name: 'GST', ratePercent: '3', effectiveFrom: '2026-01-01' });
    expect(extra.status).toBe(422);
  });

  it('maps a duplicate name to 409 DUPLICATE_RESOURCE', async () => {
    const { t, editor } = setup();
    t.m.taxRate.create.mockRejectedValue(p2002());
    const res = await request(t.app)
      .post(`${BASE}/rates`)
      .set(editor.headers)
      .send({ name: 'GST 3%', ratePercent: '3' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_RESOURCE');
    expect(res.body.error.details[0].field).toBe('name');
  });

  it('refuses to change the percentage of a rate in use, but allows a rename', async () => {
    const { t, editor } = setup();
    const row = rateRow();
    t.m.taxRate.findUnique.mockResolvedValue(row);
    t.m.productTaxAssignment.count.mockResolvedValue(2);
    t.m.orderItem.count.mockResolvedValue(0);
    const res = await request(t.app)
      .patch(`${BASE}/rates/${row.id}`)
      .set(editor.headers)
      .send({ ratePercent: '5' });
    expect(res.status).toBe(409);
    expect(res.body.error.details[0].code).toBe('IN_USE');

    t.m.taxRate.update.mockResolvedValue({ ...row, name: 'GST 3% (jewellery)' });
    const rename = await request(t.app)
      .patch(`${BASE}/rates/${row.id}`)
      .set(editor.headers)
      .send({ name: 'GST 3% (jewellery)', ratePercent: '3.00' });
    expect(rename.status).toBe(200);
    expect(rename.body.data.name).toBe('GST 3% (jewellery)');
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data.action).toBe('UPDATE');
  });

  it('changes an unused rate and blocks deactivation while assignments are live', async () => {
    const { t, editor } = setup();
    const row = rateRow();
    t.m.taxRate.findUnique.mockResolvedValue(row);
    t.m.productTaxAssignment.count.mockResolvedValue(0);
    t.m.orderItem.count.mockResolvedValue(0);
    t.m.taxRate.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...row, ...data }),
    );
    const changed = await request(t.app)
      .patch(`${BASE}/rates/${row.id}`)
      .set(editor.headers)
      .send({ ratePercent: '5', status: 'INACTIVE' });
    expect(changed.status).toBe(200);
    expect(changed.body.data).toMatchObject({ ratePercent: '5.00', status: 'INACTIVE' });

    t.m.productTaxAssignment.count.mockResolvedValue(1);
    const blocked = await request(t.app)
      .patch(`${BASE}/rates/${row.id}`)
      .set(editor.headers)
      .send({ status: 'INACTIVE' });
    expect(blocked.status).toBe(409);

    const odd = await request(t.app)
      .patch(`${BASE}/rates/${row.id}`)
      .set(editor.headers)
      .send({ ratePercent: '0.25' });
    expect(odd.status).toBe(422);
    const empty = await request(t.app)
      .patch(`${BASE}/rates/${row.id}`)
      .set(editor.headers)
      .send({});
    expect(empty.status).toBe(422);
  });

  it('gets, 404s and deletes rates (only when unused)', async () => {
    const { t, editor, viewer } = setup();
    const row = rateRow({ _count: { assignments: 1, hsnCodes: 0 } });
    t.m.taxRate.findUnique.mockResolvedValueOnce(row);
    const got = await request(t.app).get(`${BASE}/rates/${row.id}`).set(viewer.headers);
    expect(got.body.data.usage).toEqual({ assignments: 1, hsnDefaults: 0 });
    t.m.taxRate.findUnique.mockResolvedValueOnce(null);
    expect((await request(t.app).get(`${BASE}/rates/${row.id}`).set(viewer.headers)).status).toBe(
      404,
    );
    expect((await request(t.app).get(`${BASE}/rates/not-a-uuid`).set(viewer.headers)).status).toBe(
      422,
    );

    t.m.taxRate.findUnique.mockResolvedValue(row);
    t.m.productTaxAssignment.count.mockResolvedValue(1);
    t.m.hsnCode.count.mockResolvedValue(0);
    t.m.orderItem.count.mockResolvedValue(0);
    const inUse = await request(t.app).delete(`${BASE}/rates/${row.id}`).set(editor.headers);
    expect(inUse.status).toBe(409);
    expect(t.m.taxRate.delete).not.toHaveBeenCalled();

    t.m.productTaxAssignment.count.mockResolvedValue(0);
    const del = await request(t.app).delete(`${BASE}/rates/${row.id}`).set(editor.headers);
    expect(del.status).toBe(200);
    expect(del.body.data).toEqual({ id: row.id, deleted: true });
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data.action).toBe('DELETE');

    t.m.taxRate.findUnique.mockResolvedValue(null);
    expect(
      (await request(t.app).delete(`${BASE}/rates/${row.id}`).set(editor.headers)).status,
    ).toBe(404);
  });
});

describe('HSN codes', () => {
  const hsn = (overrides: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    hsnCode: '7117',
    description: 'Imitation jewellery (illustrative)',
    defaultTaxRateId: null,
    defaultTaxRate: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });

  it('lists, creates, validates and audits', async () => {
    const { t, editor, viewer } = setup();
    const rate = rateRow();
    t.m.hsnCode.findMany.mockResolvedValue([
      hsn({ defaultTaxRateId: rate.id, defaultTaxRate: rate }),
    ]);
    t.m.hsnCode.count.mockResolvedValue(1);
    const list = await request(t.app).get(`${BASE}/hsn-codes?q=71`).set(viewer.headers);
    expect(list.status).toBe(200);
    expect(list.body.data[0].defaultTaxRate.ratePercent).toBe('3.00');

    const bad = await request(t.app)
      .post(`${BASE}/hsn-codes`)
      .set(editor.headers)
      .send({ hsnCode: '71A' });
    expect(bad.status).toBe(422);

    t.m.taxRate.findUnique.mockResolvedValueOnce(null);
    const missingRate = await request(t.app)
      .post(`${BASE}/hsn-codes`)
      .set(editor.headers)
      .send({ hsnCode: '7117', defaultTaxRateId: rate.id });
    expect(missingRate.status).toBe(422);
    expect(missingRate.body.error.details[0].field).toBe('defaultTaxRateId');

    t.m.taxRate.findUnique.mockResolvedValueOnce({ isActive: true });
    t.m.hsnCode.create.mockResolvedValue(hsn({ defaultTaxRateId: rate.id }));
    const created = await request(t.app)
      .post(`${BASE}/hsn-codes`)
      .set(editor.headers)
      .send({ hsnCode: '7117', description: 'Imitation', defaultTaxRateId: rate.id });
    expect(created.status).toBe(201);
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data.entityType).toBe('HsnCode');

    t.m.hsnCode.create.mockRejectedValue(p2002());
    const dup = await request(t.app)
      .post(`${BASE}/hsn-codes`)
      .set(editor.headers)
      .send({ hsnCode: '7117' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.details[0].field).toBe('hsnCode');
  });

  it('protects referenced codes on update/delete', async () => {
    const { t, editor, viewer } = setup();
    const row = hsn();
    t.m.hsnCode.findUnique.mockResolvedValue(row);
    expect(
      (await request(t.app).get(`${BASE}/hsn-codes/${row.id}`).set(viewer.headers)).status,
    ).toBe(200);
    t.m.product.count.mockResolvedValue(3);
    t.m.productTaxAssignment.count.mockResolvedValue(0);
    const rename = await request(t.app)
      .patch(`${BASE}/hsn-codes/${row.id}`)
      .set(editor.headers)
      .send({ hsnCode: '7113' });
    expect(rename.status).toBe(409);
    const del = await request(t.app).delete(`${BASE}/hsn-codes/${row.id}`).set(editor.headers);
    expect(del.status).toBe(409);

    t.m.hsnCode.update.mockResolvedValue({ ...row, description: 'New' });
    const desc = await request(t.app)
      .patch(`${BASE}/hsn-codes/${row.id}`)
      .set(editor.headers)
      .send({ description: 'New', defaultTaxRateId: null });
    expect(desc.status).toBe(200);
    expect(desc.body.data.description).toBe('New');

    t.m.product.count.mockResolvedValue(0);
    const ok = await request(t.app).delete(`${BASE}/hsn-codes/${row.id}`).set(editor.headers);
    expect(ok.status).toBe(200);
    expect(t.m.hsnCode.delete).toHaveBeenCalledWith({ where: { id: row.id } });

    t.m.hsnCode.findUnique.mockResolvedValue(null);
    expect(
      (await request(t.app).get(`${BASE}/hsn-codes/${row.id}`).set(viewer.headers)).status,
    ).toBe(404);
    expect(
      (
        await request(t.app)
          .patch(`${BASE}/hsn-codes/${row.id}`)
          .set(editor.headers)
          .send({ description: 'x' })
      ).status,
    ).toBe(404);
    expect(
      (await request(t.app).delete(`${BASE}/hsn-codes/${row.id}`).set(editor.headers)).status,
    ).toBe(404);
  });
});

describe('tax assignments (effective-dated)', () => {
  const productId = randomUUID();
  const body = {
    targetType: 'PRODUCT',
    targetId: productId,
    hsnCodeId: randomUUID(),
    taxRateId: randomUUID(),
    effectiveFrom: '2027-01-01',
  };

  function prime(t: ReturnType<typeof setup>['t']) {
    t.m.product.findFirst.mockResolvedValue({ id: productId });
    t.m.hsnCode.findUnique.mockResolvedValue({ hsnCode: '7117' });
    t.m.taxRate.findUnique.mockResolvedValue({ isActive: true });
  }

  it('rejects overlapping windows with 409 OVERLAPPING_ASSIGNMENT (after locking the target)', async () => {
    const { t, editor } = setup();
    prime(t);
    t.m.productTaxAssignment.findMany.mockResolvedValue([
      { id: 'existing', effectiveFrom: day('2026-04-01'), effectiveTo: null },
    ]);
    const res = await request(t.app).post(`${BASE}/assignments`).set(editor.headers).send(body);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body.error.details[0].code).toBe('OVERLAPPING_ASSIGNMENT');
    expect(t.m.$queryRaw).toHaveBeenCalledTimes(1);
    expect(t.m.productTaxAssignment.create).not.toHaveBeenCalled();
  });

  it('creates a non-overlapping assignment and stores IST-midnight dates', async () => {
    const { t, editor } = setup();
    prime(t);
    t.m.productTaxAssignment.findMany.mockResolvedValue([
      { id: 'old', effectiveFrom: day('2026-04-01'), effectiveTo: day('2026-12-31') },
    ]);
    t.m.productTaxAssignment.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => Promise.resolve(assignmentRow({ ...data })),
    );
    const res = await request(t.app)
      .post(`${BASE}/assignments`)
      .set(editor.headers)
      .send({ ...body, effectiveTo: '2027-12-31' });
    expect(res.status).toBe(201);
    const data = t.m.productTaxAssignment.create.mock.calls[0]?.[0].data;
    expect(data.effectiveFrom).toEqual(new Date('2026-12-31T18:30:00.000Z'));
    expect(data).toMatchObject({
      targetType: 'PRODUCT',
      productId,
      categoryId: null,
      hsnCode: '7117',
    });
    expect(res.body.data).toMatchObject({
      effectiveFrom: '2027-01-01',
      effectiveTo: '2027-12-31',
      isCurrentlyEffective: false,
    });
  });

  it('validates target, HSN, rate and date order', async () => {
    const { t, editor } = setup();
    t.m.category.findFirst.mockResolvedValue(null);
    const noCat = await request(t.app)
      .post(`${BASE}/assignments`)
      .set(editor.headers)
      .send({ ...body, targetType: 'CATEGORY' });
    expect(noCat.status).toBe(422);
    expect(noCat.body.error.details[0].field).toBe('targetId');

    t.m.product.findFirst.mockResolvedValue(null);
    expect(
      (await request(t.app).post(`${BASE}/assignments`).set(editor.headers).send(body)).status,
    ).toBe(422);

    t.m.product.findFirst.mockResolvedValue({ id: productId });
    t.m.hsnCode.findUnique.mockResolvedValue(null);
    const noHsn = await request(t.app).post(`${BASE}/assignments`).set(editor.headers).send(body);
    expect(noHsn.body.error.details[0].field).toBe('hsnCodeId');

    t.m.hsnCode.findUnique.mockResolvedValue({ hsnCode: '7117' });
    t.m.taxRate.findUnique.mockResolvedValue({ isActive: false });
    const inactive = await request(t.app)
      .post(`${BASE}/assignments`)
      .set(editor.headers)
      .send(body);
    expect(inactive.body.error.details[0]).toMatchObject({ field: 'taxRateId' });

    const order = await request(t.app)
      .post(`${BASE}/assignments`)
      .set(editor.headers)
      .send({ ...body, effectiveTo: '2026-12-31' });
    expect(order.status).toBe(422);
    const badDate = await request(t.app)
      .post(`${BASE}/assignments`)
      .set(editor.headers)
      .send({ ...body, effectiveFrom: '2027-02-30' });
    expect(badDate.status).toBe(422);
  });

  it('creates category assignments', async () => {
    const { t, editor } = setup();
    const categoryId = randomUUID();
    t.m.category.findFirst.mockResolvedValue({ id: categoryId });
    t.m.hsnCode.findUnique.mockResolvedValue({ hsnCode: '7117' });
    t.m.taxRate.findUnique.mockResolvedValue({ isActive: true });
    t.m.productTaxAssignment.findMany.mockResolvedValue([]);
    t.m.productTaxAssignment.create.mockResolvedValue(
      assignmentRow({
        targetType: 'CATEGORY',
        productId: null,
        categoryId,
        product: null,
        category: { id: categoryId, name: 'Earrings' },
      }),
    );
    const res = await request(t.app)
      .post(`${BASE}/assignments`)
      .set(editor.headers)
      .send({ ...body, targetType: 'CATEGORY', targetId: categoryId });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ targetId: categoryId, targetName: 'Earrings' });
  });

  it('only end-dates assignments that already took effect', async () => {
    const { t, editor, viewer } = setup();
    const row = assignmentRow();
    t.m.productTaxAssignment.findUnique.mockResolvedValue(row);
    expect(
      (await request(t.app).get(`${BASE}/assignments/${row.id}`).set(viewer.headers)).body.data
        .isCurrentlyEffective,
    ).toBe(true);

    const rateChange = await request(t.app)
      .patch(`${BASE}/assignments/${row.id}`)
      .set(editor.headers)
      .send({ taxRateId: randomUUID() });
    expect(rateChange.status).toBe(409);
    expect(rateChange.body.error.details[0].code).toBe('ASSIGNMENT_STARTED');

    const past = await request(t.app)
      .patch(`${BASE}/assignments/${row.id}`)
      .set(editor.headers)
      .send({ effectiveTo: '2026-10-01' });
    expect(past.status).toBe(422);

    t.m.productTaxAssignment.findMany.mockResolvedValue([row]);
    t.m.productTaxAssignment.update.mockResolvedValue({ ...row, effectiveTo: day('2026-12-31') });
    const endDate = await request(t.app)
      .patch(`${BASE}/assignments/${row.id}`)
      .set(editor.headers)
      .send({ effectiveTo: '2026-12-31' });
    expect(endDate.status).toBe(200);
    expect(endDate.body.data.effectiveTo).toBe('2026-12-31');

    const del = await request(t.app).delete(`${BASE}/assignments/${row.id}`).set(editor.headers);
    expect(del.status).toBe(409);
    expect(del.body.error.details[0].code).toBe('IN_USE');
  });

  it('edits and deletes future assignments', async () => {
    const { t, editor } = setup();
    const row = assignmentRow({ effectiveFrom: day('2027-01-01') });
    t.m.productTaxAssignment.findUnique.mockResolvedValue(row);
    t.m.productTaxAssignment.findMany.mockResolvedValue([]);
    t.m.hsnCode.findUnique.mockResolvedValue({ hsnCode: '7113' });
    t.m.taxRate.findUnique.mockResolvedValue({ isActive: true });
    t.m.productTaxAssignment.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...row, ...data }),
    );
    const res = await request(t.app)
      .patch(`${BASE}/assignments/${row.id}`)
      .set(editor.headers)
      .send({
        effectiveFrom: '2027-02-01',
        effectiveTo: null,
        hsnCodeId: randomUUID(),
        taxRateId: randomUUID(),
      });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ effectiveFrom: '2027-02-01', hsnCode: '7113' });

    const inverted = await request(t.app)
      .patch(`${BASE}/assignments/${row.id}`)
      .set(editor.headers)
      .send({ effectiveTo: '2026-12-01' });
    expect(inverted.status).toBe(422);

    const del = await request(t.app).delete(`${BASE}/assignments/${row.id}`).set(editor.headers);
    expect(del.status).toBe(200);
    expect(t.m.auditLog.create.mock.calls.at(-1)?.[0].data.action).toBe('DELETE');

    t.m.productTaxAssignment.findUnique.mockResolvedValue(null);
    expect(
      (await request(t.app).delete(`${BASE}/assignments/${row.id}`).set(editor.headers)).status,
    ).toBe(404);
  });

  it('lists with filters', async () => {
    const { t, viewer } = setup();
    t.m.productTaxAssignment.findMany.mockResolvedValue([assignmentRow()]);
    t.m.productTaxAssignment.count.mockResolvedValue(1);
    const res = await request(t.app)
      .get(
        `${BASE}/assignments?targetType=PRODUCT&targetId=${productId}&taxRateId=${randomUUID()}&activeOn=2026-11-19`,
      )
      .set(viewer.headers);
    expect(res.status).toBe(200);
    expect(res.body.data[0].taxRate.ratePercent).toBe('3.00');
    const where = t.m.productTaxAssignment.findMany.mock.calls[0]?.[0].where;
    expect(where.AND).toHaveLength(5);
  });
});

describe('tax settings', () => {
  const first14 = '27AAPFU0939F1Z';
  const gstin = `${first14}${gstinCheckChar(first14)}`;

  it('returns provisional defaults when nothing is stored', async () => {
    const { t, viewer } = setup();
    t.m.setting.findMany.mockResolvedValue([
      { settingKey: 'tax.invoice_prefix', value: 'INV' },
      { settingKey: 'tax.prices_include_tax', value: 'not-a-boolean' },
    ]);
    const res = await request(t.app).get(`${BASE}/settings`).set(viewer.headers);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      sellerGstin: null,
      pricesIncludeTax: true,
      shippingTaxTreatment: 'PROPORTIONAL',
      roundingMode: 'PER_LINE_HALF_UP',
      invoiceRoundOff: true,
      invoiceTrigger: 'ON_SHIPPED',
      invoicePrefix: 'INV',
      creditNotePrefix: 'CN',
    });
  });

  it('validates GSTIN checksum, state prefix, state existence and fixed shipping rate', async () => {
    const { t, editor } = setup();
    t.m.setting.findMany.mockResolvedValue([]);
    const badGstin = await request(t.app)
      .patch(`${BASE}/settings`)
      .set(editor.headers)
      .send({ sellerGstin: '27AAPFU0939F1Z0' });
    expect(badGstin.status).toBe(422);
    expect(badGstin.body.error.details[0].field).toBe('sellerGstin');

    t.m.state.findUnique.mockResolvedValue({ code: '29' });
    const mismatch = await request(t.app)
      .patch(`${BASE}/settings`)
      .set(editor.headers)
      .send({ sellerGstin: gstin, sellerStateCode: '29' });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error.details[0].message).toMatch(/prefix/);

    t.m.state.findUnique.mockResolvedValue(null);
    const unknownState = await request(t.app)
      .patch(`${BASE}/settings`)
      .set(editor.headers)
      .send({ sellerStateCode: '99' });
    expect(unknownState.body.error.details[0].field).toBe('sellerStateCode');

    const fixed = await request(t.app)
      .patch(`${BASE}/settings`)
      .set(editor.headers)
      .send({ shippingTaxTreatment: 'FIXED_RATE' });
    expect(fixed.body.error.details[0].field).toBe('shippingFixedTaxRateId');

    t.m.taxRate.findUnique.mockResolvedValue(null);
    const fixedMissing = await request(t.app)
      .patch(`${BASE}/settings`)
      .set(editor.headers)
      .send({ shippingTaxTreatment: 'FIXED_RATE', shippingFixedTaxRateId: randomUUID() });
    expect(fixedMissing.status).toBe(422);
    expect(t.m.setting.upsert).not.toHaveBeenCalled();
  });

  it('saves changed keys and audits SETTINGS_CHANGE', async () => {
    const { t, editor, noReauth } = setup();
    t.m.setting.findMany.mockResolvedValue([]);
    t.m.state.findUnique.mockResolvedValue({ code: '27' });
    const rateId = randomUUID();
    t.m.taxRate.findUnique.mockResolvedValue({ isActive: true });
    const payload = {
      sellerGstin: gstin.toLowerCase(),
      sellerStateCode: '27',
      sellerLegalName: 'Example Jewels Pvt Ltd',
      sellerAddress: { line1: 'Shop 4, MG Road', city: 'Pune', pincode: '411001' },
      shippingTaxTreatment: 'FIXED_RATE',
      shippingFixedTaxRateId: rateId,
    };
    expect(
      (await request(t.app).patch(`${BASE}/settings`).set(noReauth.headers).send(payload)).status,
    ).toBe(403);
    const res = await request(t.app).patch(`${BASE}/settings`).set(editor.headers).send(payload);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ sellerGstin: gstin, sellerStateCode: '27' });
    expect(t.m.setting.upsert).toHaveBeenCalledTimes(6);
    const firstUpsert = t.m.setting.upsert.mock.calls[0]?.[0];
    expect(firstUpsert.where.settingKey).toBe('tax.seller_gstin');
    expect(firstUpsert.create).toMatchObject({ groupKey: 'tax', valueType: 'STRING' });
    const audit = t.m.auditLog.create.mock.calls[0]?.[0].data;
    expect(audit).toMatchObject({
      action: 'SETTINGS_CHANGE',
      module: 'tax',
      entityType: 'Setting',
    });

    t.m.setting.upsert.mockClear();
    const clear = await request(t.app)
      .patch(`${BASE}/settings`)
      .set(editor.headers)
      .send({ sellerLegalName: null });
    expect(clear.status).toBe(200);
    expect(t.m.setting.upsert.mock.calls[0]?.[0].update.value).toBeDefined();
  });
});

describe('POST /admin/tax/preview', () => {
  const v1 = randomUUID();
  const v2 = randomUUID();
  const p1 = randomUUID();
  const p2 = randomUUID();
  const c1 = randomUUID();
  const c2 = randomUUID();
  const rate3 = { id: randomUUID(), name: 'GST 3%', rate: new Decimal('3.00'), isActive: true };

  function prime(
    t: ReturnType<typeof setup>['t'],
    stored: { settingKey: string; value: unknown }[],
  ) {
    t.m.setting.findMany.mockResolvedValue(stored);
    t.m.state.findUnique.mockImplementation(({ where }: { where: { code: string } }) =>
      Promise.resolve(
        where.code === '27'
          ? { code: '27', name: 'Maharashtra', isUnionTerritory: false, hasLegislature: false }
          : where.code === '29'
            ? { code: '29', name: 'Karnataka', isUnionTerritory: false, hasLegislature: false }
            : null,
      ),
    );
    t.m.productVariant.findMany.mockResolvedValue([
      { id: v1, sku: 'EAR-MEERA-GLD-S', productId: p1 },
      { id: v2, sku: 'RNG-TARA-SLV-7', productId: p2 },
    ]);
    t.m.product.findMany.mockResolvedValue([
      { id: p1, categoryId: c1, hsnCode: null },
      { id: p2, categoryId: c2, hsnCode: '7113' },
    ]);
    t.m.category.findMany
      .mockResolvedValueOnce([
        { id: c1, parentId: null },
        { id: c2, parentId: c1 },
      ])
      .mockResolvedValue([]);
    t.m.productTaxAssignment.findMany.mockResolvedValue([
      {
        id: 'a-prod',
        targetType: 'PRODUCT',
        productId: p1,
        categoryId: null,
        taxRateId: rate3.id,
        hsnCode: '7117',
        effectiveFrom: day('2026-04-01'),
        effectiveTo: null,
        taxRate: rate3,
      },
      {
        id: 'a-cat',
        targetType: 'CATEGORY',
        productId: null,
        categoryId: c1,
        taxRateId: rate3.id,
        hsnCode: null,
        effectiveFrom: day('2026-04-01'),
        effectiveTo: null,
        taxRate: rate3,
      },
    ]);
  }

  it('reproduces the §3.9 checkout example from configured masters', async () => {
    const { t, viewer } = setup();
    prime(t, [{ settingKey: 'tax.seller_state_code', value: '27' }]);
    const res = await request(t.app)
      .post(`${BASE}/preview`)
      .set(viewer.headers)
      .send({
        lines: [
          { variantId: v1, netLineValue: '2479.26' },
          { variantId: v2, netLineValue: '917.94' },
        ],
        shippingCharge: '99.00',
        destinationStateCode: '27',
      });
    expect(res.status).toBe(200);
    expect(res.body.data.supplyType).toBe('INTRA_STATE');
    expect(res.body.data.placeOfSupply).toEqual({ stateCode: '27', stateName: 'Maharashtra' });
    expect(res.body.data.lines[0]).toMatchObject({
      variantId: v1,
      sku: 'EAR-MEERA-GLD-S',
      source: 'PRODUCT',
      hsnCode: '7117',
      tax: { taxableValue: '2407.05', taxAmount: '72.21' },
    });
    expect(res.body.data.lines[1]).toMatchObject({ source: 'CATEGORY', hsnCode: '7113' });
    expect(res.body.data.totals).toMatchObject({
      taxableTotal: '3394.37',
      cgstTotal: '50.92',
      sgstTotal: '50.91',
      taxTotal: '101.83',
      roundOff: '-0.20',
      grandTotal: '3496.00',
    });
    expect(res.body.data.resolvedAt).toBe('2026-11-19');
    expect(t.m.auditLog.create).not.toHaveBeenCalled();
  });

  it('supports manual lines, inter-state and a past resolution date', async () => {
    const { t, viewer } = setup();
    prime(t, [{ settingKey: 'tax.seller_state_code', value: '27' }]);
    const res = await request(t.app)
      .post(`${BASE}/preview`)
      .set(viewer.headers)
      .send({
        lines: [{ hsnCode: '7117', ratePercent: '3', netLineValue: '1030' }],
        destinationStateCode: '29',
        at: '2026-05-01',
      });
    expect(res.status).toBe(200);
    expect(res.body.data.supplyType).toBe('INTER_STATE');
    expect(res.body.data.lines[0]).toMatchObject({
      source: 'MANUAL',
      tax: { components: [{ component: 'IGST', ratePercent: '3.00', amount: '30.00' }] },
    });
  });

  it('fails closed when masters/settings are incomplete', async () => {
    const { t, viewer } = setup();
    prime(t, []);
    const noSeller = await request(t.app)
      .post(`${BASE}/preview`)
      .set(viewer.headers)
      .send({ lines: [{ variantId: v1, netLineValue: '10' }], destinationStateCode: '27' });
    expect(noSeller.status).toBe(422);
    expect(noSeller.body.error.details[0].code).toBe('TAX_SETTINGS_INCOMPLETE');

    prime(t, [{ settingKey: 'tax.seller_state_code', value: '27' }]);
    const badState = await request(t.app)
      .post(`${BASE}/preview`)
      .set(viewer.headers)
      .send({ lines: [{ variantId: v1, netLineValue: '10' }], destinationStateCode: '98' });
    expect(badState.body.error.details[0].field).toBe('destinationStateCode');

    t.m.productTaxAssignment.findMany.mockResolvedValue([]);
    const unknown = randomUUID();
    const noTax = await request(t.app)
      .post(`${BASE}/preview`)
      .set(viewer.headers)
      .send({
        lines: [
          { variantId: v1, netLineValue: '10' },
          { variantId: unknown, netLineValue: '10' },
        ],
        destinationStateCode: '27',
      });
    expect(noTax.status).toBe(422);
    expect(noTax.body.error.details).toEqual([
      expect.objectContaining({ field: 'lines[0].variantId', code: 'TAX_NOT_CONFIGURED' }),
      expect.objectContaining({ field: 'lines[1].variantId', message: 'Variant not found.' }),
    ]);

    const mixed = await request(t.app)
      .post(`${BASE}/preview`)
      .set(viewer.headers)
      .send({
        lines: [{ variantId: v1, hsnCode: '7117', ratePercent: '3', netLineValue: '10' }],
        destinationStateCode: '27',
      });
    expect(mixed.status).toBe(422);
  });

  it('applies FIXED_RATE shipping from settings and reports a missing fixed rate', async () => {
    const { t, viewer } = setup();
    const fixedId = randomUUID();
    prime(t, [
      { settingKey: 'tax.seller_state_code', value: '27' },
      { settingKey: 'tax.shipping_tax_mode', value: 'FIXED_RATE' },
      { settingKey: 'tax.shipping_fixed_rate_id', value: fixedId },
    ]);
    t.m.taxRate.findUnique.mockResolvedValueOnce({ rate: new Decimal('18'), isActive: true });
    const res = await request(t.app)
      .post(`${BASE}/preview`)
      .set(viewer.headers)
      .send({
        lines: [{ hsnCode: '7117', ratePercent: '3', netLineValue: '1030' }],
        shippingCharge: '118',
        destinationStateCode: '27',
      });
    expect(res.status).toBe(200);
    expect(res.body.data.shipping.tax.taxAmount).toBe('18.00');

    t.m.taxRate.findUnique.mockResolvedValueOnce(null);
    const missing = await request(t.app)
      .post(`${BASE}/preview`)
      .set(viewer.headers)
      .send({
        lines: [{ hsnCode: '7117', ratePercent: '3', netLineValue: '1030' }],
        shippingCharge: '118',
        destinationStateCode: '27',
      });
    expect(missing.body.error.details[0].code).toBe('SHIPPING_FIXED_RATE_MISSING');
  });
});
