/**
 * TC-030 — Last-unit oversell prevented (TESTING_STRATEGY §8 CC-01, P1).
 *
 * NOT EXECUTED — requires explicit owner authorization (DEC-12). Runs ONLY through
 * `tests/db/vitest.db.config.ts` against `ecommerce_test` (see tests/db/README.md).
 *
 * Setup     : one variant with `quantity_on_hand = 1`, `quantity_reserved = 0`; 10 verified
 *             customers, each with an ACTIVE cart holding that variant (qty 1) and a valid quote.
 * Action    : 10 parallel `POST /api/v1/checkout/orders` (ONLINE) released by one barrier, each
 *             with its own Idempotency-Key.
 * Invariant : exactly 1 × 201 (order PENDING_PAYMENT with an ACTIVE reservation of 1);
 *             9 × 409 `INSUFFICIENT_STOCK`; `quantity_on_hand = 1`, `quantity_reserved = 1`
 *             (never above on-hand, never negative); exactly one RESERVATION ledger row;
 *             one payment; one CONVERTED cart, nine carts still ACTIVE.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seedCatalog, seedCustomers, seedReference } from '../harness/fixtures.js';
import { placeOrder, readPlacedOrder, tallyResults } from '../harness/http.js';
import { evidence, fulfilled, race, rejected } from '../harness/race.js';
import { at, prepareBuyers } from '../harness/scenario.js';
import { assertDbTestGuard, openWorld, scenarioTimeout, type DbWorld } from '../harness/world.js';

const TC = 'TC-030';
const PARALLEL_CUSTOMERS = 10;

describe('TC-030 last-unit oversell (CC-01) — real MySQL', () => {
  let world: DbWorld | undefined;

  beforeAll(async () => {
    assertDbTestGuard();
    world = await openWorld();
  });

  afterAll(async () => {
    await world?.close();
  });

  async function iteration(w: DbWorld, n: number): Promise<void> {
    const { db } = w;
    await w.reset();
    await seedReference(db);
    const catalog = await seedCatalog(db, { onHand: 1 });
    const customers = await seedCustomers(db, PARALLEL_CUSTOMERS, {
      variantId: catalog.variantId,
    });
    const buyers = await prepareBuyers(w, customers, {
      shippingMethodId: catalog.shippingMethodId,
      paymentMethod: 'ONLINE',
    });

    const settled = await race(PARALLEL_CUSTOMERS, async (index) => {
      const buyer = at(buyers, index);
      return placeOrder(w, buyer.session, randomUUID(), buyer.order);
    });
    const responses = fulfilled(settled);
    const created = responses.filter((r) => r.status === 201);
    const refused = responses.filter((r) => r.status !== 201);

    const [orders, inventory, reservations, ledger, payments, convertedCarts, activeCarts] =
      await Promise.all([
        db.order.findMany({ select: { id: true, status: true, userId: true } }),
        db.inventory.findUnique({
          where: { variantId: catalog.variantId },
          select: { quantityOnHand: true, quantityReserved: true },
        }),
        db.stockReservation.findMany({
          where: { variantId: catalog.variantId },
          select: { orderId: true, quantity: true, status: true },
        }),
        db.inventoryTransaction.findMany({
          where: { variantId: catalog.variantId },
          select: { type: true, onHandDelta: true, reservedDelta: true },
        }),
        db.payment.count(),
        db.cart.count({ where: { status: 'CONVERTED' } }),
        db.cart.count({ where: { status: 'ACTIVE' } }),
      ]);

    evidence(TC, {
      iteration: n,
      parallel: PARALLEL_CUSTOMERS,
      outcomes: tallyResults(responses),
      transportErrors: rejected(settled).length,
      orders: orders.length,
      onHand: inventory?.quantityOnHand ?? null,
      reserved: inventory?.quantityReserved ?? null,
      activeReservations: reservations.filter((r) => r.status === 'ACTIVE').length,
      ledger: ledger.map((l) => l.type),
      maxMs: Math.max(...settled.map((s) => s.ms)),
    });

    const label = `${TC} iteration ${String(n)}`;
    expect(rejected(settled), `${label}: transport errors`).toHaveLength(0);
    expect(created, `${label}: exactly one order succeeds`).toHaveLength(1);
    expect(refused, `${label}: all others are refused`).toHaveLength(PARALLEL_CUSTOMERS - 1);
    for (const r of refused) {
      expect({ status: r.status, code: r.code }, label).toEqual({
        status: 409,
        code: 'INSUFFICIENT_STOCK',
      });
    }

    const placed = readPlacedOrder(at(created, 0));
    expect(placed?.status, label).toBe('PENDING_PAYMENT');
    expect(orders, `${label}: one committed order`).toHaveLength(1);
    expect(orders[0]?.id, label).toBe(placed?.orderId);
    expect(inventory, label).toEqual({ quantityOnHand: 1, quantityReserved: 1 });
    expect(reservations, `${label}: one reservation row`).toEqual([
      { orderId: placed?.orderId, quantity: 1, status: 'ACTIVE' },
    ]);
    expect(ledger, `${label}: one RESERVATION ledger row`).toEqual([
      { type: 'RESERVATION', onHandDelta: 0, reservedDelta: 1 },
    ]);
    expect(payments, label).toBe(1);
    expect(convertedCarts, label).toBe(1);
    expect(activeCarts, label).toBe(PARALLEL_CUSTOMERS - 1);
  }

  it(
    'exactly one of 10 parallel orders gets the last unit',
    { timeout: scenarioTimeout(60_000) },
    async () => {
      if (world === undefined) throw new Error('world not initialised');
      for (let n = 1; n <= world.iterations; n += 1) await iteration(world, n);
    },
  );
});
