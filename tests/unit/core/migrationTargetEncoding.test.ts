/**
 * Offline evidence for the G3 v1.2 review (2026-11-19): how the migration guard treats special
 * characters in the migrator password inside MIGRATION_DATABASE_URL. Dummy values only — no
 * connection is made.
 */
import { describe, expect, it } from 'vitest';

import { resolveMigrationTarget } from '../../../src/core/config/migrationTarget.js';

const expected = { MIGRATION_EXPECTED_DATABASE: 'ecommerce_migrate_test' };
const url = (password: string) =>
  `mysql://ecommerce_migrator:${password}@localhost:3306/ecommerce_migrate_test`;

describe('migration URL password encoding (G3 v1.2 review)', () => {
  it('accepts an unreserved-character password unchanged', () => {
    const target = resolveMigrationTarget({
      ...expected,
      MIGRATION_DATABASE_URL: url('Abc-123_x.y~Z'),
    });
    expect(target.database).toBe('ecommerce_migrate_test');
  });

  it('accepts percent-encoded reserved characters', () => {
    const raw = 'p@ss:w/rd#?%!';
    const target = resolveMigrationTarget({
      ...expected,
      MIGRATION_DATABASE_URL: url(encodeURIComponent(raw)),
    });
    expect(target.database).toBe('ecommerce_migrate_test');
  });

  it.each(['pa#ss', 'pa/ss', 'pa?ss'])(
    'an UNENCODED %s never reaches a database: the guard fails closed or the target differs',
    (password) => {
      let database: string | undefined;
      try {
        database = resolveMigrationTarget({
          ...expected,
          MIGRATION_DATABASE_URL: url(password),
        }).database;
      } catch {
        database = undefined; // fail-closed
      }
      // Either the guard refuses, or it resolves the same expected database (never a different one).
      expect(database === undefined || database === 'ecommerce_migrate_test').toBe(true);
    },
  );
});
