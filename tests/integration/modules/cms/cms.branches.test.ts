/**
 * CMS HTTP — banner states/scheduling, page & block CRUD edge cases (not found, duplicates,
 * category checks, status-only changes, filters) through the real Express app.
 * MOCKED DB (tests/helpers/mockDb.ts): no SQL runs; assertions target service logic and contracts.
 */
import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createCmsModule } from '../../../../src/modules/cms/index.js';
import { buildModuleTestApp } from '../../../helpers/container.js';

const NOW = new Date('2026-11-19T06:30:00.000Z');
const PAST = new Date('2026-11-01T00:00:00.000Z');
const FUTURE = new Date('2026-12-01T00:00:00.000Z');
const IMG = 'https://res.cloudinary.com/demo/image/upload/banners/hero.jpg';
const PERMS = [
  'banners.view',
  'banners.create',
  'banners.update',
  'banners.delete',
  'cms.view',
  'cms.create',
  'cms.update',
  'cms.delete',
];

function setup() {
  const t = buildModuleTestApp([createCmsModule], { now: NOW });
  t.m.auditLog.create.mockResolvedValue({});
  const auth = t.staff({ permissions: PERMS }).headers;
  return { t, auth };
}

function bannerRow(over: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    placement: 'HOME_HERO',
    title: 'Festive edit',
    desktopImageUrl: IMG,
    mobileImageUrl: null,
    altText: 'Gold jhumkas',
    linkUrl: '/collections/festive',
    categoryId: null,
    startsAt: null,
    endsAt: null,
    isActive: true,
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function pageRow(over: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    slug: 'about-us',
    title: 'About us',
    pageType: 'ABOUT',
    status: 'PUBLISHED',
    content: '<p>Hello</p>',
    version: 1,
    seoTitle: null,
    seoDescription: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...over,
  };
}

function blockRow(over: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    blockKey: 'home.story',
    page: 'home',
    type: 'RICH_TEXT',
    content: { title: 'Story', html: '<p>Hi</p>' },
    categoryId: null,
    sortOrder: 0,
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

const lastAudit = (t: ReturnType<typeof setup>['t']) =>
  t.m.auditLog.create.mock.calls.at(-1)?.[0].data as Record<string, unknown>;

describe('cms banners — states, filters, CRUD edges', () => {
  it('GET /admin/banners/:id derives LIVE / SCHEDULED / EXPIRED / INACTIVE and 404s', async () => {
    const { t, auth } = setup();
    const cases: [Record<string, unknown>, string, string][] = [
      [{ startsAt: PAST, endsAt: FUTURE }, 'LIVE', 'ACTIVE'],
      [{ startsAt: FUTURE }, 'SCHEDULED', 'ACTIVE'],
      [{ endsAt: PAST }, 'EXPIRED', 'ACTIVE'],
      [{ endsAt: NOW }, 'EXPIRED', 'ACTIVE'],
      [{ isActive: false, startsAt: FUTURE }, 'INACTIVE', 'INACTIVE'],
      [{}, 'LIVE', 'ACTIVE'],
    ];
    for (const [over, state, status] of cases) {
      const row = bannerRow(over);
      t.m.banner.findUnique.mockResolvedValueOnce(row);
      const res = await request(t.app).get(`/api/v1/admin/banners/${row.id}`).set(auth);
      expect(res.status, state).toBe(200);
      expect(res.body.data).toMatchObject({ id: row.id, state, status });
    }
    const live = bannerRow({ startsAt: PAST, endsAt: FUTURE });
    t.m.banner.findUnique.mockResolvedValueOnce(live);
    const dto = await request(t.app).get(`/api/v1/admin/banners/${live.id}`).set(auth);
    expect(dto.body.data).toMatchObject({
      startsAt: PAST.toISOString(),
      endsAt: FUTURE.toISOString(),
      ctaHref: '/collections/festive',
      image: { desktopUrl: IMG, mobileUrl: null, altText: 'Gold jhumkas' },
    });

    t.m.banner.findUnique.mockResolvedValueOnce(null);
    const missing = await request(t.app).get(`/api/v1/admin/banners/${randomUUID()}`).set(auth);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
    expect((await request(t.app).get('/api/v1/admin/banners/not-a-uuid').set(auth)).status).toBe(
      422,
    );
  });

  it('GET /admin/banners maps each state filter onto a Prisma where and combines placement', async () => {
    const { t, auth } = setup();
    t.m.banner.findMany.mockResolvedValue([bannerRow()]);
    t.m.banner.count.mockResolvedValue(1);
    const expected: Record<string, unknown> = {
      LIVE: {
        isActive: true,
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: NOW } }] },
          { OR: [{ endsAt: null }, { endsAt: { gt: NOW } }] },
        ],
      },
      EXPIRED: { isActive: true, endsAt: { lte: NOW } },
      INACTIVE: { isActive: false },
    };
    for (const [state, where] of Object.entries(expected)) {
      t.m.banner.findMany.mockClear();
      const res = await request(t.app).get(`/api/v1/admin/banners?state=${state}`).set(auth);
      expect(res.status).toBe(200);
      expect(t.m.banner.findMany.mock.calls[0]?.[0].where).toEqual(where);
    }
    t.m.banner.findMany.mockClear();
    const both = await request(t.app)
      .get('/api/v1/admin/banners?placement=HOME_HERO&state=INACTIVE')
      .set(auth);
    expect(both.status).toBe(200);
    expect(both.body.meta.totalItems).toBe(1);
    expect(t.m.banner.findMany.mock.calls[0]?.[0].where).toEqual({
      placement: 'HOME_HERO',
      isActive: false,
    });
    t.m.banner.findMany.mockClear();
    await request(t.app).get('/api/v1/admin/banners').set(auth);
    expect(t.m.banner.findMany.mock.calls[0]?.[0].where).toEqual({});
    expect((await request(t.app).get('/api/v1/admin/banners?state=NOPE').set(auth)).status).toBe(
      422,
    );
  });

  it('GET /banners (public) filters by categoryId and omits absent filters', async () => {
    const { t } = setup();
    const categoryId = randomUUID();
    t.m.banner.findMany.mockResolvedValue([]);
    const res = await request(t.app).get(`/api/v1/banners?categoryId=${categoryId}`);
    expect(res.status).toBe(200);
    expect(res.body.meta.totalItems).toBe(0);
    const where = t.m.banner.findMany.mock.calls[0]?.[0].where;
    expect(where.categoryId).toBe(categoryId);
    expect(where).not.toHaveProperty('placement');
    expect((await request(t.app).get('/api/v1/banners?categoryId=x')).status).toBe(422);
  });

  it('POST /admin/banners checks the category (missing / deleted → 422) and stores optional fields', async () => {
    const { t, auth } = setup();
    const categoryId = randomUUID();
    const body = {
      placement: 'HOME_HERO',
      title: 'Bridal',
      desktopImageUrl: IMG,
      mobileImageUrl: IMG,
      altText: 'Bridal set',
      ctaHref: 'https://localhost:5173/bridal',
      categoryId,
      status: 'INACTIVE',
      sortOrder: 3,
    };
    t.m.category.findUnique.mockResolvedValueOnce(null);
    const missing = await request(t.app).post('/api/v1/admin/banners').set(auth).send(body);
    expect(missing.status).toBe(422);
    expect(missing.body.error.details[0]).toMatchObject({ field: 'categoryId' });

    t.m.category.findUnique.mockResolvedValueOnce({ deletedAt: PAST });
    const deleted = await request(t.app).post('/api/v1/admin/banners').set(auth).send(body);
    expect(deleted.status).toBe(422);
    expect(t.m.banner.create).not.toHaveBeenCalled();

    t.m.category.findUnique.mockResolvedValueOnce({ deletedAt: null });
    t.m.banner.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve(bannerRow(data)),
    );
    const ok = await request(t.app).post('/api/v1/admin/banners').set(auth).send(body);
    expect(ok.status).toBe(201);
    expect(t.m.banner.create.mock.calls[0]?.[0].data).toMatchObject({
      title: 'Bridal',
      mobileImageUrl: IMG,
      linkUrl: 'https://localhost:5173/bridal',
      categoryId,
      isActive: false,
      sortOrder: 3,
      startsAt: null,
      endsAt: null,
    });
    expect(ok.body.data).toMatchObject({ status: 'INACTIVE', state: 'INACTIVE' });

    // https to a foreign host is not an allowed CTA (open-redirect guard).
    const foreign = await request(t.app)
      .post('/api/v1/admin/banners')
      .set(auth)
      .send({ ...body, ctaHref: 'https://evil.example/x' });
    expect(foreign.status).toBe(422);
    expect(foreign.body.error.details[0]).toMatchObject({ field: 'ctaHref', code: 'INVALID_URL' });
  });

  it('PATCH /admin/banners: 404, bad href, end-before-existing-start, category check', async () => {
    const { t, auth } = setup();
    const id = randomUUID();
    t.m.banner.findUnique.mockResolvedValueOnce(null);
    const missing = await request(t.app)
      .patch(`/api/v1/admin/banners/${id}`)
      .set(auth)
      .send({ title: 'x' });
    expect(missing.status).toBe(404);

    const badHref = await request(t.app)
      .patch(`/api/v1/admin/banners/${id}`)
      .set(auth)
      .send({ ctaHref: 'javascript:alert(1)' });
    expect(badHref.status).toBe(422);
    expect(badHref.body.error.details[0].code).toBe('INVALID_URL');

    // endsAt alone is before the stored startsAt → service-level schedule check.
    t.m.banner.findUnique.mockResolvedValueOnce(bannerRow({ id, startsAt: FUTURE }));
    const order = await request(t.app)
      .patch(`/api/v1/admin/banners/${id}`)
      .set(auth)
      .send({ endsAt: '2026-11-25T00:00:00.000Z' });
    expect(order.status).toBe(422);
    expect(order.body.error.details[0]).toMatchObject({ field: 'endsAt' });

    // startsAt alone after the stored endsAt → same rule from the other side.
    t.m.banner.findUnique.mockResolvedValueOnce(bannerRow({ id, endsAt: PAST }));
    const order2 = await request(t.app)
      .patch(`/api/v1/admin/banners/${id}`)
      .set(auth)
      .send({ startsAt: '2026-11-10T00:00:00.000Z' });
    expect(order2.status).toBe(422);

    t.m.banner.findUnique.mockResolvedValueOnce(bannerRow({ id }));
    t.m.category.findUnique.mockResolvedValueOnce({ deletedAt: PAST });
    const cat = await request(t.app)
      .patch(`/api/v1/admin/banners/${id}`)
      .set(auth)
      .send({ categoryId: randomUUID() });
    expect(cat.status).toBe(422);
    expect(t.m.banner.update).not.toHaveBeenCalled();

    const empty = await request(t.app).patch(`/api/v1/admin/banners/${id}`).set(auth).send({});
    expect(empty.status).toBe(422);
  });

  it('PATCH /admin/banners writes every provided field (UPDATE) and clears the schedule with null', async () => {
    const { t, auth } = setup();
    const before = bannerRow({ startsAt: PAST, endsAt: FUTURE });
    t.m.banner.findUnique.mockResolvedValue(before);
    t.m.banner.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...before, ...data }),
    );
    const res = await request(t.app).patch(`/api/v1/admin/banners/${before.id}`).set(auth).send({
      placement: 'HOME_HERO',
      title: null,
      desktopImageUrl: IMG,
      mobileImageUrl: null,
      altText: 'New alt',
      ctaHref: null,
      categoryId: null,
      startsAt: null,
      endsAt: null,
      sortOrder: 7,
      status: 'ACTIVE',
    });
    expect(res.status).toBe(200);
    expect(t.m.banner.update.mock.calls[0]?.[0].data).toEqual({
      placement: 'HOME_HERO',
      title: null,
      desktopImageUrl: IMG,
      mobileImageUrl: null,
      altText: 'New alt',
      linkUrl: null,
      categoryId: null,
      startsAt: null,
      endsAt: null,
      sortOrder: 7,
      isActive: true,
    });
    expect(t.m.category.findUnique).not.toHaveBeenCalled();
    expect(res.body.data).toMatchObject({ startsAt: null, endsAt: null, state: 'LIVE' });
    expect(lastAudit(t)).toMatchObject({ action: 'UPDATE', module: 'banners' });

    // A valid new window after the stored start is accepted.
    t.m.banner.update.mockClear();
    const window = await request(t.app)
      .patch(`/api/v1/admin/banners/${before.id}`)
      .set(auth)
      .send({ startsAt: '2026-11-20T00:00:00.000Z', endsAt: '2026-11-30T00:00:00.000Z' });
    expect(window.status).toBe(200);
    expect(t.m.banner.update.mock.calls[0]?.[0].data).toEqual({
      startsAt: new Date('2026-11-20T00:00:00.000Z'),
      endsAt: new Date('2026-11-30T00:00:00.000Z'),
    });
    expect(window.body.data.state).toBe('SCHEDULED');
  });

  it('PATCH /admin/banners with only status audits STATUS_CHANGE', async () => {
    const { t, auth } = setup();
    const before = bannerRow();
    t.m.banner.findUnique.mockResolvedValue(before);
    t.m.banner.update.mockResolvedValue({ ...before, isActive: false });
    const res = await request(t.app)
      .patch(`/api/v1/admin/banners/${before.id}`)
      .set(auth)
      .send({ status: 'INACTIVE' });
    expect(res.status).toBe(200);
    expect(t.m.banner.update.mock.calls[0]?.[0].data).toEqual({ isActive: false });
    expect(res.body.data).toMatchObject({ status: 'INACTIVE', state: 'INACTIVE' });
    expect(lastAudit(t)).toMatchObject({ action: 'STATUS_CHANGE', module: 'banners' });
  });

  it('DELETE /admin/banners hard-deletes with an audit snapshot; unknown id → 404', async () => {
    const { t, auth } = setup();
    const row = bannerRow();
    t.m.banner.findUnique.mockResolvedValueOnce(row);
    const res = await request(t.app).delete(`/api/v1/admin/banners/${row.id}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: row.id, deleted: true });
    expect(t.m.banner.delete.mock.calls[0]?.[0]).toEqual({ where: { id: row.id } });
    expect(lastAudit(t)).toMatchObject({ action: 'DELETE', module: 'banners', entityId: row.id });

    t.m.banner.findUnique.mockResolvedValueOnce(null);
    const missing = await request(t.app).delete(`/api/v1/admin/banners/${row.id}`).set(auth);
    expect(missing.status).toBe(404);
    expect(t.m.banner.delete).toHaveBeenCalledTimes(1);
  });

  it('banner routes enforce their own permission keys', async () => {
    const { t } = setup();
    const viewer = t.staff({ permissions: ['banners.view'] }).headers;
    const id = randomUUID();
    expect(
      (await request(t.app).patch(`/api/v1/admin/banners/${id}`).set(viewer).send({ title: 'x' }))
        .status,
    ).toBe(403);
    expect((await request(t.app).delete(`/api/v1/admin/banners/${id}`).set(viewer)).status).toBe(
      403,
    );
    expect((await request(t.app).get('/api/v1/admin/banners')).status).toBe(401);
  });
});

describe('cms pages — list/get/update/delete edges', () => {
  it('GET /admin/cms/pages applies status + q filters and excludes deleted pages', async () => {
    const { t, auth } = setup();
    t.m.cmsPage.findMany.mockResolvedValue([pageRow({ content: null, seoTitle: 'SEO' })]);
    t.m.cmsPage.count.mockResolvedValue(1);
    const res = await request(t.app).get('/api/v1/admin/cms/pages?status=DRAFT&q=about').set(auth);
    expect(res.status).toBe(200);
    expect(t.m.cmsPage.findMany.mock.calls[0]?.[0].where).toEqual({
      deletedAt: null,
      status: 'DRAFT',
      OR: [{ title: { contains: 'about' } }, { slug: { contains: 'about' } }],
    });
    expect(res.body.data[0]).toMatchObject({
      bodyHtml: '',
      seo: { title: 'SEO', description: null },
      deleted: false,
    });
    t.m.cmsPage.findMany.mockClear();
    await request(t.app).get('/api/v1/admin/cms/pages').set(auth);
    expect(t.m.cmsPage.findMany.mock.calls[0]?.[0].where).toEqual({ deletedAt: null });
    expect(
      (await request(t.app).get('/api/v1/admin/cms/pages?status=ARCHIVED').set(auth)).status,
    ).toBe(422);
  });

  it('GET /admin/cms/pages/:id returns live pages and 404s missing or soft-deleted ones', async () => {
    const { t, auth } = setup();
    const row = pageRow({ status: 'DRAFT' });
    t.m.cmsPage.findUnique.mockResolvedValueOnce(row);
    const res = await request(t.app).get(`/api/v1/admin/cms/pages/${row.id}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: row.id, status: 'DRAFT', version: 1 });
    t.m.cmsPage.findUnique.mockResolvedValueOnce(null);
    expect((await request(t.app).get(`/api/v1/admin/cms/pages/${row.id}`).set(auth)).status).toBe(
      404,
    );
    t.m.cmsPage.findUnique.mockResolvedValueOnce(pageRow({ deletedAt: PAST }));
    expect((await request(t.app).get(`/api/v1/admin/cms/pages/${row.id}`).set(auth)).status).toBe(
      404,
    );
  });

  it('GET /cms/pages/:slug: unknown slug → 404; null content → empty bodyHtml; bad slug → 422', async () => {
    const { t } = setup();
    t.m.cmsPage.findUnique.mockResolvedValueOnce(null);
    expect((await request(t.app).get('/api/v1/cms/pages/nope')).status).toBe(404);
    t.m.cmsPage.findUnique.mockResolvedValueOnce(
      pageRow({ content: null, seoDescription: 'Desc' }),
    );
    const res = await request(t.app).get('/api/v1/cms/pages/about-us');
    expect(res.body.data).toMatchObject({
      bodyHtml: '',
      seo: { title: null, description: 'Desc' },
    });
    expect((await request(t.app).get('/api/v1/cms/pages/Bad--Slug!')).status).toBe(422);
  });

  it('POST /admin/cms/pages stores seo fields and PUBLISHED status', async () => {
    const { t, auth } = setup();
    t.m.cmsPage.findUnique.mockResolvedValue(null);
    t.m.cmsPage.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve(pageRow(data)),
    );
    const res = await request(t.app)
      .post('/api/v1/admin/cms/pages')
      .set(auth)
      .send({
        slug: 'Returns',
        title: 'Returns',
        status: 'PUBLISHED',
        seo: { title: 'Returns policy', description: 'How returns work' },
      });
    expect(res.status).toBe(201);
    expect(t.m.cmsPage.create.mock.calls[0]?.[0].data).toMatchObject({
      slug: 'returns',
      pageType: 'GENERIC',
      status: 'PUBLISHED',
      content: '',
      seoTitle: 'Returns policy',
      seoDescription: 'How returns work',
      version: 1,
    });
    expect(lastAudit(t)).toMatchObject({ action: 'CREATE', module: 'cms' });
    const bad = await request(t.app)
      .post('/api/v1/admin/cms/pages')
      .set(auth)
      .send({ slug: 'ok', title: 'Ok', seo: { keywords: 'x' } });
    expect(bad.status).toBe(422);
  });

  it('PATCH /admin/cms/pages: 404 (missing/deleted), slug clash → 409, own slug skips the check', async () => {
    const { t, auth } = setup();
    const row = pageRow();
    t.m.cmsPage.findUnique.mockResolvedValueOnce(null);
    expect(
      (
        await request(t.app)
          .patch(`/api/v1/admin/cms/pages/${row.id}`)
          .set(auth)
          .send({ title: 'New title' })
      ).status,
    ).toBe(404);
    t.m.cmsPage.findUnique.mockResolvedValueOnce(pageRow({ deletedAt: PAST }));
    expect(
      (
        await request(t.app)
          .patch(`/api/v1/admin/cms/pages/${row.id}`)
          .set(auth)
          .send({ title: 'New title' })
      ).status,
    ).toBe(404);

    t.m.cmsPage.findUnique
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce(pageRow({ slug: 'contact' }));
    const clash = await request(t.app)
      .patch(`/api/v1/admin/cms/pages/${row.id}`)
      .set(auth)
      .send({ slug: 'contact' });
    expect(clash.status).toBe(409);
    expect(clash.body.error.details[0]).toMatchObject({ field: 'slug', code: 'DUPLICATE' });
    expect(t.m.cmsPage.update).not.toHaveBeenCalled();

    t.m.cmsPage.findUnique.mockReset();
    t.m.cmsPage.findUnique.mockResolvedValueOnce(row).mockResolvedValueOnce(null);
    t.m.cmsPage.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...row, ...data, version: 1 }),
    );
    const renamed = await request(t.app)
      .patch(`/api/v1/admin/cms/pages/${row.id}`)
      .set(auth)
      .send({ slug: 'about', pageType: 'policy' });
    expect(renamed.status).toBe(200);
    expect(t.m.cmsPage.update.mock.calls[0]?.[0].data).toEqual({
      slug: 'about',
      pageType: 'POLICY',
    });
    expect(lastAudit(t)).toMatchObject({ action: 'UPDATE' });

    t.m.cmsPage.findUnique.mockReset();
    t.m.cmsPage.findUnique.mockResolvedValueOnce(row);
    const same = await request(t.app)
      .patch(`/api/v1/admin/cms/pages/${row.id}`)
      .set(auth)
      .send({ slug: 'about-us' });
    expect(same.status).toBe(200);
    expect(t.m.cmsPage.findUnique).toHaveBeenCalledTimes(1);
  });

  it('PATCH /admin/cms/pages: status-only is STATUS_CHANGE without a version bump; seo bumps version', async () => {
    const { t, auth } = setup();
    const row = pageRow({ status: 'DRAFT' });
    t.m.cmsPage.findUnique.mockResolvedValue(row);
    t.m.cmsPage.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...row, ...data, version: 1 }),
    );
    const publish = await request(t.app)
      .patch(`/api/v1/admin/cms/pages/${row.id}`)
      .set(auth)
      .send({ status: 'PUBLISHED' });
    expect(publish.status).toBe(200);
    expect(t.m.cmsPage.update.mock.calls[0]?.[0].data).toEqual({ status: 'PUBLISHED' });
    expect(lastAudit(t)).toMatchObject({ action: 'STATUS_CHANGE', module: 'cms' });

    const seo = await request(t.app)
      .patch(`/api/v1/admin/cms/pages/${row.id}`)
      .set(auth)
      .send({ seo: { title: 'T', description: null } });
    expect(seo.status).toBe(200);
    expect(t.m.cmsPage.update.mock.calls[1]?.[0].data).toEqual({
      seoTitle: 'T',
      seoDescription: null,
      version: { increment: 1 },
    });

    const seoDescOnly = await request(t.app)
      .patch(`/api/v1/admin/cms/pages/${row.id}`)
      .set(auth)
      .send({ seo: { description: 'Only desc' }, status: 'DRAFT', title: 'Renamed' });
    expect(seoDescOnly.status).toBe(200);
    expect(t.m.cmsPage.update.mock.calls[2]?.[0].data).toEqual({
      title: 'Renamed',
      status: 'DRAFT',
      seoDescription: 'Only desc',
      version: { increment: 1 },
    });
    expect(lastAudit(t)).toMatchObject({ action: 'UPDATE' });
  });

  it('DELETE /admin/cms/pages 404s for missing and already-deleted pages', async () => {
    const { t, auth } = setup();
    const id = randomUUID();
    t.m.cmsPage.findUnique.mockResolvedValueOnce(null);
    expect((await request(t.app).delete(`/api/v1/admin/cms/pages/${id}`).set(auth)).status).toBe(
      404,
    );
    t.m.cmsPage.findUnique.mockResolvedValueOnce(pageRow({ deletedAt: PAST }));
    expect((await request(t.app).delete(`/api/v1/admin/cms/pages/${id}`).set(auth)).status).toBe(
      404,
    );
    expect(t.m.cmsPage.update).not.toHaveBeenCalled();
  });
});

describe('cms blocks — list/get/create/update/delete edges', () => {
  it('GET /admin/cms/blocks applies placement/type/status filters', async () => {
    const { t, auth } = setup();
    t.m.cmsBlock.findMany.mockResolvedValue([blockRow({ isActive: false })]);
    t.m.cmsBlock.count.mockResolvedValue(1);
    const res = await request(t.app)
      .get('/api/v1/admin/cms/blocks?placement=Home&type=RICH_TEXT&status=INACTIVE')
      .set(auth);
    expect(res.status).toBe(200);
    expect(t.m.cmsBlock.findMany.mock.calls[0]?.[0].where).toEqual({
      page: 'home',
      type: 'RICH_TEXT',
      isActive: false,
    });
    expect(res.body.data[0]).toMatchObject({ key: 'home.story', status: 'INACTIVE' });
    t.m.cmsBlock.findMany.mockClear();
    await request(t.app).get('/api/v1/admin/cms/blocks?status=ACTIVE').set(auth);
    expect(t.m.cmsBlock.findMany.mock.calls[0]?.[0].where).toEqual({ isActive: true });
    t.m.cmsBlock.findMany.mockClear();
    await request(t.app).get('/api/v1/admin/cms/blocks').set(auth);
    expect(t.m.cmsBlock.findMany.mock.calls[0]?.[0].where).toEqual({});
  });

  it('GET /admin/cms/blocks/:id returns the block or 404', async () => {
    const { t, auth } = setup();
    const row = blockRow();
    t.m.cmsBlock.findUnique.mockResolvedValueOnce(row);
    const res = await request(t.app).get(`/api/v1/admin/cms/blocks/${row.id}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: row.id, placement: 'home', status: 'ACTIVE' });
    t.m.cmsBlock.findUnique.mockResolvedValueOnce(null);
    expect((await request(t.app).get(`/api/v1/admin/cms/blocks/${row.id}`).set(auth)).status).toBe(
      404,
    );
  });

  it('POST /admin/cms/blocks: duplicate key → 409, bad category → 422, rich text needs html', async () => {
    const { t, auth } = setup();
    const body = {
      key: 'home.story',
      type: 'RICH_TEXT',
      content: { html: '<p>x</p>' },
      categoryId: randomUUID(),
      status: 'INACTIVE',
    };
    t.m.cmsBlock.findUnique.mockResolvedValueOnce(blockRow());
    const dup = await request(t.app).post('/api/v1/admin/cms/blocks').set(auth).send(body);
    expect(dup.status).toBe(409);
    expect(dup.body.error.details[0]).toMatchObject({ field: 'key', code: 'DUPLICATE' });

    t.m.cmsBlock.findUnique.mockResolvedValueOnce(null);
    t.m.category.findUnique.mockResolvedValueOnce(null);
    const cat = await request(t.app).post('/api/v1/admin/cms/blocks').set(auth).send(body);
    expect(cat.status).toBe(422);
    expect(cat.body.error.details[0].field).toBe('categoryId');

    const noHtml = await request(t.app)
      .post('/api/v1/admin/cms/blocks')
      .set(auth)
      .send({ key: 'home.x', type: 'RICH_TEXT', content: { title: 'no html' } });
    expect(noHtml.status).toBe(422);
    expect(noHtml.body.error.details[0].field).toBe('content.html');

    t.m.cmsBlock.findUnique.mockResolvedValueOnce(null);
    t.m.category.findUnique.mockResolvedValueOnce({ deletedAt: null });
    t.m.cmsBlock.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...data, createdAt: NOW, updatedAt: NOW }),
    );
    const ok = await request(t.app).post('/api/v1/admin/cms/blocks').set(auth).send(body);
    expect(ok.status).toBe(201);
    expect(t.m.cmsBlock.create.mock.calls[0]?.[0].data).toMatchObject({
      categoryId: body.categoryId,
      isActive: false,
    });
    expect(ok.body.data.status).toBe('INACTIVE');
  });

  it('PATCH /admin/cms/blocks: 404, key clash 409, type change re-validates stored content', async () => {
    const { t, auth } = setup();
    const row = blockRow();
    t.m.cmsBlock.findUnique.mockResolvedValueOnce(null);
    expect(
      (
        await request(t.app)
          .patch(`/api/v1/admin/cms/blocks/${row.id}`)
          .set(auth)
          .send({ sortOrder: 1 })
      ).status,
    ).toBe(404);

    t.m.cmsBlock.findUnique
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce(blockRow({ blockKey: 'home.other' }));
    const clash = await request(t.app)
      .patch(`/api/v1/admin/cms/blocks/${row.id}`)
      .set(auth)
      .send({ key: 'home.other' });
    expect(clash.status).toBe(409);

    // Switching a PROMO block to RICH_TEXT without new content: stored content has no html → 422.
    t.m.cmsBlock.findUnique.mockResolvedValueOnce(
      blockRow({ type: 'PROMO_BANNER', content: { ctaHref: '/sale' } }),
    );
    const retype = await request(t.app)
      .patch(`/api/v1/admin/cms/blocks/${row.id}`)
      .set(auth)
      .send({ type: 'RICH_TEXT' });
    expect(retype.status).toBe(422);
    expect(retype.body.error.details[0].field).toBe('content.html');

    const badLink = blockRow({ type: 'PROMO_BANNER', content: {} });
    t.m.cmsBlock.findUnique.mockResolvedValueOnce(badLink);
    const unsafe = await request(t.app)
      .patch(`/api/v1/admin/cms/blocks/${row.id}`)
      .set(auth)
      .send({ content: { ctaHref: 'javascript:x' } });
    expect(unsafe.status).toBe(422);
    expect(t.m.cmsBlock.update).not.toHaveBeenCalled();
  });

  it('PATCH /admin/cms/blocks writes all fields; same key skips the clash lookup; status-only → STATUS_CHANGE', async () => {
    const { t, auth } = setup();
    const row = blockRow();
    const categoryId = randomUUID();
    t.m.cmsBlock.findUnique.mockResolvedValue(row);
    t.m.category.findUnique.mockResolvedValue({ deletedAt: null });
    t.m.cmsBlock.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...row, ...data }),
    );
    const res = await request(t.app)
      .patch(`/api/v1/admin/cms/blocks/${row.id}`)
      .set(auth)
      .send({
        key: 'home.story',
        type: 'RICH_TEXT',
        placement: 'Category',
        content: { html: '<p>New<script>x</script></p>' },
        categoryId,
        sortOrder: 4,
        status: 'ACTIVE',
      });
    expect(res.status).toBe(200);
    expect(t.m.cmsBlock.findUnique).toHaveBeenCalledTimes(1);
    expect(t.m.cmsBlock.update.mock.calls[0]?.[0].data).toEqual({
      blockKey: 'home.story',
      type: 'RICH_TEXT',
      page: 'category',
      content: { html: '<p>New</p>' },
      categoryId,
      sortOrder: 4,
      isActive: true,
    });
    expect(lastAudit(t)).toMatchObject({ action: 'UPDATE', entityType: 'CmsBlock' });

    const status = await request(t.app)
      .patch(`/api/v1/admin/cms/blocks/${row.id}`)
      .set(auth)
      .send({ status: 'INACTIVE' });
    expect(status.status).toBe(200);
    expect(t.m.cmsBlock.update.mock.calls[1]?.[0].data).toEqual({ isActive: false });
    expect(lastAudit(t)).toMatchObject({ action: 'STATUS_CHANGE' });

    // New, free key is checked and accepted; categoryId null skips the category lookup.
    t.m.cmsBlock.findUnique.mockReset();
    t.m.category.findUnique.mockClear();
    t.m.cmsBlock.findUnique.mockResolvedValueOnce(row).mockResolvedValueOnce(null);
    const rekey = await request(t.app)
      .patch(`/api/v1/admin/cms/blocks/${row.id}`)
      .set(auth)
      .send({ key: 'home.new', categoryId: null });
    expect(rekey.status).toBe(200);
    expect(t.m.cmsBlock.update.mock.calls[2]?.[0].data).toEqual({
      blockKey: 'home.new',
      categoryId: null,
    });
    expect(t.m.category.findUnique).not.toHaveBeenCalled();
  });

  it('DELETE /admin/cms/blocks hard-deletes or 404s', async () => {
    const { t, auth } = setup();
    const row = blockRow();
    t.m.cmsBlock.findUnique.mockResolvedValueOnce(row);
    const res = await request(t.app).delete(`/api/v1/admin/cms/blocks/${row.id}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: row.id, deleted: true });
    expect(lastAudit(t)).toMatchObject({ action: 'DELETE', entityType: 'CmsBlock' });
    t.m.cmsBlock.findUnique.mockResolvedValueOnce(null);
    expect(
      (await request(t.app).delete(`/api/v1/admin/cms/blocks/${row.id}`).set(auth)).status,
    ).toBe(404);
    expect(t.m.cmsBlock.delete).toHaveBeenCalledTimes(1);
  });

  it('GET /cms/home tolerates non-object content and non-string titles', async () => {
    const { t } = setup();
    t.m.cmsBlock.findMany.mockResolvedValue([
      blockRow({ blockKey: 'a', content: ['x'] }),
      blockRow({ blockKey: 'b', content: null }),
      blockRow({ blockKey: 'c', content: { title: 42 } }),
    ]);
    const res = await request(t.app).get('/api/v1/cms/home');
    expect(res.status).toBe(200);
    expect(res.body.data.sections).toEqual([
      { key: 'a', type: 'RICH_TEXT', title: null, content: {} },
      { key: 'b', type: 'RICH_TEXT', title: null, content: {} },
      { key: 'c', type: 'RICH_TEXT', title: null, content: { title: 42 } },
    ]);
  });
});
