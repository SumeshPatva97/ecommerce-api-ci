/**
 * Brands — admin CRUD + public list through the real Express app.
 * MOCKED DB (tests/helpers/mockDb.ts): verifies HTTP contract, guards, service rules and audit
 * calls; no SQL is executed.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createBrandsModule } from '../../../../src/modules/brands/index.js';
import { buildModuleTestApp } from '../../../helpers/container.js';
import { expectAdminRoutesGuarded } from '../../../helpers/routeTable.js';
import { brandRow, ids, p2002 } from './fixtures.js';

const ALL = ['brands.view', 'brands.create', 'brands.update', 'brands.delete'];

function setup() {
  const t = buildModuleTestApp([createBrandsModule]);
  return { t, auth: t.staff({ permissions: ALL }).headers };
}

describe('admin brands', () => {
  it('guards every admin route with a brands.* permission', () => {
    const { t } = setup();
    const routes = expectAdminRoutesGuarded(createBrandsModule(t.container));
    expect(routes.map((r) => `${r.method} ${r.path} ${r.permissions.join(',')}`)).toEqual([
      'GET /brands brands.view',
      'POST /brands brands.create',
      'GET /brands/:brandId brands.view',
      'PATCH /brands/:brandId brands.update',
      'DELETE /brands/:brandId brands.delete',
      'POST /brands/:brandId/restore brands.delete',
    ]);
  });

  it('creates a brand with a generated slug and writes a CREATE audit row', async () => {
    const { t, auth } = setup();
    t.m.brand.findUnique.mockResolvedValue(null);
    t.m.brand.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve(brandRow(data)),
    );
    const res = await request(t.app)
      .post('/api/v1/admin/brands')
      .set(auth)
      .send({
        name: '  Aura   Atelier ',
        logo: {
          url: 'https://res.cloudinary.com/x/image/upload/brands/aura',
          publicId: 'brands/aura',
        },
      });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: 'Aura   Atelier',
      slug: 'aura-atelier',
      status: 'ACTIVE',
      logo: { publicId: 'brands/aura' },
    });
    const data = t.m.brand.create.mock.calls[0]?.[0].data;
    expect(data.nameNormalized).toBe('aura atelier');
    const audit = t.m.auditLog.create.mock.calls[0]?.[0].data;
    expect(audit).toMatchObject({ action: 'CREATE', module: 'brands', entityType: 'Brand' });
  });

  it('rejects unknown body keys and short names with 422', async () => {
    const { t, auth } = setup();
    const res = await request(t.app)
      .post('/api/v1/admin/brands')
      .set(auth)
      .send({ name: 'A', costPrice: '1.00' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const fields = (res.body.error.details as { field?: string }[]).map((d) => d.field);
    expect(fields).toContain('name');
  });

  it('returns 409 DUPLICATE_RESOURCE with field details for a normalized name clash', async () => {
    const { t, auth } = setup();
    const existing = brandRow();
    t.m.brand.findUnique.mockResolvedValueOnce(existing);
    const res = await request(t.app)
      .post('/api/v1/admin/brands')
      .set(auth)
      .send({ name: 'AURA atelier' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_RESOURCE');
    expect(res.body.error.details[0]).toMatchObject({
      field: 'name',
      meta: { normalized: 'aura atelier', existingId: existing.id },
    });
    expect(t.m.brand.create).not.toHaveBeenCalled();
  });

  it('maps a DB unique violation (race) to 409', async () => {
    const { t, auth } = setup();
    t.m.brand.findUnique.mockResolvedValue(null);
    t.m.brand.create.mockRejectedValue(p2002(['slug']));
    const res = await request(t.app).post('/api/v1/admin/brands').set(auth).send({ name: 'Aura' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_RESOURCE');
  });

  it('denies a staff member without brands.create (403)', async () => {
    const { t } = setup();
    const viewer = t.staff({ permissions: ['brands.view'] });
    const res = await request(t.app)
      .post('/api/v1/admin/brands')
      .set(viewer.headers)
      .send({ name: 'Aura' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_DENIED');
  });

  it('returns 404 for an unknown brand and 422 for a malformed id', async () => {
    const { t, auth } = setup();
    t.m.brand.findUnique.mockResolvedValue(null);
    expect((await request(t.app).get(`/api/v1/admin/brands/${ids()}`).set(auth)).status).toBe(404);
    expect((await request(t.app).get('/api/v1/admin/brands/nope').set(auth)).status).toBe(422);
  });

  it('lists brands with pagination meta and status filter', async () => {
    const { t, auth } = setup();
    t.m.brand.findMany.mockResolvedValue([{ ...brandRow(), _count: { products: 4 } }]);
    t.m.brand.count.mockResolvedValue(1);
    const res = await request(t.app)
      .get('/api/v1/admin/brands?status=INACTIVE&sort=-name')
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 25, totalItems: 1 });
    expect(res.body.data[0].productCount).toBe(4);
    const args = t.m.brand.findMany.mock.calls[0]?.[0];
    expect(args.where).toMatchObject({ deletedAt: null, isActive: false });
    expect(args.orderBy[0]).toEqual({ name: 'desc' });
    expect((await request(t.app).get('/api/v1/admin/brands?limit=101').set(auth)).status).toBe(422);
  });

  it('records STATUS_CHANGE when only the status changes', async () => {
    const { t, auth } = setup();
    const before = brandRow();
    t.m.brand.findUnique.mockResolvedValue(before);
    t.m.brand.update.mockResolvedValue({ ...before, isActive: false });
    const res = await request(t.app)
      .patch(`/api/v1/admin/brands/${before.id}`)
      .set(auth)
      .send({ status: 'INACTIVE' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('INACTIVE');
    const audit = t.m.auditLog.create.mock.calls[0]?.[0].data;
    expect(audit.action).toBe('STATUS_CHANGE');
    expect(audit.oldValues).toMatchObject({ isActive: true });
    expect(audit.newValues).toMatchObject({ isActive: false });
  });

  it('blocks delete while ACTIVE products reference the brand (409 IN_USE)', async () => {
    const { t, auth } = setup();
    const row = brandRow();
    t.m.brand.findUnique.mockResolvedValue(row);
    t.m.product.count.mockResolvedValue(3);
    const res = await request(t.app).delete(`/api/v1/admin/brands/${row.id}`).set(auth);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body.error.details[0].code).toBe('IN_USE');
    expect(t.m.brand.update).not.toHaveBeenCalled();
  });

  it('soft-deletes an unused brand and audits DELETE; restore audits RESTORE', async () => {
    const { t, auth } = setup();
    const row = brandRow();
    t.m.brand.findUnique.mockResolvedValueOnce(row);
    t.m.product.count.mockResolvedValue(0);
    t.m.brand.update.mockResolvedValueOnce({ ...row, deletedAt: t.now.value });
    const res = await request(t.app).delete(`/api/v1/admin/brands/${row.id}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: row.id, deleted: true });
    expect(t.m.brand.update.mock.calls[0]?.[0].data).toEqual({ deletedAt: t.now.value });
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data.action).toBe('DELETE');

    t.m.brand.findUnique.mockResolvedValueOnce({ ...row, deletedAt: t.now.value });
    t.m.brand.update.mockResolvedValueOnce(row);
    const restored = await request(t.app)
      .post(`/api/v1/admin/brands/${row.id}/restore`)
      .set(auth)
      .send({});
    expect(restored.status).toBe(200);
    expect(t.m.auditLog.create.mock.calls[1]?.[0].data.action).toBe('RESTORE');
  });
});

describe('public brands', () => {
  it('lists only active, non-deleted brands without internal fields', async () => {
    const { t } = setup();
    t.m.brand.findMany.mockResolvedValue([
      {
        ...brandRow({ logoUrl: 'https://res.cloudinary.com/x/a', logoPublicId: 'brands/a' }),
        _count: { products: 7 },
      },
    ]);
    const res = await request(t.app).get('/api/v1/brands');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('public');
    expect(res.body.data[0]).toEqual({
      id: expect.any(String),
      name: 'Aura Atelier',
      slug: 'aura-atelier',
      logo: { url: 'https://res.cloudinary.com/x/a' },
      productCount: 7,
    });
    expect(t.m.brand.findMany.mock.calls[0]?.[0].where).toEqual({
      isActive: true,
      deletedAt: null,
    });
  });
});
