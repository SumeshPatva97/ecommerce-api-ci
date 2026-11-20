/**
 * Staff authentication module (increment B1) — `/api/v1/admin/auth/*`.
 */
import type { ModuleFactory } from '../types.js';
import { ADMIN_SELF_SERVICE_PATHS, createAdminAuthRouters } from './admin-auth.routes.js';
import { createAdminAuthService } from './admin-auth.service.js';

export const createAdminAuthModule: ModuleFactory = (container) => {
  const service = createAdminAuthService(container);
  const { adminPublicRouter, adminRouter } = createAdminAuthRouters(container, service);
  return {
    name: 'admin-auth',
    adminPublicRouter,
    adminRouter,
    selfServiceAdminPaths: ADMIN_SELF_SERVICE_PATHS,
  };
};

export { createAdminAuthService, isMfaMandatory, loadStaffRoles } from './admin-auth.service.js';
export { createMfaService } from './mfa.js';
