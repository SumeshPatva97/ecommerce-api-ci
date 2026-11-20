/**
 * Staff, roles & permissions — zod schemas (API_DOCUMENTATION.md §4.15).
 *
 * Every admin body is strict (unknown keys → 422, SECURITY_GUIDELINES §5). `isSuperadmin` is the
 * only privileged field accepted, and only from a Superadmin (rule R11 — enforced in the service so
 * the attempt is audited).
 */
import { z } from 'zod';

import { PAGE_LIMITS, paginationQuery } from '../../core/http/pagination.js';
import { PERMISSION_KEYS } from '../../lib/permissions.js';
import { normalizePhone } from '../../lib/normalize.js';

export const UserIdParams = z.strictObject({ userId: z.uuid() });
export const RoleIdParams = z.strictObject({ roleId: z.uuid() });

const STAFF_STATUSES = ['PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DISABLED'] as const;

export const ListUsersQuery = paginationQuery(PAGE_LIMITS.adminList).extend({
  q: z.string().trim().min(1).max(100).optional(),
  status: z.enum(STAFF_STATUSES).optional(),
  roleId: z.uuid().optional(),
  sort: z.enum(['createdAt', '-createdAt', 'firstName', '-firstName']).default('-createdAt'),
});
export type ListUsersQuery = z.output<typeof ListUsersQuery>;

const name = z.string().trim().min(1).max(80);
const phone = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const normalized = normalizePhone(value);
    if (normalized === undefined) {
      ctx.addIssue({ code: 'custom', message: 'Must be an Indian mobile number (+91).' });
      return z.NEVER;
    }
    return normalized;
  });

export const CreateUserBody = z.strictObject({
  email: z.string().trim().max(254).pipe(z.email()),
  firstName: name,
  lastName: name.optional(),
  phone: phone.optional(),
  roleIds: z.array(z.uuid()).max(20).default([]),
  /** R11: accepted from a Superadmin only (checked in the service, audited). */
  isSuperadmin: z.boolean().optional(),
});
export type CreateUserBody = z.output<typeof CreateUserBody>;

export const UpdateUserBody = z
  .strictObject({
    firstName: name.optional(),
    lastName: name.nullable().optional(),
    phone: phone.nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Provide at least one field.' });
export type UpdateUserBody = z.output<typeof UpdateUserBody>;

const uniqueStrings = (values: readonly string[]): boolean =>
  new Set(values).size === values.length;

export const SetUserRolesBody = z.strictObject({
  roleIds: z.array(z.uuid()).max(20).refine(uniqueStrings, { message: 'Role ids must be unique.' }),
});
export type SetUserRolesBody = z.output<typeof SetUserRolesBody>;

export const permissionKey = z
  .string()
  .refine((key) => PERMISSION_KEYS.has(key), { message: 'Unknown permission key.' });

export const SetOverridesBody = z.strictObject({
  overrides: z
    .array(
      z.strictObject({
        permissionKey,
        // D-42 / OQ-27: DENY overrides only — ALLOW is not adopted.
        effect: z.literal('DENY'),
        reason: z.string().trim().min(1).max(500).optional(),
      }),
    )
    .max(PERMISSION_KEYS.size)
    .refine((rows) => uniqueStrings(rows.map((r) => r.permissionKey)), {
      message: 'Each permission may appear once.',
    }),
});
export type SetOverridesBody = z.output<typeof SetOverridesBody>;

export const SetStatusBody = z.strictObject({
  status: z.enum(['ACTIVE', 'SUSPENDED', 'DISABLED']),
  reason: z.string().trim().min(1).max(500),
});
export type SetStatusBody = z.output<typeof SetStatusBody>;

// Roles -----------------------------------------------------------------------------------------

export const ListRolesQuery = paginationQuery(PAGE_LIMITS.adminList).extend({
  q: z.string().trim().min(1).max(100).optional(),
  isActive: z.enum(['true', 'false']).optional(),
});
export type ListRolesQuery = z.output<typeof ListRolesQuery>;

const roleName = z.string().trim().min(2).max(50);
const description = z.string().trim().max(500);

export const CreateRoleBody = z.strictObject({
  code: z.string().regex(/^[A-Z_]{2,30}$/, { message: 'Use 2–30 upper-case letters or _.' }),
  name: roleName,
  description: description.optional(),
  permissionKeys: z
    .array(permissionKey)
    .refine(uniqueStrings, { message: 'Permission keys must be unique.' })
    .default([]),
});
export type CreateRoleBody = z.output<typeof CreateRoleBody>;

export const UpdateRoleBody = z
  .strictObject({
    name: roleName.optional(),
    description: description.nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Provide at least one field.' });
export type UpdateRoleBody = z.output<typeof UpdateRoleBody>;

export const SetRolePermissionsBody = z.strictObject({
  permissionKeys: z
    .array(permissionKey)
    .refine(uniqueStrings, { message: 'Permission keys must be unique.' }),
  comment: z.string().trim().min(1).max(500).optional(),
});
export type SetRolePermissionsBody = z.output<typeof SetRolePermissionsBody>;
