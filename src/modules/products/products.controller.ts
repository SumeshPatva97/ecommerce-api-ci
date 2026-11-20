/**
 * Admin products HTTP adapter: validated input → service → envelope.
 */
import type { Request, Response } from 'express';

import { ok } from '../../core/http/envelope.js';
import { actorFromRequest, requireAuthz } from '../../core/middleware/auth.js';
import { getValidated } from '../../core/middleware/validate.js';
import { hasPermission } from '../rbac/permission.service.js';
import type { ImagesService } from './images.service.js';
import {
  AddImagesBody,
  AdminProductListQuery,
  AxisVariantBody,
  CheckDuplicateQuery,
  CreateProductBody,
  GenerateModeQuery,
  GenerateVariantsBody,
  ImageOrderBody,
  ImageParams,
  ProductIdParams,
  ProductStatusBody,
  UpdateImageBody,
  UpdateProductBody,
  UpdateVariantBody,
  VariantIdParams,
} from './products.schemas.js';
import type { ProductsService } from './products.service.js';
import type { VariantsService } from './variants.service.js';

/** Cost price visibility (workflow §10, PROPOSED): `products.update` or `reports.view`. */
function view(req: Request): { canSeeCost: boolean } {
  const ctx = requireAuthz(req);
  return {
    canSeeCost: hasPermission(ctx, 'products.update') || hasPermission(ctx, 'reports.view'),
  };
}

export function createProductsController(
  products: ProductsService,
  variants: VariantsService,
  images: ImagesService,
) {
  const productId = (req: Request): string =>
    getValidated(req, 'params', ProductIdParams).productId;
  const variantId = (req: Request): string =>
    getValidated(req, 'params', VariantIdParams).variantId;

  return {
    list: async (req: Request, res: Response): Promise<void> => {
      const { items, meta } = await products.list(
        getValidated(req, 'query', AdminProductListQuery),
      );
      ok(req, res, items, { meta });
    },
    create: async (req: Request, res: Response): Promise<void> => {
      const body = getValidated(req, 'body', CreateProductBody);
      ok(req, res, await products.create(actorFromRequest(req), body), { status: 201 });
    },
    get: async (req: Request, res: Response): Promise<void> => {
      ok(req, res, await products.get(productId(req), view(req)));
    },
    update: async (req: Request, res: Response): Promise<void> => {
      const body = getValidated(req, 'body', UpdateProductBody);
      ok(req, res, await products.update(actorFromRequest(req), productId(req), body, view(req)));
    },
    remove: async (req: Request, res: Response): Promise<void> => {
      ok(req, res, await products.remove(actorFromRequest(req), productId(req)));
    },
    changeStatus: async (req: Request, res: Response): Promise<void> => {
      const body = getValidated(req, 'body', ProductStatusBody);
      ok(req, res, await products.changeStatus(actorFromRequest(req), productId(req), body));
    },
    checkDuplicate: async (req: Request, res: Response): Promise<void> => {
      ok(req, res, await products.checkDuplicate(getValidated(req, 'query', CheckDuplicateQuery)));
    },

    listVariants: async (req: Request, res: Response): Promise<void> => {
      const items = await variants.list(productId(req), view(req));
      ok(req, res, items, { meta: { totalItems: items.length } });
    },
    addVariant: async (req: Request, res: Response): Promise<void> => {
      const body = getValidated(req, 'body', AxisVariantBody);
      ok(req, res, await variants.add(actorFromRequest(req), productId(req), body), {
        status: 201,
      });
    },
    generateVariants: async (req: Request, res: Response): Promise<void> => {
      const { mode } = getValidated(req, 'query', GenerateModeQuery);
      const body = getValidated(req, 'body', GenerateVariantsBody);
      const result = await variants.generate(actorFromRequest(req), productId(req), mode, body);
      ok(req, res, result.data, { status: result.status });
    },
    updateVariant: async (req: Request, res: Response): Promise<void> => {
      const body = getValidated(req, 'body', UpdateVariantBody);
      ok(req, res, await variants.update(actorFromRequest(req), variantId(req), body, view(req)));
    },
    removeVariant: async (req: Request, res: Response): Promise<void> => {
      ok(req, res, await variants.remove(actorFromRequest(req), variantId(req)));
    },

    addImages: async (req: Request, res: Response): Promise<void> => {
      const body = getValidated(req, 'body', AddImagesBody);
      ok(req, res, await images.add(actorFromRequest(req), productId(req), body), { status: 201 });
    },
    updateImage: async (req: Request, res: Response): Promise<void> => {
      const params = getValidated(req, 'params', ImageParams);
      const body = getValidated(req, 'body', UpdateImageBody);
      ok(
        req,
        res,
        await images.update(actorFromRequest(req), params.productId, params.imageId, body),
      );
    },
    removeImage: async (req: Request, res: Response): Promise<void> => {
      const params = getValidated(req, 'params', ImageParams);
      ok(req, res, await images.remove(actorFromRequest(req), params.productId, params.imageId));
    },
    reorderImages: async (req: Request, res: Response): Promise<void> => {
      const body = getValidated(req, 'body', ImageOrderBody);
      ok(req, res, await images.reorder(actorFromRequest(req), productId(req), body.imageIds));
    },
  };
}

export type ProductsController = ReturnType<typeof createProductsController>;
