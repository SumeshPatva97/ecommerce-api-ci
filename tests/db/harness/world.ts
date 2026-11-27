/**
 * DEC-12 — the "world" a real-database scenario runs in: the guard-validated Prisma client for
 * `ecommerce_test`, the REAL application container and the REAL Express app (every module, real
 * middleware, mock payment / shipping / e-mail adapters exactly as in local development).
 *
 * Order of operations in `openWorld()` (fail closed):
 *   1. `resolveDbTestTarget(process.env)` — throws `DbTestGuardError` before anything else runs;
 *   2. `openVerifiedClient(target)`       — connects and requires `SELECT DATABASE()` to be
 *                                           `ecommerce_test`;
 *   3. container + app built on that client.
 *
 * The application configuration is built from the FIXED record below with `loadConfig` (pure).
 * `loadConfigFromProcess` is never called, so no `.env` file is read, and `createDatabase(config)`
 * is never called, so `config.databaseUrl` (a non-connectable placeholder) is never used.
 */
import type { Express } from 'express';

import { createApp } from '../../../src/app.js';
import { createContainer, type AppContainer } from '../../../src/container.js';
import { loadConfig, type AppConfig } from '../../../src/core/config/index.js';
import { Readiness } from '../../../src/core/health/readiness.js';
import { createLogger } from '../../../src/core/logger/logger.js';
import type { PrismaClient } from '../../../src/generated/prisma/client.js';
import { FakeEmailProviderAdapter } from '../../../src/integrations/email/emailProvider.js';
import { MockPaymentProviderAdapter } from '../../../src/integrations/payments/paymentProvider.js';
import { cleanDatabase } from './cleanup.js';
import { openVerifiedClient } from './client.js';
import { resolveDbTestTarget } from './guard.js';
import { resolveIterations } from './options.js';
import { eventually, evidence, sleep } from './race.js';

export const STOREFRONT_ORIGIN = 'http://localhost:5173';
export const ADMIN_ORIGIN = 'http://localhost:5174';

/**
 * Fixed, secret-free application environment. `DATABASE_URL` is required by `loadConfig` but is
 * deliberately NOT a usable connection string: the only database client of the harness is the
 * one built from the guarded `DB_TEST_DATABASE_URL`.
 */
const HARNESS_APP_ENV: Readonly<Record<string, string>> = {
  NODE_ENV: 'test',
  APP_TIMEZONE: 'Asia/Kolkata',
  TZ: 'UTC',
  API_BASE_URL: 'http://localhost:4000',
  STOREFRONT_URL: STOREFRONT_ORIGIN,
  ADMIN_URL: ADMIN_ORIGIN,
  CORS_ORIGINS: `${STOREFRONT_ORIGIN},${ADMIN_ORIGIN}`,
  LOG_LEVEL: 'silent',
  // The scenarios fire bursts of parallel requests on purpose; rate limiting has its own tests.
  RATE_LIMIT_ENABLED: 'false',
  DATABASE_URL: 'harness-placeholder://never-used-as-a-connection-string',
};

const DEFAULT_POOL_SIZE = 40;

export interface DbWorld {
  readonly db: PrismaClient;
  readonly config: AppConfig;
  readonly container: AppContainer;
  readonly app: Express;
  readonly payment: MockPaymentProviderAdapter;
  readonly email: FakeEmailProviderAdapter;
  /** Repetitions per scenario (`DB_TESTS_ITERATIONS`, default 3). */
  readonly iterations: number;
  /** Application time = real time + offset. Moves the offset forward. */
  advanceClock(ms: number): void;
  /**
   * Waits for fire-and-forget writes of the previous iteration (idempotency completion), resets
   * the clock offset and empties every application table of `ecommerce_test` (DML only).
   */
  reset(): Promise<void>;
  /** Final cleanup + disconnect. Safe to call more than once. */
  close(): Promise<void>;
}

export interface WorldOptions {
  /** Connection pool size; must exceed the largest burst (each transaction holds a connection). */
  readonly poolSize?: number;
}

/**
 * Explicit guard call for scenario files: every `*.dbtest.ts` calls this first in `beforeAll`,
 * before `openWorld()` (which runs the same guard again before it builds the client).
 */
export function assertDbTestGuard(): void {
  resolveDbTestTarget(process.env);
}

/**
 * Test timeout that grows with `DB_TESTS_ITERATIONS` (evaluated when the file is collected, after
 * the guard setups have already validated the environment).
 */
export function scenarioTimeout(perIterationMs: number, iterationsRun?: number): number {
  const iterations = iterationsRun ?? resolveIterations(process.env);
  return 60_000 + iterations * perIterationMs;
}

export async function openWorld(options: WorldOptions = {}): Promise<DbWorld> {
  // 1. Guard — before any client exists. Throws DbTestGuardError (names variables only).
  const target = resolveDbTestTarget(process.env);
  const iterations = resolveIterations(process.env);
  const poolSize = options.poolSize ?? DEFAULT_POOL_SIZE;

  // 2. Connect and verify the server-side database name.
  const db = await openVerifiedClient(target, poolSize);

  // 3. Real container + real app on the guarded client.
  let offsetMs = 0;
  const clock = (): Date => new Date(Date.now() + offsetMs);
  const config = loadConfig(HARNESS_APP_ENV);
  const logger = createLogger(config);
  const payment = new MockPaymentProviderAdapter();
  const email = new FakeEmailProviderAdapter();
  const container = createContainer(config, logger, db, { clock, providers: { payment, email } });
  const app = createApp({ config, logger, readiness: new Readiness(), container });

  evidence('HARNESS', { database: target.database, loopback: target.isLoopback, poolSize });

  let closed = false;
  const settle = async (): Promise<void> => {
    // Idempotency rows are completed after the response is sent (fire-and-forget).
    await eventually(
      async () => (await db.idempotencyKey.count({ where: { status: 'IN_PROGRESS' } })) === 0,
      5_000,
    );
    await sleep(200);
  };

  return {
    db,
    config,
    container,
    app,
    payment,
    email,
    iterations,
    advanceClock(ms) {
      offsetMs += ms;
    },
    async reset() {
      await settle();
      offsetMs = 0;
      await cleanDatabase(db);
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await settle();
        await cleanDatabase(db);
      } finally {
        await db.$disconnect();
      }
    },
  };
}
