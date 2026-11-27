/**
 * Payments use-cases (B6) — API_DOCUMENTATION.md §3.9 (verify, retry-payment), §4.11 (admin
 * list/detail), §5 (webhook); BACKEND_STRUCTURE.md §7, §16; SECURITY_GUIDELINES.md §10.
 *
 * - `verify`: ownership (foreign order → 404), constant-time client signature check, then the
 *   payment state is FETCHED from the gateway (client claims are never trusted) and applied through
 *   `capturePayment` / `failPayment` (order row locked first — race-safe with the webhook).
 * - `retryPayment`: PROVISIONAL (OQ-58) 60 min / 3 attempts; stock re-reserved with a fresh TTL;
 *   the order snapshot is binding (no re-pricing); new gateway session after commit.
 * - `handleWebhook`: raw Buffer, signature verified BEFORE parsing (constant time), duplicate
 *   provider event ids answered `duplicate: true`, payload stored redacted on
 *   `payment_transactions` (type WEBHOOK). Processed synchronously (no queue — D-38 / OQ-35).
 */
import type { AppContainer } from '../../container.js';
import { withTransaction, type TxClient } from '../../core/db/transaction.js';
import { markRefundCompleted } from '../refunds/index.js';
import { AppError } from '../../core/errors/AppError.js';
import { isPrismaKnownError } from '../../core/errors/prismaErrorMapper.js';
import { buildPageMeta, toSkipTake, type PageMeta } from '../../core/http/pagination.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  isVerifiablePaymentProvider,
  PaymentWebhookPayloadError,
  PaymentWebhookSignatureError,
  type VerifiablePaymentProvider,
  type WebhookHeaders,
} from '../../integrations/payments/paymentProvider.js';
import { dec, toMoneyString } from '../../lib/money.js';
import { istDayRange } from '../../lib/time.js';
import { createCouponsService } from '../coupons/index.js';
import { createInventoryService } from '../inventory/index.js';
import { notificationServiceFor } from '../notifications/index.js';
import {
  capturePayment,
  failPayment,
  recordPaymentTxn,
  type CaptureDeps,
  type LateCaptureRefundHook,
  type PaymentStateView,
  type RefundJob,
} from './payments.capture.js';
import {
  toAdminPaymentDetail,
  toAdminPaymentItem,
  type AdminPaymentDetailDto,
  type AdminPaymentItemDto,
} from './payments.mapper.js';
import {
  lockOrder,
  loadOrderCore,
  transitionOrder,
  invalidTransition,
  WEBHOOK_ORDER_ACTOR,
} from './payments.orders.js';
import {
  MAX_PAYMENT_ATTEMPTS,
  isRetryWindowOpen,
  retryWindowEnd,
  withTimeout,
} from './payments.policy.js';
import type { AdminPaymentListQueryInput, VerifyPaymentInput } from './payments.schemas.js';
import { refundsModuleHook, runRefundJob } from './payments.refunds.js';
import {
  createPaymentSessions,
  type PaymentSessionDto,
  type PaymentSessions,
} from './payments.session.js';

export interface PaymentsModuleOptions {
  /**
   * OQ-59 auto-refund hook. Default: the refunds module (`refundsModuleHook`); pass `null` to only
   * record the refund requirement for staff.
   */
  readonly lateCaptureRefund?: LateCaptureRefundHook | null;
}

/** Wires the capture service dependencies from the container. */
export function captureDepsFor(
  container: AppContainer,
  options: PaymentsModuleOptions = {},
): CaptureDeps {
  return {
    clock: container.clock,
    logger: container.logger,
    inventory: createInventoryService({
      clock: container.clock,
      reservationTtlMinutes: container.config.integrations.reservationTtlMinutes,
    }),
    coupons: createCouponsService(container),
    notify: {
      notifications: notificationServiceFor(container),
      storefrontUrl: container.config.storefrontUrl,
    },
    lateCaptureRefund:
      options.lateCaptureRefund === null
        ? undefined
        : (options.lateCaptureRefund ?? refundsModuleHook(container.logger)),
  };
}

export type NextAction = 'SHOW_CONFIRMATION' | 'POLL_ORDER' | 'RETRY_PAYMENT' | 'SHOW_ORDER';

export interface VerifyResultDto {
  readonly orderNumber: string;
  readonly orderStatus: string;
  readonly paymentStatus: string;
  readonly paidAmount: string | null;
  readonly paidAt: string | null;
  readonly nextAction: NextAction;
  readonly retryAllowedUntil?: string;
}

export interface RetryResultDto {
  readonly order: {
    readonly orderNumber: string;
    readonly status: string;
    readonly reservationExpiresAt: string | null;
  };
  readonly payment: PaymentSessionDto | null;
  readonly warnings?: readonly { code: string }[];
}

export interface WebhookResultDto {
  readonly received: true;
  readonly duplicate?: true;
  readonly ignored?: true;
}

export interface PaymentsService {
  verify(userId: string, input: VerifyPaymentInput): Promise<VerifyResultDto>;
  retryPayment(userId: string, orderNumber: string): Promise<RetryResultDto>;
  handleWebhook(
    providerKey: string,
    rawBody: unknown,
    headers: WebhookHeaders,
    meta: { readonly ip?: string | undefined },
  ): Promise<WebhookResultDto>;
  list(
    query: AdminPaymentListQueryInput,
  ): Promise<{ items: AdminPaymentItemDto[]; meta: PageMeta }>;
  get(paymentId: string): Promise<AdminPaymentDetailDto>;
}

function signatureInvalid(): AppError {
  return new AppError('VALIDATION_ERROR', 'The payment could not be verified.', {
    details: [
      {
        field: 'providerSignature',
        code: 'SIGNATURE_INVALID',
        message: 'Invalid payment signature.',
      },
    ],
  });
}

function viewOf(state: PaymentStateView, nextAction: NextAction, now: Date): VerifyResultDto {
  const captured = state.paidAt !== null;
  return {
    orderNumber: state.orderNumber,
    orderStatus: state.orderStatus,
    paymentStatus: state.paymentStatus,
    paidAmount: captured ? toMoneyString(state.grandTotal) : null,
    paidAt: state.paidAt?.toISOString() ?? null,
    nextAction,
    ...(nextAction === 'RETRY_PAYMENT' && isRetryWindowOpen(state.placedAt, now)
      ? { retryAllowedUntil: retryWindowEnd(state.placedAt).toISOString() }
      : {}),
  };
}

function nextActionFor(state: PaymentStateView): NextAction {
  if (state.paidAt !== null) {
    return state.orderStatus === 'CANCELLED' ? 'SHOW_ORDER' : 'SHOW_CONFIRMATION';
  }
  if (state.orderStatus === 'PAYMENT_FAILED') return 'RETRY_PAYMENT';
  if (state.orderStatus === 'PENDING_PAYMENT') return 'POLL_ORDER';
  return 'SHOW_ORDER';
}

export function createPaymentsService(
  container: AppContainer,
  options: PaymentsModuleOptions & { readonly sessions?: PaymentSessions } = {},
): PaymentsService {
  const { db, clock, logger, config } = container;
  const deps = captureDepsFor(container, options);
  const sessions = options.sessions ?? createPaymentSessions(container);
  const provider = container.providers.payment;

  function gateway(): VerifiablePaymentProvider {
    // The mock adapter's client-signature secret is a public test value: never accept it in
    // production (same rule as `handleWebhook`). Start-up already refuses it (src/container.ts).
    if (
      (provider.name === 'mock' && config.nodeEnv === 'production') ||
      !isVerifiablePaymentProvider(provider)
    ) {
      throw new AppError('SERVICE_UNAVAILABLE', 'Payment verification is not available.');
    }
    return provider;
  }

  /** Gateway refund outcome → refunds module (`markRefundCompleted`), idempotent. */
  async function applyRefundEvent(
    tx: TxClient,
    type: 'REFUND_PROCESSED' | 'REFUND_FAILED',
    providerRefundId: string,
    reason: string | null,
    now: Date,
  ): Promise<void> {
    const refund = await tx.refund.findFirst({
      where: { providerRefundId },
      select: { id: true, status: true },
    });
    if (refund === null) {
      logger.info({ providerRefundId }, 'refund webhook for an unknown refund acknowledged');
      return;
    }
    if (type === 'REFUND_PROCESSED') {
      await markRefundCompleted(tx, deps.notify, { refundId: refund.id, now, providerRefundId });
    } else if (refund.status === 'PROCESSING' || refund.status === 'APPROVED') {
      await tx.refund.update({
        where: { id: refund.id },
        data: {
          status: 'FAILED',
          failedAt: now,
          failureReason: (reason ?? 'Refund failed at the gateway.').slice(0, 500),
        },
        select: { id: true },
      });
    }
  }

  async function currentState(orderId: string): Promise<PaymentStateView> {
    const order = await db.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        paymentStatus: true,
        grandTotal: true,
        placedAt: true,
        payments: {
          where: { status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'] } },
          select: { capturedAt: true },
          take: 1,
        },
      },
    });
    if (order === null) throw new AppError('NOT_FOUND', 'Order not found.');
    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      orderStatus: order.status,
      paymentStatus: order.paymentStatus,
      grandTotal: order.grandTotal,
      placedAt: order.placedAt,
      paidAt: order.payments[0]?.capturedAt ?? null,
    };
  }

  return {
    async verify(userId, input) {
      const order = await db.order.findFirst({
        where: { orderNumber: input.orderNumber, userId },
        select: { id: true, status: true },
      });
      if (order === null) throw new AppError('NOT_FOUND', 'Order not found.');
      const payment = await db.payment.findFirst({
        where: { orderId: order.id, providerOrderId: input.providerOrderId },
        select: { id: true, status: true, provider: true },
      });
      if (payment === null) {
        logger.warn(
          { orderId: order.id, security: true },
          'payment verify: provider order id does not belong to the order',
        );
        throw signatureInvalid();
      }
      const now = clock();
      if (['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(payment.status)) {
        const state = await currentState(order.id);
        return viewOf(state, nextActionFor(state), now);
      }
      const gw = gateway();
      const signed = gw.verifyClientSignature({
        providerOrderId: input.providerOrderId,
        providerPaymentId: input.providerPaymentId,
        signature: input.providerSignature,
      });
      if (!signed) {
        await recordPaymentTxn(db, {
          paymentId: payment.id,
          type: 'AUTHORIZE',
          provider: gw.name,
          providerReference: input.providerPaymentId,
          providerStatus: 'signature_invalid',
          signatureVerified: false,
          errorCode: 'SIGNATURE_INVALID',
          now,
        });
        logger.warn(
          { orderId: order.id, paymentId: payment.id, security: true },
          'payment verify: invalid client signature',
        );
        throw signatureInvalid();
      }
      if (order.status === 'CANCELLED') {
        throw new AppError('INVALID_STATE_TRANSITION', 'This order has been cancelled.');
      }

      let state;
      try {
        state = await withTimeout(
          gw.fetchPayment({
            providerOrderId: input.providerOrderId,
            providerPaymentId: input.providerPaymentId,
          }),
        );
      } catch (error) {
        logger.warn({ err: error, orderId: order.id }, 'payment verify: gateway fetch failed');
        throw new AppError(
          'SERVICE_UNAVAILABLE',
          'The payment gateway is not reachable. Please retry.',
        );
      }
      if (
        state.providerOrderId !== input.providerOrderId ||
        state.providerPaymentId !== input.providerPaymentId
      ) {
        logger.warn({ orderId: order.id, security: true }, 'payment verify: gateway ref mismatch');
        throw signatureInvalid();
      }

      if (state.status === 'CAPTURED') {
        const result = await withTransaction(
          db,
          async ({ tx }) =>
            capturePayment(deps, tx, {
              orderId: order.id,
              providerOrderId: state.providerOrderId,
              providerPaymentId: state.providerPaymentId,
              amountMinor: state.amountMinor,
              currency: state.currency,
              method: state.method,
              provider: gw.name,
              source: 'VERIFY',
              actor: { type: 'CUSTOMER', userId },
            }),
          { retryOnDeadlock: true },
        );
        await runRefundJob(container, result.refundJob);
        if (result.outcome === 'AMOUNT_MISMATCH') {
          throw new AppError('VALIDATION_ERROR', 'The payment could not be verified.', {
            details: [
              {
                code: 'AMOUNT_MISMATCH',
                message: 'The paid amount does not match the order. Our team will contact you.',
              },
            ],
          });
        }
        if (result.outcome === 'PAYMENT_NOT_FOUND') throw signatureInvalid();
        return viewOf(result.state, nextActionFor(result.state), now);
      }
      if (state.status === 'FAILED') {
        const result = await withTransaction(
          db,
          async ({ tx }) =>
            failPayment(deps, tx, {
              orderId: order.id,
              providerOrderId: state.providerOrderId,
              providerPaymentId: state.providerPaymentId,
              errorCode: state.errorCode,
              errorDescription: state.errorDescription,
              provider: gw.name,
              source: 'VERIFY',
              actor: { type: 'CUSTOMER', userId },
            }),
          { retryOnDeadlock: true },
        );
        const view = viewOf(result.state, nextActionFor(result.state), now);
        return result.outcome === 'ALREADY_CAPTURED' ? view : { ...view, paymentStatus: 'FAILED' };
      }
      // PENDING / AUTHORIZED at the gateway (e.g. UPI still processing) → client polls.
      const pending = await currentState(order.id);
      return { ...viewOf(pending, 'POLL_ORDER', now), paymentStatus: 'PENDING' };
    },

    async retryPayment(userId, orderNumber) {
      const now = clock();
      const found = await db.order.findFirst({
        where: { orderNumber, userId },
        select: { id: true },
      });
      if (found === null) throw new AppError('NOT_FOUND', 'Order not found.');

      const outcome = await withTransaction(db, async ({ tx }) => {
        await lockOrder(tx, found.id);
        const order = await loadOrderCore(tx, found.id);
        if (order === null) throw new AppError('NOT_FOUND', 'Order not found.');
        if (order.paymentMethod !== 'ONLINE') {
          throw new AppError('INVALID_STATE_TRANSITION', 'Only online payments can be retried.');
        }
        if (order.status !== 'PENDING_PAYMENT' && order.status !== 'PAYMENT_FAILED') {
          throw invalidTransition(order.status, 'PENDING_PAYMENT');
        }
        const payments = await tx.payment.findMany({
          where: { orderId: order.id },
          select: { id: true, attemptNo: true, status: true },
          orderBy: { attemptNo: 'asc' },
        });
        if (
          payments.some((p) => ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(p.status))
        ) {
          throw new AppError('INVALID_STATE_TRANSITION', 'This order is already paid.');
        }
        // PROVISIONAL (OQ-58): 60 minutes from placement, max 3 attempts.
        if (!isRetryWindowOpen(order.placedAt, now)) {
          throw new AppError('VALIDATION_ERROR', 'The payment window for this order has closed.', {
            details: [
              {
                code: 'RETRY_WINDOW_EXPIRED',
                message: 'The payment window for this order has closed.',
                meta: { retryAllowedUntil: retryWindowEnd(order.placedAt).toISOString() },
              },
            ],
          });
        }
        if (payments.length >= MAX_PAYMENT_ATTEMPTS) {
          throw new AppError('VALIDATION_ERROR', 'No payment attempts are left for this order.', {
            details: [
              {
                code: 'RETRY_LIMIT_REACHED',
                message: 'No payment attempts are left for this order.',
                meta: { maxAttempts: MAX_PAYMENT_ATTEMPTS },
              },
            ],
          });
        }

        // Fresh TTL on every attempt (R-06): release what is still held, reserve again.
        await deps.inventory.releaseReservation(tx, order.id, 'RETRY_REPLACED');
        const expiresAt = deps.inventory.reservationExpiry(now);
        await deps.inventory.reserve(
          tx,
          order.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity, sku: i.sku })),
          order.id,
          expiresAt,
        );
        if (order.couponId !== null) {
          await deps.coupons.reserveUsage(
            tx,
            order.couponId,
            order.userId,
            order.id,
            order.couponDiscountTotal,
          );
        }
        await tx.payment.updateMany({
          where: { orderId: order.id, status: 'PENDING' },
          data: { status: 'CANCELLED' },
        });
        const attemptNo = (payments.at(-1)?.attemptNo ?? 0) + 1;
        const payment = await tx.payment.create({
          data: {
            orderId: order.id,
            attemptNo,
            paymentMethod: 'ONLINE',
            status: 'PENDING',
            amount: order.grandTotal,
            currency: 'INR',
            expiresAt,
            createdAt: now,
          },
          select: { id: true },
        });
        const orderData = { paymentStatus: 'PENDING' as const, reservationExpiresAt: expiresAt };
        if (order.status === 'PAYMENT_FAILED') {
          await transitionOrder(tx, {
            orderId: order.id,
            from: 'PAYMENT_FAILED',
            to: 'PENDING_PAYMENT',
            actor: { type: 'CUSTOMER', userId },
            now,
            note: `Payment retry (attempt ${String(attemptNo)}).`,
            data: orderData,
          });
        } else {
          await tx.order.update({ where: { id: order.id }, data: orderData, select: { id: true } });
        }
        return { order, paymentId: payment.id, expiresAt };
      });

      const session = await sessions.open({
        orderId: outcome.order.id,
        orderNumber: outcome.order.orderNumber,
        paymentId: outcome.paymentId,
        amount: outcome.order.grandTotal,
        customer: {
          name: outcome.order.customerNameSnapshot,
          email: outcome.order.customerEmailSnapshot,
          phone: outcome.order.customerPhoneSnapshot,
        },
      });
      return {
        order: {
          orderNumber: outcome.order.orderNumber,
          status: 'PENDING_PAYMENT',
          reservationExpiresAt: outcome.expiresAt.toISOString(),
        },
        payment: session,
        ...(session === null ? { warnings: [{ code: 'PAYMENT_SESSION_PENDING' }] } : {}),
      };
    },

    async handleWebhook(providerKey, rawBody, headers, meta) {
      // The mock adapter's secrets are public test values: never accept it in production.
      if (
        providerKey !== provider.name ||
        (provider.name === 'mock' && config.nodeEnv === 'production') ||
        !isVerifiablePaymentProvider(provider)
      ) {
        throw new AppError('NOT_FOUND', 'Unknown webhook provider.');
      }
      if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
        throw new AppError('UNAUTHENTICATED', 'Invalid signature.');
      }
      try {
        provider.verifyWebhook(rawBody, headers, clock());
      } catch (error) {
        if (error instanceof PaymentWebhookSignatureError) {
          logger.warn(
            { provider: providerKey, reason: error.message, ip: meta.ip, security: true },
            'payment webhook signature rejected',
          );
          throw new AppError('UNAUTHENTICATED', 'Invalid signature.');
        }
        throw error;
      }
      let event;
      try {
        event = provider.parseWebhook(rawBody);
      } catch (error) {
        if (error instanceof PaymentWebhookPayloadError) {
          throw new AppError('BAD_REQUEST', 'Malformed webhook payload.');
        }
        throw error;
      }

      const seen = await db.paymentTransaction.findFirst({
        where: { provider: provider.name, providerEventId: event.eventId },
        select: { id: true },
      });
      if (seen !== null) return { received: true, duplicate: true };

      const payment =
        event.providerOrderId === null
          ? null
          : await db.payment.findFirst({
              where: { provider: provider.name, providerOrderId: event.providerOrderId },
              select: { id: true, orderId: true },
            });
      if (payment === null) {
        // PROVISIONAL (OQ-77): no generic webhook_events table — unmatched events are logged only.
        logger.info(
          { provider: providerKey, eventId: event.eventId, event: event.providerEvent },
          'payment webhook for an unknown payment acknowledged',
        );
        return { received: true, ignored: true };
      }
      if (event.type === 'PAYMENT_CAPTURED' && event.amountMinor === null) {
        throw new AppError('BAD_REQUEST', 'Malformed webhook payload.');
      }

      const now = clock();
      let refundJob: RefundJob | null = null;
      try {
        await withTransaction(
          db,
          async ({ tx }) => {
            await recordPaymentTxn(tx, {
              paymentId: payment.id,
              type: 'WEBHOOK',
              provider: provider.name,
              providerEventId: event.eventId,
              providerReference: event.providerPaymentId ?? event.providerRefundId,
              providerStatus: event.providerEvent,
              amount: event.amountMinor === null ? null : dec(event.amountMinor).dividedBy(100),
              signatureVerified: true,
              requestPayload: event.payload,
              now,
            });
            const providerOrderId = event.providerOrderId ?? '';
            if (event.type === 'PAYMENT_CAPTURED' && event.providerPaymentId !== null) {
              const captured = await capturePayment(deps, tx, {
                orderId: payment.orderId,
                providerOrderId,
                providerPaymentId: event.providerPaymentId,
                amountMinor: event.amountMinor ?? 0,
                currency: event.currency ?? 'INR',
                method: event.method,
                provider: provider.name,
                source: 'WEBHOOK',
                actor: WEBHOOK_ORDER_ACTOR,
              });
              refundJob = captured.refundJob;
            } else if (event.type === 'PAYMENT_FAILED') {
              await failPayment(deps, tx, {
                orderId: payment.orderId,
                providerOrderId,
                providerPaymentId: event.providerPaymentId,
                errorCode: event.errorCode,
                errorDescription: event.errorDescription,
                provider: provider.name,
                source: 'WEBHOOK',
                actor: WEBHOOK_ORDER_ACTOR,
              });
            } else if (
              (event.type === 'REFUND_PROCESSED' || event.type === 'REFUND_FAILED') &&
              event.providerRefundId !== null
            ) {
              await applyRefundEvent(
                tx,
                event.type,
                event.providerRefundId,
                event.errorDescription,
                now,
              );
            } else {
              logger.info(
                { provider: providerKey, eventId: event.eventId, event: event.providerEvent },
                'payment webhook recorded without domain effect',
              );
            }
          },
          { retryOnDeadlock: true },
        );
      } catch (error) {
        if (isPrismaKnownError(error) && error.code === 'P2002') {
          return { received: true, duplicate: true };
        }
        throw error;
      }
      await runRefundJob(container, refundJob);
      return { received: true };
    },

    async list(query) {
      const and: Prisma.PaymentWhereInput[] = [];
      if (query.q !== undefined) {
        and.push({
          OR: [
            { order: { orderNumber: { contains: query.q } } },
            { providerPaymentId: query.q },
            { providerOrderId: query.q },
          ],
        });
      }
      if (query.status !== undefined) and.push({ status: query.status });
      if (query.method !== undefined) and.push({ paymentMethod: query.method });
      if (query.from !== undefined) and.push({ createdAt: { gte: istDayRange(query.from).start } });
      if (query.to !== undefined) and.push({ createdAt: { lt: istDayRange(query.to).end } });
      const where: Prisma.PaymentWhereInput = and.length === 0 ? {} : { AND: and };
      const { skip, take } = toSkipTake(query.page, query.limit);
      const [rows, total] = await Promise.all([
        db.payment.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          skip,
          take,
          select: {
            id: true,
            attemptNo: true,
            paymentMethod: true,
            status: true,
            amount: true,
            amountRefunded: true,
            provider: true,
            providerPaymentId: true,
            capturedAt: true,
            createdAt: true,
            order: { select: { id: true, orderNumber: true } },
          },
        }),
        db.payment.count({ where }),
      ]);
      return {
        items: rows.map(toAdminPaymentItem),
        meta: buildPageMeta(query.page, query.limit, total),
      };
    },

    async get(paymentId) {
      const row = await db.payment.findUnique({
        where: { id: paymentId },
        select: {
          id: true,
          attemptNo: true,
          paymentMethod: true,
          status: true,
          amount: true,
          amountRefunded: true,
          currency: true,
          provider: true,
          providerOrderId: true,
          providerPaymentId: true,
          instrumentType: true,
          failureCode: true,
          failureReason: true,
          capturedAt: true,
          failedAt: true,
          expiresAt: true,
          createdAt: true,
          updatedAt: true,
          order: { select: { id: true, orderNumber: true, status: true, grandTotal: true } },
          transactions: {
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              type: true,
              providerStatus: true,
              amount: true,
              providerReference: true,
              providerEventId: true,
              signatureVerified: true,
              errorCode: true,
              createdAt: true,
            },
          },
        },
      });
      if (row === null) throw new AppError('NOT_FOUND', 'Payment not found.');
      return toAdminPaymentDetail(row);
    },
  };
}
