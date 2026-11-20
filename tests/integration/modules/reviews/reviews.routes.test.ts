/**
 * Reviews HTTP — verified-purchaser creation, public/own listings, admin moderation.
 * MOCKED DB (tests/helpers/mockDb.ts): no SQL runs.
 */
import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createReviewsModule } from '../../../../src/modules/reviews/index.js';
import { buildModuleTestApp } from '../../../helpers/container.js';
import { expectAdminRoutesGuarded } from '../../../helpers/routeTable.js';

const NOW = new Date('2026-11-19T06:30:00.000Z');
const PRODUCT_ID = randomUUID();
const BODY = {
  rating: 5,
  title: 'Stunning',
  body: 'Lightweight and <b>beautiful</b>.<script>x()</script>',
};

function setup() {
  const t = buildModuleTestApp([createReviewsModule], { now: NOW });
  t.m.auditLog.create.mockResolvedValue({});
  return t;
}

function activeProduct() {
  return { id: PRODUCT_ID, status: 'ACTIVE', deletedAt: null, avgRating: '4.50', reviewCount: 2 };
}

function adminRow(status = 'PENDING') {
  return {
    id: randomUUID(),
    productId: PRODUCT_ID,
    userId: randomUUID(),
    orderItemId: randomUUID(),
    rating: 4,
    title: 'Nice',
    body: 'Lovely finish and light.',
    status,
    moderatedById: null,
    moderatedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    product: { id: PRODUCT_ID, name: 'Jhumka', slug: 'jhumka' },
    user: { id: randomUUID(), firstName: 'Ananya', lastName: 'Rao', email: 'ananya@example.com' },
    orderItem: { variantName: 'Gold', order: { orderNumber: 'ORD-261119-00001' } },
  };
}

describe('reviews — customer', () => {
  it('guards admin routes', () => {
    const t = setup();
    const routes = expectAdminRoutesGuarded(createReviewsModule(t.container));
    expect(routes.map((r) => `${r.method} ${r.path} ${r.permissions.join(',')}`)).toEqual([
      'GET /reviews reviews.view',
      'POST /reviews/:reviewId/approve reviews.approve',
      'POST /reviews/:reviewId/reject reviews.approve',
      'DELETE /reviews/:reviewId reviews.delete',
    ]);
  });

  it('creates a PENDING review for a verified purchaser with HTML stripped', async () => {
    const t = setup();
    const c = t.customer();
    const orderItemId = randomUUID();
    t.m.product.findUnique.mockResolvedValue(activeProduct());
    t.m.review.findUnique.mockResolvedValue(null);
    t.m.orderItem.findFirst.mockResolvedValue({ id: orderItemId });
    t.m.setting.findUnique.mockResolvedValue(null);
    const res = await request(t.app)
      .post(`/api/v1/products/${PRODUCT_ID}/reviews`)
      .set(c.headers)
      .send(BODY);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      status: 'PENDING',
      message: 'Thanks! Your review will appear after moderation.',
    });
    expect(t.m.orderItem.findFirst.mock.calls[0]?.[0].where).toEqual({
      productId: PRODUCT_ID,
      order: { userId: c.ctx.userId, status: 'DELIVERED' },
    });
    expect(t.m.review.create.mock.calls[0]?.[0].data).toMatchObject({
      userId: c.ctx.userId,
      orderItemId,
      rating: 5,
      body: 'Lightweight and beautiful.',
      status: 'PENDING',
    });
    expect(t.m.product.update).not.toHaveBeenCalled();
  });

  it('403 NOT_VERIFIED_PURCHASER without a delivered order item', async () => {
    const t = setup();
    const c = t.customer();
    t.m.product.findUnique.mockResolvedValue(activeProduct());
    t.m.review.findUnique.mockResolvedValue(null);
    t.m.orderItem.findFirst.mockResolvedValue(null);
    const res = await request(t.app)
      .post(`/api/v1/products/${PRODUCT_ID}/reviews`)
      .set(c.headers)
      .send(BODY);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({
      code: 'FORBIDDEN',
      details: [{ code: 'NOT_VERIFIED_PURCHASER' }],
    });
    expect(t.m.review.create).not.toHaveBeenCalled();
  });

  it('409 for a second review; 422 when only markup remains; 401 without a token', async () => {
    const t = setup();
    const c = t.customer();
    t.m.product.findUnique.mockResolvedValue(activeProduct());
    t.m.review.findUnique.mockResolvedValue({ id: 'r1' });
    const dup = await request(t.app)
      .post(`/api/v1/products/${PRODUCT_ID}/reviews`)
      .set(c.headers)
      .send(BODY);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_RESOURCE');

    const markup = await request(t.app)
      .post(`/api/v1/products/${PRODUCT_ID}/reviews`)
      .set(c.headers)
      .send({ rating: 4, body: '<script>alert(1)</script><b></b>' });
    expect(markup.status).toBe(422);

    const strictBody = await request(t.app)
      .post(`/api/v1/products/${PRODUCT_ID}/reviews`)
      .set(c.headers)
      .send({ ...BODY, photos: ['x'] });
    expect(strictBody.status).toBe(422);
    expect(
      (await request(t.app).post(`/api/v1/products/${PRODUCT_ID}/reviews`).send(BODY)).status,
    ).toBe(401);
  });

  it('auto-publishes when reviews.moderation_mode = POST and recomputes aggregates', async () => {
    const t = setup();
    const c = t.customer();
    t.m.product.findUnique.mockResolvedValue(activeProduct());
    t.m.review.findUnique.mockResolvedValue(null);
    t.m.orderItem.findFirst.mockResolvedValue({ id: randomUUID() });
    t.m.setting.findUnique.mockResolvedValue({ value: 'POST' });
    t.m.review.aggregate.mockResolvedValue({ _avg: { rating: 5 }, _count: { _all: 1 } });
    const res = await request(t.app)
      .post(`/api/v1/products/${PRODUCT_ID}/reviews`)
      .set(c.headers)
      .send(BODY);
    expect(res.body.data.status).toBe('APPROVED');
    expect(t.m.product.update.mock.calls[0]?.[0].data.reviewCount).toBe(1);
  });

  it('GET /products/:slug/reviews lists APPROVED reviews with summary; unknown slug 404', async () => {
    const t = setup();
    t.m.product.findUnique.mockResolvedValue(activeProduct());
    t.m.review.findMany.mockResolvedValue([
      {
        id: 'r1',
        rating: 5,
        title: 'Stunning',
        body: 'Lightweight.',
        createdAt: NOW,
        user: { firstName: 'Ananya', lastName: 'Rao' },
        orderItem: { variantName: 'Gold / Small' },
      },
    ]);
    t.m.review.count.mockResolvedValue(1);
    t.m.review.groupBy.mockResolvedValue([{ rating: 5, _count: { _all: 1 } }]);
    const res = await request(t.app).get(
      '/api/v1/products/jhumka/reviews?sort=rating_desc&limit=50',
    );
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toEqual({
      id: 'r1',
      rating: 5,
      title: 'Stunning',
      body: 'Lightweight.',
      authorName: 'Ananya R.',
      isVerifiedPurchase: true,
      variantName: 'Gold / Small',
      createdAt: NOW.toISOString(),
    });
    expect(res.body.meta.summary).toEqual({
      average: '4.50',
      count: 2,
      distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 1 },
    });
    expect(t.m.review.findMany.mock.calls[0]?.[0].where).toMatchObject({
      status: 'APPROVED',
      deletedAt: null,
    });
    expect((await request(t.app).get('/api/v1/products/jhumka/reviews?limit=51')).status).toBe(422);
    t.m.product.findUnique.mockResolvedValue(null);
    expect((await request(t.app).get('/api/v1/products/none/reviews')).status).toBe(404);
  });

  it('GET /me/reviews returns only the caller’s reviews', async () => {
    const t = setup();
    const c = t.customer();
    t.m.review.findMany.mockResolvedValue([]);
    t.m.review.count.mockResolvedValue(0);
    const res = await request(t.app).get('/api/v1/me/reviews').set(c.headers);
    expect(res.status).toBe(200);
    expect(t.m.review.findMany.mock.calls[0]?.[0].where).toEqual({
      userId: c.ctx.userId,
      deletedAt: null,
    });
  });
});

describe('reviews — admin moderation', () => {
  const perms = ['reviews.view', 'reviews.approve', 'reviews.delete'];

  it('lists PENDING by default', async () => {
    const t = setup();
    const auth = t.staff({ permissions: perms }).headers;
    t.m.review.findMany.mockResolvedValue([adminRow()]);
    t.m.review.count.mockResolvedValue(1);
    const res = await request(t.app).get('/api/v1/admin/reviews').set(auth);
    expect(res.status).toBe(200);
    expect(t.m.review.findMany.mock.calls[0]?.[0].where).toMatchObject({
      status: 'PENDING',
      deletedAt: null,
    });
    expect(res.body.data[0]).toMatchObject({
      customer: { name: 'Ananya Rao' },
      orderNumber: 'ORD-261119-00001',
    });
  });

  it('approve recomputes aggregates and audits; approving twice → 409', async () => {
    const t = setup();
    const staff = t.staff({ permissions: perms });
    const row = adminRow();
    t.m.review.findUnique.mockResolvedValue(row);
    t.m.review.update.mockResolvedValue({ ...row, status: 'APPROVED', moderatedAt: NOW });
    t.m.review.aggregate.mockResolvedValue({ _avg: { rating: 4.25 }, _count: { _all: 4 } });
    const res = await request(t.app)
      .post(`/api/v1/admin/reviews/${row.id}/approve`)
      .set(staff.headers);
    expect(res.status).toBe(200);
    expect(t.m.review.update.mock.calls[0]?.[0].data).toEqual({
      status: 'APPROVED',
      moderatedAt: NOW,
      moderatedById: staff.ctx.userId,
    });
    expect(t.m.product.update.mock.calls[0]?.[0]).toMatchObject({
      where: { id: PRODUCT_ID },
      data: { reviewCount: 4 },
    });
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data).toMatchObject({
      action: 'STATUS_CHANGE',
      module: 'reviews',
    });

    t.m.review.findUnique.mockResolvedValue(adminRow('APPROVED'));
    const again = await request(t.app)
      .post(`/api/v1/admin/reviews/${row.id}/approve`)
      .set(staff.headers);
    expect(again.status).toBe(409);
  });

  it('reject needs a reason; rejecting an approved review recomputes aggregates', async () => {
    const t = setup();
    const auth = t.staff({ permissions: perms }).headers;
    const row = adminRow('APPROVED');
    expect(
      (await request(t.app).post(`/api/v1/admin/reviews/${row.id}/reject`).set(auth).send({}))
        .status,
    ).toBe(422);
    t.m.review.findUnique.mockResolvedValue(row);
    t.m.review.update.mockResolvedValue({ ...row, status: 'REJECTED' });
    t.m.review.aggregate.mockResolvedValue({ _avg: { rating: null }, _count: { _all: 0 } });
    const res = await request(t.app)
      .post(`/api/v1/admin/reviews/${row.id}/reject`)
      .set(auth)
      .send({ reason: 'Contains personal data', shareWithCustomer: true });
    expect(res.status).toBe(200);
    expect(t.m.product.update).toHaveBeenCalled();
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data.reason).toBe('Contains personal data');
  });

  it('DELETE soft-deletes with a text snapshot in the audit row; unknown → 404', async () => {
    const t = setup();
    const auth = t.staff({ permissions: perms }).headers;
    const row = adminRow('PENDING');
    t.m.review.findUnique.mockResolvedValue(row);
    const res = await request(t.app).delete(`/api/v1/admin/reviews/${row.id}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: row.id, deleted: true });
    expect(t.m.review.update.mock.calls[0]?.[0].data).toEqual({ deletedAt: NOW });
    const audit = t.m.auditLog.create.mock.calls[0]?.[0].data;
    expect(audit.action).toBe('DELETE');
    expect(audit.oldValues).toMatchObject({ body: row.body, rating: 4 });
    t.m.review.findUnique.mockResolvedValue(null);
    expect((await request(t.app).delete(`/api/v1/admin/reviews/${row.id}`).set(auth)).status).toBe(
      404,
    );
  });

  it('a viewer cannot moderate (403)', async () => {
    const t = setup();
    const viewer = t.staff({ permissions: ['reviews.view'] });
    const res = await request(t.app)
      .post(`/api/v1/admin/reviews/${randomUUID()}/approve`)
      .set(viewer.headers);
    expect(res.status).toBe(403);
  });
});
