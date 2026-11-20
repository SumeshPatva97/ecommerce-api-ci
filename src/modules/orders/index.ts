/**
 * Orders module (B6) — customer orders (API_DOCUMENTATION.md §3.10) and admin orders (§4.7):
 * listing/detail, state-machine status changes, cancellations (direct / request / approve /
 * reject), notes, invoice & credit-note PDF downloads, tracking.
 *
 * Exports for other modules: `cancelOrderInTx` (all cancellation effects in the caller's
 * transaction), `createOrdersService`.
 */
import type { ModuleFactory } from '../types.js';
import { createOrdersAdminRouter, createOrdersPublicRouter } from './orders.routes.js';
import { createOrdersService, type OrdersServiceDeps } from './orders.service.js';

/** Factory with injectable stock/coupon services and shipping adapters (tests). */
export function ordersModuleWith(deps: OrdersServiceDeps = {}): ModuleFactory {
  return (container) => {
    const service = createOrdersService(container, deps);
    return {
      name: 'orders',
      publicRouter: createOrdersPublicRouter(container, service),
      adminRouter: createOrdersAdminRouter(container, service),
    };
  };
}

export const createOrdersModule: ModuleFactory = ordersModuleWith();

export {
  createOrdersService,
  type CancellationRequestResult,
  type OrdersService,
  type OrdersServiceDeps,
  type PdfDownload,
} from './orders.service.js';
export {
  LOCKED_ORDER_SELECT,
  cancelOrderInTx,
  invalidTransition,
  lockOrderRow,
  type CancelArgs,
  type CancelDeps,
  type CancelResult,
  type LockedOrder,
} from './orders.cancel.js';
export {
  customerActions,
  toAdminDetail,
  toCustomerDetail,
  type AdminOrderDetail,
  type CustomerOrderDetail,
} from './orders.mapper.js';
