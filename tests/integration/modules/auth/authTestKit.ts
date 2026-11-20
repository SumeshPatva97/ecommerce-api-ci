/**
 * Test kit for the auth modules (MOCKED DB — no MySQL). Installs a tiny in-memory implementation
 * of the Prisma delegates the auth code uses (users, refresh tokens, verification tokens, roles)
 * on top of `tests/helpers/mockDb.ts`, so multi-step flows (login → refresh → reuse → logout) can
 * be exercised end-to-end through the real Express app, real JWTs and the REAL permission service
 * (context loading against the fake rows). It verifies service/HTTP logic, not SQL.
 */
import { randomUUID } from 'node:crypto';

import request from 'supertest';

import type { ContainerOverrides } from '../../../../src/container.js';
import { base32Decode, hotp, totpStep } from '../../../../src/core/security/totp.js';
import type {
  SendWhatsAppInput,
  SendWhatsAppResult,
  WhatsAppProviderAdapter,
} from '../../../../src/integrations/whatsapp/whatsappProvider.js';
import { createAdminAuthModule } from '../../../../src/modules/admin-auth/index.js';
import { createAuthModule } from '../../../../src/modules/auth/index.js';
import { createMeProfileModule } from '../../../../src/modules/me/index.js';
import {
  createPermissionService,
  type Audience,
  type AuthContext,
  type PermissionService,
} from '../../../../src/modules/rbac/permission.service.js';
import type { ModuleFactory } from '../../../../src/modules/types.js';
import { buildModuleTestApp, type ModuleTestApp } from '../../../helpers/container.js';
import type { MockModels } from '../../../helpers/mockDb.js';
import { ADMIN_ORIGIN, STOREFRONT_ORIGIN } from '../../../helpers/testApp.js';

type Row = Record<string, unknown>;

export const UA_A = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36';
export const UA_B = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Version/17.0 Mobile Safari/604.1';
export const GOOD_PASSWORD = 'violet-harbour-lantern';

class LazyPermissionService implements PermissionService {
  target: PermissionService | undefined;
  invalidated: string[] = [];
  private get t(): PermissionService {
    if (this.target === undefined) throw new Error('permission service not wired');
    return this.target;
  }
  loadContext(userId: string, sid: string, audience: Audience): Promise<AuthContext | null> {
    return this.t.loadContext(userId, sid, audience);
  }
  effectivePermissions(
    ...args: Parameters<PermissionService['effectivePermissions']>
  ): Promise<'ALL' | string[]> {
    return this.t.effectivePermissions(...args);
  }
  invalidateUser(userId: string): void {
    this.invalidated.push(userId);
    this.t.invalidateUser(userId);
  }
  bumpVersion(): void {
    this.t.bumpVersion();
  }
}

export class CapturingWhatsApp implements WhatsAppProviderAdapter {
  readonly name = 'capture';
  readonly sent: SendWhatsAppInput[] = [];
  send(input: SendWhatsAppInput): Promise<SendWhatsAppResult> {
    this.sent.push(input);
    return Promise.resolve({
      provider: this.name,
      messageId: `wa_${String(this.sent.length)}`,
      accepted: true,
    });
  }
}

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a === undefined) return b === null || b === undefined;
  return a === b;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !(value instanceof Date) && !Array.isArray(value)
  );
}

export function matches(row: Row, where: Row | undefined): boolean {
  if (where === undefined) return true;
  for (const [key, cond] of Object.entries(where)) {
    const value = row[key];
    if (isPlainObject(cond)) {
      if ('not' in cond && same(value, cond.not)) return false;
      if ('in' in cond && !(cond.in as unknown[]).some((c) => same(value, c))) return false;
      if ('gt' in cond && !((value as Date | number) > (cond.gt as Date | number))) return false;
      if ('lt' in cond && !((value as Date | number) < (cond.lt as Date | number))) return false;
      continue;
    }
    if (!same(value, cond)) return false;
  }
  return true;
}

function apply(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (isPlainObject(value) && 'increment' in value) {
      row[key] = (row[key] as number) + (value.increment as number);
    } else {
      row[key] = value;
    }
  }
}

function sortBy<T extends Row>(rows: T[], orderBy: Row | undefined): T[] {
  if (orderBy === undefined) return rows;
  const [[field, dir] = ['id', 'asc']] = Object.entries(orderBy);
  return [...rows].sort((a, b) => {
    const x = a[field] as Date;
    const y = b[field] as Date;
    const cmp = x < y ? -1 : x > y ? 1 : 0;
    return dir === 'desc' ? -cmp : cmp;
  });
}

function uniqueViolation(target: string): Error {
  return Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
    clientVersion: '7.10.1',
    meta: { target: [target] },
  });
}

export interface RoleSeed {
  readonly code: string;
  readonly permissions?: readonly string[];
}

export interface FakeAuthDb {
  readonly users: Map<string, Row>;
  readonly refreshTokens: Row[];
  readonly verificationTokens: Row[];
  readonly roles: Map<string, RoleSeed[]>;
  readonly denies: Map<string, string[]>;
}

export function installFakeAuthDb(m: MockModels, now: () => Date): FakeAuthDb {
  const db: FakeAuthDb = {
    users: new Map(),
    refreshTokens: [],
    verificationTokens: [],
    roles: new Map(),
    denies: new Map(),
  };
  const users = (): Row[] => [...db.users.values()];
  const findUser = (where: Row): Row | null => users().find((u) => matches(u, where)) ?? null;

  m.user.findUnique.mockImplementation(({ where }: { where: Row }) =>
    Promise.resolve(findUser(where)),
  );
  m.user.findFirst.mockImplementation(({ where }: { where: Row }) =>
    Promise.resolve(findUser(where)),
  );
  m.user.update.mockImplementation(({ where, data }: { where: Row; data: Row }) => {
    const user = findUser(where);
    if (user === null) return Promise.reject(new Error('user not found'));
    if (
      typeof data.phone === 'string' &&
      users().some((u) => u !== user && u.phone === data.phone)
    ) {
      return Promise.reject(uniqueViolation('phone'));
    }
    apply(user, { ...data, updatedAt: now() });
    return Promise.resolve(user);
  });
  m.user.updateMany.mockImplementation(({ where, data }: { where: Row; data: Row }) => {
    const hits = users().filter((u) => matches(u, where));
    for (const u of hits) apply(u, data);
    return Promise.resolve({ count: hits.length });
  });
  m.user.create.mockImplementation(({ data }: { data: Row }) => {
    if (users().some((u) => u.emailNormalized === data.emailNormalized)) {
      return Promise.reject(uniqueViolation('email_normalized'));
    }
    const row = seedUserRow(data);
    db.users.set(row.id as string, row);
    return Promise.resolve(row);
  });

  m.refreshToken.findUnique.mockImplementation(({ where }: { where: Row }) =>
    Promise.resolve(db.refreshTokens.find((r) => matches(r, where)) ?? null),
  );
  m.refreshToken.findFirst.mockImplementation(({ where, orderBy }: { where: Row; orderBy?: Row }) =>
    Promise.resolve(
      sortBy(
        db.refreshTokens.filter((r) => matches(r, where)),
        orderBy,
      )[0] ?? null,
    ),
  );
  m.refreshToken.findMany.mockImplementation(({ where, orderBy }: { where: Row; orderBy?: Row }) =>
    Promise.resolve(
      sortBy(
        db.refreshTokens.filter((r) => matches(r, where)),
        orderBy,
      ),
    ),
  );
  m.refreshToken.create.mockImplementation(({ data }: { data: Row }) => {
    if (db.refreshTokens.some((r) => r.tokenHash === data.tokenHash)) {
      return Promise.reject(uniqueViolation('token_hash'));
    }
    const row = {
      revokedAt: null,
      revokedReason: null,
      replacedById: null,
      createdAt: now(),
      ...data,
    };
    db.refreshTokens.push(row);
    return Promise.resolve(row);
  });
  m.refreshToken.updateMany.mockImplementation(({ where, data }: { where: Row; data: Row }) => {
    const hits = db.refreshTokens.filter((r) => matches(r, where));
    for (const r of hits) apply(r, data);
    return Promise.resolve({ count: hits.length });
  });
  m.refreshToken.groupBy.mockImplementation(({ where }: { where: Row }) => {
    const groups = new Map<string, Date>();
    for (const r of db.refreshTokens.filter((x) => matches(x, where))) {
      const fam = r.familyId as string;
      const issued = r.issuedAt as Date;
      const prev = groups.get(fam);
      if (prev === undefined || issued < prev) groups.set(fam, issued);
    }
    return Promise.resolve(
      [...groups.entries()].map(([familyId, issuedAt]) => ({ familyId, _min: { issuedAt } })),
    );
  });

  const withUser = (row: Row | undefined): Row | null =>
    row === undefined ? null : { ...row, user: db.users.get(row.userId as string) };
  m.verificationToken.findUnique.mockImplementation(({ where }: { where: Row }) =>
    Promise.resolve(withUser(db.verificationTokens.find((r) => matches(r, where)))),
  );
  m.verificationToken.findFirst.mockImplementation(
    ({ where, orderBy }: { where: Row; orderBy?: Row }) =>
      Promise.resolve(
        sortBy(
          db.verificationTokens.filter((r) => matches(r, where)),
          orderBy,
        )[0] ?? null,
      ),
  );
  m.verificationToken.create.mockImplementation(({ data }: { data: Row }) => {
    const row = {
      attemptCount: 0,
      maxAttempts: 5,
      consumedAt: null,
      invalidatedAt: null,
      createdAt: now(),
      ...data,
    };
    db.verificationTokens.push(row);
    return Promise.resolve(row);
  });
  m.verificationToken.update.mockImplementation(({ where, data }: { where: Row; data: Row }) => {
    const row = db.verificationTokens.find((r) => matches(r, where));
    if (row === undefined) return Promise.reject(new Error('not found'));
    apply(row, data);
    return Promise.resolve(row);
  });
  m.verificationToken.updateMany.mockImplementation(
    ({ where, data }: { where: Row; data: Row }) => {
      const hits = db.verificationTokens.filter((r) => matches(r, where));
      for (const r of hits) apply(r, data);
      return Promise.resolve({ count: hits.length });
    },
  );

  m.userRole.findMany.mockImplementation(({ where }: { where: Row }) =>
    Promise.resolve(
      (db.roles.get(where.userId as string) ?? []).map((r) => ({
        role: {
          id: `role-${r.code}`,
          code: r.code,
          name: r.code.charAt(0) + r.code.slice(1).toLowerCase(),
          isSystem: r.code === 'ADMIN' || r.code === 'SUPERADMIN',
          rolePermissions: (r.permissions ?? []).map((code) => ({
            permission: { code, isDeprecated: false },
          })),
        },
      })),
    ),
  );
  m.userPermissionOverride.findMany.mockImplementation(({ where }: { where: Row }) =>
    Promise.resolve(
      (db.denies.get(where.userId as string) ?? []).map((code) => ({ permission: { code } })),
    ),
  );
  m.userAddress.findFirst.mockResolvedValue(null);
  m.notificationPreference.createMany.mockResolvedValue({ count: 2 });
  return db;
}

export function seedUserRow(data: Row): Row {
  return {
    id: randomUUID(),
    accountType: 'CUSTOMER',
    phone: null,
    passwordHash: null,
    passwordChangedAt: null,
    lastName: null,
    status: 'ACTIVE',
    emailVerifiedAt: null,
    phoneVerifiedAt: null,
    isSuperadmin: false,
    mfaEnabled: false,
    mfaSecretEncrypted: null,
    lastLoginAt: null,
    lastLoginIp: null,
    failedLoginCount: 0,
    lockedUntil: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    deletedAt: null,
    ...data,
  };
}

export interface AuthKit {
  readonly t: ModuleTestApp;
  readonly db: FakeAuthDb;
  readonly whatsapp: CapturingWhatsApp;
  readonly permissions: LazyPermissionService;
  seedUser(data: Row & { email: string; password?: string; roles?: RoleSeed[] }): Row;
  sf(path: string, ua?: string): request.Test;
  adm(path: string, ua?: string): request.Test;
  advance(seconds: number): void;
  /** Value of `name` from Set-Cookie (`''` when cleared, undefined when absent). */
  cookie(res: request.Response, name: string): string | undefined;
  rawCookie(res: request.Response, name: string): string | undefined;
  totp(secret: string, offsetSteps?: number): string;
}

export function buildAuthKit(
  factories: readonly ModuleFactory[] = [
    createAuthModule,
    createAdminAuthModule,
    createMeProfileModule,
  ],
  overrides: ContainerOverrides = {},
): AuthKit {
  const permissions = new LazyPermissionService();
  const whatsapp = new CapturingWhatsApp();
  const t = buildModuleTestApp(factories, {
    overrides: { ...overrides, permissions, providers: { whatsapp, ...overrides.providers } },
  });
  permissions.target = createPermissionService({
    db: t.container.db,
    store: t.store,
    ttlSeconds: 0,
    clock: t.container.clock,
  });
  const db = installFakeAuthDb(t.m, () => t.now.value);

  const rawCookie = (res: request.Response, name: string): string | undefined => {
    const header = res.headers['set-cookie'] as unknown;
    const list = Array.isArray(header) ? (header as string[]) : [];
    return list.find((c) => c.startsWith(`${name}=`));
  };

  return {
    t,
    db,
    whatsapp,
    permissions,
    seedUser({ email, password, roles, ...rest }) {
      const row = seedUserRow({
        email,
        emailNormalized: email.toLowerCase(),
        firstName: 'Riya',
        ...(password === undefined ? {} : { passwordHash: `test-hash:${password}` }),
        ...rest,
      });
      db.users.set(row.id as string, row);
      if (roles !== undefined) db.roles.set(row.id as string, roles);
      return row;
    },
    sf(path, ua = UA_A) {
      return request(t.app)
        .post(`/api/v1${path}`)
        .set({ Origin: STOREFRONT_ORIGIN, 'X-Client': 'storefront', 'User-Agent': ua });
    },
    adm(path, ua = UA_A) {
      return request(t.app)
        .post(`/api/v1/admin${path}`)
        .set({ Origin: ADMIN_ORIGIN, 'X-Client': 'admin', 'User-Agent': ua });
    },
    advance(seconds) {
      t.now.value = new Date(t.now.value.getTime() + seconds * 1000);
    },
    rawCookie,
    cookie(res, name) {
      const raw = rawCookie(res, name);
      if (raw === undefined) return undefined;
      return decodeURIComponent(raw.slice(name.length + 1).split(';')[0] ?? '');
    },
    totp(secret, offsetSteps = 0) {
      return hotp(base32Decode(secret), totpStep(t.now.value) + offsetSteps);
    },
  };
}
