/**
 * `GET /me` DTO — API_DOCUMENTATION.md §3.2.
 */
import type { UserStatus } from '../../generated/prisma/enums.js';

export interface MeRow {
  readonly id: string;
  readonly email: string;
  readonly emailVerifiedAt: Date | null;
  readonly phone: string | null;
  readonly phoneVerifiedAt: Date | null;
  readonly firstName: string;
  readonly lastName: string | null;
  readonly status: UserStatus;
  readonly createdAt: Date;
}

export interface MeDto {
  readonly id: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly phone: string | null;
  readonly phoneVerified: boolean;
  readonly firstName: string;
  readonly lastName: string | null;
  readonly status: UserStatus;
  readonly createdAt: string;
  readonly defaultAddressId: string | null;
}

export function toMeDto(user: MeRow, defaultAddressId: string | null): MeDto {
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
    phone: user.phone,
    phoneVerified: user.phoneVerifiedAt !== null,
    firstName: user.firstName,
    lastName: user.lastName,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
    defaultAddressId,
  };
}
