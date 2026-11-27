/**
 * Catalog module (B3, public) — `GET /products`, `/products/facets`, `/products/:slug`,
 * `/products/:slug/related` (`public-read`) and `GET /search/autocomplete` (`search`).
 * `GET /products/:slug/reviews` belongs to the reviews module.
 *
 * Caching: anonymous responses carry `Cache-Control: public, max-age=60,
 * stale-while-revalidate=300` (API §2.5); personalised detail (customer token → isWishlisted)
 * stays `private, no-store` (global default).
 */
import { Router, type Request, type Response } from 'express';

import { ok } from '../../core/http/envelope.js';
import { markPublicCache, publicCache } from '../../core/http/publicCache.js';
import { getValidated, validate } from '../../core/middleware/validate.js';
import { deliveryFromConfig } from '../media/cloudinary.js';
import type { ModuleFactory } from '../types.js';
import { createCatalogRepository } from './catalog.repository.js';
import {
  AutocompleteQuery,
  DetailQuery,
  ProductFilterQuery,
  ProductListQuery,
  RelatedQuery,
  SlugParams,
} from './catalog.schemas.js';
import { createCatalogService } from './catalog.service.js';

export const createCatalogModule: ModuleFactory = (container) => {
  const service = createCatalogService({
    db: container.db,
    repo: createCatalogRepository(container.db),
    clock: container.clock,
    delivery: deliveryFromConfig(container.config.integrations.media),
  });
  const read = container.rateLimit('public-read');
  const router = Router();

  router.get(
    '/products',
    read,
    validate({ query: ProductListQuery }),
    publicCache,
    async (req: Request, res: Response): Promise<void> => {
      const { items, meta } = await service.list(getValidated(req, 'query', ProductListQuery));
      ok(req, res, items, { meta });
    },
  );
  router.get(
    '/products/facets',
    read,
    validate({ query: ProductFilterQuery }),
    publicCache,
    async (req: Request, res: Response): Promise<void> => {
      const { data, meta } = await service.facets(getValidated(req, 'query', ProductFilterQuery));
      ok(req, res, data, { meta });
    },
  );
  router.get(
    '/products/:slug',
    read,
    container.auth.optionalAuthenticate('storefront'),
    validate({ params: SlugParams, query: DetailQuery }),
    async (req: Request, res: Response): Promise<void> => {
      const { slug } = getValidated(req, 'params', SlugParams);
      const { variant } = getValidated(req, 'query', DetailQuery);
      const customerId = req.authz?.accountType === 'CUSTOMER' ? req.authz.userId : undefined;
      const data = await service.detail(slug, { variantSku: variant, customerId });
      if (customerId === undefined) markPublicCache(res);
      ok(req, res, data);
    },
  );
  router.get(
    '/products/:slug/related',
    read,
    validate({ params: SlugParams, query: RelatedQuery }),
    publicCache,
    async (req: Request, res: Response): Promise<void> => {
      const { slug } = getValidated(req, 'params', SlugParams);
      const { limit } = getValidated(req, 'query', RelatedQuery);
      const items = await service.related(slug, limit);
      ok(req, res, items, { meta: { totalItems: items.length, limit } });
    },
  );
  router.get(
    '/search/autocomplete',
    container.rateLimit('search'),
    validate({ query: AutocompleteQuery }),
    publicCache,
    async (req: Request, res: Response): Promise<void> => {
      const { q } = getValidated(req, 'query', AutocompleteQuery);
      ok(req, res, await service.autocomplete(q));
    },
  );

  return { name: 'catalog', publicRouter: router };
};

export { createCatalogService, type CatalogService } from './catalog.service.js';
