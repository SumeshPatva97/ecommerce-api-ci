/**
 * Category HTTP adapter: validated input → service → envelope.
 */
import type { Request, Response } from 'express';

import { ok } from '../../core/http/envelope.js';
import { actorFromRequest } from '../../core/middleware/auth.js';
import { getValidated } from '../../core/middleware/validate.js';
import {
  CategoryIdParams,
  CategoryListQuery,
  CategorySlugParams,
  CreateCategoryBody,
  PublicCategoryTreeQuery,
  ReorderCategoriesBody,
  ReplaceCategoryAttributesBody,
  UpdateCategoryBody,
} from './categories.schemas.js';
import type { CategoriesService } from './categories.service.js';

export function createCategoriesController(service: CategoriesService) {
  return {
    list: async (req: Request, res: Response): Promise<void> => {
      const { items, meta } = await service.list(getValidated(req, 'query', CategoryListQuery));
      ok(req, res, items, { meta });
    },
    get: async (req: Request, res: Response): Promise<void> => {
      const { categoryId } = getValidated(req, 'params', CategoryIdParams);
      ok(req, res, await service.get(categoryId));
    },
    create: async (req: Request, res: Response): Promise<void> => {
      const body = getValidated(req, 'body', CreateCategoryBody);
      ok(req, res, await service.create(actorFromRequest(req), body), { status: 201 });
    },
    update: async (req: Request, res: Response): Promise<void> => {
      const { categoryId } = getValidated(req, 'params', CategoryIdParams);
      const body = getValidated(req, 'body', UpdateCategoryBody);
      ok(req, res, await service.update(actorFromRequest(req), categoryId, body));
    },
    remove: async (req: Request, res: Response): Promise<void> => {
      const { categoryId } = getValidated(req, 'params', CategoryIdParams);
      ok(req, res, await service.remove(actorFromRequest(req), categoryId));
    },
    restore: async (req: Request, res: Response): Promise<void> => {
      const { categoryId } = getValidated(req, 'params', CategoryIdParams);
      ok(req, res, await service.restore(actorFromRequest(req), categoryId));
    },
    reorder: async (req: Request, res: Response): Promise<void> => {
      const body = getValidated(req, 'body', ReorderCategoriesBody);
      ok(req, res, await service.reorder(actorFromRequest(req), body));
    },
    getAttributes: async (req: Request, res: Response): Promise<void> => {
      const { categoryId } = getValidated(req, 'params', CategoryIdParams);
      ok(req, res, await service.getAttributes(categoryId));
    },
    replaceAttributes: async (req: Request, res: Response): Promise<void> => {
      const { categoryId } = getValidated(req, 'params', CategoryIdParams);
      const body = getValidated(req, 'body', ReplaceCategoryAttributesBody);
      ok(req, res, await service.replaceAttributes(actorFromRequest(req), categoryId, body));
    },
    publicTree: async (req: Request, res: Response): Promise<void> => {
      const tree = await service.publicTree(getValidated(req, 'query', PublicCategoryTreeQuery));
      ok(req, res, tree);
    },
    publicDetail: async (req: Request, res: Response): Promise<void> => {
      const { slug } = getValidated(req, 'params', CategorySlugParams);
      ok(req, res, await service.publicDetail(slug));
    },
  };
}

export type CategoriesController = ReturnType<typeof createCategoriesController>;
