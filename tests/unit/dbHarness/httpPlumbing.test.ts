/**
 * DEC-12 HTTP helpers (tests/db/harness/http.ts, scenario.ts) — request plumbing checked OFFLINE.
 *
 * The scenarios cannot run before DEC-12, so this file drives the same helpers through the REAL
 * app that `openWorld()` builds, on a FAKE in-memory client (`client.js` is mocked for the whole
 * file — no database, no connection). It proves that the helpers' requests are the ones the real
 * routes accept: authentication headers, Idempotency-Key, strict request bodies, the signed raw
 * webhook body, and the response envelope readers (`201`, replay, conflict, error codes).
 * It does NOT prove any database behaviour — that is what the `*.dbtest.ts` scenarios are for.
 */
import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clientModule = vi.hoisted(() => ({
  openVerifiedClient: vi.fn(),
  createTestPrismaClient: vi.fn(() => {
    throw new Error('a Prisma client must never be constructed in the default suite');
  }),
  assertServerDatabase: vi.fn(),
}));
vi.mock('../../db/harness/client.js', () => clientModule);

import { requestHash } from '../../../src/core/middleware/idempotency.js';
import type { PlacedOrderDto } from '../../../src/modules/checkout/index.js';
import type { CustomerFixture } from '../../db/harness/fixtures.js';
import { DB_TEST_CONFIRM_VAR, DB_TEST_URL_VAR } from '../../db/harness/guard.js';
import {
  dataFlag,
  fetchQuoteHash,
  outcomeLabel,
  placeOrder,
  readPlacedOrder,
  sendCaptureWebhook,
  signInCustomer,
  tallyResults,
  verifyPayment,
  type PlaceOrderRequest,
} from '../../db/harness/http.js';
import { at, prepareBuyers } from '../../db/harness/scenario.js';
import { openWorld, type DbWorld } from '../../db/harness/world.js';

type Method = (...args: unknown[]) => Promise<unknown>;
type Overrides = Record<string, Record<string, Method>>;

const DEFAULT_RESULTS: Readonly<Record<string, unknown>> = {
  findUnique: null,
  findFirst: null,
  findMany: [],
  count: 0,
  create: { id: 'fake-id' },
  update: { id: 'fake-id' },
  upsert: { id: 'fake-id' },
  delete: { id: 'fake-id' },
  createMany: { count: 0 },
  updateMany: { count: 0 },
  deleteMany: { count: 0 },
};

/** Minimal in-memory stand-in: every model method resolves to an empty default. */
function fakeClient(overrides: Overrides): unknown {
  const model = (name: string): unknown =>
    new Proxy(
      {},
      {
        get: (_target, method): Method | undefined => {
          if (typeof method !== 'string') return undefined;
          return overrides[name]?.[method] ?? (() => Promise.resolve(DEFAULT_RESULTS[method]));
        },
      },
    );
  const client: unknown = new Proxy(
    {},
    {
      get: (_target, key): unknown => {
        if (typeof key !== 'string' || key === 'then') return undefined;
        if (key === '$transaction') return (run: (tx: unknown) => unknown) => run(client);
        if (key.startsWith('$')) return () => Promise.resolve([]);
        return model(key);
      },
    },
  );
  return client;
}

const userId = randomUUID();
const customer: CustomerFixture = {
  index: 0,
  userId,
  email: 'dbtest-plumbing@example.test',
  addressId: randomUUID(),
  cartId: randomUUID(),
};
const activeCustomer = {
  id: userId,
  accountType: 'CUSTOMER',
  status: 'ACTIVE',
  isSuperadmin: false,
  email: customer.email,
  firstName: 'Dbtest',
  lastName: 'Plumbing',
  phone: null,
  emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
  deletedAt: null,
};
const order: PlaceOrderRequest = {
  shippingAddressId: customer.addressId,
  shippingMethodId: randomUUID(),
  paymentMethod: 'ONLINE',
  quoteHash: `sha256:${'a'.repeat(64)}`,
};

async function worldWith(overrides: Overrides = {}): Promise<DbWorld> {
  clientModule.openVerifiedClient.mockResolvedValue(
    fakeClient({
      user: { findUnique: () => Promise.resolve(activeCustomer) },
      refreshToken: { findFirst: () => Promise.resolve({ id: 'session-row' }) },
      ...overrides,
    }),
  );
  return openWorld();
}

beforeEach(() => {
  vi.stubEnv(DB_TEST_CONFIRM_VAR, 'ecommerce_test');
  // Fake credentials on a closed port: unusable even if the client mock were bypassed.
  vi.stubEnv(DB_TEST_URL_VAR, 'mysql://dbtest_fake:not-a-real-password@127.0.0.1:1/ecommerce_test');
  vi.stubEnv('DATABASE_URL', undefined);
  vi.stubEnv('MIGRATION_DATABASE_URL', undefined);
  vi.stubEnv('DB_TESTS_ITERATIONS', undefined);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  clientModule.openVerifiedClient.mockReset();
});

describe('DEC-12 HTTP helpers — requests are accepted by the real routes (fake client)', () => {
  it('checkout: session, summary body and order body pass auth, idempotency and validation', async () => {
    const world = await worldWith();
    const session = await signInCustomer(world, userId);
    expect(session.headers.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);

    // Both requests reach the checkout service: it finds no address in the fake client (404).
    // A rejected token would be 401, a rejected body 422, a missing Idempotency-Key 400.
    await expect(
      fetchQuoteHash(world, session, {
        shippingAddressId: order.shippingAddressId,
        shippingMethodId: order.shippingMethodId,
        paymentMethod: 'ONLINE',
      }),
    ).rejects.toThrow('checkout summary failed: 404:NOT_FOUND');
    await expect(
      prepareBuyers(world, [customer], {
        shippingMethodId: order.shippingMethodId,
        paymentMethod: 'COD',
      }),
    ).rejects.toThrow('checkout summary failed: 404:NOT_FOUND');

    const placed = await placeOrder(world, session, randomUUID(), order);
    expect(outcomeLabel(placed)).toBe('404:NOT_FOUND');
    expect(readPlacedOrder(placed)).toBeNull();
    const withNote = await placeOrder(world, session, randomUUID(), {
      ...order,
      customerNote: 'x',
    });
    expect(outcomeLabel(withNote)).toBe('404:NOT_FOUND');
  });

  it('checkout: an unauthenticated session is refused (the helper does not bypass auth)', async () => {
    const world = await worldWith({ refreshToken: { findFirst: () => Promise.resolve(null) } });
    const session = await signInCustomer(world, userId);
    const refused = await placeOrder(world, session, randomUUID(), order);
    expect(outcomeLabel(refused)).toBe('401:UNAUTHENTICATED');
  });

  it('idempotency: stored response → replay; in progress / other body → 409 with the detail code', async () => {
    const key = randomUUID();
    const stored: PlacedOrderDto = {
      order: {
        id: randomUUID(),
        orderNumber: 'ORD-261124-00001',
        status: 'PENDING_PAYMENT',
        paymentMethod: 'ONLINE',
        paymentStatus: 'PENDING',
        placedAt: '2026-11-24T10:00:00.000Z',
        grandTotal: '1000.00',
        currency: 'INR',
        reservationExpiresAt: '2026-11-24T10:15:00.000Z',
      },
      payment: {
        paymentId: randomUUID(),
        provider: 'mock',
        providerOrderId: 'mock_order_0123456789abcdef_100000',
        amount: '1000.00',
        currency: 'INR',
        clientPayload: {
          keyId: 'mock_key_id',
          orderRef: 'mock_order_0123456789abcdef_100000',
          prefill: { name: 'Dbtest Plumbing', email: customer.email, contact: null },
        },
        returnUrl: 'http://localhost:5173/checkout/payment-return?order=ORD-261124-00001',
      },
    };
    const hash = requestHash('POST', '/api/v1/checkout/orders', { ...order, acceptTerms: true });
    let existing: Record<string, unknown> = {
      requestHash: hash,
      status: 'COMPLETED',
      responseRef: { status: 201, body: { success: true, data: stored, requestId: 'r-1' } },
    };
    const world = await worldWith({
      idempotencyKey: {
        create: () =>
          Promise.reject(Object.assign(new Error('unique'), { code: 'P2002', clientVersion: 'x' })),
        findFirst: () => Promise.resolve(existing),
        count: () => Promise.resolve(0),
      },
    });
    const session = await signInCustomer(world, userId);

    const replay = await placeOrder(world, session, key, order);
    expect(outcomeLabel(replay)).toBe('201:replayed');
    expect(readPlacedOrder(replay)).toEqual({
      orderId: stored.order.id,
      orderNumber: stored.order.orderNumber,
      status: 'PENDING_PAYMENT',
      providerOrderId: stored.payment?.providerOrderId,
    });

    const mismatch = await placeOrder(world, session, key, { ...order, customerNote: 'other' });
    expect({ label: outcomeLabel(mismatch), detail: mismatch.detailCode }).toEqual({
      label: '409:IDEMPOTENCY_CONFLICT',
      detail: 'PAYLOAD_MISMATCH',
    });

    existing = { requestHash: hash, status: 'IN_PROGRESS', responseRef: null };
    const inProgress = await placeOrder(world, session, key, order);
    expect({ label: outcomeLabel(inProgress), detail: inProgress.detailCode }).toEqual({
      label: '409:IDEMPOTENCY_CONFLICT',
      detail: 'IN_PROGRESS',
    });
    expect(tallyResults([replay, mismatch, inProgress])).toEqual({
      '201:replayed': 1,
      '409:IDEMPOTENCY_CONFLICT': 2,
    });
  });

  it('payments: the verify body and the signed raw webhook body are accepted', async () => {
    const world = await worldWith();
    const session = await signInCustomer(world, userId);
    const refs = {
      orderNumber: 'ORD-261124-00001',
      providerOrderId: 'mock_order_0123456789abcdef_100000',
      providerPaymentId: `mock_pay_${randomUUID().replaceAll('-', '')}`,
    };

    // Reaches the payments service, which finds no such order in the fake client (404).
    expect(outcomeLabel(await verifyPayment(world, session, refs))).toBe('404:NOT_FOUND');

    // Signature and payload are valid (a bad signature is 401, a bad payload 400); the fake
    // client knows no such payment, so the real handler acknowledges and ignores the event.
    const webhook = await sendCaptureWebhook(world, {
      eventId: `evt_${randomUUID()}`,
      providerOrderId: refs.providerOrderId,
      providerPaymentId: refs.providerPaymentId,
      amountMinor: 100_000,
    });
    expect(webhook.status).toBe(200);
    expect(dataFlag(webhook, 'received')).toBe(true);
    expect(dataFlag(webhook, 'ignored')).toBe(true);

    // A known event id is answered as a duplicate — the reader TC-051 relies on.
    const seen = await worldWith({
      paymentTransaction: { findFirst: () => Promise.resolve({ id: 'txn-1' }) },
    });
    const duplicate = await sendCaptureWebhook(seen, {
      eventId: 'evt_known',
      providerOrderId: refs.providerOrderId,
      providerPaymentId: refs.providerPaymentId,
      amountMinor: 100_000,
    });
    expect({ status: duplicate.status, duplicate: dataFlag(duplicate, 'duplicate') }).toEqual({
      status: 200,
      duplicate: true,
    });
  });

  it('at() fails loudly on an index outside the prepared data', () => {
    expect(at(['a'], 0)).toBe('a');
    expect(() => at(['a'], 1)).toThrow('out of range');
  });
});
