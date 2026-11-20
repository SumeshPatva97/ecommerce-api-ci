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
import type { AppContainer } from './container.js';
import type { ApiModule } from './modules/types.js';
import { buildModules, createV1Router, createWebhookRouter } from './routes/v1.js';

export const API_V1_PREFIX = '/api/v1';

export interface AppDependencies {
  config: AppConfig;
  logger: Logger;
  readiness: Readiness;
  /** Overrides the v1 router (tests mount fixture routes through the real pipeline). */
  v1Router?: Router;
  /** Feature modules' dependencies; without it only health routes exist (foundation tests). */
  container?: AppContainer;
  /** Overrides the module list built from the container (tests). */
  modules?: readonly ApiModule[];
}

/**
 * Builds the Express app without listening (used by `server.ts` and by tests).
 * Middleware order is fixed here — BACKEND_STRUCTURE.md §5:
 * requestId → access log → helmet → [health] → CORS → rate limit → body parse → routes → 404 → errors.
 * Authentication, permissions, re-auth and idempotency stages are added with their modules.
 */
export function createApp({
  config,
  logger,
  readiness,
  v1Router,
  container,
  modules,
}: AppDependencies): Express {
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
  const moduleList = container === undefined ? [] : (modules ?? buildModules(container));
  // Webhooks: raw body (1 MB) for signature verification, mounted before JSON parsing (§16).
  app.use(
    `${API_V1_PREFIX}/webhooks`,
    express.raw({ type: '*/*', limit: '1mb' }),
    createWebhookRouter(moduleList),
  );
  app.use(API_V1_PREFIX, requireJsonContentType(), jsonBody(config));
  app.use(API_V1_PREFIX, v1Router ?? createV1Router(container, moduleList));

  app.use(notFound());
  app.use(errorHandler(logger));

  return app;
}
