/**
 * CMS module (B8) — banners, CMS pages and blocks (admin CRUD + public home / page / banners).
 */
import type { ModuleFactory } from '../types.js';
import { createCmsAdminRouter, createCmsPublicRouter } from './cms.routes.js';
import { createCmsService } from './cms.service.js';

export const createCmsModule: ModuleFactory = (container) => {
  const service = createCmsService(container);
  return {
    name: 'cms',
    publicRouter: createCmsPublicRouter(container, service),
    adminRouter: createCmsAdminRouter(container, service),
  };
};

export {
  bannerState,
  createCmsService,
  liveBannerWhere,
  type BannerState,
  type CmsService,
} from './cms.service.js';
export { isAllowedHref, prepareBlockContent } from './cms.content.js';
