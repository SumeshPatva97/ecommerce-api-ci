import express, { type Express, type Router } from 'express';

import type { AppConfig } from './core/config/index.js';
import { healthRouter } from './core/health/health.routes.js';
import type { Readiness } from './core/health/readiness.js';
import type { Logger } from './core/logger/logger.js';
import { accessLog } from './core/middleware/accessLog.js';
import { jsonBody, requireJsonContentType } from './core/middleware/bodyParsers.js';
import { corsPolicy } from './core/middleware/cors.js';
import { errorHandler } from './core/middleware/errorHandler.js';
import { notFound } from './core/middleware/notFound.js';
import { generalRateLimit } from './core/middleware/rateLimit.js';
import { requestId } from './core/middleware/requestId.js';
import { noStore, securityHeaders } from './core/middleware/security.js';
import { createV1Router } from './routes/v1.js';

export const API_V1_PREFIX = '/api/v1';

export interface AppDependencies {
  config: AppConfig;
  logger: Logger;
  readiness: Readiness;
  /** Overrides the v1 router (tests mount fixture routes through the real pipeline). */
  v1Router?: Router;
}

/**
 * Builds the Express app without listening (used by `server.ts` and by tests).
 * Middleware order is fixed here — BACKEND_STRUCTURE.md §5:
 * requestId → access log → helmet → [health] → CORS → rate limit → body parse → routes → 404 → errors.
 * Authentication, permissions, re-auth and idempotency stages are added with their modules.
 */
export function createApp({ config, logger, readiness, v1Router }: AppDependencies): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy === 0 ? false : config.trustProxy);
  app.set('json spaces', 0);

  app.use(requestId());
  app.use(accessLog(logger));
  app.use(securityHeaders(config));
  app.use(noStore());

  app.use(healthRouter(readiness));

  app.use(corsPolicy(config));
  app.use(API_V1_PREFIX, generalRateLimit(config));
  // Webhook routes (raw body for signature verification) will be mounted here, before JSON parsing.
  app.use(API_V1_PREFIX, requireJsonContentType(), jsonBody(config));
  app.use(API_V1_PREFIX, v1Router ?? createV1Router());

  app.use(notFound());
  app.use(errorHandler(logger));

  return app;
}
