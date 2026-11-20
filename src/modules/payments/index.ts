/**
 * Payments module (B6) — payment verification, retry, gateway webhook, admin payment views, and the
 * capture/failure domain service shared with jobs and (later) reconciliation.
 * API_DOCUMENTATION.md §3.9, §4.11, §5; BACKEND_STRUCTURE.md §7, §16.
 *
 * PROVISIONAL (OQ-06): mock gateway only. PROVISIONAL (OQ-58): 60 min / 3 attempts.
 * PROVISIONAL (OQ-59): late capture → confirm if stock free, else cancel + refund requirement.
 */
import type { ModuleFactory } from '../types.js';
import {
  createPaymentsAdminRouter,
  createPaymentsPublicRouter,
  createPaymentsWebhookRouter,
} from './payments.routes.js';
import { createPaymentsService, type PaymentsModuleOptions } from './payments.service.js';

/** Factory with options (e.g. the refunds module's OQ-59 auto-refund hook). */
export function paymentsModuleWith(options: PaymentsModuleOptions = {}): ModuleFactory {
  return (container) => {
    const service = createPaymentsService(container, options);
    return {
      name: 'payments',
      publicRouter: createPaymentsPublicRouter(container, service),
      adminRouter: createPaymentsAdminRouter(container, service),
      webhookRouter: createPaymentsWebhookRouter(container, service),
    };
  };
}

export const createPaymentsModule: ModuleFactory = paymentsModuleWith();

export {
  capturePayment,
  failPayment,
  recordPaymentTxn,
  type CaptureDeps,
  type CaptureInput,
  type CaptureOutcome,
  type CaptureResult,
  type CaptureSource,
  type FailureInput,
  type FailureOutcome,
  type FailureResult,
  type LateCaptureRefundHook,
  type PaymentStateView,
} from './payments.capture.js';
export {
  captureDepsFor,
  createPaymentsService,
  type PaymentsModuleOptions,
  type PaymentsService,
  type RetryResultDto,
  type VerifyResultDto,
  type WebhookResultDto,
} from './payments.service.js';
export {
  createPaymentSessions,
  type OpenSessionInput,
  type PaymentSessionDto,
  type PaymentSessions,
  type SessionCustomer,
} from './payments.session.js';
export {
  SYSTEM_ORDER_ACTOR,
  WEBHOOK_ORDER_ACTOR,
  invalidTransition,
  loadOrderCore,
  lockOrder,
  notifyOrder,
  orderCoreSelect,
  transitionOrder,
  type NotifyContext,
  type OrderActor,
  type OrderCore,
  type TransitionArgs,
} from './payments.orders.js';
export {
  GATEWAY_TIMEOUT_MS,
  MAX_PAYMENT_ATTEMPTS,
  RETRY_WINDOW_MINUTES,
  isRetryWindowOpen,
  retryWindowEnd,
} from './payments.policy.js';
export { emailNotVerifiedError, requireVerifiedCustomer } from './payments.guards.js';
