/**
 * FR-SF-047 — "No card/UPI credentials touch our servers; gateway-hosted or SDK checkout only."
 *
 * The requirement is met by design (gateway-hosted checkout + strict request schemas). These tests
 * pin the API side of that design through the real Express app, MOCKED DB (tests/helpers/mockDb.ts):
 *
 * - `POST /checkout/summary`, `POST /checkout/orders` and `POST /payments/verify` have strict
 *   bodies: a request carrying card / UPI fields is REJECTED with 422 (not silently stripped) and
 *   nothing is priced, written or sent to the gateway;
 * - the two places that do accept free-form data never keep instrument values:
 *   `providerPayload` on verify is accepted but never read, and a signed provider webhook is
 *   stored with `card` / `cvv` / `vpa` keys redacted;
 * - `POST /me/orders/:orderNumber/retry-payment` declares no body schema — a body is ignored (as
 *   implemented), not rejected;
 * - the payment session handed to the browser is a gateway order reference, never instrument data.
 *
 * "Persisted" is checked over every mocked Prisma call of the request; "logged" over a real logger
 * at `trace` level writing to memory (access log + everything the modules log through the
 * container logger). The idempotency middleware and the audit service keep the silent logger they
 * were built with, so their log output is outside this check.
 */
import request from 'supertest';
import { describe, expect, it, vi, type Mock } from 'vitest';

import { createApp } from '../../../../src/app.js';
import type { AppContainer } from '../../../../src/container.js';
import { Readiness } from '../../../../src/core/health/readiness.js';
import { createLogger } from '../../../../src/core/logger/logger.js';
import { Prisma } from '../../../../src/generated/prisma/client.js';
import {
  MockPaymentProviderAdapter,
  signMockPaymentCallback,
  signMockPaymentWebhook,
} from '../../../../src/integrations/payments/paymentProvider.js';
import {
  CheckoutSummaryBody,
  PlaceOrderBody,
  checkoutModuleWith,
} from '../../../../src/modules/checkout/index.js';
import { createPaymentsModule } from '../../../../src/modules/payments/index.js';
import { VerifyPaymentBody } from '../../../../src/modules/payments/payments.schemas.js';
import type { ModuleFactory } from '../../../../src/modules/types.js';
import { buildModules } from '../../../../src/routes/v1.js';
import { buildModuleTestApp } from '../../../helpers/container.js';
import type { MockModels } from '../../../helpers/mockDb.js';
import { IDS, NOW, primeCheckout, serviceable, summaryBody } from '../checkout/fixtures.js';
import { ORDER_NUMBER, PROVIDER_ORDER_ID, buildWorld, type WorldOptions } from './world.js';

/** What a tampered / naive client might post. Values are distinctive so they can be searched for. */
const CARD = {
  cardNumber: '4111111111111111',
  cvv: '737',
  expiry: '12/29',
  cardholderName: 'A RAO CARDHOLDER',
  vpa: 'ananya.rao@okhdfcbank',
} as const;

const CARD_VALUES: readonly RegExp[] = [
  /4111111111111111/,
  /"737"/, // the CVV as a JSON string value (a bare 737 could occur inside a hash or id)
  /12\/29/,
  /A RAO CARDHOLDER/,
  /ananya\.rao@okhdfcbank/,
];

function expectNoCardData(text: string, where: string): void {
  for (const pattern of CARD_VALUES)
    expect(text, `${where} ${String(pattern)}`).not.toMatch(pattern);
}

const DELEGATE_METHODS = [
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
] as const;

/** Every argument handed to the mocked Prisma client (all models, reads and writes, raw SQL). */
function dbTraffic(m: MockModels): string {
  const traffic: unknown[] = [];
  const models = m as unknown as Record<string, Record<string, Mock | undefined> | undefined>;
  for (const name of Object.values(Prisma.ModelName)) {
    const key = `${name.charAt(0).toLowerCase()}${name.slice(1)}`;
    for (const method of DELEGATE_METHODS) {
      const calls = models[key]?.[method]?.mock.calls ?? [];
      if (calls.length > 0) traffic.push({ model: key, method, calls });
    }
  }
  for (const raw of ['$queryRaw', '$queryRawUnsafe', '$executeRaw', '$executeRawUnsafe'] as const) {
    traffic.push({ raw, calls: m[raw].mock.calls });
  }
  return JSON.stringify(traffic, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

/** All property names of a JSON-like value, at any depth. */
function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) keysOf(item, out);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      out.add(key);
      keysOf(child, out);
    }
  }
  return out;
}

const INSTRUMENT_KEY = /card|cvv|cvc|expiry|upi|vpa|netbanking|bankAccount|ifsc/i;

/** Module app whose access log and container logger write to memory at `trace` level. */
function build(
  factories: readonly ModuleFactory[],
  now: Date,
  gateway: MockPaymentProviderAdapter,
) {
  const t = buildModuleTestApp(factories, { now, overrides: { providers: { payment: gateway } } });
  const lines: string[] = [];
  const logger = createLogger(
    { ...t.container.config, log: { level: 'trace', pretty: false } },
    { write: (chunk: string) => lines.push(chunk) },
  );
  const container: AppContainer = { ...t.container, logger };
  const app = createApp({
    config: t.container.config,
    logger,
    readiness: new Readiness(),
    container,
    modules: buildModules(container, factories),
  });
  return { t, app, logs: (): string => lines.join('') };
}

function checkoutApp() {
  const gateway = new MockPaymentProviderAdapter();
  const built = build([checkoutModuleWith({ serviceability: serviceable })], NOW, gateway);
  const auth = built.t.customer({ userId: IDS.user }).headers;
  primeCheckout(built.t.m, IDS.user);
  return { ...built, gateway, auth };
}

const PAY_NOW = new Date('2026-11-13T09:50:00.000Z');

function paymentsApp(world: WorldOptions = {}) {
  const gateway = new MockPaymentProviderAdapter();
  const built = build([createPaymentsModule], PAY_NOW, gateway);
  const auth = built.t.customer({ userId: IDS.user }).headers;
  const w = buildWorld(built.t.m, world);
  return { ...built, gateway, auth, w };
}

const verifyBody = (paymentId = 'pay_ok_001') => ({
  orderNumber: ORDER_NUMBER,
  providerOrderId: PROVIDER_ORDER_ID,
  providerPaymentId: paymentId,
  providerSignature: signMockPaymentCallback(PROVIDER_ORDER_ID, paymentId),
});

const placeBody = (quoteHash: string, over: Record<string, unknown> = {}) => ({
  ...summaryBody(),
  quoteHash,
  acceptTerms: true,
  ...over,
});

interface ErrorBody {
  error: { code: string; details: { field?: string; message: string }[] };
}

describe('FR-SF-047 — strict checkout / payment request bodies', () => {
  it('FR-SF-047: the checkout and verify body schemas are strict and declare no payment-instrument field', () => {
    for (const schema of [CheckoutSummaryBody, PlaceOrderBody, VerifyPaymentBody]) {
      for (const key of Object.keys(schema.shape)) expect(key).not.toMatch(INSTRUMENT_KEY);
      for (const field of Object.keys(CARD)) {
        const result = schema.safeParse({ [field]: 'x' });
        const rejected =
          !result.success &&
          result.error.issues.some(
            (issue) => issue.code === 'unrecognized_keys' && issue.keys.includes(field),
          );
        expect(rejected, field).toBe(true);
      }
    }
    // The only payment choice a client makes is the method; the instrument is entered at the gateway.
    expect(PlaceOrderBody.shape.paymentMethod.options).toEqual(['ONLINE', 'COD']);
  });

  it('FR-SF-047: POST /checkout/summary rejects card / UPI fields with 422 before reading the cart', async () => {
    const { t, app, auth, logs } = checkoutApp();
    const post = (body: Record<string, unknown>) =>
      request(app).post('/api/v1/checkout/summary').set(auth).send(body);

    for (const [field, value] of Object.entries(CARD)) {
      const res = await post(summaryBody({ [field]: value }));
      expect(res.status, field).toBe(422);
      const body = res.body as ErrorBody;
      expect(body.error.code).toBe('VALIDATION_ERROR');
      // The offending key is named; its value is not echoed back.
      expect(body.error.details.map((d) => d.message).join(' ')).toContain(field);
      expectNoCardData(JSON.stringify(res.body), 'response');
    }
    const nested = await post(
      summaryBody({ card: { number: CARD.cardNumber, cvv: CARD.cvv, expiry: CARD.expiry } }),
    );
    expect(nested.status).toBe(422);
    expectNoCardData(JSON.stringify(nested.body), 'response');

    // Rejected by validation: no address / cart read, nothing written.
    expect(t.m.userAddress.findMany).not.toHaveBeenCalled();
    expect(t.m.cart.findFirst).not.toHaveBeenCalled();
    expectNoCardData(dbTraffic(t.m), 'db');
    expect(logs()).toContain('request completed');
    expectNoCardData(logs(), 'logs');

    // Control: the same body without the extra fields is a valid quote request.
    expect((await post(summaryBody())).status).toBe(200);
  });

  it('FR-SF-047: POST /checkout/orders rejects card / UPI fields with 422 — no order, reservation, payment or gateway session', async () => {
    const { t, app, auth, gateway, logs } = checkoutApp();
    const initiate = vi.spyOn(gateway, 'initiate');
    const res = await request(app)
      .post('/api/v1/checkout/orders')
      .set(auth)
      .set('Idempotency-Key', 'card-data-key-0000000001')
      .send(placeBody(`sha256:${'a'.repeat(64)}`, CARD));
    expect(res.status).toBe(422);
    const body = res.body as ErrorBody;
    expect(body.error.code).toBe('VALIDATION_ERROR');
    const message = body.error.details.map((d) => d.message).join(' ');
    for (const field of Object.keys(CARD)) expect(message).toContain(field);
    expectNoCardData(JSON.stringify(res.body), 'response');

    expect(t.m.cart.findFirst).not.toHaveBeenCalled();
    expect(t.m.order.create).not.toHaveBeenCalled();
    expect(t.m.orderItem.createMany).not.toHaveBeenCalled();
    expect(t.m.stockReservation.create).not.toHaveBeenCalled();
    expect(t.m.payment.create).not.toHaveBeenCalled();
    expect(t.m.paymentTransaction.create).not.toHaveBeenCalled();
    expect(initiate).not.toHaveBeenCalled();

    // The Idempotency-Key row is written before validation: it keeps a SHA-256 of the request and
    // the 422 response (which names the rejected keys) — never the request body itself.
    const created = t.m.idempotencyKey.create.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(Object.keys(created.data).sort()).toEqual([
      'expiresAt',
      'idemKey',
      'requestHash',
      'scope',
      'status',
      'userId',
    ]);
    expect(created.data.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(t.m.idempotencyKey.update).toHaveBeenCalledWith({
      where: { id: 'idem-row' },
      data: { status: 'COMPLETED', responseRef: { status: 422, body: res.body as unknown } },
    });
    expectNoCardData(dbTraffic(t.m), 'db');
    expect(logs()).toContain('request completed');
    expectNoCardData(logs(), 'logs');
  });

  it('FR-SF-047: POST /payments/verify rejects top-level card / UPI fields with 422 before any lookup or gateway call', async () => {
    const { t, app, auth, gateway, w, logs } = paymentsApp();
    const verifySignature = vi.spyOn(gateway, 'verifyClientSignature');
    const fetchPayment = vi.spyOn(gateway, 'fetchPayment');
    const res = await request(app)
      .post('/api/v1/payments/verify')
      .set(auth)
      .set('Idempotency-Key', 'card-data-key-0000000002')
      .send({ ...verifyBody(), ...CARD });
    expect(res.status).toBe(422);
    const body = res.body as ErrorBody;
    expect(body.error.code).toBe('VALIDATION_ERROR');
    const message = body.error.details.map((d) => d.message).join(' ');
    for (const field of Object.keys(CARD)) expect(message).toContain(field);
    expectNoCardData(JSON.stringify(res.body), 'response');

    expect(t.m.order.findFirst).not.toHaveBeenCalled();
    expect(t.m.payment.findFirst).not.toHaveBeenCalled();
    expect(t.m.paymentTransaction.create).not.toHaveBeenCalled();
    expect(verifySignature).not.toHaveBeenCalled();
    expect(fetchPayment).not.toHaveBeenCalled();
    expect(w.order.status).toBe('PENDING_PAYMENT');
    expectNoCardData(dbTraffic(t.m), 'db');
    expectNoCardData(logs(), 'logs');
  });
});

describe('FR-SF-047 — free-form provider data is never kept', () => {
  it('FR-SF-047: POST /payments/verify accepts `providerPayload` but never reads it — instrument data inside is not persisted, logged or sent on (as implemented)', async () => {
    const { t, app, auth, gateway, w, logs } = paymentsApp();
    const verifySignature = vi.spyOn(gateway, 'verifyClientSignature');
    const fetchPayment = vi.spyOn(gateway, 'fetchPayment');
    const res = await request(app)
      .post('/api/v1/payments/verify')
      .set(auth)
      .set('Idempotency-Key', 'card-data-key-0000000003')
      .send({
        ...verifyBody(),
        providerPayload: { ...CARD, card: { number: CARD.cardNumber, cvv: CARD.cvv } },
      });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ orderStatus: 'CONFIRMED', paymentStatus: 'CAPTURED' });
    expect(w.payments[0]).toMatchObject({ status: 'CAPTURED', providerPaymentId: 'pay_ok_001' });

    // The gateway is asked with the references only.
    expect(verifySignature).toHaveBeenCalledWith({
      providerOrderId: PROVIDER_ORDER_ID,
      providerPaymentId: 'pay_ok_001',
      signature: signMockPaymentCallback(PROVIDER_ORDER_ID, 'pay_ok_001'),
    });
    expect(fetchPayment).toHaveBeenCalledWith({
      providerOrderId: PROVIDER_ORDER_ID,
      providerPaymentId: 'pay_ok_001',
    });

    const db = dbTraffic(t.m);
    expect(db).toContain('pay_ok_001'); // control: the capture really was written and scanned
    expect(t.m.paymentTransaction.create).toHaveBeenCalled();
    expectNoCardData(db, 'db');
    expectNoCardData(JSON.stringify(res.body), 'response');
    expect(logs()).toContain('request completed');
    expectNoCardData(logs(), 'logs');
  });

  it('FR-SF-047: POST /me/orders/:orderNumber/retry-payment has no body schema — a body with card fields is ignored, not rejected (as implemented)', async () => {
    const { t, app, auth, gateway, w, logs } = paymentsApp({
      status: 'PAYMENT_FAILED',
      paymentStatus: 'FAILED',
      payments: [{ status: 'FAILED' }],
      reservations: [
        { variantId: IDS.v1, quantity: 2, status: 'EXPIRED' },
        { variantId: IDS.v2, quantity: 1, status: 'EXPIRED' },
      ],
      inventory: { [IDS.v1]: [20, 0], [IDS.v2]: [20, 0] },
    });
    const initiate = vi.spyOn(gateway, 'initiate');
    const res = await request(app)
      .post(`/api/v1/me/orders/${ORDER_NUMBER}/retry-payment`)
      .set(auth)
      .set('Idempotency-Key', 'card-data-key-0000000004')
      .send({ ...CARD });
    expect(res.status).toBe(200);
    expect(res.body.data.order.status).toBe('PENDING_PAYMENT');
    expect(w.payments[1]).toMatchObject({ attemptNo: 2 });

    expect(initiate).toHaveBeenCalledTimes(1);
    expectNoCardData(JSON.stringify(initiate.mock.calls), 'gateway');
    const db = dbTraffic(t.m);
    expect(db).toContain('"attemptNo":2'); // control: the new attempt really was written and scanned
    expectNoCardData(db, 'db');
    expectNoCardData(JSON.stringify(res.body), 'response');
    expectNoCardData(logs(), 'logs');
  });

  it('FR-SF-047: a signed provider webhook is stored with `card` / `cvv` / `vpa` keys redacted', async () => {
    const { t, app, w, logs } = paymentsApp();
    const raw = JSON.stringify({
      eventId: 'evt_card_1',
      event: 'payment.captured',
      providerOrderId: PROVIDER_ORDER_ID,
      providerPaymentId: 'pay_ok_001',
      amountMinor: 349600,
      currency: 'INR',
      method: 'card',
      card: { number: CARD.cardNumber, expiry: CARD.expiry, name: CARD.cardholderName },
      cvv: CARD.cvv,
      vpa: CARD.vpa,
    });
    const ts = Math.floor(PAY_NOW.getTime() / 1000);
    const res = await request(app)
      .post('/api/v1/webhooks/payments/mock')
      .set('Content-Type', 'application/json')
      .set('x-mock-timestamp', String(ts))
      .set('x-mock-signature', signMockPaymentWebhook(raw, ts))
      .send(raw);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ received: true });
    expect(w.order.status).toBe('CONFIRMED');

    const stored = t.m.paymentTransaction.create.mock.calls
      .map((call) => (call[0] as { data: { type: string; requestPayload?: unknown } }).data)
      .find((data) => data.type === 'WEBHOOK');
    expect(stored?.requestPayload).toMatchObject({
      eventId: 'evt_card_1',
      event: 'payment.captured',
      method: 'card',
      card: '***REDACTED***',
      cvv: '***REDACTED***',
      vpa: '***REDACTED***',
    });
    expectNoCardData(dbTraffic(t.m), 'db');
    expect(logs()).toContain('request completed');
    expectNoCardData(logs(), 'logs');
  });
});

describe('FR-SF-047 — gateway-hosted checkout', () => {
  it('FR-SF-047: an ONLINE order returns a gateway session (order reference + client payload), and neither the gateway request nor the response carries an instrument field', async () => {
    const { t, app, auth, gateway } = checkoutApp();
    const initiate = vi.spyOn(gateway, 'initiate');
    const summary = await request(app)
      .post('/api/v1/checkout/summary')
      .set(auth)
      .send(summaryBody());
    expect(summary.status).toBe(200);
    const res = await request(app)
      .post('/api/v1/checkout/orders')
      .set(auth)
      .set('Idempotency-Key', 'card-data-key-0000000005')
      .send(placeBody(summary.body.data.quoteHash as string));
    expect(res.status).toBe(201);

    const { payment } = res.body.data as {
      payment: { providerOrderId: string; clientPayload: { orderRef: string } };
    };
    expect(payment.clientPayload.orderRef).toBe(payment.providerOrderId);
    expect([...keysOf(res.body)].filter((key) => INSTRUMENT_KEY.test(key))).toEqual([]);

    expect(initiate).toHaveBeenCalledTimes(1);
    expect([...keysOf(initiate.mock.calls)].filter((key) => INSTRUMENT_KEY.test(key))).toEqual([]);

    // The stored payment attempt has a method, never an instrument.
    const attempt = t.m.payment.create.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(attempt.data).toMatchObject({ paymentMethod: 'ONLINE', status: 'PENDING' });
    expect([...keysOf(attempt.data)].filter((key) => INSTRUMENT_KEY.test(key))).toEqual([]);
  });
});
