/**
 * OQ-59 auto-refund wiring (PROVISIONAL): a payment captured for an order that had to be cancelled
 * (late capture without stock, or capture on a cancelled order) gets a full refund created by the
 * SYSTEM, auto-APPROVED, through the refunds module's primitives — `createRefundForOrder` +
 * `prepareGatewayRefund` inside the capture transaction, `executeGatewayRefund` after commit.
 * A refund that cannot be created never blocks the capture: it falls back to the staff-review
 * record (`REFUND_REQUIRED`).
 */
import type { AppContainer } from '../../container.js';
import { AppError } from '../../core/errors/AppError.js';
import type { Logger } from '../../core/logger/logger.js';
import { notificationServiceFor } from '../notifications/index.js';
import {
  createRefundForOrder,
  executeGatewayRefund,
  prepareGatewayRefund,
} from '../refunds/index.js';
import {
  recordPaymentTxn,
  type LateCaptureRefundHook,
  type RefundJob,
} from './payments.capture.js';

export function refundsModuleHook(logger: Logger): LateCaptureRefundHook {
  return async (tx, args) => {
    try {
      const refund = await createRefundForOrder(tx, {
        orderId: args.orderId,
        now: args.now,
        requestedBy: { type: 'SYSTEM' },
        status: 'APPROVED',
        method: 'ORIGINAL_PAYMENT_METHOD',
        reasonCode: args.reasonCode,
        reasonText:
          'Automatic full refund: payment received for an order that could not be fulfilled.',
        paymentId: args.paymentId,
      });
      return await prepareGatewayRefund(tx, refund.id, args.now);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      await recordPaymentTxn(tx, {
        paymentId: args.paymentId,
        type: 'REFUND',
        provider: null,
        providerStatus: 'refund_required',
        amount: args.amount,
        errorCode: 'REFUND_REQUIRED',
        errorMessage: `${args.reasonCode}: automatic refund failed (${error.code}).`,
        now: args.now,
      });
      logger.error(
        { orderId: args.orderId, paymentId: args.paymentId, code: error.code, staffReview: true },
        'automatic refund could not be created',
      );
      return null;
    }
  };
}

/** Runs a prepared gateway refund after commit (never throws for gateway errors). */
export async function runRefundJob(container: AppContainer, job: RefundJob | null): Promise<void> {
  if (job === null) return;
  try {
    await executeGatewayRefund(
      {
        db: container.db,
        provider: container.providers.payment,
        clock: container.clock,
        logger: container.logger,
        notifications: notificationServiceFor(container),
        storefrontUrl: container.config.storefrontUrl,
      },
      job,
    );
  } catch (error) {
    container.logger.error(
      { err: error, refundId: job.refundId, staffReview: true },
      'post-commit refund execution failed',
    );
  }
}
