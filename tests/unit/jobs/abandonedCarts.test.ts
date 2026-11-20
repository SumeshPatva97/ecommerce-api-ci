/**
 * abandoned-carts job (RD-08 option B). MOCKED DB: an in-memory carts table whose findMany /
 * updateMany / deleteMany honour the job's where-clauses, so cut-offs, compare-and-set guards and
 * re-runs are exercised. It cannot prove MySQL locking, isolation or the ON DELETE CASCADE of
 * cart_items (asserted separately against the baseline migration).
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { runAbandonedCarts } from '../../../src/jobs/abandonedCarts.js';
import { buildModuleTestApp } from '../../helpers/container.js';

const NOW = new Date('2026-11-20T06:30:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

interface Row {
  id: string;
  status: 'ACTIVE' | 'ABANDONED' | 'CONVERTED';
  lastActivityAt: Date;
  abandonedAt: Date | null;
}
interface Where {
  id?: { in?: string[] };
  status?: string;
  lastActivityAt?: { lt: Date };
  abandonedAt?: { lt: Date };
}

function setup(rows: Row[], setting?: unknown) {
  const t = buildModuleTestApp([], { now: NOW });
  const table = rows.map((r) => ({ ...r }));
  const match = (r: Row, w: Where) =>
    (w.id?.in === undefined || w.id.in.includes(r.id)) &&
    (w.status === undefined || r.status === w.status) &&
    (w.lastActivityAt === undefined || r.lastActivityAt < w.lastActivityAt.lt) &&
    (w.abandonedAt === undefined || (r.abandonedAt !== null && r.abandonedAt < w.abandonedAt.lt));
  t.m.setting.findUnique.mockResolvedValue(setting === undefined ? null : { value: setting });
  t.m.cart.findMany.mockImplementation((args: { where: Where; take: number }) =>
    Promise.resolve(
      table
        .filter((r) => match(r, args.where))
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, args.take)
        .map((r) => ({ id: r.id })),
    ),
  );
  t.m.cart.updateMany.mockImplementation((args: { where: Where; data: Partial<Row> }) => {
    const hit = table.filter((r) => match(r, args.where));
    for (const r of hit) Object.assign(r, args.data);
    return Promise.resolve({ count: hit.length });
  });
  t.m.cart.deleteMany.mockImplementation((args: { where: Where }) => {
    const hit = table.filter((r) => match(r, args.where));
    for (const r of hit) table.splice(table.indexOf(r), 1);
    return Promise.resolve({ count: hit.length });
  });
  const status = (id: string) => table.find((r) => r.id === id)?.status ?? 'DELETED';
  return { t, table, status };
}

const row = (id: string, status: Row['status'], lastDays: number, abandonedDays?: number): Row => ({
  id,
  status,
  lastActivityAt: daysAgo(lastDays),
  abandonedAt: abandonedDays === undefined ? null : daysAgo(abandonedDays),
});

describe('runAbandonedCarts', () => {
  it('abandons ACTIVE carts idle more than 30 days, never earlier, and never other statuses', async () => {
    const { t, status, table } = setup([
      row('a-old', 'ACTIVE', 31),
      row('b-edge', 'ACTIVE', 29.99),
      row('c-new', 'ACTIVE', 1),
      row('d-conv', 'CONVERTED', 200),
    ]);
    const summary = await runAbandonedCarts(t.container);
    expect(summary).toEqual({ abandonAfterDays: 30, abandoned: 1, purged: 0 });
    expect([status('a-old'), status('b-edge'), status('c-new'), status('d-conv')]).toEqual([
      'ABANDONED',
      'ACTIVE',
      'ACTIVE',
      'CONVERTED',
    ]);
    expect(table.find((r) => r.id === 'a-old')?.abandonedAt).toEqual(NOW);
  });

  it('purges ABANDONED carts 90+ days after abandonment; ACTIVE and CONVERTED carts are never deleted', async () => {
    const { t, status } = setup([
      row('a-purge', 'ABANDONED', 200, 91),
      row('b-keep', 'ABANDONED', 150, 89),
      row('c-active-old', 'ACTIVE', 5, 400), // reactivated cart that still carries an old date
      row('d-conv', 'CONVERTED', 500, 400),
    ]);
    const summary = await runAbandonedCarts(t.container);
    expect(summary.purged).toBe(1);
    expect([status('a-purge'), status('b-keep'), status('c-active-old'), status('d-conv')]).toEqual(
      ['DELETED', 'ABANDONED', 'ACTIVE', 'CONVERTED'],
    );
    for (const call of t.m.cart.deleteMany.mock.calls) {
      expect((call[0] as { where: Where }).where.status).toBe('ABANDONED');
    }
  });

  it('is safe to run repeatedly: the second run changes nothing', async () => {
    const { t, table } = setup([row('a', 'ACTIVE', 45), row('b', 'ABANDONED', 300, 120)]);
    const first = await runAbandonedCarts(t.container);
    expect(first).toMatchObject({ abandoned: 1, purged: 1 });
    const snapshot = JSON.stringify(table);
    const second = await runAbandonedCarts(t.container);
    expect(second).toMatchObject({ abandoned: 0, purged: 0 });
    expect(JSON.stringify(table)).toBe(snapshot);
  });

  it('compare-and-set: a cart used or reactivated between read and write is not touched', async () => {
    const { t, table, status } = setup([row('a', 'ACTIVE', 40), row('b', 'ABANDONED', 300, 100)]);
    // Between the job's SELECT and its UPDATE/DELETE: the customer touches cart "a" and cart "b" is
    // reactivated. The real findMany ran first; then the rows change.
    const realFindMany = t.m.cart.findMany.getMockImplementation();
    t.m.cart.findMany.mockImplementation(async (args: { where: Where; take: number }) => {
      const result = (await realFindMany?.(args)) as { id: string }[];
      for (const r of table) {
        if (r.id === 'a') r.lastActivityAt = NOW;
        if (r.id === 'b') Object.assign(r, { status: 'ACTIVE', abandonedAt: null });
      }
      return result;
    });
    const summary = await runAbandonedCarts(t.container);
    expect(summary).toMatchObject({ abandoned: 0, purged: 0 });
    expect([status('a'), status('b')]).toEqual(['ACTIVE', 'ACTIVE']);
  });

  it('honours cart.abandon_after_days and falls back to 30 for an invalid value', async () => {
    const custom = setup([row('a', 'ACTIVE', 40), row('b', 'ACTIVE', 50)], 45);
    expect(await runAbandonedCarts(custom.t.container)).toMatchObject({
      abandonAfterDays: 45,
      abandoned: 1,
    });
    const invalid = setup([row('a', 'ACTIVE', 40)], 0);
    expect(await runAbandonedCarts(invalid.t.container)).toMatchObject({
      abandonAfterDays: 30,
      abandoned: 1,
    });
  });

  it('works in bounded batches and continues on the next run', async () => {
    const rows = Array.from({ length: 7 }, (_, i) => row(`c${String(i)}`, 'ACTIVE', 60));
    const { t, table } = setup(rows);
    const first = await runAbandonedCarts(t.container, { batchSize: 2, maxBatches: 2 });
    expect(first.abandoned).toBe(4);
    const second = await runAbandonedCarts(t.container, { batchSize: 2, maxBatches: 2 });
    expect(second.abandoned).toBe(3);
    expect(table.every((r) => r.status === 'ABANDONED')).toBe(true);
  });

  it('WP10-6 exact boundary: idle exactly 30 days is kept; 1 ms more is abandoned', async () => {
    const DAY = 86_400_000;
    const at = (ms: number) => new Date(NOW.getTime() - ms);
    const { t, status } = setup([
      {
        id: 'a-30d-minus-1ms',
        status: 'ACTIVE',
        lastActivityAt: at(30 * DAY - 1),
        abandonedAt: null,
      },
      { id: 'b-30d-exact', status: 'ACTIVE', lastActivityAt: at(30 * DAY), abandonedAt: null },
      {
        id: 'c-30d-plus-1ms',
        status: 'ACTIVE',
        lastActivityAt: at(30 * DAY + 1),
        abandonedAt: null,
      },
    ]);
    const summary = await runAbandonedCarts(t.container);
    expect(summary).toEqual({ abandonAfterDays: 30, abandoned: 1, purged: 0 });
    expect([status('a-30d-minus-1ms'), status('b-30d-exact'), status('c-30d-plus-1ms')]).toEqual([
      'ACTIVE',
      'ACTIVE',
      'ABANDONED',
    ]);
    // The cut-off is exactly now − 30 days and strict ("older than"), in both read and write.
    const cutoff = at(30 * DAY);
    expect(t.m.cart.findMany.mock.calls[0]?.[0].where).toEqual({
      status: 'ACTIVE',
      lastActivityAt: { lt: cutoff },
    });
    expect(t.m.cart.updateMany.mock.calls[0]?.[0].where).toMatchObject({
      status: 'ACTIVE',
      lastActivityAt: { lt: cutoff },
    });
  });

  it('WP10-6 exact boundary: abandoned exactly 90 days is kept; 1 ms more is purged', async () => {
    const DAY = 86_400_000;
    const at = (ms: number) => new Date(NOW.getTime() - ms);
    const { t, status } = setup([
      {
        id: 'a-90d-minus-1ms',
        status: 'ABANDONED',
        lastActivityAt: at(400 * DAY),
        abandonedAt: at(90 * DAY - 1),
      },
      {
        id: 'b-90d-exact',
        status: 'ABANDONED',
        lastActivityAt: at(400 * DAY),
        abandonedAt: at(90 * DAY),
      },
      {
        id: 'c-90d-plus-1ms',
        status: 'ABANDONED',
        lastActivityAt: at(400 * DAY),
        abandonedAt: at(90 * DAY + 1),
      },
    ]);
    const summary = await runAbandonedCarts(t.container);
    expect(summary).toEqual({ abandonAfterDays: 30, abandoned: 0, purged: 1 });
    expect([status('a-90d-minus-1ms'), status('b-90d-exact'), status('c-90d-plus-1ms')]).toEqual([
      'ABANDONED',
      'ABANDONED',
      'DELETED',
    ]);
    // Purge age is measured from abandoned_at (not last activity), strictly older than 90 days.
    const cutoff = at(90 * DAY);
    const purgeRead = t.m.cart.findMany.mock.calls
      .map((c) => (c[0] as { where: Where }).where)
      .find((w) => w.status === 'ABANDONED');
    expect(purgeRead).toEqual({ status: 'ABANDONED', abandonedAt: { lt: cutoff } });
    expect(t.m.cart.deleteMany.mock.calls[0]?.[0].where).toMatchObject({
      status: 'ABANDONED',
      abandonedAt: { lt: cutoff },
    });
  });

  it('WP10-6 boundary with a configured window: exactly N days is kept, N days + 1 ms abandoned', async () => {
    const DAY = 86_400_000;
    const at = (ms: number) => new Date(NOW.getTime() - ms);
    const { t, status } = setup(
      [
        { id: 'a-exact', status: 'ACTIVE', lastActivityAt: at(7 * DAY), abandonedAt: null },
        { id: 'b-over', status: 'ACTIVE', lastActivityAt: at(7 * DAY + 1), abandonedAt: null },
      ],
      7,
    );
    expect(await runAbandonedCarts(t.container)).toMatchObject({
      abandonAfterDays: 7,
      abandoned: 1,
    });
    expect([status('a-exact'), status('b-over')]).toEqual(['ACTIVE', 'ABANDONED']);
  });

  it('relies on the baseline migration for item cleanup and order safety (static check)', () => {
    const sql = readFileSync('prisma/migrations/20261117160425_baseline/migration.sql', 'utf8');
    // cart_items go with their cart …
    expect(sql).toMatch(
      /`cart_items_cart_id_fkey` FOREIGN KEY \(`cart_id`\) REFERENCES `carts`\(`id`\) ON DELETE CASCADE/,
    );
    // … no other table references carts …
    expect(sql.match(/REFERENCES `carts`/g)).toHaveLength(1);
    // … and one ACTIVE cart per user is a database guarantee.
    expect(sql).toMatch(/UNIQUE INDEX `uq_carts_active_owner` \(`active_owner_key`\)/);
  });
});
