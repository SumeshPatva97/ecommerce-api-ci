/**
 * Collection HTTP adapter: validated input → service → envelope.
 */
import type { Request, Response } from 'express';

import { ok } from '../../core/http/envelope.js';
import { actorFromRequest } from '../../core/middleware/auth.js';
import { getValidated } from '../../core/middleware/validate.js';
import {
  CollectionIdParams,
  CollectionListQuery,
  CollectionSlugParams,
  CreateCollectionBody,
  PublicCollectionListQuery,
  ReplaceCollectionProductsBody,
  UpdateCollectionBody,
} from './collections.schemas.js';
import type { CollectionsService } from './collections.service.js';

export function createCollectionsController(service: CollectionsService) {
  return {
    list: async (req: Request, res: Response): Promise<void> => {
      const { items, meta } = await service.list(getValidated(req, 'query', CollectionListQuery));
      ok(req, res, items, { meta });
    },
    get: async (req: Request, res: Response): Promise<void> => {
      const { collectionId } = getValidated(req, 'params', CollectionIdParams);
      ok(req, res, await service.get(collectionId));
    },
    create: async (req: Request, res: Response): Promise<void> => {
      const body = getValidated(req, 'body', CreateCollectionBody);
      ok(req, res, await service.create(actorFromRequest(req), body), { status: 201 });
    },
    update: async (req: Request, res: Response): Promise<void> => {
      const { collectionId } = getValidated(req, 'params', CollectionIdParams);
      const body = getValidated(req, 'body', UpdateCollectionBody);
      ok(req, res, await service.update(actorFromRequest(req), collectionId, body));
    },
    remove: async (req: Request, res: Response): Promise<void> => {
      const { collectionId } = getValidated(req, 'params', CollectionIdParams);
      ok(req, res, await service.remove(actorFromRequest(req), collectionId));
    },
    restore: async (req: Request, res: Response): Promise<void> => {
      const { collectionId } = getValidated(req, 'params', CollectionIdParams);
      ok(req, res, await service.restore(actorFromRequest(req), collectionId));
    },
    replaceProducts: async (req: Request, res: Response): Promise<void> => {
      const { collectionId } = getValidated(req, 'params', CollectionIdParams);
      const body = getValidated(req, 'body', ReplaceCollectionProductsBody);
      ok(req, res, await service.replaceProducts(actorFromRequest(req), collectionId, body));
    },
    listPublic: async (req: Request, res: Response): Promise<void> => {
      const items = await service.listPublic(getValidated(req, 'query', PublicCollectionListQuery));
      ok(req, res, items, { meta: { totalItems: items.length } });
    },
    getPublic: async (req: Request, res: Response): Promise<void> => {
      const { slug } = getValidated(req, 'params', CollectionSlugParams);
      ok(req, res, await service.getPublic(slug));
    },
  };
}

export type CollectionsController = ReturnType<typeof createCollectionsController>;
