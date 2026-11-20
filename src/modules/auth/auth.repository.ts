/**
 * Prisma queries for the auth modules (users, refresh tokens, verification tokens).
 * Callers pass the transaction client where atomicity matters.
 */
import { randomUUID } from 'node:crypto';

import type { Queryable } from '../../core/db/transaction.js';
import type {
  NotificationChannel,
  TokenAudience,
  VerificationPurpose,
} from '../../generated/prisma/enums.js';

export const LOGIN_USER_SELECT = {
  id: true,
  accountType: true,
  email: true,
  emailNormalized: true,
  phone: true,
  passwordHash: true,
  firstName: true,
  lastName: true,
  status: true,
  emailVerifiedAt: true,
  phoneVerifiedAt: true,
  isSuperadmin: true,
  mfaEnabled: true,
  mfaSecretEncrypted: true,
  failedLoginCount: true,
  lockedUntil: true,
  lastLoginAt: true,
  createdAt: true,
  deletedAt: true,
} as const;

export interface LoginUserRow {
  readonly id: string;
  readonly accountType: 'CUSTOMER' | 'STAFF';
  readonly email: string;
  readonly emailNormalized: string;
  readonly phone: string | null;
  readonly passwordHash: string | null;
  readonly firstName: string;
  readonly lastName: string | null;
  readonly status: 'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED' | 'DISABLED';
  readonly emailVerifiedAt: Date | null;
  readonly phoneVerifiedAt: Date | null;
  readonly isSuperadmin: boolean;
  readonly mfaEnabled: boolean;
  readonly mfaSecretEncrypted: string | null;
  readonly failedLoginCount: number;
  readonly lockedUntil: Date | null;
  readonly lastLoginAt: Date | null;
  readonly createdAt: Date;
  readonly deletedAt: Date | null;
}

export function findUserByEmail(
  db: Queryable,
  emailNormalized: string,
): Promise<LoginUserRow | null> {
  return db.user.findUnique({ where: { emailNormalized }, select: LOGIN_USER_SELECT });
}

export function findUserById(db: Queryable, id: string): Promise<LoginUserRow | null> {
  return db.user.findUnique({ where: { id }, select: LOGIN_USER_SELECT });
}

export const REFRESH_ROW_SELECT = {
  id: true,
  userId: true,
  familyId: true,
  audience: true,
  issuedAt: true,
  expiresAt: true,
  absoluteExpiresAt: true,
  revokedAt: true,
  revokedReason: true,
  userAgent: true,
} as const;

export interface RefreshRow {
  readonly id: string;
  readonly userId: string;
  readonly familyId: string;
  readonly audience: TokenAudience;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly revokedAt: Date | null;
  readonly revokedReason: string | null;
  readonly userAgent: string | null;
}

export function findRefreshByHash(db: Queryable, tokenHash: string): Promise<RefreshRow | null> {
  return db.refreshToken.findUnique({ where: { tokenHash }, select: REFRESH_ROW_SELECT });
}

export interface NewRefreshRow {
  readonly id?: string;
  readonly userId: string;
  readonly familyId: string;
  readonly tokenHash: string;
  readonly audience: TokenAudience;
  readonly now: Date;
  readonly expiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export async function createRefreshRow(db: Queryable, row: NewRefreshRow): Promise<string> {
  const id = row.id ?? randomUUID();
  await db.refreshToken.create({
    data: {
      id,
      userId: row.userId,
      familyId: row.familyId,
      tokenHash: row.tokenHash,
      audience: row.audience,
      issuedAt: row.now,
      lastUsedAt: row.now,
      expiresAt: row.expiresAt,
      absoluteExpiresAt: row.absoluteExpiresAt,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
    },
  });
  return id;
}

export const VERIFICATION_ROW_SELECT = {
  id: true,
  userId: true,
  purpose: true,
  channel: true,
  target: true,
  tokenHash: true,
  attemptCount: true,
  maxAttempts: true,
  expiresAt: true,
  consumedAt: true,
  invalidatedAt: true,
} as const;

export interface VerificationRow {
  readonly id: string;
  readonly userId: string;
  readonly purpose: VerificationPurpose;
  readonly channel: NotificationChannel;
  readonly target: string;
  readonly tokenHash: string;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly invalidatedAt: Date | null;
}

export function findVerificationByHash(
  db: Queryable,
  tokenHash: string,
): Promise<VerificationRow | null> {
  return db.verificationToken.findUnique({ where: { tokenHash }, select: VERIFICATION_ROW_SELECT });
}

/** Only the latest unconsumed token of a purpose is valid (§6.1): older ones are invalidated. */
export async function invalidateOpenTokens(
  db: Queryable,
  userId: string,
  purpose: VerificationPurpose,
  now: Date,
): Promise<void> {
  await db.verificationToken.updateMany({
    where: { userId, purpose, consumedAt: null, invalidatedAt: null },
    data: { invalidatedAt: now },
  });
}

export interface NewVerificationRow {
  readonly id?: string;
  readonly userId: string;
  readonly purpose: VerificationPurpose;
  readonly channel: NotificationChannel;
  readonly target: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly ipAddress: string | null;
  readonly maxAttempts?: number;
  readonly now: Date;
}

export async function createVerificationRow(db: Queryable, row: NewVerificationRow): Promise<void> {
  await db.verificationToken.create({
    data: {
      id: row.id ?? randomUUID(),
      userId: row.userId,
      purpose: row.purpose,
      channel: row.channel,
      target: row.target,
      tokenHash: row.tokenHash,
      expiresAt: row.expiresAt,
      ipAddress: row.ipAddress,
      createdAt: row.now,
      ...(row.maxAttempts === undefined ? {} : { maxAttempts: row.maxAttempts }),
    },
  });
}

/** Single-use consumption guarded against concurrent use: true iff this call consumed it. */
export async function consumeVerification(db: Queryable, id: string, now: Date): Promise<boolean> {
  const result = await db.verificationToken.updateMany({
    where: { id, consumedAt: null, invalidatedAt: null },
    data: { consumedAt: now },
  });
  return result.count === 1;
}
