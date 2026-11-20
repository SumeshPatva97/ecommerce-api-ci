/**
 * Route-table self-check — AUTHENTICATION_AUTHORIZATION.md §19 ("no admin route can be added
 * without auth (enforced by a startup self-test that enumerates routes)"), ROLE_PERMISSION_AND_AUDIT_LOGS
 * §7 ("an admin route without a declared permission fails startup").
 *
 * Rules for every module's `adminRouter` (router-level `authenticate('admin')` is applied by v1.ts):
 * 1. each route declares a permission guard, unless listed in `selfServiceAdminPaths`;
 * 2. a route using a critical permission key carries `requireReauth()`, unless listed in
 *    `REAUTH_EXEMPT` with its documentary basis.
 */
import type { Router } from 'express';

import { PERMISSION_GUARD, REAUTH_GUARD } from '../middleware/auth.js';
import { isCriticalPermission } from '../../lib/permissions.js';
import type { ApiModule } from '../../modules/types.js';

export interface RouteInfo {
  readonly method: string;
  readonly path: string;
  readonly permissions: readonly string[];
  readonly reauth: boolean;
}

interface LayerLike {
  route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] };
  handle?: { stack?: LayerLike[] };
}

/**
 * Routes that use a critical permission key but are documented WITHOUT re-auth. Each entry cites the
 * contract; anything else using a critical key must carry requireReauth().
 */
export const REAUTH_EXEMPT: Readonly<Record<string, readonly string[]>> = {
  // API_DOCUMENTATION §4.11: reject = `refunds.approve` only (no money moves; R-15 lists approve/complete).
  refunds: ['POST /refunds/:refundId/reject'],
};

export function listRoutes(router: Router): RouteInfo[] {
  const out: RouteInfo[] = [];
  const walk = (stack: LayerLike[]): void => {
    for (const layer of stack) {
      if (layer.route) {
        const handles = layer.route.stack.map((l) => l.handle as Record<symbol, unknown>);
        const permissions = handles.flatMap(
          (h) => (h[PERMISSION_GUARD] as string[] | undefined) ?? [],
        );
        const reauth = handles.some((h) => h[REAUTH_GUARD] === true);
        for (const method of Object.keys(layer.route.methods)) {
          out.push({ method: method.toUpperCase(), path: layer.route.path, permissions, reauth });
        }
      } else if (layer.handle?.stack) {
        walk(layer.handle.stack);
      }
    }
  };
  walk((router as unknown as { stack: LayerLike[] }).stack);
  return out;
}

/** Returns human-readable violations for one module (empty = compliant). */
export function adminRouteViolations(
  module: ApiModule,
  reauthExempt: readonly string[] = REAUTH_EXEMPT[module.name] ?? [],
): string[] {
  if (module.adminRouter === undefined) return [];
  const selfService = new Set(module.selfServiceAdminPaths ?? []);
  const problems: string[] = [];
  for (const route of listRoutes(module.adminRouter)) {
    if (selfService.has(route.path)) continue;
    const id = `${route.method} ${route.path}`;
    if (route.permissions.length === 0) {
      problems.push(`${module.name}: ${id} has no permission guard`);
      continue;
    }
    if (
      route.permissions.some(isCriticalPermission) &&
      !route.reauth &&
      !reauthExempt.includes(id)
    ) {
      problems.push(`${module.name}: ${id} uses a critical permission without requireReauth`);
    }
  }
  return problems;
}

/** Throws at startup if any registered module violates the admin route rules. */
export function assertAdminRoutesGuarded(modules: readonly ApiModule[]): void {
  const problems = modules.flatMap((module) => adminRouteViolations(module));
  if (problems.length > 0) {
    throw new Error(`Admin route self-check failed:\n  - ${problems.join('\n  - ')}`);
  }
}
