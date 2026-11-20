/**
 * DEC-12 real-database test guard — hard, fail-closed safety checks that run BEFORE any database
 * client is constructed. Pure: no I/O, no network, no `process.env` access of its own (the caller
 * passes the environment), so it is unit-tested with fake URLs in the default suite
 * (`tests/unit/dbHarness/guard.test.ts`).
 *
 * Rules (all must pass):
 *  1. `DB_TESTS_CONFIRM` must be exactly `ecommerce_test` (explicit, second opt-in).
 *  2. `DB_TEST_DATABASE_URL` is required. There is NO fallback to `DATABASE_URL`; when
 *     `DATABASE_URL` is present it must differ from the test URL (never the runtime credential).
 *  3. The URL (raw and percent-decoded, case-insensitive) must not contain `ecommerce_dev`,
 *     `ecommerce_prod` or `production` anywhere (database, user, password, host, query).
 *  4. Only `mysql:` / `mariadb:` URLs are accepted.
 *  5. The database name must be EXACTLY `ecommerce_test` (case-sensitive, single path segment).
 *  6. The host must be `localhost` or `127.0.0.1`, unless `DB_TESTS_ALLOW_NON_LOCAL_HOST` is set
 *     to EXACTLY the URL's host name (a per-host, explicit override).
 *
 * Error messages name variables and rules only. They never include the URL, user name, password,
 * host or any other value taken from the URL.
 */

export const DB_TEST_URL_VAR = 'DB_TEST_DATABASE_URL';
export const DB_TEST_CONFIRM_VAR = 'DB_TESTS_CONFIRM';
export const DB_TEST_ALLOW_HOST_VAR = 'DB_TESTS_ALLOW_NON_LOCAL_HOST';
export const REQUIRED_DATABASE = 'ecommerce_test';
export const FORBIDDEN_URL_FRAGMENTS: readonly string[] = [
  'ecommerce_dev',
  'ecommerce_prod',
  'production',
];
export const LOCAL_HOSTS: readonly string[] = ['localhost', '127.0.0.1'];

export class DbTestGuardError extends Error {
  constructor(message: string) {
    super(`[DEC-12 guard] ${message} Refusing to run real-database tests.`);
    this.name = 'DbTestGuardError';
  }
}

/** Validated connection target. `password` is non-enumerable (never serialised or inspected). */
export interface DbTestTarget {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: typeof REQUIRED_DATABASE;
  readonly isLoopback: boolean;
  /** Safe description for logs: `host:port/database` (no user, no password). */
  describe(): string;
}

type Env = Readonly<Record<string, string | undefined>>;

function value(env: Env, name: string): string {
  return (env[name] ?? '').trim();
}

function safeDecode(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/**
 * Resolves and validates the real-database test target from `env`.
 * Throws `DbTestGuardError` on any violation; never returns a target that failed a rule.
 */
export function resolveDbTestTarget(env: Env): DbTestTarget {
  // 1. Explicit second opt-in.
  if (value(env, DB_TEST_CONFIRM_VAR) !== REQUIRED_DATABASE) {
    throw new DbTestGuardError(
      `${DB_TEST_CONFIRM_VAR} must be set to exactly "${REQUIRED_DATABASE}".`,
    );
  }

  // 2. Dedicated URL variable, no fallback.
  const raw = value(env, DB_TEST_URL_VAR);
  if (raw === '') {
    throw new DbTestGuardError(
      `${DB_TEST_URL_VAR} is not set (there is no fallback to DATABASE_URL).`,
    );
  }
  const runtimeUrl = value(env, 'DATABASE_URL');
  if (runtimeUrl !== '' && runtimeUrl === raw) {
    throw new DbTestGuardError(
      `${DB_TEST_URL_VAR} must not be the same connection string as DATABASE_URL.`,
    );
  }

  // 3. Forbidden fragments anywhere in the URL (raw and decoded, case-insensitive).
  const decodedWhole = safeDecode(raw);
  const haystacks = [raw.toLowerCase(), (decodedWhole ?? '').toLowerCase()];
  for (const fragment of FORBIDDEN_URL_FRAGMENTS) {
    if (haystacks.some((h) => h.includes(fragment))) {
      throw new DbTestGuardError(`${DB_TEST_URL_VAR} contains a forbidden fragment ("${fragment}").`);
    }
  }

  // 4. Parse.
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DbTestGuardError(`${DB_TEST_URL_VAR} is not a valid URL.`);
  }
  if (url.protocol !== 'mysql:' && url.protocol !== 'mariadb:') {
    throw new DbTestGuardError(`${DB_TEST_URL_VAR} must use the mysql:// or mariadb:// scheme.`);
  }

  // 5. Database name exactly `ecommerce_test`.
  const rawPath = url.pathname.replace(/^\//, '');
  const database = safeDecode(rawPath);
  if (database !== REQUIRED_DATABASE) {
    throw new DbTestGuardError(
      `the database name in ${DB_TEST_URL_VAR} must be exactly "${REQUIRED_DATABASE}".`,
    );
  }

  // 6. Host: loopback only, unless the per-host override names this exact host.
  const host = url.hostname.toLowerCase();
  if (host === '') throw new DbTestGuardError(`${DB_TEST_URL_VAR} has no host.`);
  const isLoopback = LOCAL_HOSTS.includes(host);
  if (!isLoopback) {
    const allowed = value(env, DB_TEST_ALLOW_HOST_VAR).toLowerCase();
    if (allowed === '' || allowed !== host) {
      throw new DbTestGuardError(
        `the host in ${DB_TEST_URL_VAR} is not localhost/127.0.0.1 and ${DB_TEST_ALLOW_HOST_VAR} ` +
          'does not name it exactly.',
      );
    }
  }

  const user = safeDecode(url.username);
  const password = safeDecode(url.password);
  if (user === null || user === '' || password === null) {
    throw new DbTestGuardError(`${DB_TEST_URL_VAR} must include a valid user name.`);
  }
  const port = url.port === '' ? 3306 : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DbTestGuardError(`${DB_TEST_URL_VAR} has an invalid port.`);
  }

  const target = {
    host,
    port,
    user,
    database: REQUIRED_DATABASE,
    isLoopback,
    describe: () => `${host}:${String(port)}/${REQUIRED_DATABASE}`,
    toJSON: () => ({ host, port, database: REQUIRED_DATABASE }),
  };
  // Non-enumerable: JSON.stringify / util.inspect / spread never expose it.
  Object.defineProperty(target, 'password', { value: password, enumerable: false });
  return Object.freeze(target) as unknown as DbTestTarget;
}
