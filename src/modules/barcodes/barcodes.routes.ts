/** Barcode routes — API_DOCUMENTATION.md §4.6, §7 (`barcodes.view` / `barcodes.create`). */
import { Router } from 'express';

import type { AppContainer } from '../../container.js';
import { ok } from '../../core/http/envelope.js';
import { actorFromRequest } from '../../core/middleware/auth.js';
import { getValidated, validate } from '../../core/middleware/validate.js';
import { BarcodeImageQuery, LabelsBody, PreviewBody, VariantIdParams } from './barcodes.schemas.js';
import type { BarcodeService } from './barcodes.service.js';

export function createBarcodesAdminRouter(c: AppContainer, service: BarcodeService): Router {
  const router = Router();
  const requirePermission = (key: string) => c.auth.requirePermission(key);

  router.get(
    '/product-variants/:variantId/barcode',
    requirePermission('barcodes.view'),
    validate({ params: VariantIdParams, query: BarcodeImageQuery }),
    async (req, res) => {
      const { variantId } = getValidated(req, 'params', VariantIdParams);
      const query = getValidated(req, 'query', BarcodeImageQuery);
      const image = await service.image(variantId, query);
      res
        .status(200)
        .set('Content-Type', image.contentType)
        .set('Cache-Control', 'private, max-age=86400')
        .set('X-Barcode-Value', image.encodedValue)
        .send(image.body);
    },
  );

  router.post(
    '/barcodes/preview',
    requirePermission('barcodes.view'),
    validate({ body: PreviewBody }),
    async (req, res) => {
      ok(req, res, await service.preview(getValidated(req, 'body', PreviewBody)));
    },
  );

  // Rate class: the dedicated `barcode-labels` class (SECURITY_GUIDELINES §9, 30/min/user).
  // API_DOCUMENTATION §2.8 lists label PDFs under `admin-export`, whose canonical value
  // (10/hour/user, OQ-109) would block routine warehouse printing — flagged for owner review.
  router.post(
    '/barcodes/labels',
    c.rateLimit('barcode-labels'),
    requirePermission('barcodes.create'),
    validate({ body: LabelsBody }),
    async (req, res) => {
      const body = getValidated(req, 'body', LabelsBody);
      const result = await service.labels(actorFromRequest(req), body);
      res
        .status(200)
        .set('Content-Type', 'application/pdf')
        .set('Content-Disposition', `attachment; filename="${result.filename}"`)
        .set('X-Total-Labels', String(result.totalLabels))
        .send(result.pdf);
    },
  );

  return router;
}
