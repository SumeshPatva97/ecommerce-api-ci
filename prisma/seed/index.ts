/**
 * Reference/system seed — DATABASE_SEEDING_STRATEGY.md §2.1, §3. Order respects FKs:
 * permissions → roles (+ role_permissions) → states → settings. Every step is an idempotent upsert;
 * safe to re-run. Never creates users or passwords (Superadmin: `scripts/create-superadmin.ts`).
 *
 *   npx tsx prisma/seed/index.ts        (reads DATABASE_URL from .env / the environment)
 */
import { pathToFileURL } from 'node:url';

import { loadConfigFromProcess } from '../../src/core/config/index.js';
import type { DbClient } from '../../src/core/db/transaction.js';
import { createDatabase } from '../../src/core/db/prisma.js';
import { createLogger, type Logger } from '../../src/core/logger/logger.js';
import { seedPermissions } from './permissions.seed.js';
import { seedRoles } from './roles.seed.js';
import { seedSettings } from './settings.seed.js';
import { seedStates } from './states.seed.js';

export async function runSeeds(db: DbClient, logger: Pick<Logger, 'info'>): Promise<void> {
  // One transaction per step keeps each step atomic without holding a long transaction.
  const permissions = await db.$transaction((tx) => seedPermissions(tx), { timeout: 60_000 });
  logger.info(permissions, 'seed: permissions');
  const roles = await db.$transaction((tx) => seedRoles(tx), { timeout: 60_000 });
  logger.info(roles, 'seed: roles');
  const states = await db.$transaction((tx) => seedStates(tx), { timeout: 60_000 });
  logger.info(states, 'seed: states');
  const settings = await db.$transaction((tx) => seedSettings(tx), { timeout: 60_000 });
  logger.info(settings, 'seed: settings');
}

async function main(): Promise<void> {
  const config = loadConfigFromProcess();
  const logger = createLogger(config);
  const database = createDatabase(config, logger);
  try {
    await database.connect();
    await runSeeds(database.client, logger);
    logger.info('seed: done');
  } finally {
    await database.disconnect();
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `seed failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
