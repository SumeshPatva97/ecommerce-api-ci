/**
 * TC-048 — Idempotency-Key concurrent replay returns the same order (TESTING_STRATEGY §8 CC-08,
 * P1; PROJECT_CONTEXT §15 R-18).
 *
 * NOT EXECUTED — requires explicit owner authorization (DEC-12). Runs ONLY through
 * `tests/db/vitest.db.config.ts` against `ecommerce_test` (see tests/db/README.md).
 *
 * Setup     : one verified customer, ACTIVE cart (qty 1), stock 5, a valid quote.
 * Action    : the SAME `POST /api/v1/checkout/orders` (same body, same Idempotency-Key) sent 5×
 *             in parallel behind one barrier.
 * Invariant : ONE order. Exactly one request executes the handler (201, not replayed); every
 *             other request is either the stored response (201 + `Idempotent-Replayed: true`,
 *             same order id) or 409 `IDEMPOTENCY_CONFLICT` / `IN_PROGRESS`. One
 *             `idempotency_keys` row, one payment, one reservation (qty 1), `reserved = 1`.
 * Follow-up : (sequential, after the row is COMPLETED) the same key + same body replays the
 *             same order; the same key + a DIFFERENT body is 409 `IDEMPOTENCY_CONFLICT` /
 *             `PAYLOAD_MISMATCH`; still one order.
 *
 * Why this needs a real database: the guarantee rests on the SQL-only unique index
 * `(owner_key, scope, idem_key)` with the generated `owner_key` column — it does not exist in
 * the mocked Prisma client.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seedCatalog, seedCustomers, seedReference } from '../harness/fixtures.js';
import { placeOrder, readPlacedOrder, tallyResults } from '../harness/http.js';
import { eventually, evidence, fulfilled, race, rejected } from '../harness/race.js';
import { at, prepareBuyers } from '../harness/scenario.js';
import { assertDbTestGuard, openWorld, scenarioTimeout, type DbWorld } from '../harness/world.js';

const TC = 'TC-048';
const PARALLEL_REQUESTS = 5;
const STOCK = 5;

describe('TC-048 Idempotency-Key concurrent replay (CC-08) — real MySQL', () => {
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
    const catalog = await seedCatalog(db, { onHand: STOCK });
    const customers = await seedCustomers(db, 1, { variantId: catalog.variantId });
    const buyer = at(
      await prepareBuyers(w, customers, {
        shippingMethodId: catalog.shippingMethodId,
        paymentMethod: 'ONLINE',
      }),
      0,
    );
    const key = randomUUID();

    const settled = await race(PARALLEL_REQUESTS, () =>
      placeOrder(w, buyer.session, key, buyer.order),
    );
    const responses = fulfilled(settled);
    const executed = responses.filter((r) => r.status === 201 && !r.replayed);
    const replays = responses.filter((r) => r.status === 201 && r.replayed);
    const conflicts = responses.filter((r) => r.status === 409);
    const first = executed[0] === undefined ? null : readPlacedOrder(executed[0]);

    // The idempotency row is completed after the response is sent (fire-and-forget).
    const completed = await eventually(
      async () =>
        (await db.idempotencyKey.count({ where: { idemKey: key, status: 'COMPLETED' } })) === 1,
    );

    // Follow-up (sequential): replay, then payload mismatch with the same key.
    const replay = await placeOrder(w, buyer.session, key, buyer.order);
    const mismatch = await placeOrder(w, buyer.session, key, {
      ...buyer.order,
      customerNote: 'different body, same key',
    });

    const [orders, keys, payments, reservations, inventory] = await Promise.all([
      db.order.findMany({
        where: { userId: buyer.customer.userId },
        select: { id: true, orderNumber: true },
      }),
      db.idempotencyKey.findMany({
        where: { idemKey: key },
        select: { status: true, userId: true, scope: true },
      }),
      db.payment.count(),
      db.stockReservation.findMany({ select: { quantity: true, status: true } }),
      db.inventory.findUnique({
        where: { variantId: catalog.variantId },
        select: { quantityOnHand: true, quantityReserved: true },
      }),
    ]);

    evidence(TC, {
      iteration: n,
      parallel: PARALLEL_REQUESTS,
      outcomes: tallyResults(responses),
      detailCodes: conflicts.map((c) => c.detailCode),
      transportErrors: rejected(settled).length,
      orders: orders.length,
      idempotencyRows: keys.map((k) => k.status),
      completedInTime: completed,
      sequentialReplay: { status: replay.status, replayed: replay.replayed },
      payloadMismatch: {
        status: mismatch.status,
        code: mismatch.code,
        detail: mismatch.detailCode,
      },
      reserved: inventory?.quantityReserved ?? null,
    });

    const label = `${TC} iteration ${String(n)}`;
    expect(rejected(settled), `${label}: transport errors`).toHaveLength(0);
    expect(orders, `${label}: ONE order`).toHaveLength(1);
    expect(executed, `${label}: exactly one request executes the handler`).toHaveLength(1);
    expect(first, `${label}: the executed request returns the order`).not.toBeNull();
    expect(orders[0]?.id, label).toBe(first?.orderId);
    expect(
      executed.length + replays.length + conflicts.length,
      `${label}: only 201 / 201-replayed / 409 outcomes`,
    ).toBe(PARALLEL_REQUESTS);
    for (const r of replays) {
      expect(readPlacedOrder(r)?.orderId, `${label}: replay returns the same order`).toBe(
        first?.orderId,
      );
    }
    for (const r of conflicts) {
      expect({ code: r.code, detail: r.detailCode }, label).toEqual({
        code: 'IDEMPOTENCY_CONFLICT',
        detail: 'IN_PROGRESS',
      });
    }

    expect(keys, `${label}: one idempotency_keys row`).toEqual([
      {
        status: 'COMPLETED',
        userId: buyer.customer.userId,
        scope: 'POST /api/v1/checkout/orders',
      },
    ]);
    expect(payments, label).toBe(1);
    expect(reservations, label).toEqual([{ quantity: 1, status: 'ACTIVE' }]);
    expect(inventory, label).toEqual({ quantityOnHand: STOCK, quantityReserved: 1 });

    expect(
      { status: replay.status, replayed: replay.replayed },
      `${label}: sequential replay`,
    ).toEqual({ status: 201, replayed: true });
    expect(readPlacedOrder(replay), label).toEqual(first);
    expect(
      { status: mismatch.status, code: mismatch.code, detail: mismatch.detailCode },
      `${label}: same key, different body`,
    ).toEqual({ status: 409, code: 'IDEMPOTENCY_CONFLICT', detail: 'PAYLOAD_MISMATCH' });
  }

  it(
    '5 parallel requests with one Idempotency-Key create one order',
    { timeout: scenarioTimeout(60_000) },
    async () => {
      if (world === undefined) throw new Error('world not initialised');
      for (let n = 1; n <= world.iterations; n += 1) await iteration(world, n);
    },
  );
});
