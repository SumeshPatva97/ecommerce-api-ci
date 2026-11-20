/**
 * Refund primitives (B6) — API_DOCUMENTATION.md §4.11, ADMIN_WORKFLOWS.md §11.
 * MOCKED DB (tests/helpers/mockDb.ts): amounts, validation codes, roll-ups and the post-commit
 * gateway step; no SQL is executed.
 */
import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { TxClient } from '../../../../src/core/db/transaction.js';
import { createLogger } from '../../../../src/core/logger/logger.js';
import { MockPaymentProviderAdapter } from '../../../../src/integrations/payments/paymentProvider.js';
import { Decimal } from '../../../../src/lib/money.js';
import { createNotificationService } from '../../../../src/modules/notifications/index.js';
import {
  createRefundForOrder,
  executeGatewayRefund,
  markRefundCompleted,
  prepareGatewayRefund,
} from '../../../../src/modules/refunds/index.js';
import { createMockDb, type MockModels } from '../../../helpers/mockDb.js';
import { testConfig } from '../../../helpers/testApp.js';

const NOW = new Date('2026-11-19T06:30:00.000Z');
const ORDER_ID = randomUUID();
const PAYMENT_ID = randomUUID();
const L1 = randomUUID();
const L2 = randomUUID();

function order(over: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    status: 'DELIVERED',
    paymentMethod: 'ONLINE',
    paymentStatus: 'CAPTURED',
    grandTotal: new Decimal('4320.00'),
    items: [
      { id: L1, quantity: 1, lineTotal: new Decimal('1966.79'), taxAmount: new Decimal('57.28') },
      { id: L2, quantity: 2, lineTotal: new Decimal('2253.21'), taxAmount: new Decimal('343.72') },
    ],
    payments: [{ id: PAYMENT_ID, amount: new Decimal('4320.00') }],
    ...over,
  };
}

function setup(o = order(), prior: unknown[] = []) {
  const { db, m } = createMockDb();
  m.order.findUnique.mockResolvedValue(o);
  m.refund.findMany.mockResolvedValue(prior);
  return { tx: db as TxClient, db, m };
}

const base = {
  orderId: ORDER_ID,
  now: NOW,
  requestedBy: { type: 'STAFF' as const, userId: randomUUID() },
  reasonCode: 'OTHER',
};

interface RefundData {
  shippingAmount: Decimal;
  itemsAmount: Decimal;
  approvedAt?: Date;
  [key: string]: unknown;
}

function refundData(m: MockModels): RefundData {
  return m.refund.create.mock.calls[0]?.[0].data as RefundData;
}

describe('createRefundForOrder', () => {
  it('full refund = everything paid, REQUESTED, RFD number, lines for every unit', async () => {
    const { tx, m } = setup();
    const refund = await createRefundForOrder(tx, base);
    expect(refund).toMatchObject({
      refundNumber: 'RFD-261119-00001',
      status: 'REQUESTED',
      method: 'ORIGINAL_PAYMENT_METHOD',
      paymentId: PAYMENT_ID,
    });
    expect(refund.amount.toFixed(2)).toBe('4320.00');
    const data = refundData(m);
    expect(data.shippingAmount.toFixed(2)).toBe('100.00');
    expect(data.itemsAmount.toFixed(2)).toBe('4220.00');
    expect(data.approvedAt).toBeUndefined();
    expect(m.refundItem.createMany.mock.calls[0]?.[0].data).toHaveLength(2);
  });

  it('auto-approved refund (R-16) is created APPROVED with approvedAt', async () => {
    const { tx, m } = setup();
    await createRefundForOrder(tx, { ...base, status: 'APPROVED' });
    expect(refundData(m)).toMatchObject({ status: 'APPROVED', approvedAt: NOW });
  });

  it('partial refund pro-rates the line and checks the client amount', async () => {
    const { tx, m } = setup();
    const refund = await createRefundForOrder(tx, {
      ...base,
      items: [{ orderItemId: L2, quantity: 1 }],
      expectedAmount: new Decimal('1126.61'),
    });
    expect(refund.amount.toFixed(2)).toBe('1126.61');
    const line = m.refundItem.createMany.mock.calls[0]?.[0].data[0] as {
      quantity: number;
      taxAmount: Decimal;
    };
    expect([line.quantity, line.taxAmount.toFixed(2)]).toEqual([1, '171.86']);

    const mismatch = setup();
    await expect(
      createRefundForOrder(mismatch.tx, {
        ...base,
        items: [{ orderItemId: L2, quantity: 1 }],
        expectedAmount: new Decimal('1000.00'),
      }),
    ).rejects.toMatchObject({ details: [{ code: 'AMOUNT_MISMATCH' }] });
  });

  it('rejects over-refunds, quantities beyond refundable and unknown lines', async () => {
    const prior = [
      {
        amount: new Decimal('4000.00'),
        shippingAmount: new Decimal('0'),
        items: [
          {
            orderItemId: L2,
            quantity: 2,
            amount: new Decimal('2253.21'),
            taxAmount: new Decimal('343.72'),
          },
        ],
      },
    ];
    const over = setup(order(), prior);
    await expect(
      createRefundForOrder(over.tx, { ...base, items: [{ orderItemId: L1, quantity: 1 }] }),
    ).rejects.toMatchObject({ details: [{ code: 'REFUND_EXCEEDS_PAID' }] });

    const qty = setup(order(), prior);
    await expect(
      createRefundForOrder(qty.tx, { ...base, items: [{ orderItemId: L2, quantity: 1 }] }),
    ).rejects.toMatchObject({ details: [{ code: 'QUANTITY_EXCEEDS_REFUNDABLE' }] });

    const unknown = setup();
    await expect(
      createRefundForOrder(unknown.tx, {
        ...base,
        items: [{ orderItemId: randomUUID(), quantity: 1 }],
      }),
    ).rejects.toMatchObject({ details: [{ code: 'UNKNOWN_ORDER_ITEM' }] });
  });

  it('applies the OQ-13 method rules and refuses unpaid orders', async () => {
    const storeCredit = setup();
    await expect(
      createRefundForOrder(storeCredit.tx, { ...base, method: 'STORE_CREDIT' }),
    ).rejects.toMatchObject({ details: [{ code: 'METHOD_NOT_SUPPORTED' }] });

    const cod = setup(order({ paymentMethod: 'COD', payments: [] }));
    const refund = await createRefundForOrder(cod.tx, base);
    expect(refund.method).toBe('BANK_TRANSFER');
    expect(refund.paymentId).toBeNull();

    const codOriginal = setup(order({ paymentMethod: 'COD', payments: [] }));
    await expect(
      createRefundForOrder(codOriginal.tx, { ...base, method: 'ORIGINAL_PAYMENT_METHOD' }),
    ).rejects.toMatchObject({ details: [{ code: 'METHOD_NOT_ALLOWED' }] });

    const unpaid = setup(order({ paymentStatus: 'PENDING', payments: [] }));
    await expect(createRefundForOrder(unpaid.tx, base)).rejects.toMatchObject({
      details: [{ code: 'ORDER_NOT_PAID' }],
    });
  });
});

describe('gateway step and completion', () => {
  const notify = {
    notifications: createNotificationService({ clock: () => NOW }),
    storefrontUrl: 'https://shop.example',
  };
  const contact = {
    id: ORDER_ID,
    orderNumber: 'ORD-261119-00001',
    userId: randomUUID(),
    grandTotal: new Decimal('4320.00'),
    paymentMethod: 'ONLINE',
    customerPhoneSnapshot: null,
    user: { firstName: 'Riya', email: 'riya@example.com', phone: null },
    refundedTotal: new Decimal('0'),
  };

  function refundRow(over: Record<string, unknown> = {}) {
    return {
      id: randomUUID(),
      refundNumber: 'RFD-261119-00001',
      status: 'APPROVED',
      method: 'ORIGINAL_PAYMENT_METHOD',
      amount: new Decimal('4320.00'),
      reasonCode: 'ORDER_CANCELLED',
      orderId: ORDER_ID,
      paymentId: PAYMENT_ID,
      payment: { id: PAYMENT_ID, providerPaymentId: 'pay_123' },
      items: [{ orderItemId: L1, quantity: 1 }],
      ...over,
    };
  }

  it('prepareGatewayRefund → PROCESSING only for gateway refunds', async () => {
    const { tx, m } = setup();
    m.refund.findUnique.mockResolvedValueOnce(refundRow());
    const job = await prepareGatewayRefund(tx, 'r1', NOW);
    expect(job).toMatchObject({ providerPaymentId: 'pay_123', paymentId: PAYMENT_ID });
    expect(m.refund.update.mock.calls[0]?.[0].data).toMatchObject({ status: 'PROCESSING' });

    m.refund.findUnique.mockResolvedValueOnce(refundRow({ method: 'BANK_TRANSFER' }));
    expect(await prepareGatewayRefund(tx, 'r2', NOW)).toBeNull();
  });

  it('markRefundCompleted rolls up payment/order totals and is idempotent', async () => {
    const { tx, m } = setup();
    m.notification.findUnique.mockResolvedValue(null);
    m.refund.findUnique.mockResolvedValueOnce(refundRow({ status: 'PROCESSING' }));
    m.payment.findUnique.mockResolvedValue({
      amount: new Decimal('4320.00'),
      amountRefunded: new Decimal('0'),
    });
    m.order.findUnique.mockResolvedValue(contact);
    expect(await markRefundCompleted(tx, notify, { refundId: 'r1', now: NOW })).toBe(true);
    expect(m.payment.update.mock.calls[0]?.[0].data.status).toBe('REFUNDED');
    expect(m.order.update.mock.calls[0]?.[0].data.paymentStatus).toBe('REFUNDED');
    expect(m.orderItem.update.mock.calls[0]?.[0].data).toEqual({
      quantityRefunded: { increment: 1 },
    });
    expect(m.notification.create.mock.calls.map((c): unknown => c[0].data.event)).toContain(
      'REFUND_COMPLETED',
    );

    m.refund.findUnique.mockResolvedValueOnce(refundRow({ status: 'COMPLETED' }));
    expect(await markRefundCompleted(tx, notify, { refundId: 'r1', now: NOW })).toBe(false);
  });

  it('TC-057: a partial refund updates refunded_total and marks payment/order PARTIALLY_REFUNDED', async () => {
    const { tx, m } = setup();
    m.notification.findUnique.mockResolvedValue(null);
    m.refund.findUnique.mockResolvedValueOnce(
      refundRow({
        status: 'PROCESSING',
        amount: new Decimal('1126.61'),
        items: [{ orderItemId: L2, quantity: 1 }],
      }),
    );
    m.payment.findUnique.mockResolvedValue({
      amount: new Decimal('4320.00'),
      amountRefunded: new Decimal('0'),
    });
    m.order.findUnique.mockResolvedValue(contact);
    expect(await markRefundCompleted(tx, notify, { refundId: 'r1', now: NOW })).toBe(true);
    const payment = m.payment.update.mock.calls[0]?.[0] as {
      where: { id: string };
      data: { amountRefunded: Decimal; status: string };
    };
    expect(payment.where).toEqual({ id: PAYMENT_ID });
    expect(payment.data.status).toBe('PARTIALLY_REFUNDED');
    expect(payment.data.amountRefunded.toFixed(2)).toBe('1126.61');
    const orderUpdate = m.order.update.mock.calls[0]?.[0] as {
      where: { id: string };
      data: { refundedTotal: Decimal; paymentStatus: string };
    };
    expect(orderUpdate.where).toEqual({ id: ORDER_ID });
    expect(orderUpdate.data.paymentStatus).toBe('PARTIALLY_REFUNDED');
    expect(orderUpdate.data.refundedTotal.toFixed(2)).toBe('1126.61');
    expect(m.orderItem.update.mock.calls[0]?.[0]).toEqual({
      where: { id: L2 },
      data: { quantityRefunded: { increment: 1 } },
    });

    // A second partial refund accumulates on top of the earlier refunded_total.
    const second = setup();
    second.m.notification.findUnique.mockResolvedValue(null);
    second.m.refund.findUnique.mockResolvedValueOnce(
      refundRow({ status: 'PROCESSING', amount: new Decimal('1000.00') }),
    );
    second.m.payment.findUnique.mockResolvedValue({
      amount: new Decimal('4320.00'),
      amountRefunded: new Decimal('1126.61'),
    });
    second.m.order.findUnique.mockResolvedValue({
      ...contact,
      refundedTotal: new Decimal('1126.61'),
    });
    await markRefundCompleted(second.tx, notify, { refundId: 'r2', now: NOW });
    const again = second.m.order.update.mock.calls[0]?.[0].data as {
      refundedTotal: Decimal;
      paymentStatus: string;
    };
    expect([again.refundedTotal.toFixed(2), again.paymentStatus]).toEqual([
      '2126.61',
      'PARTIALLY_REFUNDED',
    ]);
    expect(second.m.payment.update.mock.calls[0]?.[0].data.status).toBe('PARTIALLY_REFUNDED');
  });

  it('executeGatewayRefund records a FAILED refund when the gateway throws', async () => {
    const { db, m } = createMockDb();
    const provider = new MockPaymentProviderAdapter();
    vi.spyOn(provider, 'refund').mockRejectedValue(new Error('network down'));
    const result = await executeGatewayRefund(
      {
        ...notify,
        db,
        provider,
        clock: () => NOW,
        logger: createLogger(testConfig()),
      },
      {
        refundId: 'r1',
        paymentId: PAYMENT_ID,
        providerPaymentId: 'pay_123',
        amount: new Decimal('10.00'),
        reason: 'OTHER',
      },
    );
    expect(result.status).toBe('FAILED');
    expect(m.paymentTransaction.create.mock.calls[0]?.[0].data).toMatchObject({
      type: 'REFUND',
      refundId: 'r1',
    });
    expect(m.refund.update.mock.calls[0]?.[0].data).toMatchObject({ status: 'FAILED' });
  });
});
