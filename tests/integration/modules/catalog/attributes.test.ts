/**
 * Attributes & attribute values — admin CRUD, uniqueness, delete-if-unused, axis guard.
 * MOCKED DB (tests/helpers/mockDb.ts): verifies HTTP contract, guards, service rules and audit
 * calls; no SQL is executed.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createAttributesModule } from '../../../../src/modules/attributes/index.js';
import { buildModuleTestApp } from '../../../helpers/container.js';
import { expectAdminRoutesGuarded } from '../../../helpers/routeTable.js';
import { attributeRow, ids, valueRow } from './fixtures.js';

const ALL = ['attributes.view', 'attributes.create', 'attributes.update', 'attributes.delete'];

function setup() {
  const t = buildModuleTestApp([createAttributesModule]);
  return { t, auth: t.staff({ permissions: ALL }).headers };
}

describe('admin attributes', () => {
  it('guards every admin route with an attributes.* permission; no public routes', () => {
    const { t } = setup();
    const module = createAttributesModule(t.container);
    expect(module.publicRouter).toBeUndefined();
    const routes = expectAdminRoutesGuarded(module);
    expect(routes).toHaveLength(11);
    for (const r of routes) expect(r.permissions[0]).toMatch(/^attributes\./);
  });

  it('creates an attribute with a generated code and audits CREATE', async () => {
    const { t, auth } = setup();
    t.m.attribute.findUnique.mockResolvedValue(null);
    t.m.attribute.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve(attributeRow(data)),
    );
    const res = await request(t.app)
      .post('/api/v1/admin/attributes')
      .set(auth)
      .send({ name: 'Metal Finish', displayType: 'SWATCH', isVariantAxis: true });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ code: 'metal_finish', displayType: 'SWATCH' });
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data).toMatchObject({
      action: 'CREATE',
      entityType: 'Attribute',
    });
  });

  it('rejects reserved/invalid codes and bad display types (422); duplicate code → 409', async () => {
    const { t, auth } = setup();
    const reserved = await request(t.app)
      .post('/api/v1/admin/attributes')
      .set(auth)
      .send({ name: 'Sorting', code: 'sort' });
    expect(reserved.status).toBe(422);
    const invalid = await request(t.app)
      .post('/api/v1/admin/attributes')
      .set(auth)
      .send({ name: 'Size', code: 'ring-size', displayType: 'RADIO' });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error.details).toHaveLength(2);

    const existing = attributeRow({ code: 'size' });
    t.m.attribute.findUnique.mockImplementation(({ where }: { where: { code?: string } }) =>
      Promise.resolve(where.code === 'size' ? existing : null),
    );
    const dup = await request(t.app)
      .post('/api/v1/admin/attributes')
      .set(auth)
      .send({ name: 'Ring Size', code: 'size' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.details[0].field).toBe('code');
  });

  it('does not allow changing code (immutable) via PATCH', async () => {
    const { t, auth } = setup();
    const res = await request(t.app)
      .patch(`/api/v1/admin/attributes/${ids()}`)
      .set(auth)
      .send({ code: 'other' });
    expect(res.status).toBe(422);
  });

  it('blocks switching off isVariantAxis while variants use it (409 IN_USE)', async () => {
    const { t, auth } = setup();
    const row = attributeRow({ isVariantAxis: true });
    t.m.attribute.findUnique.mockResolvedValue(row);
    t.m.variantAttributeValue.count.mockResolvedValue(4);
    t.m.productAttributeValue.count.mockResolvedValue(0);
    t.m.categoryAttribute.count.mockResolvedValue(0);
    const res = await request(t.app)
      .patch(`/api/v1/admin/attributes/${row.id}`)
      .set(auth)
      .send({ isVariantAxis: false });
    expect(res.status).toBe(409);
    expect(res.body.error.details[0]).toMatchObject({ code: 'IN_USE', meta: { variants: 4 } });
    expect(t.m.attribute.update).not.toHaveBeenCalled();
  });

  it('deletes only unused attributes', async () => {
    const { t, auth } = setup();
    const row = attributeRow();
    t.m.attribute.findUnique.mockResolvedValue(row);
    t.m.variantAttributeValue.count.mockResolvedValue(0);
    t.m.productAttributeValue.count.mockResolvedValue(0);
    t.m.categoryAttribute.count.mockResolvedValueOnce(1);
    const blocked = await request(t.app).delete(`/api/v1/admin/attributes/${row.id}`).set(auth);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.details[0].meta).toMatchObject({ categoryRules: 1 });

    t.m.categoryAttribute.count.mockResolvedValueOnce(0);
    t.m.attribute.update.mockResolvedValue({ ...row, deletedAt: t.now.value });
    const ok = await request(t.app).delete(`/api/v1/admin/attributes/${row.id}`).set(auth);
    expect(ok.status).toBe(200);
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data.action).toBe('DELETE');
  });
});

describe('admin attribute values', () => {
  it('creates a value (hex upper-cased, slug generated) for a SWATCH attribute', async () => {
    const { t, auth } = setup();
    const attr = attributeRow({ displayType: 'SWATCH' });
    t.m.attribute.findUnique.mockResolvedValue(attr);
    t.m.attributeValue.findUnique.mockResolvedValue(null);
    t.m.attributeValue.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve(valueRow(data)),
    );
    const res = await request(t.app)
      .post(`/api/v1/admin/attributes/${attr.id}/values`)
      .set(auth)
      .send({ value: 'Rose  Gold', hexColor: '#b76e79' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      attributeId: attr.id,
      slug: 'rose-gold',
      hexColor: '#B76E79',
    });
    expect(t.m.attributeValue.create.mock.calls[0]?.[0].data.valueNormalized).toBe('rose gold');
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data.entityType).toBe('AttributeValue');
  });

  it('returns the documented duplicate error for a value clash in the same attribute', async () => {
    const { t, auth } = setup();
    const attr = attributeRow();
    const existing = valueRow({ attributeId: attr.id });
    t.m.attribute.findUnique.mockResolvedValue(attr);
    t.m.attributeValue.findUnique.mockResolvedValueOnce(existing);
    const res = await request(t.app)
      .post(`/api/v1/admin/attributes/${attr.id}/values`)
      .set(auth)
      .send({ value: 'Rose  Gold' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('Value "Rose  Gold" already exists for Metal Finish.');
    expect(res.body.error.details[0]).toMatchObject({
      field: 'value',
      meta: { normalized: 'rose gold', existingId: existing.id },
    });
    expect(t.m.attributeValue.findUnique.mock.calls[0]?.[0].where).toEqual({
      attributeId_valueNormalized: { attributeId: attr.id, valueNormalized: 'rose gold' },
    });
  });

  it('rejects hexColor on non-SWATCH attributes and malformed hex (422)', async () => {
    const { t, auth } = setup();
    const attr = attributeRow({ displayType: 'BUTTON' });
    t.m.attribute.findUnique.mockResolvedValue(attr);
    const swatchOnly = await request(t.app)
      .post(`/api/v1/admin/attributes/${attr.id}/values`)
      .set(auth)
      .send({ value: 'Small', hexColor: '#FFFFFF' });
    expect(swatchOnly.status).toBe(422);
    expect(swatchOnly.body.error.details[0].code).toBe('SWATCH_ONLY');
    const malformed = await request(t.app)
      .post(`/api/v1/admin/attributes/${attr.id}/values`)
      .set(auth)
      .send({ value: 'Small', hexColor: 'red' });
    expect(malformed.status).toBe(422);
  });

  it('404s a value that belongs to another attribute', async () => {
    const { t, auth } = setup();
    const attr = attributeRow();
    t.m.attribute.findUnique.mockResolvedValue(attr);
    t.m.attributeValue.findUnique.mockResolvedValue(valueRow());
    const res = await request(t.app)
      .patch(`/api/v1/admin/attributes/${attr.id}/values/${ids()}`)
      .set(auth)
      .send({ sortOrder: 2 });
    expect(res.status).toBe(404);
  });

  it('blocks deleting a value used by variants; soft-deletes an unused one', async () => {
    const { t, auth } = setup();
    const attr = attributeRow();
    const value = valueRow({ attributeId: attr.id });
    t.m.attributeValue.findUnique.mockResolvedValue(value);
    t.m.variantAttributeValue.count.mockResolvedValueOnce(3);
    t.m.productAttributeValue.count.mockResolvedValue(0);
    const blocked = await request(t.app)
      .delete(`/api/v1/admin/attributes/${attr.id}/values/${value.id}`)
      .set(auth);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.details[0]).toMatchObject({ code: 'IN_USE', meta: { variants: 3 } });

    t.m.variantAttributeValue.count.mockResolvedValueOnce(0);
    t.m.attributeValue.update.mockResolvedValue({ ...value, deletedAt: t.now.value });
    const res = await request(t.app)
      .delete(`/api/v1/admin/attributes/${attr.id}/values/${value.id}`)
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: value.id, deleted: true });
  });

  it('lists values of an attribute with pagination and 403 without attributes.view', async () => {
    const { t, auth } = setup();
    const attr = attributeRow();
    t.m.attribute.findUnique.mockResolvedValue(attr);
    t.m.attributeValue.findMany.mockResolvedValue([valueRow({ attributeId: attr.id })]);
    t.m.attributeValue.count.mockResolvedValue(1);
    const res = await request(t.app)
      .get(`/api/v1/admin/attributes/${attr.id}/values?limit=10`)
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ limit: 10, totalItems: 1 });
    expect(t.m.attributeValue.findMany.mock.calls[0]?.[0].where).toMatchObject({
      attributeId: attr.id,
      deletedAt: null,
    });
    const other = t.staff({ permissions: ['brands.view'] });
    expect(
      (await request(t.app).get(`/api/v1/admin/attributes/${attr.id}/values`).set(other.headers))
        .status,
    ).toBe(403);
  });
});

describe('Phase 4 catalogue gaps — attribute value uniqueness scope', () => {
  it('TC-019: the same value is a 409 within one attribute but allowed in a different attribute', async () => {
    const { t, auth } = setup();
    const finish = attributeRow({ displayType: 'BUTTON' });
    const plating = attributeRow({
      name: 'Plating',
      nameNormalized: 'plating',
      code: 'plating',
      displayType: 'BUTTON',
    });
    const existing = valueRow({ attributeId: finish.id });
    t.m.attribute.findUnique.mockImplementation((args: { where: { id?: string } }) =>
      Promise.resolve(
        args.where.id === finish.id ? finish : args.where.id === plating.id ? plating : null,
      ),
    );
    // Unique key (attribute_id, value_normalized): "rose gold" exists only under `finish`.
    t.m.attributeValue.findUnique.mockImplementation(
      (args: {
        where: { attributeId_valueNormalized?: { attributeId: string; valueNormalized: string } };
      }) => {
        const key = args.where.attributeId_valueNormalized;
        return Promise.resolve(
          key?.attributeId === finish.id && key.valueNormalized === 'rose gold' ? existing : null,
        );
      },
    );
    t.m.attributeValue.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve(valueRow(data)),
    );

    const other = await request(t.app)
      .post(`/api/v1/admin/attributes/${plating.id}/values`)
      .set(auth)
      .send({ value: 'Rose Gold' });
    expect(other.status).toBe(201);
    expect(other.body.data).toMatchObject({ attributeId: plating.id, value: 'Rose Gold' });
    expect(t.m.attributeValue.create.mock.calls[0]?.[0].data).toMatchObject({
      attributeId: plating.id,
      valueNormalized: 'rose gold',
    });

    const same = await request(t.app)
      .post(`/api/v1/admin/attributes/${finish.id}/values`)
      .set(auth)
      .send({ value: 'Rose Gold' });
    expect(same.status).toBe(409);
    expect(same.body.error.details[0]).toMatchObject({
      field: 'value',
      meta: { normalized: 'rose gold', existingId: existing.id },
    });
    expect(t.m.attributeValue.create).toHaveBeenCalledTimes(1);
  });
});
