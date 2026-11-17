import { existsSync } from 'node:fs';
import { defineConfig, env } from 'prisma/config';

// Application-level Prisma configuration (Increment B Stage 1 — G4).
// Approved per OQ-B1 (user acceptance 2026-11-17, INCREMENT-B-IMPLEMENTATION-PLAN.md §0).
// All Prisma CLI commands run from `ecommerce-api/`; the Prisma CLI resolves
// `prisma.config.ts` from the current working directory first, so this file
// (paths relative to `ecommerce-api/`) governs app commands. The workspace-root
// `prisma.config.ts` remains only for workspace-root invocations and its final
// disposition is recorded in the Increment B implementation plan.
//
// DATABASE_URL is read from `ecommerce-api/.env` (git-ignored; never committed,
// never logged). Presence-only validation lives in `src/core/config/env.ts`.
if (existsSync('.env')) process.loadEnvFile('.env');

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: env('DATABASE_URL') },
});
