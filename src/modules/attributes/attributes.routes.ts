/**
 * Attribute routes — API_DOCUMENTATION.md §4.4 (Attributes, Attribute values). Admin only.
 * Mounted under `/api/v1/admin` after `authenticate('admin')` + `admin-read`.
 */
import { Router } from 'express';

import type { AppContainer } from '../../container.js';
import { respondsWith } from '../../core/http/successStatus.js';
import { validate } from '../../core/middleware/validate.js';
import type { AttributesController } from './attributes.controller.js';
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

export function createAttributesAdminRouter(c: AppContainer, ctl: AttributesController): Router {
  const requirePermission = (...keys: string[]) => c.auth.requirePermission(...keys);
  const write = c.rateLimit('admin-write');
  const router = Router();

  router.get(
    '/attributes',
    requirePermission('attributes.view'),
    validate({ query: AttributeListQuery }),
    ctl.list,
  );
  router.post(
    '/attributes',
    requirePermission('attributes.create'),
    write,
    validate({ body: CreateAttributeBody }),
    respondsWith(201),
    ctl.create,
  );
  router.get(
    '/attributes/:attributeId',
    requirePermission('attributes.view'),
    validate({ params: AttributeIdParams }),
    ctl.get,
  );
  router.patch(
    '/attributes/:attributeId',
    requirePermission('attributes.update'),
    write,
    validate({ params: AttributeIdParams, body: UpdateAttributeBody }),
    ctl.update,
  );
  router.delete(
    '/attributes/:attributeId',
    requirePermission('attributes.delete'),
    write,
    validate({ params: AttributeIdParams }),
    ctl.remove,
  );
  // Added detail (OQ-39 "restore or rename"): restore reverses a soft delete → same permission.
  router.post(
    '/attributes/:attributeId/restore',
    requirePermission('attributes.delete'),
    write,
    validate({ params: AttributeIdParams }),
    ctl.restore,
  );

  router.get(
    '/attributes/:attributeId/values',
    requirePermission('attributes.view'),
    validate({ params: AttributeIdParams, query: AttributeValueListQuery }),
    ctl.listValues,
  );
  router.post(
    '/attributes/:attributeId/values',
    requirePermission('attributes.create'),
    write,
    validate({ params: AttributeIdParams, body: CreateAttributeValueBody }),
    respondsWith(201),
    ctl.createValue,
  );
  router.get(
    '/attributes/:attributeId/values/:valueId',
    requirePermission('attributes.view'),
    validate({ params: AttributeValueParams }),
    ctl.getValue,
  );
  router.patch(
    '/attributes/:attributeId/values/:valueId',
    requirePermission('attributes.update'),
    write,
    validate({ params: AttributeValueParams, body: UpdateAttributeValueBody }),
    ctl.updateValue,
  );
  router.delete(
    '/attributes/:attributeId/values/:valueId',
    requirePermission('attributes.delete'),
    write,
    validate({ params: AttributeValueParams }),
    ctl.removeValue,
  );
  return router;
}
