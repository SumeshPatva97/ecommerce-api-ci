/**
 * Checkout routes through the real Express app — API_DOCUMENTATION.md §3.9.
 * MOCKED DB (tests/helpers/mockDb.ts): verifies the HTTP contract, the §3.9 worked example end to
 * end (pricing engine → shipping → GST engine), idempotency, PRICE_CHANGED / INSUFFICIENT_STOCK /
 * COUPON_INVALID semantics and the placement writes; no SQL is executed.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import type { Prisma } from '../../../../src/generated/prisma/client.js';
import { MockPaymentProviderAdapter } from '../../../../src/integrations/payments/paymentProvider.js';
import {
  MockShippingProviderAdapter,
  createShippingProviderRegistry,
} from '../../../../src/integrations/shipping/shippingProvider.js';
import {
  checkoutModuleWith,
  createCheckoutModule,
} from '../../../../src/modules/checkout/index.js';
import { buildModuleTestApp } from '../../../helpers/container.js';
import {
  IDS,
  NOW,
  address,
  couponRow,
  jhumka,
  primeCheckout,
  ring,
  serviceable,
  summaryBody,
  type PrimeOptions,
} from './fixtures.js';

const IDEM = 'checkout-key-000000000001';

function setup(
  prime: PrimeOptions = {},
  opts: { payment?: MockPaymentProviderAdapter; status?: 'ACTIVE' | 'PENDING_VERIFICATION' } = {},
) {
  const t = buildModuleTestApp([checkoutModuleWith({ serviceability: serviceable })], {
    now: NOW,
    ...(opts.payment === undefined ? {} : { overrides: { providers: { payment: opts.payment } } }),
  });
  const customer = t.customer({ userId: IDS.user, status: opts.status ?? 'ACTIVE' });
  primeCheckout(t.m, IDS.user, prime);
  return { t, auth: customer.headers };
}

async function quote(t: ReturnType<typeof setup>['t'], auth: Record<string, string>, body = {}) {
  const res = await request(t.app)
    .post('/api/v1/checkout/summary')
    .set(auth)
    .send(summaryBody(body));
  expect(res.status).toBe(200);
  return res.body.data as { quoteHash: string };
}

const placeBody = (quoteHash: string, over: Record<string, unknown> = {}) => ({
  ...summaryBody(),
  quoteHash,
  acceptTerms: true,
  ...over,
});

describe('POST /checkout/summary', () => {
  it('reproduces the API §3.9 worked example (intra-state)', async () => {
    const { t, auth } = setup();
    const res = await request(t.app).post('/api/v1/checkout/summary').set(auth).send(summaryBody());
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.quoteHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(d).toMatchObject({
      quotedAt: NOW.toISOString(),
      currency: 'INR',
      pricesIncludeTax: true,
      supplyType: 'INTRA_STATE',
      placeOfSupply: { stateCode: '27', stateName: 'Maharashtra' },
      seller: { stateCode: '27', gstin: '27ABCDE1234F1Z5' },
      issues: [],
    });
    expect(d.lines[0]).toEqual({
      cartItemId: 'ci-1',
      variantId: 'v-meera-gold-s',
      sku: 'EAR-MEERA-GLD-S',
      productName: 'Meera Kundan Jhumka',
      variantName: 'Gold / Small',
      hsnCode: '7117',
      quantity: 2,
      mrp: '1799.00',
      unitPrice: '1499.00',
      lineBase: '2998.00',
      promotion: { id: 'p-fest', label: 'Festive 10% off', scope: 'CATEGORY', discount: '299.80' },
      couponAllocation: '218.94',
      netLineValue: '2479.26',
      tax: {
        ratePercent: '3.00',
        taxableValue: '2407.05',
        components: [
          { component: 'CGST', ratePercent: '1.50', amount: '36.11' },
          { component: 'SGST', ratePercent: '1.50', amount: '36.10' },
        ],
        taxAmount: '72.21',
      },
      lineTotal: '2479.26',
    });
    expect(d.lines[1]).toMatchObject({
      cartItemId: 'ci-2',
      hsnCode: '7113',
      promotion: null,
      couponAllocation: '81.06',
      netLineValue: '917.94',
      tax: {
        taxableValue: '891.20',
        components: [
          { component: 'CGST', amount: '13.37' },
          { component: 'SGST', amount: '13.37' },
        ],
        taxAmount: '26.74',
      },
      lineTotal: '917.94',
    });
    expect(d.coupon).toEqual({
      code: 'WELCOME10',
      discountType: 'PERCENTAGE',
      discountValue: '10.00',
      maxDiscountAmount: '300.00',
      eligibleBase: '3697.20',
      computed: '369.72',
      applied: '300.00',
      capped: true,
      allocation: 'PRO_RATA_BY_NET_LINE_VALUE',
    });
    expect(d.shipping).toEqual({
      methodId: IDS.method,
      methodName: 'Standard Delivery',
      charge: '99.00',
      discount: '0.00',
      freeAbove: '4999.00',
      amountToFreeShipping: '1601.80',
      tax: {
        treatment: 'PROPORTIONAL',
        taxableValue: '96.12',
        components: [
          { component: 'CGST', amount: '1.44' },
          { component: 'SGST', amount: '1.44' },
        ],
        taxAmount: '2.88',
      },
      estimatedDelivery: { minDays: 3, maxDays: 6 },
    });
    expect(d.totals).toEqual({
      subtotal: '3997.00',
      itemDiscountTotal: '299.80',
      couponDiscountTotal: '300.00',
      shippingCharge: '99.00',
      shippingDiscount: '0.00',
      taxableTotal: '3394.37',
      cgstTotal: '50.92',
      sgstTotal: '50.91',
      utgstTotal: '0.00',
      igstTotal: '0.00',
      taxTotal: '101.83',
      totalBeforeRoundOff: '3496.20',
      roundOff: '-0.20',
      grandTotal: '3496.00',
      youSave: '1399.80',
    });
    expect(d.paymentMethods).toEqual([
      { method: 'ONLINE', available: true },
      { method: 'COD', available: false, reason: 'COD_DISABLED' },
    ]);
    // Stateless: nothing reserved, nothing written.
    expect(t.m.stockReservation.create).not.toHaveBeenCalled();
    expect(t.m.couponUsage.create).not.toHaveBeenCalled();
    expect(t.m.order.create).not.toHaveBeenCalled();
  });

  it('switches to IGST for an inter-state address with all other numbers unchanged', async () => {
    const { t, auth } = setup();
    const res = await request(t.app)
      .post('/api/v1/checkout/summary')
      .set(auth)
      .send(summaryBody({ shippingAddressId: IDS.addrBlr }));
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.supplyType).toBe('INTER_STATE');
    expect(d.lines[0].tax.components).toEqual([
      { component: 'IGST', ratePercent: '3.00', amount: '72.21' },
    ]);
    expect(d.lines[1].tax.components).toEqual([
      { component: 'IGST', ratePercent: '3.00', amount: '26.74' },
    ]);
    expect(d.shipping.tax.components).toEqual([{ component: 'IGST', amount: '2.88' }]);
    expect(d.totals).toMatchObject({
      cgstTotal: '0.00',
      sgstTotal: '0.00',
      igstTotal: '101.83',
      taxTotal: '101.83',
      grandTotal: '3496.00',
    });
  });

  it('refuses an unverified customer with 403 EMAIL_NOT_VERIFIED before touching the DB', async () => {
    const { t, auth } = setup({}, { status: 'PENDING_VERIFICATION' });
    const res = await request(t.app).post('/api/v1/checkout/summary').set(auth).send(summaryBody());
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.details[0].code).toBe('EMAIL_NOT_VERIFIED');
    expect(t.m.cart.findFirst).not.toHaveBeenCalled();
  });

  it('requires a customer token', async () => {
    const { t } = setup();
    const res = await request(t.app).post('/api/v1/checkout/summary').send(summaryBody());
    expect(res.status).toBe(401);
  });

  it('answers 404 for an address that is not the customer’s own', async () => {
    const { t, auth } = setup();
    const res = await request(t.app)
      .post('/api/v1/checkout/summary')
      .set(auth)
      .send(summaryBody({ shippingAddressId: '99999999-9999-4999-8999-999999999999' }));
    expect(res.status).toBe(404);
  });

  it('fails closed when a product has no GST rate (never 0 %)', async () => {
    const { t, auth } = setup({ withTax: false });
    const res = await request(t.app).post('/api/v1/checkout/summary').set(auth).send(summaryBody());
    expect(res.status).toBe(422);
    expect(res.body.error.details[0].code).toBe('TAX_NOT_CONFIGURED');
  });

  it('detaches a coupon that became invalid and returns 422 COUPON_INVALID with the reason', async () => {
    const { t, auth } = setup({
      coupon: couponRow({ expiresAt: new Date('2026-11-10T00:00:00.000Z') }),
    });
    const res = await request(t.app).post('/api/v1/checkout/summary').set(auth).send(summaryBody());
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('COUPON_INVALID');
    expect(res.body.error.details[0].code).toBe('COUPON_EXPIRED');
    expect(t.m.cart.updateMany).toHaveBeenCalledWith({
      where: { userId: IDS.user, status: 'ACTIVE' },
      data: { couponId: null, couponCode: null },
    });
  });

  it('lists every failing line with 409 INSUFFICIENT_STOCK', async () => {
    const { t, auth } = setup({ items: [jhumka({ onHand: 1 }), ring({ onHand: 0 })] });
    const res = await request(t.app).post('/api/v1/checkout/summary').set(auth).send(summaryBody());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(res.body.error.details).toHaveLength(2);
    expect(res.body.error.details[0]).toMatchObject({
      field: 'quantity',
      code: 'INSUFFICIENT_STOCK',
      meta: { variantId: IDS.v1, sku: 'EAR-MEERA-GLD-S', requested: 2, available: 1 },
    });
  });

  it('rejects COD while it is disabled (OQ-06) and the empty cart', async () => {
    const { t, auth } = setup();
    const cod = await request(t.app)
      .post('/api/v1/checkout/summary')
      .set(auth)
      .send(summaryBody({ paymentMethod: 'COD' }));
    expect(cod.status).toBe(422);
    expect(cod.body.error.details[0].code).toBe('COD_NOT_AVAILABLE');

    t.m.cart.findFirst.mockResolvedValue({ id: IDS.cart, couponId: null, items: [] });
    const empty = await request(t.app)
      .post('/api/v1/checkout/summary')
      .set(auth)
      .send(summaryBody());
    expect(empty.status).toBe(422);
    expect(empty.body.error.details[0].code).toBe('CART_EMPTY');
  });
});

describe('POST /checkout/orders', () => {
  it('requires an Idempotency-Key (400) and accepted terms (422)', async () => {
    const { t, auth } = setup();
    const { quoteHash } = await quote(t, auth);
    const missing = await request(t.app)
      .post('/api/v1/checkout/orders')
      .set(auth)
      .send(placeBody(quoteHash));
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('BAD_REQUEST');

    const terms = await request(t.app)
      .post('/api/v1/checkout/orders')
      .set(auth)
      .set('Idempotency-Key', IDEM)
      .send(placeBody(quoteHash, { acceptTerms: false }));
    expect(terms.status).toBe(422);
    expect(t.m.order.create).not.toHaveBeenCalled();
  });

  it('places the §3.9 order: snapshots, reservation, coupon RESERVED, payment PENDING, cart CONVERTED, gateway session', async () => {
    const { t, auth } = setup();
    const { quoteHash } = await quote(t, auth);
    const res = await request(t.app)
      .post('/api/v1/checkout/orders')
      .set(auth)
      .set('Idempotency-Key', IDEM)
      .send(placeBody(quoteHash, { customerNote: 'Gift <b>wrap</b> please' }));
    expect(res.status).toBe(201);
    const { order, payment } = res.body.data;
    expect(order).toMatchObject({
      orderNumber: 'ORD-261113-00042',
      status: 'PENDING_PAYMENT',
      paymentMethod: 'ONLINE',
      paymentStatus: 'PENDING',
      placedAt: NOW.toISOString(),
      grandTotal: '3496.00',
      currency: 'INR',
      reservationExpiresAt: '2026-11-13T10:01:03.120Z',
    });
    expect(payment).toMatchObject({
      provider: 'mock',
      amount: '3496.00',
      currency: 'INR',
      clientPayload: {
        keyId: 'mock_key_id',
        prefill: { name: 'Ananya Rao', email: 'ananya@example.com', contact: '+919812345678' },
      },
      returnUrl: expect.stringContaining('/checkout/payment-return?order=ORD-261113-00042'),
    });
    expect(payment.providerOrderId).toMatch(/^mock_order_[0-9a-f]{16}_349600$/);
    expect(payment.clientPayload.orderRef).toBe(payment.providerOrderId);

    const orderData = (
      t.m.order.create.mock.calls[0]?.[0] as { data: Record<string, Prisma.Decimal> }
    ).data;
    expect(orderData).toMatchObject({
      orderNumber: 'ORD-261113-00042',
      userId: IDS.user,
      status: 'PENDING_PAYMENT',
      itemCount: 2,
      totalQuantity: 3,
      supplyType: 'INTRA_STATE',
      placeOfSupplyStateCode: '27',
      sellerStateCodeSnapshot: '27',
      sellerGstinSnapshot: '27ABCDE1234F1Z5',
      couponCodeSnapshot: 'WELCOME10',
      shippingMethodNameSnapshot: 'Standard Delivery',
      customerNameSnapshot: 'Ananya Rao',
      customerNote: 'Gift wrap please',
      pricesIncludeTax: true,
    });
    expect(orderData.grandTotal?.toFixed(2)).toBe('3496.00');
    expect(orderData.taxTotal?.toFixed(2)).toBe('101.83');
    expect(orderData.cgstTotal?.toFixed(2)).toBe('50.92');
    expect(orderData.roundOff?.toFixed(2)).toBe('-0.20');
    expect(orderData.pricingContext).toMatchObject({
      quoteHash,
      shippingTaxTreatment: 'PROPORTIONAL',
      taxResult: {
        supplyType: 'INTRA_STATE',
        shipping: { tax: { taxableValue: '96.12', taxAmount: '2.88' } },
        totals: { taxTotal: '101.83', grandTotal: '3496.00' },
      },
    });

    const items = (
      t.m.orderItem.createMany.mock.calls[0]?.[0] as { data: Record<string, Prisma.Decimal>[] }
    ).data;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      lineNo: 1,
      hsnCode: '7117',
      sku: 'EAR-MEERA-GLD-S',
      quantity: 2,
    });
    expect(items[0]?.cgstAmount?.toFixed(2)).toBe('36.11');
    expect(items[0]?.sgstAmount?.toFixed(2)).toBe('36.10');
    expect(items[0]?.taxableValue?.toFixed(2)).toBe('2407.05');
    expect(items[1]?.couponDiscount?.toFixed(2)).toBe('81.06');

    expect(t.m.orderStatusHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        fromStatus: null,
        toStatus: 'PENDING_PAYMENT',
        actorType: 'CUSTOMER',
      }),
    });
    expect(t.m.stockReservation.create).toHaveBeenCalledTimes(2);
    expect(t.m.couponUsage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ couponId: IDS.coupon, status: 'RESERVED' }),
      select: { id: true },
    });
    expect(t.m.payment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ attemptNo: 1, status: 'PENDING', paymentMethod: 'ONLINE' }),
      select: { id: true },
    });
    expect(t.m.cart.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CONVERTED' }) }),
    );
    expect(t.m.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ event: 'ORDER_PLACED' }),
    });
    // Gateway session recorded after commit.
    expect(t.m.paymentTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'CREATE_ORDER', providerStatus: 'created' }),
    });
  });

  async function placedExpiry(settings: Record<string, unknown>) {
    const { t, auth } = setup({ settings });
    const { quoteHash } = await quote(t, auth);
    const res = await request(t.app)
      .post('/api/v1/checkout/orders')
      .set(auth)
      .set('Idempotency-Key', IDEM)
      .send(placeBody(quoteHash));
    expect(res.status).toBe(201);
    const reservation = t.m.stockReservation.create.mock.calls[0]?.[0] as {
      data: { expiresAt: Date };
    };
    return {
      response: res.body.data.order.reservationExpiresAt as string,
      reservation: reservation.data.expiresAt.toISOString(),
    };
  }

  it('FR-AD-008: honours checkout.reservation_ttl_minutes for the reservation TTL', async () => {
    const expiry = await placedExpiry({ 'checkout.reservation_ttl_minutes': 30 });
    expect(expiry.response).toBe('2026-11-13T10:16:03.120Z');
    expect(expiry.reservation).toBe('2026-11-13T10:16:03.120Z');
  });

  it('FR-AD-008: falls back to the configured TTL when the setting is missing or invalid', async () => {
    for (const value of [undefined, 4, 121, 12.5, '30']) {
      const expiry = await placedExpiry(
        value === undefined ? {} : { 'checkout.reservation_ttl_minutes': value },
      );
      expect(expiry.response).toBe('2026-11-13T10:01:03.120Z');
      expect(expiry.reservation).toBe('2026-11-13T10:01:03.120Z');
    }
  });

  it('replays a completed request for the same Idempotency-Key', async () => {
    const { t, auth } = setup();
    const stored = {
      status: 201,
      body: { success: true, data: { order: { orderNumber: 'ORD-261113-00042' } } },
    };
    t.m.idempotencyKey.create.mockRejectedValue(
      Object.assign(new Error('dup'), { code: 'P2002', clientVersion: '7' }),
    );
    const body = placeBody(`sha256:${'a'.repeat(64)}`);
    const { requestHash } = await import('../../../../src/core/middleware/idempotency.js');
    t.m.idempotencyKey.findFirst.mockResolvedValue({
      requestHash: requestHash('POST', '/api/v1/checkout/orders', body),
      status: 'COMPLETED',
      responseRef: stored,
    });
    const res = await request(t.app)
      .post('/api/v1/checkout/orders')
      .set(auth)
      .set('Idempotency-Key', IDEM)
      .send(body);
    expect(res.status).toBe(201);
    expect(res.headers['idempotent-replayed']).toBe('true');
    expect(res.body).toEqual(stored.body);
    expect(t.m.order.create).not.toHaveBeenCalled();
  });

  it('answers 409 PRICE_CHANGED with old/new unit price when the quote drifted', async () => {
    const { t, auth } = setup();
    const { quoteHash } = await quote(t, auth);
    primeCheckout(t.m, IDS.user, { items: [jhumka({ sellingPrice: '1549.00' }), ring()] });
    const res = await request(t.app)
      .post('/api/v1/checkout/orders')
      .set(auth)
      .set('Idempotency-Key', IDEM)
      .send(placeBody(quoteHash));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'PRICE_CHANGED',
      message: 'Prices in your cart have changed. Please review the updated summary.',
      details: [
        {
          field: 'lines[0].unitPrice',
          code: 'PRICE_CHANGED',
          meta: { variantId: 'v-meera-gold-s', old: '1499.00', new: '1549.00' },
        },
      ],
    });
    expect(t.m.order.create).not.toHaveBeenCalled();
  });

  it('answers 409 INSUFFICIENT_STOCK from the locked inventory rows', async () => {
    const { t, auth } = setup();
    const { quoteHash } = await quote(t, auth);
    primeCheckout(t.m, IDS.user, { locked: { [IDS.v1]: [3, 2], [IDS.v2]: [5, 0] } });
    const res = await request(t.app)
      .post('/api/v1/checkout/orders')
      .set(auth)
      .set('Idempotency-Key', IDEM)
      .send(placeBody(quoteHash));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(res.body.error.details).toEqual([
      expect.objectContaining({
        meta: { variantId: IDS.v1, sku: 'EAR-MEERA-GLD-S', requested: 2, available: 1 },
      }),
    ]);
    expect(t.m.order.create).not.toHaveBeenCalled();
  });

  it('answers 422 COUPON_INVALID when a concurrent order took the last redemption', async () => {
    const { t, auth } = setup();
    const limited = couponRow({ usageLimitEnabled: true, usageLimit: 1, usedCount: 0 });
    t.m.coupon.findUnique
      .mockResolvedValueOnce(limited) // summary pricing
      .mockResolvedValueOnce(limited) // placement pricing
      .mockResolvedValueOnce({ ...limited, usedCount: 1 }); // reserveUsage (row locked)
    const { quoteHash } = await quote(t, auth);
    const res = await request(t.app)
      .post('/api/v1/checkout/orders')
      .set(auth)
      .set('Idempotency-Key', IDEM)
      .send(placeBody(quoteHash));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('COUPON_INVALID');
    expect(res.body.error.details[0].code).toBe('COUPON_USAGE_LIMIT_REACHED');
    expect(t.m.cart.updateMany).toHaveBeenCalled();
  });

  it('refuses a customer whose email is not verified in the DB (403)', async () => {
    const { t, auth } = setup({ emailVerified: false });
    const res = await request(t.app)
      .post('/api/v1/checkout/orders')
      .set(auth)
      .set('Idempotency-Key', IDEM)
      .send(placeBody(`sha256:${'b'.repeat(64)}`));
    expect(res.status).toBe(403);
    expect(res.body.error.details[0].code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('still creates the order when the gateway is down (payment null + PAYMENT_SESSION_PENDING)', async () => {
    const { t, auth } = setup(
      {},
      { payment: new MockPaymentProviderAdapter({ failInitiate: true }) },
    );
    const { quoteHash } = await quote(t, auth);
    const res = await request(t.app)
      .post('/api/v1/checkout/orders')
      .set(auth)
      .set('Idempotency-Key', IDEM)
      .send(placeBody(quoteHash));
    expect(res.status).toBe(201);
    expect(res.body.data.order.status).toBe('PENDING_PAYMENT');
    expect(res.body.data.payment).toBeNull();
    expect(res.body.data.warnings).toEqual([{ code: 'PAYMENT_SESSION_PENDING' }]);
    expect(t.m.paymentTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'CREATE_ORDER', errorCode: 'GATEWAY_UNAVAILABLE' }),
    });
  });

  it('confirms a COD order immediately when COD is enabled (stock deducted, payment null)', async () => {
    const { t, auth } = setup({ settings: { 'checkout.cod_enabled': true } });
    const { quoteHash } = await quote(t, auth, { paymentMethod: 'COD' });
    const res = await request(t.app)
      .post('/api/v1/checkout/orders')
      .set(auth)
      .set('Idempotency-Key', IDEM)
      .send(placeBody(quoteHash, { paymentMethod: 'COD' }));
    expect(res.status).toBe(201);
    expect(res.body.data.order.status).toBe('CONFIRMED');
    expect(res.body.data.payment).toBeNull();
    expect(t.m.stockReservation.create).not.toHaveBeenCalled();
    const ledger = (
      t.m.inventoryTransaction.createMany.mock.calls[0]?.[0] as { data: { type: string }[] }
    ).data;
    expect(ledger.every((e) => e.type === 'ORDER_DEDUCTION')).toBe(true);
  });
});

/**
 * TC-049 — "Serviceability check blocks non-serviceable pincode (OQ-07)" at checkout.
 * checkout.service.ts `prepare()` asks the serviceability collaborator for the SHIPPING address
 * pincode on both the quote and the placement; `serviceable === false` → 422
 * `PINCODE_NOT_SERVICEABLE` on `shippingAddressId`. PROVISIONAL (OQ-07): fake courier only.
 */
describe('TC-049 — serviceability gate at checkout', () => {
  const ADDR_REMOTE = '33333333-3333-4333-8333-333333333309';
  const NOT_SERVICEABLE = {
    field: 'shippingAddressId',
    code: 'PINCODE_NOT_SERVICEABLE',
    message: 'We do not deliver to this pincode yet.',
  };

  /** Pune (411045) plus an address at 999001 — the fixture stub and the mock courier refuse 9xxxxx. */
  function withRemoteAddress(t: ReturnType<typeof setup>['t']) {
    t.m.userAddress.findMany.mockResolvedValue([
      address(IDS.addrPune, '27', 'Maharashtra', '411045', 'Pune'),
      address(ADDR_REMOTE, '27', 'Maharashtra', '999001', 'Remote Town'),
    ]);
  }

  function expectNothingPlaced(t: ReturnType<typeof setup>['t']) {
    expect(t.m.order.create).not.toHaveBeenCalled();
    expect(t.m.orderItem.createMany).not.toHaveBeenCalled();
    expect(t.m.stockReservation.create).not.toHaveBeenCalled();
    expect(t.m.couponUsage.create).not.toHaveBeenCalled();
    expect(t.m.payment.create).not.toHaveBeenCalled();
    expect(t.m.paymentTransaction.create).not.toHaveBeenCalled();
    expect(t.m.cart.update).not.toHaveBeenCalled();
    expect(t.m.notification.create).not.toHaveBeenCalled();
  }

  it('TC-049: POST /checkout/summary answers 422 PINCODE_NOT_SERVICEABLE for a non-serviceable shipping pincode, before pricing the cart', async () => {
    const { t, auth } = setup();
    withRemoteAddress(t);
    const res = await request(t.app)
      .post('/api/v1/checkout/summary')
      .set(auth)
      .send(summaryBody({ shippingAddressId: ADDR_REMOTE }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toEqual([NOT_SERVICEABLE]);
    expect(t.m.cart.findFirst).not.toHaveBeenCalled();

    // Only the SHIPPING pincode is checked: billing to the remote address is fine.
    const billing = await request(t.app)
      .post('/api/v1/checkout/summary')
      .set(auth)
      .send(summaryBody({ billingAddressId: ADDR_REMOTE }));
    expect(billing.status).toBe(200);
    expect(billing.body.data.issues).toEqual([]);
  });

  it('TC-049: POST /checkout/orders blocks placement to a non-serviceable pincode — 422, no order, reservation, coupon usage or payment', async () => {
    const { t, auth } = setup();
    withRemoteAddress(t);
    const { quoteHash } = await quote(t, auth); // quoted for the serviceable Pune address
    const res = await request(t.app)
      .post('/api/v1/checkout/orders')
      .set(auth)
      .set('Idempotency-Key', IDEM)
      .send(placeBody(quoteHash, { shippingAddressId: ADDR_REMOTE }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toEqual([NOT_SERVICEABLE]);
    expect(t.m.$transaction).not.toHaveBeenCalled();
    expectNothingPlaced(t);
  });

  it('TC-049: placement re-checks serviceability — a pincode that stopped being serviceable after the quote is refused', async () => {
    let open = true;
    const t = buildModuleTestApp(
      [
        checkoutModuleWith({
          serviceability: async (pincode) => ({
            ...(await serviceable(pincode)),
            serviceable: open,
          }),
        }),
      ],
      { now: NOW },
    );
    const auth = t.customer({ userId: IDS.user }).headers;
    primeCheckout(t.m, IDS.user);
    const { quoteHash } = await quote(t, auth);

    open = false;
    const res = await request(t.app)
      .post('/api/v1/checkout/orders')
      .set(auth)
      .set('Idempotency-Key', IDEM)
      .send(placeBody(quoteHash));
    expect(res.status).toBe(422);
    expect(res.body.error.details).toEqual([NOT_SERVICEABLE]);
    expectNothingPlaced(t);
  });

  it('TC-049: default wiring asks the shipping provider — the mock courier refuses 9xxxxx on summary and placement', async () => {
    const t = buildModuleTestApp([createCheckoutModule], { now: NOW });
    const auth = t.customer({ userId: IDS.user }).headers;
    primeCheckout(t.m, IDS.user);
    withRemoteAddress(t);

    const ok = await request(t.app).post('/api/v1/checkout/summary').set(auth).send(summaryBody());
    expect(ok.status).toBe(200);
    expect(ok.body.data.issues).toEqual([]);
    // ETA comes from the courier (411045 is a mock "metro" prefix), not the 3–6 days of the method.
    expect(ok.body.data.shipping.estimatedDelivery).toEqual({ minDays: 2, maxDays: 4 });

    const summary = await request(t.app)
      .post('/api/v1/checkout/summary')
      .set(auth)
      .send(summaryBody({ shippingAddressId: ADDR_REMOTE }));
    expect(summary.status).toBe(422);
    expect(summary.body.error.details).toEqual([NOT_SERVICEABLE]);

    const place = await request(t.app)
      .post('/api/v1/checkout/orders')
      .set(auth)
      .set('Idempotency-Key', IDEM)
      .send(placeBody(ok.body.data.quoteHash as string, { shippingAddressId: ADDR_REMOTE }));
    expect(place.status).toBe(422);
    expect(place.body.error.details).toEqual([NOT_SERVICEABLE]);
    expectNothingPlaced(t);
  });

  it('TC-049: a courier outage does not block the quote — issues carries SERVICEABILITY_UNVERIFIED and the ETA falls back to the method (as implemented)', async () => {
    const t = buildModuleTestApp([createCheckoutModule], {
      now: NOW,
      overrides: {
        providers: {
          shipping: createShippingProviderRegistry([
            new MockShippingProviderAdapter({ failServiceability: true }),
          ]),
        },
      },
    });
    const auth = t.customer({ userId: IDS.user }).headers;
    primeCheckout(t.m, IDS.user);
    const res = await request(t.app).post('/api/v1/checkout/summary').set(auth).send(summaryBody());
    expect(res.status).toBe(200);
    expect(res.body.data.issues).toEqual([{ code: 'SERVICEABILITY_UNVERIFIED' }]);
    expect(res.body.data.shipping.estimatedDelivery).toEqual({ minDays: 3, maxDays: 6 });
    expect(res.body.data.totals.grandTotal).toBe('3496.00');
  });
});
