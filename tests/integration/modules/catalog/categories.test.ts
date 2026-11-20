/**
 * Categories — admin CRUD, tree moves (cycle/depth prevention), delete guard, attribute rules,
 * public tree/detail through the real Express app.
 * MOCKED DB (tests/helpers/mockDb.ts): verifies HTTP contract, guards, service rules and audit
 * calls; no SQL is executed (the generated-column unique index is not exercised here).
 */
import type { Category } from '../../../../src/generated/prisma/client.js';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createCategoriesModule } from '../../../../src/modules/categories/index.js';
import { buildModuleTestApp } from '../../../helpers/container.js';
import { expectAdminRoutesGuarded } from '../../../helpers/routeTable.js';
import { attributeRow, categoryRow, childOf, ids } from './fixtures.js';

const ALL = ['categories.view', 'categories.create', 'categories.update', 'categories.delete'];

function setup() {
  const t = buildModuleTestApp([createCategoriesModule]);
  return { t, auth: t.staff({ permissions: ALL }).headers };
}

/** `category.findUnique` resolving by id or slug from a fixed set of rows. */
function serveCategories(t: ReturnType<typeof setup>['t'], rows: Category[]): void {
  t.m.category.findUnique.mockImplementation(
    ({ where }: { where: { id?: string; slug?: string } }) =>
      Promise.resolve(
        rows.find((r) => (where.id !== undefined ? r.id === where.id : r.slug === where.slug)) ??
          null,
      ),
  );
  t.m.category.findMany.mockImplementation(
    ({ where }: { where: { id?: { in: string[] }; path?: { startsWith: string } } }) =>
      Promise.resolve(
        rows.filter((r) => {
          if (where.id !== undefined) return where.id.in.includes(r.id);
          if (where.path !== undefined) return r.path.startsWith(where.path.startsWith);
          return true;
        }),
      ),
  );
}

const echoUpdate = (rows: Category[]) => {
  return ({ where, data }: { where: { id: string }; data: Partial<Category> }) =>
    Promise.resolve({ ...rows.find((r) => r.id === where.id), ...data } as Category);
};

describe('admin categories', () => {
  it('guards every admin route with a categories.* permission', () => {
    const { t } = setup();
    const routes = expectAdminRoutesGuarded(createCategoriesModule(t.container));
    expect(routes.map((r) => `${r.method} ${r.path} ${r.permissions.join(',')}`)).toEqual([
      'GET /categories categories.view',
      'POST /categories categories.create',
      'POST /categories/reorder categories.update',
      'GET /categories/:categoryId categories.view',
      'PATCH /categories/:categoryId categories.update',
      'DELETE /categories/:categoryId categories.delete',
      'POST /categories/:categoryId/restore categories.delete',
      'GET /categories/:categoryId/attributes categories.view',
      'PUT /categories/:categoryId/attributes categories.update',
    ]);
  });

  it('creates a root category with path/depth, generated slug and CREATE audit', async () => {
    const { t } = setup();
    const staff = t.staff({ permissions: ALL });
    t.m.category.findFirst.mockResolvedValue(null);
    t.m.category.findUnique.mockResolvedValue(null);
    t.m.category.create.mockImplementation(({ data }: { data: Partial<Category> }) =>
      Promise.resolve(categoryRow(data)),
    );
    const res = await request(t.app)
      .post('/api/v1/admin/categories')
      .set(staff.headers)
      .send({ name: 'Oxidised  Jhumkas', seo: { title: 'Jhumkas' } });
    expect(res.status).toBe(201);
    const data = t.m.category.create.mock.calls[0]?.[0].data;
    expect(data).toMatchObject({
      parentId: null,
      depth: 1,
      nameNormalized: 'oxidised jhumkas',
      slug: 'oxidised-jhumkas',
      path: `/${data.id}/`,
      seoTitle: 'Jhumkas',
      createdById: staff.ctx.userId,
    });
    expect(res.body.data).toMatchObject({ slug: 'oxidised-jhumkas', depth: 1, status: 'ACTIVE' });
    expect(res.body.data.path).toBeUndefined();
    const audit = t.m.auditLog.create.mock.calls[0]?.[0].data;
    expect(audit).toMatchObject({ action: 'CREATE', module: 'categories', entityId: data.id });
  });

  it('rejects a 4th level with 422 CATEGORY_DEPTH and an unknown parent with 422', async () => {
    const { t, auth } = setup();
    const root = categoryRow();
    const l2 = childOf(root, { name: 'Jhumkas', slug: 'jhumkas' });
    const l3 = childOf(l2, { name: 'Oxidised', slug: 'oxidised' });
    serveCategories(t, [root, l2, l3]);
    const deep = await request(t.app)
      .post('/api/v1/admin/categories')
      .set(auth)
      .send({ name: 'Too deep', parentId: l3.id });
    expect(deep.status).toBe(422);
    expect(deep.body.error.details[0]).toMatchObject({ field: 'parentId', code: 'CATEGORY_DEPTH' });

    const missing = await request(t.app)
      .post('/api/v1/admin/categories')
      .set(auth)
      .send({ name: 'Orphan', parentId: ids() });
    expect(missing.status).toBe(422);
    expect(missing.body.error.details[0].code).toBe('PARENT_NOT_FOUND');
  });

  it('returns 409 for a duplicate name under the same parent (normalized)', async () => {
    const { t, auth } = setup();
    const existing = categoryRow();
    t.m.category.findFirst.mockResolvedValue(existing);
    const res = await request(t.app)
      .post('/api/v1/admin/categories')
      .set(auth)
      .send({ name: ' EARRINGS ' });
    expect(res.status).toBe(409);
    expect(res.body.error.details[0]).toMatchObject({
      field: 'name',
      meta: { normalized: 'earrings', existingId: existing.id, parentId: null },
    });
    expect(t.m.category.findFirst.mock.calls[0]?.[0].where).toEqual({
      parentId: null,
      nameNormalized: 'earrings',
    });
  });

  it('returns 409 for a slug used by another category', async () => {
    const { t, auth } = setup();
    t.m.category.findFirst.mockResolvedValue(null);
    t.m.category.findUnique.mockResolvedValue(categoryRow({ slug: 'rings' }));
    const res = await request(t.app)
      .post('/api/v1/admin/categories')
      .set(auth)
      .send({ name: 'Rings', slug: 'rings' });
    expect(res.status).toBe(409);
    expect(res.body.error.details[0].field).toBe('slug');
  });

  it('rejects unknown body keys and invalid slugs (422)', async () => {
    const { t, auth } = setup();
    const res = await request(t.app)
      .post('/api/v1/admin/categories')
      .set(auth)
      .send({ name: 'Rings', slug: 'Bad Slug!', path: '/x/' });
    expect(res.status).toBe(422);
    const fields = (res.body.error.details as { field?: string }[]).map((d) => d.field);
    expect(fields).toContain('slug');
  });

  it('prevents moving a category under itself or a descendant (422 CATEGORY_CYCLE)', async () => {
    const { t, auth } = setup();
    const root = categoryRow();
    const child = childOf(root, { name: 'Jhumkas', slug: 'jhumkas' });
    serveCategories(t, [root, child]);
    const toChild = await request(t.app)
      .patch(`/api/v1/admin/categories/${root.id}`)
      .set(auth)
      .send({ parentId: child.id });
    expect(toChild.status).toBe(422);
    expect(toChild.body.error.details[0].code).toBe('CATEGORY_CYCLE');

    const toSelf = await request(t.app)
      .patch(`/api/v1/admin/categories/${root.id}`)
      .set(auth)
      .send({ parentId: root.id });
    expect(toSelf.status).toBe(422);
    expect(toSelf.body.error.details[0].code).toBe('CATEGORY_CYCLE');
    expect(t.m.category.update).not.toHaveBeenCalled();
  });

  it('rejects a move whose subtree would exceed depth 3', async () => {
    const { t, auth } = setup();
    const a = categoryRow({ name: 'A', slug: 'a' });
    const aChild = childOf(a, { name: 'A1', slug: 'a1' });
    const x = categoryRow({ name: 'X', slug: 'x' });
    const x2 = childOf(x, { name: 'X2', slug: 'x2' });
    serveCategories(t, [a, aChild, x, x2]);
    const res = await request(t.app)
      .patch(`/api/v1/admin/categories/${a.id}`)
      .set(auth)
      .send({ parentId: x2.id });
    expect(res.status).toBe(422);
    expect(res.body.error.details[0].code).toBe('CATEGORY_DEPTH');
  });

  it('moves a subtree, rebasing descendant paths/depths, and audits the move', async () => {
    const { t, auth } = setup();
    const a = categoryRow({ name: 'A', slug: 'a' });
    const aChild = childOf(a, { name: 'A1', slug: 'a1' });
    const x = categoryRow({ name: 'X', slug: 'x' });
    const rows = [a, aChild, x];
    serveCategories(t, rows);
    t.m.category.findFirst.mockResolvedValue(null);
    t.m.category.update.mockImplementation(echoUpdate(rows));
    const res = await request(t.app)
      .patch(`/api/v1/admin/categories/${a.id}`)
      .set(auth)
      .send({ parentId: x.id });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ parentId: x.id, depth: 2 });
    const calls = t.m.category.update.mock.calls.map(
      (c) => c[0] as { where: { id: string }; data: Record<string, unknown> },
    );
    expect(calls[0]?.data).toMatchObject({
      parentId: x.id,
      path: `/${x.id}/${a.id}/`,
      depth: 2,
    });
    expect(calls[1]).toEqual({
      where: { id: aChild.id },
      data: { path: `/${x.id}/${a.id}/${aChild.id}/`, depth: 3 },
    });
    const audit = t.m.auditLog.create.mock.calls[0]?.[0].data;
    expect(audit.action).toBe('UPDATE');
    expect(audit.newValues._event).toMatchObject({
      eventKey: 'categories.moved',
      metadata: { rebasedDescendants: 1 },
    });
  });

  it('moves a category back to the root level (parentId null)', async () => {
    const { t, auth } = setup();
    const root = categoryRow();
    const child = childOf(root, { name: 'Jhumkas', slug: 'jhumkas' });
    const rows = [root, child];
    serveCategories(t, rows);
    t.m.category.findFirst.mockResolvedValue(null);
    t.m.category.update.mockImplementation(echoUpdate(rows));
    const res = await request(t.app)
      .patch(`/api/v1/admin/categories/${child.id}`)
      .set(auth)
      .send({ parentId: null });
    expect(res.status).toBe(200);
    expect(t.m.category.update.mock.calls[0]?.[0].data).toMatchObject({
      parentId: null,
      path: `/${child.id}/`,
      depth: 1,
    });
  });

  it('blocks deleting a category with children or products (409 IN_USE)', async () => {
    const { t, auth } = setup();
    const row = categoryRow();
    serveCategories(t, [row]);
    t.m.category.count.mockResolvedValueOnce(2);
    const withChildren = await request(t.app)
      .delete(`/api/v1/admin/categories/${row.id}`)
      .set(auth);
    expect(withChildren.status).toBe(409);
    expect(withChildren.body.error.details[0]).toMatchObject({
      code: 'IN_USE',
      meta: { children: 2 },
    });

    t.m.category.count.mockResolvedValueOnce(0);
    t.m.product.count.mockResolvedValueOnce(5);
    const withProducts = await request(t.app)
      .delete(`/api/v1/admin/categories/${row.id}`)
      .set(auth);
    expect(withProducts.status).toBe(409);
    expect(withProducts.body.error.details[0].meta).toEqual({ products: 5 });
    expect(t.m.category.update).not.toHaveBeenCalled();
  });

  it('soft-deletes an empty category and audits DELETE', async () => {
    const { t } = setup();
    const staff = t.staff({ permissions: ['categories.delete'] });
    const row = categoryRow();
    serveCategories(t, [row]);
    t.m.category.count.mockResolvedValue(0);
    t.m.product.count.mockResolvedValue(0);
    t.m.category.update.mockImplementation(echoUpdate([row]));
    const res = await request(t.app)
      .delete(`/api/v1/admin/categories/${row.id}`)
      .set(staff.headers);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: row.id, deleted: true });
    expect(t.m.category.update.mock.calls[0]?.[0].data).toEqual({
      deletedAt: t.now.value,
      deletedById: staff.ctx.userId,
    });
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data.action).toBe('DELETE');
  });

  it('returns 404 for a deleted category on PATCH and 403 without permission', async () => {
    const { t, auth } = setup();
    const row = categoryRow({ deletedAt: new Date() });
    serveCategories(t, [row]);
    const res = await request(t.app)
      .patch(`/api/v1/admin/categories/${row.id}`)
      .set(auth)
      .send({ name: 'New' });
    expect(res.status).toBe(404);
    const viewer = t.staff({ permissions: ['categories.view'] });
    const denied = await request(t.app)
      .patch(`/api/v1/admin/categories/${row.id}`)
      .set(viewer.headers)
      .send({ name: 'New' });
    expect(denied.status).toBe(403);
  });

  it('returns a tree for ?view=tree with rolled-up product counts', async () => {
    const { t, auth } = setup();
    const root = categoryRow();
    const child = childOf(root, { name: 'Jhumkas', slug: 'jhumkas' });
    t.m.category.findMany.mockResolvedValue([
      { ...root, _count: { products: 1, children: 1 } },
      { ...child, _count: { products: 4, children: 0 } },
    ]);
    const res = await request(t.app).get('/api/v1/admin/categories?view=tree').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ id: root.id, productCount: 5 });
    expect(res.body.data[0].children[0]).toMatchObject({ id: child.id, productCount: 4 });
    expect(res.body.meta).toMatchObject({ view: 'tree', totalItems: 2 });
  });

  it('reorders siblings (exact set required) and audits each change', async () => {
    const { t, auth } = setup();
    const a = categoryRow({ name: 'A', slug: 'a', sortOrder: 0 });
    const b = categoryRow({ name: 'B', slug: 'b', sortOrder: 1 });
    t.m.category.findMany.mockResolvedValue([a, b]);
    t.m.category.update.mockImplementation(echoUpdate([a, b]));
    const mismatch = await request(t.app)
      .post('/api/v1/admin/categories/reorder')
      .set(auth)
      .send({ parentId: null, categoryIds: [a.id] });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error.details[0].code).toBe('REORDER_MISMATCH');

    const res = await request(t.app)
      .post('/api/v1/admin/categories/reorder')
      .set(auth)
      .send({ parentId: null, categoryIds: [b.id, a.id] });
    expect(res.status).toBe(200);
    expect(t.m.category.update).toHaveBeenCalledTimes(2);
    // 2 entity rows + 1 summary row
    expect(t.m.auditLog.create).toHaveBeenCalledTimes(3);
  });
});

describe('category attribute rules', () => {
  it('returns own + inherited rules (nearest wins, non-inheritable rules skipped)', async () => {
    const { t, auth } = setup();
    const root = categoryRow();
    const child = childOf(root, { name: 'Jhumkas', slug: 'jhumkas' });
    serveCategories(t, [root, child]);
    const material = attributeRow({ name: 'Material', code: 'material' });
    const size = attributeRow({ name: 'Size', code: 'size' });
    const finish = attributeRow();
    const rule = (categoryId: string, attribute: typeof material, over = {}) => ({
      categoryId,
      attributeId: attribute.id,
      attribute,
      isRequired: false,
      isVariantAxisDefault: false,
      inheritToChildren: true,
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    });
    t.m.categoryAttribute.findMany.mockResolvedValue([
      rule(root.id, material, { isRequired: true, sortOrder: 1 }),
      rule(root.id, size, { inheritToChildren: false }),
      rule(root.id, finish, { sortOrder: 5 }),
      rule(child.id, finish, { isVariantAxisDefault: true, sortOrder: 2 }),
    ]);
    const res = await request(t.app)
      .get(`/api/v1/admin/categories/${child.id}/attributes`)
      .set(auth);
    expect(res.status).toBe(200);
    const rules = res.body.data.attributes as {
      attributeId: string;
      inheritedFrom: unknown;
      isVariantAxisDefault: boolean;
    }[];
    expect(rules.map((r) => r.attributeId)).toEqual([material.id, finish.id]);
    expect(rules[0]?.inheritedFrom).toEqual({ id: root.id, name: root.name });
    expect(rules[1]).toMatchObject({ inheritedFrom: null, isVariantAxisDefault: true });
  });

  it('rejects unknown attributes and axis defaults on non-axis attributes (422)', async () => {
    const { t, auth } = setup();
    const cat = categoryRow();
    serveCategories(t, [cat]);
    const material = attributeRow({ name: 'Material', code: 'material', isVariantAxis: false });
    t.m.attribute.findMany.mockResolvedValue([material]);
    const res = await request(t.app)
      .put(`/api/v1/admin/categories/${cat.id}/attributes`)
      .set(auth)
      .send({
        attributes: [
          { attributeId: material.id, isVariantAxisDefault: true },
          { attributeId: ids() },
        ],
      });
    expect(res.status).toBe(422);
    expect((res.body.error.details as { code: string }[]).map((d) => d.code)).toEqual([
      'NOT_VARIANT_AXIS',
      'ATTRIBUTE_NOT_FOUND',
    ]);
    const dup = await request(t.app)
      .put(`/api/v1/admin/categories/${cat.id}/attributes`)
      .set(auth)
      .send({ attributes: [{ attributeId: material.id }, { attributeId: material.id }] });
    expect(dup.status).toBe(422);
    expect(dup.body.error.details[0].field).toBe('attributes[1].attributeId');
  });

  it('replaces the rule set, audits it and warns about newly required attributes', async () => {
    const { t, auth } = setup();
    const cat = categoryRow();
    serveCategories(t, [cat]);
    const material = attributeRow({ name: 'Material', code: 'material', isVariantAxis: false });
    t.m.attribute.findMany.mockResolvedValue([material]);
    t.m.categoryAttribute.findMany.mockResolvedValue([]);
    t.m.product.count.mockResolvedValue(12);
    const res = await request(t.app)
      .put(`/api/v1/admin/categories/${cat.id}/attributes`)
      .set(auth)
      .send({ attributes: [{ attributeId: material.id, isRequired: true }] });
    expect(res.status).toBe(200);
    expect(t.m.categoryAttribute.deleteMany).toHaveBeenCalledWith({
      where: { categoryId: cat.id },
    });
    expect(t.m.categoryAttribute.createMany.mock.calls[0]?.[0].data).toEqual([
      {
        attributeId: material.id,
        isRequired: true,
        isVariantAxisDefault: false,
        inheritToChildren: true,
        sortOrder: 0,
        categoryId: cat.id,
      },
    ]);
    expect(res.body.data.warnings[0]).toMatchObject({
      code: 'REQUIRED_ATTRIBUTE_ADDED',
      meta: { attributeId: material.id, affectedProducts: 12 },
    });
    const audit = t.m.auditLog.create.mock.calls[0]?.[0].data;
    expect(audit).toMatchObject({ action: 'UPDATE', entityId: cat.id });
  });
});

describe('public categories', () => {
  it('returns the active tree only, hiding subtrees of inactive parents, with counts', async () => {
    const { t } = setup();
    const root = categoryRow();
    const child = childOf(root, { name: 'Jhumkas', slug: 'jhumkas' });
    const grand = childOf(child, { name: 'Oxidised', slug: 'oxidised' });
    const orphanParentId = ids();
    const orphan = categoryRow({ parentId: orphanParentId, depth: 2, name: 'Hidden', slug: 'h' });
    t.m.category.findMany.mockResolvedValue([
      { ...root, _count: { products: 1, children: 1 } },
      { ...child, _count: { products: 2, children: 1 } },
      { ...grand, _count: { products: 3, children: 0 } },
      { ...orphan, _count: { products: 9, children: 0 } },
    ]);
    const res = await request(t.app).get('/api/v1/categories');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('public');
    expect(t.m.category.findMany.mock.calls[0]?.[0].where).toEqual({
      isActive: true,
      deletedAt: null,
    });
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ slug: 'earrings', productCount: 6 });
    expect(res.body.data[0].children[0]).toMatchObject({ slug: 'jhumkas', productCount: 5 });
    expect(res.body.data[0].children[0].children[0]).toMatchObject({ productCount: 3 });
    expect(Object.keys(res.body.data[0] as object)).not.toContain('imagePublicId');

    const shallow = await request(t.app).get('/api/v1/categories?depth=1');
    expect(shallow.body.data[0]).toMatchObject({ productCount: 6, children: [] });
    expect((await request(t.app).get('/api/v1/categories?depth=4')).status).toBe(422);
  });

  it('returns detail with breadcrumb, children and nearest size guide; 404 if inactive', async () => {
    const { t } = setup();
    const root = categoryRow();
    const child = childOf(root, {
      name: 'Jhumkas',
      slug: 'jhumkas',
      bannerImageUrl: 'https://res.cloudinary.com/x/banner',
      bannerImagePid: 'cat/banner',
    });
    const grand = childOf(child, { name: 'Oxidised', slug: 'oxidised' });
    const all = [root, child, grand];
    t.m.category.findUnique.mockImplementation(({ where }: { where: { slug: string } }) =>
      Promise.resolve(all.find((r) => r.slug === where.slug) ?? null),
    );
    t.m.category.findMany.mockImplementation(
      ({ where }: { where: { id?: { in: string[] }; path?: { startsWith: string } } }) => {
        if (where.id !== undefined) {
          return Promise.resolve(all.filter((r) => where.id?.in.includes(r.id)));
        }
        return Promise.resolve(
          all
            .filter((r) => r.path.startsWith(where.path?.startsWith ?? ''))
            .map((r) => ({ ...r, _count: { products: r.id === grand.id ? 4 : 1, children: 0 } })),
        );
      },
    );
    t.m.cmsBlock.findMany.mockResolvedValue([
      { blockKey: 'size-guide-earrings', categoryId: root.id },
    ]);
    const res = await request(t.app).get('/api/v1/categories/jhumkas');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      slug: 'jhumkas',
      productCount: 5,
      bannerImage: { url: 'https://res.cloudinary.com/x/banner' },
      seo: { title: 'Jhumkas', description: null },
      sizeGuideBlockKey: 'size-guide-earrings',
      breadcrumb: [
        { id: root.id, name: 'Earrings', slug: 'earrings' },
        { id: child.id, name: 'Jhumkas', slug: 'jhumkas' },
      ],
    });
    expect(res.body.data.children).toEqual([
      { id: grand.id, name: 'Oxidised', slug: 'oxidised', image: null, productCount: 4 },
    ]);

    // Parent inactive → the child is not reachable publicly.
    root.isActive = false;
    expect((await request(t.app).get('/api/v1/categories/jhumkas')).status).toBe(404);
    expect((await request(t.app).get('/api/v1/categories/unknown')).status).toBe(404);
  });
});
