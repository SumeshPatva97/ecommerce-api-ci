/**
 * DEC-12 cleanup plan (tests/db/harness/cleanup.ts + tests/db/sql/cleanup.sql) — verified OFFLINE
 * against the baseline migration SQL. Nothing here connects to a database: `loadCleanupPlan`
 * only parses a file.
 *
 * Proves that the cleanup (a) is DML only and passes the statement allow-list, (b) names every
 * application table of the baseline exactly once and nothing else, and (c) deletes every child
 * table before its parent for every foreign key of the baseline, so no `ON DELETE RESTRICT` can
 * block it.
 */
import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { loadCleanupPlan } from '../../db/harness/cleanup.js';

const MIGRATIONS = new URL('../../../prisma/migrations/', import.meta.url);
const GUARD =
  "SET @db_guard = (SELECT 1 FROM DUAL WHERE NOT (DATABASE() <=> 'ecommerce_test') UNION ALL SELECT 1 FROM DUAL WHERE NOT (DATABASE() <=> 'ecommerce_test'));";

interface ForeignKey {
  readonly child: string;
  readonly columns: string;
  readonly parent: string;
  readonly onDelete: string;
}

function migrationSql(): string {
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => readFileSync(new URL(`${name}/migration.sql`, MIGRATIONS), 'utf8'))
    .join('\n');
}

function schemaOf(sql: string): {
  tables: string[];
  foreignKeys: ForeignKey[];
  foreignKeyClauses: number;
} {
  const tables = [...sql.matchAll(/CREATE TABLE `([a-z_]+)`/g)].flatMap((m) =>
    m[1] === undefined ? [] : [m[1]],
  );
  // Single- and multi-column keys: FOREIGN KEY (`a`, `b`) REFERENCES `parent`(…) ON DELETE <action>
  const foreignKeys = [
    ...sql.matchAll(
      /ALTER TABLE `([a-z_]+)` ADD CONSTRAINT `[^`]+` FOREIGN KEY \(([^)]+)\) REFERENCES `([a-z_]+)`\([^)]+\) ON DELETE (RESTRICT|CASCADE|SET NULL|NO ACTION)/g,
    ),
  ].flatMap((m) =>
    m[1] === undefined || m[2] === undefined || m[3] === undefined || m[4] === undefined
      ? []
      : [{ child: m[1], columns: m[2].replaceAll('`', ''), parent: m[3], onDelete: m[4] }],
  );
  return { tables, foreignKeys, foreignKeyClauses: sql.split('FOREIGN KEY').length - 1 };
}

describe('DEC-12 cleanup plan — offline verification against the baseline migration', () => {
  const plan = loadCleanupPlan();
  const schema = schemaOf(migrationSql());

  it('parses the baseline (sanity: tables and foreign keys were found)', () => {
    expect(schema.tables.length).toBeGreaterThan(50);
    expect(schema.foreignKeys.length).toBeGreaterThan(50);
    // The parser understood every FOREIGN KEY clause of the baseline (none silently skipped).
    expect(schema.foreignKeys).toHaveLength(schema.foreignKeyClauses);
    expect(new Set(schema.tables).size).toBe(schema.tables.length);
  });

  it('starts with the ecommerce_test guard statement and contains DML only', () => {
    expect(`${plan.statements[0] ?? ''};`).toBe(GUARD);
    for (const statement of plan.statements.slice(1)) {
      expect(statement).toMatch(/^(DELETE FROM|UPDATE) `[a-z_]+`/);
      expect(statement).not.toMatch(/\b(DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|RENAME)\b/i);
    }
  });

  it('deletes every application table exactly once and never _prisma_migrations', () => {
    expect([...plan.tables].sort()).toEqual([...schema.tables].sort());
    expect(plan.tables).not.toContain('_prisma_migrations');
  });

  it('deletes every child table before its parent (all baseline foreign keys)', () => {
    const position = new Map(plan.tables.map((table, index) => [table, index]));
    const violations = schema.foreignKeys
      .filter((fk) => fk.child !== fk.parent)
      .filter((fk) => (position.get(fk.child) ?? -1) > (position.get(fk.parent) ?? -1))
      .map((fk) => `${fk.child}.${fk.columns} -> ${fk.parent}`);
    expect(violations).toEqual([]);
  });

  it('clears every self-referencing foreign key before the deletes', () => {
    const selfReferences = schema.foreignKeys.filter((fk) => fk.child === fk.parent);
    const firstDelete = plan.statements.findIndex((s) => s.startsWith('DELETE FROM'));
    const nullified = plan.statements.slice(1, firstDelete).flatMap((s) => {
      const match = /^UPDATE `([a-z_]+)` SET `([a-z_]+)` = NULL/.exec(s);
      return match === null ? [] : [`${match[1] ?? ''}.${match[2] ?? ''}`];
    });
    // ON DELETE SET NULL / CASCADE self-references need no UPDATE; RESTRICT / NO ACTION do.
    const required = selfReferences
      .filter((fk) => fk.onDelete === 'RESTRICT' || fk.onDelete === 'NO ACTION')
      .map((fk) => `${fk.child}.${fk.columns}`);
    expect(selfReferences.length).toBeGreaterThanOrEqual(required.length);
    expect(nullified.sort()).toEqual(required.sort());
  });

  it.each([
    ['DROP TABLE', 'DROP TABLE `users`;'],
    ['DROP DATABASE', 'DROP DATABASE ecommerce_test;'],
    ['TRUNCATE', 'TRUNCATE TABLE `users`;'],
    ['ALTER', 'ALTER TABLE `users` ADD COLUMN x INT;'],
    ['a WHERE-less UPDATE of data', "UPDATE `users` SET `email` = 'x';"],
    ['a DELETE with a qualified database', 'DELETE FROM `ecommerce_dev`.`users`;'],
    ['a DELETE with a WHERE clause', 'DELETE FROM `users` WHERE 1 = 1;'],
    ['an INSERT', "INSERT INTO `users` (`id`) VALUES ('x');"],
    ['a USE statement', 'USE ecommerce_dev;'],
  ])('refuses a cleanup file containing %s', (_label, statement) => {
    expect(() => loadCleanupPlan(`${GUARD}\n${statement}\nDELETE FROM \`users\`;`)).toThrow();
  });

  it('refuses a cleanup file without the guard statement or deleting a table twice', () => {
    expect(() => loadCleanupPlan('DELETE FROM `users`;')).toThrow(/guard statement/);
    expect(() =>
      loadCleanupPlan(`${GUARD}\nDELETE FROM \`users\`;\nDELETE FROM \`users\`;`),
    ).toThrow(/twice/);
  });
});
