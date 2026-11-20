/**
 * shipment-tracking-poll job. MOCKED DB; mock courier (no network); no SQL runs.
 */
import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  MockShippingProviderAdapter,
  createShippingProviderRegistry,
} from '../../../src/integrations/shipping/shippingProvider.js';
import { runShipmentTrackingPoll } from '../../../src/jobs/shipmentTrackingPoll.js';
import { dedupeHash } from '../../../src/modules/shipping/shipping.shipments.js';
import { buildModuleTestApp } from '../../helpers/container.js';

const NOW = new Date('2026-11-20T06:30:00.000Z');
const ORDER_ID = randomUUID();

function core(id: string, awb: string) {
  return {
    id,
    shipmentNumber: 'SHP-261120-00001',
    orderId: ORDER_ID,
    status: 'IN_TRANSIT',
    provider: 'mock:MockExpress',
    awbNumber: awb,
    shippedAt: NOW,
    deliveredAt: null,
    items: [{ orderItemId: randomUUID(), quantity: 1 }],
    order: {
      id: ORDER_ID,
      orderNumber: 'ORD-261120-00001',
      userId: randomUUID(),
      grandTotal: '2499.00',
      paymentMethod: 'ONLINE',
      customerPhoneSnapshot: null,
      user: { firstName: 'Riya', email: 'riya@example.com', phone: '+919812345678' },
    },
  };
}

function setup(adapter = new MockShippingProviderAdapter({ pollTracking: true })) {
  const t = buildModuleTestApp([], {
    now: NOW,
    overrides: { providers: { shipping: createShippingProviderRegistry([adapter]) } },
  });
  const shipments = [core('s-1', 'MOCK0000000001'), core('s-2', 'MOCK0000000002')];
  t.m.shipment.findMany.mockResolvedValue(
    shipments.map((s) => ({ id: s.id, awbNumber: s.awbNumber })),
  );
  t.m.shipment.findFirst.mockImplementation((args: { where: { awbNumber: string } }) =>
    Promise.resolve(shipments.find((s) => s.awbNumber === args.where.awbNumber) ?? null),
  );
  t.m.shipment.findUnique.mockImplementation((args: { where: { id: string } }) =>
    Promise.resolve(shipments.find((s) => s.id === args.where.id) ?? null),
  );
  t.m.shipmentTrackingEvent.findUnique.mockResolvedValue(null);
  t.m.shipmentTrackingEvent.findFirst.mockResolvedValue(null);
  t.m.order.findUnique.mockResolvedValue({
    id: ORDER_ID,
    orderNumber: 'ORD-261120-00001',
    status: 'SHIPPED',
    userId: randomUUID(),
    grandTotal: '2499.00',
    paymentMethod: 'ONLINE',
    shippedAt: NOW,
    customerEmailSnapshot: 'riya@example.com',
    customerPhoneSnapshot: null,
    user: { firstName: 'Riya', email: 'riya@example.com', phone: '+919812345678' },
    items: [{ quantity: 1, quantityShipped: 1, quantityCancelled: 0 }],
    shipments: [{ status: 'IN_TRANSIT' }],
  });
  t.m.auditLog.create.mockResolvedValue({});
  t.m.notification.findUnique.mockResolvedValue(null);
  adapter.simulateTracking('MOCK0000000001', [
    { eventId: 'trk_1', status: 'in_transit', occurredAt: '2026-11-20T03:00:00.000Z' },
    {
      eventId: 'trk_2',
      status: 'out_for_delivery',
      occurredAt: '2026-11-20T05:00:00.000Z',
      location: 'Pune Hub',
    },
  ]);
  return { t, adapter };
}

describe('runShipmentTrackingPoll', () => {
  it('is a no-op for couriers that push tracking by webhook (default mock)', async () => {
    const { t } = setup(new MockShippingProviderAdapter());
    t.m.shipment.findMany.mockClear();
    const summary = await runShipmentTrackingPoll(t.container);
    expect(summary).toEqual({
      adapters: 0,
      shipments: 0,
      events: 0,
      duplicates: 0,
      statusChanges: 0,
      errors: 0,
      nextCursor: {},
    });
    expect(t.m.shipment.findMany).not.toHaveBeenCalled();
  });

  it('D4: rotates through in-flight shipments with a per-courier cursor', async () => {
    const { t } = setup();
    const page1 = await runShipmentTrackingPoll(t.container, { limit: 2 });
    expect(page1.nextCursor).toEqual({ mock: 's-2' });
    expect(t.m.shipment.findMany.mock.calls[0]?.[0]).toMatchObject({
      orderBy: { id: 'asc' },
      take: 2,
    });
    expect(t.m.shipment.findMany.mock.calls[0]?.[0].where.id).toBeUndefined();

    t.m.shipment.findMany.mockResolvedValueOnce([]);
    const page2 = await runShipmentTrackingPoll(t.container, { limit: 2, after: page1.nextCursor });
    expect(t.m.shipment.findMany.mock.calls[1]?.[0].where.id).toEqual({ gt: 's-2' });
    expect(page2.nextCursor).toEqual({}); // short page → next run starts over
  });

  it('records polled events like a webhook (source SYSTEM, same dedupe hash) and advances status', async () => {
    const { t } = setup();
    const summary = await runShipmentTrackingPoll(t.container);
    expect(summary).toMatchObject({
      adapters: 1,
      shipments: 2,
      events: 2,
      statusChanges: 1,
      errors: 0,
    });
    expect(t.m.shipment.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: {
        status: {
          in: ['SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERY_FAILED', 'RTO_INITIATED'],
        },
        awbNumber: { not: null },
        provider: { startsWith: 'mock:' },
      },
      take: 200,
    });
    const created = t.m.shipmentTrackingEvent.create.mock.calls.map(
      (c) => (c[0] as { data: { mappedStatus: string; source: string; dedupeHash: string } }).data,
    );
    expect(created.map((e) => [e.mappedStatus, e.source])).toEqual([
      ['IN_TRANSIT', 'SYSTEM'],
      ['OUT_FOR_DELIVERY', 'SYSTEM'],
    ]);
    expect(created[1]?.dedupeHash).toBe(dedupeHash('mock', 'trk_2'));
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data).toMatchObject({ actorType: 'SYSTEM' });
  });

  it('is idempotent: re-polling already recorded events creates nothing', async () => {
    const { t } = setup();
    t.m.shipmentTrackingEvent.findUnique.mockResolvedValue({ id: 'already' });
    const summary = await runShipmentTrackingPoll(t.container);
    expect(summary).toMatchObject({ events: 0, duplicates: 2, statusChanges: 0 });
    expect(t.m.shipmentTrackingEvent.create).not.toHaveBeenCalled();
  });

  it('isolates a courier error to one shipment', async () => {
    const adapter = new MockShippingProviderAdapter({ pollTracking: true });
    const { t } = setup(adapter);
    adapter.simulateTracking('MOCK0000000002', [
      { eventId: 'trk_9', status: 'delivered', occurredAt: '2026-11-20T06:00:00.000Z' },
    ]);
    const spy = vi.spyOn(adapter, 'getTracking' as never) as unknown as {
      mockRejectedValueOnce(e: Error): unknown;
    };
    spy.mockRejectedValueOnce(new Error('courier 503'));
    const summary = await runShipmentTrackingPoll(t.container);
    expect(summary).toMatchObject({ shipments: 2, errors: 1, events: 1 });
    expect(t.m.shipmentTrackingEvent.create.mock.calls[0]?.[0].data).toMatchObject({
      mappedStatus: 'DELIVERED',
    });
  });

  it('WP-O2: stops between shipments when the stop signal is raised (the current one finishes)', async () => {
    const adapter = new MockShippingProviderAdapter({ pollTracking: true });
    const { t } = setup(adapter);
    const controller = new AbortController();
    const getTracking = adapter.getTracking;
    if (getTracking === undefined) throw new Error('polling adapter expected');
    const spy = vi.spyOn(adapter, 'getTracking' as never) as unknown as {
      mockImplementation(fn: (awb: string) => Promise<unknown>): unknown;
    };
    spy.mockImplementation((awb: string) => {
      controller.abort(); // shutdown requested while the first shipment is being polled
      return getTracking(awb);
    });
    const summary = await runShipmentTrackingPoll(t.container, { signal: controller.signal });
    expect(summary).toMatchObject({ shipments: 1, events: 2, errors: 0 });
  });
});
