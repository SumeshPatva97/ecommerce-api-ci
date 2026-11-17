# ecommerce-api

REST API for the jewellery e-commerce platform. This is one of three independent repositories:

| Repository                      | Role                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| `ecommerce-storefront`          | React customer website. Talks to this API over REST only.                                  |
| `ecommerce-admin`               | React admin panel. Talks to this API over REST only.                                       |
| **`ecommerce-api`** (this repo) | Node.js + Express REST API. **The only component that connects to MySQL**, through Prisma. |

Canonical documentation lives in `project-documentation/` (sibling folder). The most relevant files:
`01-requirements/PROJECT_CONTEXT.md` (canonical names, error codes, routes),
`04-backend/BACKEND_STRUCTURE.md` (architecture), `04-backend/API_DOCUMENTATION.md` (contracts),
`09-deployment/REPOSITORY_SETUP_GUIDE.md` (setup), `12-phase3-database-design/` (approved DB design).

## Status

**Phase 4 in progress — NOT YET APPROVED (Gate G4 not met).** B0-a: **APPROVED AND COMPLETE (2026-11-16)**. B0-b Part 1: **complete for authorized offline scope** (Prisma 7.10.1, 67 models/50 enums, schema/config validated; no DB connection/migrations/SQL). B0-b Part 2: **pending/unverified** — MySQL 8.4.9 installed and `MySQL84` service **Running/Automatic** with localhost:3306 reachable (verified 2026-11-17), but local `ecommerce_dev`/`ecommerce_app`, ignored `.env` `DATABASE_URL`/secret protection, Prisma runtime connectivity, reviewed migrations, approved SQL-only constraints/indexes, seeds/repeatability, DB integration/migration tests, and backup/restore verification are **not yet completed/verified** (runtime DB client/readiness scaffolding added: `src/core/db/prisma.ts`, server wiring). B0-c: **partial scaffold only** (CI/Dockerfile/OpenAPI stub, provider adapter interfaces+mocks, jobs/ops/security docs). B1–B9: **not implemented**.

**Not built yet / not verified:** live MySQL setup, applied migrations/SQL-only constraints, seeds, DB integration, business modules and documented endpoints, OpenAPI aligned to implementation, production provider integrations, full acceptance/security verification. No Phase 4 approval claimed. No code pushed. See `docs/PHASE4-G4-REVIEW-REPORT.md` and B0-b reports.

## Requirements

| Tool    | Version                                                                         |
| ------- | ------------------------------------------------------------------------------- |
| Node.js | 22 LTS (`.nvmrc`; minimum 22.13). Tests so far ran on Node 24.22 only (OQ-110). |
| npm     | 10+ (repository uses `package-lock.json`; use `npm ci`)                         |

MySQL and Redis are **not** needed for this increment. When the database increment starts, MySQL 8
is installed **natively** on development laptops (decision D-37; no Docker Desktop just for MySQL).

## Getting started

```bash
npm ci                      # install exact locked dependencies
cp .env.example .env        # local settings; .env is git-ignored
npm run dev                 # http://localhost:4000 with reload
```

Check that it is running:

```bash
curl http://localhost:4000/health/live     # {"status":"ok"}
curl http://localhost:4000/health/ready    # {"status":"ready","checks":{}}
```

If a required variable is missing or invalid, the process exits immediately and prints the
variable names and the problem (values are never printed).

## Scripts

| Script                                   | What it does                                            |
| ---------------------------------------- | ------------------------------------------------------- |
| `npm run dev`                            | Start the API with reload (`tsx watch`)                 |
| `npm run build`                          | Compile TypeScript to `dist/`                           |
| `npm start`                              | Run the compiled API (`node dist/server.js`)            |
| `npm test`                               | Run all tests once (Vitest)                             |
| `npm run test:unit` / `test:integration` | Run one test layer                                      |
| `npm run test:coverage`                  | Tests with coverage (floors: 80 % lines, 75 % branches) |
| `npm run typecheck`                      | `tsc --noEmit`                                          |
| `npm run lint` / `lint:fix`              | ESLint (`--max-warnings 0`)                             |
| `npm run format` / `format:check`        | Prettier                                                |

## Environment variables

See [.env.example](.env.example). Variables used by the current code are declared and validated in
[src/core/config/env.ts](src/core/config/env.ts). `DATABASE_URL` is included as a **placeholder
only** for Prisma configuration (B0-b Part 1) — no database connection is made in this increment.
Rules:

- Never commit `.env` or real secrets. Staging and production values come from the hosting secret
  manager.
- `TZ` must be `UTC` (stored timestamps), and `APP_TIMEZONE` must be `Asia/Kolkata` (business days).
- In `staging` and `production`, URLs and CORS origins must be `https`, rate limiting cannot be
  disabled, and pretty logs are rejected.
- `CORS_ORIGINS` must contain the origins of both `STOREFRONT_URL` and `ADMIN_URL`, and the two must
  differ. `/api/v1/admin/*` accepts only the admin origin; every other route accepts only the other
  listed origins (PROJECT_CONTEXT R-46). The admin prefix is matched case-insensitively, like
  Express routing, so `/API/V1/ADMIN/...` is treated as an admin route.
- Cross-field rules (distinct origins, allow-listing, the staging/production rules) are checked
  only after every variable passes its own validation, so an invalid URL is always reported by
  variable name (`ADMIN_URL: Must be an absolute http(s) URL.`).
- Variable names follow REPOSITORY_SETUP_GUIDE.md §9.1 (canonical per R-46). A new variable must be
  added to `.env.example`, the Zod schema, and §9.1 in the same change.

## Endpoints available now

| Method | Path            | Notes                                                                                                                                                                 |
| ------ | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/health/live`  | Liveness. `200 {"status":"ok"}`. No dependency checks.                                                                                                                |
| GET    | `/health/ready` | Readiness. `200 {"status":"ready","checks":{…}}` or `503 {"status":"not_ready",…}` (also during shutdown). DB/Redis checks are registered when those increments land. |
| *      | `/api/v1/*`     | Versioned API mount point. No business routes yet. Unknown routes return the canonical `404 NOT_FOUND` envelope.                                                      |

Health endpoints sit outside `/api/v1`, as PROJECT_CONTEXT §8 specifies. They have no auth, no rate limit,
and no access logging.

## Project structure

```text
src/
  app.ts                  # builds the Express app (no listen); fixed middleware order
  server.ts               # entrypoint: config → logger → app → start server → shutdown wiring
  core/
    config/               # env.ts (Zod schema, pure loadConfig) · index.ts (.env loading)
    errors/               # canonical error codes → HTTP status · AppError
    health/               # readiness registry · /health routes
    lifecycle/            # startHttpServer (startup errors via 'error' event) · graceful shutdown
    http/                 # response envelopes · pagination helpers
    logger/               # pino logger with redaction · AsyncLocalStorage request context
    middleware/           # requestId, accessLog, security, cors, rateLimit, bodyParsers,
                          # validate, notFound, errorHandler
  lib/                    # pure helpers (ulid)
  routes/v1.ts            # /api/v1 router; feature modules register here
  types/express.d.ts      # Request augmentation (requestId, validated)
tests/
  unit/                   # pure functions (config, errors, pagination, ids, readiness)
  integration/            # Supertest through the full pipeline; server lifecycle & shutdown
  helpers/                # test config / app builder
```

This layout follows BACKEND_STRUCTURE.md §3 (canonical per PROJECT_CONTEXT R-45). Feature modules
will live in `src/modules/<module>/` using the documented anatomy
(`routes → controller → service → repository`, plus `schemas` and `mapper`).

## Request pipeline

`requestId → access log → security headers (helmet) + no-store → /health → CORS → rate limit
(/api/v1) → JSON-only body parser → v1 routes → 404 → error handler`

Responses always use the canonical envelopes:

```json
{ "success": true, "data": {}, "meta": {}, "requestId": "req_…" }
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "…", "details": [] }, "requestId": "req_…" }
```

## Conventions

- TypeScript `strict`, ESM, relative imports with `.js` extensions.
- Errors: throw `AppError('<CANONICAL_CODE>', 'User-safe message', { details })`. Never return stack
  traces or internal messages.
- Validation: `validate({ params, query, body })` with Zod schemas. Use `z.strictObject` for admin
  and security-sensitive bodies so unknown keys are rejected.
- Logging: use the pino logger, never `console.*`. Do not log request bodies, tokens, or passwords.
  Log IDs and selected fields, not whole objects.
- Redaction (`src/core/logger/logger.ts`): `Authorization`, `Cookie` and `Set-Cookie` headers, and
  the keys `password`, `newPassword`, `currentPassword`, `passwordHash`, `token`, `accessToken`,
  `refreshToken`, `otp`, `signature`, `cardNumber`, `cvv`, `apiKey`, `secret` are replaced by
  `[REDACTED]` **at the root, one level and two levels below the root of a logged object** (an
  array index counts as one level). The same keys **three or more levels deep are not redacted**,
  and matching is exact and case-sensitive (`Password` is not matched).
- Money will use Decimal (never `number`/`parseFloat`) once the pricing modules arrive.

## Startup and shutdown

- Startup failures such as `EADDRINUSE` or `EACCES` come from the HTTP server's `error` event. They
  are logged at `fatal` and the process exits with code 1.
- On `SIGTERM`/`SIGINT` the API marks itself not ready (`/health/ready` → 503), stops accepting
  connections, lets in-flight requests finish (closing idle keep-alive connections as soon as they
  free up), and exits 0. Hanging connections are closed after 25 s; the process is forced to exit
  with code 1 after 30 s. An unhandled rejection or uncaught exception triggers the same shutdown
  with exit code 1.
- **Windows limitation:** Windows cannot deliver `SIGTERM`/`SIGINT` to another process. Sending one
  (for example from Git Bash or `child.kill()`) terminates the process immediately and the shutdown
  handler does not run. The shutdown logic is therefore verified with simulated signals in
  `tests/integration/lifecycle.test.ts`. Real signal delivery must still be verified on Linux (CI or
  staging). According to the Node.js documentation, Ctrl+C in an interactive Windows console does
  raise `SIGINT`; this has not been tested here.

## Known limitations and tracked items

| Item                           | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **In-memory rate limiter**     | One local instance only. It is **not suitable for multi-instance production**: each instance keeps its own counters, so the effective limit multiplies by the number of instances, and counters reset on restart. Redis is deferred for local development (D-38); it must be decided (OQ-35) before any production or multi-instance deployment that needs shared limits. Route-class limits (auth, checkout, admin) are not implemented yet; their values are open (OQ-109).                                                                                                                                                                                                        |
| **`X-API-Version` header**     | Required by the API contract (API_DOCUMENTATION §2.1; read from `/health/ready` by the release pipeline). **Not emitted yet**: its value is the OpenAPI `info.version`, which depends on OQ-49. Already in the CORS exposed-header list.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Unsupported `Content-Type`** | Returns **400 `BAD_REQUEST`**. SECURITY_GUIDELINES §5 says "415 → mapped to BAD_REQUEST", and the canonical table (PROJECT_CONTEXT §8) defines `BAD_REQUEST` as 400 with no 415 code. Changing this needs a canonical decision (OQ-106).                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Real-signal shutdown**       | Not verifiable on Windows (see above).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **`npm audit` (dev only)**     | **8 moderate** advisories (`npm audit` exits 1), one root cause: `minimatch` "potential denial of service via globparts amplification" (GHSA-g3hv-75wg-m249), reached through `eslint` ≤ 10.14.0 and `typescript-eslint` ≤ 8.72.2 (6 `@typescript-eslint/*` packages). Production dependencies (`--omit=dev`): 0. No high/critical (`--audit-level=high` passes). ESLint's part is fixed in 10.15.0 (released 2026-11-13, not yet adopted under the 2-week version-age rule); typescript-eslint has **no fixed release**, and `npm audit fix --force` would downgrade it to 8.36.0 (breaking), so it is not applied. Re-check weekly. Exposure: lint tooling only, on our own files. |
