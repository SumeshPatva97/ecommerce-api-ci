/**
 * Attribute HTTP adapter: validated input → service → envelope.
 */
import type { Request, Response } from 'express';

import { ok } from '../../core/http/envelope.js';
import { actorFromRequest } from '../../core/middleware/auth.js';
import { getValidated } from '../../core/middleware/validate.js';
import {
  AttributeIdParams,
  AttributeListQuery,
  AttributeValueListQuery,
  AttributeValueParams,
  CreateAttributeBody,
  CreateAttributeValueBody,
  UpdateAttributeBody,
  UpdateAttributeValueBody,
} from './attributes.schemas.js';
import type { AttributesService } from './attributes.service.js';

export function createAttributesController(service: AttributesService) {
  return {
    list: async (req: Request, res: Response): Promise<void> => {
      const { items, meta } = await service.list(getValidated(req, 'query', AttributeListQuery));
      ok(req, res, items, { meta });
    },
    get: async (req: Request, res: Response): Promise<void> => {
      const { attributeId } = getValidated(req, 'params', AttributeIdParams);
      ok(req, res, await service.get(attributeId));
    },
    create: async (req: Request, res: Response): Promise<void> => {
      const body = getValidated(req, 'body', CreateAttributeBody);
      ok(req, res, await service.create(actorFromRequest(req), body), { status: 201 });
    },
    update: async (req: Request, res: Response): Promise<void> => {
      const { attributeId } = getValidated(req, 'params', AttributeIdParams);
      const body = getValidated(req, 'body', UpdateAttributeBody);
      ok(req, res, await service.update(actorFromRequest(req), attributeId, body));
    },
    remove: async (req: Request, res: Response): Promise<void> => {
      const { attributeId } = getValidated(req, 'params', AttributeIdParams);
      ok(req, res, await service.remove(actorFromRequest(req), attributeId));
    },
    restore: async (req: Request, res: Response): Promise<void> => {
      const { attributeId } = getValidated(req, 'params', AttributeIdParams);
      ok(req, res, await service.restore(actorFromRequest(req), attributeId));
    },
    listValues: async (req: Request, res: Response): Promise<void> => {
      const { attributeId } = getValidated(req, 'params', AttributeIdParams);
      const query = getValidated(req, 'query', AttributeValueListQuery);
      const { items, meta } = await service.listValues(attributeId, query);
      ok(req, res, items, { meta });
    },
    getValue: async (req: Request, res: Response): Promise<void> => {
      const { attributeId, valueId } = getValidated(req, 'params', AttributeValueParams);
      ok(req, res, await service.getValue(attributeId, valueId));
    },
    createValue: async (req: Request, res: Response): Promise<void> => {
      const { attributeId } = getValidated(req, 'params', AttributeIdParams);
      const body = getValidated(req, 'body', CreateAttributeValueBody);
      ok(req, res, await service.createValue(actorFromRequest(req), attributeId, body), {
        status: 201,
      });
    },
    updateValue: async (req: Request, res: Response): Promise<void> => {
      const { attributeId, valueId } = getValidated(req, 'params', AttributeValueParams);
      const body = getValidated(req, 'body', UpdateAttributeValueBody);
      ok(req, res, await service.updateValue(actorFromRequest(req), attributeId, valueId, body));
    },
    removeValue: async (req: Request, res: Response): Promise<void> => {
      const { attributeId, valueId } = getValidated(req, 'params', AttributeValueParams);
      ok(req, res, await service.removeValue(actorFromRequest(req), attributeId, valueId));
    },
  };
}

export type AttributesController = ReturnType<typeof createAttributesController>;
