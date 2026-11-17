import { Router } from 'express';

/**
 * Versioned API surface mounted at `/api/v1` (PROJECT_CONTEXT.md §8).
 *
 * Feature modules register their routers here as they are built, following the build order in
 * IMPLEMENTATION_ROADMAP.md §6.1 (B1 auth/RBAC → B2 settings/tax/catalog masters → …).
 * Customer/public routes mount at the root of this router, admin routes under `/admin`,
 * webhooks under `/webhooks` (raw-body parser, mounted before JSON parsing in app.ts).
 *
 * No business routes exist yet in this increment.
 */
export function createV1Router(): Router {
  const router = Router();
  return router;
}
