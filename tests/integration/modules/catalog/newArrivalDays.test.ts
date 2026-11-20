/**
 * FR-AD-008 — `catalog.new_arrival_days` drives the public new-arrival window (badge + the
 * `isNewArrival=true` filter); 30 days when the setting is missing or invalid. MOCKED DB.
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createCatalogModule } from '../../../../src/modules/catalog/index.js';
import { buildModuleTestApp, type ModuleTestApp } from '../../../helpers/container.js';
import { cardRow, primeEmptyDb } from '../products/fixtures.js';

const NOW = new Date('2026-11-19T06:30:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
/** 49 days before NOW: new under a 60-day window, not under the 30-day default. */
const PUBLISHED = new Date('2026-10-01T06:30:00.000Z');

let t: ModuleTestApp;

beforeEach(() => {
  t = buildModuleTestApp([createCatalogModule], { now: NOW });
  primeEmptyDb(t.m);
});

function primeSetting(value: unknown): void {
  t.m.setting.findUnique.mockImplementation((args: { where: { settingKey: string } }) =>
    Promise.resolve(
      args.where.settingKey === 'catalog.new_arrival_days' && value !== undefined
        ? { value }
        : null,
    ),
  );
}

interface Where {
  AND: Record<string, unknown>[];
}

async function listWith(query: Record<string, string> = {}) {
  t.m.product.findMany.mockResolvedValue([
    cardRow({ isBestSellerPinned: false, publishedAt: PUBLISHED }),
  ]);
  t.m.product.count.mockResolvedValue(1);
  const res = await request(t.app).get('/api/v1/products').query(query);
  expect(res.status).toBe(200);
  const where = t.m.product.findMany.mock.calls.at(-1)?.[0].where as Where;
  return { badges: res.body.data[0].badges as string[], where };
}

function newArrivalClause(where: Where) {
  return where.AND.find((c) => 'OR' in c && JSON.stringify(c).includes('isNewArrival'));
}

describe('FR-AD-008 catalog.new_arrival_days', () => {
  it('honours a configured window for the NEW_ARRIVAL badge and the isNewArrival filter', async () => {
    primeSetting(60);
    const { badges, where } = await listWith({ isNewArrival: 'true' });
    expect(badges).toContain('NEW_ARRIVAL');
    expect(newArrivalClause(where)).toEqual({
      OR: [{ isNewArrival: true }, { publishedAt: { gte: new Date(NOW.getTime() - 60 * DAY_MS) } }],
    });
    expect(t.m.setting.findUnique).toHaveBeenCalledWith({
      where: { settingKey: 'catalog.new_arrival_days' },
      select: { value: true },
    });
  });

  it('a shorter configured window drops the badge from older products', async () => {
    primeSetting(7);
    const { badges, where } = await listWith({ isNewArrival: 'true' });
    expect(badges).not.toContain('NEW_ARRIVAL');
    expect(newArrivalClause(where)).toEqual({
      OR: [{ isNewArrival: true }, { publishedAt: { gte: new Date(NOW.getTime() - 7 * DAY_MS) } }],
    });
  });

  it.each([undefined, 0, 366, 12.5, '60', null])(
    'falls back to 30 days when the setting is %s',
    async (value) => {
      primeSetting(value);
      const { badges, where } = await listWith({ isNewArrival: 'true' });
      expect(badges).not.toContain('NEW_ARRIVAL');
      expect(newArrivalClause(where)).toEqual({
        OR: [
          { isNewArrival: true },
          { publishedAt: { gte: new Date(NOW.getTime() - 30 * DAY_MS) } },
        ],
      });
    },
  );
});
