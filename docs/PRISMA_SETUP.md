# Prisma ORM Setup (B0-b Part 1 offline + B0-b Part 2 migrations)

**Status (2026-11-18):** B0-b Part 1 offline setup complete/verified. Increment A passed live runtime verification (2026-11-17). Increment B Stage 1 is complete offline: the reviewed baseline candidate exists at `prisma/migrations/20261117160425_baseline/migration.sql` and reached **G6 PASS — ACCEPTED** for G7 preparation. **No migration has been applied and no `prisma migrate deploy`/`dev`, `prisma db push` or seed has been run.** Gates **G2** (backup/restore drill) and **G3** (migration user) are **NOT STARTED**; G7 is pending. Migration commands use a separate config and credential — see `docs/INCREMENT-B-G3-MIGRATION-CONNECTION.md`.

## Scope implemented

- Prisma **7.10.1** pinned exactly (`prisma`, `@prisma/client`).
- MySQL/MariaDB driver adapter: `@prisma/adapter-mariadb@7.10.1`.
- `prisma.config.ts` (Prisma 7): schema/migrations paths and datasource URL via `env('DATABASE_URL')`; loads `.env` if present.
- `prisma/schema.prisma`: generator `prisma-client` (output `../src/generated/prisma`, git-ignored), MySQL datasource, **67 models** and **50 enums** from approved Phase 3 design (`project-documentation/12-phase3-database-design/PRISMA_SCHEMA_DESIGN.md`, incl. P3-21).
- `.env.example` placeholder-only `DATABASE_URL`; runtime config validates presence (`src/core/config/env.ts`).
- Runtime scaffolding: `src/core/db/prisma.ts` (`PrismaMariaDb` adapter client factory with connect/disconnect/ping). `src/server.ts` attempts DB connect on startup, registers a `database` readiness check (`SELECT 1`) so `/health/ready` reflects DB availability once configured, and disconnects on shutdown. **Not verified against a live MySQL instance.**
- Offline validation: `prisma format`, `prisma validate`, `prisma generate` (placeholder URL), app format/lint/typecheck/build/tests.

## Prerequisites

- Node.js `>=22.13.0` (per `package.json` engines; verified on Node 24.12.0 / npm 10.4.0 in this environment).
- Dependencies installed (`npm ci` / `npm install`).

## Environment variables

| Variable                      | Purpose                                      | Notes                                                                                                                                                                                                                                      |
| ----------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                | MySQL connection URL for Prisma CLI/runtime  | Runtime/offline identity (`ecommerce_app`, DML only). Set via environment/secret manager; do not commit real credentials. `prisma.config.ts` reads it via `env('DATABASE_URL')`; app config (`src/core/config/env.ts`) validates presence. |
| `MIGRATION_DATABASE_URL`      | MySQL connection URL for migration commands  | Migration-only identity (`ecommerce_migrator`). Read **only** by `prisma.migration.config.ts` from git-ignored `.env.migration`; never added to the runtime config.                                                                        |
| `MIGRATION_EXPECTED_DATABASE` | Exact database the migration URL must target | Fail-closed guard (G7: `ecommerce_migrate_test`; G8: `ecommerce_dev`). Non-secret.                                                                                                                                                         |

Templates: `.env.example` (runtime) and `.env.migration.example` (migration). Save both local files as
UTF-8 **without BOM** — a BOM becomes part of the first variable name and the value will not load.

## Commands (offline-safe)

Run from `ecommerce-api/` with a placeholder `DATABASE_URL` set (no DB required for these checks):

```bash
# format & validate schema
DATABASE_URL="mysql://user:password@localhost:3306/ecommerce_dev" npx prisma validate
DATABASE_URL="mysql://user:password@localhost:3306/ecommerce_dev" npx prisma format

# generate client to src/generated/prisma (optional; output is git-ignored)
DATABASE_URL="mysql://user:password@localhost:3306/ecommerce_dev" npx prisma generate
```

Windows PowerShell:

```powershell
$env:DATABASE_URL='mysql://user:password@localhost:3306/ecommerce_dev'; npx prisma validate
```

## Runtime client (live-verified 2026-11-17)

Implemented in `src/core/db/prisma.ts` (Prisma 7 + `@prisma/adapter-mariadb`) and wired in `src/server.ts` (connect attempt, readiness ping, graceful disconnect). Example shape:

```ts
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../generated/prisma/client.js';

export const prisma = new PrismaClient({ adapter: new PrismaMariaDb(config.databaseUrl) });
```

## Migration configuration (G3)

Two configs, two identities:

| File                         | Commands                                                 | Credential               |
| ---------------------------- | -------------------------------------------------------- | ------------------------ |
| `prisma.config.ts`           | `validate`, `format`, `generate`, offline `migrate diff` | `DATABASE_URL`           |
| `prisma.migration.config.ts` | `migrate deploy`, `migrate status`, `migrate resolve`    | `MIGRATION_DATABASE_URL` |

The migration config does not load `.env` and does not read `DATABASE_URL`; there is no fallback.
`src/core/config/migrationTarget.ts` enforces presence, scheme, a single database name, refusal of
MySQL system schemas, exact equality with `MIGRATION_EXPECTED_DATABASE`, and difference from
`DATABASE_URL`. Details and the user-managed G3 steps: `docs/INCREMENT-B-G3-MIGRATION-CONNECTION.md`.

**Target ≠ privilege.** The configured expected database name is a guard only. The G3
`ecommerce_dev.*` grant does not authorize `ecommerce_migrate_test`. G7 requires a temporary,
scratch-scoped grant on `ecommerce_migrate_test.*`; G8 uses the `ecommerce_dev.*` grant and requires
switching both the URL path and `MIGRATION_EXPECTED_DATABASE` to `ecommerce_dev` (G3 doc §4.8).

Approved workflow (OQ-B2, Option B): offline `migrate diff --from-empty` → human review of the full
SQL → controlled `migrate deploy`. No shadow database; `migrate dev`/`db push` are not used.

## Current state (2026-11-18)

Verified offline:

- 67 models / 50 enums; schema valid; generated client (git-ignored).
- Baseline candidate `prisma/migrations/20261117160425_baseline/migration.sql` — 1943 lines, 67
  `CREATE TABLE`, 114 FKs all `ON UPDATE RESTRICT`, 75 CHECKs, SQL-only constraints; **G6 PASS —
  ACCEPTED** for G7 preparation.
- `npm run typecheck`, `lint`, `format:check`, `build`, `npm test` (10 files, 193 tests) pass.

Pending (gated — user actions and separate approvals):

- **G2** backup/restore drill (user-executed; `docs/INCREMENT-B-G2-BACKUP-RESTORE-DRILL.md`).
- **G3** create `ecommerce_migrator@localhost` with the `ecommerce_dev.*` grant (for G8) and create
  `.env.migration` targeting `ecommerce_migrate_test` for G7 (user). G3 does not include scratch
  privileges.
- **G7** dry-run on the user-created, empty `ecommerce_migrate_test` with a temporary scratch-scoped
  grant (separate authorization).
- **G8** revoke the scratch grant, switch the migration target to `ecommerce_dev`, fresh backup, then
  live baseline apply (separate authorization).
- Idempotent seeds, DB integration/migration tests, backup/restore evidence.

No migration has been generated for execution beyond the reviewed candidate, applied, or run against
any database. `prisma db push` is not used. `src/generated/` is git-ignored and not committed.
