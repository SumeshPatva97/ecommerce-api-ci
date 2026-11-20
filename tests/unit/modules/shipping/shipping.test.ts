/**
 * Shipping — rate rules (OQ-07, PROVISIONAL), shipment/order state rules, item planning, mock
 * provider signature verification, and the narrow order transition. MOCKED DB.
 */
import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  MockShippingProviderAdapter,
  WebhookPayloadError,
  WebhookSignatureError,
  signMockShippingWebhook,
} from '../../../../src/integrations/shipping/shippingProvider.js';
import { createAuditService } from '../../../../src/modules/audit/audit.service.js';
import { createNotificationService } from '../../../../src/modules/notifications/index.js';
import {
  advanceOrderForShipment,
  canTransitionShipment,
  computeShippingCharge,
  orderPathTo,
  orderTargetFor,
  planShipmentItems,
  toQuoteDto,
} from '../../../../src/modules/shipping/index.js';
import { createMockDb } from '../../../helpers/mockDb.js';

const NOW = new Date('2026-11-19T06:30:00.000Z');
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('computeShippingCharge (PROVISIONAL OQ-07)', () => {
  const standard = {
    rateType: 'FLAT' as const,
    baseCharge: '99.00',
    freeAboveAmount: '4999.00',
    codSupported: true,
    codCharge: '49.00',
  };

  it('charges the flat rate below the threshold and is free at/above it', () => {
    const below = computeShippingCharge(standard, { cartValue: '4998.99' });
    expect(toQuoteDto(below)).toEqual({
      charge: '99.00',
      discount: '0.00',
      payable: '99.00',
      isFree: false,
      freeAbove: '4999.00',
      amountToFreeShipping: '0.01',
    });
    const at = computeShippingCharge(standard, { cartValue: '4999' });
    expect(toQuoteDto(at)).toMatchObject({
      charge: '99.00',
      discount: '99.00',
      payable: '0.00',
      isFree: true,
    });
  });

  it('uses the global threshold only for FREE_ABOVE methods without their own', () => {
    const freeAbove = { ...standard, rateType: 'FREE_ABOVE' as const, freeAboveAmount: null };
    expect(
      computeShippingCharge(freeAbove, { cartValue: '1000', globalFreeShippingThreshold: '999.00' })
        .isFree,
    ).toBe(true);
    const flatNoThreshold = { ...standard, freeAboveAmount: null };
    expect(
      computeShippingCharge(flatNoThreshold, {
        cartValue: '100000',
        globalFreeShippingThreshold: '999.00',
      }).isFree,
    ).toBe(false);
  });

  it('adds the COD fee only for COD on COD-capable methods', () => {
    expect(
      computeShippingCharge(standard, { cartValue: 10, paymentMethod: 'COD' }).codCharge.toFixed(2),
    ).toBe('49.00');
    const noCod = { ...standard, codSupported: false };
    const quote = computeShippingCharge(noCod, { cartValue: 10, paymentMethod: 'COD' });
    expect(quote.codAllowed).toBe(false);
    expect(quote.codCharge.toFixed(2)).toBe('0.00');
    expect(() => computeShippingCharge(standard, { cartValue: -1 })).toThrow(RangeError);
  });
});

describe('shipment & order state rules', () => {
  it('follows the shipment flow', () => {
    expect(canTransitionShipment('PENDING', 'READY_TO_SHIP')).toBe(true);
    expect(canTransitionShipment('READY_TO_SHIP', 'SHIPPED')).toBe(true);
    expect(canTransitionShipment('SHIPPED', 'CANCELLED')).toBe(false);
    expect(canTransitionShipment('DELIVERED', 'IN_TRANSIT')).toBe(false);
    expect(canTransitionShipment('RTO_INITIATED', 'RTO_DELIVERED')).toBe(true);
  });

  it('maps shipment statuses onto canonical order edges only', () => {
    expect(orderTargetFor('IN_TRANSIT')).toBe('SHIPPED');
    expect(orderTargetFor('DELIVERY_FAILED')).toBeUndefined();
    expect(orderPathTo('PACKED', 'SHIPPED')).toEqual(['SHIPPED']);
    expect(orderPathTo('SHIPPED', 'DELIVERED')).toEqual(['OUT_FOR_DELIVERY', 'DELIVERED']);
    expect(orderPathTo('DELIVERED', 'SHIPPED')).toEqual([]);
    expect(orderPathTo('CANCELLED', 'SHIPPED')).toBeNull();
    expect(orderPathTo('CONFIRMED', 'SHIPPED')).toBeNull();
  });
});

describe('planShipmentItems', () => {
  const a = randomUUID();
  const b = randomUUID();
  const order = {
    items: [
      { id: a, quantity: 3, quantityCancelled: 0 },
      { id: b, quantity: 1, quantityCancelled: 1 },
    ],
    shipments: [
      { status: 'SHIPPED' as const, items: [{ orderItemId: a, quantity: 1 }] },
      { status: 'CANCELLED' as const, items: [{ orderItemId: a, quantity: 2 }] },
    ],
  };

  it('defaults to every unshipped unit (cancelled shipments release allocation)', () => {
    expect(planShipmentItems(order, undefined)).toEqual([{ orderItemId: a, quantity: 2 }]);
  });

  it('rejects over-allocation, foreign and duplicate lines', () => {
    expect(() => planShipmentItems(order, [{ orderItemId: a, quantity: 3 }])).toThrow(
      /left to ship/,
    );
    expect(() => planShipmentItems(order, [{ orderItemId: randomUUID(), quantity: 1 }])).toThrow(
      /does not belong/,
    );
    expect(() =>
      planShipmentItems(order, [
        { orderItemId: a, quantity: 1 },
        { orderItemId: a, quantity: 1 },
      ]),
    ).toThrow(/twice/);
  });

  it('409 NOTHING_TO_SHIP when everything is allocated', () => {
    const full = {
      ...order,
      shipments: [{ status: 'PENDING' as const, items: [{ orderItemId: a, quantity: 3 }] }],
    };
    expect(() => planShipmentItems(full, undefined)).toThrow(/already in a shipment/);
  });
});

describe('mock shipping provider webhook signature', () => {
  const provider = new MockShippingProviderAdapter();
  const body = Buffer.from(
    JSON.stringify({
      eventId: 'evt_1',
      awb: 'MOCK0000000001',
      status: 'out_for_delivery',
      occurredAt: NOW.toISOString(),
    }),
  );
  const ts = Math.floor(NOW.getTime() / 1000);

  it('accepts a correct HMAC-SHA256 signature within tolerance', () => {
    const headers = {
      'x-mock-timestamp': String(ts),
      'x-mock-signature': signMockShippingWebhook(body, ts),
    };
    expect(() => {
      provider.verifyWebhook(body, headers, NOW);
    }).not.toThrow();
    expect(provider.parseWebhook(body)[0]).toMatchObject({
      eventId: 'evt_1',
      mappedStatus: 'OUT_FOR_DELIVERY',
      providerStatus: 'out_for_delivery',
    });
  });

  it('rejects tampered bodies, wrong secrets, stale timestamps and missing headers', () => {
    const good = signMockShippingWebhook(body, ts);
    const tampered = Buffer.from(body.toString().replace('out_for_delivery', 'delivered'));
    const cases: [Buffer, Record<string, string>, Date][] = [
      [tampered, { 'x-mock-timestamp': String(ts), 'x-mock-signature': good }, NOW],
      [
        body,
        {
          'x-mock-timestamp': String(ts),
          'x-mock-signature': signMockShippingWebhook(body, ts, 'other'),
        },
        NOW,
      ],
      [
        body,
        { 'x-mock-timestamp': String(ts), 'x-mock-signature': good },
        new Date(NOW.getTime() + 301_000),
      ],
      [body, { 'x-mock-signature': good }, NOW],
      [body, { 'x-mock-timestamp': String(ts), 'x-mock-signature': 'sha256=00' }, NOW],
    ];
    for (const [raw, headers, now] of cases) {
      expect(() => {
        provider.verifyWebhook(raw, headers, now);
      }).toThrow(WebhookSignatureError);
    }
  });

  it('rejects malformed payloads and leaves unknown statuses unmapped', () => {
    expect(() => provider.parseWebhook(Buffer.from('{nope'))).toThrow(WebhookPayloadError);
    expect(() => provider.parseWebhook(Buffer.from('{"eventId":"e"}'))).toThrow(
      WebhookPayloadError,
    );
    const unknown = Buffer.from(
      JSON.stringify({ eventId: 'e', awb: 'A1', status: 'weird', occurredAt: NOW.toISOString() }),
    );
    expect(provider.parseWebhook(unknown)[0]?.mappedStatus).toBeNull();
  });

  it('reports serviceability (APS 9xxxxx not serviceable) and simulated outages', async () => {
    await expect(provider.checkServiceability('411045')).resolves.toMatchObject({
      serviceable: true,
      stateCode: '27',
      estimatedDays: { min: 2, max: 4 },
    });
    await expect(provider.checkServiceability('999999')).resolves.toMatchObject({
      serviceable: false,
    });
    await expect(
      new MockShippingProviderAdapter({ failServiceability: true }).checkServiceability('411045'),
    ).rejects.toThrow();
  });
});

describe('advanceOrderForShipment (narrow order transition)', () => {
  function setup(order: Record<string, unknown>) {
    const { db, m } = createMockDb();
    m.order.findUnique.mockResolvedValue({
      id: randomUUID(),
      orderNumber: 'ORD-261119-00001',
      userId: randomUUID(),
      grandTotal: '2499.00',
      paymentMethod: 'ONLINE',
      shippedAt: null,
      customerEmailSnapshot: 'riya@example.com',
      customerPhoneSnapshot: null,
      user: { firstName: 'Riya', email: 'riya@example.com', phone: '+919812345678' },
      items: [{ quantity: 1, quantityShipped: 1, quantityCancelled: 0 }],
      shipments: [{ status: 'DELIVERED' }],
      ...order,
    });
    m.notification.findUnique.mockResolvedValue(null);
    const deps = {
      audit: createAuditService(logger as never, () => NOW),
      notifications: createNotificationService({ clock: () => NOW }),
      storefrontUrl: 'https://www.example.com',
    };
    const actor = { type: 'WEBHOOK' as const, loginType: 'WEBHOOK' as const };
    const run = (shipmentStatus: 'SHIPPED' | 'DELIVERED' | 'OUT_FOR_DELIVERY' | 'RTO_INITIATED') =>
      advanceOrderForShipment(db, deps, {
        orderId: randomUUID(),
        shipmentStatus,
        actor,
        now: NOW,
      });
    return { m, run };
  }

  it('walks SHIPPED → OUT_FOR_DELIVERY → DELIVERED with history + audit per edge and notifies', async () => {
    const { m, run } = setup({ status: 'SHIPPED' });
    const result = await run('DELIVERED');
    expect(result).toEqual({
      from: 'SHIPPED',
      to: 'DELIVERED',
      steps: ['OUT_FOR_DELIVERY', 'DELIVERED'],
    });
    expect(m.$queryRaw).toHaveBeenCalledTimes(1);
    const history = m.orderStatusHistory.create.mock.calls.map((c): unknown[] => [
      c[0].data.fromStatus,
      c[0].data.toStatus,
    ]);
    expect(history).toEqual([
      ['SHIPPED', 'OUT_FOR_DELIVERY'],
      ['OUT_FOR_DELIVERY', 'DELIVERED'],
    ]);
    expect(m.auditLog.create).toHaveBeenCalledTimes(2);
    expect(m.order.update.mock.calls[0]?.[0].data).toMatchObject({
      status: 'DELIVERED',
      deliveredAt: NOW,
    });
    const events = m.notification.create.mock.calls.map((c): unknown[] => [
      c[0].data.event,
      c[0].data.channel,
    ]);
    expect(events).toEqual([
      ['ORDER_DELIVERED', 'EMAIL'],
      ['ORDER_DELIVERED', 'WHATSAPP'],
    ]);
  });

  it('moves PACKED → SHIPPED and stamps shipped_at', async () => {
    const { m, run } = setup({ status: 'PACKED' });
    expect((await run('SHIPPED')).steps).toEqual(['SHIPPED']);
    expect(m.order.update.mock.calls[0]?.[0].data).toEqual({ status: 'SHIPPED', shippedAt: NOW });
    expect(m.notification.create).not.toHaveBeenCalled();
  });

  it('waits for every shipment before DELIVERED and ignores off-path/beyond states', async () => {
    const split = setup({
      status: 'SHIPPED',
      shipments: [{ status: 'DELIVERED' }, { status: 'IN_TRANSIT' }],
    });
    expect(await split.run('DELIVERED')).toMatchObject({
      skipped: 'NOT_ALL_DELIVERED',
      to: 'SHIPPED',
    });
    expect(split.m.order.update).not.toHaveBeenCalled();

    const cancelled = setup({ status: 'CANCELLED' });
    expect(await cancelled.run('SHIPPED')).toMatchObject({ skipped: 'OFF_PATH' });
    const beyond = setup({ status: 'DELIVERED' });
    expect(await beyond.run('SHIPPED')).toMatchObject({ skipped: 'ALREADY_BEYOND' });
    const rto = setup({ status: 'SHIPPED' });
    expect(await rto.run('RTO_INITIATED')).toMatchObject({ skipped: 'NO_ORDER_EFFECT' });
  });
});
