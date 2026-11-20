/**
 * Shipping provider adapter — BACKEND_STRUCTURE.md §15 (`ShippingProvider` interface), §16 (webhook
 * verification). Courier / aggregator is still open (OQ-07): only the MOCK adapter exists
 * (`SHIPPING_PROVIDER=mock`). No network calls are made.
 *
 * ## Mock webhook signature (documented test contract)
 *
 *   POST /api/v1/webhooks/shipping/mock
 *   X-Mock-Timestamp: <unix seconds>
 *   X-Mock-Signature: sha256=<hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)>
 *   { "eventId": "evt_1", "awb": "MOCK0000000001", "status": "in_transit",
 *     "occurredAt": "2026-11-19T06:00:00.000Z", "location": "Pune Hub", "message": "…" }
 *
 * - The secret is `MOCK_SHIPPING_WEBHOOK_TEST_SECRET` (public test value — the mock route is refused
 *   in production; a real adapter reads `SHIPPING_WEBHOOK_SECRET`, BACKEND_STRUCTURE §16).
 * - The timestamp must be within ±5 minutes (replay protection); the comparison is constant-time
 *   (`crypto.timingSafeEqual`) and happens on the raw bytes BEFORE any JSON parsing.
 * - `status` values: picked_up, in_transit, out_for_delivery, delivered, delivery_failed,
 *   rto_initiated, rto_delivered, cancelled (anything else is acknowledged and ignored).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import type { ShipmentStatus } from '../../generated/prisma/enums.js';

export interface ServiceabilityResult {
  readonly serviceable: boolean;
  readonly city: string | null;
  readonly stateCode: string | null;
  readonly codAvailable: boolean;
  readonly estimatedDays: { readonly min: number; readonly max: number } | null;
}

export interface CreateProviderShipmentInput {
  readonly reference: string;
  readonly pincode: string;
  readonly weightGrams: number;
  readonly dimensionsCm?:
    { readonly l: number; readonly w: number; readonly h: number } | undefined;
  /** COD amount to collect (decimal string), when the order is COD. */
  readonly codAmount?: string | undefined;
}

export interface CreateProviderShipmentResult {
  readonly courier: string;
  readonly awb: string;
  readonly labelUrl: string | null;
}

export interface ShippingWebhookEvent {
  readonly eventId: string;
  readonly awb: string;
  readonly providerStatus: string;
  /** `null` when the provider status has no mapping (acknowledged, not applied). */
  readonly mappedStatus: ShipmentStatus | null;
  readonly occurredAt: Date;
  readonly location: string | null;
  readonly message: string | null;
}

export type WebhookHeaders = Readonly<Record<string, string | string[] | undefined>>;

export class WebhookSignatureError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'WebhookSignatureError';
  }
}

export class WebhookPayloadError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'WebhookPayloadError';
  }
}

export interface ShippingProviderAdapter {
  readonly name: string;
  checkServiceability(pincode: string): Promise<ServiceabilityResult>;
  createShipment(input: CreateProviderShipmentInput): Promise<CreateProviderShipmentResult>;
  cancelShipment(awb: string): Promise<void>;
  /** Public courier tracking page (no PII), or null. */
  trackingUrl(awb: string): string | null;
  /** Throws `WebhookSignatureError`; must be called before `parseWebhook`. */
  verifyWebhook(rawBody: Buffer, headers: WebhookHeaders, now: Date): void;
  /** Throws `WebhookPayloadError` on malformed (but correctly signed) payloads. */
  parseWebhook(rawBody: Buffer): ShippingWebhookEvent[];
  /**
   * OPTIONAL: implemented ONLY by couriers without tracking webhooks (BACKEND_STRUCTURE §14
   * `shipment-tracking-poll`, OQ-07). A server-to-server tracking fetch, normalised to the webhook
   * event shape (`eventId` must be stable across polls so events dedupe). The poll job ignores
   * adapters that do not implement it.
   */
  readonly getTracking?: (awb: string) => Promise<readonly ShippingWebhookEvent[]>;
}

/** Tracking event as the mock "courier" reports it (`simulateTracking`). */
export interface MockTrackingEvent {
  readonly eventId: string;
  readonly status: string;
  readonly occurredAt: string;
  readonly location?: string;
  readonly message?: string;
}

export const MOCK_SHIPPING_WEBHOOK_TEST_SECRET = 'mock-shipping-webhook-test-secret';
export const WEBHOOK_TOLERANCE_SECONDS = 300;

const MOCK_STATUS_MAP: Readonly<Record<string, ShipmentStatus>> = {
  picked_up: 'SHIPPED',
  in_transit: 'IN_TRANSIT',
  out_for_delivery: 'OUT_FOR_DELIVERY',
  delivered: 'DELIVERED',
  delivery_failed: 'DELIVERY_FAILED',
  rto_initiated: 'RTO_INITIATED',
  rto_delivered: 'RTO_DELIVERED',
  cancelled: 'CANCELLED',
};

/** First two pincode digits → GST state code (illustrative subset for the mock). */
const PINCODE_STATE: Readonly<Record<string, string>> = {
  '11': '07',
  '12': '06',
  '13': '06',
  '14': '03',
  '15': '03',
  '30': '08',
  '31': '08',
  '38': '24',
  '39': '24',
  '40': '27',
  '41': '27',
  '42': '27',
  '43': '27',
  '44': '27',
  '50': '36',
  '56': '29',
  '57': '29',
  '60': '33',
  '61': '33',
  '67': '32',
  '68': '32',
  '70': '19',
  '71': '19',
};
const METRO_PREFIXES = new Set(['11', '40', '41', '50', '56', '60', '70']);

export function signMockShippingWebhook(
  rawBody: Buffer | string,
  timestamp: number,
  secret: string = MOCK_SHIPPING_WEBHOOK_TEST_SECRET,
): string {
  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  return `sha256=${createHmac('sha256', secret)
    .update(`${String(timestamp)}.${body}`)
    .digest('hex')}`;
}

function header(headers: WebhookHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function str(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null;
}

export interface MockShippingProviderOptions {
  readonly secret?: string;
  /** Pincodes reported as not serviceable (in addition to the `9xxxxx` APS range). */
  readonly unserviceable?: readonly string[];
  /** Simulate an outage of the serviceability API. */
  readonly failServiceability?: boolean;
  /**
   * Behave like a courier WITHOUT webhooks: expose `getTracking` (events from `simulateTracking`).
   * Off by default — the default mock pushes tracking by webhook and is never polled.
   */
  readonly pollTracking?: boolean;
}

export class MockShippingProviderAdapter implements ShippingProviderAdapter {
  readonly name = 'mock';
  private counter = 0;
  readonly cancelled: string[] = [];
  private readonly secret: string;
  private readonly unserviceable: ReadonlySet<string>;
  private readonly tracking = new Map<string, MockTrackingEvent[]>();
  readonly getTracking?: (awb: string) => Promise<readonly ShippingWebhookEvent[]>;

  constructor(private readonly options: MockShippingProviderOptions = {}) {
    this.secret = options.secret ?? MOCK_SHIPPING_WEBHOOK_TEST_SECRET;
    this.unserviceable = new Set(options.unserviceable ?? []);
    if (options.pollTracking === true) {
      this.getTracking = async (awb) => {
        await Promise.resolve();
        return (this.tracking.get(awb.toUpperCase()) ?? []).map((e) => ({
          eventId: e.eventId,
          awb: awb.toUpperCase(),
          providerStatus: e.status,
          mappedStatus: MOCK_STATUS_MAP[e.status.toLowerCase()] ?? null,
          occurredAt: new Date(e.occurredAt),
          location: e.location ?? null,
          message: e.message ?? null,
        }));
      };
    }
  }

  /** Test hook: tracking history the "courier" reports for an AWB (`getTracking`). */
  simulateTracking(awb: string, events: readonly MockTrackingEvent[]): void {
    this.tracking.set(awb.toUpperCase(), [...events]);
  }

  async checkServiceability(pincode: string): Promise<ServiceabilityResult> {
    await Promise.resolve();
    if (this.options.failServiceability === true) throw new Error('Mock serviceability outage.');
    const prefix = pincode.slice(0, 2);
    const serviceable = !pincode.startsWith('9') && !this.unserviceable.has(pincode);
    if (!serviceable) {
      return {
        serviceable: false,
        city: null,
        stateCode: null,
        codAvailable: false,
        estimatedDays: null,
      };
    }
    const metro = METRO_PREFIXES.has(prefix);
    return {
      serviceable: true,
      city: null,
      stateCode: PINCODE_STATE[prefix] ?? null,
      codAvailable: true,
      estimatedDays: metro ? { min: 2, max: 4 } : { min: 3, max: 7 },
    };
  }

  async createShipment(_input: CreateProviderShipmentInput): Promise<CreateProviderShipmentResult> {
    await Promise.resolve();
    this.counter += 1;
    return {
      courier: 'MockExpress',
      awb: `MOCK${String(this.counter).padStart(10, '0')}`,
      labelUrl: null,
    };
  }

  async cancelShipment(awb: string): Promise<void> {
    await Promise.resolve();
    this.cancelled.push(awb);
  }

  trackingUrl(awb: string): string | null {
    return `https://tracking.example.com/mock/${encodeURIComponent(awb)}`;
  }

  verifyWebhook(rawBody: Buffer, headers: WebhookHeaders, now: Date): void {
    const timestamp = header(headers, 'x-mock-timestamp');
    const signature = header(headers, 'x-mock-signature');
    if (timestamp === undefined || signature === undefined) {
      throw new WebhookSignatureError('missing signature headers');
    }
    if (!/^\d{1,12}$/.test(timestamp)) throw new WebhookSignatureError('bad timestamp');
    const ts = Number(timestamp);
    if (Math.abs(now.getTime() / 1000 - ts) > WEBHOOK_TOLERANCE_SECONDS) {
      throw new WebhookSignatureError('timestamp outside tolerance');
    }
    const expected = Buffer.from(signMockShippingWebhook(rawBody, ts, this.secret), 'utf8');
    const given = Buffer.from(signature, 'utf8');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new WebhookSignatureError('signature mismatch');
    }
  }

  parseWebhook(rawBody: Buffer): ShippingWebhookEvent[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new WebhookPayloadError('invalid JSON');
    }
    const list: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    if (list.length === 0 || list.length > 100) throw new WebhookPayloadError('bad event count');
    return list.map((item) => {
      if (typeof item !== 'object' || item === null) throw new WebhookPayloadError('bad event');
      const e = item as Record<string, unknown>;
      const eventId = str(e.eventId, 100);
      const awb = str(e.awb, 100);
      const status = str(e.status, 100);
      const occurredAt = typeof e.occurredAt === 'string' ? new Date(e.occurredAt) : undefined;
      if (
        eventId === null ||
        awb === null ||
        status === null ||
        occurredAt === undefined ||
        Number.isNaN(occurredAt.getTime())
      ) {
        throw new WebhookPayloadError('missing fields');
      }
      return {
        eventId,
        awb,
        providerStatus: status,
        mappedStatus: MOCK_STATUS_MAP[status.toLowerCase()] ?? null,
        occurredAt,
        location: str(e.location, 200),
        message: str(e.message, 500),
      };
    });
  }
}

export type ShippingProviderRegistry = ReadonlyMap<string, ShippingProviderAdapter>;

/** Adapters selectable by `:provider` (lower-case key). Only the mock exists (OQ-07). */
export function createShippingProviderRegistry(
  adapters: readonly ShippingProviderAdapter[] = [new MockShippingProviderAdapter()],
): ShippingProviderRegistry {
  return new Map(adapters.map((a) => [a.name, a]));
}
