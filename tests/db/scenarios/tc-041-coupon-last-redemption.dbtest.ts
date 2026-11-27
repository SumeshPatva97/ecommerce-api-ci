/**
 * TC-041 — Coupon last-redemption race (TESTING_STRATEGY §8 CC-03, P1).
 *
 * NOT EXECUTED — requires explicit owner authorization (DEC-12). Runs ONLY through
 * `tests/db/vitest.db.config.ts` against `ecommerce_test` (see tests/db/README.md).
 *
 * Setup     : one FIXED ₹100 coupon with `usage_limit = L`, `used_count = 0`, attached to the
 *             ACTIVE cart of 10 verified customers; ample stock (no stock contention).
 * Action    : 10 parallel `POST /api/v1/checkout/orders` (ONLINE) released by one barrier.
 * Invariant : redemptions never exceed the limit — exactly L × 201, the rest 422
 *             `COUPON_INVALID`; `coupons.used_count = L`; exactly L `coupon_usage` rows in
 *             RESERVED/REDEEMED; exactly L orders (all carrying the coupon); stock reserved only
 *             for those L orders; the refused customers' carts stay ACTIVE with the coupon
 *             detached (API §3.9).
 * Cases     : L = 1 on every iteration (CC-03 exactly) and L = 3 once (limit > 1).
 *
 * Why this needs a real database: `placeOrder` prices the cart (plain reads) BEFORE it takes the
 * inventory and coupon row locks, and `reserveUsage` re-reads the coupon after `FOR UPDATE`.
 * Whether that re-read observes the redemption committed by the winning transaction depends on
 * the InnoDB read view of the losing transaction — something no mocked test can show.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seedCatalog, seedCoupon, seedCustomers, seedReference } from '../harness/fixtures.js';
import { placeOrder, tallyResults } from '../harness/http.js';
import { evidence, fulfilled, race, rejected } from '../harness/race.js';
import { at, prepareBuyers } from '../harness/scenario.js';
import { assertDbTestGuard, openWorld, scenarioTimeout, type DbWorld } from '../harness/world.js';

const TC = 'TC-041';
const PARALLEL_CUSTOMERS = 10;

describe('TC-041 coupon last-redemption race (CC-03) — real MySQL', () => {
  let world: DbWorld | undefined;

  beforeAll(async () => {
    assertDbTestGuard();
    world = await openWorld();
  });

  afterAll(async () => {
    await world?.close();
  });

  async function iteration(w: DbWorld, n: number, usageLimit: number): Promise<void> {
    const { db } = w;
    await w.reset();
    await seedReference(db);
    const catalog = await seedCatalog(db, { onHand: PARALLEL_CUSTOMERS + 5 });
    const coupon = await seedCoupon(db, { usageLimit });
    const customers = await seedCustomers(db, PARALLEL_CUSTOMERS, {
      variantId: catalog.variantId,
      coupon,
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

    const [couponRow, usages, orders, inventory, cartsWithCoupon, activeCarts] = await Promise.all([
      db.coupon.findUnique({
        where: { id: coupon.id },
        select: { usedCount: true, usageLimit: true },
      }),
      db.couponUsage.findMany({
        where: { couponId: coupon.id },
        select: { orderId: true, userId: true, status: true },
      }),
      db.order.findMany({ select: { id: true, couponId: true } }),
      db.inventory.findUnique({
        where: { variantId: catalog.variantId },
        select: { quantityOnHand: true, quantityReserved: true },
      }),
      db.cart.count({ where: { status: 'ACTIVE', couponId: { not: null } } }),
      db.cart.count({ where: { status: 'ACTIVE' } }),
    ]);
    const liveUsages = usages.filter((u) => u.status === 'RESERVED' || u.status === 'REDEEMED');

    evidence(TC, {
      iteration: n,
      usageLimit,
      parallel: PARALLEL_CUSTOMERS,
      outcomes: tallyResults(responses),
      transportErrors: rejected(settled).length,
      usedCount: couponRow?.usedCount ?? null,
      liveUsages: liveUsages.length,
      orders: orders.length,
      reserved: inventory?.quantityReserved ?? null,
      maxMs: Math.max(...settled.map((s) => s.ms)),
    });

    const label = `${TC} iteration ${String(n)} (limit ${String(usageLimit)})`;
    expect(rejected(settled), `${label}: transport errors`).toHaveLength(0);
    // The invariant that matters most, asserted first: the limit is never exceeded.
    expect(couponRow?.usedCount, `${label}: used_count never exceeds usage_limit`).toBe(usageLimit);
    expect(liveUsages, `${label}: live coupon_usage rows`).toHaveLength(usageLimit);
    expect(new Set(liveUsages.map((u) => u.userId)).size, `${label}: one usage per customer`).toBe(
      usageLimit,
    );

    expect(created, `${label}: successful orders`).toHaveLength(usageLimit);
    expect(refused, `${label}: refused orders`).toHaveLength(PARALLEL_CUSTOMERS - usageLimit);
    for (const r of refused) {
      expect({ status: r.status, code: r.code }, label).toEqual({
        status: 422,
        code: 'COUPON_INVALID',
      });
    }

    expect(orders, `${label}: committed orders`).toHaveLength(usageLimit);
    expect(
      orders.every((o) => o.couponId === coupon.id),
      `${label}: every order carries the coupon`,
    ).toBe(true);
    expect(new Set(liveUsages.map((u) => u.orderId)), label).toEqual(
      new Set(orders.map((o) => o.id)),
    );
    // Refused placements rolled back completely: stock is reserved only for the winners.
    expect(inventory, label).toEqual({
      quantityOnHand: PARALLEL_CUSTOMERS + 5,
      quantityReserved: usageLimit,
    });
    expect(activeCarts, label).toBe(PARALLEL_CUSTOMERS - usageLimit);
    expect(cartsWithCoupon, `${label}: coupon detached from refused carts`).toBe(0);
  }

  it(
    'usage_limit = 1: exactly one of 10 parallel orders redeems the coupon',
    { timeout: scenarioTimeout(60_000) },
    async () => {
      if (world === undefined) throw new Error('world not initialised');
      for (let n = 1; n <= world.iterations; n += 1) await iteration(world, n, 1);
    },
  );

  it(
    'usage_limit = 3: exactly three of 10 parallel orders redeem the coupon',
    { timeout: scenarioTimeout(60_000, 1) },
    async () => {
      if (world === undefined) throw new Error('world not initialised');
      await iteration(world, 1, 3);
    },
  );
});
