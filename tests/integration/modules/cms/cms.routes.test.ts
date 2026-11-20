/**
 * CMS HTTP — banners (scheduling), pages (sanitised rich text), blocks, public home.
 * MOCKED DB (tests/helpers/mockDb.ts): no SQL runs.
 */
import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createCmsModule } from '../../../../src/modules/cms/index.js';
import { buildModuleTestApp } from '../../../helpers/container.js';
import { expectAdminRoutesGuarded } from '../../../helpers/routeTable.js';

const NOW = new Date('2026-11-19T06:30:00.000Z');
const IMG = 'https://res.cloudinary.com/demo/image/upload/banners/hero.jpg';

function setup() {
  const t = buildModuleTestApp([createCmsModule], { now: NOW });
  t.m.auditLog.create.mockResolvedValue({});
  return t;
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

describe('cms — guards & public', () => {
  it('guards admin routes with banners.* / cms.*', () => {
    const t = setup();
    const routes = expectAdminRoutesGuarded(createCmsModule(t.container));
    const perms = new Set(routes.flatMap((r) => r.permissions));
    expect([...perms].sort()).toEqual([
      'banners.create',
      'banners.delete',
      'banners.update',
      'banners.view',
      'cms.create',
      'cms.delete',
      'cms.update',
      'cms.view',
    ]);
    expect(routes).toHaveLength(15);
  });

  it('GET /banners applies the schedule window and placement filter', async () => {
    const t = setup();
    t.m.banner.findMany.mockResolvedValue([bannerRow()]);
    const res = await request(t.app).get('/api/v1/banners?placement=HOME_HERO');
    expect(res.status).toBe(200);
    expect(t.m.banner.findMany.mock.calls[0]?.[0].where).toEqual({
      isActive: true,
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: NOW } }] },
        { OR: [{ endsAt: null }, { endsAt: { gt: NOW } }] },
      ],
      placement: 'HOME_HERO',
    });
    expect(res.body.data[0]).toMatchObject({
      title: 'Festive edit',
      subtitle: null,
      image: { desktopUrl: IMG, altText: 'Gold jhumkas' },
      ctaHref: '/collections/festive',
    });
    expect(res.headers['cache-control']).toContain('public');
    expect((await request(t.app).get('/api/v1/banners?placement=NOPE')).status).toBe(422);
  });

  it('GET /cms/pages/:slug serves only PUBLISHED, non-deleted pages', async () => {
    const t = setup();
    t.m.cmsPage.findUnique.mockResolvedValue(pageRow());
    const res = await request(t.app).get('/api/v1/cms/pages/about-us');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ slug: 'about-us', bodyHtml: '<p>Hello</p>' });
    t.m.cmsPage.findUnique.mockResolvedValue(pageRow({ status: 'DRAFT' }));
    expect((await request(t.app).get('/api/v1/cms/pages/about-us')).status).toBe(404);
    t.m.cmsPage.findUnique.mockResolvedValue(pageRow({ deletedAt: NOW }));
    expect((await request(t.app).get('/api/v1/cms/pages/about-us')).status).toBe(404);
  });

  it('GET /cms/home returns ordered active home sections', async () => {
    const t = setup();
    t.m.cmsBlock.findMany.mockResolvedValue([
      {
        id: randomUUID(),
        blockKey: 'home.hero',
        page: 'home',
        type: 'HERO_CAROUSEL',
        content: { title: 'Hero', slides: [] },
        categoryId: null,
        sortOrder: 0,
        isActive: true,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    const res = await request(t.app).get('/api/v1/cms/home');
    expect(res.status).toBe(200);
    expect(res.body.data.sections).toEqual([
      {
        key: 'home.hero',
        type: 'HERO_CAROUSEL',
        title: 'Hero',
        content: { title: 'Hero', slides: [] },
      },
    ]);
    expect(t.m.cmsBlock.findMany.mock.calls[0]?.[0].where).toEqual({
      page: 'home',
      isActive: true,
    });
  });
});

describe('cms — admin', () => {
  const perms = [
    'banners.view',
    'banners.create',
    'banners.update',
    'banners.delete',
    'cms.view',
    'cms.create',
    'cms.update',
    'cms.delete',
  ];

  it('creates a scheduled banner (audited) and rejects unsafe links / bad schedules / non-Cloudinary images', async () => {
    const t = setup();
    const auth = t.staff({ permissions: perms }).headers;
    t.m.banner.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve(bannerRow(data)),
    );
    const res = await request(t.app).post('/api/v1/admin/banners').set(auth).send({
      placement: 'HOME_HERO',
      desktopImageUrl: IMG,
      altText: 'Gold jhumkas',
      ctaHref: 'http://localhost:5173/sale',
      startsAt: '2026-11-20T00:00:00.000Z',
      endsAt: '2026-11-30T00:00:00.000Z',
    });
    expect(res.status).toBe(422); // http (not https) storefront link
    const ok = await request(t.app).post('/api/v1/admin/banners').set(auth).send({
      placement: 'HOME_HERO',
      desktopImageUrl: IMG,
      altText: 'Gold jhumkas',
      ctaHref: '/sale',
      startsAt: '2026-11-20T00:00:00.000Z',
      endsAt: '2026-11-30T00:00:00.000Z',
    });
    expect(ok.status).toBe(201);
    expect(ok.body.data.state).toBe('SCHEDULED');
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data).toMatchObject({
      action: 'CREATE',
      module: 'banners',
    });

    const cases = [
      { ctaHref: 'javascript:alert(1)' },
      { ctaHref: '//evil.example' },
      { desktopImageUrl: 'https://evil.example/x.jpg' },
      { startsAt: '2026-11-30T00:00:00.000Z', endsAt: '2026-11-20T00:00:00.000Z' },
      { altText: undefined },
      { unknownField: 1 },
    ];
    for (const patch of cases) {
      const r = await request(t.app)
        .post('/api/v1/admin/banners')
        .set(auth)
        .send({ placement: 'HOME_HERO', desktopImageUrl: IMG, altText: 'x', ...patch });
      expect(r.status, JSON.stringify(patch)).toBe(422);
    }
  });

  it('page create sanitises bodyHtml (SECURITY_GUIDELINES §5) and blocks duplicate slugs', async () => {
    const t = setup();
    const auth = t.staff({ permissions: perms }).headers;
    t.m.cmsPage.findUnique.mockResolvedValue(null);
    t.m.cmsPage.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve(pageRow(data)),
    );
    const res = await request(t.app).post('/api/v1/admin/cms/pages').set(auth).send({
      slug: 'shipping-policy',
      title: 'Shipping policy',
      pageType: 'policy',
      bodyHtml:
        '<h2 style="color:red">Policy</h2><script>steal()</script><a href="javascript:x" onclick="y">x</a><img src="https://evil.example/a.png">',
    });
    expect(res.status).toBe(201);
    const data = t.m.cmsPage.create.mock.calls[0]?.[0].data;
    expect(data.content).toBe('<h2>Policy</h2><a rel="noopener noreferrer">x</a>');
    expect(data.pageType).toBe('POLICY');
    expect(data.status).toBe('DRAFT');

    t.m.cmsPage.findUnique.mockResolvedValue(pageRow({ slug: 'shipping-policy' }));
    const dup = await request(t.app)
      .post('/api/v1/admin/cms/pages')
      .set(auth)
      .send({ slug: 'shipping-policy', title: 'Again' });
    expect(dup.status).toBe(409);
  });

  it('page update bumps version and re-sanitises; delete is soft', async () => {
    const t = setup();
    const auth = t.staff({ permissions: perms }).headers;
    const row = pageRow();
    t.m.cmsPage.findUnique.mockResolvedValue(row);
    t.m.cmsPage.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...row, ...data, version: 2 }),
    );
    const res = await request(t.app)
      .patch(`/api/v1/admin/cms/pages/${row.id}`)
      .set(auth)
      .send({ bodyHtml: '<p>New<iframe src="x"></iframe></p>' });
    expect(res.status).toBe(200);
    expect(t.m.cmsPage.update.mock.calls[0]?.[0].data).toMatchObject({
      content: '<p>New</p>',
      version: { increment: 1 },
    });
    const del = await request(t.app).delete(`/api/v1/admin/cms/pages/${row.id}`).set(auth);
    expect(del.status).toBe(200);
    expect(t.m.cmsPage.update.mock.calls[1]?.[0].data).toEqual({ deletedAt: NOW });
  });

  it('block create sanitises *html content and rejects unsafe links', async () => {
    const t = setup();
    const auth = t.staff({ permissions: perms }).headers;
    t.m.cmsBlock.findUnique.mockResolvedValue(null);
    t.m.cmsBlock.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...data, createdAt: NOW, updatedAt: NOW }),
    );
    const res = await request(t.app)
      .post('/api/v1/admin/cms/blocks')
      .set(auth)
      .send({
        key: 'home.story',
        type: 'RICH_TEXT',
        content: { title: 'Our story', html: '<p>Handmade<script>x()</script></p>' },
      });
    expect(res.status).toBe(201);
    expect(t.m.cmsBlock.create.mock.calls[0]?.[0].data).toMatchObject({
      blockKey: 'home.story',
      page: 'home',
      content: { title: 'Our story', html: '<p>Handmade</p>' },
    });
    const bad = await request(t.app)
      .post('/api/v1/admin/cms/blocks')
      .set(auth)
      .send({
        key: 'home.promo',
        type: 'PROMO_BANNER',
        content: { ctaHref: 'javascript:alert(1)' },
      });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details[0]).toMatchObject({
      field: 'content.ctaHref',
      code: 'INVALID_URL',
    });
  });

  it('admin banner list filters by state (SCHEDULED) and lacks permission → 403', async () => {
    const t = setup();
    const auth = t.staff({ permissions: perms }).headers;
    t.m.banner.findMany.mockResolvedValue([]);
    t.m.banner.count.mockResolvedValue(0);
    const res = await request(t.app).get('/api/v1/admin/banners?state=SCHEDULED').set(auth);
    expect(res.status).toBe(200);
    expect(t.m.banner.findMany.mock.calls[0]?.[0].where).toEqual({
      isActive: true,
      startsAt: { gt: NOW },
    });
    const viewer = t.staff({ permissions: ['cms.view'] });
    expect((await request(t.app).get('/api/v1/admin/banners').set(viewer.headers)).status).toBe(
      403,
    );
  });
});
