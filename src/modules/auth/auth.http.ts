/**
 * HTTP helpers shared by the auth, admin-auth and me controllers.
 */
import type { Request, Response } from 'express';

import type { AppContainer } from '../../container.js';
import { AppError } from '../../core/errors/AppError.js';
import {
  clearRefreshCookie,
  setRefreshCookie,
  type CookieSettings,
} from '../../core/http/cookies.js';
import { actorFromRequest, parseBearer } from '../../core/middleware/auth.js';
import { verifyAccessToken } from '../../core/security/jwt.js';
import type { Audience, RequestMeta } from './auth.context.js';
import type { IssuedSession } from './session.service.js';

export function requestMeta(req: Request, audience: Audience): RequestMeta {
  const fallback =
    audience === 'admin'
      ? ({ type: 'STAFF', loginType: 'STAFF' } as const)
      : ({ type: 'CUSTOMER', loginType: 'CUSTOMER' } as const);
  return {
    ip: req.ip,
    userAgent: req.get('user-agent'),
    actor: actorFromRequest(req, fallback),
  };
}

export function cookieSettings(container: AppContainer): CookieSettings {
  return container.config.auth.cookies;
}

export function setSessionCookie(
  container: AppContainer,
  res: Response,
  audience: Audience,
  session: IssuedSession,
): void {
  setRefreshCookie(
    res,
    audience,
    session.refreshToken,
    session.cookieMaxAgeSeconds,
    cookieSettings(container),
  );
}

export function clearSessionCookie(
  container: AppContainer,
  res: Response,
  audience: Audience,
): void {
  clearRefreshCookie(res, audience, cookieSettings(container));
}

/**
 * Identity from a bearer token for logout — an EXPIRED (but otherwise valid) token is accepted so
 * a user whose access token lapsed can still log out (§10.1). Invalid tokens are ignored.
 */
export function bearerIdentity(
  req: Request,
  container: AppContainer,
  audience: Audience,
): { userId: string; sid: string } | undefined {
  const token = parseBearer(req.get('authorization'));
  if (token === undefined) return undefined;
  const { jwt } = container.config.auth;
  try {
    const claims = verifyAccessToken(container.keySet, token, {
      audience: audience === 'admin' ? jwt.audienceAdmin : jwt.audienceStorefront,
      issuer: jwt.issuer,
      // Signature, issuer and audience are still checked; only `exp` is relaxed (≤ 1 day).
      now: new Date(container.clock().getTime() - 24 * 3600 * 1000),
      skewSeconds: 24 * 3600,
    });
    return { userId: claims.sub, sid: claims.sid };
  } catch {
    return undefined;
  }
}

/** Clears the refresh cookie when a refresh fails with 401, then rethrows. */
export function clearCookieOnAuthError(
  container: AppContainer,
  res: Response,
  audience: Audience,
  error: unknown,
): never {
  if (
    error instanceof AppError &&
    (error.code === 'UNAUTHENTICATED' || error.code === 'TOKEN_EXPIRED')
  ) {
    clearSessionCookie(container, res, audience);
  }
  throw error;
}
