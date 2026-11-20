/**
 * Shared types & helpers for the auth, admin-auth and me modules (no Express types here — the
 * controllers translate `req` into a `RequestMeta`).
 */
import type { AppContainer } from '../../container.js';
import type { AccountType, TokenAudience } from '../../generated/prisma/enums.js';
import type { SendEmailInput } from '../../integrations/email/emailProvider.js';
import type { AuditActor } from '../audit/audit.service.js';
import type { Audience } from '../rbac/permission.service.js';

export type { Audience };

/** What a service needs to know about the HTTP request (IP, UA, audit actor snapshot). */
export interface RequestMeta {
  readonly ip: string | undefined;
  readonly userAgent: string | undefined;
  readonly actor: AuditActor;
}

export const TOKEN_AUDIENCE: Readonly<Record<Audience, TokenAudience>> = {
  storefront: 'STOREFRONT',
  admin: 'ADMIN',
};

export const ACCOUNT_TYPE: Readonly<Record<Audience, AccountType>> = {
  storefront: 'CUSTOMER',
  admin: 'STAFF',
};

/** Actor snapshot for an identified user (login success, reset completion, …). */
export function userActor(
  meta: RequestMeta,
  userId: string,
  audience: Audience,
  role?: string,
): AuditActor {
  return {
    ...meta.actor,
    type: audience === 'admin' ? 'STAFF' : 'CUSTOMER',
    loginType: audience === 'admin' ? 'STAFF' : 'CUSTOMER',
    userId,
    ...(role === undefined ? {} : { role }),
  };
}

export function truncate(value: string | undefined, max: number): string | null {
  if (value === undefined) return null;
  return value.length > max ? value.slice(0, max) : value;
}

/** Frontend base URL of the audience (links in emails). */
export function appBaseUrl(container: AppContainer, audience: Audience): string {
  const base = audience === 'admin' ? container.config.adminUrl : container.config.storefrontUrl;
  return base.replace(/\/+$/, '');
}

/** The exact Origin a cookie endpoint accepts (CSRF guard, §16.2). */
export function appOrigin(container: AppContainer, audience: Audience): string {
  return new URL(appBaseUrl(container, audience)).origin;
}

/**
 * Sends an email through the provider adapter; failures are logged (without body or links) and
 * never fail the request. Call from `afterCommit` when tied to a DB change.
 */
export async function sendEmailSafe(container: AppContainer, input: SendEmailInput): Promise<void> {
  try {
    await container.providers.email.send(input);
  } catch (error) {
    container.logger.warn(
      { err: error, templateKey: input.templateKey },
      'email delivery failed (auth notification)',
    );
  }
}
