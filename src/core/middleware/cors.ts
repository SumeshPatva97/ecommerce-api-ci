import cors from 'cors';
import type { RequestHandler } from 'express';

import type { AppConfig } from '../config/index.js';
import { AppError } from '../errors/AppError.js';

const ADMIN_PREFIX = '/api/v1/admin';

/**
 * Route-family detection. Express routing is case-insensitive by default, so `/API/V1/ADMIN/x`
 * reaches the same handlers as `/api/v1/admin/x`; the family check must therefore be
 * case-insensitive too, otherwise a non-admin origin could reach admin routes (review D1).
 */
export function isAdminRoutePath(path: string): boolean {
  const normalized = path.toLowerCase();
  return normalized === ADMIN_PREFIX || normalized.startsWith(`${ADMIN_PREFIX}/`);
}

/**
 * Exact-origin CORS allowlist with route-family restriction — CROSS_APPLICATION_INTEGRATION.md
 * §3.2, SECURITY_GUIDELINES.md §12, AUTHENTICATION_AUTHORIZATION.md §16.3, BACKEND_STRUCTURE.md
 * §5.1 stage 3. Variable naming per PROJECT_CONTEXT.md R-46 (single `CORS_ORIGINS` list; the
 * admin origin is identified by `ADMIN_URL`).
 * - Origin must be listed in CORS_ORIGINS (no wildcards, no arbitrary reflection).
 * - `/api/v1/admin/*` (matched case-insensitively, like Express routing) accepts only the admin
 *   origin.
 * - All other routes accept only non-admin (storefront) origins.
 * - A disallowed Origin gets 403 FORBIDDEN with no CORS headers.
 * - Requests without an Origin header (server-to-server, curl) are unaffected; CORS is not an
 *   authorisation control.
 * Webhook routes (no CORS at all) are mounted before this middleware when they are built.
 */
export function corsPolicy(config: Pick<AppConfig, 'cors'>): RequestHandler {
  const allowed = new Set(config.cors.origins);
  const { adminOrigin } = config.cors;

  const handler = cors({
    origin: true, // reflects the request origin — only reached after the allowlist check below
    credentials: true,
    maxAge: 600,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Idempotency-Key',
      'X-Request-Id',
      'X-Client',
      'If-None-Match',
    ],
    exposedHeaders: [
      'X-Request-Id',
      'ETag',
      'RateLimit-Limit',
      'RateLimit-Remaining',
      'RateLimit-Reset',
      'Retry-After',
      'Idempotent-Replayed',
      'Deprecation',
      'Sunset',
      'Link',
      'Content-Disposition',
      'X-API-Version',
    ],
  });

  return (req, res, next) => {
    const origin = req.get('origin');
    if (origin === undefined) {
      next();
      return;
    }
    const isAdminRoute = isAdminRoutePath(req.path);
    const familyMatches = isAdminRoute ? origin === adminOrigin : origin !== adminOrigin;
    const permitted = allowed.has(origin) && familyMatches;
    if (!permitted) {
      next(new AppError('FORBIDDEN', 'Origin not allowed.'));
      return;
    }
    handler(req, res, next);
  };
}
