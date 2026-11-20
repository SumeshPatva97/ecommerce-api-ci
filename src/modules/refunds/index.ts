/**
 * Refunds module (B6) — admin refunds (API_DOCUMENTATION.md §4.11) and the refund primitives used
 * by order cancellation and the payments module.
 *
 * Exports for other modules:
 * - `createRefundForOrder(tx, …)` — e.g. late capture after cancellation (OQ-59, checkout/payments);
 * - `prepareGatewayRefund(tx, …)` + `executeGatewayRefund(deps, job)` — post-commit gateway call;
 * - `markRefundCompleted(tx, ctx, …)` — refund webhook completion (idempotent).
 */
import type { ModuleFactory } from '../types.js';
import { createRefundsAdminRouter } from './refunds.routes.js';
import { createRefundsService } from './refunds.service.js';

export const createRefundsModule: ModuleFactory = (container) => ({
  name: 'refunds',
  adminRouter: createRefundsAdminRouter(container, createRefundsService(container)),
});

export {
  createRefundForOrder,
  executeGatewayRefund,
  markRefundCompleted,
  prepareGatewayRefund,
  type CreateRefundForOrderInput,
  type CreatedRefund,
  type GatewayDeps,
  type GatewayRefundJob,
  type RefundCompletion,
  type RefundLineRequest,
} from './refunds.core.js';
export {
  createRefundsService,
  MAX_REFUND_RETRIES,
  toRefundDetail,
  toRefundListItem,
  type RefundDetailDto,
  type RefundsService,
  type StaffContext,
} from './refunds.service.js';
export { staffContext } from './refunds.routes.js';
export {
  METHOD_LABELS,
  ORDER_CONTACT_SELECT,
  notifyOrderEvent,
  type NotifyContext,
  type OrderContact,
} from './refunds.notify.js';
