/**
 * DEC-12 fail-closed wiring — proves, WITHOUT a database, that every entry point of the
 * real-database harness refuses before a client can exist.
 *
 * `tests/db/harness/client.js` (the only module that constructs a Prisma client) is replaced by
 * a mock for this whole file, so nothing here can open a connection even by mistake. The single
 * "guard passes" case uses a fake URL on 127.0.0.1 port 1 and asserts only that the (mocked)
 * client factory receives the guard-validated target.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const clientModule = vi.hoisted(() => ({
  openVerifiedClient: vi.fn(),
  createTestPrismaClient: vi.fn(() => {
    throw new Error('a Prisma client must never be constructed in the default suite');
  }),
  assertServerDatabase: vi.fn(),
}));
vi.mock('../../db/harness/client.js', () => clientModule);

import {
  DB_TEST_ALLOW_HOST_VAR,
  DB_TEST_CONFIRM_VAR,
  DB_TEST_URL_VAR,
  DbTestGuardError,
} from '../../db/harness/guard.js';
import { DB_TEST_ITERATIONS_VAR } from '../../db/harness/options.js';
import { assertDbTestGuard, openWorld, scenarioTimeout } from '../../db/harness/world.js';
import globalGuard from '../../db/setup/globalGuard.js';

const HARNESS_VARS = [
  DB_TEST_URL_VAR,
  DB_TEST_CONFIRM_VAR,
  DB_TEST_ALLOW_HOST_VAR,
  DB_TEST_ITERATIONS_VAR,
  'DATABASE_URL',
  'MIGRATION_DATABASE_URL',
];
/** Fake credentials on a closed port: unusable even if the client mock were bypassed. */
const FAKE_URL = 'mysql://dbtest_fake:not-a-real-password@127.0.0.1:1/ecommerce_test';

function stubEnvironment(values: Record<string, string>): void {
  for (const name of HARNESS_VARS) vi.stubEnv(name, undefined);
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  clientModule.openVerifiedClient.mockReset();
});

describe('DEC-12 fail-closed wiring — refusals happen before any client', () => {
  it.each([
    ['no variables at all', {}],
    ['the URL without the confirmation', { [DB_TEST_URL_VAR]: FAKE_URL }],
    ['the confirmation without the URL', { [DB_TEST_CONFIRM_VAR]: 'ecommerce_test' }],
    ['only DATABASE_URL (never a fallback)', { DATABASE_URL: FAKE_URL }],
    [
      'a development database',
      {
        [DB_TEST_CONFIRM_VAR]: 'ecommerce_test',
        [DB_TEST_URL_VAR]: 'mysql://dbtest_fake:x@127.0.0.1:1/ecommerce_dev',
      },
    ],
    [
      'a non-local host without the override',
      {
        [DB_TEST_CONFIRM_VAR]: 'ecommerce_test',
        [DB_TEST_URL_VAR]: 'mysql://dbtest_fake:x@db.invalid:1/ecommerce_test',
      },
    ],
    [
      'an invalid iteration count',
      {
        [DB_TEST_CONFIRM_VAR]: 'ecommerce_test',
        [DB_TEST_URL_VAR]: FAKE_URL,
        [DB_TEST_ITERATIONS_VAR]: 'many',
      },
    ],
  ])('openWorld() with %s', async (label, values) => {
    stubEnvironment(values);
    const refusal = await openWorld().then(
      () => null,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(Error);
    if (label !== 'an invalid iteration count') {
      expect(refusal).toBeInstanceOf(DbTestGuardError);
      expect(() => {
        assertDbTestGuard();
      }).toThrow(DbTestGuardError);
    }
    expect(clientModule.openVerifiedClient).not.toHaveBeenCalled();
    expect(clientModule.createTestPrismaClient).not.toHaveBeenCalled();
    expect((refusal as Error).message).not.toContain('dbtest_fake');
  });

  it('the vitest global setup throws the guard error', () => {
    stubEnvironment({});
    expect(() => {
      globalGuard();
    }).toThrow(DbTestGuardError);
  });

  it('the vitest per-file setup throws the guard error when it is evaluated', async () => {
    stubEnvironment({});
    await expect(import('../../db/setup/workerGuard.js')).rejects.toBeInstanceOf(DbTestGuardError);
  });
});

describe('DEC-12 fail-closed wiring — scenario timeouts', () => {
  it('grow with DB_TESTS_ITERATIONS and refuse an invalid value', () => {
    stubEnvironment({});
    expect(scenarioTimeout(60_000)).toBe(60_000 + 3 * 60_000);
    expect(scenarioTimeout(60_000, 1)).toBe(120_000);
    stubEnvironment({ [DB_TEST_ITERATIONS_VAR]: '20' });
    expect(scenarioTimeout(180_000)).toBe(60_000 + 20 * 180_000);
    stubEnvironment({ [DB_TEST_ITERATIONS_VAR]: '0' });
    expect(() => scenarioTimeout(60_000)).toThrow(DB_TEST_ITERATIONS_VAR);
  });
});

describe('DEC-12 fail-closed wiring — when the guard passes', () => {
  it('the client is opened once, from the validated target only, and the real app is built', async () => {
    stubEnvironment({ [DB_TEST_CONFIRM_VAR]: 'ecommerce_test', [DB_TEST_URL_VAR]: FAKE_URL });
    const fakeDb = { marker: 'fake-client' };
    clientModule.openVerifiedClient.mockResolvedValue(fakeDb);
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    const world = await openWorld({ poolSize: 7 });

    expect(clientModule.openVerifiedClient).toHaveBeenCalledTimes(1);
    const [target, poolSize] = clientModule.openVerifiedClient.mock.calls[0] ?? [];
    expect(target).toMatchObject({ host: '127.0.0.1', port: 1, database: 'ecommerce_test' });
    expect(poolSize).toBe(7);
    expect(world.db).toBe(fakeDb);
    expect(world.container.db).toBe(fakeDb);
    expect(typeof world.app).toBe('function');
    expect(world.iterations).toBe(3);
    // The application never receives a usable connection string.
    expect(world.config.databaseUrl).not.toContain('mysql');
    expect(world.config.rateLimit.enabled).toBe(false);

    // Application clock = real time + offset.
    const before = world.container.clock().getTime();
    world.advanceClock(11_000);
    expect(world.container.clock().getTime() - before).toBeGreaterThanOrEqual(11_000);

    // The evidence line carries no credential, user or host.
    const output = written.join('');
    expect(output).toContain('[DEC-12][HARNESS]');
    expect(output).not.toContain('dbtest_fake');
    expect(output).not.toContain('not-a-real-password');
    expect(output).not.toContain('127.0.0.1');
  });
});
