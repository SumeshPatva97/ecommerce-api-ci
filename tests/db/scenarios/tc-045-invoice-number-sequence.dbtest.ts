/**
 * TC-045 — Invoice (`INV/<FY>/000001`) and credit-note (`CN/<FY>/000001`) numbers are gap-free
 * and unique per financial year under concurrency (TESTING_STRATEGY §8 CC-05 / CC-06, P1;
 * PROJECT_CONTEXT §15 R-09).
 *
 * NOT EXECUTED — requires explicit owner authorization (DEC-12). Runs ONLY through
 * `tests/db/vitest.db.config.ts` against `ecommerce_test` (see tests/db/README.md).
 *
 * Driven through the REAL numbering code: `issueInvoiceForOrder` / `issueCreditNote`
 * (`allocateNumber` on `number_sequences` with `SELECT … FOR UPDATE`) inside `withTransaction`
 * with the same options as the production callers (order → SHIPPED, cancellation / refund
 * approval): no deadlock retry. Orders are real COD orders placed through the checkout service
 * (CONFIRMED, invoiceable). The full "mark shipped" / "approve refund" HTTP flows are not driven
 * here; the numbering transaction they run is.
 *
 * Per document kind, per iteration (20 orders + 3 probe orders):
 *   Phase 1 — cold start : 10 parallel issuances while NO sequence row exists for the FY.
 *             Allowed outcomes: issued, or 409-style `CONFLICT` (InnoDB deadlock on the first
 *             insert of the period row, surfaced by `withTransaction`). Whatever committed must
 *             already be gap-free from 000001. Refused orders are then issued sequentially.
 *   Phase 2 — warm       : one burst of 10 further issuances + 3 transactions that allocate a
 *             number and then ROLL BACK + 3 repeated requests for already-numbered orders.
 *             STRICT: all 10 issue; a rolled-back transaction consumes no number; a repeated
 *             request creates nothing.
 *   Phase 3 — the 3 probe orders are issued for real: the series continues without a gap.
 * Invariant : numbers are exactly `<PREFIX>/<FY>/000001 … 0000NN` — distinct, consecutive, no
 *             gaps; `sequence_no` matches; `number_sequences.next_value = NN + 1`; exactly one
 *             document of the kind per order.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { formatSequence, periodKeyFor } from '../../../src/core/db/sequences.js';
import { withTransaction } from '../../../src/core/db/transaction.js';
import { createCheckoutService } from '../../../src/modules/checkout/index.js';
import {
  issueCreditNote,
  issueInvoiceForOrder,
  type IssuedDocument,
} from '../../../src/modules/invoices/index.js';
import { lockOrder } from '../../../src/modules/payments/index.js';
import { seedCatalog, seedCustomers, seedReference } from '../harness/fixtures.js';
import { requestMeta } from '../harness/http.js';
import { errorLabel, evidence, race, tally, type Settled } from '../harness/race.js';
import { at } from '../harness/scenario.js';
import { assertDbTestGuard, openWorld, scenarioTimeout, type DbWorld } from '../harness/world.js';

const TC = 'TC-045';
const ORDERS = 20;
const COLD_PARALLEL = 10;
const PROBES = 3;
const DUPLICATES = 3;

type Kind = 'INVOICE' | 'CREDIT_NOTE';
const DOCUMENT_TYPE = { INVOICE: 'TAX_INVOICE', CREDIT_NOTE: 'CREDIT_NOTE' } as const;

/** Thrown on purpose after a number was allocated, to roll the transaction back. */
class RollbackProbe extends Error {
  constructor() {
    super('deliberate rollback after number allocation');
    this.name = 'RollbackProbe';
  }
}

interface WarmOperation {
  readonly type: 'issue' | 'rollback' | 'duplicate';
  readonly orderId: string;
}

describe('TC-045 gap-free invoice / credit-note numbers (CC-05, CC-06) — real MySQL', () => {
  let world: DbWorld | undefined;

  beforeAll(async () => {
    assertDbTestGuard();
    world = await openWorld();
  });

  afterAll(async () => {
    await world?.close();
  });

  /** Places `count` real COD orders (CONFIRMED on placement) and returns their ids. */
  async function placeCodOrders(w: DbWorld, count: number): Promise<string[]> {
    const { db } = w;
    await seedReference(db, { codEnabled: true });
    const catalog = await seedCatalog(db, { onHand: count + 5, codSupported: true });
    const customers = await seedCustomers(db, count, { variantId: catalog.variantId });
    const checkout = createCheckoutService(w.container);
    const meta = requestMeta();
    const orderIds: string[] = [];
    for (const customer of customers) {
      const selection = {
        shippingAddressId: customer.addressId,
        shippingMethodId: catalog.shippingMethodId,
        paymentMethod: 'COD' as const,
      };
      const quote = await checkout.summary(customer.userId, selection);
      const placed = await checkout.placeOrder(
        customer.userId,
        { ...selection, quoteHash: quote.quoteHash, acceptTerms: true },
        { ip: meta.ip, userAgent: meta.userAgent },
      );
      if (placed.order.status !== 'CONFIRMED') {
        throw new Error(`${TC}: expected a CONFIRMED COD order, got ${placed.order.status}`);
      }
      orderIds.push(placed.order.id);
    }
    return orderIds;
  }

  function issue(
    w: DbWorld,
    kind: Kind,
    orderId: string,
    now: Date,
    rollback = false,
  ): Promise<IssuedDocument | null> {
    return withTransaction(w.db, async ({ tx }) => {
      let document: IssuedDocument | null;
      if (kind === 'INVOICE') {
        document = await issueInvoiceForOrder(tx, orderId, now);
      } else {
        // Callers of issueCreditNote hold the order row lock (cancellation / refund approval).
        await lockOrder(tx, orderId);
        document = await issueCreditNote(tx, {
          orderId,
          refundId: null,
          scope: { kind: 'FULL' },
          now,
        });
      }
      if (rollback) throw new RollbackProbe();
      return document;
    });
  }

  function documents(w: DbWorld, kind: Kind, financialYear: string) {
    return w.db.invoiceRecord.findMany({
      where: { invoiceType: DOCUMENT_TYPE[kind], financialYear },
      orderBy: { sequenceNo: 'asc' },
      select: { invoiceNumber: true, sequenceNo: true, orderId: true },
    });
  }

  function expectGapFree(
    rows: readonly { invoiceNumber: string; sequenceNo: number }[],
    kind: Kind,
    periodKey: string,
    count: number,
    label: string,
  ): void {
    const sequence = Array.from({ length: count }, (_unused, index) => index + 1);
    expect(
      rows.map((r) => r.sequenceNo),
      `${label}: sequence_no 1…${String(count)} without gaps`,
    ).toEqual(sequence);
    expect(
      rows.map((r) => r.invoiceNumber),
      `${label}: consecutive numbers`,
    ).toEqual(sequence.map((value) => formatSequence(kind, periodKey, value)));
  }

  async function series(
    w: DbWorld,
    n: number,
    kind: Kind,
    orderIds: readonly string[],
    probeIds: readonly string[],
    now: Date,
  ): Promise<void> {
    const periodKey = periodKeyFor(kind, now);
    const label = `${TC} ${kind} iteration ${String(n)}`;
    const cold = orderIds.slice(0, COLD_PARALLEL);
    const warm = orderIds.slice(COLD_PARALLEL);

    // Phase 1 — cold start (no number_sequences row for this kind / financial year yet).
    const coldSettled = await race(cold.length, (index) => issue(w, kind, at(cold, index), now));
    const afterCold = await documents(w, kind, periodKey);
    const coldIssued = coldSettled.filter((s) => s.ok).length;
    const coldRefused = coldSettled.flatMap((s) => (s.ok ? [] : [errorLabel(s.error)]));
    const retried: (IssuedDocument | null)[] = [];
    for (const [index, settled] of coldSettled.entries()) {
      if (!settled.ok) retried.push(await issue(w, kind, at(cold, index), now));
    }
    const afterRetry = await documents(w, kind, periodKey);

    // Phase 2 — warm burst: issuances + rolled-back allocations + repeated requests.
    const operations: WarmOperation[] = [
      ...warm.map((orderId) => ({ type: 'issue' as const, orderId })),
      ...probeIds.map((orderId) => ({ type: 'rollback' as const, orderId })),
      ...cold.slice(0, DUPLICATES).map((orderId) => ({ type: 'duplicate' as const, orderId })),
    ];
    const warmSettled = await race(operations.length, (index) => {
      const operation = at(operations, index);
      return issue(w, kind, operation.orderId, now, operation.type === 'rollback');
    });
    const afterWarm = await documents(w, kind, periodKey);
    const of = (type: WarmOperation['type']): Settled<IssuedDocument | null>[] =>
      warmSettled.filter((_unused, index) => at(operations, index).type === type);

    // Phase 3 — the probe orders for real (sequential): the series continues without a gap.
    for (const orderId of probeIds) await issue(w, kind, orderId, now);
    const final = await documents(w, kind, periodKey);
    const sequenceRow = await w.db.numberSequence.findUnique({
      where: { sequenceKey_periodKey: { sequenceKey: kind, periodKey } },
      select: { nextValue: true, isGapFree: true },
    });

    evidence(TC, {
      iteration: n,
      kind,
      financialYear: periodKey,
      cold: { parallel: cold.length, outcomes: tally(coldSettled), committed: afterCold.length },
      warm: {
        parallel: operations.length,
        issue: tally(of('issue')),
        rollback: tally(of('rollback')),
        duplicate: tally(of('duplicate')),
        committed: afterWarm.length,
      },
      first: final[0]?.invoiceNumber ?? null,
      last: final.at(-1)?.invoiceNumber ?? null,
      documents: final.length,
      nextValue: sequenceRow?.nextValue ?? null,
    });

    // Phase 1 assertions.
    expect(coldIssued, `${label}: at least one cold-start issuance commits`).toBeGreaterThan(0);
    expect(coldRefused, `${label}: cold-start refusals are CONFLICT only`).toEqual(
      coldRefused.map(() => 'CONFLICT'),
    );
    expectGapFree(afterCold, kind, periodKey, coldIssued, `${label} after cold start`);
    expect(
      retried.every((d) => d?.created === true),
      `${label}: refused orders are issued on a sequential retry`,
    ).toBe(true);
    expectGapFree(afterRetry, kind, periodKey, cold.length, `${label} after cold retries`);

    // Phase 2 assertions (strict).
    expect(tally(of('issue')), `${label}: every warm issuance commits`).toEqual({
      ok: warm.length,
    });
    for (const settled of of('issue')) {
      expect(settled.ok && settled.value?.created, `${label}: a new document`).toBe(true);
    }
    expect(tally(of('rollback')), `${label}: probes rolled back`).toEqual({
      RollbackProbe: probeIds.length,
    });
    expect(tally(of('duplicate')), `${label}: repeated requests answer`).toEqual({
      ok: Math.min(DUPLICATES, cold.length),
    });
    for (const settled of of('duplicate')) {
      // INVOICE: the existing document (`created: false`); CREDIT_NOTE: nothing left to credit.
      expect(settled.ok && settled.value?.created === true, `${label}: nothing new`).toBe(false);
    }
    expectGapFree(afterWarm, kind, periodKey, orderIds.length, `${label} after the warm burst`);
    expect(
      afterWarm.filter((d) => probeIds.includes(d.orderId)),
      `${label}: a rolled-back transaction leaves no document and consumes no number`,
    ).toHaveLength(0);

    // Final assertions.
    const total = orderIds.length + probeIds.length;
    expectGapFree(final, kind, periodKey, total, `${label} final`);
    expect(new Set(final.map((d) => d.orderId)).size, `${label}: one document per order`).toBe(
      total,
    );
    expect(sequenceRow, `${label}: number_sequences`).toEqual({
      nextValue: total + 1,
      isGapFree: true,
    });
  }

  async function iteration(w: DbWorld, n: number): Promise<void> {
    await w.reset();
    const all = await placeCodOrders(w, ORDERS + PROBES);
    const orderIds = all.slice(0, ORDERS);
    const probeIds = all.slice(ORDERS);
    // One instant for the whole iteration so every document falls in the same financial year.
    const now = w.container.clock();
    await series(w, n, 'INVOICE', orderIds, probeIds, now);
    await series(w, n, 'CREDIT_NOTE', orderIds, probeIds, now);
  }

  it(
    'INV/ and CN/ numbers stay consecutive under parallel issuance and rollbacks',
    { timeout: scenarioTimeout(180_000) },
    async () => {
      if (world === undefined) throw new Error('world not initialised');
      for (let n = 1; n <= world.iterations; n += 1) await iteration(world, n);
    },
  );
});
