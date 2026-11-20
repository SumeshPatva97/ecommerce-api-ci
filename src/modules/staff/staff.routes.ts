/**
 * Staff & RBAC admin routes (relative to `/api/v1/admin`, mounted after `authenticate('admin')`).
 * API_DOCUMENTATION.md §4.15 / §7; every route that carries a critical key (ROLE_PERMISSION §3)
 * also carries `requireReauth()` (R7, PROJECT_CONTEXT §15 R-15).
 */
import { Router } from 'express';

import type { AppContainer } from '../../container.js';
import { respondsWith } from '../../core/http/successStatus.js';
import { validate } from '../../core/middleware/validate.js';
import type { createStaffController } from './staff.controller.js';
import {
  CreateRoleBody,
  CreateUserBody,
  ListRolesQuery,
  ListUsersQuery,
  RoleIdParams,
  SetOverridesBody,
  SetRolePermissionsBody,
  SetStatusBody,
  SetUserRolesBody,
  UpdateRoleBody,
  UpdateUserBody,
  UserIdParams,
} from './staff.schemas.js';

export function createStaffRouter(
  c: AppContainer,
  h: ReturnType<typeof createStaffController>,
): Router {
  const perm = (key: string): ReturnType<AppContainer['auth']['requirePermission']> =>
    c.auth.requirePermission(key);
  const reauth = (): ReturnType<AppContainer['auth']['requireReauth']> => c.auth.requireReauth();
  const write = (): ReturnType<AppContainer['rateLimit']> => c.rateLimit('admin-write');
  const r = Router();

  // Staff users
  r.get('/users', perm('admin_users.view'), validate({ query: ListUsersQuery }), h.listUsers);
  r.post(
    '/users',
    perm('admin_users.create'),
    reauth(),
    write(),
    validate({ body: CreateUserBody }),
    respondsWith(201),
    h.createUser,
  );
  r.get('/users/:userId', perm('admin_users.view'), validate({ params: UserIdParams }), h.getUser);
  r.patch(
    '/users/:userId',
    perm('admin_users.update'),
    reauth(),
    write(),
    validate({ params: UserIdParams, body: UpdateUserBody }),
    h.updateUser,
  );
  r.delete(
    '/users/:userId',
    perm('admin_users.delete'),
    reauth(),
    write(),
    validate({ params: UserIdParams }),
    h.deleteUser,
  );
  r.put(
    '/users/:userId/roles',
    perm('admin_users.update'),
    reauth(),
    write(),
    validate({ params: UserIdParams, body: SetUserRolesBody }),
    h.setUserRoles,
  );
  r.put(
    '/users/:userId/permission-overrides',
    perm('admin_users.update'),
    reauth(),
    write(),
    validate({ params: UserIdParams, body: SetOverridesBody }),
    h.setOverrides,
  );
  r.patch(
    '/users/:userId/status',
    perm('admin_users.update'),
    reauth(),
    write(),
    validate({ params: UserIdParams, body: SetStatusBody }),
    h.setStatus,
  );
  r.delete(
    '/users/:userId/sessions',
    perm('admin_users.update'),
    reauth(),
    write(),
    validate({ params: UserIdParams }),
    h.revokeSessions,
  );

  // Roles
  r.get('/roles', perm('roles.view'), validate({ query: ListRolesQuery }), h.listRoles);
  r.post(
    '/roles',
    perm('roles.create'),
    reauth(),
    write(),
    validate({ body: CreateRoleBody }),
    respondsWith(201),
    h.createRole,
  );
  r.get('/roles/:roleId', perm('roles.view'), validate({ params: RoleIdParams }), h.getRole);
  r.patch(
    '/roles/:roleId',
    perm('roles.update'),
    reauth(),
    write(),
    validate({ params: RoleIdParams, body: UpdateRoleBody }),
    h.updateRole,
  );
  r.delete(
    '/roles/:roleId',
    perm('roles.delete'),
    reauth(),
    write(),
    validate({ params: RoleIdParams }),
    h.deleteRole,
  );
  r.put(
    '/roles/:roleId/permissions',
    perm('roles.update'),
    reauth(),
    write(),
    validate({ params: RoleIdParams, body: SetRolePermissionsBody }),
    h.setRolePermissions,
  );

  // Permission catalogue (rows are seeded only — R10; no write routes)
  r.get('/permissions', perm('roles.view'), h.listPermissions);

  return r;
}
