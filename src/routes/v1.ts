import { Router } from 'express';

import type { AppContainer } from '../container.js';
import { assertAdminRoutesGuarded } from '../core/http/routeTable.js';
import type { ApiModule, ModuleFactory } from '../modules/types.js';
import { MODULE_FACTORIES } from '../modules/index.js';

/**
 * Versioned API surface mounted at `/api/v1` (PROJECT_CONTEXT.md §8).
 *
 * Customer/public routes mount at the root, admin routes under `/admin` behind router-level
 * `authenticate('admin')`, webhooks under `/webhooks` (see app.ts — raw body, before JSON).
 * Without a container (foundation tests) no business routes are mounted.
 */
export function buildModules(
  container: AppContainer,
  factories: readonly ModuleFactory[] = MODULE_FACTORIES,
): ApiModule[] {
  return factories.map((factory) => factory(container));
}

export function createV1Router(container?: AppContainer, modules?: readonly ApiModule[]): Router {
  const router = Router();
  if (container === undefined) return router;
  const list = modules ?? buildModules(container);
  // AUTH §19 / RBAC §7: refuse to start if any admin route lacks a permission guard (or re-auth).
  assertAdminRoutesGuarded(list);

  const admin = Router();
  for (const module of list) if (module.adminPublicRouter) admin.use(module.adminPublicRouter);
  admin.use(container.auth.authenticate('admin'));
  admin.use(container.rateLimit('admin-read'));
  for (const module of list) if (module.adminRouter) admin.use(module.adminRouter);
  router.use('/admin', admin);

  for (const module of list) if (module.publicRouter) router.use(module.publicRouter);
  return router;
}

export function createWebhookRouter(modules: readonly ApiModule[]): Router {
  const router = Router();
  for (const module of modules) if (module.webhookRouter) router.use(module.webhookRouter);
  return router;
}
