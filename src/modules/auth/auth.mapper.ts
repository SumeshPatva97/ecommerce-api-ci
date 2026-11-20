/**
 * DB row → DTO mappers for auth/session responses (API_DOCUMENTATION.md §3.1, §3.2, §4.1).
 * Never maps hashes, secrets or raw tokens.
 */
import type { UserStatus } from '../../generated/prisma/enums.js';

export interface CustomerUserRow {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string | null;
  readonly email: string;
  readonly phone: string | null;
  readonly status: UserStatus;
  readonly emailVerifiedAt: Date | null;
}

export interface CustomerUserDto {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string | null;
  readonly email: string;
  readonly phone: string | null;
  readonly status: UserStatus;
  readonly emailVerified: boolean;
}

export function toCustomerUserDto(user: CustomerUserRow): CustomerUserDto {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    phone: user.phone,
    status: user.status,
    emailVerified: user.emailVerifiedAt !== null,
  };
}

/** `49.36.120.7` → `49.36.***.***`; IPv6 keeps the first two groups. */
export function maskIp(ip: string | null | undefined): string | null {
  if (ip === null || ip === undefined || ip === '') return null;
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/i.exec(ip);
  if (v4 !== null) return `${v4[1] ?? ''}.${v4[2] ?? ''}.***.***`;
  if (ip.includes(':')) {
    const groups = ip.split(':').filter((g) => g !== '');
    return `${groups.slice(0, 2).join(':')}:****`;
  }
  return '***';
}

/**
 * Derived "Chrome on Windows" label for the session list. The proposed `device_label` column is
 * not in the approved schema, so the label is computed from the stored user agent on read.
 */
export function deviceLabel(userAgent: string | null | undefined): string {
  if (userAgent === null || userAgent === undefined || userAgent.trim() === '') {
    return 'Unknown device';
  }
  const ua = userAgent;
  const has = (...needles: string[]): boolean => needles.some((n) => ua.includes(n));
  const browsers: readonly (readonly [string, readonly string[]])[] = [
    ['Edge', ['Edg/']],
    ['Opera', ['OPR/', 'Opera']],
    ['Firefox', ['Firefox/']],
    ['Chrome', ['Chrome/', 'CriOS/']],
    ['Safari', ['Safari/']],
  ];
  const systems: readonly (readonly [string, readonly string[]])[] = [
    ['Android', ['Android']],
    ['iOS', ['iPhone', 'iPad', 'iPod']],
    ['Windows', ['Windows']],
    ['macOS', ['Mac OS X', 'Macintosh']],
    ['Linux', ['Linux']],
  ];
  const browser = browsers.find(([, needles]) => has(...needles))?.[0];
  const os = systems.find(([, needles]) => has(...needles))?.[0];
  if (browser !== undefined && os !== undefined) return `${browser} on ${os}`;
  return browser ?? os ?? 'Unknown device';
}

export interface SessionRow {
  readonly familyId: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export interface SessionDto {
  readonly sessionId: string;
  readonly deviceLabel: string;
  readonly ipAddress: string | null;
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly expiresAt: string;
  readonly current: boolean;
}

export function toSessionDto(row: SessionRow, currentSid: string): SessionDto {
  return {
    sessionId: row.familyId,
    deviceLabel: deviceLabel(row.userAgent),
    ipAddress: maskIp(row.ipAddress),
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: (row.lastUsedAt ?? row.issuedAt).toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    current: row.familyId === currentSid,
  };
}
