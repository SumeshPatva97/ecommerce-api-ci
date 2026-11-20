/**
 * CMS routes — API_DOCUMENTATION.md §3.11, §4.14.
 *
 * | GET  /cms/home · /cms/pages/:slug · /banners?placement=      | public  | public-read  |
 * | GET  /admin/banners[/:bannerId]                              | banners.view   | admin-read  |
 * | POST /admin/banners · PATCH/DELETE /admin/banners/:bannerId  | banners.create/update/delete | admin-write |
 * | GET  /admin/cms/pages[/:pageId] · /admin/cms/blocks[/:blockId] | cms.view     | admin-read  |
 * | POST/PATCH/DELETE pages & blocks                             | cms.create/update/delete | admin-write |
 *
 * `GET /settings/public` belongs to the settings module.
 */
import { Router } from 'express';

import type { AppContainer } from '../../container.js';
import { respondsWith } from '../../core/http/successStatus.js';
import { ok } from '../../core/http/envelope.js';
import { actorFromRequest } from '../../core/middleware/auth.js';
import { getValidated, validate } from '../../core/middleware/validate.js';
import { publicCache } from '../catalog-common/catalog.http.js';
import {
  BannerListQuery,
  BlockListQuery,
  CreateBannerBody,
  CreateBlockBody,
  CreatePageBody,
  IdParams,
  PageListQuery,
  PageSlugParams,
  PublicBannersQuery,
  UpdateBannerBody,
  UpdateBlockBody,
  UpdatePageBody,
} from './cms.schemas.js';
import type { CmsService } from './cms.service.js';

export function createCmsPublicRouter(c: AppContainer, cms: CmsService): Router {
  const router = Router();
  const read = c.rateLimit('public-read');
  router.get('/cms/home', read, publicCache, async (req, res) => {
    ok(req, res, await cms.home());
  });
  router.get(
    '/cms/pages/:slug',
    read,
    publicCache,
    validate({ params: PageSlugParams }),
    async (req, res) => {
      ok(req, res, await cms.publicPage(getValidated(req, 'params', PageSlugParams).slug));
    },
  );
  router.get(
    '/banners',
    read,
    publicCache,
    validate({ query: PublicBannersQuery }),
    async (req, res) => {
      const items = await cms.publicBanners(getValidated(req, 'query', PublicBannersQuery));
      ok(req, res, items, { meta: { totalItems: items.length } });
    },
  );
  return router;
}

export function createCmsAdminRouter(c: AppContainer, cms: CmsService): Router {
  const perm = (key: string) => c.auth.requirePermission(key);
  const write = c.rateLimit('admin-write');
  const router = Router();

  // Banners
  router.get(
    '/banners',
    perm('banners.view'),
    validate({ query: BannerListQuery }),
    async (req, res) => {
      const { items, meta } = await cms.listBanners(getValidated(req, 'query', BannerListQuery));
      ok(req, res, items, { meta });
    },
  );
  router.post(
    '/banners',
    perm('banners.create'),
    write,
    validate({ body: CreateBannerBody }),
    respondsWith(201),
    async (req, res) => {
      const body = getValidated(req, 'body', CreateBannerBody);
      ok(req, res, await cms.createBanner(actorFromRequest(req), body), { status: 201 });
    },
  );
  router.get(
    '/banners/:bannerId',
    perm('banners.view'),
    validate({ params: IdParams.banner }),
    async (req, res) => {
      ok(req, res, await cms.getBanner(getValidated(req, 'params', IdParams.banner).bannerId));
    },
  );
  router.patch(
    '/banners/:bannerId',
    perm('banners.update'),
    write,
    validate({ params: IdParams.banner, body: UpdateBannerBody }),
    async (req, res) => {
      const { bannerId } = getValidated(req, 'params', IdParams.banner);
      const body = getValidated(req, 'body', UpdateBannerBody);
      ok(req, res, await cms.updateBanner(actorFromRequest(req), bannerId, body));
    },
  );
  router.delete(
    '/banners/:bannerId',
    perm('banners.delete'),
    write,
    validate({ params: IdParams.banner }),
    async (req, res) => {
      const { bannerId } = getValidated(req, 'params', IdParams.banner);
      ok(req, res, await cms.deleteBanner(actorFromRequest(req), bannerId));
    },
  );

  // Pages
  router.get(
    '/cms/pages',
    perm('cms.view'),
    validate({ query: PageListQuery }),
    async (req, res) => {
      const { items, meta } = await cms.listPages(getValidated(req, 'query', PageListQuery));
      ok(req, res, items, { meta });
    },
  );
  router.post(
    '/cms/pages',
    perm('cms.create'),
    write,
    validate({ body: CreatePageBody }),
    respondsWith(201),
    async (req, res) => {
      const body = getValidated(req, 'body', CreatePageBody);
      ok(req, res, await cms.createPage(actorFromRequest(req), body), { status: 201 });
    },
  );
  router.get(
    '/cms/pages/:pageId',
    perm('cms.view'),
    validate({ params: IdParams.page }),
    async (req, res) => {
      ok(req, res, await cms.getPage(getValidated(req, 'params', IdParams.page).pageId));
    },
  );
  router.patch(
    '/cms/pages/:pageId',
    perm('cms.update'),
    write,
    validate({ params: IdParams.page, body: UpdatePageBody }),
    async (req, res) => {
      const { pageId } = getValidated(req, 'params', IdParams.page);
      const body = getValidated(req, 'body', UpdatePageBody);
      ok(req, res, await cms.updatePage(actorFromRequest(req), pageId, body));
    },
  );
  router.delete(
    '/cms/pages/:pageId',
    perm('cms.delete'),
    write,
    validate({ params: IdParams.page }),
    async (req, res) => {
      const { pageId } = getValidated(req, 'params', IdParams.page);
      ok(req, res, await cms.deletePage(actorFromRequest(req), pageId));
    },
  );

  // Blocks
  router.get(
    '/cms/blocks',
    perm('cms.view'),
    validate({ query: BlockListQuery }),
    async (req, res) => {
      const { items, meta } = await cms.listBlocks(getValidated(req, 'query', BlockListQuery));
      ok(req, res, items, { meta });
    },
  );
  router.post(
    '/cms/blocks',
    perm('cms.create'),
    write,
    validate({ body: CreateBlockBody }),
    respondsWith(201),
    async (req, res) => {
      const body = getValidated(req, 'body', CreateBlockBody);
      ok(req, res, await cms.createBlock(actorFromRequest(req), body), { status: 201 });
    },
  );
  router.get(
    '/cms/blocks/:blockId',
    perm('cms.view'),
    validate({ params: IdParams.block }),
    async (req, res) => {
      ok(req, res, await cms.getBlock(getValidated(req, 'params', IdParams.block).blockId));
    },
  );
  router.patch(
    '/cms/blocks/:blockId',
    perm('cms.update'),
    write,
    validate({ params: IdParams.block, body: UpdateBlockBody }),
    async (req, res) => {
      const { blockId } = getValidated(req, 'params', IdParams.block);
      const body = getValidated(req, 'body', UpdateBlockBody);
      ok(req, res, await cms.updateBlock(actorFromRequest(req), blockId, body));
    },
  );
  router.delete(
    '/cms/blocks/:blockId',
    perm('cms.delete'),
    write,
    validate({ params: IdParams.block }),
    async (req, res) => {
      const { blockId } = getValidated(req, 'params', IdParams.block);
      ok(req, res, await cms.deleteBlock(actorFromRequest(req), blockId));
    },
  );
  return router;
}
