import type { RequestHandler } from 'express';
import helmet from 'helmet';

import type { AppConfig } from '../config/index.js';

/**
 * Security headers for a JSON API — SECURITY_GUIDELINES.md §11.1, BACKEND_STRUCTURE.md §5.1.
 * HSTS only in production (no `preload` until the domain is ready, per §11.1).
 */
export function securityHeaders(config: Pick<AppConfig, 'nodeEnv'>): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'same-site' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    strictTransportSecurity:
      config.nodeEnv === 'production' ? { maxAge: 63_072_000, includeSubDomains: true } : false,
    xPoweredBy: false,
  });
}

/**
 * Default `Cache-Control: no-store`. Public catalogue GETs override this per route
 * (API_DOCUMENTATION.md §2.5) when they are implemented.
 */
export function noStore(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  };
}
