/**
 * Admin promotion HTTP adapter (API_DOCUMENTATION.md §4.9).
 */
import type { Request, Response } from 'express';

import { ok } from '../../core/http/envelope.js';
import { actorFromRequest } from '../../core/middleware/auth.js';
import { getValidated } from '../../core/middleware/validate.js';
import {
  CreatePromotionBody,
  PromotionIdParams,
  PromotionListQuery,
  UpdatePromotionBody,
} from './promotions.schemas.js';
import type { PromotionsService } from './promotions.service.js';

export function createPromotionsController(service: PromotionsService) {
  const idOf = (req: Request): string => getValidated(req, 'params', PromotionIdParams).promotionId;
  return {
    list: async (req: Request, res: Response): Promise<void> => {
      const { items, meta } = await service.list(getValidated(req, 'query', PromotionListQuery));
      ok(req, res, items, { meta });
    },
    get: async (req: Request, res: Response): Promise<void> => {
      ok(req, res, await service.get(idOf(req)));
    },
    create: async (req: Request, res: Response): Promise<void> => {
      const body = getValidated(req, 'body', CreatePromotionBody);
      ok(req, res, await service.create(actorFromRequest(req), body), { status: 201 });
    },
    update: async (req: Request, res: Response): Promise<void> => {
      const body = getValidated(req, 'body', UpdatePromotionBody);
      ok(req, res, await service.update(actorFromRequest(req), idOf(req), body));
    },
    remove: async (req: Request, res: Response): Promise<void> => {
      ok(req, res, await service.remove(actorFromRequest(req), idOf(req)));
    },
    pause: async (req: Request, res: Response): Promise<void> => {
      ok(req, res, await service.pause(actorFromRequest(req), idOf(req)));
    },
    resume: async (req: Request, res: Response): Promise<void> => {
      ok(req, res, await service.resume(actorFromRequest(req), idOf(req)));
    },
  };
}

export type PromotionsController = ReturnType<typeof createPromotionsController>;
