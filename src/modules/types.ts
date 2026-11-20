/**
 * Module contract. Each feature module exports a factory returning its routers; `routes/v1.ts`
 * mounts them. Paths are relative to the mount point:
 *
 * - `publicRouter` → `/api/v1` (customer & public routes; the module applies `authenticate`
 *   / `optionalAuthenticate('storefront')` itself).
 * - `adminPublicRouter` → `/api/v1/admin` BEFORE admin authentication (only `/auth/*` login-type
 *   routes of the admin-auth module).
 * - `adminRouter` → `/api/v1/admin` AFTER `authenticate('admin')` is applied at router level
 *   (AUTHENTICATION_AUTHORIZATION §19), so no admin route can exist without authentication. Every
 *   admin route must carry `requirePermission`/`requireAnyPermission` (route-table self-test),
 *   except routes listed in `selfServiceAdminPaths`.
 * - `webhookRouter` → `/api/v1/webhooks` before JSON parsing (raw body, signature-verified).
 */
import type { Router } from 'express';

import type { AppContainer } from '../container.js';

export interface ApiModule {
  readonly name: string;
  readonly publicRouter?: Router;
  readonly adminPublicRouter?: Router;
  readonly adminRouter?: Router;
  readonly webhookRouter?: Router;
  /** Admin paths (relative to /admin) that need only authentication, e.g. `/auth/me`. */
  readonly selfServiceAdminPaths?: readonly string[];
}

export type ModuleFactory = (container: AppContainer) => ApiModule;
