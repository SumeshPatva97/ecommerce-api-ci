/**
 * Refresh-token cookies & CSRF defence for cookie endpoints — AUTHENTICATION_AUTHORIZATION.md §16.
 *
 * | Cookie  | Path               | SameSite | Max-Age |
 * | sf_rt   | /api/v1/auth       | Lax      | 30 d (session cookie when "remember me" unticked, OQ-92) |
 * | adm_rt  | /api/v1/admin/auth | Strict   | 12 h |
 */
import type { Request, RequestHandler, Response } from 'express';

import { AppError } from '../errors/AppError.js';

export const COOKIE_NAMES = { storefront: 'sf_rt', admin: 'adm_rt' } as const;
export const COOKIE_PATHS = { storefront: '/api/v1/auth', admin: '/api/v1/admin/auth' } as const;

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (header === undefined) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const raw = part.slice(index + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

export function readRefreshCookie(
  req: Request,
  audience: 'storefront' | 'admin',
): string | undefined {
  const value = parseCookies(req.get('cookie'))[COOKIE_NAMES[audience]];
  return value !== undefined && /^[A-Za-z0-9_-]{20,128}$/.test(value) ? value : undefined;
}

export interface CookieSettings {
  readonly secure: boolean;
  readonly domainStorefront: string | undefined;
  readonly domainAdmin: string | undefined;
}

/** `maxAgeSeconds` undefined → session cookie (customer "remember me" unticked, OQ-92). */
export function setRefreshCookie(
  res: Response,
  audience: 'storefront' | 'admin',
  token: string,
  maxAgeSeconds: number | undefined,
  settings: CookieSettings,
): void {
  const domain = audience === 'admin' ? settings.domainAdmin : settings.domainStorefront;
  res.cookie(COOKIE_NAMES[audience], token, {
    httpOnly: true,
    secure: settings.secure,
    sameSite: audience === 'admin' ? 'strict' : 'lax',
    path: COOKIE_PATHS[audience],
    ...(maxAgeSeconds === undefined ? {} : { maxAge: maxAgeSeconds * 1000 }),
    ...(domain === undefined ? {} : { domain }),
  });
}

export function clearRefreshCookie(
  res: Response,
  audience: 'storefront' | 'admin',
  settings: CookieSettings,
): void {
  const domain = audience === 'admin' ? settings.domainAdmin : settings.domainStorefront;
  res.clearCookie(COOKIE_NAMES[audience], {
    httpOnly: true,
    secure: settings.secure,
    sameSite: audience === 'admin' ? 'strict' : 'lax',
    path: COOKIE_PATHS[audience],
    ...(domain === undefined ? {} : { domain }),
  });
}

/**
 * CSRF defence in depth for the cookie-reading endpoints (refresh, logout): the `Origin` must be the
 * app's own origin and `X-Client` must name the app (§16.2). Missing Origin → 403.
 */
export function requireCookieOrigin(
  audience: 'storefront' | 'admin',
  allowedOrigin: string,
): RequestHandler {
  return (req, _res, next) => {
    const origin = req.get('origin');
    const client = req.get('x-client');
    if (origin !== allowedOrigin || client !== audience) {
      next(new AppError('FORBIDDEN', 'Request origin not allowed.'));
      return;
    }
    next();
  };
}
