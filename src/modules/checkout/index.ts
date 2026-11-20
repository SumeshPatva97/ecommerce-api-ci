/**
 * Checkout module (B6) — quote (`POST /checkout/summary`) and order placement
 * (`POST /checkout/orders`). API_DOCUMENTATION.md §3.9, BACKEND_STRUCTURE.md §7–§9.
 * Payment verification / retry / webhooks live in the payments module.
 */
import type { ModuleFactory } from '../types.js';
import { createCheckoutRouter } from './checkout.routes.js';
import { createCheckoutService, type CheckoutServiceDeps } from './checkout.service.js';

/** Factory with injectable collaborators (tests: payment sessions, serviceability). */
export function checkoutModuleWith(deps: CheckoutServiceDeps = {}): ModuleFactory {
  return (container) => ({
    name: 'checkout',
    publicRouter: createCheckoutRouter(container, createCheckoutService(container, deps)),
  });
}

export const createCheckoutModule: ModuleFactory = checkoutModuleWith();

export {
  createCheckoutService,
  type CheckoutRequestMeta,
  type CheckoutService,
  type CheckoutServiceDeps,
  type PlacedOrderDto,
} from './checkout.service.js';
export {
  computeQuote,
  priceChangedError,
  quoteHashOf,
  type CheckoutSummaryDto,
  type ComputedQuote,
  type PreparedCheckout,
  type QuoteRequest,
} from './checkout.quote.js';
export { CheckoutSummaryBody, PlaceOrderBody } from './checkout.schemas.js';
