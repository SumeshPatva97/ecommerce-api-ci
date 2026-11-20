/**
 * Session (refresh-family) revocation — AUTHENTICATION_AUTHORIZATION.md §9.7, §10.
 * Shared by auth, admin-auth, staff and customers modules. A session = one refresh family.
 *
 * Callers must also drop cached auth contexts AFTER commit:
 *   afterCommit(() => container.permissions.invalidateUser(userId))
 */
import type { Queryable } from '../../core/db/transaction.js';

export type RevokeReason =
  | 'ROTATED'
  | 'LOGOUT'
  | 'LOGOUT_ALL'
  | 'REUSE_DETECTED'
  | 'PASSWORD_CHANGED'
  | 'PERMISSION_CHANGED'
  | 'STATUS_CHANGED'
  | 'ADMIN_REVOKED'
  | 'MFA_RESET'
  | 'EXPIRED';

/** Revokes every active family of a user (optionally keeping one family, e.g. the current one). */
export async function revokeUserSessions(
  db: Queryable,
  userId: string,
  reason: RevokeReason,
  now: Date,
  exceptFamilyId?: string,
): Promise<number> {
  const result = await db.refreshToken.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(exceptFamilyId === undefined ? {} : { familyId: { not: exceptFamilyId } }),
    },
    data: { revokedAt: now, revokedReason: reason },
  });
  return result.count;
}

/** Revokes one family (session). `userId` scopes the update so a foreign family is never touched. */
export async function revokeFamily(
  db: Queryable,
  userId: string,
  familyId: string,
  reason: RevokeReason,
  now: Date,
): Promise<number> {
  const result = await db.refreshToken.updateMany({
    where: { userId, familyId, revokedAt: null },
    data: { revokedAt: now, revokedReason: reason },
  });
  return result.count;
}
