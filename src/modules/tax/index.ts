/** Tax module (B2) — admin tax masters, GST settings, preview; rate resolution for checkout. */
import type { ModuleFactory } from '../types.js';
import { createTaxAdminRouter } from './tax.routes.js';
import { createTaxService } from './tax.service.js';

export const createTaxModule: ModuleFactory = (container) => {
  const service = createTaxService({
    db: container.db,
    audit: container.audit,
    clock: container.clock,
  });
  return { name: 'tax', adminRouter: createTaxAdminRouter(container, service) };
};

export {
  createTaxService,
  resolveRates,
  type RateResolution,
  type RateResolutionFailure,
  type TaxService,
  type TaxServiceDeps,
} from './tax.service.js';
export { loadTaxSettings, TAX_SETTING_DEFAULTS, type TaxSettings } from './tax.settings.js';
