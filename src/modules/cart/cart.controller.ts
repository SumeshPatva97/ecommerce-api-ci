/**
 * Cart HTTP adapter (API_DOCUMENTATION.md §3.4): validated input → service → envelope. The cart
 * owner is always the authenticated customer.
 */
import type { Request, Response } from 'express';

import { ok } from '../../core/http/envelope.js';
import { requireAuthz } from '../../core/middleware/auth.js';
import { getValidated } from '../../core/middleware/validate.js';
import {
  AddCartItemBody,
  ApplyCouponBody,
  CartItemParams,
  MergeCartBody,
  UpdateCartItemBody,
} from './cart.schemas.js';
import type { CartService } from './cart.service.js';

export function createCartController(service: CartService) {
  return {
    get: async (req: Request, res: Response): Promise<void> => {
      ok(req, res, await service.get(requireAuthz(req).userId));
    },
    addItem: async (req: Request, res: Response): Promise<void> => {
      const body = getValidated(req, 'body', AddCartItemBody);
      ok(req, res, await service.addItem(requireAuthz(req).userId, body), { status: 201 });
    },
    updateItem: async (req: Request, res: Response): Promise<void> => {
      const { itemId } = getValidated(req, 'params', CartItemParams);
      const { quantity } = getValidated(req, 'body', UpdateCartItemBody);
      ok(req, res, await service.updateItem(requireAuthz(req).userId, itemId, quantity));
    },
    removeItem: async (req: Request, res: Response): Promise<void> => {
      const { itemId } = getValidated(req, 'params', CartItemParams);
      ok(req, res, await service.removeItem(requireAuthz(req).userId, itemId));
    },
    merge: async (req: Request, res: Response): Promise<void> => {
      const body = getValidated(req, 'body', MergeCartBody);
      ok(req, res, await service.merge(requireAuthz(req).userId, body));
    },
    applyCoupon: async (req: Request, res: Response): Promise<void> => {
      const { code } = getValidated(req, 'body', ApplyCouponBody);
      ok(req, res, await service.applyCoupon(requireAuthz(req).userId, code));
    },
    removeCoupon: async (req: Request, res: Response): Promise<void> => {
      ok(req, res, await service.removeCoupon(requireAuthz(req).userId));
    },
  };
}

export type CartController = ReturnType<typeof createCartController>;
