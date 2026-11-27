/**
 * FR-RBAC-008 — effective-permission cache: "server cache ≤ 60 s; revoked permission effective
 * ≤ 60 s" (AUTHENTICATION_AUTHORIZATION.md §18.3).
 *
 * MOCKED DB (in-memory fake delegates from the auth test kit; no MySQL). Unlike the other module
 * tests, the container here is built WITHOUT a permission-service override, so the app uses the
 * REAL `createPermissionService` wired by `createContainer` with `config.auth
 * .permissionCacheTtlSeconds` and the injected clock (the TTL store reads the same clock). Time is
 * moved by assigning `now.value` — no fake timers needed.
 */
import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../../../src/app.js';
import { createContainer } from '../../../../src/container.js';
import { ConfigError } from '../../../../src/core/config/index.js';
import { Readiness } from '../../../../src/core/health/readiness.js';
import { ok } from '../../../../src/core/http/envelope.js';
import { createLogger } from '../../../../src/core/logger/logger.js';
import { signAccessToken } from '../../../../src/core/security/jwt.js';
import { createMemoryStore } from '../../../../src/core/store/memoryStore.js';
import type { ModuleFactory } from '../../../../src/modules/types.js';
import { buildModules } from '../../../../src/routes/v1.js';
import { fastPasswordHasher } from '../../../helpers/container.js';
import { createMockDb } from '../../../helpers/mockDb.js';
import { ADMIN_ORIGIN, testConfig } from '../../../helpers/testApp.js';
import { installFakeAuthDb, seedUserRow } from '../auth/authTestKit.js';

/** One admin route guarded by `products.view`; echoes the permissions the request ran with. */
const fixture: ModuleFactory = (c) => {
  const adminRouter = Router();
  adminRouter.get('/things', c.auth.requirePermission('products.view'), (req, res) => {
    ok(req, res, { permissions: req.authz?.permissions });
  });
  return { name: 'fixture', adminRouter };
};

interface Session {
  readonly userId: string;
  readonly headers: Record<string, string>;
}

function build(env: Record<string, string> = {}) {
  const config = testConfig({ RATE_LIMIT_ENABLED: 'false', ...env });
  const logger = createLogger(config);
  const { db, m } = createMockDb();
  const now = { value: new Date('2026-11-19T06:30:00.000Z') };
  const clock = (): Date => now.value;
  const store = createMemoryStore(() => now.value.getTime());
  // No `permissions` override → the real, caching permission service.
  const container = createContainer(config, logger, db, {
    clock,
    store,
    passwords: fastPasswordHasher,
  });
  const app = createApp({
    config,
    logger,
    readiness: new Readiness(),
    container,
    modules: buildModules(container, [fixture]),
  });
  const fake = installFakeAuthDb(m, clock);
  m.auditLog.create.mockResolvedValue({});

  /** Seeds an ACTIVE staff user with one role and returns a signed-in session (live family). */
  const seedStaff = (email: string, permissions: string[]): Session & { addSession(): Session } => {
    const user = seedUserRow({
      email,
      emailNormalized: email,
      firstName: 'Riya',
      accountType: 'STAFF',
    });
    const userId = user.id as string;
    fake.users.set(userId, user);
    fake.roles.set(userId, [{ code: 'MANAGER', permissions }]);
    const addSession = (): Session => {
      const sid = randomUUID();
      fake.refreshTokens.push({
        id: randomUUID(),
        familyId: sid,
        userId,
        audience: 'ADMIN',
        revokedAt: null,
        absoluteExpiresAt: new Date(now.value.getTime() + 12 * 3600 * 1000),
      });
      const token = signAccessToken(container.keySet, {
        sub: userId,
        sid,
        aud: config.auth.jwt.audienceAdmin,
        iss: config.auth.jwt.issuer,
        ttlSeconds: config.auth.jwt.accessTtlSeconds, // 900 s — outlives every wait below
        now: now.value,
      });
      return {
        userId,
        headers: { Authorization: `Bearer ${token}`, 'X-Client': 'admin', Origin: ADMIN_ORIGIN },
      };
    };
    return { ...addSession(), addSession };
  };

  return {
    app,
    container,
    config,
    seedStaff,
    /** Replaces the user's role grants in the fake DB (no cache invalidation). */
    setPermissions(userId: string, permissions: string[]): void {
      fake.roles.set(userId, [{ code: 'MANAGER', permissions }]);
    },
    advance(seconds: number): void {
      now.value = new Date(now.value.getTime() + seconds * 1000);
    },
    /** How often the permission service has read each table so far. */
    reads: () => ({
      user: m.user.findUnique.mock.calls.length,
      session: m.refreshToken.findFirst.mock.calls.length,
      roles: m.userRole.findMany.mock.calls.length,
      overrides: m.userPermissionOverride.findMany.mock.calls.length,
    }),
    things: (session: Session) => request(app).get('/api/v1/admin/things').set(session.headers),
  };
}

/** One context load = user + session + role codes + role permissions + DENY overrides. */
const ONE_LOAD = { user: 1, session: 1, roles: 2, overrides: 1 };
const loads = (n: number) => ({
  user: ONE_LOAD.user * n,
  session: ONE_LOAD.session * n,
  roles: ONE_LOAD.roles * n,
  overrides: ONE_LOAD.overrides * n,
});

describe('FR-RBAC-008 permission cache TTL', () => {
  it('FR-RBAC-008: the configured cache TTL defaults to 60 s and can never exceed 60 s', () => {
    expect(testConfig().auth.permissionCacheTtlSeconds).toBe(60);
    expect(testConfig({ PERMISSION_CACHE_TTL_SECONDS: '45' }).auth.permissionCacheTtlSeconds).toBe(
      45,
    );
    expect(testConfig({ PERMISSION_CACHE_TTL_SECONDS: '0' }).auth.permissionCacheTtlSeconds).toBe(
      0,
    );
    let error: unknown;
    try {
      testConfig({ PERMISSION_CACHE_TTL_SECONDS: '61' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).problems.join('\n')).toContain('PERMISSION_CACHE_TTL_SECONDS');
  });

  it('FR-RBAC-008: within the TTL a second request does not re-read permissions; after 60 s it does and a revoked permission is enforced', async () => {
    const t = build();
    expect(t.config.auth.permissionCacheTtlSeconds).toBe(60);
    const staff = t.seedStaff('cache@example.com', ['orders.view', 'products.view']);

    const first = await t.things(staff);
    expect(first.status).toBe(200);
    expect(first.body.data.permissions).toEqual(['orders.view', 'products.view']);
    expect(t.reads()).toEqual(loads(1));

    // The permission is revoked in the database WITHOUT any cache invalidation (worst case).
    t.setPermissions(staff.userId, ['orders.view']);

    // 59 s later: still served from the cache — no table is read again.
    t.advance(59);
    const cached = await t.things(staff);
    expect(cached.status).toBe(200);
    expect(cached.body.data.permissions).toEqual(['orders.view', 'products.view']);
    expect(t.reads()).toEqual(loads(1));

    // 60 s after the first load the entry has expired: permissions are re-read and the revoked
    // permission is denied (revoked permission effective ≤ 60 s).
    t.advance(1);
    const expired = await t.things(staff);
    expect(expired.status).toBe(403);
    expect(expired.body.error.code).toBe('PERMISSION_DENIED');
    expect(t.reads()).toEqual(loads(2));

    // The fresh (reduced) context is cached in turn.
    const again = await t.things(staff);
    expect(again.status).toBe(403);
    expect(t.reads()).toEqual(loads(2));
  });

  it('FR-RBAC-008: the cache lifetime is the configured TTL (30 s) and 0 disables caching', async () => {
    const short = build({ PERMISSION_CACHE_TTL_SECONDS: '30' });
    const a = short.seedStaff('short@example.com', ['products.view']);
    expect((await short.things(a)).status).toBe(200);
    short.advance(29);
    expect((await short.things(a)).status).toBe(200);
    expect(short.reads()).toEqual(loads(1));
    short.advance(1);
    expect((await short.things(a)).status).toBe(200);
    expect(short.reads()).toEqual(loads(2));

    const off = build({ PERMISSION_CACHE_TTL_SECONDS: '0' });
    const b = off.seedStaff('off@example.com', ['products.view']);
    expect((await off.things(b)).status).toBe(200);
    expect((await off.things(b)).status).toBe(200);
    expect(off.reads()).toEqual(loads(2)); // every request reads the database
  });
});

describe('FR-RBAC-008 explicit cache invalidation on permission / role change', () => {
  it('FR-RBAC-008: invalidateUser drops every cached session of that user at once and nobody else’s', async () => {
    const t = build();
    const target = t.seedStaff('target@example.com', ['products.view']);
    const secondSession = target.addSession();
    const bystander = t.seedStaff('bystander@example.com', ['products.view']);
    expect((await t.things(target)).status).toBe(200);
    expect((await t.things(secondSession)).status).toBe(200);
    expect((await t.things(bystander)).status).toBe(200);
    expect(t.reads()).toEqual(loads(3)); // one load per session, all now cached

    // Role / override change for one user: the services call `permissions.invalidateUser(userId)`.
    t.setPermissions(target.userId, []);
    t.container.permissions.invalidateUser(target.userId);

    // No time has passed: both of the user's sessions lose the permission immediately …
    expect((await t.things(target)).status).toBe(403);
    expect((await t.things(secondSession)).status).toBe(403);
    expect(t.reads()).toEqual(loads(5));
    // … while the other user is still served from the cache.
    expect((await t.things(bystander)).status).toBe(200);
    expect(t.reads()).toEqual(loads(5));
  });

  it('FR-RBAC-008: bumpVersion makes every cached context unreachable (role-permission mapping change)', async () => {
    const t = build();
    const a = t.seedStaff('a@example.com', ['products.view']);
    const b = t.seedStaff('b@example.com', ['products.view']);
    expect((await t.things(a)).status).toBe(200);
    expect((await t.things(b)).status).toBe(200);
    expect(t.reads()).toEqual(loads(2));

    // The shared role loses `products.view`; the roles service calls `permissions.bumpVersion()`.
    t.setPermissions(a.userId, ['orders.view']);
    t.setPermissions(b.userId, ['orders.view']);
    t.container.permissions.bumpVersion();

    const deniedA = await t.things(a);
    const deniedB = await t.things(b);
    expect([deniedA.status, deniedB.status]).toEqual([403, 403]);
    expect(t.reads()).toEqual(loads(4));
    // The new contexts are cached under the new version (no further reads) …
    expect((await t.things(a)).status).toBe(403);
    expect(t.reads()).toEqual(loads(4));
    // … and still expire after the TTL.
    t.setPermissions(a.userId, ['orders.view', 'products.view']);
    t.advance(60);
    expect((await t.things(a)).status).toBe(200);
    expect(t.reads()).toEqual(loads(5));
  });
});
