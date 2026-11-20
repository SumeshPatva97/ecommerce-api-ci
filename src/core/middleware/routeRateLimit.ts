/**
 * Route-class rate limiters — decision OQ-109 (2026-11-19): for every class present in both
 * API_DOCUMENTATION.md §2.8 and SECURITY_GUIDELINES.md §9 the STRICTER value applies; classes found
 * in only one document keep that value. The general per-IP limiter (300/min, `generalRateLimit`)
 * stays as the global backstop.
 *
 * LIMITATION — in-memory (D-38/OQ-35): single local instance only; not for multi-instance production.
 */
import type { Request, RequestHandler } from 'express';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';

import { AppError } from '../errors/AppError.js';

export interface RateRule {
  readonly points: number;
  readonly durationSeconds: number;
  /** `ip`, `user` (falls back to IP), or `ip+identifier` (identifier from body.email). */
  readonly key: 'ip' | 'user' | 'ip+identifier';
}

export type RateClass =
  | 'auth-strict'
  | 'auth-refresh'
  | 'public-read'
  | 'search'
  | 'customer-write'
  | 'profile-write'
  | 'review-create'
  | 'coupon-apply'
  | 'checkout'
  | 'checkout-order'
  | 'admin-read'
  | 'admin-write'
  | 'admin-export'
  | 'barcode-labels'
  | 'media-signature'
  | 'webhook';

/** Canonical values (stricter-of-two). Each class may stack several rules. */
export const RATE_CLASSES: Readonly<Record<RateClass, readonly RateRule[]>> = {
  'auth-strict': [
    { points: 5, durationSeconds: 60, key: 'ip+identifier' },
    { points: 20, durationSeconds: 3600, key: 'ip' },
  ],
  'auth-refresh': [{ points: 30, durationSeconds: 60, key: 'ip' }],
  'public-read': [{ points: 300, durationSeconds: 60, key: 'ip' }],
  search: [{ points: 60, durationSeconds: 60, key: 'ip' }],
  'customer-write': [{ points: 60, durationSeconds: 60, key: 'user' }],
  'profile-write': [{ points: 30, durationSeconds: 60, key: 'user' }],
  'review-create': [{ points: 5, durationSeconds: 3600, key: 'user' }],
  'coupon-apply': [{ points: 10, durationSeconds: 600, key: 'user' }],
  checkout: [{ points: 10, durationSeconds: 60, key: 'user' }],
  'checkout-order': [{ points: 5, durationSeconds: 60, key: 'user' }],
  'admin-read': [{ points: 600, durationSeconds: 60, key: 'user' }],
  'admin-write': [{ points: 120, durationSeconds: 60, key: 'user' }],
  'admin-export': [{ points: 10, durationSeconds: 3600, key: 'user' }],
  'barcode-labels': [{ points: 30, durationSeconds: 60, key: 'user' }],
  'media-signature': [{ points: 60, durationSeconds: 3600, key: 'user' }],
  webhook: [{ points: 600, durationSeconds: 60, key: 'ip' }],
};

function keyFor(req: Request, rule: RateRule): string {
  const ip = req.ip ?? 'unknown';
  switch (rule.key) {
    case 'ip':
      return ip;
    case 'user':
      return req.authz?.userId ?? `ip:${ip}`;
    case 'ip+identifier': {
      const body: unknown = req.body;
      const email =
        typeof body === 'object' &&
        body !== null &&
        'email' in body &&
        typeof body.email === 'string'
          ? body.email.trim().toLowerCase()
          : '';
      return `${ip}|${email}`;
    }
  }
}

/** Marker read by the OpenAPI generator. */
export const RATE_CLASS = Symbol.for('ecommerce.rateClass');

export type RateLimitFactory = (rateClass: RateClass) => RequestHandler;

/** One limiter set per process; `enabled=false` only in development/test (env validation). */
export function createRouteRateLimiter(enabled: boolean): RateLimitFactory {
  const limiters = new Map<string, RateLimiterMemory>();
  const limiterFor = (rateClass: RateClass, index: number, rule: RateRule): RateLimiterMemory => {
    const id = `${rateClass}#${String(index)}`;
    let limiter = limiters.get(id);
    if (limiter === undefined) {
      limiter = new RateLimiterMemory({
        keyPrefix: id,
        points: rule.points,
        duration: rule.durationSeconds,
      });
      limiters.set(id, limiter);
    }
    return limiter;
  };

  const build = (rateClass: RateClass): RequestHandler => {
    if (!enabled) {
      return (_req, _res, next) => {
        next();
      };
    }
    const rules = RATE_CLASSES[rateClass];
    return (req, _res, next) => {
      Promise.all(
        rules.map((rule, i) => limiterFor(rateClass, i, rule).consume(keyFor(req, rule))),
      ).then(
        () => {
          next();
        },
        (rejection: unknown) => {
          if (rejection instanceof RateLimiterRes) {
            const retryAfter = String(Math.max(1, Math.ceil(rejection.msBeforeNext / 1000)));
            next(
              new AppError(
                'RATE_LIMITED',
                'Too many attempts. Please try again in a few minutes.',
                {
                  headers: { 'Retry-After': retryAfter },
                },
              ),
            );
            return;
          }
          next(rejection);
        },
      );
    };
  };

  return (rateClass) => Object.assign(build(rateClass), { [RATE_CLASS]: rateClass });
}
