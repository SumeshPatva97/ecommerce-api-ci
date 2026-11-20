/** Barcodes module (B4) — Code 128 images, label preview and label PDFs. */
import type { ModuleFactory } from '../types.js';
import { createBarcodesAdminRouter } from './barcodes.routes.js';
import { createBarcodeService } from './barcodes.service.js';

export const createBarcodesModule: ModuleFactory = (container) => {
  const service = createBarcodeService({
    db: container.db,
    audit: container.audit,
    clock: container.clock,
  });
  return { name: 'barcodes', adminRouter: createBarcodesAdminRouter(container, service) };
};

export {
  MAX_LABELS_PER_REQUEST,
  createBarcodeService,
  type BarcodeService,
  type BarcodeServiceDeps,
} from './barcodes.service.js';
export {
  LAYOUTS,
  renderBarcodePng,
  renderBarcodeSvg,
  renderLabelsPdf,
  type LayoutKey,
} from './barcodes.render.js';
