/**
 * Staff auth DTOs — API_DOCUMENTATION.md §4.1.
 */
import type { UserStatus } from '../../generated/prisma/enums.js';

export interface StaffRole {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly isSystem: boolean;
}

export interface StaffLoginUserDto {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string | null;
  readonly email: string;
  readonly isSuperadmin: boolean;
  readonly roles: readonly StaffRole[];
}

export function toStaffLoginUser(
  user: {
    readonly id: string;
    readonly firstName: string;
    readonly lastName: string | null;
    readonly email: string;
    readonly isSuperadmin: boolean;
  },
  roles: readonly StaffRole[],
): StaffLoginUserDto {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    isSuperadmin: user.isSuperadmin,
    roles,
  };
}

export interface StaffProfileDto {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string | null;
  readonly email: string;
  readonly isSuperadmin: boolean;
  readonly status: UserStatus;
  readonly mfaEnabled: boolean;
  readonly lastLoginAt: string | null;
}

export function toStaffProfile(user: {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string | null;
  readonly email: string;
  readonly isSuperadmin: boolean;
  readonly status: UserStatus;
  readonly mfaEnabled: boolean;
  readonly lastLoginAt: Date | null;
}): StaffProfileDto {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    isSuperadmin: user.isSuperadmin,
    status: user.status,
    mfaEnabled: user.mfaEnabled,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
  };
}
