/**
 * Effective permissions & auth context — AUTHENTICATION_AUTHORIZATION.md §18,
 * ROLE_PERMISSION_AND_AUDIT_LOGS.md §2. Decision OQ-27: per-user DENY overrides; ALLOW overrides
 * are NOT adopted (ignored if present). DENY always wins.
 *
 *   effective = is_superadmin ? ALL : (⋃ active role permissions) − DENY overrides
 *
 * Context (user status, session validity, permissions) is cached ≤ `PERMISSION_CACHE_TTL_SECONDS`
 * (max 60 s) in the KeyValueStore, keyed by an RBAC version that is bumped on any role-permission
 * change so every cached context becomes unreachable at once (§18.3).
 */
import type { AccountType, UserStatus } from '../../generated/prisma/enums.js';
import type { DbClient, Queryable } from '../../core/db/transaction.js';
import type { KeyValueStore } from '../../core/store/memoryStore.js';

export type Audience = 'storefront' | 'admin';

export interface AuthContext {
  readonly userId: string;
  readonly sid: string;
  readonly audience: Audience;
  readonly accountType: AccountType;
  readonly status: UserStatus;
  readonly isSuperadmin: boolean;
  readonly email: string;
  readonly firstName: string;
  /** Active role codes (staff only). */
  readonly roles: readonly string[];
  /** `ALL` for Superadmins; empty for customers. */
  readonly permissions: 'ALL' | readonly string[];
}

export interface PermissionService {
  loadContext(userId: string, sid: string, audience: Audience): Promise<AuthContext | null>;
  effectivePermissions(
    db: Queryable,
    userId: string,
    isSuperadmin: boolean,
  ): Promise<'ALL' | string[]>;
  /** Drops cached contexts of one user (role/override/status/session change). */
  invalidateUser(userId: string): void;
  /** Invalidates all cached contexts (role-permission mapping change). */
  bumpVersion(): void;
}

export function hasPermission(
  ctx: Pick<AuthContext, 'permissions' | 'isSuperadmin'>,
  key: string,
): boolean {
  if (ctx.isSuperadmin || ctx.permissions === 'ALL') return true;
  return ctx.permissions.includes(key);
}

export function createPermissionService(deps: {
  db: DbClient;
  store: KeyValueStore;
  ttlSeconds: number;
  clock: () => Date;
}): PermissionService {
  const { db, store, ttlSeconds, clock } = deps;
  const versionKey = 'rbac:version';
  const version = (): number => {
    const value = store.get(versionKey);
    return typeof value === 'number' ? value : 0;
  };

  async function effectivePermissions(
    q: Queryable,
    userId: string,
    isSuperadmin: boolean,
  ): Promise<'ALL' | string[]> {
    if (isSuperadmin) return 'ALL';
    const [roles, overrides] = await Promise.all([
      q.userRole.findMany({
        where: { userId, role: { isActive: true } },
        select: {
          role: {
            select: {
              rolePermissions: {
                select: { permission: { select: { code: true, isDeprecated: true } } },
              },
            },
          },
        },
      }),
      q.userPermissionOverride.findMany({
        where: { userId, effect: 'DENY' },
        select: { permission: { select: { code: true } } },
      }),
    ]);
    const result = new Set<string>();
    for (const ur of roles) {
      for (const rp of ur.role.rolePermissions) {
        if (!rp.permission.isDeprecated) result.add(rp.permission.code);
      }
    }
    for (const o of overrides) result.delete(o.permission.code);
    return [...result].sort();
  }

  return {
    effectivePermissions,

    async loadContext(userId, sid, audience) {
      const key = `authctx:${userId}:${sid}:v${String(version())}`;
      const cached = ttlSeconds > 0 ? (store.get(key) as AuthContext | undefined) : undefined;
      if (cached?.audience === audience) return cached;

      const now = clock();
      const [user, session] = await Promise.all([
        db.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            accountType: true,
            status: true,
            isSuperadmin: true,
            email: true,
            firstName: true,
            deletedAt: true,
          },
        }),
        db.refreshToken.findFirst({
          where: {
            familyId: sid,
            userId,
            revokedAt: null,
            absoluteExpiresAt: { gt: now },
            audience: audience === 'admin' ? 'ADMIN' : 'STOREFRONT',
          },
          select: { id: true },
        }),
      ]);
      if (user === null || session === null || user.deletedAt !== null) return null;
      if (user.status !== 'ACTIVE' && user.status !== 'PENDING_VERIFICATION') return null;
      if ((audience === 'admin') !== (user.accountType === 'STAFF')) return null;
      if (audience === 'admin' && user.status !== 'ACTIVE') return null;

      let roles: string[] = [];
      let permissions: 'ALL' | string[] = [];
      if (audience === 'admin') {
        const roleRows = await db.userRole.findMany({
          where: { userId, role: { isActive: true } },
          select: { role: { select: { code: true } } },
        });
        roles = roleRows.map((r) => r.role.code).sort();
        permissions = await effectivePermissions(db, userId, user.isSuperadmin);
      }
      const ctx: AuthContext = Object.freeze({
        userId,
        sid,
        audience,
        accountType: user.accountType,
        status: user.status,
        isSuperadmin: user.isSuperadmin,
        email: user.email,
        firstName: user.firstName,
        roles: Object.freeze(roles),
        permissions: permissions === 'ALL' ? 'ALL' : Object.freeze(permissions),
      });
      if (ttlSeconds > 0) store.set(key, ctx, ttlSeconds);
      return ctx;
    },

    invalidateUser(userId) {
      store.deleteByPrefix(`authctx:${userId}:`);
    },

    bumpVersion() {
      store.set(versionKey, version() + 1, 365 * 24 * 3600);
    },
  };
}
