/**
 * Sessions = refresh-token families — AUTHENTICATION_AUTHORIZATION.md §9–§10, PROJECT_CONTEXT §15
 * R-10, decisions OQ-76 (10 s grace, same UA) and OQ-92 (remember me).
 *
 * - Issue: new family (`familyId` = `sid`), opaque 256-bit token, only `hashToken(t, pepper)` stored.
 *   Customer: 30-day sliding (`expiresAt` = `absoluteExpiresAt` = now + 30 d on every rotation).
 *   Staff: 8 h idle (`expiresAt`), 12 h absolute (`absoluteExpiresAt` = login + 12 h, never extended).
 * - Rotate on every refresh. A rotated token presented again:
 *     ≤ 10 s after rotation from the same UA fingerprint → the SAME successor pair (grace);
 *     otherwise → whole family revoked (`REUSE_DETECTED`) + audit `TOKEN_REUSE_DETECTED` + email.
 *   The successor raw token is held transiently (≤ 10 s) in the memory store keyed by the rotated
 *   token's hash — never in the DB. LIMITATION (D-38): single instance only; after a restart a
 *   same-UA retry inside the window gets 401 (no family revocation).
 * - Remember-me flag (no column in the approved schema) is kept per family in the memory store;
 *   if it is lost (restart) the cookie degrades to a session cookie — fails towards shorter life.
 */
import { randomUUID } from 'node:crypto';

import type { AppContainer } from '../../container.js';
import { withTransaction, type Queryable } from '../../core/db/transaction.js';
import { AppError } from '../../core/errors/AppError.js';
import { signAccessToken } from '../../core/security/jwt.js';
import {
  generateOpaqueToken,
  hashToken,
  userAgentFingerprint,
} from '../../core/security/tokens.js';
import { addDays, addHours } from '../../lib/time.js';
import { toSessionDto, type SessionDto } from './auth.mapper.js';
import {
  ACCOUNT_TYPE,
  TOKEN_AUDIENCE,
  appBaseUrl,
  sendEmailSafe,
  truncate,
  userActor,
  type Audience,
  type RequestMeta,
} from './auth.context.js';
import {
  createRefreshRow,
  findRefreshByHash,
  findUserById,
  type LoginUserRow,
  type RefreshRow,
} from './auth.repository.js';
import { revokeFamily, revokeUserSessions } from './sessions.js';

export interface IssuedSession {
  readonly familyId: string;
  readonly refreshToken: string;
  readonly accessToken: string;
  readonly expiresIn: number;
  /** `undefined` → session cookie (customer "remember me" unticked). */
  readonly cookieMaxAgeSeconds: number | undefined;
}

export interface RefreshResult {
  readonly session: IssuedSession;
  readonly user: LoginUserRow;
  readonly graceReplay: boolean;
}

interface GraceEntry {
  readonly successor: string;
  readonly accessToken: string;
  readonly uaFingerprint: string;
  readonly familyId: string;
  readonly userId: string;
  readonly cookieMaxAgeSeconds: number | undefined;
}

export interface SessionService {
  hash(rawToken: string): string;
  accessToken(userId: string, familyId: string, audience: Audience): string;
  /** Creates a new family inside the caller's transaction. */
  issue(
    db: Queryable,
    userId: string,
    audience: Audience,
    meta: RequestMeta,
    options?: { readonly rememberMe?: boolean },
  ): Promise<IssuedSession>;
  refresh(rawToken: string, audience: Audience, meta: RequestMeta): Promise<RefreshResult>;
  /** Idempotent logout by refresh cookie and/or (possibly expired) access-token identity. */
  logout(
    audience: Audience,
    identity: { readonly rawToken?: string; readonly userId?: string; readonly sid?: string },
    allDevices: boolean,
    meta: RequestMeta,
  ): Promise<void>;
  list(userId: string, audience: Audience, currentSid: string): Promise<SessionDto[]>;
  /** Revokes one own family; 404 when it is not the caller's (no ownership oracle). */
  revokeOwn(
    userId: string,
    audience: Audience,
    sessionId: string,
    meta: RequestMeta,
  ): Promise<void>;
  /** Clears per-session in-memory state (re-auth marker, remember flag). */
  forgetSession(familyId: string): void;
  /**
   * New-device sign-in alert (R-12 `SECURITY_ALERT`): emails the user when no earlier session of
   * theirs used the same user agent. Skipped on the very first login. Evaluated BEFORE the new
   * session is written; returns the sender to run in `afterCommit` (or undefined).
   */
  newDeviceAlert(
    user: Pick<LoginUserRow, 'id' | 'email' | 'firstName' | 'lastLoginAt'>,
    audience: Audience,
    meta: RequestMeta,
  ): Promise<(() => Promise<void>) | undefined>;
}

const GRACE_PREFIX = 'rtgrace:';
const REMEMBER_PREFIX = 'sfremember:';

export function isLoginAllowedStatus(user: LoginUserRow, audience: Audience): boolean {
  if (user.deletedAt !== null) return false;
  if (user.accountType !== ACCOUNT_TYPE[audience]) return false;
  if (audience === 'admin') return user.status === 'ACTIVE';
  return user.status === 'ACTIVE' || user.status === 'PENDING_VERIFICATION';
}

export function createSessionService(container: AppContainer): SessionService {
  const { config, store, clock, db } = container;
  const refreshCfg = config.auth.refresh;
  const customerTtlSeconds = refreshCfg.storefrontTtlDays * 24 * 3600;

  const hash = (raw: string): string => hashToken(raw, refreshCfg.pepper);

  const accessToken = (userId: string, familyId: string, audience: Audience): string =>
    signAccessToken(container.keySet, {
      sub: userId,
      sid: familyId,
      aud:
        audience === 'admin' ? config.auth.jwt.audienceAdmin : config.auth.jwt.audienceStorefront,
      iss: config.auth.jwt.issuer,
      ttlSeconds: config.auth.jwt.accessTtlSeconds,
      now: clock(),
    });

  const secondsUntil = (date: Date, now: Date): number =>
    Math.max(1, Math.floor((date.getTime() - now.getTime()) / 1000));

  const cookieMaxAge = (audience: Audience, familyId: string, absolute: Date, now: Date) => {
    if (audience === 'admin') return secondsUntil(absolute, now);
    return store.get(`${REMEMBER_PREFIX}${familyId}`) === true ? customerTtlSeconds : undefined;
  };

  const forgetSession = (familyId: string): void => {
    store.delete(`reauth:${familyId}`);
    store.delete(`${REMEMBER_PREFIX}${familyId}`);
  };

  const unauthenticated = (): AppError =>
    new AppError('UNAUTHENTICATED', 'Please sign in to continue.');

  async function handleReuse(row: RefreshRow, meta: RequestMeta, audience: Audience) {
    const now = clock();
    const user = await findUserById(db, row.userId);
    await withTransaction(db, async (ctx) => {
      const { tx } = ctx;
      await revokeFamily(tx, row.userId, row.familyId, 'REUSE_DETECTED', now);
      await container.audit.record(tx, userActor(meta, row.userId, audience), {
        action: 'TOKEN_REUSE_DETECTED',
        module: 'auth',
        entityType: 'RefreshTokenFamily',
        entityId: row.familyId,
        outcome: 'FAILURE',
        eventKey: 'auth.token_reuse',
        diff: false,
        metadata: { familyId: row.familyId, audience: row.audience },
      });
      ctx.afterCommit(() => {
        container.permissions.invalidateUser(row.userId);
        forgetSession(row.familyId);
      });
      if (user !== null) {
        ctx.afterCommit(() =>
          sendEmailSafe(container, {
            to: user.email,
            subject: 'Security alert: your session was signed out',
            templateKey: 'SECURITY_ALERT',
            variables: {
              firstName: user.firstName,
              reason: 'TOKEN_REUSE',
              signInUrl: `${appBaseUrl(container, audience)}/login`,
            },
          }),
        );
      }
    });
    if (audience === 'admin') {
      container.logger.warn(
        { alert: 'staff_token_reuse', userId: row.userId, familyId: row.familyId },
        'refresh-token reuse detected on a staff account',
      );
    }
  }

  return {
    hash,
    accessToken,
    forgetSession,

    async newDeviceAlert(user, audience, meta) {
      if (user.lastLoginAt === null) return undefined;
      const userAgent = truncate(meta.userAgent, 255);
      const known =
        userAgent !== null &&
        (await db.refreshToken.findFirst({
          where: { userId: user.id, audience: TOKEN_AUDIENCE[audience], userAgent },
          select: { id: true },
        })) !== null;
      if (known) return undefined;
      return () =>
        sendEmailSafe(container, {
          to: user.email,
          subject: 'New sign-in to your account',
          templateKey: 'SECURITY_ALERT',
          variables: {
            firstName: user.firstName,
            reason: 'NEW_DEVICE_LOGIN',
            device: userAgent ?? 'Unknown device',
            resetUrl: `${appBaseUrl(container, audience)}/forgot-password`,
          },
        });
    },

    async issue(q, userId, audience, meta, options = {}) {
      const now = clock();
      const familyId = randomUUID();
      const refreshToken = generateOpaqueToken();
      let expiresAt: Date;
      let absoluteExpiresAt: Date;
      if (audience === 'admin') {
        absoluteExpiresAt = addHours(now, refreshCfg.adminAbsoluteHours);
        const idle = addHours(now, refreshCfg.adminIdleHours);
        expiresAt = idle < absoluteExpiresAt ? idle : absoluteExpiresAt;
      } else {
        expiresAt = addDays(now, refreshCfg.storefrontTtlDays);
        absoluteExpiresAt = expiresAt;
      }
      await createRefreshRow(q, {
        userId,
        familyId,
        tokenHash: hash(refreshToken),
        audience: TOKEN_AUDIENCE[audience],
        now,
        expiresAt,
        absoluteExpiresAt,
        ipAddress: truncate(meta.ip, 45),
        userAgent: truncate(meta.userAgent, 255),
      });
      if (audience === 'storefront' && options.rememberMe === true) {
        store.set(`${REMEMBER_PREFIX}${familyId}`, true, customerTtlSeconds);
      }
      return {
        familyId,
        refreshToken,
        accessToken: accessToken(userId, familyId, audience),
        expiresIn: config.auth.jwt.accessTtlSeconds,
        cookieMaxAgeSeconds: cookieMaxAge(audience, familyId, absoluteExpiresAt, now),
      };
    },

    async refresh(rawToken, audience, meta) {
      const now = clock();
      const tokenHash = hash(rawToken);
      const row = await findRefreshByHash(db, tokenHash);
      if (row?.audience !== TOKEN_AUDIENCE[audience]) throw unauthenticated();

      if (row.revokedAt !== null) {
        if (row.revokedReason !== 'ROTATED') throw unauthenticated();
        const grace = store.get(`${GRACE_PREFIX}${tokenHash}`) as GraceEntry | undefined;
        const fingerprint = userAgentFingerprint(meta.userAgent);
        const storedFingerprint =
          grace?.uaFingerprint ?? userAgentFingerprint(row.userAgent ?? undefined);
        const withinWindow =
          now.getTime() - row.revokedAt.getTime() <= refreshCfg.graceSeconds * 1000;
        if (withinWindow && fingerprint === storedFingerprint) {
          const user = await findUserById(db, row.userId);
          if (grace === undefined || user === null || !isLoginAllowedStatus(user, audience)) {
            throw unauthenticated();
          }
          return {
            user,
            graceReplay: true,
            session: {
              familyId: grace.familyId,
              refreshToken: grace.successor,
              accessToken: grace.accessToken,
              expiresIn: config.auth.jwt.accessTtlSeconds,
              cookieMaxAgeSeconds: grace.cookieMaxAgeSeconds,
            },
          };
        }
        await handleReuse(row, meta, audience);
        throw unauthenticated();
      }

      if (row.expiresAt <= now || row.absoluteExpiresAt <= now) {
        throw new AppError('TOKEN_EXPIRED');
      }
      const user = await findUserById(db, row.userId);
      if (user === null || !isLoginAllowedStatus(user, audience)) throw unauthenticated();

      const successor = generateOpaqueToken();
      const successorId = randomUUID();
      let expiresAt: Date;
      let absoluteExpiresAt: Date;
      if (audience === 'admin') {
        absoluteExpiresAt = row.absoluteExpiresAt;
        const idle = addHours(now, refreshCfg.adminIdleHours);
        expiresAt = idle < absoluteExpiresAt ? idle : absoluteExpiresAt;
      } else {
        expiresAt = addDays(now, refreshCfg.storefrontTtlDays);
        absoluteExpiresAt = expiresAt;
      }
      const session = await withTransaction(db, async (ctx) => {
        const { tx } = ctx;
        await createRefreshRow(tx, {
          id: successorId,
          userId: row.userId,
          familyId: row.familyId,
          tokenHash: hash(successor),
          audience: row.audience,
          now,
          expiresAt,
          absoluteExpiresAt,
          ipAddress: truncate(meta.ip, 45),
          userAgent: truncate(meta.userAgent, 255),
        });
        const rotated = await tx.refreshToken.updateMany({
          where: { id: row.id, revokedAt: null },
          data: {
            revokedAt: now,
            revokedReason: 'ROTATED',
            replacedById: successorId,
            lastUsedAt: now,
          },
        });
        // Lost a concurrent rotation race: roll back our successor; the client retries (grace).
        if (rotated.count !== 1) throw unauthenticated();

        if (audience === 'storefront' && store.get(`${REMEMBER_PREFIX}${row.familyId}`) === true) {
          store.set(`${REMEMBER_PREFIX}${row.familyId}`, true, customerTtlSeconds);
        }
        const issued: IssuedSession = {
          familyId: row.familyId,
          refreshToken: successor,
          accessToken: accessToken(row.userId, row.familyId, audience),
          expiresIn: config.auth.jwt.accessTtlSeconds,
          cookieMaxAgeSeconds: cookieMaxAge(audience, row.familyId, absoluteExpiresAt, now),
        };
        ctx.afterCommit(() => {
          const entry: GraceEntry = {
            successor,
            accessToken: issued.accessToken,
            uaFingerprint: userAgentFingerprint(meta.userAgent),
            familyId: row.familyId,
            userId: row.userId,
            cookieMaxAgeSeconds: issued.cookieMaxAgeSeconds,
          };
          store.set(`${GRACE_PREFIX}${tokenHash}`, entry, refreshCfg.graceSeconds);
        });
        return issued;
      });
      return { session, user, graceReplay: false };
    },

    async logout(audience, identity, allDevices, meta) {
      const now = clock();
      let userId = identity.userId;
      let familyId = identity.sid;
      if (identity.rawToken !== undefined) {
        const row = await findRefreshByHash(db, hash(identity.rawToken));
        if (row !== null && row.audience === TOKEN_AUDIENCE[audience]) {
          userId = row.userId;
          familyId = row.familyId;
        }
      }
      if (userId === undefined) return; // nothing identifiable: idempotent success
      const subject = userId;
      await withTransaction(db, async (ctx) => {
        const { tx } = ctx;
        const count = allDevices
          ? await revokeUserSessions(tx, subject, 'LOGOUT_ALL', now)
          : familyId === undefined
            ? 0
            : await revokeFamily(tx, subject, familyId, 'LOGOUT', now);
        await container.audit.record(tx, userActor(meta, subject, audience), {
          action: 'LOGOUT',
          module: 'auth',
          entityType: 'RefreshTokenFamily',
          entityId: allDevices ? null : (familyId ?? null),
          eventKey: allDevices ? 'auth.logout_all' : 'auth.logout',
          diff: false,
          metadata: { revokedTokens: count },
        });
        ctx.afterCommit(() => {
          container.permissions.invalidateUser(subject);
          if (familyId !== undefined) forgetSession(familyId);
        });
      });
    },

    async list(userId, audience, currentSid) {
      const now = clock();
      const rows = await db.refreshToken.findMany({
        where: {
          userId,
          audience: TOKEN_AUDIENCE[audience],
          revokedAt: null,
          expiresAt: { gt: now },
          absoluteExpiresAt: { gt: now },
        },
        orderBy: { issuedAt: 'desc' },
        select: {
          familyId: true,
          issuedAt: true,
          lastUsedAt: true,
          expiresAt: true,
          ipAddress: true,
          userAgent: true,
        },
      });
      if (rows.length === 0) return [];
      const familyIds = [...new Set(rows.map((r) => r.familyId))];
      const firsts = await db.refreshToken.groupBy({
        by: ['familyId'],
        where: { userId, familyId: { in: familyIds } },
        _min: { issuedAt: true },
      });
      const createdByFamily = new Map<string, Date>();
      for (const group of firsts) {
        const first = group._min.issuedAt;
        if (first !== null) createdByFamily.set(group.familyId, first);
      }
      const seen = new Set<string>();
      const out: SessionDto[] = [];
      for (const row of rows) {
        if (seen.has(row.familyId)) continue;
        seen.add(row.familyId);
        out.push(
          toSessionDto(
            { ...row, createdAt: createdByFamily.get(row.familyId) ?? row.issuedAt },
            currentSid,
          ),
        );
      }
      return out;
    },

    async revokeOwn(userId, audience, sessionId, meta) {
      const now = clock();
      await withTransaction(db, async (ctx) => {
        const { tx } = ctx;
        const owned = await tx.refreshToken.findFirst({
          where: {
            userId,
            familyId: sessionId,
            audience: TOKEN_AUDIENCE[audience],
            revokedAt: null,
          },
          select: { id: true },
        });
        if (owned === null) throw new AppError('NOT_FOUND', 'Session not found.');
        await revokeFamily(tx, userId, sessionId, 'LOGOUT', now);
        await container.audit.record(tx, userActor(meta, userId, audience), {
          action: 'LOGOUT',
          module: 'auth',
          entityType: 'RefreshTokenFamily',
          entityId: sessionId,
          eventKey: 'auth.session_revoked',
          diff: false,
          metadata: { subtype: 'SESSION_REVOKE' },
        });
        ctx.afterCommit(() => {
          container.permissions.invalidateUser(userId);
          forgetSession(sessionId);
        });
      });
    },
  };
}
