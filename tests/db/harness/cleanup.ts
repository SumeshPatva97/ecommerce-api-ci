/**
 * DEC-12 — deletes all rows of every application table in `ecommerce_test` (never
 * `_prisma_migrations`), using `tests/db/sql/cleanup.sql` as the single source of truth.
 *
 * Safety:
 * - the server must report `ecommerce_test` (`assertServerDatabase`) before anything runs;
 * - every statement of the SQL file must match a strict allow-list (the DB guard statement,
 *   `UPDATE … SET … = NULL WHERE … IS NOT NULL`, `DELETE FROM <table>`); DROP / TRUNCATE / ALTER /
 *   CREATE / GRANT / RENAME anywhere refuses the whole file;
 * - statements run on ONE connection inside one transaction;
 * - after the cleanup the harness checks (read-only, `information_schema`) that the file names every
 *   application table — a new table missing from the file fails loudly — and that all are empty.
 */
import { readFileSync } from 'node:fs';

import type { PrismaClient } from '../../../src/generated/prisma/client.js';
import { assertServerDatabase } from './client.js';

const CLEANUP_SQL = new URL('../sql/cleanup.sql', import.meta.url);

const GUARD_STATEMENT =
  "SET @db_guard = (SELECT 1 FROM DUAL WHERE NOT (DATABASE() <=> 'ecommerce_test') UNION ALL SELECT 1 FROM DUAL WHERE NOT (DATABASE() <=> 'ecommerce_test'))";
const NULLIFY = /^UPDATE `([a-z_]+)` SET `[a-z_]+` = NULL WHERE `[a-z_]+` IS NOT NULL$/;
const DELETE = /^DELETE FROM `([a-z_]+)`$/;
const FORBIDDEN = /\b(DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|RENAME|INSERT|REPLACE|LOAD)\b/i;

export interface CleanupPlan {
  readonly statements: readonly string[];
  /** Tables emptied, in execution order (children first). */
  readonly tables: readonly string[];
}

/** Parses and validates cleanup.sql (no database access). Throws on anything unexpected. */
export function loadCleanupPlan(sql: string = readFileSync(CLEANUP_SQL, 'utf8')): CleanupPlan {
  const statements = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s !== '');
  if (statements[0] !== GUARD_STATEMENT) {
    throw new Error('cleanup.sql must start with the ecommerce_test guard statement.');
  }
  const tables: string[] = [];
  for (const statement of statements.slice(1)) {
    if (FORBIDDEN.test(statement)) throw new Error('cleanup.sql contains a forbidden statement.');
    const deleted = DELETE.exec(statement);
    if (deleted?.[1] !== undefined) {
      tables.push(deleted[1]);
      continue;
    }
    if (!NULLIFY.test(statement)) {
      throw new Error('cleanup.sql contains a statement outside the allow-list.');
    }
  }
  if (new Set(tables).size !== tables.length) throw new Error('cleanup.sql deletes a table twice.');
  return { statements, tables };
}

/** Empties every application table of ecommerce_test (DML only) and verifies the result. */
export async function cleanDatabase(db: PrismaClient): Promise<void> {
  const plan = loadCleanupPlan();
  await assertServerDatabase(db);
  await db.$transaction(
    async (tx) => {
      for (const statement of plan.statements) await tx.$executeRawUnsafe(statement);
    },
    { timeout: 120_000, maxWait: 30_000 },
  );

  const present = await db.$queryRaw<{ name: string }[]>`
    SELECT TABLE_NAME AS name FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
      AND TABLE_NAME <> '_prisma_migrations'`;
  const planned = new Set(plan.tables);
  const missing = present.map((r) => r.name).filter((name) => !planned.has(name));
  if (missing.length > 0) {
    throw new Error(`cleanup.sql does not cover table(s): ${missing.join(', ')}`);
  }
  for (const table of plan.tables) {
    // Table names come from the allow-listed file (^[a-z_]+$), never from user input.
    const rows = await db.$queryRawUnsafe<{ n: bigint | number }[]>(
      `SELECT COUNT(*) AS n FROM \`${table}\``,
    );
    if (Number(rows[0]?.n ?? 0) !== 0) throw new Error(`cleanup left rows in ${table}.`);
  }
}
