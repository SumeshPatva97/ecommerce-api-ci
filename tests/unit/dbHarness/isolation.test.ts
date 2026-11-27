/**
 * DEC-12 isolation rules of the real-database harness — static checks, no database, no client.
 *
 * Keeps the fail-closed properties true as the harness evolves:
 *  - the default suite (`vitest.config.ts`) can never collect a real-database scenario;
 *  - the DB configuration collects only `*.dbtest.ts`, runs one fork and aborts through the
 *    guard before any worker starts;
 *  - only `client.ts` constructs a Prisma client, only `world.ts` and the two setup files read
 *    `process.env`, and `world.ts` calls the guard before it opens the client;
 *  - every scenario calls the guard and `openWorld`, and no scenario / SQL file contains DDL.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import defaultConfig from '../../../vitest.config.js';
import dbConfig from '../../db/vitest.db.config.js';

const DB_DIR = fileURLToPath(new URL('../../db/', import.meta.url));
const EXPECTED_SCENARIOS = ['tc-004', 'tc-030', 'tc-041', 'tc-045', 'tc-048', 'tc-051'];

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(DB_DIR, `${entry.parentPath}/${entry.name}`).replaceAll('\\', '/'))
    .sort();
}

const files = filesUnder(DB_DIR);
const read = (file: string): string => readFileSync(`${DB_DIR}/${file}`, 'utf8');
/** Source without block / line comments (comments legitimately mention forbidden words). */
const code = (file: string): string =>
  read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*(\/\/|--).*$/gm, '');
const scenarios = files.filter((f) => f.endsWith('.dbtest.ts'));

describe('DEC-12 harness isolation — configuration', () => {
  it('the default suite includes only *.test.ts and no file under tests/db matches it', () => {
    expect(defaultConfig.test?.include).toEqual(['tests/**/*.test.ts']);
    expect(files.filter((f) => f.endsWith('.test.ts'))).toEqual([]);
    expect(files.filter((f) => /\.(spec|test)\.[cm]?[jt]sx?$/.test(f))).toEqual([]);
  });

  it('the DB configuration collects only *.dbtest.ts, in one fork, behind the guard', () => {
    const test = dbConfig.test;
    expect(test?.include).toEqual(['tests/db/**/*.dbtest.ts']);
    expect(test?.pool).toBe('forks');
    expect(test?.maxWorkers).toBe(1);
    expect(test?.fileParallelism).toBe(false);
    expect(test?.passWithNoTests).toBe(false);
    expect(test?.globalSetup).toContain('tests/db/setup/globalGuard.ts');
    expect(test?.setupFiles).toEqual(['tests/db/setup/workerGuard.ts']);
    expect(test?.testTimeout).toBeGreaterThanOrEqual(120_000);
    expect(test?.hookTimeout).toBeGreaterThanOrEqual(120_000);
    // No `.env*` file is read by Vite for this suite.
    expect(dbConfig.envDir).toBe(false);
  });

  it('the guard setup files import nothing but the pure guard / options modules', () => {
    for (const file of ['setup/globalGuard.ts', 'setup/workerGuard.ts']) {
      const imports = [...read(file).matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      expect(imports.length).toBeGreaterThan(0);
      for (const source of imports) {
        expect(['../harness/guard.js', '../harness/options.js']).toContain(source);
      }
      expect(code(file)).toContain('resolveDbTestTarget(process.env)');
    }
    for (const file of ['harness/guard.ts', 'harness/options.ts']) {
      expect(code(file)).not.toMatch(/\bimport\b/);
      expect(code(file)).not.toContain('process.env');
    }
  });
});

describe('DEC-12 harness isolation — source rules', () => {
  it('has the six scenario files', () => {
    expect(scenarios.map((f) => /scenarios\/(tc-\d{3})-/.exec(f)?.[1])).toEqual(EXPECTED_SCENARIOS);
  });

  it('only client.ts constructs a Prisma client', () => {
    const constructing = files.filter(
      (f) => f.endsWith('.ts') && code(f).includes('new PrismaClient('),
    );
    expect(constructing).toEqual(['harness/client.ts']);
  });

  it('only world.ts and the setup files read process.env; DATABASE_URL is never read', () => {
    const reading = files.filter((f) => f.endsWith('.ts') && code(f).includes('process.env'));
    expect(reading).toEqual(['harness/world.ts', 'setup/globalGuard.ts', 'setup/workerGuard.ts']);
    for (const file of files.filter((f) => f.endsWith('.ts'))) {
      expect(code(file)).not.toMatch(/process\.env\s*(\.|\[)/);
      expect(code(file)).not.toMatch(/loadConfigFromProcess|loadEnvFile|createDatabase\(/);
    }
  });

  it('world.ts runs the guard before it opens the client', () => {
    const source = code('harness/world.ts');
    const open = source.slice(source.indexOf('export async function openWorld'));
    const guardAt = open.indexOf('resolveDbTestTarget(process.env)');
    const clientAt = open.indexOf('openVerifiedClient(');
    expect(guardAt).toBeGreaterThan(-1);
    expect(clientAt).toBeGreaterThan(guardAt);
    // The client is built only from the guard-validated target, never from a URL string.
    expect(code('harness/client.ts')).toContain('target: DbTestTarget');
    expect(code('harness/client.ts')).toContain('assertServerDatabase(db)');
  });

  it.each(scenarios)('%s calls the guard, then openWorld, and closes the world', (file) => {
    const source = code(file);
    const guardAt = source.indexOf('assertDbTestGuard()');
    const openAt = source.indexOf('await openWorld(');
    expect(guardAt).toBeGreaterThan(-1);
    expect(openAt).toBeGreaterThan(guardAt);
    expect(source).toMatch(/afterAll\(async \(\) => \{\s*await world\?\.close\(\);/);
    expect(source).toContain('.reset()');
    expect(source).not.toMatch(/\$executeRaw|\$queryRaw/);
    expect(read(file)).toContain('NOT EXECUTED — requires explicit owner authorization (DEC-12)');
  });

  it('no scenario, harness or SQL file contains DDL or cross-database statements', () => {
    const ddl =
      /\b(DROP|TRUNCATE|CREATE|ALTER|RENAME|GRANT|REVOKE)\s+(DATABASE|SCHEMA|TABLE|USER|INDEX|VIEW|ALL)\b|\bUSE\s+`?[a-z_]+`?\s*;/i;
    for (const file of files.filter((f) => /\.(ts|sql)$/.test(f))) {
      expect(ddl.test(code(file)), file).toBe(false);
      expect(
        /ecommerce_(dev|prod|staging|live)\b/.test(code(file)) && file !== 'harness/guard.ts',
        file,
      ).toBe(false);
    }
  });

  it('the SQL files are guarded and marked as not executed', () => {
    for (const file of files.filter((f) => f.endsWith('.sql'))) {
      expect(read(file)).toContain('NOT EXECUTED — requires explicit owner authorization (DEC-12)');
      expect(code(file).trimStart().startsWith('SET @db_guard = (SELECT 1 FROM DUAL')).toBe(true);
    }
    expect(code('sql/setup.sql')).not.toMatch(/\b(INSERT|UPDATE|DELETE|REPLACE)\b/i);
  });
});
