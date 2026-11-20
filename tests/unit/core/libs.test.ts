import { describe, expect, it } from 'vitest';

import { formatSequence, periodKeyFor } from '../../../src/core/db/sequences.js';
import { isDeadlock, withTransaction } from '../../../src/core/db/transaction.js';
import { mapPrismaError } from '../../../src/core/errors/prismaErrorMapper.js';
import { canonicalJson, requestHash } from '../../../src/core/middleware/idempotency.js';
import { RATE_CLASSES } from '../../../src/core/middleware/routeRateLimit.js';
import { createMemoryStore } from '../../../src/core/store/memoryStore.js';
import {
  dec,
  sum,
  toMinorUnits,
  toMoneyString,
  toMoneyStringOrNull,
} from '../../../src/lib/money.js';
import {
  normalizeCode,
  normalizeEmail,
  normalizePhone,
  normalizeText,
} from '../../../src/lib/normalize.js';
import {
  PERMISSIONS,
  isCriticalPermission,
  templatePermissions,
} from '../../../src/lib/permissions.js';
import { computeDiff, maskEmail, maskPhone, redact, REDACTED } from '../../../src/lib/redact.js';
import { slugify, uniqueSlug } from '../../../src/lib/slug.js';
import {
  financialYearCode,
  istDateKey,
  istDayRange,
  startOfIstDay,
} from '../../../src/lib/time.js';
import { createMockDb } from '../../helpers/mockDb.js';

describe('normalize (PROJECT_CONTEXT §3.5)', () => {
  it('normalizes text, codes, emails and Indian phones', () => {
    expect(normalizeText('  Gold   Plated  Ring ')).toBe('gold plated ring');
    expect(normalizeCode(' ab-12_c ')).toBe('AB-12_C');
    expect(normalizeEmail(' Riya@Example.COM ')).toBe('riya@example.com');
    expect(normalizePhone('98765 43210')).toBe('+919876543210');
    expect(normalizePhone('09876543210')).toBe('+919876543210');
    expect(normalizePhone('919876543210')).toBe('+919876543210');
    expect(normalizePhone('+91-98765-43210')).toBe('+919876543210');
    expect(normalizePhone('12345')).toBeUndefined();
  });
});

describe('slug', () => {
  it('slugifies and allocates unique suffixes', async () => {
    expect(slugify('  Café — Gold   Earrings!! ')).toBe('cafe-gold-earrings');
    expect(slugify('x'.repeat(200))).toHaveLength(160);
    const taken = new Set(['ring', 'ring-2']);
    await expect(uniqueSlug('Ring', (s) => Promise.resolve(taken.has(s)))).resolves.toBe('ring-3');
    await expect(uniqueSlug('!!!', () => Promise.resolve(false))).resolves.toBe('item');
    await expect(uniqueSlug('a', () => Promise.resolve(true), 3)).rejects.toThrow();
  });
});

describe('money', () => {
  it('rounds half-up to 2 dp and serialises as strings', () => {
    expect(toMoneyString('1499')).toBe('1499.00');
    expect(toMoneyString('2.005')).toBe('2.01');
    expect(toMoneyString(dec('0.1').plus('0.2'))).toBe('0.30');
    expect(sum(['1.10', '2.20', 3]).toFixed(2)).toBe('6.30');
    expect(toMoneyStringOrNull(null)).toBeNull();
    expect(toMinorUnits('1499.50')).toBe(149950);
  });
});

describe('time (IST, FY)', () => {
  it('computes IST day keys and FY codes', () => {
    expect(istDateKey(new Date('2026-11-12T19:00:00Z'))).toBe('261113'); // 00:30 IST next day
    expect(financialYearCode(new Date('2026-11-13T00:00:00Z'))).toBe('2627');
    expect(financialYearCode(new Date('2027-03-31T18:00:00Z'))).toBe('2627'); // 23:30 IST 31 Mar
    expect(financialYearCode(new Date('2027-03-31T18:30:00Z'))).toBe('2728'); // 00:00 IST 1 Apr
    expect(startOfIstDay(new Date('2026-11-13T10:00:00Z')).toISOString()).toBe(
      '2026-11-12T18:30:00.000Z',
    );
    expect(istDayRange('2026-11-13')).toEqual({
      start: new Date('2026-11-12T18:30:00.000Z'),
      end: new Date('2026-11-13T18:30:00.000Z'),
    });
    expect(() => istDayRange('13/11/2026')).toThrow();
  });
});

describe('sequences', () => {
  it('formats canonical business numbers', () => {
    const now = new Date('2026-11-13T05:00:00Z');
    expect(formatSequence('ORDER', periodKeyFor('ORDER', now), 42)).toBe('ORD-261113-00042');
    expect(formatSequence('INVOICE', periodKeyFor('INVOICE', now), 1)).toBe('INV/2627/000001');
    expect(formatSequence('CREDIT_NOTE', '2627', 7)).toBe('CN/2627/000007');
    expect(formatSequence('REFUND', '261113', 3)).toBe('RFD-261113-00003');
    expect(formatSequence('SHIPMENT', '261113', 9)).toBe('SHP-261113-00009');
  });
});

describe('permission catalogue (88 keys)', () => {
  it('has exactly the 88 documented keys with critical flags', () => {
    expect(PERMISSIONS).toHaveLength(88);
    expect(new Set(PERMISSIONS.map((p) => p.key)).size).toBe(88);
    expect(isCriticalPermission('refunds.approve')).toBe(true);
    expect(isCriticalPermission('orders.view')).toBe(false);
    expect(PERMISSIONS.some((p) => p.key === 'audit_logs.update')).toBe(false);
    expect(PERMISSIONS.filter((p) => p.isReserved).map((p) => p.key)).toEqual([
      'orders.create',
      'orders.delete',
      'customers.create',
      'refunds.delete',
      'reviews.create',
    ]);
  });

  it('builds role templates from the §5 grid', () => {
    const staff = templatePermissions('STAFF');
    expect(staff).toContain('inventory.create');
    expect(staff).not.toContain('refunds.view');
    expect(templatePermissions('MANAGER')).toContain('orders.approve');
    expect(templatePermissions('MANAGER')).not.toContain('refunds.approve');
    expect(templatePermissions('EMPLOYEE')).toContain('reviews.approve');
  });
});

describe('redaction & diff', () => {
  it('drops secrets at any depth, masks phones/streets, serialises decimals', () => {
    const out = redact({
      password: 'x',
      nested: { refreshToken: 'y', apiKey: 'z', ok: 1 },
      phone: '+919876543210',
      line1: '12 MG Road',
      price: dec('10.50'),
      at: new Date('2026-01-01T00:00:00Z'),
      list: [{ otpCode: '123456' }],
    }) as Record<string, unknown>;
    expect(out.password).toBe(REDACTED);
    expect(out.nested).toEqual({ refreshToken: REDACTED, apiKey: REDACTED, ok: 1 });
    expect(out.phone).toBe('+91******3210');
    expect(out.line1).toBe('***');
    expect(out.price).toBe('10.5');
    expect(out.at).toBe('2026-01-01T00:00:00.000Z');
    expect(out.list).toEqual([{ otpCode: REDACTED }]);
    expect(maskEmail('riya@example.com')).toBe('r***@example.com');
    expect(maskEmail('bad')).toBe('***');
    expect(maskPhone('12')).toBe('****');
  });

  it('keeps only changed fields plus id', () => {
    const diff = computeDiff(
      { id: 'p1', name: 'A', price: dec('10'), updatedAt: 1 },
      { id: 'p1', name: 'B', price: dec('10'), updatedAt: 2 },
    );
    expect(diff.changedFields).toEqual(['name']);
    expect(diff.before).toEqual({ id: 'p1', name: 'A' });
    expect(diff.after).toEqual({ id: 'p1', name: 'B' });
    expect(computeDiff(null, { id: 'x', name: 'n' }).before).toBeNull();
  });
});

describe('memory store', () => {
  it('expires entries, increments counters, deletes by prefix and evicts when full', () => {
    let t = 0;
    const store = createMemoryStore(() => t, 3);
    store.set('a:1', 1, 10);
    expect(store.get('a:1')).toBe(1);
    t = 11_000;
    expect(store.get('a:1')).toBeUndefined();
    expect(store.increment('c', 60)).toBe(1);
    expect(store.increment('c', 60)).toBe(2);
    store.set('p:1', 'x', 60);
    store.set('p:2', 'y', 60);
    store.deleteByPrefix('p:');
    expect(store.get('p:1')).toBeUndefined();
    store.set('k1', 1, 60);
    store.set('k2', 1, 60);
    store.set('k3', 1, 60);
    store.set('k4', 1, 60);
    expect(store.get('k4')).toBe(1);
    store.delete('k4');
    expect(store.get('k4')).toBeUndefined();
  });
});

describe('prisma error mapping', () => {
  const err = (code: string, meta?: Record<string, unknown>) =>
    Object.assign(new Error('x'), { code, clientVersion: '7.10.1', meta });
  it('maps known codes to canonical errors', () => {
    expect(mapPrismaError(err('P2002', { target: ['sku'] }))?.code).toBe('DUPLICATE_RESOURCE');
    expect(mapPrismaError(err('P2002', { target: ['sku'] }))?.details).toEqual([
      { field: 'sku', message: 'Must be unique.' },
    ]);
    expect(mapPrismaError(err('P2002', { target: 'uq_x' }))?.details?.[0]?.field).toBe('uq_x');
    expect(mapPrismaError(err('P2003'))?.code).toBe('CONFLICT');
    expect(mapPrismaError(err('P2025'))?.code).toBe('NOT_FOUND');
    expect(mapPrismaError(err('P2034'))?.code).toBe('CONFLICT');
    expect(mapPrismaError(err('P1001'))?.code).toBe('SERVICE_UNAVAILABLE');
    expect(mapPrismaError(err('P9999'))).toBeUndefined();
    expect(mapPrismaError(new Error('plain'))).toBeUndefined();
  });
});

describe('transaction helper', () => {
  it('runs after-commit callbacks only after success and isolates their errors', async () => {
    const { db } = createMockDb();
    const events: string[] = [];
    const errors: unknown[] = [];
    const result = await withTransaction(
      db,
      (ctx) => {
        ctx.afterCommit(() => {
          events.push('sent');
        });
        ctx.afterCommit(() => {
          throw new Error('mail down');
        });
        events.push('body');
        return Promise.resolve(42);
      },
      { onAfterCommitError: (e) => errors.push(e) },
    );
    expect(result).toBe(42);
    expect(events).toEqual(['body', 'sent']);
    expect(errors).toHaveLength(1);
  });

  it('retries deadlocks when allowed, otherwise maps to CONFLICT', async () => {
    const { db, m } = createMockDb();
    const deadlock = Object.assign(new Error('Deadlock found'), { code: 'P2034' });
    m.$transaction.mockRejectedValueOnce(deadlock);
    await expect(
      withTransaction(db, () => Promise.resolve('ok'), { retryOnDeadlock: true }),
    ).resolves.toBe('ok');
    m.$transaction.mockRejectedValueOnce(deadlock);
    await expect(withTransaction(db, () => Promise.resolve('ok'))).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    m.$transaction.mockRejectedValueOnce(new Error('other'));
    await expect(withTransaction(db, () => Promise.resolve('ok'))).rejects.toThrow('other');
    expect(isDeadlock({ message: 'Lock wait timeout exceeded' })).toBe(true);
    expect(isDeadlock(null)).toBe(false);
  });
});

describe('idempotency hashing & rate classes', () => {
  it('hashes canonical JSON independent of key order', () => {
    expect(canonicalJson({ b: 1, a: [1, { d: 2, c: undefined }] })).toBe('{"a":[1,{"d":2}],"b":1}');
    expect(requestHash('POST', '/x', { a: 1, b: 2 })).toBe(
      requestHash('POST', '/x', { b: 2, a: 1 }),
    );
    expect(requestHash('POST', '/x', { a: 1 })).not.toBe(requestHash('POST', '/y', { a: 1 }));
    expect(canonicalJson(undefined)).toBe('null');
  });

  it('applies the stricter OQ-109 values', () => {
    expect(RATE_CLASSES['checkout-order']).toEqual([
      { points: 5, durationSeconds: 60, key: 'user' },
    ]);
    expect(RATE_CLASSES['admin-export']).toEqual([
      { points: 10, durationSeconds: 3600, key: 'user' },
    ]);
    expect(RATE_CLASSES.webhook[0]?.points).toBe(600);
  });
});
