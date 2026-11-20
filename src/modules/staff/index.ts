/**
 * Staff & RBAC module — staff users (invite, profile, roles, DENY overrides, status, sessions),
 * roles, role-permission mapping and the permission catalogue (API_DOCUMENTATION.md §4.15).
 *
 * Not implemented: `POST /admin/users/:userId/mfa/reset` — not part of API_DOCUMENTATION.md
 * §4.15 / PROJECT_CONTEXT §15 R-13 (only mentioned in ADMIN_WORKFLOWS / AUTH §15 as a proposal).
 */
import type { ModuleFactory } from '../types.js';
import { createRolesService } from './roles.service.js';
import { createStaffController } from './staff.controller.js';
import { createStaffRouter } from './staff.routes.js';
import { createStaffService } from './staff.service.js';

export const createStaffModule: ModuleFactory = (container) => {
  const controller = createStaffController(
    createStaffService(container),
    createRolesService(container),
  );
  return { name: 'staff', adminRouter: createStaffRouter(container, controller) };
};
