/**
 * Brand HTTP adapter: validated input → service → envelope.
 */
import type { Request, Response } from 'express';

import { ok } from '../../core/http/envelope.js';
import { actorFromRequest } from '../../core/middleware/auth.js';
import { getValidated } from '../../core/middleware/validate.js';
import {
  BrandIdParams,
  BrandListQuery,
  CreateBrandBody,
  UpdateBrandBody,
} from './brands.schemas.js';
import type { BrandsService } from './brands.service.js';

export function createBrandsController(service: BrandsService) {
  return {
    list: async (req: Request, res: Response): Promise<void> => {
      const { items, meta } = await service.list(getValidated(req, 'query', BrandListQuery));
      ok(req, res, items, { meta });
    },
    get: async (req: Request, res: Response): Promise<void> => {
      const { brandId } = getValidated(req, 'params', BrandIdParams);
      ok(req, res, await service.get(brandId));
    },
    create: async (req: Request, res: Response): Promise<void> => {
      const body = getValidated(req, 'body', CreateBrandBody);
      ok(req, res, await service.create(actorFromRequest(req), body), { status: 201 });
    },
    update: async (req: Request, res: Response): Promise<void> => {
      const { brandId } = getValidated(req, 'params', BrandIdParams);
      const body = getValidated(req, 'body', UpdateBrandBody);
      ok(req, res, await service.update(actorFromRequest(req), brandId, body));
    },
    remove: async (req: Request, res: Response): Promise<void> => {
      const { brandId } = getValidated(req, 'params', BrandIdParams);
      ok(req, res, await service.remove(actorFromRequest(req), brandId));
    },
    restore: async (req: Request, res: Response): Promise<void> => {
      const { brandId } = getValidated(req, 'params', BrandIdParams);
      ok(req, res, await service.restore(actorFromRequest(req), brandId));
    },
    listPublic: async (req: Request, res: Response): Promise<void> => {
      const items = await service.listPublic();
      ok(req, res, items, { meta: { totalItems: items.length } });
    },
  };
}

export type BrandsController = ReturnType<typeof createBrandsController>;
