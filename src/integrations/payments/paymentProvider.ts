/**
 * Payment provider adapter contract — BACKEND_STRUCTURE.md §15 (`PaymentGateway`), §16 (webhooks),
 * SECURITY_GUIDELINES.md §10. PROVISIONAL (OQ-06): no gateway is selected, only the mock adapter
 * exists (`PAYMENT_PROVIDER=mock`). No production credentials; never production-verified.
 *
 * Rules every adapter follows:
 * - Amounts are server-computed minor units (paise); client-provided amounts are never trusted.
 * - Calls are made AFTER commit, never inside a DB transaction.
 * - No card / UPI / bank credential is ever returned, stored or logged.
 *
 * Two layers:
 * - `PaymentProviderAdapter` — initiate / verify / refund (the refunds module uses `refund`).
 * - `VerifiablePaymentProvider` — adds what payment capture needs: client-callback signature check,
 *   server-side status fetch (`fetchPayment`), webhook signature verification over the RAW body and
 *   webhook parsing. Checked at runtime with `isVerifiablePaymentProvider` so adapters that only
 *   implement the base contract (test fakes) keep compiling.
 *
 * ── Mock provider contract (tests / local development only; refused in production) ──────────────
 *
 * | Item                    | Contract |
 * | providerOrderId         | `mock_order_<16 hex>_<amountMinor>` (amount recorded by the "gateway") |
 * | client signature        | hex HMAC-SHA256(`MOCK_PAYMENT_KEY_SECRET`, `${providerOrderId}|${providerPaymentId}`) |
 * |                         | — `signMockPaymentCallback(providerOrderId, providerPaymentId)` |
 * | fetchPayment status     | `simulatePayment()` override, else by payment id prefix: `mock_fail_*` → FAILED, |
 * |                         | `mock_pending_*` → PENDING, anything else → CAPTURED for the order's amount |
 * | webhook headers         | `x-mock-timestamp` (unix seconds, ±300 s) and |
 * |                         | `x-mock-signature: sha256=<hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)>` |
 * |                         | — `signMockPaymentWebhook(rawBody, timestamp)` |
 * | webhook body (JSON)     | `{ eventId, event: payment.captured|payment.failed|refund.processed|refund.failed, |
 * |                         |   providerOrderId, providerPaymentId?, amountMinor?, currency?, method?, |
 * |                         |   errorCode?, errorDescription?, providerRefundId? }` |
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export interface PaymentInitiationInput {
  readonly orderId: string;
  readonly amountMinor: number;
  readonly currency: 'INR';
  readonly idempotencyKey?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface PaymentInitiationResult {
  readonly provider: string;
  readonly providerOrderId: string;
  readonly status: 'INITIATED' | 'PENDING' | 'FAILED';
  readonly raw?: unknown;
}

export interface PaymentVerificationInput {
  readonly provider: string;
  readonly payload: unknown;
  readonly signature?: string;
}

export interface PaymentVerificationResult {
  readonly verified: boolean;
  readonly providerPaymentId?: string;
  readonly status?: 'SUCCEEDED' | 'FAILED' | 'PENDING';
  readonly reason?: string;
}

export interface PaymentProviderAdapter {
  readonly name: string;
  initiate(input: PaymentInitiationInput): Promise<PaymentInitiationResult>;
  verify(input: PaymentVerificationInput): Promise<PaymentVerificationResult>;
  /** Refund against a captured payment. Called after commit, never inside a DB transaction. */
  refund(input: PaymentRefundInput): Promise<PaymentRefundResult>;
}

export interface PaymentRefundInput {
  readonly providerPaymentId: string;
  readonly amountMinor: number;
  readonly currency: 'INR';
  /** Our refund id — passed as the gateway idempotency key so retries never double-refund. */
  readonly refundId: string;
  readonly reason?: string;
}

export interface PaymentRefundResult {
  readonly provider: string;
  readonly providerRefundId?: string;
  readonly status: 'PROCESSING' | 'COMPLETED' | 'FAILED';
  readonly reason?: string;
}

// ── Capture-side contract ─────────────────────────────────────────────────────────────────────

export type WebhookHeaders = IncomingHttpHeaders;

/** Bad / missing / stale signature — the caller answers 401 without detail. */
export class PaymentWebhookSignatureError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'PaymentWebhookSignatureError';
  }
}

/** Correctly signed but malformed payload — the caller answers 400. */
export class PaymentWebhookPayloadError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'PaymentWebhookPayloadError';
  }
}

export type ProviderPaymentStatus = 'CAPTURED' | 'AUTHORIZED' | 'FAILED' | 'PENDING';

/** Gateway-side state of one payment (server-to-server fetch — the only trusted source). */
export interface ProviderPaymentState {
  readonly providerPaymentId: string;
  readonly providerOrderId: string;
  readonly status: ProviderPaymentStatus;
  /** Paise as recorded by the gateway (compared with our order before capture). */
  readonly amountMinor: number;
  readonly currency: string;
  /** Coarse instrument type only (`upi`, `card`, `netbanking`) — never identifiers. */
  readonly method: string | null;
  readonly errorCode: string | null;
  readonly errorDescription: string | null;
}

export type PaymentWebhookEventType =
  'PAYMENT_CAPTURED' | 'PAYMENT_FAILED' | 'REFUND_PROCESSED' | 'REFUND_FAILED' | 'UNKNOWN';

export interface PaymentWebhookEvent {
  readonly eventId: string;
  readonly type: PaymentWebhookEventType;
  /** Provider event name as received (for the log). */
  readonly providerEvent: string;
  readonly providerOrderId: string | null;
  readonly providerPaymentId: string | null;
  readonly providerRefundId: string | null;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly method: string | null;
  readonly errorCode: string | null;
  readonly errorDescription: string | null;
  /** Parsed body (stored redacted on `payment_transactions.request_payload`). */
  readonly payload: Record<string, unknown>;
}

export interface VerifiablePaymentProvider extends PaymentProviderAdapter {
  /** Public key id handed to the storefront checkout widget (never a secret). */
  readonly publicKeyId: string;
  /** Constant-time check of the client-callback signature. */
  verifyClientSignature(input: {
    readonly providerOrderId: string;
    readonly providerPaymentId: string;
    readonly signature: string;
  }): boolean;
  /** Server-to-server status fetch (amount, currency, status) — called outside transactions. */
  fetchPayment(input: {
    readonly providerOrderId: string;
    readonly providerPaymentId: string;
  }): Promise<ProviderPaymentState>;
  /**
   * OPTIONAL: every gateway payment made against one gateway order (server-to-server). Used by the
   * `payment-reconciliation` job for payments whose client callback never arrived, i.e. we have no
   * `providerPaymentId`. Adapters without it can only reconcile payments with a known payment id.
   */
  fetchOrderPayments?(providerOrderId: string): Promise<readonly ProviderPaymentState[]>;
  /** Throws `PaymentWebhookSignatureError`; must run BEFORE `parseWebhook`. */
  verifyWebhook(rawBody: Buffer, headers: WebhookHeaders, now: Date): void;
  /** Throws `PaymentWebhookPayloadError` on malformed (but correctly signed) payloads. */
  parseWebhook(rawBody: Buffer): PaymentWebhookEvent;
}

export function isVerifiablePaymentProvider(
  provider: PaymentProviderAdapter,
): provider is VerifiablePaymentProvider {
  const p = provider as Partial<VerifiablePaymentProvider>;
  return (
    typeof p.verifyClientSignature === 'function' &&
    typeof p.fetchPayment === 'function' &&
    typeof p.verifyWebhook === 'function' &&
    typeof p.parseWebhook === 'function'
  );
}

// ── Mock adapter ──────────────────────────────────────────────────────────────────────────────

/** Public TEST values — the mock is refused in production by the payments module. */
export const MOCK_PAYMENT_KEY_ID = 'mock_key_id';
export const MOCK_PAYMENT_KEY_SECRET = 'mock-payment-key-test-secret';
export const MOCK_PAYMENT_WEBHOOK_TEST_SECRET = 'mock-payment-webhook-test-secret';
export const PAYMENT_WEBHOOK_TOLERANCE_SECONDS = 300;

function hmacHex(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function signMockPaymentCallback(
  providerOrderId: string,
  providerPaymentId: string,
  secret: string = MOCK_PAYMENT_KEY_SECRET,
): string {
  return hmacHex(secret, `${providerOrderId}|${providerPaymentId}`);
}

export function signMockPaymentWebhook(
  rawBody: Buffer | string,
  timestamp: number,
  secret: string = MOCK_PAYMENT_WEBHOOK_TEST_SECRET,
): string {
  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  return `sha256=${hmacHex(secret, `${String(timestamp)}.${body}`)}`;
}

function header(headers: WebhookHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function str(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null;
}

const MOCK_EVENT_TYPES: Readonly<Record<string, PaymentWebhookEventType>> = {
  'payment.captured': 'PAYMENT_CAPTURED',
  'payment.failed': 'PAYMENT_FAILED',
  'refund.processed': 'REFUND_PROCESSED',
  'refund.failed': 'REFUND_FAILED',
};

const MOCK_ORDER_ID = /^mock_order_[0-9a-f]{16}_(\d{1,12})$/;

export interface MockPaymentProviderOptions {
  readonly keySecret?: string;
  readonly webhookSecret?: string;
  /** Simulate a gateway outage on `initiate`. */
  readonly failInitiate?: boolean;
}

export class MockPaymentProviderAdapter implements VerifiablePaymentProvider {
  readonly name = 'mock';
  readonly publicKeyId = MOCK_PAYMENT_KEY_ID;
  private readonly keySecret: string;
  private readonly webhookSecret: string;
  private readonly overrides = new Map<string, Partial<ProviderPaymentState>>();
  private readonly orderPayments = new Map<string, string[]>();
  failInitiate: boolean;

  constructor(options: MockPaymentProviderOptions = {}) {
    this.keySecret = options.keySecret ?? MOCK_PAYMENT_KEY_SECRET;
    this.webhookSecret = options.webhookSecret ?? MOCK_PAYMENT_WEBHOOK_TEST_SECRET;
    this.failInitiate = options.failInitiate ?? false;
  }

  /** Deterministic provider order id for an order/attempt (exposed for tests). */
  static providerOrderIdFor(seed: string, amountMinor: number): string {
    const digest = createHash('sha256').update(seed).digest('hex').slice(0, 16);
    return `mock_order_${digest}_${String(amountMinor)}`;
  }

  /** Test hook: force what `fetchPayment` reports for a payment id. */
  simulatePayment(providerPaymentId: string, state: Partial<ProviderPaymentState>): void {
    this.overrides.set(providerPaymentId, state);
  }

  async initiate(input: PaymentInitiationInput): Promise<PaymentInitiationResult> {
    await Promise.resolve();
    if (this.failInitiate) throw new Error('Mock gateway outage.');
    const seed = `${input.orderId}:${input.idempotencyKey ?? ''}`;
    return {
      provider: this.name,
      providerOrderId: MockPaymentProviderAdapter.providerOrderIdFor(seed, input.amountMinor),
      status: 'INITIATED',
      raw: { mock: true, amountMinor: input.amountMinor, currency: input.currency },
    };
  }

  async verify(input: PaymentVerificationInput): Promise<PaymentVerificationResult> {
    await Promise.resolve();
    const payload =
      typeof input.payload === 'object' && input.payload !== null
        ? (input.payload as Record<string, unknown>)
        : {};
    const orderId = str(payload.providerOrderId, 100);
    const paymentId = str(payload.providerPaymentId, 100);
    if (orderId === null || paymentId === null || input.signature === undefined) {
      return { verified: false, reason: 'Missing callback fields.' };
    }
    const verified = this.verifyClientSignature({
      providerOrderId: orderId,
      providerPaymentId: paymentId,
      signature: input.signature,
    });
    return verified
      ? { verified: true, providerPaymentId: paymentId, status: 'PENDING' }
      : { verified: false, reason: 'Signature mismatch.' };
  }

  async refund(input: PaymentRefundInput): Promise<PaymentRefundResult> {
    await Promise.resolve();
    return {
      provider: this.name,
      providerRefundId: `mock_rfnd_${input.refundId}`,
      status: 'COMPLETED',
    };
  }

  verifyClientSignature(input: {
    readonly providerOrderId: string;
    readonly providerPaymentId: string;
    readonly signature: string;
  }): boolean {
    const expected = signMockPaymentCallback(
      input.providerOrderId,
      input.providerPaymentId,
      this.keySecret,
    );
    return safeEqual(input.signature, expected);
  }

  /** Test hook: a payment the "gateway" holds for an order (listed by `fetchOrderPayments`). */
  simulateOrderPayment(providerOrderId: string, providerPaymentId: string): void {
    const ids = this.orderPayments.get(providerOrderId) ?? [];
    if (!ids.includes(providerPaymentId)) ids.push(providerPaymentId);
    this.orderPayments.set(providerOrderId, ids);
  }

  /** Payments registered with `simulateOrderPayment` (none by default: customer never paid). */
  async fetchOrderPayments(providerOrderId: string): Promise<ProviderPaymentState[]> {
    const ids = this.orderPayments.get(providerOrderId) ?? [];
    return Promise.all(
      ids.map((providerPaymentId) => this.fetchPayment({ providerOrderId, providerPaymentId })),
    );
  }

  async fetchPayment(input: {
    readonly providerOrderId: string;
    readonly providerPaymentId: string;
  }): Promise<ProviderPaymentState> {
    await Promise.resolve();
    const recorded = MOCK_ORDER_ID.exec(input.providerOrderId);
    const amountMinor = recorded?.[1] === undefined ? 0 : Number(recorded[1]);
    const status: ProviderPaymentStatus = input.providerPaymentId.startsWith('mock_fail_')
      ? 'FAILED'
      : input.providerPaymentId.startsWith('mock_pending_')
        ? 'PENDING'
        : 'CAPTURED';
    const base: ProviderPaymentState = {
      providerPaymentId: input.providerPaymentId,
      providerOrderId: input.providerOrderId,
      status,
      amountMinor,
      currency: 'INR',
      method: 'upi',
      errorCode: status === 'FAILED' ? 'PAYMENT_DECLINED' : null,
      errorDescription: status === 'FAILED' ? 'Payment declined by the mock gateway.' : null,
    };
    return { ...base, ...this.overrides.get(input.providerPaymentId) };
  }

  verifyWebhook(rawBody: Buffer, headers: WebhookHeaders, now: Date): void {
    const timestamp = header(headers, 'x-mock-timestamp');
    const signature = header(headers, 'x-mock-signature');
    if (timestamp === undefined || signature === undefined) {
      throw new PaymentWebhookSignatureError('missing signature headers');
    }
    if (!/^\d{1,12}$/.test(timestamp)) throw new PaymentWebhookSignatureError('bad timestamp');
    const ts = Number(timestamp);
    if (Math.abs(now.getTime() / 1000 - ts) > PAYMENT_WEBHOOK_TOLERANCE_SECONDS) {
      throw new PaymentWebhookSignatureError('timestamp outside tolerance');
    }
    const expected = signMockPaymentWebhook(rawBody, ts, this.webhookSecret);
    if (!safeEqual(signature, expected)) {
      throw new PaymentWebhookSignatureError('signature mismatch');
    }
  }

  parseWebhook(rawBody: Buffer): PaymentWebhookEvent {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new PaymentWebhookPayloadError('invalid JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new PaymentWebhookPayloadError('payload must be an object');
    }
    const e = parsed as Record<string, unknown>;
    const eventId = str(e.eventId, 100);
    const providerEvent = str(e.event, 60);
    if (eventId === null || providerEvent === null) {
      throw new PaymentWebhookPayloadError('missing eventId/event');
    }
    const amount = e.amountMinor;
    if (
      amount !== undefined &&
      amount !== null &&
      !(typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0)
    ) {
      throw new PaymentWebhookPayloadError('bad amountMinor');
    }
    return {
      eventId,
      type: MOCK_EVENT_TYPES[providerEvent] ?? 'UNKNOWN',
      providerEvent,
      providerOrderId: str(e.providerOrderId, 100),
      providerPaymentId: str(e.providerPaymentId, 100),
      providerRefundId: str(e.providerRefundId, 100),
      amountMinor: typeof amount === 'number' ? amount : null,
      currency: str(e.currency, 3),
      method: str(e.method, 30),
      errorCode: str(e.errorCode, 60),
      errorDescription: str(e.errorDescription, 500),
      payload: e,
    };
  }
}
