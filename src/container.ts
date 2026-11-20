/**
 * Composition root — builds every shared dependency once. Modules receive the container and
 * never construct infrastructure themselves (BACKEND_STRUCTURE.md §6 layering).
 *
 * Tests build a container with a mocked `db` (see tests/helpers/container.ts).
 */
import type { AppConfig } from './core/config/index.js';
import type { DbClient } from './core/db/transaction.js';
import type { Logger } from './core/logger/logger.js';
import { createAuthMiddleware, type AuthMiddleware } from './core/middleware/auth.js';
import { createIdempotency, type IdempotencyFactory } from './core/middleware/idempotency.js';
import { createRouteRateLimiter, type RateLimitFactory } from './core/middleware/routeRateLimit.js';
import { createFieldCipher, parseFieldKey, type FieldCipher } from './core/security/fieldCipher.js';
import { buildKeySet, type JwtKeySet } from './core/security/jwt.js';
import { createPasswordHasher, type PasswordHasher } from './core/security/password.js';
import { createMemoryStore, type KeyValueStore } from './core/store/memoryStore.js';
import {
  FakeEmailProviderAdapter,
  type EmailProviderAdapter,
} from './integrations/email/emailProvider.js';
import {
  MockPaymentProviderAdapter,
  type PaymentProviderAdapter,
} from './integrations/payments/paymentProvider.js';
import {
  MockShippingProviderAdapter,
  createShippingProviderRegistry,
  type ShippingProviderRegistry,
} from './integrations/shipping/shippingProvider.js';
import {
  MockMediaProviderAdapter,
  type MediaProviderAdapter,
} from './integrations/storage/mediaProvider.js';
import {
  MockWhatsAppProviderAdapter,
  type WhatsAppProviderAdapter,
} from './integrations/whatsapp/whatsappProvider.js';
import { createAuditService, type AuditService } from './modules/audit/audit.service.js';
import {
  createPermissionService,
  type PermissionService,
} from './modules/rbac/permission.service.js';

export interface Providers {
  readonly email: EmailProviderAdapter;
  readonly whatsapp: WhatsAppProviderAdapter;
  readonly payment: PaymentProviderAdapter;
  readonly media: MediaProviderAdapter;
  /** Courier adapters by key (OQ-07: mock only). One shared registry for shipping, orders and jobs. */
  readonly shipping: ShippingProviderRegistry;
}

export interface AppContainer {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly db: DbClient;
  readonly clock: () => Date;
  readonly store: KeyValueStore;
  readonly keySet: JwtKeySet;
  readonly passwords: PasswordHasher;
  readonly cipher: FieldCipher;
  readonly audit: AuditService;
  readonly permissions: PermissionService;
  readonly auth: AuthMiddleware;
  readonly rateLimit: RateLimitFactory;
  readonly idempotency: IdempotencyFactory;
  readonly providers: Providers;
}

export interface ContainerOverrides {
  readonly clock?: () => Date;
  readonly store?: KeyValueStore;
  readonly passwords?: PasswordHasher;
  readonly permissions?: PermissionService;
  readonly providers?: Partial<Providers>;
}

export function createContainer(
  config: AppConfig,
  logger: Logger,
  db: DbClient,
  overrides: ContainerOverrides = {},
): AppContainer {
  const clock = overrides.clock ?? (() => new Date());
  const store = overrides.store ?? createMemoryStore(() => clock().getTime());

  const { keySet, ephemeral } = buildKeySet(config.auth.jwt);
  const field = parseFieldKey(config.auth.fieldEncryptionKey);
  if (ephemeral || field.ephemeral) {
    // loadConfig() already refuses missing keys in staging/production.
    logger.warn(
      { jwtEphemeral: ephemeral, fieldKeyEphemeral: field.ephemeral },
      'using ephemeral development keys: tokens and encrypted MFA secrets do not survive a restart',
    );
  }

  const passwords = overrides.passwords ?? createPasswordHasher(config.auth.password);
  const audit = createAuditService(logger, clock);
  const permissions =
    overrides.permissions ??
    createPermissionService({
      db,
      store,
      ttlSeconds: config.auth.permissionCacheTtlSeconds,
      clock,
    });
  const auth = createAuthMiddleware({
    db,
    keySet,
    issuer: config.auth.jwt.issuer,
    audiences: {
      storefront: config.auth.jwt.audienceStorefront,
      admin: config.auth.jwt.audienceAdmin,
    },
    permissions,
    audit,
    store,
    clock,
  });

  return {
    config,
    logger,
    db,
    clock,
    store,
    keySet,
    passwords,
    cipher: createFieldCipher(field.key),
    audit,
    permissions,
    auth,
    rateLimit: createRouteRateLimiter(config.rateLimit.enabled),
    idempotency: createIdempotency({ db, logger, clock }),
    providers: {
      email: overrides.providers?.email ?? new FakeEmailProviderAdapter(),
      whatsapp: overrides.providers?.whatsapp ?? new MockWhatsAppProviderAdapter(),
      payment:
        overrides.providers?.payment ??
        new MockPaymentProviderAdapter(
          config.integrations.paymentWebhookSecret === undefined
            ? {}
            : { webhookSecret: config.integrations.paymentWebhookSecret },
        ),
      media: overrides.providers?.media ?? new MockMediaProviderAdapter(),
      shipping:
        overrides.providers?.shipping ??
        createShippingProviderRegistry([
          new MockShippingProviderAdapter(
            config.integrations.shippingWebhookSecret === undefined
              ? {}
              : { secret: config.integrations.shippingWebhookSecret },
          ),
        ]),
    },
  };
}
