/**
 * Notification event catalogue — NOTIFICATION_WORKFLOWS.md §3.1 (master table), §5.1 (consent
 * classes), §6 (quiet hours), §7.1 (retry schedule), §8.1 (dedupe discriminators). Pure.
 *
 * Consent classes map onto the approved `NotificationCategory` enum (TRANSACTIONAL, MARKETING,
 * STAFF_ALERTS). The workflow doc's "ORDER_UPDATES" class has no enum value in the approved schema,
 * so order-update events are TRANSACTIONAL here; `kind` keeps the distinction for quiet hours.
 */
import type {
  NotificationCategory,
  NotificationChannel,
  NotificationEvent,
} from '../../generated/prisma/enums.js';

export type EventKind = 'ESSENTIAL' | 'ORDER_UPDATES' | 'STAFF';

export interface EventSpec {
  readonly kind: EventKind;
  readonly category: NotificationCategory;
  /** Variables a template for this event may reference (unknown placeholders → 422). */
  readonly variables: readonly string[];
  /** WhatsApp sends deferred to 09:00 IST during quiet hours (21:00–09:00 IST). */
  readonly quietHours: boolean;
  /** Carries a single-use token / OTP: never resent by staff, never queued with secret values. */
  readonly tokenBearing: boolean;
}

const BASE = ['firstName', 'brandName', 'supportEmail', 'helpUrl'] as const;
const ORDER = [...BASE, 'orderNumber', 'orderUrl', 'amount', 'paymentMethod'] as const;
const SHIPMENT = [
  ...ORDER,
  'shipmentNumber',
  'courier',
  'awb',
  'trackingUrl',
  'expectedDelivery',
] as const;
const REFUND = [
  ...ORDER,
  'refundNumber',
  'methodLabel',
  'reference',
  'reason',
  'businessDays',
] as const;

function spec(
  kind: EventKind,
  variables: readonly string[],
  extra: Partial<Pick<EventSpec, 'quietHours' | 'tokenBearing' | 'category'>> = {},
): EventSpec {
  return {
    kind,
    category: extra.category ?? (kind === 'STAFF' ? 'STAFF_ALERTS' : 'TRANSACTIONAL'),
    variables,
    quietHours: extra.quietHours ?? false,
    tokenBearing: extra.tokenBearing ?? false,
  };
}

export const EVENT_SPECS: Readonly<Record<NotificationEvent, EventSpec>> = {
  USER_REGISTERED: spec('ESSENTIAL', [...BASE, 'accountUrl', 'loginUrl'], { quietHours: true }),
  VERIFICATION_REQUESTED: spec('ESSENTIAL', [...BASE, 'verifyUrl', 'expiresInHours'], {
    tokenBearing: true,
  }),
  PASSWORD_RESET_REQUESTED: spec('ESSENTIAL', [...BASE, 'resetUrl', 'expiresInMinutes'], {
    tokenBearing: true,
  }),
  PASSWORD_CHANGED: spec('ESSENTIAL', [...BASE, 'changedAt', 'accountRecoveryUrl']),
  ORDER_PLACED: spec('ORDER_UPDATES', ORDER),
  ORDER_CONFIRMED: spec('ESSENTIAL', [...ORDER, 'expectedDispatch']),
  PAYMENT_SUCCEEDED: spec('ESSENTIAL', ORDER),
  PAYMENT_FAILED: spec('ESSENTIAL', [...ORDER, 'retryMinutes', 'holdUntil']),
  INVOICE_AVAILABLE: spec('ORDER_UPDATES', [...ORDER, 'invoiceNumber'], { quietHours: true }),
  ORDER_PROCESSING: spec('ORDER_UPDATES', [...ORDER, 'expectedDispatch'], { quietHours: true }),
  ORDER_SHIPPED: spec('ORDER_UPDATES', SHIPMENT, { quietHours: true }),
  ORDER_OUT_FOR_DELIVERY: spec('ORDER_UPDATES', [...SHIPMENT, 'codAmount']),
  ORDER_DELIVERED: spec('ORDER_UPDATES', [...ORDER, 'deliveredAt'], { quietHours: true }),
  ORDER_CANCELLED: spec('ESSENTIAL', [...ORDER, 'refundNote', 'reason']),
  REFUND_INITIATED: spec('ESSENTIAL', REFUND),
  REFUND_COMPLETED: spec('ESSENTIAL', REFUND),
  LOW_STOCK_ALERT: spec('STAFF', [...BASE, 'count', 'summary', 'inventoryUrl']),
  STAFF_INVITED: spec('ESSENTIAL', [...BASE, 'inviterName', 'acceptUrl', 'expiresInHours'], {
    tokenBearing: true,
  }),
  CANCELLATION_REQUESTED: spec('ESSENTIAL', [...ORDER, 'reason']),
  CANCELLATION_REJECTED: spec('ESSENTIAL', [...ORDER, 'reason']),
  REFUND_REJECTED: spec('ESSENTIAL', [...REFUND]),
  SECURITY_ALERT: spec('ESSENTIAL', [
    ...BASE,
    'signedInAt',
    'device',
    'city',
    'accountRecoveryUrl',
  ]),
};

/** Channels with a provider adapter in v1 (SMS / IN_APP are reserved enum values). */
export const SENDABLE_CHANNELS: ReadonlySet<NotificationChannel> = new Set(['EMAIL', 'WHATSAPP']);

/**
 * Variable names that must never be persisted in `notifications.payload` (§9 "Never include",
 * P3-14 §7): passwords, secrets, tokens, OTPs, card data, UPI VPA / ID, signatures, bank account
 * numbers and gateway payment ids (`razorpayPaymentId`, `paymentId`, `gatewayRef`, …).
 *
 * The public "forgot password" page link is named `accountRecoveryUrl` (not `…Password…`) so it is
 * not refused here; it carries no token (§4.20). Every allow-listed `EVENT_SPECS` variable must stay
 * unmatched (tested in eventRendering.test.ts).
 */
export const SECRET_VARIABLE =
  /pass(word)?|secret|token|otp|cvv|card|vpa|upi|signature|account_?number|razorpay|gateway|payment_?id/i;

/** §4.11: COD out-for-delivery variant (`order_out_for_delivery_cod_v1`, "Amount to pay: ₹…"). */
export const COD_VARIANT = 'COD';

/**
 * Variant implied by the variables when the caller names none: an `ORDER_OUT_FOR_DELIVERY` carrying
 * `codAmount` (set by the caller only for COD orders, from the stored order total) uses the COD
 * variant. Pure.
 */
export function implicitVariant(
  event: NotificationEvent,
  variables: Readonly<Record<string, unknown>>,
): string | undefined {
  if (event !== 'ORDER_OUT_FOR_DELIVERY') return undefined;
  const cod = variables.codAmount;
  return cod === undefined || cod === null || cod === '' ? undefined : COD_VARIANT;
}

/** §7.1: 5 attempts total; delays after attempts 1–4. */
export const MAX_ATTEMPTS = 5;
export const RETRY_DELAYS_MS: readonly number[] = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000];

/** Retry delay after `attemptNo` failed (1-based) with ±10 % jitter (`random` ∈ [0,1)). */
export function retryDelayMs(attemptNo: number, random: () => number = Math.random): number {
  const base = RETRY_DELAYS_MS[Math.min(attemptNo, RETRY_DELAYS_MS.length) - 1] ?? 60_000;
  const jitter = (random() * 2 - 1) * 0.1;
  return Math.round(base * (1 + jitter));
}

const IST_OFFSET_MS = 330 * 60_000;

/**
 * PROVISIONAL (OQ-101) quiet hours 21:00–09:00 IST. Returns the next 09:00 IST instant when `now`
 * is inside quiet hours, otherwise `undefined`.
 */
export function quietHoursDeferral(now: Date): Date | undefined {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const hour = ist.getUTCHours();
  if (hour >= 9 && hour < 21) return undefined;
  const target = new Date(
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 9, 0, 0, 0),
  );
  if (hour >= 21) target.setUTCDate(target.getUTCDate() + 1);
  return new Date(target.getTime() - IST_OFFSET_MS);
}

/** Skip / failure reason codes written to `notification_logs.error_code`. */
export type SkipReason =
  | 'OPTED_OUT'
  | 'NO_CONSENT'
  | 'NO_ADDRESS'
  | 'CHANNEL_DISABLED'
  | 'CHANNEL_UNSUPPORTED'
  | 'TEMPLATE_MISSING'
  | 'TEMPLATE_NOT_APPROVED';
