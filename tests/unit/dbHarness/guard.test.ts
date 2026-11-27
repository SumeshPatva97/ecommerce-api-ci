/**
 * DEC-12 real-database test guard (tests/db/harness/guard.ts) — accept / refuse matrix with FAKE
 * URLs only. Nothing here connects to a database: the guard is pure and builds no client.
 */
import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  DB_TEST_ALLOW_HOST_VAR,
  DB_TEST_CONFIRM_VAR,
  DB_TEST_URL_VAR,
  DbTestGuardError,
  resolveDbTestTarget,
} from '../../db/harness/guard.js';

const SECRET = 'S3cr3t-pa55';
const GOOD_URL = `mysql://dbtest_user:${SECRET}@localhost:3306/ecommerce_test`;

function env(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return { [DB_TEST_CONFIRM_VAR]: 'ecommerce_test', [DB_TEST_URL_VAR]: GOOD_URL, ...overrides };
}

function refusal(e: Record<string, string | undefined>): DbTestGuardError {
  try {
    resolveDbTestTarget(e);
  } catch (error) {
    expect(error).toBeInstanceOf(DbTestGuardError);
    return error as DbTestGuardError;
  }
  throw new Error('expected the guard to refuse');
}

describe('DEC-12 DB test guard — accepts', () => {
  it('localhost + ecommerce_test + confirmation', () => {
    const t = resolveDbTestTarget(env());
    expect(t.host).toBe('localhost');
    expect(t.port).toBe(3306);
    expect(t.user).toBe('dbtest_user');
    expect(t.password).toBe(SECRET);
    expect(t.database).toBe('ecommerce_test');
    expect(t.isLoopback).toBe(true);
    expect(t.describe()).toBe('localhost:3306/ecommerce_test');
  });

  it('127.0.0.1, default port, mariadb scheme, percent-encoded password, query string', () => {
    const t = resolveDbTestTarget(
      env({
        [DB_TEST_URL_VAR]: 'mariadb://u:p%40ss%2Fw@127.0.0.1/ecommerce_test?connectTimeout=5',
      }),
    );
    expect(t.host).toBe('127.0.0.1');
    expect(t.port).toBe(3306);
    expect(t.password).toBe('p@ss/w');
  });

  it('accepts an empty password and trims surrounding whitespace in the variables', () => {
    const t = resolveDbTestTarget({
      [DB_TEST_CONFIRM_VAR]: '  ecommerce_test ',
      [DB_TEST_URL_VAR]: '  mysql://u@localhost:3307/ecommerce_test  ',
    });
    expect(t.password).toBe('');
    expect(t.port).toBe(3307);
  });

  it('a non-local host only when the override names exactly that host', () => {
    const t = resolveDbTestTarget(
      env({
        [DB_TEST_URL_VAR]: 'mysql://u:p@db-test.internal:3306/ecommerce_test',
        [DB_TEST_ALLOW_HOST_VAR]: 'DB-TEST.internal',
      }),
    );
    expect(t.host).toBe('db-test.internal');
    expect(t.isLoopback).toBe(false);
  });

  it('DATABASE_URL may be present when it differs (it is never used as a fallback)', () => {
    const t = resolveDbTestTarget(
      env({ DATABASE_URL: 'mysql://app:x@localhost:3306/some_other_db' }),
    );
    expect(t.database).toBe('ecommerce_test');
  });

  it('other credential variables that are not URLs do not block a valid target', () => {
    const t = resolveDbTestTarget(
      env({ DATABASE_URL: 'not a url', MIGRATION_DATABASE_URL: '   ' }),
    );
    expect(t.user).toBe('dbtest_user');
  });

  it.each([['test'], ['development'], [undefined], ['']])('NODE_ENV = %s', (nodeEnv) => {
    expect(resolveDbTestTarget(env({ NODE_ENV: nodeEnv })).database).toBe('ecommerce_test');
  });
});

describe('DEC-12 DB test guard — refuses', () => {
  it('an empty environment (fail closed by default)', () => {
    const error = refusal({});
    expect(error.name).toBe('DbTestGuardError');
    expect(error.message).toContain('[DEC-12 guard]');
    expect(error.message).toContain(DB_TEST_CONFIRM_VAR);
    expect(error.message).toContain('Refusing to run real-database tests.');
  });

  it('a valid URL alone, without the confirmation variable', () => {
    expect(refusal({ [DB_TEST_URL_VAR]: GOOD_URL }).message).toContain(DB_TEST_CONFIRM_VAR);
  });

  it('the confirmation alone, without the URL variable', () => {
    expect(refusal({ [DB_TEST_CONFIRM_VAR]: 'ecommerce_test' }).message).toContain(DB_TEST_URL_VAR);
  });

  it.each([['production'], ['staging'], ['PRODUCTION'], [' Staging ']])(
    'a production-like NODE_ENV (%s), even with everything else valid',
    (nodeEnv) => {
      expect(refusal(env({ NODE_ENV: nodeEnv })).message).toContain('NODE_ENV');
    },
  );

  it('when the test URL is the migration credential', () => {
    expect(refusal(env({ MIGRATION_DATABASE_URL: GOOD_URL })).message).toContain(
      'MIGRATION_DATABASE_URL',
    );
  });

  it.each([
    ['DATABASE_URL', 'mysql://dbtest_user:other-password@localhost:3306/another_db'],
    ['MIGRATION_DATABASE_URL', 'mysql://dbtest_user:other-password@127.0.0.1:3306/ecommerce_test'],
  ])('when the test user is also the user of %s', (name, otherUrl) => {
    const error = refusal(env({ [name]: otherUrl }));
    expect(error.message).toContain('dedicated test-only user');
    expect(error.message).toContain(name);
    expect(error.message).not.toContain('dbtest_user');
  });

  it.each([['root'], ['ROOT'], ['Root']])('the administrative user %s', (user) => {
    const error = refusal(env({ [DB_TEST_URL_VAR]: `mysql://${user}:p@localhost/ecommerce_test` }));
    expect(error.message).toContain('administrative account');
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['yes', 'yes'],
    ['true', 'true'],
    ['wrong case', 'ECOMMERCE_TEST'],
    ['other database', 'ecommerce_dev'],
  ])('when %s is set as the confirmation', (_label, confirm) => {
    expect(refusal(env({ [DB_TEST_CONFIRM_VAR]: confirm })).message).toContain(DB_TEST_CONFIRM_VAR);
  });

  it('when the test URL is missing, even if DATABASE_URL points at ecommerce_test', () => {
    const error = refusal({
      [DB_TEST_CONFIRM_VAR]: 'ecommerce_test',
      DATABASE_URL: 'mysql://u:p@localhost:3306/ecommerce_test',
    });
    expect(error.message).toContain('no fallback to DATABASE_URL');
  });

  it('when the test URL is the runtime DATABASE_URL', () => {
    expect(refusal(env({ DATABASE_URL: GOOD_URL })).message).toContain('DATABASE_URL');
  });

  it.each([
    ['dev database', 'mysql://u:p@localhost:3306/ecommerce_dev'],
    ['prod database', 'mysql://u:p@localhost:3306/ecommerce_prod'],
    ['production database', 'mysql://u:p@localhost:3306/production'],
    ['dev name in the query', 'mysql://u:p@localhost/ecommerce_test?db=ecommerce_dev'],
    ['dev name in the user', 'mysql://ecommerce_dev:p@localhost/ecommerce_test'],
    ['production in the password', 'mysql://u:PRODUCTION@localhost/ecommerce_test'],
    ['production in the host', 'mysql://u:p@production.example.com/ecommerce_test'],
    ['percent-encoded dev name', 'mysql://u:p@localhost/%65commerce_dev'],
    ['upper-case prod name', 'mysql://u:p@localhost/ECOMMERCE_PROD'],
    ['staging database', 'mysql://u:p@localhost:3306/ecommerce_staging'],
    ['live database', 'mysql://u:p@localhost:3306/ecommerce_live'],
    ['staging name in the query', 'mysql://u:p@localhost/ecommerce_test?schema=ecommerce_staging'],
  ])('a URL with a forbidden fragment (%s)', (_label, url) => {
    expect(refusal(env({ [DB_TEST_URL_VAR]: url })).message).toContain('forbidden fragment');
  });

  it.each([
    ['no database', 'mysql://u:p@localhost:3306/'],
    ['no path', 'mysql://u:p@localhost:3306'],
    ['suffix', 'mysql://u:p@localhost:3306/ecommerce_test2'],
    ['prefix', 'mysql://u:p@localhost:3306/x_ecommerce_test'],
    ['longer name', 'mysql://u:p@localhost:3306/ecommerce_testing'],
    ['upper case', 'mysql://u:p@localhost:3306/Ecommerce_Test'],
    ['nested path', 'mysql://u:p@localhost:3306/ecommerce_test/extra'],
    ['encoded slash', 'mysql://u:p@localhost:3306/ecommerce_test%2Fx'],
    ['system schema', 'mysql://u:p@localhost:3306/mysql'],
    ['other database', 'mysql://u:p@localhost:3306/shop'],
  ])('a database name that is not exactly ecommerce_test (%s)', (_label, url) => {
    expect(refusal(env({ [DB_TEST_URL_VAR]: url })).message).toContain('exactly "ecommerce_test"');
  });

  it.each([
    ['remote host', 'mysql://u:p@db.example.com:3306/ecommerce_test', undefined],
    ['private IP', 'mysql://u:p@10.0.0.5:3306/ecommerce_test', undefined],
    ['IPv6 loopback (not allow-listed)', 'mysql://u:p@[::1]:3306/ecommerce_test', undefined],
    ['override for another host', 'mysql://u:p@db.example.com/ecommerce_test', 'other.example.com'],
    ['override set to a generic yes', 'mysql://u:p@db.example.com/ecommerce_test', 'true'],
    ['blank override', 'mysql://u:p@db.example.com/ecommerce_test', '  '],
  ])('a non-local host without a matching override (%s)', (_label, url, allow) => {
    const error = refusal(env({ [DB_TEST_URL_VAR]: url, [DB_TEST_ALLOW_HOST_VAR]: allow }));
    expect(error.message).toContain(DB_TEST_ALLOW_HOST_VAR);
  });

  it.each([
    ['postgres scheme', 'postgres://u:p@localhost:5432/ecommerce_test', 'scheme'],
    ['http scheme', 'http://u:p@localhost/ecommerce_test', 'scheme'],
    ['not a URL', 'ecommerce_test', 'not a valid URL'],
    ['missing user', 'mysql://localhost:3306/ecommerce_test', 'user name'],
    ['bad port', 'mysql://u:p@localhost:0/ecommerce_test', 'port'],
  ])('a malformed URL (%s)', (_label, url, expected) => {
    expect(refusal(env({ [DB_TEST_URL_VAR]: url })).message).toContain(expected);
  });
});

describe('DEC-12 DB test guard — secrecy', () => {
  it('error messages never contain the URL, user, host or password', () => {
    const urls = [
      `mysql://secret_user:${SECRET}@db.example.com:3306/ecommerce_test`,
      `mysql://secret_user:${SECRET}@localhost:3306/wrong_db`,
      `mysql://secret_user:${SECRET}production@localhost:3306/ecommerce_test`,
      `postgres://secret_user:${SECRET}@localhost/ecommerce_test`,
    ];
    for (const url of urls) {
      const message = refusal(env({ [DB_TEST_URL_VAR]: url })).message;
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain('secret_user');
      expect(message).not.toContain('db.example.com');
      expect(message).not.toContain(url);
    }
  });

  it('the resolved target never serialises or inspects the password', () => {
    const t = resolveDbTestTarget(env());
    expect(JSON.stringify(t)).not.toContain(SECRET);
    expect(inspect(t)).not.toContain(SECRET);
    expect(JSON.stringify({ ...t })).not.toContain(SECRET);
    expect(t.describe()).not.toContain(SECRET);
    expect(t.describe()).not.toContain('dbtest_user');
    expect(Object.isFrozen(t)).toBe(true);
  });
});
