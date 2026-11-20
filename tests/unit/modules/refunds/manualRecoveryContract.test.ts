/**
 * DEC-05 — refund manual-recovery contract (API_DOCUMENTATION.md §4.11, ADMIN_WORKFLOWS §11.1,
 * R-13). Pins the state rules of the two staff recovery actions on the refunds service:
 * - `retry` only from FAILED (a PROCESSING refund → 409 INVALID_STATE_TRANSITION);
 * - `complete` (manual close with a UTR): gateway refunds (ORIGINAL_PAYMENT_METHOD) only from
 *   PROCESSING; BANK_TRANSFER from APPROVED or PROCESSING;
 * - `complete` never calls the payment provider.
 * MOCKED DB (tests/helpers/mockDb.ts), same `refund.findUnique` routing as the refunds route kit
 * (tests/integration/modules/refunds/refunds.routes.test.ts); no SQL is executed.
 */
import { describe, expect, it, vi } from 'vitest';

import { MockPaymentProviderAdapter } from '../../../../src/integrations/payments/paymentProvider.js';
import { Decimal } from '../../../../src/lib/money.js';
import { createRefundsService, type StaffContext } from '../../../../src/modules/refunds/index.js';
import { buildModuleTestApp, type ModuleTestApp } from '../../../helpers/container.js';

const NOW = new Date('2026-11-19T06:30:00.000Z');
const REFUND_ID = '6e3d8b20-0000-4b00-8000-000000000101';
const ORDER_ID = '6e3d8b20-0000-4b00-8000-0000000001b1';
const MAKER = '6e3d8b20-0000-4b00-8000-0000000001c1';
const CHECKER = '6e3d8b20-0000-4b00-8000-0000000001c2';
const ITEM_ID = '6e3d8b20-0000-4b00-8000-0000000001a1';

type Method = 'ORIGINAL_PAYMENT_METHOD' | 'BANK_TRANSFER';

const staff: StaffContext = {
  actor: { type: 'STAFF', userId: CHECKER, role: 'MANAGER', loginType: 'STAFF' },
  userId: CHECKER,
  isSuperadmin: false,
};

const completion = { utr: 'UTR0009876', transferredAt: new Date('2026-11-19T05:00:00.000Z') };

const orderContact = {
  id: ORDER_ID,
  orderNumber: 'ORD-261119-00077',
  userId: MAKER,
  grandTotal: new Decimal('2499.00'),
  paymentMethod: 'ONLINE',
  customerPhoneSnapshot: null,
  user: { firstName: 'Riya', email: 'riya@example.com', phone: null },
};

function detail(status: string, method: Method) {
  return {
    id: REFUND_ID,
    refundNumber: 'RFD-261119-00009',
    orderId: ORDER_ID,
    paymentId: method === 'BANK_TRANSFER' ? null : 'pay-row',
    status,
    method,
    reasonCode: 'OTHER',
    reasonText: null,
    itemsAmount: new Decimal('2400.00'),
    shippingAmount: new Decimal('99.00'),
    amount: new Decimal('2499.00'),
    taxableValue: new Decimal('2330.10'),
    taxAmount: new Decimal('69.90'),
    restock: false,
    requestedByType: 'STAFF',
    requestedById: MAKER,
    approvedById: CHECKER,
    approvedAt: NOW,
    rejectedById: null,
    rejectedAt: null,
    rejectionReason: null,
    providerRefundId: null,
    payoutReference: null,
    processingAt: null,
    completedAt: null,
    failedAt: null,
    failureReason: null,
    retryCount: 0,
    createdAt: NOW,
    order: { orderNumber: orderContact.orderNumber },
    items: [
      {
        orderItemId: ITEM_ID,
        quantity: 1,
        amount: new Decimal('2400.00'),
        taxableValue: new Decimal('2330.10'),
        taxAmount: new Decimal('69.90'),
        orderItem: { sku: 'EAR-JH-001-G', productName: 'Meera Jhumka', variantName: 'Gold' },
      },
    ],
    invoiceRecords: [],
  };
}

/** Routes `refund.findUnique` by select shape (lock head, locked row, gateway, completion, DTO). */
function mockRefund(t: ModuleTestApp, status: string, method: Method): void {
  t.m.refund.findUnique.mockImplementation((args: { select: Record<string, unknown> }) => {
    const s = args.select;
    if (Object.keys(s).length === 1 && 'orderId' in s)
      return Promise.resolve({ orderId: ORDER_ID });
    if ('order' in s && 'retryCount' in s && !('invoiceRecords' in s)) {
      return Promise.resolve({
        id: REFUND_ID,
        refundNumber: 'RFD-261119-00009',
        orderId: ORDER_ID,
        status,
        method,
        amount: new Decimal('2499.00'),
        shippingAmount: new Decimal('99.00'),
        retryCount: 0,
        requestedByType: 'STAFF',
        requestedById: MAKER,
        items: [{ orderItemId: ITEM_ID, quantity: 1 }],
        order: orderContact,
      });
    }
    if ('payment' in s) {
      return Promise.resolve({
        id: REFUND_ID,
        status,
        method,
        amount: new Decimal('2499.00'),
        reasonCode: 'OTHER',
        payment: { id: 'pay-row', providerPaymentId: 'pay_1' },
      });
    }
    if ('invoiceRecords' in s) return Promise.resolve(detail(status, method));
    // markRefundCompleted
    return Promise.resolve({
      id: REFUND_ID,
      refundNumber: 'RFD-261119-00009',
      status,
      method,
      amount: new Decimal('2499.00'),
      orderId: ORDER_ID,
      paymentId: method === 'BANK_TRANSFER' ? null : 'pay-row',
      items: [{ orderItemId: ITEM_ID, quantity: 1 }],
    });
  });
}

function setup(status: string, method: Method) {
  const provider = new MockPaymentProviderAdapter();
  const providerRefund = vi.spyOn(provider, 'refund');
  const t = buildModuleTestApp([], { now: NOW, overrides: { providers: { payment: provider } } });
  mockRefund(t, status, method);
  t.m.notification.findUnique.mockResolvedValue(null);
  t.m.invoiceRecord.findFirst.mockResolvedValue(null);
  t.m.payment.findUnique.mockResolvedValue({
    amount: new Decimal('2499.00'),
    amountRefunded: new Decimal('0'),
  });
  t.m.order.findUnique.mockResolvedValue({ ...orderContact, refundedTotal: new Decimal('0') });
  return { t, service: createRefundsService(t.container), providerRefund };
}

describe('DEC-05 refund manual recovery — retry', () => {
  it('rejects a PROCESSING refund with 409 INVALID_STATE_TRANSITION (allowed only from FAILED)', async () => {
    const { t, service, providerRefund } = setup('PROCESSING', 'ORIGINAL_PAYMENT_METHOD');
    await expect(service.retry(staff, REFUND_ID)).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
      httpStatus: 409,
      details: [
        expect.objectContaining({
          field: 'status',
          meta: { currentStatus: 'PROCESSING', allowedFrom: ['FAILED'] },
        }),
      ],
    });
    expect(t.m.refund.update).not.toHaveBeenCalled();
    expect(t.m.auditLog.create).not.toHaveBeenCalled();
    expect(providerRefund).not.toHaveBeenCalled();
  });

  it('control: a FAILED gateway refund is retried through the provider (the spy observes calls)', async () => {
    const { service, providerRefund } = setup('FAILED', 'ORIGINAL_PAYMENT_METHOD');
    await service.retry(staff, REFUND_ID);
    expect(providerRefund).toHaveBeenCalledTimes(1);
  });
});

describe('DEC-05 refund manual recovery — complete', () => {
  it('rejects an APPROVED gateway (ORIGINAL_PAYMENT_METHOD) refund with INVALID_STATE_TRANSITION', async () => {
    const { t, service, providerRefund } = setup('APPROVED', 'ORIGINAL_PAYMENT_METHOD');
    await expect(service.complete(staff, REFUND_ID, completion)).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
      httpStatus: 409,
      details: [
        expect.objectContaining({
          meta: { currentStatus: 'APPROVED', allowedFrom: ['PROCESSING'] },
        }),
      ],
    });
    expect(t.m.refund.update).not.toHaveBeenCalled();
    expect(providerRefund).not.toHaveBeenCalled();
  });

  it('accepts a PROCESSING gateway refund → COMPLETED with the UTR, without calling the provider', async () => {
    const { t, service, providerRefund } = setup('PROCESSING', 'ORIGINAL_PAYMENT_METHOD');
    await service.complete(staff, REFUND_ID, completion);
    expect(t.m.refund.update.mock.calls[0]?.[0].data).toMatchObject({
      status: 'COMPLETED',
      payoutReference: 'UTR0009876',
    });
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data).toMatchObject({
      action: 'STATUS_CHANGE',
    });
    expect(providerRefund).not.toHaveBeenCalled();
  });

  it.each(['APPROVED', 'PROCESSING'])(
    'accepts a %s BANK_TRANSFER refund → COMPLETED, without calling the provider',
    async (status) => {
      const { t, service, providerRefund } = setup(status, 'BANK_TRANSFER');
      await service.complete(staff, REFUND_ID, completion);
      expect(t.m.refund.update.mock.calls[0]?.[0].data).toMatchObject({
        status: 'COMPLETED',
        payoutReference: 'UTR0009876',
      });
      expect(t.m.auditLog.create.mock.calls[0]?.[0].data).toMatchObject({
        action: 'STATUS_CHANGE',
      });
      expect(providerRefund).not.toHaveBeenCalled();
    },
  );
});
