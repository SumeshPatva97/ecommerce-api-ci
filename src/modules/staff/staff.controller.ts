/**
 * HTTP adapter for staff users, roles and the permission catalogue.
 */
import type { Request, RequestHandler } from 'express';

import { actorFromRequest, requireAuthz } from '../../core/middleware/auth.js';
import { ok } from '../../core/http/envelope.js';
import { getValidated } from '../../core/middleware/validate.js';
import { permissionCatalogue } from './staff.mapper.js';
import type { RolesService } from './roles.service.js';
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
import type { ActorRef, StaffService } from './staff.service.js';

function actorOf(req: Request): ActorRef {
  return { authz: requireAuthz(req), audit: actorFromRequest(req) };
}

const userId = (req: Request): string => getValidated(req, 'params', UserIdParams).userId;
const roleId = (req: Request): string => getValidated(req, 'params', RoleIdParams).roleId;

export function createStaffController(staff: StaffService, roles: RolesService) {
  return {
    listUsers: async (req, res) => {
      const result = await staff.list(getValidated(req, 'query', ListUsersQuery));
      ok(req, res, result.data, { meta: result.meta });
    },
    createUser: async (req, res) => {
      const dto = await staff.create(actorOf(req), getValidated(req, 'body', CreateUserBody));
      ok(req, res, dto, { status: 201 });
    },
    getUser: async (req, res) => {
      ok(req, res, await staff.get(userId(req)));
    },
    updateUser: async (req, res) => {
      ok(
        req,
        res,
        await staff.update(actorOf(req), userId(req), getValidated(req, 'body', UpdateUserBody)),
      );
    },
    deleteUser: async (req, res) => {
      ok(req, res, await staff.remove(actorOf(req), userId(req)));
    },
    setUserRoles: async (req, res) => {
      const body = getValidated(req, 'body', SetUserRolesBody);
      ok(req, res, await staff.setRoles(actorOf(req), userId(req), body.roleIds));
    },
    setOverrides: async (req, res) => {
      const body = getValidated(req, 'body', SetOverridesBody);
      ok(req, res, await staff.setOverrides(actorOf(req), userId(req), body));
    },
    setStatus: async (req, res) => {
      const body = getValidated(req, 'body', SetStatusBody);
      ok(req, res, await staff.setStatus(actorOf(req), userId(req), body));
    },
    revokeSessions: async (req, res) => {
      ok(req, res, await staff.revokeSessions(actorOf(req), userId(req)));
    },

    listRoles: async (req, res) => {
      const result = await roles.list(getValidated(req, 'query', ListRolesQuery));
      ok(req, res, result.data, { meta: result.meta });
    },
    createRole: async (req, res) => {
      const dto = await roles.create(actorOf(req), getValidated(req, 'body', CreateRoleBody));
      ok(req, res, dto, { status: 201 });
    },
    getRole: async (req, res) => {
      ok(req, res, await roles.get(roleId(req)));
    },
    updateRole: async (req, res) => {
      ok(
        req,
        res,
        await roles.update(actorOf(req), roleId(req), getValidated(req, 'body', UpdateRoleBody)),
      );
    },
    deleteRole: async (req, res) => {
      ok(req, res, await roles.remove(actorOf(req), roleId(req)));
    },
    setRolePermissions: async (req, res) => {
      const body = getValidated(req, 'body', SetRolePermissionsBody);
      ok(req, res, await roles.setPermissions(actorOf(req), roleId(req), body));
    },

    listPermissions: (req, res) => {
      ok(req, res, permissionCatalogue());
    },
  } satisfies Record<string, RequestHandler>;
}
