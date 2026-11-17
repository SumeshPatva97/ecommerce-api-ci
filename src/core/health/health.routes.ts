import { Router } from 'express';

import type { Readiness } from './readiness.js';

/**
 * `/health/live` and `/health/ready` (PROJECT_CONTEXT.md §8, BACKEND_STRUCTURE.md §22).
 * Outside `/api/v1`, no auth, no rate limit, not access-logged. Responses never include
 * hostnames, connection strings or error messages — only check names and ok/fail.
 */
export function healthRouter(readiness: Readiness): Router {
  const router = Router();

  router.get('/health/live', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  router.get('/health/ready', async (_req, res) => {
    const report = await readiness.evaluate();
    if (report.ready) {
      res.status(200).json({ status: 'ready', checks: report.checks });
      return;
    }
    res.setHeader('Retry-After', '5');
    res.status(503).json({
      status: 'not_ready',
      checks: report.checks,
      ...(report.shuttingDown ? { shuttingDown: true } : {}),
    });
  });

  return router;
}
