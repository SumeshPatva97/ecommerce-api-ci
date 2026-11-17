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

  const strictEnv = env.NODE_ENV === 'production' || env.NODE_ENV === 'staging';
  if (!strictEnv) return problems;

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
  });
}
