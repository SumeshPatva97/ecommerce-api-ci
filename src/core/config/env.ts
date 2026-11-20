/**
 * Environment validation — BACKEND_STRUCTURE.md §19, REPOSITORY_SETUP_GUIDE.md §9.1 / §9.4.
 *
 * Only variables used by the code that exists today are declared here. Each later increment
 * that needs a new variable (DATABASE_URL, REDIS_URL, JWT_*, …) adds it to this schema,
 * `.env.example` and the docs in the same change (REPOSITORY_SETUP_GUIDE.md §9.4 rule 1).
 *
 * `loadConfig` is pure (takes an env record) so it can be unit-tested without touching
 * `process.env`. It never echoes variable values in error messages.
 */
import { z } from 'zod';

const NODE_ENVS = ['development', 'test', 'staging', 'production'] as const;
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** Absolute http(s) URL; returned without a trailing slash. */
const httpUrl = z
  .string()
  .trim()
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Must be an absolute http(s) URL.')
  .transform((value) => value.replace(/\/+$/, ''));

/** Comma-separated list of exact origins (scheme://host[:port]); no wildcards, no paths. */
const originList = z
  .string()
  .trim()
  .min(1, 'At least one origin is required.')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  )
  .refine(
    (origins) =>
      origins.every((origin) => {
        try {
          const url = new URL(origin);
          return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === origin;
        } catch {
          return false;
        }
      }),
    'Each entry must be an exact origin such as https://www.example.com (no path, no wildcard).',
  );

/** Optional string; empty values count as absent (so `KEY=` in `.env` means "not set"). */
const optionalSecret = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed === '' ? undefined : trimmed;
  });

/** `900`, `900s`, `15m`, `1h` → seconds. */
const duration = z
  .string()
  .trim()
  .regex(/^\d+(s|m|h)?$/, 'Use a duration such as 900, 15m or 1h.')
  .transform((value) => {
    const amount = Number.parseInt(value, 10);
    if (value.endsWith('h')) return amount * 3600;
    if (value.endsWith('m')) return amount * 60;
    return amount;
  })
  .pipe(z.number().int().min(60).max(3600));

const envSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS),
  APP_NAME: z.string().trim().min(1).default('[BRAND_NAME] API'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  APP_TIMEZONE: z.literal('Asia/Kolkata', {
    error: 'APP_TIMEZONE must be Asia/Kolkata (PROJECT_CONTEXT §1).',
  }),
  TZ: z.literal('UTC', { error: 'TZ must be UTC; all timestamps are stored in UTC.' }),
  API_BASE_URL: httpUrl,
  STOREFRONT_URL: httpUrl,
  ADMIN_URL: httpUrl,
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  LOG_PRETTY: z.stringbool().default(false),
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
  REQUEST_BODY_LIMIT: z
    .string()
    .trim()
    .regex(/^\d+(b|kb|mb)$/i, 'Use a size such as 100kb or 1mb.')
    .default('100kb'),
  CORS_ORIGINS: originList,
  RATE_LIMIT_ENABLED: z.stringbool().default(true),
  RATE_LIMIT_DEFAULT_PER_MIN: z.coerce.number().int().min(1).default(300),
  // Placeholder in local/dev docs; never a real credential. Validated as present (no DB connection in B0-b Part 1).
  DATABASE_URL: z.string().trim().min(1, 'DATABASE_URL is required.'),

  // ── Auth & tokens (B1; canonical names REPOSITORY_SETUP_GUIDE §9.1, decisions D-41…D-56) ──
  // Required in staging/production; development/test fall back to an ephemeral in-process key
  // (logged as a warning) so a local `.env` without keys still boots.
  JWT_ACCESS_PRIVATE_KEY: optionalSecret,
  JWT_ACCESS_PUBLIC_KEY: optionalSecret,
  JWT_KEY_ID: z.string().trim().min(1).max(64).default('dev-ephemeral'),
  JWT_PREVIOUS_PUBLIC_KEY: optionalSecret,
  JWT_PREVIOUS_KEY_ID: z.string().trim().min(1).max(64).optional(),
  JWT_ISSUER: z.string().trim().min(1).optional(),
  JWT_ACCESS_TTL: duration.default(900),
  JWT_AUDIENCE_STOREFRONT: z.string().trim().min(1).default('storefront'),
  JWT_AUDIENCE_ADMIN: z.string().trim().min(1).default('admin'),
  REFRESH_TTL_STOREFRONT_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  REFRESH_ADMIN_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(72).default(12),
  REFRESH_ADMIN_IDLE_HOURS: z.coerce.number().int().min(1).max(72).default(8),
  REFRESH_TOKEN_PEPPER: optionalSecret,
  COOKIE_DOMAIN_STOREFRONT: optionalSecret,
  COOKIE_DOMAIN_ADMIN: optionalSecret,
  COOKIE_SECURE: z.stringbool().optional(),
  PASSWORD_HASH_MEMORY_KIB: z.coerce.number().int().min(8192).max(1048576).default(19456),
  PASSWORD_HASH_ITERATIONS: z.coerce.number().int().min(1).max(10).default(2),
  PASSWORD_PEPPER: optionalSecret,
  REAUTH_WINDOW_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
  LOGIN_MAX_ATTEMPTS_CUSTOMER: z.coerce.number().int().min(1).max(50).default(5),
  LOGIN_MAX_ATTEMPTS_STAFF: z.coerce.number().int().min(1).max(50).default(5),
  LOGIN_LOCK_MINUTES_CUSTOMER: z.coerce.number().int().min(1).max(1440).default(15),
  LOGIN_LOCK_MINUTES_STAFF: z.coerce.number().int().min(1).max(1440).default(30),
  PERMISSION_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(60).default(60),
  VERIFICATION_TOKEN_TTL_MINUTES: z.coerce.number().int().min(5).max(10080).default(1440),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
  CAPTCHA_PROVIDER: z.enum(['none']).default('none'),
  MFA_ISSUER: z.string().trim().min(1).max(64).default('[BRAND_NAME] Admin'),
  FIELD_ENCRYPTION_KEY: optionalSecret,
  SUPERADMIN_MAX: z.coerce.number().int().min(1).max(5).default(2),

  // ── Integrations (adapters; only `mock` is implemented until OQ-06/07/08 pick vendors) ──
  EMAIL_PROVIDER: z.enum(['fake']).default('fake'),
  WHATSAPP_PROVIDER: z.enum(['fake']).default('fake'),
  PAYMENT_PROVIDER: z.enum(['mock']).default('mock'),
  PAYMENT_WEBHOOK_SECRET: optionalSecret,
  SHIPPING_PROVIDER: z.enum(['mock']).default('mock'),
  /** Courier webhook signing secret (BACKEND_STRUCTURE §16). The mock uses a public test value when unset. */
  SHIPPING_WEBHOOK_SECRET: optionalSecret,
  MEDIA_PROVIDER: z.enum(['mock', 'cloudinary']).default('mock'),
  CLOUDINARY_CLOUD_NAME: optionalSecret,
  CLOUDINARY_API_KEY: optionalSecret,
  CLOUDINARY_API_SECRET: optionalSecret,
  CLOUDINARY_UPLOAD_FOLDER: z.string().trim().min(1).default('ecom/dev'),
  MEDIA_MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(50).default(10),
  MEDIA_ALLOWED_FORMATS: z
    .string()
    .trim()
    .default('jpg,jpeg,png,webp,avif')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0),
    ),
  RESERVATION_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),

  // ── Background jobs (in-process scheduler; single instance only until Redis/BullMQ, D-38) ──
  JOBS_ENABLED: z.stringbool().default(false),
});

type ParsedEnv = z.output<typeof envSchema>;

/** Origin of an absolute URL, or `undefined` if it cannot be parsed (never throws). */
function safeOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/**
 * Cross-field rules, evaluated only after every field passed its own validation (review D2:
 * running them inside the Zod schema let `new URL()` see an already-invalid URL and throw a
 * TypeError instead of producing a ConfigError). Messages name variables, never values.
 */
function crossFieldProblems(env: ParsedEnv): string[] {
  const problems: string[] = [];

  // CORS route families (R-46): the admin origin is ADMIN_URL's origin; both frontend origins
  // must be allow-listed and distinct, otherwise one of the two apps could never call the API.
  const storefrontOrigin = safeOrigin(env.STOREFRONT_URL);
  const adminOrigin = safeOrigin(env.ADMIN_URL);
  if (storefrontOrigin === undefined)
    problems.push('STOREFRONT_URL: Must be an absolute http(s) URL.');
  if (adminOrigin === undefined) problems.push('ADMIN_URL: Must be an absolute http(s) URL.');
  if (storefrontOrigin !== undefined && adminOrigin !== undefined) {
    if (storefrontOrigin === adminOrigin) {
      problems.push('ADMIN_URL: ADMIN_URL and STOREFRONT_URL must have different origins.');
    }
    for (const [key, origin] of [
      ['STOREFRONT_URL', storefrontOrigin],
      ['ADMIN_URL', adminOrigin],
    ] as const) {
      if (!env.CORS_ORIGINS.includes(origin)) {
        problems.push(`CORS_ORIGINS: Must include the origin of ${key}.`);
      }
    }
  }

  if ((env.JWT_ACCESS_PRIVATE_KEY === undefined) !== (env.JWT_ACCESS_PUBLIC_KEY === undefined)) {
    problems.push(
      'JWT_ACCESS_PUBLIC_KEY: JWT_ACCESS_PRIVATE_KEY and JWT_ACCESS_PUBLIC_KEY must be set together.',
    );
  }
  if (env.JWT_PREVIOUS_PUBLIC_KEY !== undefined && env.JWT_PREVIOUS_KEY_ID === undefined) {
    problems.push('JWT_PREVIOUS_KEY_ID: Required when JWT_PREVIOUS_PUBLIC_KEY is set.');
  }
  if (env.JWT_AUDIENCE_ADMIN === env.JWT_AUDIENCE_STOREFRONT) {
    problems.push('JWT_AUDIENCE_ADMIN: Must differ from JWT_AUDIENCE_STOREFRONT.');
  }
  if (env.MEDIA_PROVIDER === 'cloudinary') {
    for (const key of [
      'CLOUDINARY_CLOUD_NAME',
      'CLOUDINARY_API_KEY',
      'CLOUDINARY_API_SECRET',
    ] as const) {
      if (env[key] === undefined) problems.push(`${key}: Required when MEDIA_PROVIDER=cloudinary.`);
    }
  }

  const strictEnv = env.NODE_ENV === 'production' || env.NODE_ENV === 'staging';
  if (!strictEnv) return problems;

  for (const key of [
    'JWT_ACCESS_PRIVATE_KEY',
    'JWT_ACCESS_PUBLIC_KEY',
    'REFRESH_TOKEN_PEPPER',
    'FIELD_ENCRYPTION_KEY',
  ] as const) {
    if (env[key] === undefined) problems.push(`${key}: Required outside development/test.`);
  }
  if (env.COOKIE_SECURE === false) {
    problems.push('COOKIE_SECURE: Cookies must be Secure outside development.');
  }

  for (const key of ['API_BASE_URL', 'STOREFRONT_URL', 'ADMIN_URL'] as const) {
    if (!env[key].startsWith('https://')) {
      problems.push(`${key}: Must use https outside development.`);
    }
  }
  if (env.CORS_ORIGINS.some((origin) => !origin.startsWith('https://'))) {
    problems.push('CORS_ORIGINS: All origins must use https outside development.');
  }
  if (!env.RATE_LIMIT_ENABLED) {
    problems.push('RATE_LIMIT_ENABLED: Rate limiting cannot be disabled outside development.');
  }
  if (env.LOG_PRETTY) {
    problems.push('LOG_PRETTY: Pretty logs are for local development only.');
  }
  return problems;
}

export type NodeEnv = (typeof NODE_ENVS)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface AppConfig {
  readonly nodeEnv: NodeEnv;
  readonly appName: string;
  readonly port: number;
  readonly appTimezone: 'Asia/Kolkata';
  readonly apiBaseUrl: string;
  readonly storefrontUrl: string;
  readonly adminUrl: string;
  readonly log: { readonly level: LogLevel; readonly pretty: boolean };
  readonly trustProxy: number;
  readonly requestBodyLimit: string;
  readonly cors: { readonly origins: readonly string[]; readonly adminOrigin: string };
  readonly rateLimit: { readonly enabled: boolean; readonly defaultPerMinute: number };
  readonly databaseUrl: string;
  readonly auth: AuthConfig;
  readonly integrations: IntegrationsConfig;
  /** In-process scheduler (src/jobs/scheduler.ts); single instance only (D-38). */
  readonly jobs: { readonly enabled: boolean };
}

export interface AuthConfig {
  readonly jwt: {
    /** PEM strings; undefined in development/test means "generate an ephemeral key at boot". */
    readonly privateKeyPem: string | undefined;
    readonly publicKeyPem: string | undefined;
    readonly keyId: string;
    readonly previous: { readonly keyId: string; readonly publicKeyPem: string } | undefined;
    readonly issuer: string;
    readonly accessTtlSeconds: number;
    readonly audienceStorefront: string;
    readonly audienceAdmin: string;
  };
  readonly refresh: {
    readonly storefrontTtlDays: number;
    readonly adminAbsoluteHours: number;
    readonly adminIdleHours: number;
    readonly pepper: string | undefined;
    /** Grace window for multi-tab refresh races (OQ-76 decided: 10 s). */
    readonly graceSeconds: number;
  };
  readonly cookies: {
    readonly secure: boolean;
    readonly domainStorefront: string | undefined;
    readonly domainAdmin: string | undefined;
  };
  readonly password: {
    readonly memoryKib: number;
    readonly iterations: number;
    readonly pepper: string | undefined;
  };
  readonly reauthWindowMinutes: number;
  readonly lockout: {
    readonly customer: { readonly maxAttempts: number; readonly lockMinutes: number };
    readonly staff: { readonly maxAttempts: number; readonly lockMinutes: number };
  };
  readonly permissionCacheTtlSeconds: number;
  readonly verificationTtlMinutes: number;
  readonly passwordResetTtlMinutes: number;
  readonly staffResetTtlMinutes: number;
  readonly staffInviteTtlHours: number;
  readonly captchaProvider: 'none';
  readonly mfaIssuer: string;
  readonly fieldEncryptionKey: string | undefined;
  readonly superadminMax: number;
}

export interface IntegrationsConfig {
  readonly email: 'fake';
  readonly whatsapp: 'fake';
  readonly payment: 'mock';
  readonly paymentWebhookSecret: string | undefined;
  readonly shipping: 'mock';
  readonly shippingWebhookSecret: string | undefined;
  readonly media: {
    readonly provider: 'mock' | 'cloudinary';
    readonly cloudName: string | undefined;
    readonly apiKey: string | undefined;
    readonly apiSecret: string | undefined;
    readonly uploadFolder: string;
    readonly maxUploadMb: number;
    readonly allowedFormats: readonly string[];
  };
  readonly reservationTtlMinutes: number;
}

export class ConfigError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(`Invalid environment configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(source: Readonly<Record<string, string | undefined>>): AppConfig {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const name = issue.path.map(String).join('.') || '(root)';
      return `${name}: ${issue.message}`;
    });
    throw new ConfigError(problems);
  }

  const env = result.data;
  const crossProblems = crossFieldProblems(env);
  if (crossProblems.length > 0) throw new ConfigError(crossProblems);

  return Object.freeze({
    nodeEnv: env.NODE_ENV,
    appName: env.APP_NAME,
    port: env.PORT,
    appTimezone: env.APP_TIMEZONE,
    apiBaseUrl: env.API_BASE_URL,
    storefrontUrl: env.STOREFRONT_URL,
    adminUrl: env.ADMIN_URL,
    log: Object.freeze({ level: env.LOG_LEVEL, pretty: env.LOG_PRETTY }),
    trustProxy: env.TRUST_PROXY,
    requestBodyLimit: env.REQUEST_BODY_LIMIT.toLowerCase(),
    cors: Object.freeze({
      origins: Object.freeze([...env.CORS_ORIGINS]),
      // Safe: crossFieldProblems() has already confirmed ADMIN_URL parses.
      adminOrigin: safeOrigin(env.ADMIN_URL) ?? '',
    }),
    rateLimit: Object.freeze({
      enabled: env.RATE_LIMIT_ENABLED,
      defaultPerMinute: env.RATE_LIMIT_DEFAULT_PER_MIN,
    }),
    databaseUrl: env.DATABASE_URL,
    auth: Object.freeze({
      jwt: Object.freeze({
        privateKeyPem: decodePem(env.JWT_ACCESS_PRIVATE_KEY),
        publicKeyPem: decodePem(env.JWT_ACCESS_PUBLIC_KEY),
        keyId: env.JWT_KEY_ID,
        previous:
          env.JWT_PREVIOUS_PUBLIC_KEY !== undefined && env.JWT_PREVIOUS_KEY_ID !== undefined
            ? Object.freeze({
                keyId: env.JWT_PREVIOUS_KEY_ID,
                publicKeyPem: decodePem(env.JWT_PREVIOUS_PUBLIC_KEY) ?? '',
              })
            : undefined,
        issuer: env.JWT_ISSUER ?? env.API_BASE_URL,
        accessTtlSeconds: env.JWT_ACCESS_TTL,
        audienceStorefront: env.JWT_AUDIENCE_STOREFRONT,
        audienceAdmin: env.JWT_AUDIENCE_ADMIN,
      }),
      refresh: Object.freeze({
        storefrontTtlDays: env.REFRESH_TTL_STOREFRONT_DAYS,
        adminAbsoluteHours: env.REFRESH_ADMIN_ABSOLUTE_HOURS,
        adminIdleHours: env.REFRESH_ADMIN_IDLE_HOURS,
        pepper: env.REFRESH_TOKEN_PEPPER,
        graceSeconds: 10,
      }),
      cookies: Object.freeze({
        secure: env.COOKIE_SECURE ?? !(env.NODE_ENV === 'development' || env.NODE_ENV === 'test'),
        domainStorefront: env.COOKIE_DOMAIN_STOREFRONT,
        domainAdmin: env.COOKIE_DOMAIN_ADMIN,
      }),
      password: Object.freeze({
        memoryKib: env.PASSWORD_HASH_MEMORY_KIB,
        iterations: env.PASSWORD_HASH_ITERATIONS,
        pepper: env.PASSWORD_PEPPER,
      }),
      reauthWindowMinutes: env.REAUTH_WINDOW_MINUTES,
      lockout: Object.freeze({
        customer: Object.freeze({
          maxAttempts: env.LOGIN_MAX_ATTEMPTS_CUSTOMER,
          lockMinutes: env.LOGIN_LOCK_MINUTES_CUSTOMER,
        }),
        staff: Object.freeze({
          maxAttempts: env.LOGIN_MAX_ATTEMPTS_STAFF,
          lockMinutes: env.LOGIN_LOCK_MINUTES_STAFF,
        }),
      }),
      permissionCacheTtlSeconds: env.PERMISSION_CACHE_TTL_SECONDS,
      verificationTtlMinutes: env.VERIFICATION_TOKEN_TTL_MINUTES,
      passwordResetTtlMinutes: env.PASSWORD_RESET_TTL_MINUTES,
      staffResetTtlMinutes: 15,
      staffInviteTtlHours: 72,
      captchaProvider: env.CAPTCHA_PROVIDER,
      mfaIssuer: env.MFA_ISSUER,
      fieldEncryptionKey: env.FIELD_ENCRYPTION_KEY,
      superadminMax: env.SUPERADMIN_MAX,
    }),
    integrations: Object.freeze({
      email: env.EMAIL_PROVIDER,
      whatsapp: env.WHATSAPP_PROVIDER,
      payment: env.PAYMENT_PROVIDER,
      paymentWebhookSecret: env.PAYMENT_WEBHOOK_SECRET,
      shipping: env.SHIPPING_PROVIDER,
      shippingWebhookSecret: env.SHIPPING_WEBHOOK_SECRET,
      media: Object.freeze({
        provider: env.MEDIA_PROVIDER,
        cloudName: env.CLOUDINARY_CLOUD_NAME,
        apiKey: env.CLOUDINARY_API_KEY,
        apiSecret: env.CLOUDINARY_API_SECRET,
        uploadFolder: env.CLOUDINARY_UPLOAD_FOLDER,
        maxUploadMb: env.MEDIA_MAX_UPLOAD_MB,
        allowedFormats: Object.freeze([...env.MEDIA_ALLOWED_FORMATS]),
      }),
      reservationTtlMinutes: env.RESERVATION_TTL_MINUTES,
    }),
    jobs: Object.freeze({ enabled: env.JOBS_ENABLED }),
  });
}

/**
 * Accepts a PEM either with literal `\n` escapes (single-line `.env`) or base64-encoded
 * (REPOSITORY_SETUP_GUIDE §9.1). Never logs the value.
 */
function decodePem(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.includes('-----BEGIN')) return value.replace(/\\n/g, '\n');
  const decoded = Buffer.from(value, 'base64').toString('utf8');
  return decoded.includes('-----BEGIN') ? decoded : value;
}
