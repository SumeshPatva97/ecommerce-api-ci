/**
 * TC-051 — Payment webhook vs client verify race: single capture (TESTING_STRATEGY §8 CC-09, P1).
 *
 * NOT EXECUTED — requires explicit owner authorization (DEC-12). Runs ONLY through
 * `tests/db/vitest.db.config.ts` against `ecommerce_test` (see tests/db/README.md).
 *
 * Setup     : one verified customer places a real ONLINE order (PENDING_PAYMENT, ACTIVE stock
 *             reservation, PENDING payment with a mock gateway order id). Stock 5.
 * Action    : `POST /api/v1/payments/verify` (signed client callback) and
 *             `POST /api/v1/webhooks/payments/mock` (`payment.captured`, signed raw body) for the
 *             SAME gateway payment, released by one barrier.
 * Invariant : both answer 200; ONE capture — payment CAPTURED once, exactly one CAPTURE row in
 *             `payment_transactions`, exactly one PENDING_PAYMENT → CONFIRMED history row, the
 *             reservation COMMITTED once, exactly one ORDER_DEDUCTION (on_hand 5 → 4, reserved
 *             0), and one PAYMENT_SUCCEEDED / ORDER_CONFIRMED notification per channel.
 * Follow-up : (sequential) the same webhook event again → `duplicate`; a NEW webhook event for
 *             the same payment and a second verify → still one capture, nothing deducted twice.
 *
 * Both paths lock the `orders` row first (`capturePayment`) and run with `retryOnDeadlock`; the
 * webhook inserts its `payment_transactions` row before that lock, so a deadlock between the two
 * is possible on a real server and must be retried transparently — only a real database shows it.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { toMinorUnits } from '../../../src/lib/money.js';
import { seedCatalog, seedCustomers, seedReference } from '../harness/fixtures.js';
import {
  dataFlag,
  dataString,
  outcomeLabel,
  placeOrder,
  readPlacedOrder,
  sendCaptureWebhook,
  verifyPayment,
  type ApiResult,
} from '../harness/http.js';
import { evidence, race } from '../harness/race.js';
import { at, prepareBuyers } from '../harness/scenario.js';
import { assertDbTestGuard, openWorld, scenarioTimeout, type DbWorld } from '../harness/world.js';

const TC = 'TC-051';
const STOCK = 5;

describe('TC-051 webhook vs client-verify race (CC-09) — real MySQL', () => {
  let world: DbWorld | undefined;

  beforeAll(async () => {
    assertDbTestGuard();
    world = await openWorld();
  });

  afterAll(async () => {
    await world?.close();
  });

  async function snapshot(w: DbWorld, orderId: string, variantId: string) {
    const { db } = w;
    const [order, payments, history, reservations, deductions, inventory, notifications] =
      await Promise.all([
        db.order.findUnique({
          where: { id: orderId },
          select: { status: true, paymentStatus: true, confirmedAt: true },
        }),
        db.payment.findMany({
          where: { orderId },
          select: {
            status: true,
            providerPaymentId: true,
            capturedAt: true,
            transactions: { select: { type: true, errorCode: true } },
          },
        }),
        db.orderStatusHistory.count({ where: { orderId, toStatus: 'CONFIRMED' } }),
        db.stockReservation.findMany({
          where: { orderId },
          select: { status: true, quantity: true },
        }),
        db.inventoryTransaction.count({ where: { orderId, type: 'ORDER_DEDUCTION' } }),
        db.inventory.findUnique({
          where: { variantId },
          select: { quantityOnHand: true, quantityReserved: true },
        }),
        db.notification.findMany({
          where: { entityId: orderId, event: { in: ['PAYMENT_SUCCEEDED', 'ORDER_CONFIRMED'] } },
          select: { event: true, channel: true },
        }),
      ]);
    const transactions = payments.flatMap((p) => p.transactions);
    const channelsOf = (event: string): string[] =>
      notifications
        .filter((x) => x.event === event)
        .map((x) => x.channel)
        .sort();
    return {
      orderStatus: order?.status ?? null,
      paymentStatus: order?.paymentStatus ?? null,
      confirmed: order?.confirmedAt != null,
      payments: payments.map((p) => ({
        status: p.status,
        providerPaymentId: p.providerPaymentId,
        captured: p.capturedAt !== null,
      })),
      captureRows: transactions.filter((t) => t.type === 'CAPTURE' && t.errorCode === null).length,
      webhookRows: transactions.filter((t) => t.type === 'WEBHOOK').length,
      refundRequiredRows: transactions.filter((t) => t.errorCode === 'REFUND_REQUIRED').length,
      confirmedTransitions: history,
      reservations,
      orderDeductions: deductions,
      inventory,
      paymentSucceededChannels: channelsOf('PAYMENT_SUCCEEDED'),
      orderConfirmedChannels: channelsOf('ORDER_CONFIRMED'),
    };
  }

  async function iteration(w: DbWorld, n: number): Promise<void> {
    const { db } = w;
    await w.reset();
    await seedReference(db);
    const catalog = await seedCatalog(db, { onHand: STOCK });
    const customers = await seedCustomers(db, 1, { variantId: catalog.variantId });
    const buyer = at(
      await prepareBuyers(w, customers, {
        shippingMethodId: catalog.shippingMethodId,
        paymentMethod: 'ONLINE',
      }),
      0,
    );

    const placed = readPlacedOrder(await placeOrder(w, buyer.session, randomUUID(), buyer.order));
    if (placed?.providerOrderId == null) {
      throw new Error(`${TC}: the ONLINE order or its gateway session was not created`);
    }
    const { orderId, orderNumber, providerOrderId } = placed;
    const payment = await db.payment.findFirst({
      where: { orderId, providerOrderId },
      select: { amount: true },
    });
    if (payment === null) throw new Error(`${TC}: payment row not found`);
    const amountMinor = toMinorUnits(payment.amount);
    const providerPaymentId = `mock_pay_${randomUUID().replaceAll('-', '')}`;
    const eventId = `evt_${randomUUID()}`;
    const refs = { orderNumber, providerOrderId, providerPaymentId };
    const webhookEvent = { eventId, providerOrderId, providerPaymentId, amountMinor };

    // Alternate the scheduling order so neither path is systematically first.
    const verify = (): Promise<ApiResult> => verifyPayment(w, buyer.session, refs);
    const webhook = (): Promise<ApiResult> => sendCaptureWebhook(w, webhookEvent);
    const verifyFirst = n % 2 === 1;
    const operations = verifyFirst ? [verify, webhook] : [webhook, verify];
    const settled = await race(operations.length, (index) => at(operations, index)());
    const verifySettled = at(settled, verifyFirst ? 0 : 1);
    const webhookSettled = at(settled, verifyFirst ? 1 : 0);
    const verifyResult = verifySettled.ok ? verifySettled.value : null;
    const webhookResult = webhookSettled.ok ? webhookSettled.value : null;

    const afterRace = await snapshot(w, orderId, catalog.variantId);

    // Follow-up (sequential): duplicate event, a new event for the same payment, verify again.
    const duplicate = await sendCaptureWebhook(w, webhookEvent);
    const redelivery = await sendCaptureWebhook(w, {
      ...webhookEvent,
      eventId: `evt_${randomUUID()}`,
    });
    const verifyAgain = await verifyPayment(w, buyer.session, refs);
    const afterReplays = await snapshot(w, orderId, catalog.variantId);

    evidence(TC, {
      iteration: n,
      scheduledFirst: verifyFirst ? 'verify' : 'webhook',
      verify: verifyResult === null ? 'transport-error' : outcomeLabel(verifyResult),
      webhook: webhookResult === null ? 'transport-error' : outcomeLabel(webhookResult),
      afterRace,
      duplicate: { status: duplicate.status, duplicate: dataFlag(duplicate, 'duplicate') },
      redelivery: outcomeLabel(redelivery),
      verifyAgain: outcomeLabel(verifyAgain),
      afterReplays: {
        captureRows: afterReplays.captureRows,
        webhookRows: afterReplays.webhookRows,
        orderDeductions: afterReplays.orderDeductions,
        inventory: afterReplays.inventory,
      },
    });

    const label = `${TC} iteration ${String(n)}`;
    expect(verifyResult?.status, `${label}: verify answers 200`).toBe(200);
    expect(webhookResult?.status, `${label}: webhook answers 200`).toBe(200);
    expect(
      {
        orderStatus: verifyResult === null ? null : dataString(verifyResult, 'orderStatus'),
        paymentStatus: verifyResult === null ? null : dataString(verifyResult, 'paymentStatus'),
      },
      `${label}: verify reports the captured state`,
    ).toEqual({ orderStatus: 'CONFIRMED', paymentStatus: 'CAPTURED' });

    const single = {
      orderStatus: 'CONFIRMED',
      paymentStatus: 'CAPTURED',
      confirmed: true,
      payments: [{ status: 'CAPTURED', providerPaymentId, captured: true }],
      captureRows: 1,
      refundRequiredRows: 0,
      confirmedTransitions: 1,
      reservations: [{ status: 'COMMITTED', quantity: 1 }],
      orderDeductions: 1,
      inventory: { quantityOnHand: STOCK - 1, quantityReserved: 0 },
      paymentSucceededChannels: ['EMAIL', 'WHATSAPP'],
      orderConfirmedChannels: ['EMAIL', 'WHATSAPP'],
    };
    expect(afterRace, `${label}: single capture after the race`).toEqual({
      ...single,
      webhookRows: 1,
    });

    expect(
      { status: duplicate.status, duplicate: dataFlag(duplicate, 'duplicate') },
      `${label}: same event id is a duplicate`,
    ).toEqual({ status: 200, duplicate: true });
    expect(redelivery.status, `${label}: new event for a captured payment`).toBe(200);
    expect(
      { status: verifyAgain.status, paymentStatus: dataString(verifyAgain, 'paymentStatus') },
      `${label}: verify after capture`,
    ).toEqual({ status: 200, paymentStatus: 'CAPTURED' });
    expect(afterReplays, `${label}: still a single capture after replays`).toEqual({
      ...single,
      webhookRows: 2,
    });
  }

  it(
    'verify and webhook for the same payment capture it exactly once',
    { timeout: scenarioTimeout(60_000) },
    async () => {
      if (world === undefined) throw new Error('world not initialised');
      for (let n = 1; n <= world.iterations; n += 1) await iteration(world, n);
    },
  );
});
