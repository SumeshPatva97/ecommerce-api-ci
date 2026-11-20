/**
 * Shipping module (B7) — methods, serviceability, shipments, tracking, courier webhook.
 * PROVISIONAL (OQ-07): only the mock provider adapter exists (`src/integrations/shipping`).
 *
 * Exports for other modules:
 * - `computeShippingCharge` / `toQuoteDto` / `loadFreeShippingThreshold` (checkout);
 * - `advanceOrderForShipment` (narrow order effect of shipments; the orders module will own the
 *   order state machine later).
 */
import type { AppContainer } from '../../container.js';
import type { ShippingProviderRegistry } from '../../integrations/shipping/shippingProvider.js';
import { notificationServiceFor } from '../notifications/index.js';
import type { ModuleFactory } from '../types.js';
import { createShippingMethodsService } from './shipping.methods.js';
import {
  createShippingAdminRouter,
  createShippingPublicRouter,
  createShippingWebhookRouter,
} from './shipping.routes.js';
import { createShipmentsService } from './shipping.shipments.js';

export interface ShippingModuleOptions {
  readonly providers?: ShippingProviderRegistry;
}

export function buildShippingServices(
  container: AppContainer,
  options: ShippingModuleOptions = {},
) {
  const providers = options.providers ?? container.providers.shipping;
  const defaultProvider = container.config.integrations.shipping;
  const provider = providers.get(defaultProvider);
  if (provider === undefined) throw new Error(`Shipping provider "${defaultProvider}" missing.`);
  return {
    methods: createShippingMethodsService(container, provider),
    shipments: createShipmentsService(container, {
      providers,
      defaultProvider,
      notifications: notificationServiceFor(container),
    }),
  };
}

/** Factory with injectable provider adapters (tests). */
export function shippingModuleWith(options: ShippingModuleOptions = {}): ModuleFactory {
  return (container) => {
    const { methods, shipments } = buildShippingServices(container, options);
    return {
      name: 'shipping',
      publicRouter: createShippingPublicRouter(container, methods),
      adminRouter: createShippingAdminRouter(container, methods, shipments),
      webhookRouter: createShippingWebhookRouter(container, shipments),
    };
  };
}

export const createShippingModule: ModuleFactory = shippingModuleWith();

export {
  computeShippingCharge,
  effectiveFreeAbove,
  loadFreeShippingThreshold,
  toQuoteDto,
  type RateContext,
  type RateMethod,
  type ShippingQuote,
  type ShippingQuoteDto,
} from './shipping.rates.js';
export {
  advanceOrderForShipment,
  canTransitionShipment,
  orderPathTo,
  orderTargetFor,
  SHIPMENT_TRANSITIONS,
  type AdvanceOrderArgs,
  type AdvanceOrderDeps,
  type AdvanceOrderResult,
} from './shipping.orders.js';
export { createShippingMethodsService, type ShippingMethodsService } from './shipping.methods.js';
export {
  createShipmentsService,
  planShipmentItems,
  type ShipmentsService,
} from './shipping.shipments.js';
