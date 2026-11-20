/**
 * Gateway payment session — created AFTER the order transaction commits (BACKEND_STRUCTURE.md §7:
 * no network call inside a DB transaction). Used by `POST /checkout/orders` and
 * `POST /me/orders/:orderNumber/retry-payment`.
 *
 * The amount sent to the gateway is the server-computed payment row amount (paise); the order
 * number is the receipt. If the gateway cannot be reached the order stays `PENDING_PAYMENT` and
 * the caller answers with `payment: null` + warning `PAYMENT_SESSION_PENDING` (API §3.9).
 * `clientPayload` is provider-specific (PROVISIONAL OQ-06) and never contains secrets.
 */
import type { AppContainer } from '../../container.js';
import { withTransaction } from '../../core/db/transaction.js';
import { toMinorUnits, toMoneyString, type Decimal } from '../../lib/money.js';
import { isVerifiablePaymentProvider } from '../../integrations/payments/paymentProvider.js';
import { recordPaymentTxn } from './payments.capture.js';
import { withTimeout } from './payments.policy.js';

export interface SessionCustomer {
  readonly name: string;
  readonly email: string;
  readonly phone: string | null;
}

export interface OpenSessionInput {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly paymentId: string;
  readonly amount: Decimal;
  readonly customer: SessionCustomer;
}

export interface PaymentSessionDto {
  readonly paymentId: string;
  readonly provider: string;
  readonly providerOrderId: string;
  readonly amount: string;
  readonly currency: 'INR';
  readonly clientPayload: {
    readonly keyId: string;
    readonly orderRef: string;
    readonly prefill: {
      readonly name: string;
      readonly email: string;
      readonly contact: string | null;
    };
  };
  readonly returnUrl: string;
}

export interface PaymentSessions {
  /** Creates the gateway order; `null` when the gateway is unavailable (order stays pending). */
  open(input: OpenSessionInput): Promise<PaymentSessionDto | null>;
}

export function createPaymentSessions(container: AppContainer): PaymentSessions {
  const { db, logger, clock, config } = container;
  const provider = container.providers.payment;
  const storefront = config.storefrontUrl.replace(/\/+$/, '');

  return {
    async open(input) {
      const amountMinor = toMinorUnits(input.amount);
      let providerOrderId: string;
      try {
        const result = await withTimeout(
          provider.initiate({
            orderId: input.orderId,
            amountMinor,
            currency: 'INR',
            idempotencyKey: input.paymentId,
            metadata: { orderNumber: input.orderNumber, paymentId: input.paymentId },
          }),
        );
        if (result.status === 'FAILED') throw new Error('Gateway refused the payment order.');
        providerOrderId = result.providerOrderId;
      } catch (error) {
        logger.warn(
          {
            err: error,
            orderId: input.orderId,
            paymentId: input.paymentId,
            provider: provider.name,
          },
          'payment session could not be created',
        );
        try {
          await recordPaymentTxn(db, {
            paymentId: input.paymentId,
            type: 'CREATE_ORDER',
            provider: provider.name,
            providerStatus: 'error',
            amount: input.amount,
            errorCode: 'GATEWAY_UNAVAILABLE',
            errorMessage: error instanceof Error ? error.message : 'Gateway error.',
            requestPayload: { amountMinor, currency: 'INR', receipt: input.orderNumber },
            now: clock(),
          });
        } catch (logError) {
          logger.error({ err: logError }, 'payment transaction log failed');
        }
        return null;
      }

      await withTransaction(db, async ({ tx }) => {
        await tx.payment.update({
          where: { id: input.paymentId },
          data: { provider: provider.name, providerOrderId },
          select: { id: true },
        });
        await recordPaymentTxn(tx, {
          paymentId: input.paymentId,
          type: 'CREATE_ORDER',
          provider: provider.name,
          providerReference: providerOrderId,
          providerStatus: 'created',
          amount: input.amount,
          requestPayload: { amountMinor, currency: 'INR', receipt: input.orderNumber },
          responsePayload: { providerOrderId },
          now: clock(),
        });
      });

      return {
        paymentId: input.paymentId,
        provider: provider.name,
        providerOrderId,
        amount: toMoneyString(input.amount),
        currency: 'INR',
        clientPayload: {
          keyId: isVerifiablePaymentProvider(provider) ? provider.publicKeyId : provider.name,
          orderRef: providerOrderId,
          prefill: {
            name: input.customer.name,
            email: input.customer.email,
            contact: input.customer.phone,
          },
        },
        returnUrl: `${storefront}/checkout/payment-return?order=${encodeURIComponent(input.orderNumber)}`,
      };
    },
  };
}
