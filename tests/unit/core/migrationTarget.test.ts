import { describe, expect, it } from 'vitest';

import {
  MigrationTargetError,
  resolveMigrationTarget,
} from '../../../src/core/config/migrationTarget.js';

const MIGRATION_URL = 'mysql://ecommerce_migrator:secret@localhost:3306/ecommerce_migrate_test';

function resolve(overrides: Record<string, string | undefined> = {}) {
  return resolveMigrationTarget({
    MIGRATION_DATABASE_URL: MIGRATION_URL,
    MIGRATION_EXPECTED_DATABASE: 'ecommerce_migrate_test',
    ...overrides,
  });
}

function messageOf(overrides: Record<string, string | undefined> = {}): string {
  try {
    resolve(overrides);
  } catch (error) {
    if (error instanceof MigrationTargetError) return error.message;
    throw error;
  }
  throw new Error('expected MigrationTargetError');
}

describe('resolveMigrationTarget', () => {
  it('returns the validated migration target', () => {
    expect(resolve()).toEqual({
      url: MIGRATION_URL,
      database: 'ecommerce_migrate_test',
      expectedDatabase: 'ecommerce_migrate_test',
    });
  });

  it('trims surrounding whitespace before validating', () => {
    expect(
      resolve({
        MIGRATION_DATABASE_URL: `  ${MIGRATION_URL}  `,
        MIGRATION_EXPECTED_DATABASE: '  ecommerce_migrate_test  ',
      }).database,
    ).toBe('ecommerce_migrate_test');
  });

  it('decodes a percent-encoded database name', () => {
    expect(
      resolve({
        MIGRATION_DATABASE_URL: 'mysql://u:p@localhost:3306/ecommerce%5Fdev',
        MIGRATION_EXPECTED_DATABASE: 'ecommerce_dev',
      }).database,
    ).toBe('ecommerce_dev');
  });

  it('requires MIGRATION_DATABASE_URL and never falls back to DATABASE_URL', () => {
    const message = messageOf({
      MIGRATION_DATABASE_URL: undefined,
      DATABASE_URL: 'mysql://ecommerce_app:supplied@localhost:3306/ecommerce_dev',
    });
    expect(message).toContain('MIGRATION_DATABASE_URL is required');
    expect(message).not.toContain('ecommerce_app');
    expect(message).not.toContain('supplied');
  });

  it('treats a blank MIGRATION_DATABASE_URL as missing', () => {
    expect(messageOf({ MIGRATION_DATABASE_URL: '   ' })).toContain(
      'MIGRATION_DATABASE_URL is required',
    );
  });

  it('requires MIGRATION_EXPECTED_DATABASE', () => {
    expect(messageOf({ MIGRATION_EXPECTED_DATABASE: undefined })).toContain(
      'MIGRATION_EXPECTED_DATABASE is required',
    );
  });

  it('rejects an unparseable URL without echoing it', () => {
    const message = messageOf({ MIGRATION_DATABASE_URL: 'not a url' });
    expect(message).toContain('must be a valid connection URL');
    expect(message).not.toContain('not a url');
  });

  it('rejects non-MySQL schemes', () => {
    expect(
      messageOf({
        MIGRATION_DATABASE_URL: 'postgresql://u:p@localhost:5432/ecommerce_migrate_test',
      }),
    ).toContain('must use the mysql:// scheme');
  });

  it('rejects a URL without a database name', () => {
    expect(
      messageOf({
        MIGRATION_DATABASE_URL: 'mysql://u:p@localhost:3306/',
        MIGRATION_EXPECTED_DATABASE: 'ecommerce_migrate_test',
      }),
    ).toContain('must include a database name');
  });

  it('rejects extra path segments after the database name', () => {
    expect(
      messageOf({
        MIGRATION_DATABASE_URL: 'mysql://u:p@localhost:3306/ecommerce_migrate_test/extra',
        MIGRATION_EXPECTED_DATABASE: 'ecommerce_migrate_test',
      }),
    ).toContain('exactly one database');
  });

  it('rejects the MySQL system schemas', () => {
    expect(
      messageOf({
        MIGRATION_DATABASE_URL: 'mysql://u:p@localhost:3306/mysql',
        MIGRATION_EXPECTED_DATABASE: 'mysql',
      }),
    ).toContain('system schema');
  });

  it('fails closed when the URL database differs from the expected database', () => {
    const message = messageOf({
      MIGRATION_EXPECTED_DATABASE: 'ecommerce_migrate_test',
      MIGRATION_DATABASE_URL: 'mysql://u:p@localhost:3306/ecommerce_dev',
    });
    expect(message).toContain('targets database "ecommerce_dev"');
    expect(message).toContain('MIGRATION_EXPECTED_DATABASE is "ecommerce_migrate_test"');
    expect(message).toContain('Refusing to run');
  });

  it('rejects a case-only database-name difference (MySQL names are case-sensitive here)', () => {
    expect(messageOf({ MIGRATION_EXPECTED_DATABASE: 'Ecommerce_Migrate_Test' })).toContain(
      'Refusing to run',
    );
  });

  it('rejects a migration URL identical to DATABASE_URL', () => {
    expect(messageOf({ DATABASE_URL: MIGRATION_URL })).toContain(
      'must not be identical to DATABASE_URL',
    );
  });

  it('accepts a different DATABASE_URL (runtime credential stays separate)', () => {
    expect(
      resolve({ DATABASE_URL: 'mysql://ecommerce_app:other@localhost:3306/ecommerce_dev' })
        .database,
    ).toBe('ecommerce_migrate_test');
  });

  it('never includes the password or user in any error message', () => {
    const cases: Record<string, string | undefined>[] = [
      { MIGRATION_EXPECTED_DATABASE: 'wrong_db' },
      { MIGRATION_DATABASE_URL: 'mysql://ecommerce_migrator:topsecret@localhost:3306/' },
      { MIGRATION_DATABASE_URL: 'mysql://ecommerce_migrator:topsecret@localhost:3306/mysql' },
      { DATABASE_URL: MIGRATION_URL },
    ];
    for (const overrides of cases) {
      const message = messageOf(overrides);
      expect(message).not.toContain('topsecret');
      expect(message).not.toContain('secret');
      expect(message).not.toContain('ecommerce_migrator:');
    }
  });
});
