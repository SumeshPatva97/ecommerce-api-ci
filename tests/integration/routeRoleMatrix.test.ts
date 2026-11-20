/**
 * TC-014 — Permission matrix: every admin route × role, GENERATED from the real route table of the
 * full application (TESTING_STRATEGY), executed over HTTP through the real middleware pipeline.
 *
 * MOCKED container (tests/helpers/mockDb.ts, FakePermissionService): this proves the HTTP guard
 * layer (authenticate audience → requirePermission/requireAnyPermission → requireReauth) for every
 * registered route. It does NOT prove business authorisation inside services, SQL, real session
 * storage, or the production permission resolver.
 *
 * Guard order (src/routes/v1.ts + module routers): admin router-level `authenticate('admin')`, then
 * per-route permission guard (first handler), then `requireReauth()`, then rate limit /
 * idempotency / validation. Guards therefore run before validation, so empty bodies and synthetic
 * path params cannot mask a guard decision.
 *
 * Shadowing check: the denied request's PERMISSION_DENIED audit row must name exactly the
 * route's declared keys, proving the concrete URL reached the intended route.
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { AUTH_GUARD } from '../../src/core/middleware/auth.js';
import { MODULE_FACTORIES } from '../../src/modules/index.js';
import { buildModules } from '../../src/routes/v1.js';
import { buildModuleTestApp } from '../helpers/container.js';
import { listRoutes } from '../helpers/routeTable.js';

const API = '/api/v1';
const PARAM_ID = '3f1c2a7e-5b4d-4c8e-9a6f-1b2c3d4e5f60';
const AUTH_CODES = ['UNAUTHENTICATED', 'TOKEN_EXPIRED', 'PERMISSION_DENIED', 'REAUTH_REQUIRED'];

const t = buildModuleTestApp(MODULE_FACTORIES);
// Same factories against the same container as the mounted app (as routeTable.all.test.ts does).
const modules = buildModules(t.container, MODULE_FACTORIES);

interface AdminRoute {
  readonly module: string;
  readonly method: string;
  readonly path: string;
  readonly url: string;
  readonly permissions: readonly string[];
  readonly reauth: boolean;
}

interface CustomerRoute {
  readonly module: string;
  readonly method: string;
  readonly path: string;
  readonly url: string;
}

function concrete(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+(\([^)]*\))?\??/g, PARAM_ID);
}

const adminRoutes: AdminRoute[] = [];
const selfServiceRoutes: CustomerRoute[] = [];
for (const module of modules) {
  if (module.adminRouter === undefined) continue;
  const selfService = new Set(module.selfServiceAdminPaths ?? []);
  for (const r of listRoutes(module.adminRouter)) {
    const entry = {
      module: module.name,
      method: r.method,
      path: `/admin${r.path}`,
      url: `${API}/admin${concrete(r.path)}`,
    };
    if (selfService.has(r.path)) selfServiceRoutes.push(entry);
    else adminRoutes.push({ ...entry, permissions: r.permissions, reauth: r.reauth });
  }
}

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] };
}

/** Public routes whose own handler stack carries a mandatory storefront `authenticate`. */
const customerRoutes: CustomerRoute[] = [];
for (const module of modules) {
  if (module.publicRouter === undefined) continue;
  const stack = (module.publicRouter as unknown as { stack: RouteLayer[] }).stack;
  for (const layer of stack) {
    if (layer.route === undefined) continue;
    const guarded = layer.route.stack.some((l) => {
      const marker = (l.handle as Record<symbol, unknown>)[AUTH_GUARD] as
        { audience: string; optional: boolean } | undefined;
      return marker?.audience === 'storefront' && !marker.optional;
    });
    if (!guarded) continue;
    for (const method of Object.keys(layer.route.methods)) {
      customerRoutes.push({
        module: module.name,
        method: method.toUpperCase(),
        path: layer.route.path,
        url: `${API}${concrete(layer.route.path)}`,
      });
    }
  }
}

const ALL_KEYS = [...new Set(adminRoutes.flatMap((r) => r.permissions))].sort();

function send(method: string, url: string, headers: Record<string, string> = {}) {
  const verb = method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
  const req = request(t.app)[verb](url).set(headers);
  return method === 'GET' || method === 'HEAD' ? req : req.send({});
}

const adminNoAuthHeaders = { 'X-Client': 'admin', Origin: 'http://localhost:5174' };
const storefrontNoAuthHeaders = { 'X-Client': 'storefront', Origin: 'http://localhost:5173' };

function expectPassedGuards(res: request.Response): void {
  const code = (res.body as { error?: { code?: string } } | undefined)?.error?.code;
  expect(res.status, `status ${res.status} code ${code ?? '-'}`).not.toBe(401);
  expect(res.status, `status ${res.status} code ${code ?? '-'}`).not.toBe(403);
  expect(AUTH_CODES).not.toContain(code);
}

const label = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

describe('TC-014 route × role permission matrix (generated, MOCKED DB)', () => {
  beforeEach(() => {
    t.m.auditLog.create.mockClear();
  });

  // Coverage is part of the test title so the reporter output shows how many routes were exercised.
  it(
    `enumerates the full route table — [TC-014] admin permission-guarded routes: ` +
      `${adminRoutes.length} (re-auth: ${adminRoutes.filter((r) => r.reauth).length}); ` +
      `admin self-service routes: ${selfServiceRoutes.length}; ` +
      `customer (storefront-auth) routes: ${customerRoutes.length}; ` +
      `distinct permission keys: ${ALL_KEYS.length}`,
    () => {
      expect(modules.length).toBe(MODULE_FACTORIES.length);
      expect(adminRoutes.length).toBeGreaterThan(50);
      expect(customerRoutes.length).toBeGreaterThan(10);
      expect(adminRoutes.every((r) => r.permissions.length > 0)).toBe(true);
      expect(new Set(adminRoutes.map(label)).size).toBe(adminRoutes.length);
    },
  );

  describe('admin routes (permission-guarded)', () => {
    it.each(adminRoutes.map((r) => [label(r), r] as const))(
      '%s — no token → 401 UNAUTHENTICATED',
      async (_l, r) => {
        const res = await send(r.method, r.url, adminNoAuthHeaders);
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHENTICATED');
      },
    );

    it.each(adminRoutes.map((r) => [label(r), r] as const))(
      '%s — customer (storefront-audience) token → 401 UNAUTHENTICATED',
      async (_l, r) => {
        const customer = t.customer({ permissions: ALL_KEYS });
        const res = await send(r.method, r.url, {
          ...customer.headers,
          'X-Client': 'admin',
          Origin: 'http://localhost:5174',
        });
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHENTICATED');
      },
    );

    it.each(adminRoutes.map((r) => [label(r), r] as const))(
      '%s — staff with every other key but none of the required → 403 PERMISSION_DENIED (audited)',
      async (_l, r) => {
        const staff = t.staff({
          permissions: ALL_KEYS.filter((k) => !r.permissions.includes(k)),
          reauthenticated: true,
        });
        const res = await send(r.method, r.url, staff.headers);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('PERMISSION_DENIED');
        const rows = t.m.auditLog.create.mock.calls.map(
          (c) => (c[0] as { data: Record<string, unknown> }).data,
        );
        const denial = rows.find((row) => row.action === 'PERMISSION_DENIED');
        expect(denial).toBeDefined();
        expect(denial).toMatchObject({ actorUserId: staff.ctx.userId, outcome: 'FAILURE' });
        // The audited metadata proves this URL reached the intended route (no shadowing).
        expect(JSON.stringify(denial)).toContain(JSON.stringify(r.permissions));
      },
    );

    it.each(adminRoutes.map((r) => [label(r), r] as const))(
      '%s — staff holding exactly the required key(s) passes the permission layer',
      async (_l, r) => {
        const staff = t.staff({ permissions: r.permissions, reauthenticated: true });
        expectPassedGuards(await send(r.method, r.url, staff.headers));
      },
    );

    it.each(adminRoutes.map((r) => [label(r), r] as const))(
      '%s — Superadmin passes the permission layer',
      async (_l, r) => {
        const sa = t.staff({ isSuperadmin: true, reauthenticated: true });
        expectPassedGuards(await send(r.method, r.url, sa.headers));
      },
    );

    const reauthRoutes = adminRoutes.filter((r) => r.reauth);
    const plainRoutes = adminRoutes.filter((r) => !r.reauth);

    it.each(reauthRoutes.map((r) => [label(r), r] as const))(
      '%s — required key(s) but no fresh re-auth → 403 REAUTH_REQUIRED (staff and Superadmin)',
      async (_l, r) => {
        const staff = t.staff({ permissions: r.permissions });
        const res = await send(r.method, r.url, staff.headers);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('REAUTH_REQUIRED');
        const sa = t.staff({ isSuperadmin: true });
        const saRes = await send(r.method, r.url, sa.headers);
        expect(saRes.status).toBe(403);
        expect(saRes.body.error.code).toBe('REAUTH_REQUIRED');
      },
    );

    it.each(plainRoutes.map((r) => [label(r), r] as const))(
      '%s — no re-auth declared: required key(s) without re-auth passes the guards',
      async (_l, r) => {
        const staff = t.staff({ permissions: r.permissions });
        expectPassedGuards(await send(r.method, r.url, staff.headers));
      },
    );
  });

  describe('admin self-service routes (authentication only)', () => {
    it.each(selfServiceRoutes.map((r) => [label(r), r] as const))(
      '%s — no token → 401; customer token → 401',
      async (_l, r) => {
        const anon = await send(r.method, r.url, adminNoAuthHeaders);
        expect(anon.status).toBe(401);
        expect(anon.body.error.code).toBe('UNAUTHENTICATED');
        const customer = t.customer();
        const res = await send(r.method, r.url, {
          ...customer.headers,
          'X-Client': 'admin',
          Origin: 'http://localhost:5174',
        });
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHENTICATED');
      },
    );
  });

  describe('customer routes (storefront authentication)', () => {
    it.each(customerRoutes.map((r) => [label(r), r] as const))(
      '%s — no token → 401 UNAUTHENTICATED',
      async (_l, r) => {
        const res = await send(r.method, r.url, storefrontNoAuthHeaders);
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHENTICATED');
      },
    );

    it.each(customerRoutes.map((r) => [label(r), r] as const))(
      '%s — admin (staff, even Superadmin) token → 401 UNAUTHENTICATED',
      async (_l, r) => {
        const sa = t.staff({ isSuperadmin: true, reauthenticated: true });
        const res = await send(r.method, r.url, {
          ...sa.headers,
          'X-Client': 'storefront',
          Origin: 'http://localhost:5173',
        });
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHENTICATED');
      },
    );

    it.each(customerRoutes.map((r) => [label(r), r] as const))(
      '%s — customer token passes authentication',
      async (_l, r) => {
        const customer = t.customer();
        // Services such as GET /me re-load the account row and answer 401 when it is missing or
        // soft-deleted (me.profile.service `load`). With the empty mocked DB that would be a
        // fixture artefact, not a guard decision, so the caller's own live row is provided.
        t.m.user.findUnique.mockImplementation((args: { where?: { id?: string } }) =>
          Promise.resolve(
            args.where?.id === customer.ctx.userId
              ? {
                  id: customer.ctx.userId,
                  email: customer.ctx.email,
                  emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
                  phone: null,
                  phoneVerifiedAt: null,
                  firstName: 'Test',
                  lastName: 'Customer',
                  status: 'ACTIVE',
                  accountType: 'CUSTOMER',
                  createdAt: new Date('2026-01-01T00:00:00.000Z'),
                  deletedAt: null,
                }
              : undefined,
          ),
        );
        try {
          expectPassedGuards(await send(r.method, r.url, customer.headers));
        } finally {
          t.m.user.findUnique.mockReset();
          t.m.user.findUnique.mockResolvedValue(undefined);
        }
      },
    );
  });
});
