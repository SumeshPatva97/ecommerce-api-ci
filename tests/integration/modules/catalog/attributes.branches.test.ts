/**
 * Attributes & attribute values — edge cases through the real Express app. MOCKED DB
 * (tests/helpers/mockDb.ts; no SQL executed). Covers list filters/sorting, not-found and
 * soft-deleted rows, name/code/value/slug duplicates (live and deleted), code allocation, the
 * variant-axis guard, partial updates (incl. no-op updates) and restore.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import type { Attribute, AttributeValue } from '../../../../src/generated/prisma/client.js';
import { createAttributesModule } from '../../../../src/modules/attributes/index.js';
import { codeFromName } from '../../../../src/modules/attributes/attributes.service.js';
import { buildModuleTestApp, type ModuleTestApp } from '../../../helpers/container.js';
import { attributeRow, ids, valueRow } from './fixtures.js';

const ALL = ['attributes.view', 'attributes.create', 'attributes.update', 'attributes.delete'];
const BASE = '/api/v1/admin/attributes';

function setup() {
  const t = buildModuleTestApp([createAttributesModule]);
  return { t, auth: t.staff({ permissions: ALL }).headers };
}

interface AttrWhere {
  id?: string;
  code?: string;
  nameNormalized?: string;
}

/** Routes `attribute.findUnique` by lookup key (id / code / nameNormalized). */
function serveAttribute(
  t: ModuleTestApp,
  opts: {
    byId?: Attribute | null;
    byName?: Attribute | null;
    takenCodes?: (code: string) => boolean;
  },
): void {
  t.m.attribute.findUnique.mockImplementation(({ where }: { where: AttrWhere }) => {
    if (where.id !== undefined) return Promise.resolve(opts.byId ?? null);
    if (where.nameNormalized !== undefined) return Promise.resolve(opts.byName ?? null);
    if (where.code !== undefined) {
      return Promise.resolve(opts.takenCodes?.(where.code) === true ? attributeRow() : null);
    }
    return Promise.resolve(null);
  });
}

interface ValueWhere {
  id?: string;
  attributeId_valueNormalized?: { valueNormalized: string };
  attributeId_slug?: { slug: string };
}

/** Routes `attributeValue.findUnique` by lookup key (id / normalized value / slug). */
function serveValue(
  t: ModuleTestApp,
  opts: {
    byId?: AttributeValue | null;
    byValue?: AttributeValue | null;
    bySlug?: AttributeValue | null;
  },
): void {
  t.m.attributeValue.findUnique.mockImplementation(({ where }: { where: ValueWhere }) => {
    if (where.id !== undefined) return Promise.resolve(opts.byId ?? null);
    if (where.attributeId_valueNormalized !== undefined) {
      return Promise.resolve(opts.byValue ?? null);
    }
    if (where.attributeId_slug !== undefined) return Promise.resolve(opts.bySlug ?? null);
    return Promise.resolve(null);
  });
}

const echoAttribute = (t: ModuleTestApp) => {
  t.m.attribute.create.mockImplementation(({ data }: { data: Partial<Attribute> }) =>
    Promise.resolve(attributeRow(data)),
  );
};

describe('codeFromName', () => {
  it('derives snake_case codes, falls back to "attr" and suffixes reserved listing keys', () => {
    expect(codeFromName('Metal Finish')).toBe('metal_finish');
    expect(codeFromName('!!!')).toBe('attr');
    expect(codeFromName('Sort')).toBe('sort_attr');
    expect(codeFromName('x'.repeat(80))).toHaveLength(50);
  });
});

describe('GET /admin/attributes', () => {
  it('lists with the default sort (sortOrder, then name) and live value counts', async () => {
    const { t, auth } = setup();
    t.m.attribute.findMany.mockResolvedValue([{ ...attributeRow(), _count: { values: 3 } }]);
    t.m.attribute.count.mockResolvedValue(1);
    const res = await request(t.app).get(BASE).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ code: 'metal_finish', valueCount: 3 });
    const args = t.m.attribute.findMany.mock.calls[0]?.[0];
    expect(args.where).toEqual({ deletedAt: null });
    expect(args.orderBy).toEqual([{ sortOrder: 'asc' }, { name: 'asc' }]);
  });

  it('applies q, status, axis/filterable flags and a descending sort', async () => {
    const { t, auth } = setup();
    t.m.attribute.findMany.mockResolvedValue([]);
    t.m.attribute.count.mockResolvedValue(0);
    const res = await request(t.app).get(BASE).set(auth).query({
      q: 'size',
      status: 'INACTIVE',
      isVariantAxis: 'true',
      isFilterable: 'false',
      sort: '-name',
    });
    expect(res.status).toBe(200);
    const args = t.m.attribute.findMany.mock.calls[0]?.[0];
    expect(args.where).toEqual({
      deletedAt: null,
      isActive: false,
      OR: [{ name: { contains: 'size' } }, { code: { contains: 'size' } }],
      isVariantAxis: true,
      isFilterable: false,
    });
    expect(args.orderBy).toEqual([{ name: 'desc' }, { name: 'asc' }]);
  });
});

describe('GET /admin/attributes/:attributeId', () => {
  it('404s an unknown attribute and returns a known one with its value count', async () => {
    const { t, auth } = setup();
    serveAttribute(t, {});
    const missing = await request(t.app).get(`${BASE}/${ids()}`).set(auth);
    expect(missing.status).toBe(404);
    const row = { ...attributeRow({ isActive: false }), _count: { values: 2 } };
    t.m.attribute.findUnique.mockResolvedValue(row);
    const res = await request(t.app).get(`${BASE}/${row.id}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: row.id, status: 'INACTIVE', valueCount: 2 });
  });
});

describe('POST /admin/attributes — duplicates & code allocation', () => {
  it('rejects a name used by a live attribute (409, no deleted flag)', async () => {
    const { t, auth } = setup();
    const clash = attributeRow();
    serveAttribute(t, { byName: clash });
    const res = await request(t.app).post(BASE).set(auth).send({ name: 'Metal  FINISH' });
    expect(res.status).toBe(409);
    expect(res.body.error.details[0]).toEqual({
      field: 'name',
      code: 'DUPLICATE',
      message: 'Attribute "Metal  FINISH" already exists.',
      meta: { normalized: 'metal finish', existingId: clash.id },
    });
    expect(t.m.attribute.create).not.toHaveBeenCalled();
  });

  it('a soft-deleted attribute still reserves its name (meta.deleted)', async () => {
    const { t, auth } = setup();
    serveAttribute(t, { byName: attributeRow({ deletedAt: new Date() }) });
    const res = await request(t.app).post(BASE).set(auth).send({ name: 'Metal Finish' });
    expect(res.status).toBe(409);
    expect(res.body.error.details[0].meta).toMatchObject({ deleted: true });
  });

  it('suffixes the generated code when it is taken and applies defaults', async () => {
    const { t, auth } = setup();
    serveAttribute(t, { takenCodes: (c) => c === 'ring_size' });
    echoAttribute(t);
    const res = await request(t.app).post(BASE).set(auth).send({ name: 'Ring Size' });
    expect(res.status).toBe(201);
    expect(t.m.attribute.create.mock.calls[0]?.[0].data).toMatchObject({
      code: 'ring_size_2',
      displayType: 'BUTTON',
      isVariantAxis: false,
      isFilterable: false,
      isVisibleOnPdp: true,
      unit: null,
      sortOrder: 0,
      isActive: true,
    });
  });

  it('stores explicit flags, unit and INACTIVE status', async () => {
    const { t, auth } = setup();
    serveAttribute(t, {});
    echoAttribute(t);
    const res = await request(t.app).post(BASE).set(auth).send({
      name: 'Weight',
      code: 'weight',
      displayType: 'DROPDOWN',
      isVariantAxis: true,
      isFilterable: true,
      isVisibleOnPdp: false,
      unit: 'g',
      sortOrder: 4,
      status: 'INACTIVE',
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ code: 'weight', status: 'INACTIVE', unit: 'g' });
    expect(t.m.attribute.create.mock.calls[0]?.[0].data).toMatchObject({
      displayType: 'DROPDOWN',
      isVariantAxis: true,
      isFilterable: true,
      isVisibleOnPdp: false,
      sortOrder: 4,
      isActive: false,
    });
  });

  it('gives up with 409 CONFLICT when no code candidate is free', async () => {
    const { t, auth } = setup();
    serveAttribute(t, { takenCodes: () => true });
    const res = await request(t.app).post(BASE).set(auth).send({ name: 'Colour' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body.error.message).toBe('Could not allocate a unique attribute code.');
    // base + _2 … _50
    expect(
      t.m.attribute.findUnique.mock.calls.filter(
        (c) => (c[0] as { where: AttrWhere }).where.code !== undefined,
      ),
    ).toHaveLength(50);
  });
});

describe('PATCH /admin/attributes/:attributeId', () => {
  it('404s unknown and soft-deleted attributes', async () => {
    const { t, auth } = setup();
    const missing = await request(t.app).patch(`${BASE}/${ids()}`).set(auth).send({ sortOrder: 1 });
    expect(missing.status).toBe(404);
    const deleted = attributeRow({ deletedAt: new Date() });
    serveAttribute(t, { byId: deleted });
    const gone = await request(t.app)
      .patch(`${BASE}/${deleted.id}`)
      .set(auth)
      .send({ sortOrder: 1 });
    expect(gone.status).toBe(404);
  });

  it('blocks dropping isVariantAxis while a category rule uses it as an axis default', async () => {
    const { t, auth } = setup();
    const row = attributeRow({ isVariantAxis: true });
    serveAttribute(t, { byId: row });
    t.m.variantAttributeValue.count.mockResolvedValue(0);
    t.m.productAttributeValue.count.mockResolvedValue(0);
    t.m.categoryAttribute.count.mockResolvedValue(2);
    const res = await request(t.app)
      .patch(`${BASE}/${row.id}`)
      .set(auth)
      .send({ isVariantAxis: false });
    expect(res.status).toBe(409);
    expect(res.body.error.details[0].meta).toEqual({ variants: 0, categoryAxisDefaults: 2 });
  });

  it('drops isVariantAxis when unused and renames (own name is not a clash)', async () => {
    const { t, auth } = setup();
    const row = attributeRow({ isVariantAxis: true });
    serveAttribute(t, { byId: row, byName: row });
    t.m.variantAttributeValue.count.mockResolvedValue(0);
    t.m.productAttributeValue.count.mockResolvedValue(0);
    t.m.categoryAttribute.count.mockResolvedValue(0);
    t.m.attribute.update.mockImplementation(({ data }: { data: Partial<Attribute> }) =>
      Promise.resolve({ ...row, ...data }),
    );
    const res = await request(t.app)
      .patch(`${BASE}/${row.id}`)
      .set(auth)
      .send({ name: 'Metal finish', isVariantAxis: false, displayType: 'TEXT', unit: null });
    expect(res.status).toBe(200);
    expect(t.m.attribute.update.mock.calls[0]?.[0].data).toEqual({
      name: 'Metal finish',
      nameNormalized: 'metal finish',
      displayType: 'TEXT',
      isVariantAxis: false,
      unit: null,
    });
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data.action).toBe('UPDATE');
  });

  it('renaming onto another attribute is 409', async () => {
    const { t, auth } = setup();
    const row = attributeRow();
    serveAttribute(t, { byId: row, byName: attributeRow({ name: 'Size' }) });
    const res = await request(t.app).patch(`${BASE}/${row.id}`).set(auth).send({ name: 'Size' });
    expect(res.status).toBe(409);
    expect(res.body.error.details[0].field).toBe('name');
  });

  it('a status-only change is audited as STATUS_CHANGE', async () => {
    const { t, auth } = setup();
    const row = attributeRow();
    serveAttribute(t, { byId: row });
    t.m.attribute.update.mockResolvedValue({ ...row, isActive: false });
    const res = await request(t.app)
      .patch(`${BASE}/${row.id}`)
      .set(auth)
      .send({ status: 'INACTIVE' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('INACTIVE');
    expect(t.m.attribute.update.mock.calls[0]?.[0].data).toEqual({ isActive: false });
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data.action).toBe('STATUS_CHANGE');
  });

  it('an update that changes nothing writes nothing', async () => {
    const { t, auth } = setup();
    const row = attributeRow({ sortOrder: 3 });
    serveAttribute(t, { byId: row });
    const res = await request(t.app)
      .patch(`${BASE}/${row.id}`)
      .set(auth)
      .send({ sortOrder: 3, status: 'ACTIVE' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: row.id, sortOrder: 3 });
    expect(t.m.attribute.update).not.toHaveBeenCalled();
    expect(t.m.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('DELETE / restore /admin/attributes/:attributeId', () => {
  it('delete 404s an already-deleted attribute', async () => {
    const { t, auth } = setup();
    serveAttribute(t, { byId: attributeRow({ deletedAt: new Date() }) });
    const res = await request(t.app).delete(`${BASE}/${ids()}`).set(auth);
    expect(res.status).toBe(404);
  });

  it('restore: 404 unknown, 409 when not deleted, RESTORE audit on success', async () => {
    const { t, auth } = setup();
    serveAttribute(t, {});
    const missing = await request(t.app).post(`${BASE}/${ids()}/restore`).set(auth);
    expect(missing.status).toBe(404);

    const live = attributeRow();
    serveAttribute(t, { byId: live });
    const notDeleted = await request(t.app).post(`${BASE}/${live.id}/restore`).set(auth);
    expect(notDeleted.status).toBe(409);
    expect(notDeleted.body.error.code).toBe('INVALID_STATE_TRANSITION');

    const deleted = attributeRow({ deletedAt: new Date() });
    serveAttribute(t, { byId: deleted });
    t.m.attribute.update.mockResolvedValue({ ...deleted, deletedAt: null });
    const ok = await request(t.app).post(`${BASE}/${deleted.id}/restore`).set(auth);
    expect(ok.status).toBe(200);
    expect(ok.body.data.deletedAt).toBeNull();
    expect(t.m.attribute.update.mock.calls[0]?.[0].data).toEqual({ deletedAt: null });
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data.action).toBe('RESTORE');
  });
});

describe('attribute values — list & get', () => {
  it('list 404s an unknown attribute; filters by q/status and sorts', async () => {
    const { t, auth } = setup();
    serveAttribute(t, {});
    const missing = await request(t.app).get(`${BASE}/${ids()}/values`).set(auth);
    expect(missing.status).toBe(404);

    const attr = attributeRow();
    serveAttribute(t, { byId: attr });
    t.m.attributeValue.findMany.mockResolvedValue([]);
    t.m.attributeValue.count.mockResolvedValue(0);
    const res = await request(t.app)
      .get(`${BASE}/${attr.id}/values`)
      .set(auth)
      .query({ q: 'gold', status: 'DELETED', sort: '-value' });
    expect(res.status).toBe(200);
    const args = t.m.attributeValue.findMany.mock.calls[0]?.[0];
    expect(args.where).toEqual({
      attributeId: attr.id,
      deletedAt: { not: null },
      value: { contains: 'gold' },
    });
    expect(args.orderBy).toEqual([{ value: 'desc' }, { value: 'asc' }]);
  });

  it('get returns a value of the attribute and 404s one of another attribute', async () => {
    const { t, auth } = setup();
    const attr = attributeRow();
    const value = valueRow({ attributeId: attr.id });
    serveValue(t, { byId: value });
    const ok = await request(t.app).get(`${BASE}/${attr.id}/values/${value.id}`).set(auth);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ id: value.id, hexColor: '#B76E79', status: 'ACTIVE' });
    const other = await request(t.app).get(`${BASE}/${ids()}/values/${value.id}`).set(auth);
    expect(other.status).toBe(404);
  });
});

describe('attribute values — create', () => {
  const echoValue = (t: ModuleTestApp) => {
    t.m.attributeValue.create.mockImplementation(({ data }: { data: Partial<AttributeValue> }) =>
      Promise.resolve(valueRow(data)),
    );
  };

  it('404s a soft-deleted attribute', async () => {
    const { t, auth } = setup();
    serveAttribute(t, { byId: attributeRow({ deletedAt: new Date() }) });
    const res = await request(t.app)
      .post(`${BASE}/${ids()}/values`)
      .set(auth)
      .send({ value: 'Gold' });
    expect(res.status).toBe(404);
  });

  it('rejects a swatch image on a non-SWATCH attribute but accepts a null colour', async () => {
    const { t, auth } = setup();
    const attr = attributeRow({ displayType: 'BUTTON' });
    serveAttribute(t, { byId: attr });
    serveValue(t, {});
    echoValue(t);
    const bad = await request(t.app)
      .post(`${BASE}/${attr.id}/values`)
      .set(auth)
      .send({ value: 'Small', swatchImageUrl: 'https://img.example/s.png' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details[0]).toMatchObject({
      field: 'swatchImageUrl',
      code: 'SWATCH_ONLY',
    });
    const ok = await request(t.app)
      .post(`${BASE}/${attr.id}/values`)
      .set(auth)
      .send({ value: 'Small', hexColor: null, swatchImageUrl: null, status: 'INACTIVE' });
    expect(ok.status).toBe(201);
    expect(t.m.attributeValue.create.mock.calls[0]?.[0].data).toMatchObject({
      swatchHex: null,
      swatchImageUrl: null,
      isActive: false,
      sortOrder: 0,
    });
  });

  it('a soft-deleted value still reserves its text (409 meta.deleted)', async () => {
    const { t, auth } = setup();
    const attr = attributeRow();
    serveAttribute(t, { byId: attr });
    serveValue(t, { byValue: valueRow({ attributeId: attr.id, deletedAt: new Date() }) });
    const res = await request(t.app)
      .post(`${BASE}/${attr.id}/values`)
      .set(auth)
      .send({ value: 'Rose Gold' });
    expect(res.status).toBe(409);
    expect(res.body.error.details[0].meta).toMatchObject({ deleted: true });
  });

  it('an explicit slug must be free; a free one is stored as given', async () => {
    const { t, auth } = setup();
    const attr = attributeRow();
    serveAttribute(t, { byId: attr });
    const holder = valueRow({ attributeId: attr.id, slug: 'rg' });
    serveValue(t, { bySlug: holder });
    const taken = await request(t.app)
      .post(`${BASE}/${attr.id}/values`)
      .set(auth)
      .send({ value: 'Rose Gold', slug: 'rg' });
    expect(taken.status).toBe(409);
    expect(taken.body.error.details[0]).toMatchObject({
      field: 'slug',
      meta: { existingId: holder.id },
    });

    serveValue(t, {});
    echoValue(t);
    const ok = await request(t.app).post(`${BASE}/${attr.id}/values`).set(auth).send({
      value: 'Rose Gold',
      slug: 'rg',
      swatchImageUrl: 'https://img.example/rg.png',
      sortOrder: 2,
    });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({
      slug: 'rg',
      swatchImageUrl: 'https://img.example/rg.png',
      sortOrder: 2,
    });
  });
});

describe('attribute values — update', () => {
  function prime(t: ModuleTestApp, over: Partial<AttributeValue> = {}) {
    const attr = attributeRow();
    const value = valueRow({ attributeId: attr.id, ...over });
    serveAttribute(t, { byId: attr });
    t.m.attributeValue.update.mockImplementation(({ data }: { data: Partial<AttributeValue> }) =>
      Promise.resolve({ ...value, ...data }),
    );
    return { attr, value, url: `${BASE}/${attr.id}/values/${value.id}` };
  }

  it('404s a soft-deleted value', async () => {
    const { t, auth } = setup();
    const { value, url } = prime(t, { deletedAt: new Date() });
    serveValue(t, { byId: value });
    const res = await request(t.app).patch(url).set(auth).send({ sortOrder: 1 });
    expect(res.status).toBe(404);
  });

  it('renames (own row is not a clash), re-slugs to a free slug and changes status', async () => {
    const { t, auth } = setup();
    const { value, url } = prime(t);
    serveValue(t, { byId: value, byValue: value });
    const res = await request(t.app)
      .patch(url)
      .set(auth)
      .send({ value: 'Rose  gold', slug: 'rose-gold-2', status: 'INACTIVE', hexColor: '#000000' });
    expect(res.status).toBe(200);
    expect(t.m.attributeValue.update.mock.calls[0]?.[0].data).toEqual({
      value: 'Rose  gold',
      valueNormalized: 'rose gold',
      slug: 'rose-gold-2',
      swatchHex: '#000000',
      isActive: false,
    });
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data.action).toBe('UPDATE');
  });

  it('a slug taken by another value is 409; the unchanged slug is not re-checked', async () => {
    const { t, auth } = setup();
    const { value, url } = prime(t);
    serveValue(t, { byId: value, bySlug: valueRow({ attributeId: value.attributeId }) });
    const taken = await request(t.app).patch(url).set(auth).send({ slug: 'taken-slug' });
    expect(taken.status).toBe(409);
    expect(taken.body.error.details[0].field).toBe('slug');

    t.m.attributeValue.findUnique.mockClear();
    const same = await request(t.app).patch(url).set(auth).send({ slug: value.slug });
    expect(same.status).toBe(200);
    const slugLookups = t.m.attributeValue.findUnique.mock.calls.filter(
      (c) => (c[0] as { where: ValueWhere }).where.attributeId_slug !== undefined,
    );
    expect(slugLookups).toHaveLength(0);
    expect(t.m.attributeValue.update).not.toHaveBeenCalled(); // nothing changed
  });

  it('a value clashing with a sibling is 409', async () => {
    const { t, auth } = setup();
    const { value, url } = prime(t);
    serveValue(t, { byId: value, byValue: valueRow({ attributeId: value.attributeId }) });
    const res = await request(t.app).patch(url).set(auth).send({ value: 'Rose Gold' });
    expect(res.status).toBe(409);
    expect(res.body.error.details[0].field).toBe('value');
  });
});
