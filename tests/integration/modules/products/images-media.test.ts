/**
 * Product images + signed upload parameters — MOCKED DB (no MySQL, no Cloudinary network calls).
 */
import { createHash, randomUUID } from 'node:crypto';

import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createMediaModule } from '../../../../src/modules/media/index.js';
import { createProductsModule } from '../../../../src/modules/products/index.js';
import { buildModuleTestApp, type ModuleTestApp } from '../../../helpers/container.js';
import { expectAdminRoutesGuarded } from '../../../helpers/routeTable.js';
import { primeEmptyDb, productCore, T0, UPLOAD_FOLDER } from './fixtures.js';

const product = productCore();
const folder = `${UPLOAD_FOLDER}/products/${product.id}`;

function imageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    productId: product.id,
    variantId: null,
    cloudinaryPublicId: `${folder}/${randomUUID()}`,
    url: 'x',
    altText: 'Front',
    width: null,
    height: null,
    format: null,
    sortOrder: 0,
    isPrimary: false,
    mediaType: 'IMAGE',
    createdAt: T0,
    ...overrides,
  };
}

describe('product images', () => {
  let t: ModuleTestApp;
  let headers: Record<string, string>;

  beforeEach(() => {
    t = buildModuleTestApp([createProductsModule]);
    primeEmptyDb(t.m);
    t.m.product.findFirst.mockResolvedValue(product);
    headers = t.staff({ permissions: ['products.update'] }).headers;
  });

  it('attaches an image inside the signed folder; the first image becomes primary', async () => {
    const res = await request(t.app)
      .post(`/api/v1/admin/products/${product.id}/images`)
      .set(headers)
      .send({ publicId: `${folder}/01jcxd`, altText: 'Front view' });
    expect(res.status).toBe(201);
    const image = res.body.data.images[0];
    expect(image).toMatchObject({ publicId: `${folder}/01jcxd`, isPrimary: true, sortOrder: 0 });
    expect(image.url).toContain(`f_auto,q_auto,w_1000/${folder}/01jcxd`);
    expect(image.thumbUrl).toContain('w_160');
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data).toMatchObject({
      action: 'CREATE',
      entityType: 'ProductImage',
    });
  });

  it('rejects public IDs outside the product folder and foreign variants (422)', async () => {
    const res = await request(t.app)
      .post(`/api/v1/admin/products/${product.id}/images`)
      .set(headers)
      .send({
        images: [
          { publicId: 'ecom/dev/products/other-product/x', altText: 'A' },
          { publicId: `${folder}/y`, altText: 'B', variantId: randomUUID() },
        ],
      });
    expect(res.status).toBe(422);
    expect((res.body.error.details as { code: string }[]).map((d) => d.code)).toEqual([
      'PUBLIC_ID_OUTSIDE_FOLDER',
      'VARIANT_NOT_IN_PRODUCT',
    ]);
  });

  it('requires altText and a well-formed publicId', async () => {
    const res = await request(t.app)
      .post(`/api/v1/admin/products/${product.id}/images`)
      .set(headers)
      .send({ publicId: '../etc/passwd' });
    expect(res.status).toBe(422);
  });

  it('reorders when the set matches exactly, else 422', async () => {
    const a = imageRow({ sortOrder: 0 });
    const b = imageRow({ sortOrder: 1 });
    t.m.productImage.findMany.mockResolvedValue([a, b]);
    const bad = await request(t.app)
      .put(`/api/v1/admin/products/${product.id}/images/order`)
      .set(headers)
      .send({ imageIds: [a.id] });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details[0].code).toBe('IMAGE_SET_MISMATCH');

    const res = await request(t.app)
      .put(`/api/v1/admin/products/${product.id}/images/order`)
      .set(headers)
      .send({ imageIds: [b.id, a.id] });
    expect(res.status).toBe(200);
    expect((res.body.data.images as { id: string }[]).map((i) => i.id)).toEqual([b.id, a.id]);
    expect(t.m.productImage.update.mock.calls.map((c): unknown => c[0])).toEqual([
      { where: { id: b.id }, data: { sortOrder: 0 } },
      { where: { id: a.id }, data: { sortOrder: 1 } },
    ]);
    expect(t.m.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('refuses to delete the last image of an ACTIVE product', async () => {
    const img = imageRow({ isPrimary: true });
    t.m.productImage.findFirst.mockResolvedValue(img);
    t.m.product.findFirst.mockResolvedValue({ ...product, status: 'ACTIVE' });
    t.m.productImage.count.mockResolvedValue(1);
    const res = await request(t.app)
      .delete(`/api/v1/admin/products/${product.id}/images/${img.id}`)
      .set(headers);
    expect(res.status).toBe(409);
    expect(res.body.error.details[0].code).toBe('LAST_IMAGE_OF_ACTIVE_PRODUCT');
    expect(t.m.productImage.delete).not.toHaveBeenCalled();
  });

  it('deletes an image row, promotes the next primary and audits', async () => {
    const img = imageRow({ isPrimary: true });
    t.m.productImage.findFirst.mockResolvedValueOnce(img).mockResolvedValueOnce({ id: 'next' });
    t.m.productImage.count.mockResolvedValue(2);
    const res = await request(t.app)
      .delete(`/api/v1/admin/products/${product.id}/images/${img.id}`)
      .set(headers);
    expect(res.status).toBe(200);
    expect(t.m.productImage.delete).toHaveBeenCalledWith({ where: { id: img.id } });
    expect(t.m.productImage.update).toHaveBeenCalledWith({
      where: { id: 'next' },
      data: { isPrimary: true },
    });
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data).toMatchObject({ action: 'DELETE' });
  });
});

describe('POST /admin/media/upload-signature', () => {
  const SECRET = 'cloudinary-test-secret-0123456789';

  it('is guarded by anyOf the purpose permissions', () => {
    const t = buildModuleTestApp([createMediaModule]);
    const routes = expectAdminRoutesGuarded(createMediaModule(t.container));
    expect(routes[0]?.permissions).toEqual(
      expect.arrayContaining([
        'products.create',
        'products.update',
        'banners.create',
        'banners.update',
      ]),
    );
  });

  it('signs folder/public_id/timestamp/allowed_formats locally and never returns the secret', async () => {
    const t = buildModuleTestApp([createMediaModule], {
      env: {
        MEDIA_PROVIDER: 'cloudinary',
        CLOUDINARY_CLOUD_NAME: 'demo-cloud',
        CLOUDINARY_API_KEY: '123456789012345',
        CLOUDINARY_API_SECRET: SECRET,
      },
    });
    primeEmptyDb(t.m);
    t.m.product.findFirst.mockResolvedValue({ id: product.id });
    const staff = t.staff({ permissions: ['products.update'] });
    const res = await request(t.app)
      .post('/api/v1/admin/media/upload-signature')
      .set(staff.headers)
      .send({ purpose: 'PRODUCT_IMAGE', entityId: product.id, fileName: 'front.jpg' });
    expect(res.status).toBe(200);
    const d = res.body.data;
    const timestamp = Math.floor(t.now.value.getTime() / 1000);
    expect(d).toMatchObject({
      mock: false,
      cloudName: 'demo-cloud',
      apiKey: '123456789012345',
      timestamp,
      folder,
      uploadUrl: 'https://api.cloudinary.com/v1_1/demo-cloud/image/upload',
      maxFileSizeBytes: 10 * 1024 * 1024,
      expiresAt: new Date((timestamp + 600) * 1000).toISOString(),
    });
    expect(d.publicId).toBe(`${folder}/${String(d.uploadParams.public_id)}`);
    const expected = createHash('sha1')
      .update(
        `allowed_formats=${String(d.uploadParams.allowed_formats)}&folder=${folder}` +
          `&public_id=${String(d.uploadParams.public_id)}&timestamp=${String(timestamp)}${SECRET}`,
      )
      .digest('hex');
    expect(d.signature).toBe(expected);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('returns a clearly-marked mock signature without credentials', async () => {
    const t = buildModuleTestApp([createMediaModule]);
    primeEmptyDb(t.m);
    t.m.product.findFirst.mockResolvedValue({ id: product.id });
    const staff = t.staff({ permissions: ['products.create'] });
    const res = await request(t.app)
      .post('/api/v1/admin/media/upload-signature')
      .set(staff.headers)
      .send({ purpose: 'PRODUCT_IMAGE', entityId: product.id });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ mock: true, cloudName: 'mock', apiKey: 'mock' });
    expect(res.body.data.signature).toMatch(/^mock_[0-9a-f]{40}$/);
    expect(res.body.data.uploadUrl).toMatch(/example\.invalid/);
  });

  it('enforces the per-purpose permission and the product existence', async () => {
    const t = buildModuleTestApp([createMediaModule]);
    primeEmptyDb(t.m);
    const staff = t.staff({ permissions: ['products.update'] });
    const banner = await request(t.app)
      .post('/api/v1/admin/media/upload-signature')
      .set(staff.headers)
      .send({ purpose: 'BANNER' });
    expect(banner.status).toBe(403);
    const missing = await request(t.app)
      .post('/api/v1/admin/media/upload-signature')
      .set(staff.headers)
      .send({ purpose: 'PRODUCT_IMAGE', entityId: randomUUID() });
    expect(missing.status).toBe(404);
    const noEntity = await request(t.app)
      .post('/api/v1/admin/media/upload-signature')
      .set(staff.headers)
      .send({ purpose: 'PRODUCT_IMAGE' });
    expect(noEntity.status).toBe(422);
  });
});
