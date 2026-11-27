/**
 * DEC-12 concurrency helpers (tests/db/harness/race.ts) — pure, no database.
 */
import { describe, expect, it } from 'vitest';

import { AppError } from '../../../src/core/errors/AppError.js';
import {
  detailCode,
  errorLabel,
  eventually,
  fulfilled,
  race,
  raceAll,
  rejected,
  tally,
} from '../../db/harness/race.js';

describe('DEC-12 race helpers', () => {
  it('releases every operation through one barrier and settles all of them', async () => {
    let started = 0;
    let startedWhenFirstContinued = -1;
    const results = await race(8, async (index) => {
      started += 1;
      await Promise.resolve();
      // Every operation was started before the first one continued past its first await.
      if (startedWhenFirstContinued === -1) startedWhenFirstContinued = started;
      if (index % 2 === 1) throw new AppError('INSUFFICIENT_STOCK');
      return index;
    });
    expect(startedWhenFirstContinued).toBe(8);
    expect(results).toHaveLength(8);
    expect(fulfilled(results)).toEqual([0, 2, 4, 6]);
    expect(rejected(results)).toHaveLength(4);
    expect(tally(results)).toEqual({ ok: 4, INSUFFICIENT_STOCK: 4 });
    expect(results.every((r) => r.ms >= 0)).toBe(true);
  });

  it('keeps results in call order (index → result)', async () => {
    const results = await race(3, (index) => Promise.resolve(`r${String(index)}`));
    expect(fulfilled(results)).toEqual(['r0', 'r1', 'r2']);
  });

  it('raceAll runs heterogeneous operations and captures rejections', async () => {
    const results = await raceAll([
      () => Promise.resolve('a'),
      () => Promise.reject(new TypeError('boom')),
    ]);
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(tally(results)).toEqual({ ok: 1, TypeError: 1 });
  });

  it('labels errors without leaking their messages', () => {
    const prismaLike = Object.assign(new Error('Unique constraint failed on secret-value'), {
      code: 'P2002',
      clientVersion: '7.10.1',
    });
    expect(errorLabel(new AppError('COUPON_INVALID', 'private text'))).toBe('COUPON_INVALID');
    expect(errorLabel(prismaLike)).toBe('PRISMA_P2002');
    expect(errorLabel(new RangeError('private text'))).toBe('RangeError');
    expect(errorLabel('a string')).toBe('UNKNOWN');
    expect(
      detailCode(
        new AppError('IDEMPOTENCY_CONFLICT', undefined, {
          details: [{ code: 'IN_PROGRESS', message: 'Retry shortly.' }],
        }),
      ),
    ).toBe('IN_PROGRESS');
    expect(detailCode(new Error('x'))).toBeUndefined();
  });

  it('eventually polls until the condition holds or the timeout elapses', async () => {
    let calls = 0;
    const ok = await eventually(
      () => {
        calls += 1;
        return Promise.resolve(calls >= 3);
      },
      1_000,
      1,
    );
    expect(ok).toBe(true);
    expect(calls).toBe(3);
    expect(await eventually(() => Promise.resolve(false), 20, 5)).toBe(false);
  });
});
