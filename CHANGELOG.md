# Changelog — ecommerce-api

All notable changes to this repository are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · Versioning: [SemVer](https://semver.org/).

## [Unreleased]

### Status — G2/G3 preparation and G3 migration configuration (2026-11-18)

- **G6:** **PASS — ACCEPTED (2026-11-17)** preserved. **Increment B IN PROGRESS; Phase 4 IN PROGRESS — NOT APPROVED.**
- **G3 configuration (offline only):** added `prisma.migration.config.ts` (database-writing commands), `src/core/config/migrationTarget.ts` (fail-closed target guard), `.env.migration.example`, `db:migrate:status`/`db:migrate:deploy` scripts, and 16 guard tests (**10 files / 193 tests** pass). **No MySQL connection, no migration executed.** Gate **G3 remains NOT STARTED** — `ecommerce_migrator@localhost`, grants and `.env.migration` are user-managed.
- **G2 procedure:** `docs/INCREMENT-B-G2-BACKUP-RESTORE-DRILL.md` — single-schema dump **without `--databases`** (prevents a restore from targeting the source), `--routines --events --triggers`, guard scan, SHA-256, restore into `ecommerce_restore_check`, PowerShell 5.1-compatible. Gate **G2 remains NOT STARTED** (user-executed).
- **G7 readiness:** **NOT READY** — blocked by G2/G3 acceptance (evidence checklist empty), the user-created and verified-empty `ecommerce_migrate_test`, the temporary scratch grant, independent baseline-hash confirmation, and explicit authorization (`docs/INCREMENT-B-G7-READINESS-REVIEW.md`).
- **G2/G3 safety review (2026-11-18):** G2 procedure re-checked for PowerShell 5.1 and MySQL 8.4 correctness (positional single-schema dump, explicit `$restoreDb`, scratch pre-check, source-unchanged check, expanded abort list); G3 config verified against the documentation; guard protocol message corrected to state that `mariadb://` is also accepted. Added `docs/INCREMENT-B-G2-G3-EVIDENCE-CHECKLIST.md` (P4-B-EVID-01) and `docs/ENV-BOM-REMEDIATION.md` (P4-ENV-01). G7 prerequisites expanded to ten criteria.
- **BOM recheck:** a byte-level check found **no BOM** in the current `.env` (80 bytes); the remediation procedure is retained for recurrence and for `.env.migration`. The file was not read beyond its first bytes and was not modified.
- **Scratch-grant recommendation:** temporary, database-scoped grant on `ecommerce_migrate_test.*` for `ecommerce_migrator`, verified before G7 and revoked afterwards; no `*.*`, no global privilege, no change to `ecommerce_app`.
- **G3/G7 target–grant consistency correction (2026-11-18):** the G3 `ecommerce_dev.*` grant and the G7 `ecommerce_migrate_test` target are now explicitly separated in every document. A dev-scoped grant confers no scratch privileges, and `MIGRATION_EXPECTED_DATABASE` is a name guard only. G3 evidence excludes the scratch grant; G7 has its own preflight evidence (scratch DB exists/empty, scratch grant, hash, authorization); a documented target switch (URL path + expected name) is required between G7 and G8. Also corrected the planning document's remaining `mysqldump --databases` snippet and the risk note that implied migrations use `DATABASE_URL`.
- **CI:** workflow paths corrected because `ecommerce-api` is the repository root (removed the `ecommerce-api/` prefix from `working-directory`, `.nvmrc` and cache path).
- **Local environment finding:** the 2026-11-18 audit initially reported a UTF-8 BOM in the local `ecommerce-api/.env`; a byte-level recheck during the G2/G3 safety review found **no BOM** (80 bytes). The file was never read beyond its first bytes and was not modified. The remediation procedure for recurrence (and for `.env.migration`) is in `docs/ENV-BOM-REMEDIATION.md`.
- **Secrets:** `.env` content never read/printed; `.env.migration` is git-ignored; only placeholder examples are tracked.
- **Repository:** published to `https://github.com/SumeshPatva97/ecommerce-api-ci` (branch `main`, commit `baa5620`) after the 2026-11-17 entry below. No Git operation was performed in this update.

### Status — Phase 4 autonomous verification and planning (2026-11-18)

- **G3 read-only checks (actual):** `MySQL84` = Running/Automatic; TCP 3306 listening on `[::]:3306`; client `mysql.exe 8.4.9`; baseline SHA-256 matches `154D2C8E…7A6BB`; `.env` 80 bytes, no BOM; `.env.migration` absent; no saved MySQL login path. Offline suite: format/lint/typecheck/build exit 0; **10 files / 193 tests pass**; `prisma validate` PASS; migration `prisma validate --config` PASS; mismatch, system-schema and missing-URL cases all fail closed (exit 1).
- **G3 steps 3–7 remain USER ACTION:** no credential-free admin login exists; a read-only capture script (SELECT/SHOW only, hash-redacting) was prepared outside the repo. **No SQL, user, grant or database change was executed.**
- **G2 procedure gap fixed:** added a dump **completeness-marker** check (final `-- Dump completed` line) and evidence row **G2-19**, so a truncated dump cannot pass on size alone. G2 still **NOT STARTED**.
- **New planning documents:** `docs/PHASE4-B1-B9-DECISION-REGISTER.md` (P4-DEC-01 — the 12 open questions and 3 confirmations from `PROJECT_CONTEXT.md` §17.3, with documented working assumptions only, no decisions made) and `docs/PHASE4-BLOCKER-REGISTER-AND-ROADMAP.md` (P4-ROAD-01 — live blockers, G3 step status, G4 completion-criteria gap and dependency-ordered roadmap).
- **Unchanged:** G6 PASS — ACCEPTED; G2/G3 USER EXECUTION PENDING; G7 NOT READY — NOT AUTHORIZED; Increment B IN PROGRESS; Phase 4 IN PROGRESS — NOT APPROVED; B1–B9 NOT STARTED; 0 of 80 business endpoints implemented.

### Status — Phase 4 progress update (2026-11-17)

- **Phase 3:** final verification audit completed (documentation consistent; **APPROVED AND COMPLETE — 2026-11-13** unchanged). Report: `project-documentation/12-phase3-database-design/PHASE3_FINAL_VERIFICATION_REPORT.md`.
- **B0-b Part 1 (offline):** complete/verified as previously recorded (Prisma 7.10.1, 67 models/50 enums, schema valid, offline checks/tests pass; no DB/migrations/SQL).
- **B0-b Part 2:** **in progress, pending/unverified** — MySQL 8.4.9 is installed and `MySQL84` service is **Running/Automatic** with localhost:3306 reachable (verified 2026-11-17; binaries present, `mysql` CLI not in PATH). Local `ecommerce_dev`/`ecommerce_app`, ignored `.env` `DATABASE_URL` (secret-protected), Prisma runtime connectivity, reviewed/applied baseline migrations, approved SQL-only constraints/indexes, seeds/repeatability, DB integration/migration tests, and backup/restore verification are **not yet completed/verified**. Runtime scaffolding added: `src/core/db/prisma.ts` and server DB readiness/connect/shutdown wiring; `prisma generate` (placeholder URL) succeeded (generated client git-ignored). **No live MySQL connection verified, no migrations/SQL applied, no seeds, no DB verification.** Reports: `docs/B0-b-PART2-IMPLEMENTATION-REPORT.md`, `docs/PHASE4-G4-REVIEW-REPORT.md`.
- **B0-c:** partial scaffolds added (CI workflow, Dockerfile, OpenAPI stub, provider adapter interfaces+safe mocks for payment/media/email/WhatsApp, jobs architecture note, ops/security docs). **Not complete/aligned to implementation.**
- **B1–B9:** not implemented (0 documented business endpoints). Canonical contract unchanged (`project-documentation/04-backend/API_DOCUMENTATION.md`).
- **Quality gates (current):** `format:check`, `lint`, `typecheck`, `build`, `npm test` **PASS** (9 files, 177/177). `prisma validate` **PASS** (offline). DB-backed/migration/acceptance tests pending/blocked.
- **Restrictions:** no Phase 4/G4 approval claimed; no Phase 5/frontend; no `prisma db push`/unreviewed SQL/DB execution; no production DB; no real credentials committed; no git commit/push/branch changes. See `docs/PHASE4-G4-REVIEW-REPORT.md`.

### Status — B0-a APPROVED AND COMPLETE (2026-11-16)

- Client final approval of increment B0-a (backend foundation). Final verification: format,
  ESLint (0 warnings), typecheck and build passed; 177/177 tests; coverage 97.98 % lines /
  87.81 % branches; `npm audit` 8 moderate dev-only advisories, 0 production. Not yet committed —
  the initial commit is made only on explicit client instruction.

### Changed — logger redaction policy expanded (2026-11-16, client-approved)

- `src/core/logger/logger.ts`: every documented sensitive key (`password`, `newPassword`,
  `currentPassword`, `passwordHash`, `token`, `accessToken`, `refreshToken`, `otp`, `signature`,
  `cardNumber`, `cvv`, `apiKey`, `secret`) is now redacted at the **root**, **one level** and
  **two levels** below the root (previously one level only). Header redaction (`Authorization`,
  `Cookie`, `Set-Cookie`) unchanged. Paths are generated from `SENSITIVE_KEYS` /
  `HEADER_REDACT_PATHS` (42 paths: 3 header + 13 keys × 3 depths).
- Limitation (documented and tested): keys three or more levels deep are not redacted — pino has
  no recursive wildcard; matching is exact and case-sensitive.
- Tests: `tests/unit/core/logger.test.ts` rewritten — 63 tests (each key at root / one / two
  levels, arrays, headers, mixed records with safe siblings, no mutation of the logged object,
  null/non-object parents, documented depth-3 and case limitations). A mutation check
  (temporarily restoring the one-level policy) made 30 of them fail.

### Fixed — B0-a final-review defects D1/D2 (2026-11-16, client-authorized)

- **D1 — CORS route family was case-sensitive** (`src/core/middleware/cors.ts`). Express routing is
  case-insensitive, so `/API/V1/ADMIN/...` or `/api/v1/Admin/...` reached admin routes while the
  CORS check classified them as customer routes, letting the storefront origin through. Admin
  detection (`isAdminRoutePath`) now lower-cases the path. Allowlist, CORS headers and middleware
  order unchanged.
- **D2 — invalid `STOREFRONT_URL` / `ADMIN_URL` threw `TypeError: Invalid URL`** instead of
  `ConfigError` (`src/core/config/env.ts`). Cross-field rules (distinct origins, CORS allow-listing,
  https/rate-limit/pretty-log rules outside development) now run only after all fields pass
  field-level validation, using a non-throwing origin helper. Invalid URLs are reported as
  `<VARIABLE>: Must be an absolute http(s) URL.` without echoing the value.

### Added — tests (2026-11-16)

- D1: 14 integration cases (lowercase/uppercase/mixed-case admin paths and bare prefix for both
  origins, uppercase preflight, customer routes still rejecting the admin origin). A mutation
  check (temporarily restoring the old comparison) made 8 of them fail.
- D2: 7 unit cases (each URL invalid, both invalid, combined with other invalid fields, valid URLs
  still enforce distinct origins and allow-listing).
- Logger: unit tests for every documented redaction path, Authorization/Cookie/Set-Cookie headers,
  requestId context and level; integration tests proving the access log contains no headers,
  cookies, query strings or bodies. `createLogger` gained an optional `destination` stream (test
  seam; default output unchanged).

### Fixed — B0-a review corrections (2026-11-16)

- **Startup errors:** the HTTP server is created with `node:http` and startup failures
  (`EADDRINUSE`, `EACCES`, …) are taken from the server's `error` event, not from the listen
  callback (`src/core/lifecycle/httpServer.ts`). Verified with a real process: port in use →
  `fatal` log + exit code 1.
- **Graceful shutdown:** idle keep-alive connections are now closed as soon as their in-flight
  request finishes (previously shutdown waited for the full 25 s drain timeout). Shutdown logic
  moved to `registerGracefulShutdown` and covered by simulated-signal tests; Windows cannot
  deliver real signals (documented in README).
- **CORS route families:** the admin origin is now rejected on customer/public routes
  (CROSS_APPLICATION_INTEGRATION §3.2, SECURITY_GUIDELINES §12, AUTHENTICATION_AUTHORIZATION
  §16.3). Allowed/exposed header lists now match CROSS_APPLICATION_INTEGRATION §3.2 exactly
  (adds `If-None-Match`; `ETag`, `Deprecation`, `Sunset`, `Link`, `X-API-Version`).
- **Config:** `CORS_ORIGINS` must include the origins of `STOREFRONT_URL` and `ADMIN_URL`, which
  must differ.

### Documented

- Unsupported `Content-Type` stays **400 `BAD_REQUEST`** per the canonical code table (OQ-106).
- In-memory rate limiter is not suitable for multi-instance production (D-38, OQ-35).
- `X-API-Version` header tracked, not yet emitted (depends on OQ-49).
- Dev-only `npm audit` moderate advisories (minimatch via ESLint tooling).

### Added — Phase 4, increment B0-a "Backend foundation" (2026-11-16)

- Node.js + TypeScript (ESM) project with Express 5; npm with a committed lockfile.
- Zod-validated environment configuration with fail-fast boot (`src/core/config`).
- Middleware pipeline per BACKEND_STRUCTURE.md §5: request ID (`req_<ULID>`, AsyncLocalStorage),
  structured pino access log with redaction, helmet security headers, `Cache-Control: no-store`
  default, exact-origin CORS allowlist, general per-IP rate limit (in-memory), JSON-only body
  parsing with size limit.
- Canonical response envelopes and error codes; centralized error handler (no stack/internal
  message leakage); Zod `validate()` middleware; pagination helpers (defaults 30/25, max 100).
- `GET /health/live`, `GET /health/ready` (readiness registry; graceful shutdown).
- `/api/v1` versioned router mount point (no business routes yet).
- Vitest + Supertest test setup (unit + integration), ESLint (typescript-eslint strict), Prettier,
  EditorConfig.

### Not included (by instruction)

- No Prisma, no database connection, no migrations, no business modules.
