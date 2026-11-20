/**
 * Test container & app builders for module tests (MOCKED DB — see mockDb.ts).
 *
 *   const t = buildModuleTestApp([createCategoriesModule]);
 *   const auth = t.staff({ permissions: ['categories.view'] });
 *   await request(t.app).get('/api/v1/admin/categories').set(auth.headers);
 *   t.m.category.findMany.mockResolvedValue([...]);
 */
import { randomUUID } from 'node:crypto';

import type { Express } from 'express';

import { createApp } from '../../src/app.js';
import {
  createContainer,
  type AppContainer,
  type ContainerOverrides,
} from '../../src/container.js';
import { Readiness } from '../../src/core/health/readiness.js';
import { createLogger } from '../../src/core/logger/logger.js';
import type { PasswordHasher } from '../../src/core/security/password.js';
import { signAccessToken } from '../../src/core/security/jwt.js';
import { createMemoryStore, type KeyValueStore } from '../../src/core/store/memoryStore.js';
import { FakeEmailProviderAdapter } from '../../src/integrations/email/emailProvider.js';
import type { ModuleFactory } from '../../src/modules/types.js';
import { buildModules } from '../../src/routes/v1.js';
import type {
  Audience,
  AuthContext,
  PermissionService,
} from '../../src/modules/rbac/permission.service.js';
import { ADMIN_ORIGIN, STOREFRONT_ORIGIN, testConfig } from './testApp.js';
import { createMockDb, type MockModels } from './mockDb.js';

/** Deterministic, fast stand-in for Argon2id in HTTP tests (real Argon2 is tested separately). */
export const fastPasswordHasher: PasswordHasher = {
  hash: (password) => Promise.resolve(`test-hash:${password.normalize('NFC')}`),
  verify: (hash, password) => Promise.resolve(hash === `test-hash:${password.normalize('NFC')}`),
  needsRehash: () => false,
  verifyDummy: () => Promise.resolve(),
};

/** Permission service backed by an in-memory map of sessions (no DB queries). */
export class FakePermissionService implements PermissionService {
  readonly sessions = new Map<string, AuthContext>();
  invalidated: string[] = [];
  bumps = 0;

  loadContext(userId: string, sid: string, audience: Audience): Promise<AuthContext | null> {
    const ctx = this.sessions.get(`${userId}:${sid}`);
    return Promise.resolve(ctx?.audience === audience ? ctx : null);
  }

  effectivePermissions(
    _db: unknown,
    userId: string,
    isSuperadmin: boolean,
  ): Promise<'ALL' | string[]> {
    if (isSuperadmin) return Promise.resolve('ALL');
    for (const ctx of this.sessions.values()) {
      if (ctx.userId === userId) {
        return Promise.resolve(ctx.permissions === 'ALL' ? 'ALL' : [...ctx.permissions]);
      }
    }
    return Promise.resolve([]);
  }

  invalidateUser(userId: string): void {
    this.invalidated.push(userId);
  }

  bumpVersion(): void {
    this.bumps += 1;
  }
}

export interface TestPrincipal {
  readonly ctx: AuthContext;
  readonly token: string;
  /** Authorization + X-Client + Origin headers for supertest `.set()`. */
  readonly headers: Record<string, string>;
}

export interface PrincipalOptions {
  readonly userId?: string;
  readonly sid?: string;
  readonly permissions?: readonly string[] | 'ALL';
  readonly isSuperadmin?: boolean;
  readonly roles?: readonly string[];
  readonly status?: AuthContext['status'];
  readonly email?: string;
  /** Marks the session as recently re-authenticated (critical operations). */
  readonly reauthenticated?: boolean;
}

export interface ModuleTestApp {
  readonly app: Express;
  readonly container: AppContainer;
  readonly m: MockModels;
  readonly store: KeyValueStore;
  readonly permissions: FakePermissionService;
  readonly email: FakeEmailProviderAdapter;
  readonly now: { value: Date };
  staff(options?: PrincipalOptions): TestPrincipal;
  customer(options?: PrincipalOptions): TestPrincipal;
}

export interface ModuleTestOptions {
  readonly env?: Record<string, string | undefined>;
  readonly now?: Date;
  readonly overrides?: ContainerOverrides;
}

export function buildModuleTestApp(
  factories: readonly ModuleFactory[],
  options: ModuleTestOptions = {},
): ModuleTestApp {
  const config = testConfig({ RATE_LIMIT_ENABLED: 'false', ...options.env });
  const logger = createLogger(config);
  const { db, m } = createMockDb();
  const now = { value: options.now ?? new Date('2026-11-19T06:30:00.000Z') };
  const clock = (): Date => now.value;
  const store = createMemoryStore(() => now.value.getTime());
  const permissions = new FakePermissionService();
  const email = new FakeEmailProviderAdapter();
  const container = createContainer(config, logger, db, {
    clock,
    store,
    passwords: fastPasswordHasher,
    permissions,
    ...options.overrides,
    providers: { email, ...options.overrides?.providers },
  });
  const modules = buildModules(container, factories);
  const app = createApp({ config, logger, readiness: new Readiness(), container, modules });

  const principal = (audience: Audience, opts: PrincipalOptions = {}): TestPrincipal => {
    const userId = opts.userId ?? randomUUID();
    const sid = opts.sid ?? randomUUID();
    const ctx: AuthContext = {
      userId,
      sid,
      audience,
      accountType: audience === 'admin' ? 'STAFF' : 'CUSTOMER',
      status: opts.status ?? 'ACTIVE',
      isSuperadmin: opts.isSuperadmin ?? false,
      email: opts.email ?? `${audience}-${userId.slice(0, 8)}@example.com`,
      firstName: 'Test',
      roles: opts.roles ?? (audience === 'admin' ? ['MANAGER'] : []),
      permissions: opts.isSuperadmin === true ? 'ALL' : (opts.permissions ?? []),
    };
    permissions.sessions.set(`${userId}:${sid}`, ctx);
    if (opts.reauthenticated === true) store.set(`reauth:${sid}`, now.value.getTime(), 600);
    const token = signAccessToken(container.keySet, {
      sub: userId,
      sid,
      aud:
        audience === 'admin' ? config.auth.jwt.audienceAdmin : config.auth.jwt.audienceStorefront,
      iss: config.auth.jwt.issuer,
      ttlSeconds: config.auth.jwt.accessTtlSeconds,
      now: now.value,
    });
    return {
      ctx,
      token,
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Client': audience,
        Origin: audience === 'admin' ? ADMIN_ORIGIN : STOREFRONT_ORIGIN,
      },
    };
  };

  return {
    app,
    container,
    m,
    store,
    permissions,
    email,
    now,
    staff: (opts) => principal('admin', opts),
    customer: (opts) => principal('storefront', opts),
  };
}
