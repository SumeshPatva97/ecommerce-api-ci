/**
 * DEC-12 — HTTP helpers for the scenarios (supertest against the REAL app of `world.ts`).
 *
 * Customers are signed in through the real session service (`issue` → refresh family in
 * `refresh_tokens` + EdDSA access token), so `authenticate('storefront')` runs its real
 * server-side session lookup. Responses are reduced to a small typed `ApiResult`; evidence lines
 * built from it carry statuses, error codes and generated ids only.
 */
import { randomUUID } from 'node:crypto';

import request from 'supertest';

import {
  signMockPaymentCallback,
  signMockPaymentWebhook,
} from '../../../src/integrations/payments/paymentProvider.js';
import type { RequestMeta } from '../../../src/modules/auth/auth.context.js';
import { createSessionService } from '../../../src/modules/auth/index.js';
import { STOREFRONT_ORIGIN, type DbWorld } from './world.js';

export const TEST_USER_AGENT = 'dec12-db-harness/1.0';
const API = '/api/v1';

export function requestMeta(userAgent: string = TEST_USER_AGENT): RequestMeta {
  const ip = '127.0.0.1';
  return { ip, userAgent, actor: { type: 'CUSTOMER', loginType: 'CUSTOMER', ip, userAgent } };
}

export interface CustomerSession {
  readonly userId: string;
  /** Refresh family id = session id (`sid`). */
  readonly familyId: string;
  readonly refreshToken: string;
  readonly accessToken: string;
  /** Authorization + X-Client + Origin + User-Agent for supertest `.set()`. */
  readonly headers: Readonly<Record<string, string>>;
}

/** Opens a real storefront session for a seeded customer (one `refresh_tokens` row). */
export async function signInCustomer(world: DbWorld, userId: string): Promise<CustomerSession> {
  const sessions = createSessionService(world.container);
  const issued = await sessions.issue(world.db, userId, 'storefront', requestMeta());
  return {
    userId,
    familyId: issued.familyId,
    refreshToken: issued.refreshToken,
    accessToken: issued.accessToken,
    headers: {
      Authorization: `Bearer ${issued.accessToken}`,
      'X-Client': 'storefront',
      Origin: STOREFRONT_ORIGIN,
      'User-Agent': TEST_USER_AGENT,
    },
  };
}

/** What a scenario needs from a response — never the raw body in evidence output. */
export interface ApiResult {
  readonly status: number;
  /** `Idempotent-Replayed: true` (stored response served by the idempotency middleware). */
  readonly replayed: boolean;
  /** `error.code` of the canonical error envelope, or null on success. */
  readonly code: string | null;
  /** `error.details[0].code`, when present. */
  readonly detailCode: string | null;
  /** `data` of the success envelope (callers narrow it with the readers below). */
  readonly data: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringAt(value: unknown, ...path: string[]): string | null {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return typeof current === 'string' ? current : null;
}

export function toApiResult(res: request.Response): ApiResult {
  const body: unknown = res.body;
  const error = isRecord(body) ? body.error : undefined;
  const details = isRecord(error) && Array.isArray(error.details) ? error.details : [];
  return {
    status: res.status,
    replayed: res.get('Idempotent-Replayed') === 'true',
    code: stringAt(error, 'code'),
    detailCode: stringAt(details[0], 'code'),
    data: isRecord(body) ? body.data : undefined,
  };
}

/** `201` / `409:INSUFFICIENT_STOCK` / `201:replayed` — the key used in tallies. */
export function outcomeLabel(result: ApiResult): string {
  if (result.code !== null) return `${String(result.status)}:${result.code}`;
  return result.replayed ? `${String(result.status)}:replayed` : String(result.status);
}

export function tallyResults(results: readonly ApiResult[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of results) {
    const key = outcomeLabel(r);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

// ── Checkout ──────────────────────────────────────────────────────────────────────────────────

export interface CheckoutSelection {
  readonly shippingAddressId: string;
  readonly shippingMethodId: string;
  readonly paymentMethod: 'ONLINE' | 'COD';
}

/** `POST /checkout/summary` → `quoteHash` (stateless quote; reserves nothing). */
export async function fetchQuoteHash(
  world: DbWorld,
  session: CustomerSession,
  selection: CheckoutSelection,
): Promise<string> {
  const res = await request(world.app)
    .post(`${API}/checkout/summary`)
    .set(session.headers)
    .send(selection);
  const result = toApiResult(res);
  const quoteHash = stringAt(result.data, 'quoteHash');
  if (result.status !== 200 || quoteHash === null) {
    throw new Error(`checkout summary failed: ${outcomeLabel(result)}`);
  }
  return quoteHash;
}

export interface PlaceOrderRequest extends CheckoutSelection {
  readonly quoteHash: string;
  readonly customerNote?: string;
}

/** `POST /checkout/orders` with an explicit Idempotency-Key. */
export async function placeOrder(
  world: DbWorld,
  session: CustomerSession,
  idempotencyKey: string,
  body: PlaceOrderRequest,
): Promise<ApiResult> {
  const res = await request(world.app)
    .post(`${API}/checkout/orders`)
    .set(session.headers)
    .set('Idempotency-Key', idempotencyKey)
    .send({ ...body, acceptTerms: true });
  return toApiResult(res);
}

export interface PlacedOrder {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly status: string;
  /** Null for COD and when the gateway session could not be opened. */
  readonly providerOrderId: string | null;
}

/** Reads the `201` body of `POST /checkout/orders`; null when the request did not succeed. */
export function readPlacedOrder(result: ApiResult): PlacedOrder | null {
  const orderId = stringAt(result.data, 'order', 'id');
  const orderNumber = stringAt(result.data, 'order', 'orderNumber');
  const status = stringAt(result.data, 'order', 'status');
  if (result.status !== 201 || orderId === null || orderNumber === null || status === null) {
    return null;
  }
  return {
    orderId,
    orderNumber,
    status,
    providerOrderId: stringAt(result.data, 'payment', 'providerOrderId'),
  };
}

// ── Payments ──────────────────────────────────────────────────────────────────────────────────

export interface PaymentRefs {
  readonly orderNumber: string;
  readonly providerOrderId: string;
  readonly providerPaymentId: string;
}

/** `POST /payments/verify` — the storefront callback, signed like the mock checkout widget. */
export async function verifyPayment(
  world: DbWorld,
  session: CustomerSession,
  refs: PaymentRefs,
): Promise<ApiResult> {
  const res = await request(world.app)
    .post(`${API}/payments/verify`)
    .set(session.headers)
    .set('Idempotency-Key', randomUUID())
    .send({
      orderNumber: refs.orderNumber,
      providerOrderId: refs.providerOrderId,
      providerPaymentId: refs.providerPaymentId,
      providerSignature: signMockPaymentCallback(refs.providerOrderId, refs.providerPaymentId),
    });
  return toApiResult(res);
}

/** `POST /webhooks/payments/mock` — `payment.captured`, raw body signed with the mock secret. */
export async function sendCaptureWebhook(
  world: DbWorld,
  event: {
    readonly eventId: string;
    readonly providerOrderId: string;
    readonly providerPaymentId: string;
    readonly amountMinor: number;
  },
): Promise<ApiResult> {
  const raw = JSON.stringify({
    eventId: event.eventId,
    event: 'payment.captured',
    providerOrderId: event.providerOrderId,
    providerPaymentId: event.providerPaymentId,
    amountMinor: event.amountMinor,
    currency: 'INR',
    method: 'upi',
  });
  const timestamp = Math.floor(world.container.clock().getTime() / 1000);
  const res = await request(world.app)
    .post(`${API}/webhooks/payments/mock`)
    .set('Content-Type', 'application/json')
    .set('x-mock-timestamp', String(timestamp))
    .set('x-mock-signature', signMockPaymentWebhook(raw, timestamp))
    .send(raw);
  return toApiResult(res);
}

/** Reads a string field of a success body (`data.<path>`), e.g. `paymentStatus`. */
export function dataString(result: ApiResult, ...path: string[]): string | null {
  return stringAt(result.data, ...path);
}

/** Reads a boolean field of a success body (`data.<key>`), e.g. `duplicate`. */
export function dataFlag(result: ApiResult, key: string): boolean {
  return isRecord(result.data) && result.data[key] === true;
}
