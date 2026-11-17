import type { RequestHandler } from 'express';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';

import type { AppConfig } from '../config/index.js';
import { AppError } from '../errors/AppError.js';

/**
 * General per-IP limiter for `/api/v1` (BACKEND_STRUCTURE.md §5.1 stage 4, SECURITY_GUIDELINES §9).
 *
 * LIMITATION — in-memory store: valid for a single local instance only and NOT suitable for
 * multi-instance production. Each instance keeps its own counters (the effective limit multiplies
 * by the instance count) and counters reset on restart. Redis is deferred for local development
 * (PROJECT_CONTEXT D-38) and must be decided (OQ-35) before any multi-instance/production
 * deployment; the swap is `RateLimiterRedis` from the same library. Route-class limiters
 * (auth-strict, checkout, admin-write, …) are added with their modules (values: OQ-109).
 */
export function generalRateLimit(config: Pick<AppConfig, 'rateLimit'>): RequestHandler {
  if (!config.rateLimit.enabled) {
    return (_req, _res, next) => {
      next();
    };
  }

  const points = config.rateLimit.defaultPerMinute;
  const limiter = new RateLimiterMemory({ keyPrefix: 'general', points, duration: 60 });

  const setHeaders = (res: Parameters<RequestHandler>[1], state: RateLimiterRes): void => {
    res.setHeader('RateLimit-Limit', String(points));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, state.remainingPoints)));
    res.setHeader('RateLimit-Reset', String(Math.ceil(state.msBeforeNext / 1000)));
  };

  return (req, res, next) => {
    const key = req.ip ?? 'unknown';
    limiter
      .consume(key)
      .then((state) => {
        setHeaders(res, state);
        next();
      })
      .catch((rejection: unknown) => {
        if (rejection instanceof RateLimiterRes) {
          setHeaders(res, rejection);
          const retryAfter = String(Math.max(1, Math.ceil(rejection.msBeforeNext / 1000)));
          next(new AppError('RATE_LIMITED', undefined, { headers: { 'Retry-After': retryAfter } }));
          return;
        }
        next(rejection);
      });
  };
}
