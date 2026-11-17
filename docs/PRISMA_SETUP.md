# Prisma ORM Setup (B0-b Part 1 offline + B0-b Part 2 scaffolding)

**Status (2026-11-17):** B0-b Part 1 offline setup complete/verified. B0-b Part 2 **blocked** in this environment because local MySQL 8 is not installed/configured (installation requires admin/UAC and secure configuration; not completed). **No live MySQL connection established, no migrations generated/applied, no `prisma db push`, no SQL executed against a database, no seeds run.**

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

| Variable       | Purpose                                     | Notes                                                                                                                                                                                                                                                                                    |
| -------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL` | MySQL connection URL for Prisma CLI/runtime | **Placeholder only in B0-b Part 1.** Example: `mysql://user:password@localhost:3306/ecommerce_dev`. Set via environment/secret manager; do not commit real credentials. `prisma.config.ts` reads it via `env('DATABASE_URL')`; app config (`src/core/config/env.ts`) validates presence. |

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

## Runtime client (scaffolded; live verification pending)

Implemented in `src/core/db/prisma.ts` (Prisma 7 + `@prisma/adapter-mariadb`) and wired in `src/server.ts` (connect attempt, readiness ping, graceful disconnect). Example shape:

```ts
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../generated/prisma/client.js';

export const prisma = new PrismaClient({ adapter: new PrismaMariaDb(config.databaseUrl) });
```

**B0-b Part 2 still required:** install/configure local MySQL 8 (admin/UAC), create `ecommerce_dev` + least-privilege localhost app user, set `DATABASE_URL` in ignored `.env` (never committed), generate/review/apply baseline migrations including all Phase 3 SQL-only constraints/indexes, verify DB objects, implement/run idempotent seeds and repeatability tests, and execute/verify backup-recovery procedure. `prisma db push` is not used.

## Not done / blocked (B0-b Part 2)

- No MySQL 8 installed/configured in this environment; no local `ecommerce_dev` database/user created; no live DB connection verified.
- No migration files generated/applied, no `prisma migrate dev/deploy`, no `prisma db push`, no SQL executed against a database.
- SQL-only constraints/indexes from Phase 3 not yet implemented in migration SQL or verified on DB.
- No idempotent seed implementation/execution/repeatability verification.
- No DB integration/migration/seed-repeatability tests against MySQL; backup/restore not executed/verified.
- Generated client (`src/generated/`) is git-ignored and not committed.
- No business/auth APIs, no frontend, B0-c/B1–B9 incomplete. No code pushed.
