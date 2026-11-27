/**
 * Public cacheable GETs — conditional requests (API_DOCUMENTATION.md §2.5: `If-None-Match` /
 * `ETag` on public catalog & CMS GETs).
 *
 * Every envelope carries a per-request `requestId`, so an ETag computed over the whole body would
 * change on every response and `If-None-Match` could never produce 304. The ETag must depend on
 * the payload (`data` + `meta`) only.
 *
 * MOCKED DB (tests/helpers/mockDb.ts): verifies the HTTP contract only; no SQL is executed.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createBrandsModule } from '../../src/modules/brands/index.js';
import { buildModuleTestApp } from '../helpers/container.js';
import { brandRow } from './modules/catalog/fixtures.js';

function setup(productCount = 7) {
  const t = buildModuleTestApp([createBrandsModule]);
  t.m.brand.findMany.mockResolvedValue([
    {
      ...brandRow({ logoUrl: 'https://res.cloudinary.com/x/a', logoPublicId: 'brands/a' }),
      _count: { products: productCount },
    },
  ]);
  return t;
}

describe('public cacheable GET: ETag and If-None-Match', () => {
  it('returns the same ETag for the same payload although requestId differs per request', async () => {
    const t = setup();
    const first = await request(t.app).get('/api/v1/brands');
    const second = await request(t.app).get('/api/v1/brands');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.requestId).not.toBe(second.body.requestId);
    expect(first.headers.etag).toMatch(/^W\/"[^"]+"$/);
    expect(second.headers.etag).toBe(first.headers.etag);
  });

  it('answers 304 with no body when If-None-Match carries the current ETag', async () => {
    const t = setup();
    const first = await request(t.app).get('/api/v1/brands');
    const etag = String(first.headers.etag);

    const conditional = await request(t.app).get('/api/v1/brands').set('If-None-Match', etag);

    expect(conditional.status).toBe(304);
    expect(conditional.text).toBe('');
    expect(conditional.headers.etag).toBe(etag);
    expect(conditional.headers['cache-control']).toBe(
      'public, max-age=60, stale-while-revalidate=300',
    );
    // The request is still traceable although a 304 has no envelope.
    expect(conditional.headers['x-request-id']).toEqual(expect.any(String));
  });

  it('returns 200 with a new ETag once the payload changes', async () => {
    const before = await request(setup(7).app).get('/api/v1/brands');
    const t = setup(8);

    const after = await request(t.app)
      .get('/api/v1/brands')
      .set('If-None-Match', String(before.headers.etag));

    expect(after.status).toBe(200);
    expect(after.body.data[0].productCount).toBe(8);
    expect(after.headers.etag).not.toBe(before.headers.etag);
  });

  it('does not add a payload ETag to responses that are not publicly cacheable', async () => {
    const t = setup();
    t.m.brand.findMany.mockResolvedValue([]);
    t.m.brand.count.mockResolvedValue(0);
    const auth = t.staff({ permissions: ['brands.view'] }).headers;

    const first = await request(t.app).get('/api/v1/admin/brands').set(auth);
    const second = await request(t.app)
      .get('/api/v1/admin/brands')
      .set(auth)
      .set('If-None-Match', String(first.headers.etag));

    expect(first.status).toBe(200);
    expect(first.headers['cache-control']).toContain('no-store');
    // Private responses are never revalidated to 304.
    expect(second.status).toBe(200);
  });
});
