/**
 * Order cancellation effects (B6) — BACKEND_STRUCTURE.md §7 "Cancel order", OQ-12/OQ-15, R-16.
 * MOCKED DB (tests/helpers/mockDb.ts) with stubbed inventory/coupon services; no SQL is executed.
 */
import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { TxClient } from '../../../../src/core/db/transaction.js';
import { createLogger } from '../../../../src/core/logger/logger.js';
import { Decimal } from '../../../../src/lib/money.js';
import {
  canTransition,
  customerCancelMode,
  staffCanCancel,
} from '../../../../src/lib/orderStateMachine.js';
import { createAuditService } from '../../../../src/modules/audit/audit.service.js';
import type { CouponsService } from '../../../../src/modules/coupons/index.js';
import type { InventoryService } from '../../../../src/modules/inventory/index.js';
import { createNotificationService } from '../../../../src/modules/notifications/index.js';
import {
  cancelOrderInTx,
  customerActions,
  type LockedOrder,
} from '../../../../src/modules/orders/index.js';
import { createMockDb } from '../../../helpers/mockDb.js';
import { testConfig } from '../../../helpers/testApp.js';

const NOW = new Date('2026-11-19T06:30:00.000Z');
const ORDER_ID = randomUUID();

function lockedOrder(over: Partial<LockedOrder> = {}): LockedOrder {
  return {
    id: ORDER_ID,
    orderNumber: 'ORD-261119-00001',
    userId: randomUUID(),
    status: 'CONFIRMED',
    paymentMethod: 'ONLINE',
    paymentStatus: 'CAPTURED',
    grandTotal: new Decimal('2499.00'),
    couponCodeSnapshot: 'WELCOME10',
    customerPhoneSnapshot: null,
    user: { firstName: 'Riya', email: 'riya@example.com', phone: null },
    ...over,
  };
}

function setup() {
  const { db, m } = createMockDb();
  m.notification.findUnique.mockResolvedValue(null);
  m.invoiceRecord.findFirst.mockResolvedValue(null);
  m.order.findUnique.mockResolvedValue({
    id: ORDER_ID,
    status: 'CONFIRMED',
    paymentMethod: 'ONLINE',
    paymentStatus: 'CAPTURED',
    grandTotal: new Decimal('2499.00'),
    items: [
      {
        id: randomUUID(),
        quantity: 1,
        lineTotal: new Decimal('2400.00'),
        taxAmount: new Decimal('69.90'),
      },
    ],
    payments: [{ id: randomUUID(), amount: new Decimal('2499.00') }],
  });
  m.refund.findMany.mockResolvedValue([]);
  m.refund.findUnique.mockResolvedValue({
    id: 'r',
    status: 'APPROVED',
    method: 'ORIGINAL_PAYMENT_METHOD',
    amount: new Decimal('2499.00'),
    reasonCode: 'ORDER_CANCELLED',
    payment: { id: 'p', providerPaymentId: 'pay_1' },
  });
  const ledger = (type: string) => ({
    ledger: [
      {
        id: 'l',
        variantId: 'v',
        type,
        onHandDelta: 1,
        reservedDelta: 0,
        onHandBefore: 0,
        onHandAfter: 1,
        reservedAfter: 0,
      },
    ],
    lowStock: [],
  });
  const restore = vi.fn().mockResolvedValue(ledger('CANCELLATION_RESTORE'));
  const releaseStock = vi.fn().mockResolvedValue(ledger('RESERVATION_RELEASE'));
  const releaseCoupon = vi.fn().mockResolvedValue({
    status: 'RELEASED',
    changed: true,
    usageId: 'u',
    couponId: 'c',
  });
  const inventory = {
    restoreCancellation: restore,
    releaseReservation: releaseStock,
  } as unknown as InventoryService;
  const coupons = { release: releaseCoupon } as unknown as CouponsService;
  const deps = {
    audit: createAuditService(createLogger(testConfig()), () => NOW),
    inventory,
    coupons,
    notifications: createNotificationService({ clock: () => NOW }),
    storefrontUrl: 'https://shop.example',
  };
  return { tx: db as TxClient, m, deps, restore, releaseStock, releaseCoupon };
}

const baseArgs = {
  actor: { type: 'CUSTOMER' as const, userId: randomUUID() },
  now: NOW,
  reasonCode: 'CHANGED_MIND',
  restock: true,
  notifyCustomer: true,
  eventKey: 'orders.cancelled_by_customer',
};

describe('order state machine policy (OQ-12)', () => {
  it('customer: DIRECT in CONFIRMED, REQUEST in PROCESSING, nothing from PACKED', () => {
    expect(customerCancelMode('CONFIRMED')).toBe('DIRECT');
    expect(customerCancelMode('PROCESSING')).toBe('REQUEST');
    expect(customerCancelMode('PACKED')).toBe('NOT_ALLOWED');
    expect(customerActions('PROCESSING')).toEqual({
      canCancel: false,
      canRequestCancellation: true,
    });
    expect(staffCanCancel('PACKED')).toBe(true);
    expect(staffCanCancel('SHIPPED')).toBe(false);
    expect(canTransition('SHIPPED', 'CANCELLED')).toBe(false);
  });
});

describe('cancelOrderInTx', () => {
  it('self-cancel of a CONFIRMED prepaid order: restore stock, release coupon, auto-APPROVED refund', async () => {
    const { tx, m, deps, restore, releaseCoupon } = setup();
    const { result, gatewayJob } = await cancelOrderInTx(tx, deps, {
      ...baseArgs,
      order: lockedOrder(),
      refund: { initiate: true, autoApprove: true },
    });
    expect(restore).toHaveBeenCalledWith(tx, ORDER_ID, { actorUserId: null });
    // PROVISIONAL OQ-15: restored only for cancellations before shipment.
    expect(releaseCoupon).toHaveBeenCalledWith(tx, ORDER_ID, 'ORDER_CANCELLED_BEFORE_SHIPMENT');
    expect(result).toMatchObject({
      previousStatus: 'CONFIRMED',
      status: 'CANCELLED',
      stock: { restored: true, transactionType: 'CANCELLATION_RESTORE' },
      coupon: { code: 'WELCOME10', redemptionRestored: true },
      refund: { status: 'PROCESSING', amount: '2499.00', method: 'ORIGINAL_PAYMENT_METHOD' },
      creditNote: null,
    });
    expect(m.refund.create.mock.calls[0]?.[0].data).toMatchObject({
      status: 'APPROVED',
      requestedByType: 'CUSTOMER',
    });
    expect(gatewayJob).toMatchObject({ providerPaymentId: 'pay_1' });
    expect(m.order.update.mock.calls[0]?.[0].data).toMatchObject({ status: 'CANCELLED' });
    expect(m.orderStatusHistory.create.mock.calls[0]?.[0].data).toMatchObject({
      fromStatus: 'CONFIRMED',
      toStatus: 'CANCELLED',
    });
    const actions = m.auditLog.create.mock.calls.map((c): unknown => c[0].data.action);
    expect(actions).toEqual(['STATUS_CHANGE', 'REFUND_APPROVE']);
    const events = new Set(m.notification.create.mock.calls.map((c): unknown => c[0].data.event));
    expect(events).toEqual(new Set(['ORDER_CANCELLED', 'REFUND_INITIATED']));
  });

  it('staff cancel without restock only releases reservations; refund REQUESTED by SYSTEM', async () => {
    const { tx, m, deps, restore, releaseStock } = setup();
    const { result, gatewayJob } = await cancelOrderInTx(tx, deps, {
      ...baseArgs,
      actor: { type: 'STAFF', userId: randomUUID() },
      order: lockedOrder({ status: 'PACKED' }),
      restock: false,
      refund: { initiate: true, autoApprove: false },
      eventKey: 'orders.cancelled_by_staff',
    });
    expect(releaseStock).toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(result.refund?.status).toBe('REQUESTED');
    expect(m.refund.create.mock.calls[0]?.[0].data).toMatchObject({
      requestedByType: 'SYSTEM',
      requestedById: null,
    });
    expect(gatewayJob).toBeNull();
  });

  it('issues a credit note when the order is already invoiced', async () => {
    const { tx, m, deps } = setup();
    m.invoiceRecord.findFirst.mockReset();
    m.invoiceRecord.findFirst
      .mockResolvedValueOnce({
        id: 'inv',
        sellerGstin: null,
        sellerStateCode: '27',
        buyerGstin: null,
        placeOfSupplyStateCode: '27',
        supplyType: 'INTRA_STATE',
        taxTransactions: [
          {
            orderItemId: 'i',
            lineType: 'ITEM',
            component: 'CGST',
            hsnCode: '7113',
            rate: '3',
            taxableValue: '2330.10',
            amount: '34.95',
          },
          {
            orderItemId: 'i',
            lineType: 'ITEM',
            component: 'SGST',
            hsnCode: '7113',
            rate: '3',
            taxableValue: '2330.10',
            amount: '34.95',
          },
        ],
      })
      .mockResolvedValueOnce(null);
    m.invoiceRecord.findMany.mockResolvedValue([]);
    const { result } = await cancelOrderInTx(tx, deps, {
      ...baseArgs,
      order: lockedOrder({ paymentMethod: 'COD', paymentStatus: 'PENDING' }),
      refund: { initiate: true, autoApprove: true },
    });
    expect(result.refund).toBeNull();
    expect(result.creditNote).toEqual({ invoiceNumber: 'CN/2627/000001' });
  });

  it('refuses statuses without a CANCELLED edge', async () => {
    const { tx, deps } = setup();
    await expect(
      cancelOrderInTx(tx, deps, {
        ...baseArgs,
        order: lockedOrder({ status: 'SHIPPED' }),
        refund: { initiate: true, autoApprove: false },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });
});
