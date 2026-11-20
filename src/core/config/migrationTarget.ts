/**
 * Migration-connection guard (G3 — migration connection configuration).
 *
 * Prisma CLI commands that write to a database (`migrate deploy`, `migrate status`,
 * `migrate resolve`) must use the dedicated migration credential, never the runtime
 * credential. This module resolves and validates the migration target from the
 * migration-only environment, and fails closed on any ambiguity.
 *
 * Rules enforced here (approved direction, see
 * `docs/INCREMENT-B-G3-MIGRATION-CONNECTION.md`):
 *  - `MIGRATION_DATABASE_URL` is required; there is **no fallback** to `DATABASE_URL`.
 *  - `MIGRATION_EXPECTED_DATABASE` is required and must equal the database named in the URL
 *    (fail-closed database-name guard for G7/G8).
 *  - Only `mysql:`/`mariadb:` URLs with an explicit database name are accepted.
 *  - System schemas are refused.
 *  - The migration URL must differ from `DATABASE_URL` when the latter is present,
 *    so migrations can never run with the runtime user by accident.
 *
 * Error messages name variables and database names only. They never include the URL,
 * user name, password or any other secret value.
 *
 * This module is imported by `prisma.migration.config.ts` only. It never reads
 * `process.env` itself, so the runtime application cannot obtain migration credentials
 * through it.
 */

export class MigrationTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationTargetError';
  }
}

export interface MigrationTarget {
  /** Validated connection URL (never log this value). */
  readonly url: string;
  /** Database name parsed from the URL; equals `expectedDatabase`. */
  readonly database: string;
  /** Value of `MIGRATION_EXPECTED_DATABASE`. */
  readonly expectedDatabase: string;
}

const SYSTEM_SCHEMAS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

function trimmed(value: string | undefined): string {
  return (value ?? '').trim();
}

/**
 * Parses the database name from a MySQL connection URL's path.
 * Rejects empty names and names that still contain a path separator after decoding.
 */
function parseDatabaseName(parsed: URL): string {
  const rawPath = parsed.pathname.replace(/^\/+/, '');
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    throw new MigrationTargetError(
      'MIGRATION_DATABASE_URL contains an invalid percent-encoded database name.',
    );
  }
  if (decoded === '') {
    throw new MigrationTargetError(
      'MIGRATION_DATABASE_URL must include a database name (mysql://user:password@host:port/database).',
    );
  }
  if (decoded.includes('/')) {
    throw new MigrationTargetError(
      'MIGRATION_DATABASE_URL must name exactly one database (no path segments after the database name).',
    );
  }
  return decoded;
}

/**
 * Resolves the migration target or throws `MigrationTargetError`.
 * Callers must pass the migration-only environment; `DATABASE_URL` is inspected only to
 * prove the two credentials differ.
 */
export function resolveMigrationTarget(
  env: Readonly<Record<string, string | undefined>>,
): MigrationTarget {
  const url = trimmed(env.MIGRATION_DATABASE_URL);
  const expectedDatabase = trimmed(env.MIGRATION_EXPECTED_DATABASE);

  if (url === '') {
    throw new MigrationTargetError(
      'MIGRATION_DATABASE_URL is required for migration commands. There is no fallback to DATABASE_URL; put the migration credential in ecommerce-api/.env.migration (git-ignored).',
    );
  }
  if (expectedDatabase === '') {
    throw new MigrationTargetError(
      'MIGRATION_EXPECTED_DATABASE is required for migration commands; set it to the exact target database name (for G7: ecommerce_migrate_test).',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MigrationTargetError(
      'MIGRATION_DATABASE_URL must be a valid connection URL (mysql://user:password@host:port/database).',
    );
  }

  if (parsed.protocol !== 'mysql:' && parsed.protocol !== 'mariadb:') {
    throw new MigrationTargetError(
      'MIGRATION_DATABASE_URL must use the mysql:// scheme (mariadb:// is also accepted).',
    );
  }

  const database = parseDatabaseName(parsed);

  if (SYSTEM_SCHEMAS.has(database.toLowerCase())) {
    throw new MigrationTargetError(
      `MIGRATION_DATABASE_URL must not target the MySQL system schema "${database}".`,
    );
  }
  if (database !== expectedDatabase) {
    throw new MigrationTargetError(
      `MIGRATION_DATABASE_URL targets database "${database}" but MIGRATION_EXPECTED_DATABASE is "${expectedDatabase}". Refusing to run.`,
    );
  }

  const runtimeUrl = trimmed(env.DATABASE_URL);
  if (runtimeUrl !== '' && runtimeUrl === url) {
    throw new MigrationTargetError(
      'MIGRATION_DATABASE_URL must not be identical to DATABASE_URL: migrations must use ecommerce_migrator, never the runtime user.',
    );
  }

  return { url, database, expectedDatabase };
}
