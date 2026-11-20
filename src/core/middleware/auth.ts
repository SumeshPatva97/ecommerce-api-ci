/**
 * Authentication & authorization middleware — BACKEND_STRUCTURE.md §5.1 stages 6–8,
 * AUTHENTICATION_AUTHORIZATION.md §18, ROLE_PERMISSION_AND_AUDIT_LOGS.md §7.
 *
 * - `authenticate(aud)`: Bearer EdDSA JWT for the route family's audience, then server-side
 *   context (user status, live session = refresh family, effective permissions; cached ≤ 60 s).
 *   Customer token on admin routes (and vice versa) → 401.
 * - `requirePermission(...keys)`: all keys required (AND); `requireAnyPermission` = OR. Denials
 *   are audited (`PERMISSION_DENIED`). Superadmins bypass (still audited by the services).
 * - `requireReauth()`: password re-entry within REAUTH_WINDOW_MINUTES, bound to the session
 *   (`reauth:{sid}`), Superadmins NOT exempt.
 */
import type { Request, RequestHandler } from 'express';

import { AppError } from '../errors/AppError.js';
import { JwtError, verifyAccessToken, type JwtKeySet } from '../security/jwt.js';
import type { KeyValueStore } from '../store/memoryStore.js';
import type { DbClient } from '../db/transaction.js';
import type { AuditActor, AuditService } from '../../modules/audit/audit.service.js';
import {
  hasPermission,
  type Audience,
  type AuthContext,
  type PermissionService,
} from '../../modules/rbac/permission.service.js';

/** Marker read by the route-table self-test (every admin route must declare permissions). */
export const PERMISSION_GUARD = Symbol.for('ecommerce.permissionGuard');
export const REAUTH_GUARD = Symbol.for('ecommerce.reauthGuard');
/** Marker on authenticate/optionalAuthenticate handlers (OpenAPI security generation). */
export const AUTH_GUARD = Symbol.for('ecommerce.authGuard');

export type GuardedHandler = RequestHandler & {
  [PERMISSION_GUARD]?: readonly string[];
  [REAUTH_GUARD]?: true;
  [AUTH_GUARD]?: { readonly audience: Audience; readonly optional: boolean };
};

export interface AuthMiddlewareDeps {
  readonly db: DbClient;
  readonly keySet: JwtKeySet;
  readonly issuer: string;
  readonly audiences: { readonly storefront: string; readonly admin: string };
  readonly permissions: PermissionService;
  readonly audit: AuditService;
  readonly store: KeyValueStore;
  readonly clock: () => Date;
}

export interface AuthMiddleware {
  authenticate(audience: Audience): RequestHandler;
  optionalAuthenticate(audience: Audience): RequestHandler;
  requirePermission(...keys: string[]): GuardedHandler;
  requireAnyPermission(...keys: string[]): GuardedHandler;
  requireReauth(): GuardedHandler;
}

export function parseBearer(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer\s+([A-Za-z0-9_\-.]+)$/.exec(header.trim());
  return match?.[1];
}

/** Audit actor snapshot for the current request (anonymous when not authenticated). */
export function actorFromRequest(req: Request, fallback?: Partial<AuditActor>): AuditActor {
  const ctx = req.authz;
  const userAgent = req.get('user-agent');
  const base = {
    ip: req.ip,
    requestId: req.requestId,
    ...(userAgent === undefined ? {} : { userAgent }),
  };
  if (ctx === undefined) {
    return {
      type: fallback?.type ?? 'CUSTOMER',
      loginType: fallback?.loginType ?? 'CUSTOMER',
      ...base,
      ...fallback,
    };
  }
  const role = ctx.isSuperadmin ? 'SUPERADMIN' : ctx.roles[0];
  return {
    type: ctx.accountType === 'STAFF' ? 'STAFF' : 'CUSTOMER',
    userId: ctx.userId,
    ...(role === undefined ? {} : { role }),
    loginType: ctx.accountType,
    ...base,
  };
}

/** Returns the verified context or throws 401 (use in controllers behind `authenticate`). */
export function requireAuthz(req: Request): AuthContext {
  if (req.authz === undefined) throw new AppError('UNAUTHENTICATED', 'Please sign in to continue.');
  return req.authz;
}

export function createAuthMiddleware(deps: AuthMiddlewareDeps): AuthMiddleware {
  const audienceClaim = (audience: Audience): string =>
    audience === 'admin' ? deps.audiences.admin : deps.audiences.storefront;

  async function resolve(req: Request, audience: Audience, token: string): Promise<AuthContext> {
    let claims;
    try {
      claims = verifyAccessToken(deps.keySet, token, {
        audience: audienceClaim(audience),
        issuer: deps.issuer,
        now: deps.clock(),
      });
    } catch (error) {
      if (error instanceof JwtError && error.reason === 'EXPIRED') {
        throw new AppError('TOKEN_EXPIRED');
      }
      throw new AppError('UNAUTHENTICATED', 'Please sign in to continue.');
    }
    const ctx = await deps.permissions.loadContext(claims.sub, claims.sid, audience);
    if (ctx === null) throw new AppError('UNAUTHENTICATED', 'Please sign in to continue.');
    req.authz = ctx;
    return ctx;
  }

  function guard(keys: readonly string[], mode: 'all' | 'any'): GuardedHandler {
    const handler: GuardedHandler = (req, _res, next) => {
      const ctx = req.authz;
      if (ctx === undefined) {
        next(new AppError('UNAUTHENTICATED', 'Please sign in to continue.'));
        return;
      }
      const missing = keys.filter((k) => !hasPermission(ctx, k));
      const allowed = mode === 'all' ? missing.length === 0 : missing.length < keys.length;
      if (allowed) {
        next();
        return;
      }
      void deps.audit
        .recordSafe(deps.db, actorFromRequest(req), {
          action: 'PERMISSION_DENIED',
          module: keys[0]?.split('.')[0] ?? 'unknown',
          entityType: 'Route',
          outcome: 'FAILURE',
          eventKey: 'authz.denied',
          diff: false,
          metadata: {
            required: keys,
            missing,
            mode,
            method: req.method,
            path: req.baseUrl + req.path,
          },
        })
        .finally(() => {
          next(new AppError('PERMISSION_DENIED'));
        });
    };
    handler[PERMISSION_GUARD] = Object.freeze([...keys]);
    return handler;
  }

  return {
    authenticate(audience) {
      const handler: GuardedHandler = (req, _res, next) => {
        const token = parseBearer(req.get('authorization'));
        if (token === undefined) {
          next(new AppError('UNAUTHENTICATED', 'Please sign in to continue.'));
          return;
        }
        resolve(req, audience, token).then(() => {
          next();
        }, next);
      };
      handler[AUTH_GUARD] = { audience, optional: false };
      return handler;
    },

    optionalAuthenticate(audience) {
      const handler: GuardedHandler = (req, _res, next) => {
        const token = parseBearer(req.get('authorization'));
        if (token === undefined) {
          next();
          return;
        }
        // An invalid/expired token on a public route is reported so the client can refresh.
        resolve(req, audience, token).then(() => {
          next();
        }, next);
      };
      handler[AUTH_GUARD] = { audience, optional: true };
      return handler;
    },

    requirePermission(...keys) {
      if (keys.length === 0) throw new Error('requirePermission needs at least one key.');
      return guard(keys, 'all');
    },

    requireAnyPermission(...keys) {
      if (keys.length === 0) throw new Error('requireAnyPermission needs at least one key.');
      return guard(keys, 'any');
    },

    requireReauth() {
      const handler: GuardedHandler = (req, _res, next) => {
        const ctx = req.authz;
        if (ctx === undefined) {
          next(new AppError('UNAUTHENTICATED', 'Please sign in to continue.'));
          return;
        }
        const marker = deps.store.get(`reauth:${ctx.sid}`);
        if (marker === undefined) {
          next(new AppError('REAUTH_REQUIRED'));
          return;
        }
        next();
      };
      handler[REAUTH_GUARD] = true;
      return handler;
    },
  };
}
