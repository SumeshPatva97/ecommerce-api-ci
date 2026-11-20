import { existsSync } from 'node:fs';

import { defineConfig } from 'prisma/config';

import { resolveMigrationTarget } from './src/core/config/migrationTarget.js';

// Migration-only Prisma configuration (G3).
//
// Used exclusively by commands that write to a database:
//   npx prisma migrate deploy --config prisma.migration.config.ts
//   npx prisma migrate status --config prisma.migration.config.ts
//
// It deliberately does NOT read `.env` or `DATABASE_URL`, so the runtime credential can
// never be used for migrations. Offline commands (`validate`, `format`, `generate`,
// offline `migrate diff`) keep using `prisma.config.ts` and `DATABASE_URL`.
//
// `MIGRATION_DATABASE_URL` and `MIGRATION_EXPECTED_DATABASE` live in
// `ecommerce-api/.env.migration` (git-ignored; see `.env.migration.example`). Values are
// never logged by this file or by the guard it calls.
if (existsSync('.env.migration')) process.loadEnvFile('.env.migration');

const target = resolveMigrationTarget(process.env);

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: target.url },
});
