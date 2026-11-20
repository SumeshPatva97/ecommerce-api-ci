/**
 * Collections — admin CRUD, membership replace, public list/detail through the real Express app.
 * MOCKED DB (tests/helpers/mockDb.ts): verifies HTTP contract, guards, service rules and audit
 * calls; no SQL is executed.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createCollectionsModule } from '../../../../src/modules/collections/index.js';
import { buildModuleTestApp } from '../../../helpers/container.js';
import { expectAdminRoutesGuarded } from '../../../helpers/routeTable.js';
import { collectionRow, ids } from './fixtures.js';

const ALL = ['collections.view', 'collections.create', 'collections.update', 'collections.delete'];

function setup() {
  const t = buildModuleTestApp([createCollectionsModule]);
  return { t, auth: t.staff({ permissions: ALL }).headers };
}

describe('admin collections', () => {
  it('guards every admin route with a collections.* permission', () => {
    const { t } = setup();
    const routes = expectAdminRoutesGuarded(createCollectionsModule(t.container));
    expect(routes.map((r) => `${r.method} ${r.path} ${r.permissions.join(',')}`)).toEqual([
      'GET /collections collections.view',
      'POST /collections collections.create',
      'GET /collections/:collectionId collections.view',
      'PATCH /collections/:collectionId collections.update',
      'DELETE /collections/:collectionId collections.delete',
      'POST /collections/:collectionId/restore collections.delete',
      'PUT /collections/:collectionId/products collections.update',
    ]);
  });

  it('creates a collection with a window and audits CREATE', async () => {
    const { t, auth } = setup();
    t.m.collection.findUnique.mockResolvedValue(null);
    t.m.collection.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve(collectionRow(data)),
    );
    const res = await request(t.app)
      .post('/api/v1/admin/collections')
      .set(auth)
      .send({
        name: 'Bridal Edit',
        isFeatured: true,
        startsAt: '2026-12-01T00:00:00.000Z',
        endsAt: '2027-01-31T00:00:00.000Z',
        heroImage: { url: 'https://res.cloudinary.com/x/hero', publicId: 'collections/bridal' },
      });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      slug: 'bridal-edit',
      isFeatured: true,
      startsAt: '2026-12-01T00:00:00.000Z',
      heroImage: { url: 'https://res.cloudinary.com/x/hero', publicId: 'collections/bridal' },
    });
    expect(t.m.collection.create.mock.calls[0]?.[0].data).toMatchObject({
      bannerImagePid: 'collections/bridal',
      nameNormalized: 'bridal edit',
    });
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data.action).toBe('CREATE');
  });

  it('rejects endsAt <= startsAt with 422 (body and merged PATCH)', async () => {
    const { t, auth } = setup();
    const bad = await request(t.app).post('/api/v1/admin/collections').set(auth).send({
      name: 'Bridal Edit',
      startsAt: '2026-12-01T00:00:00.000Z',
      endsAt: '2026-11-01T00:00:00.000Z',
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details[0].field).toBe('endsAt');

    const row = collectionRow({ startsAt: new Date('2026-12-01T00:00:00.000Z') });
    t.m.collection.findUnique.mockResolvedValue(row);
    const patch = await request(t.app)
      .patch(`/api/v1/admin/collections/${row.id}`)
      .set(auth)
      .send({ endsAt: '2026-11-15T00:00:00.000Z' });
    expect(patch.status).toBe(422);
    expect(patch.body.error.details[0].code).toBe('INVALID_WINDOW');
  });

  it('returns 409 for a duplicate collection name', async () => {
    const { t, auth } = setup();
    t.m.collection.findUnique.mockResolvedValueOnce(collectionRow({ deletedAt: new Date() }));
    const res = await request(t.app)
      .post('/api/v1/admin/collections')
      .set(auth)
      .send({ name: 'bridal   EDIT' });
    expect(res.status).toBe(409);
    // PROVISIONAL (OQ-39): a soft-deleted name stays reserved.
    expect(res.body.error.details[0].meta).toMatchObject({ deleted: true });
  });

  it('replaces ordered membership, validating products and auditing the change', async () => {
    const { t } = setup();
    const staff = t.staff({ permissions: ['collections.update'] });
    const row = collectionRow();
    const [p1, p2, p3] = [ids(), ids(), ids()];
    t.m.collection.findUnique.mockResolvedValue(row);
    t.m.product.findMany.mockResolvedValue([{ id: p1 }, { id: p2 }]);
    t.m.collectionProduct.findMany.mockResolvedValue([{ productId: p3 }]);
    const res = await request(t.app)
      .put(`/api/v1/admin/collections/${row.id}/products`)
      .set(staff.headers)
      .send({ productIds: [p2, p1] });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ collectionId: row.id, productIds: [p2, p1], count: 2 });
    expect(t.m.collectionProduct.deleteMany).toHaveBeenCalledWith({
      where: { collectionId: row.id },
    });
    const created = t.m.collectionProduct.createMany.mock.calls[0]?.[0].data;
    expect(created).toEqual([
      expect.objectContaining({ productId: p2, sortOrder: 0, addedById: staff.ctx.userId }),
      expect.objectContaining({ productId: p1, sortOrder: 1 }),
    ]);
    const audit = t.m.auditLog.create.mock.calls[0]?.[0].data;
    expect(audit).toMatchObject({ action: 'UPDATE', entityId: row.id });
    expect(audit.oldValues).toMatchObject({ productIds: [p3] });
  });

  it('rejects unknown products, duplicates and > 500 ids with 422', async () => {
    const { t, auth } = setup();
    const row = collectionRow();
    const known = ids();
    const unknown = ids();
    t.m.collection.findUnique.mockResolvedValue(row);
    t.m.product.findMany.mockResolvedValue([{ id: known }]);
    const missing = await request(t.app)
      .put(`/api/v1/admin/collections/${row.id}/products`)
      .set(auth)
      .send({ productIds: [known, unknown] });
    expect(missing.status).toBe(422);
    expect(missing.body.error.details[0]).toMatchObject({
      field: 'productIds[1]',
      code: 'PRODUCT_NOT_FOUND',
    });
    const dup = await request(t.app)
      .put(`/api/v1/admin/collections/${row.id}/products`)
      .set(auth)
      .send({ productIds: [known, known] });
    expect(dup.status).toBe(422);
    const tooMany = await request(t.app)
      .put(`/api/v1/admin/collections/${row.id}/products`)
      .set(auth)
      .send({ productIds: Array.from({ length: 501 }, () => ids()) });
    expect(tooMany.status).toBe(422);
    expect(t.m.collectionProduct.deleteMany).not.toHaveBeenCalled();
  });

  it('blocks delete while ACTIVE products are members (409 IN_USE)', async () => {
    const { t, auth } = setup();
    const row = collectionRow();
    t.m.collection.findUnique.mockResolvedValue(row);
    t.m.collectionProduct.count.mockResolvedValue(2);
    const res = await request(t.app).delete(`/api/v1/admin/collections/${row.id}`).set(auth);
    expect(res.status).toBe(409);
    expect(res.body.error.details[0].code).toBe('IN_USE');
  });

  it('shows member product ids on the admin detail and 404 for unknown ids', async () => {
    const { t, auth } = setup();
    const row = collectionRow();
    const p1 = ids();
    t.m.collection.findUnique.mockResolvedValueOnce({ ...row, _count: { products: 1 } });
    t.m.collectionProduct.findMany.mockResolvedValue([{ productId: p1 }]);
    const res = await request(t.app).get(`/api/v1/admin/collections/${row.id}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ productCount: 1, productIds: [p1] });
    t.m.collection.findUnique.mockResolvedValueOnce(null);
    expect((await request(t.app).get(`/api/v1/admin/collections/${ids()}`).set(auth)).status).toBe(
      404,
    );
  });
});

describe('public collections', () => {
  it('lists only visible collections inside their window, featured filter honoured', async () => {
    const { t } = setup();
    t.m.collection.findMany.mockResolvedValue([
      {
        ...collectionRow({ bannerImageUrl: 'https://res.cloudinary.com/x/h', bannerImagePid: 'p' }),
        _count: { products: 3 },
      },
    ]);
    const res = await request(t.app).get('/api/v1/collections?featured=true');
    expect(res.status).toBe(200);
    const where = t.m.collection.findMany.mock.calls[0]?.[0].where;
    expect(where).toMatchObject({ isActive: true, deletedAt: null, isFeatured: true });
    expect(where.AND).toEqual([
      { OR: [{ startsAt: null }, { startsAt: { lte: t.now.value } }] },
      { OR: [{ endsAt: null }, { endsAt: { gt: t.now.value } }] },
    ]);
    expect(res.body.data[0]).toEqual({
      id: expect.any(String),
      name: 'Bridal Edit',
      slug: 'bridal-edit',
      description: null,
      heroImage: { url: 'https://res.cloudinary.com/x/h' },
      isFeatured: false,
      productCount: 3,
    });
    expect((await request(t.app).get('/api/v1/collections?featured=yes')).status).toBe(422);
  });

  it('FR-SF-004: the public list hides collections with no active product; admin list does not', async () => {
    const { t, auth } = setup();
    const full = { ...collectionRow({ name: 'Bridal Edit' }), _count: { products: 2 } };
    const empty = {
      ...collectionRow({ id: ids(), name: 'Empty Edit', slug: 'empty-edit' }),
      _count: { products: 0 },
    };
    t.m.collection.findMany.mockResolvedValue([full, empty]);
    t.m.collection.count.mockResolvedValue(2);

    const res = await request(t.app).get('/api/v1/collections');
    expect(res.status).toBe(200);
    const where = t.m.collection.findMany.mock.calls[0]?.[0].where;
    expect(where).toMatchObject({
      isActive: true,
      deletedAt: null,
      products: { some: { product: { status: 'ACTIVE', deletedAt: null } } },
    });
    const listed = res.body.data as { slug: string }[];
    expect(listed.map((c) => c.slug)).toEqual([full.slug]);
    expect(res.body.data[0].productCount).toBe(2);

    const admin = await request(t.app).get('/api/v1/admin/collections').set(auth);
    expect(admin.status).toBe(200);
    expect(t.m.collection.findMany.mock.calls[1]?.[0].where).not.toHaveProperty('products');
    expect(admin.body.data).toHaveLength(2);
  });

  it('returns collection detail by slug and 404 when not visible', async () => {
    const { t } = setup();
    t.m.collection.findFirst.mockResolvedValueOnce({ ...collectionRow(), _count: { products: 2 } });
    const res = await request(t.app).get('/api/v1/collections/bridal-edit');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      slug: 'bridal-edit',
      productCount: 2,
      seo: { title: 'Bridal Edit' },
    });
    expect(t.m.collection.findFirst.mock.calls[0]?.[0].where).toMatchObject({
      slug: 'bridal-edit',
      isActive: true,
      deletedAt: null,
    });
    t.m.collection.findFirst.mockResolvedValueOnce(null);
    expect((await request(t.app).get('/api/v1/collections/hidden')).status).toBe(404);
  });
});
