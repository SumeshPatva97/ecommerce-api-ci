/**
 * DEC-12 — real Prisma client for `ecommerce_test`, built ONLY from a guard-validated target.
 *
 * Mirrors `src/core/db/prisma.ts` (MariaDB driver adapter, parsed pool config, public-key retrieval
 * on loopback only) but never reads `DATABASE_URL` / `AppConfig.databaseUrl`. Constructing the
 * client does not connect; the first query does. `openVerifiedClient` runs one read-only query
 * (`SELECT DATABASE()`) and refuses to continue unless the SERVER reports `ecommerce_test`.
 */
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import type { PoolConfig } from 'mariadb';

import { PrismaClient } from '../../../src/generated/prisma/client.js';
import { DbTestGuardError, REQUIRED_DATABASE, type DbTestTarget } from './guard.js';

export function createTestPrismaClient(target: DbTestTarget, poolSize: number): PrismaClient {
  const pool: PoolConfig & { allowPublicKeyRetrieval?: boolean } = {
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: target.database,
    connectionLimit: poolSize,
  };
  if (target.isLoopback) pool.allowPublicKeyRetrieval = true;
  return new PrismaClient({ adapter: new PrismaMariaDb(pool), log: [] });
}

/** Server-side check: the connection's current database must be exactly `ecommerce_test`. */
export async function assertServerDatabase(db: PrismaClient): Promise<void> {
  const rows = await db.$queryRaw<{ db: string | null }[]>`SELECT DATABASE() AS db`;
  if (rows[0]?.db !== REQUIRED_DATABASE) {
    throw new DbTestGuardError(`the server reports a current database other than "${REQUIRED_DATABASE}".`);
  }
}

export async function openVerifiedClient(
  target: DbTestTarget,
  poolSize: number,
): Promise<PrismaClient> {
  const db = createTestPrismaClient(target, poolSize);
  try {
    await db.$connect();
    await assertServerDatabase(db);
    return db;
  } catch (error) {
    await db.$disconnect().catch(() => undefined);
    throw error;
  }
}
