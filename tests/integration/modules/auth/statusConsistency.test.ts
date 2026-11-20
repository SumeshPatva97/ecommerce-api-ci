/**
 * HTTP status consistency (owner decision 7, 2026-11-19), MOCKED DB:
 * - forgot-password (customer + staff) and resend-verification: always 202 with an identical body
 *   whether or not the account exists (anti-enumeration);
 * - account LOCKOUT: generic 401 UNAUTHENTICATED, byte-identical to a wrong password (the lock is never
 *   disclosed to the caller — only the owner is emailed);
 * - RATE LIMITING (auth-strict route class): 429 RATE_LIMITED + Retry-After, independent of any account.
 */
import { describe, expect, it } from 'vitest';

import { createAuthModule } from '../../../../src/modules/auth/index.js';
import { GOOD_PASSWORD, buildAuthKit } from './authTestKit.js';
import { buildModuleTestApp } from '../../../helpers/container.js';
import { STOREFRONT_ORIGIN } from '../../../helpers/testApp.js';
import request from 'supertest';

const strip = (body: unknown) => ({ ...(body as Record<string, unknown>), requestId: undefined });

describe('forgot-password / resend-verification: 202, identical for known and unknown accounts', () => {
  it.each([
    ['customer forgot-password', 'sf', '/auth/forgot-password'],
    ['customer resend-verification', 'sf', '/auth/resend-verification'],
    ['staff forgot-password', 'adm', '/auth/forgot-password'],
  ] as const)('%s', async (_name, app, path) => {
    const kit = buildAuthKit();
    kit.seedUser({
      email: 'known@example.com',
      password: GOOD_PASSWORD,
      accountType: app === 'adm' ? 'STAFF' : 'CUSTOMER',
      status: app === 'adm' ? 'ACTIVE' : 'PENDING_VERIFICATION',
    });
    const known = await kit[app](path).send({ email: 'known@example.com' });
    const unknown = await kit[app](path).send({ email: 'nobody@example.com' });
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(strip(known.body)).toEqual(strip(unknown.body));
  });
});

describe('lockout is a 401, rate limiting is a 429', () => {
  it('a locked account answers exactly like a wrong password (no lock disclosure)', async () => {
    const kit = buildAuthKit();
    kit.seedUser({ email: 'lk@example.com', password: GOOD_PASSWORD });
    const wrong = await kit
      .sf('/auth/login')
      .send({ email: 'lk@example.com', password: 'nope-nope-nope' });
    for (let i = 0; i < 4; i += 1) {
      await kit
        .sf('/auth/login')
        .send({ email: 'lk@example.com', password: `bad-${String(i)}-xxxxxx` });
    }
    const locked = await kit
      .sf('/auth/login')
      .send({ email: 'lk@example.com', password: GOOD_PASSWORD });
    expect(wrong.status).toBe(401);
    expect(locked.status).toBe(401);
    expect(strip(locked.body)).toEqual(strip(wrong.body));
    expect(locked.headers['retry-after']).toBeUndefined();
    expect(JSON.stringify(locked.body)).not.toMatch(/lock/i);
  });

  it('the auth-strict route class returns 429 RATE_LIMITED with Retry-After after 5/min', async () => {
    const t = buildModuleTestApp([createAuthModule], { env: { RATE_LIMIT_ENABLED: 'true' } });
    t.m.user.findUnique.mockResolvedValue(null);
    t.m.user.findFirst.mockResolvedValue(null);
    const attempt = () =>
      request(t.app)
        .post('/api/v1/auth/forgot-password')
        .set({ Origin: STOREFRONT_ORIGIN })
        .send({ email: 'rl@example.com' });
    for (let i = 0; i < 5; i += 1) expect((await attempt()).status).toBe(202);
    const limited = await attempt();
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
});
