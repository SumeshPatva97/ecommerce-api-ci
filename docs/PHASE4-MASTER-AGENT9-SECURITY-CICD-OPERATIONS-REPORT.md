# Phase 4 — Agent 9: Security, CI/CD and Operations — Report

| Field         | Value                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Document ID   | P4-MASTER-AGENT9                                                                                                                     |
| Date          | 2026-11-24                                                                                                                           |
| Scope         | Documentation only. Three operations documents brought up to date with verified evidence. No source, test, config or workflow change |
| Evidence type | Code reading and existing tests run offline with a mocked database. No database, external service, CI run or deployment              |
| Status        | Complete for the assigned scope. The security self-assessment stays **DRAFT — for owner review**                                     |

**Not claimed:** penetration testing, certification, production readiness, a CI run or a staging
deployment. None exists.

## 1. Result in brief

- The G4 security self-assessment draft now assesses **142 controls in 16 areas**, each with one
  result and named evidence: 71 TESTED, 15 CODE-VERIFIED, 9 DOCUMENTED, 4 PREPARED, 14 BLOCKED,
  12 USER-DEPENDENT, 17 GAP.
- **No open S1 / S2 defect was identified in the Phase 4 scope.** This depends on the owner's
  reading of one finding (A9-F02, §6.1).
- Defects DF-01, DF-02 and DF-03 are recorded as fixed. The draft no longer lists DF-02 as open.
- Nine statements in the earlier drafts were wrong, stale or incomplete and were corrected with dated notes (§5).
- Seven new findings were recorded (A9-F01 … A9-F07), all proposed S3 / S4 except A9-F02.

## 2. What was verified, and how

**Method.**

1. Each statement in the three documents was compared with the file it describes.
2. Each control in the assessment was traced to source code, and to a test where one exists.
3. The named test files were run with `npx vitest run <files>` on Node 24.12.0, in two groups.

**Tests run by this agent.** 58 test files, 2,152 tests, all passed. This is not the full suite.

| Group | Files | Tests | Content                                                                                                                                                                                  |
| ----- | ----- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | 30    | 1,746 | Notifications rendering, jobs registry and scheduler, route × role matrix, auth, config, worker, logger, payments, security primitives, audit, media, stock, coupons, cart races, health |
| 2     | 28    | 406   | Staff, cart, addresses, orders, wishlist, MFA, notifications routes, reconciliation, payments units, refunds, shipping branches, readiness, migration target                             |

`tests/integration/routeRoleMatrix.test.ts` was also run alone to confirm its size: 1,113 cases.

**Source files read (main ones).**

| Area                    | Files                                                                                                                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration           | `src/core/config/env.ts`, `src/core/config/index.ts`, `src/core/config/migrationTarget.ts`, `prisma.config.ts`, `prisma.migration.config.ts`                                                          |
| Processes               | `src/server.ts`, `src/worker.ts`, `src/workerRuntime.ts`, `src/bootstrap.ts`, `src/core/lifecycle/*`, `src/core/health/*`                                                                             |
| Jobs                    | `src/jobs/scheduler.ts`, `src/jobs/registry.ts`, `src/jobs/tokenCleanup.ts`, `src/jobs/notificationDispatcher.ts`, `src/jobs/abandonedCarts.ts`                                                       |
| Authentication          | `src/core/security/{jwt,tokens,password,fieldCipher}.ts`, `src/core/middleware/auth.ts`, `src/modules/auth/{session.service,password.service,auth.context}.ts`                                        |
| Middleware              | `src/core/middleware/{rateLimit,routeRateLimit,idempotency,validate,security,cors,errorHandler,bodyParsers}.ts`, `src/core/http/routeTable.ts`, `src/core/logger/logger.ts`                           |
| Notifications           | `src/modules/notifications/{notifications.catalog,notifications.service,notifications.dispatcher,notifications.admin}.ts`, `src/integrations/email/emailProvider.ts`                                  |
| Payments and refunds    | `src/modules/payments/{payments.service,payments.refunds}.ts`, `src/integrations/payments/paymentProvider.ts`, `src/modules/refunds/{refunds.core,refunds.service,refunds.routes,refunds.schemas}.ts` |
| Stock, coupons, uploads | `src/modules/inventory/inventory.stock.ts`, `src/modules/coupons/coupons.{repository,service}.ts`, `src/modules/media/{media.service,cloudinary}.ts`                                                  |
| Audit and privacy       | `src/modules/audit/audit.service.ts`, `src/lib/redact.ts`, `src/modules/customers/*` (search)                                                                                                         |
| CI and build            | `.github/workflows/ci.yml`, `package.json`, `Dockerfile`, `.nvmrc`, `vitest.config.ts`, `tsconfig.build.json`, `.gitignore`                                                                           |

**Facts from the brief that were confirmed in code or tests.**

| Fact                                                  | Confirmed by                                                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| DF-01, DF-02, DF-03 fixed                             | `notifications.catalog.ts` (`SECRET_VARIABLE`, `COD_VARIANT`, `implicitVariant`); `eventRendering.test.ts` passes         |
| Route × role matrix, 1,113 cases                      | Run on 2026-11-24: 1,113 passed                                                                                           |
| Cookie flags, lockout and audit assertions            | `adminAuth.test.ts`, `customerAuth.test.ts` (TC-003, TC-006, TC-063) pass                                                 |
| Registry stop-signal wiring test (M-2)                | `tests/unit/jobs/registryWiring.test.ts` passes                                                                           |
| The scheduler catches a synchronous `job.run()` throw | `src/jobs/scheduler.ts` (`execute`); `scheduler.test.ts` "synchronous throw from run() (IMP-09)" passes                   |
| M-1: five code paths                                  | Three call sites of `executeGatewayRefund` serving five flows (worker and API late capture, approval, retry, self-cancel) |
| D-62 … D-66                                           | `project-documentation/01-requirements/PROJECT_CONTEXT.md` §17.8                                                          |
| G2 at Step 1; G3, G7, G8 not executed                 | `docs/G2-EXECUTION-LOG.md`, `docs/PHASE3-PHASE4-MASTER-PROGRESS-REPORT.md`                                                |

## 3. Changes per document

### 3.1 `docs/operations/SECURITY_SELF_ASSESSMENT-G4-DRAFT.md`

| Section                                | Before                                                               | After                                                                                                                                            |
| -------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Header                                 | Date 2026-11-20; "No tests executed"                                 | "Last updated 2026-11-24" row; method note; an explicit "what this document is not" paragraph. Status unchanged: **DRAFT — for owner review**    |
| Update of 2026-11-24                   | Absent                                                               | New: four-point summary of this revision                                                                                                         |
| §23 checklist tables                   | Five H2 sections                                                     | Same rows and results, grouped under one heading. Four rows carry dated notes (recount, catalogue test, audit not re-run, permission-key source) |
| Broader control areas                  | "Webhook verification … rejected in production"; "M-1 open (DEC-05)" | Dated corrections: refusal is production-only and untested; DEC-05 answered by D-64                                                              |
| **G4 control assessment — 2026-11-24** | Absent                                                               | **New: 16 tables, 142 controls**, with the result vocabulary of the brief and the limits of "TESTED"                                             |
| Defect classification                  | DF-02 open; DF-01 open; "pending DEC-14"                             | Original text kept; dated correction: D-62 decided, DF-01 / 02 / 03 fixed (table with evidence)                                                  |
| Open findings                          | Absent                                                               | New table: A9-F01 … A9-F07 and DEC-06-impl, with proposed severity and what each needs                                                           |
| Known limitations                      | "In-memory … sessions, idempotency …"                                | Dated correction: which state is in memory and which is in the database                                                                          |
| Summary                                | One table (19 items)                                                 | Three tables: checklist (recounted, unchanged), broader areas (new count), G4 control assessment (new count). Six owner items added              |

### 3.2 `docs/operations/CI-CD-AND-DEPLOYMENT-PREPARATION.md`

| Section                  | Before                                                | After                                                                                                                                                                                                    |
| ------------------------ | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Whole file               | Not Prettier-formatted                                | Formatted                                                                                                                                                                                                |
| Header                   | —                                                     | "Last updated" row; sources extended; "Not claimed" line                                                                                                                                                 |
| §1 CI workflow           | Job called "CI (ecommerce-api)"                       | Correction: that is the workflow name; the job is `quality`. Triggers, runner, permissions, environment and Node resolution added                                                                        |
| §1 gaps                  | Six gaps                                              | Three more: no container build, actions pinned by tag, no job timeout. Coverage floors stated per metric                                                                                                 |
| §1 local equivalent      | "Results are in `PHASE4-G4-FINAL-EVIDENCE-REPORT.md`" | Correction: that file does not exist; results are in the new §8                                                                                                                                          |
| §2 artefacts             | "No worker container or health endpoint exists"       | Clarified. Shutdown-timing table added. **Dockerfile review** added (eight observations, read only)                                                                                                      |
| §3 environment variables | Strict list and inventory                             | Inventory confirmed complete (62 variables). Added: rules for every environment, start-up key checks, values the schema does not enforce, worker needs the same set, consequences of mock-only providers |
| §4 prerequisites         | "in-memory rate limits and sessions"                  | Dated precision; webhook secrets added to the secrets item                                                                                                                                               |
| §5 rollback              | —                                                     | Dated note: G2 not accepted; never rehearsed                                                                                                                                                             |
| §7                       | Absent                                                | **New: pre-deployment validation checklist** (eight groups, all unchecked)                                                                                                                               |
| §8                       | Absent                                                | **New: current local gate results**, marked as local, Node 24, not CI                                                                                                                                    |

### 3.3 `docs/operations/DEPLOYMENT_AND_OPERATIONS.md`

The "scaffold … Not a complete production runbook" warning is unchanged.

| Section | Before                                                     | After                                                                                                  |
| ------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Status  | Scaffold warning only                                      | Warning kept; "last checked 2026-11-24" line added                                                     |
| §1      | Process model                                              | Accurate. Shutdown timing added (API 25 s drain / 30 s; worker 60 s)                                   |
| §2      | "Future: JWT secrets/keys … add only when implemented"     | Dated correction: implemented and required in staging / production; values the schema does not require |
| §3      | G2 / G3 status of 2026-11-20                               | Dated re-check: unchanged. Database snapshot explicitly still **not re-verified**                      |
| §4      | Dockerfile line                                            | Pointer to the Dockerfile review                                                                       |
| §5      | CI step list without `prisma generate` and `openapi:check` | Dated correction; "no CI run has been recorded"                                                        |
| §6      | General guidance                                           | Two code-verified facts: process role on each log line; worker heartbeat. No metrics or alerting       |
| §7      | Points to the interim assessment                           | Pointer to the G4 draft, marked as a draft                                                             |
| §9      | "no further procedure is defined"                          | Dated correction pointing to §9.1                                                                      |
| §9.1    | Procedure                                                  | Three request constraints added from the route and schema. **No recovery step was added or changed**   |
| §10     | Absent                                                     | New: notifications left in `SENDING` — facts only; states that no procedure is defined                 |
| §11     | Absent                                                     | New: verification record                                                                               |

## 4. Control-status summary

Source: `SECURITY_SELF_ASSESSMENT-G4-DRAFT.md`, "G4 control assessment — 2026-11-24". The counts
were produced by a script from the tables.

| Area                                | TESTED | CODE-VERIFIED | DOCUMENTED | PREPARED | BLOCKED | USER-DEPENDENT | GAP    | Total   |
| ----------------------------------- | ------ | ------------- | ---------- | -------- | ------- | -------------- | ------ | ------- |
| 1. Authentication and authorization | 9      | 0             | 0          | 0        | 2       | 0              | 3      | 14      |
| 2. JWT and refresh tokens           | 7      | 2             | 2          | 0        | 1       | 0              | 0      | 12      |
| 3. Password recovery                | 6      | 2             | 0          | 0        | 1       | 1              | 0      | 10      |
| 4. Rate limiting                    | 3      | 1             | 0          | 1        | 0       | 0              | 1      | 6       |
| 5. Input validation                 | 5      | 2             | 0          | 0        | 0       | 0              | 0      | 7       |
| 6. Notification payload safety      | 5      | 0             | 1          | 0        | 1       | 1              | 0      | 8       |
| 7. Payment webhooks and idempotency | 5      | 1             | 0          | 0        | 2       | 0              | 2      | 10      |
| 8. Inventory and coupon concurrency | 5      | 0             | 0          | 0        | 1       | 0              | 0      | 6       |
| 9. Audit logs                       | 4      | 1             | 0          | 0        | 1       | 2              | 0      | 8       |
| 10. File uploads                    | 3      | 1             | 0          | 0        | 1       | 0              | 1      | 6       |
| 11. Data privacy                    | 7      | 0             | 1          | 0        | 0       | 1              | 2      | 11      |
| 12. Worker safety                   | 5      | 0             | 2          | 0        | 1       | 1              | 2      | 11      |
| 13. Secret handling                 | 4      | 4             | 0          | 0        | 0       | 2              | 2      | 12      |
| 14. Backup and restore              | 0      | 0             | 1          | 1        | 1       | 1              | 1      | 5       |
| 15. Logging and monitoring          | 3      | 1             | 0          | 0        | 0       | 1              | 1      | 6       |
| 16. CI/CD and staging readiness     | 0      | 0             | 2          | 2        | 2       | 2              | 2      | 10      |
| **Total**                           | **71** | **15**        | **9**      | **4**    | **14**  | **12**         | **17** | **142** |

**Reading the table.** All 71 TESTED results use a mocked database and fake providers. Areas 14 and
16 have no TESTED control: nothing in them has been executed.

## 5. Statements in the earlier drafts that were wrong or stale

| #   | Document          | Statement                                                                             | Finding                                                                                                                          |
| --- | ----------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Security draft    | DF-02 is an open verified defect; DF-01 is not fixed                                  | **Wrong since 2026-11-21.** Both are fixed, as is DF-03                                                                          |
| 2   | Security draft    | "In-memory … sessions, idempotency … are single-instance only"                        | **Imprecise.** Refresh-token sessions and idempotency keys are stored in the database. Only auxiliary session state is in memory |
| 3   | Security draft    | "88 permission keys in the RBAC service"                                              | **Wrong location.** They are defined in `src/lib/permissions.ts`                                                                 |
| 4   | Security draft    | Webhooks: "the mock provider is rejected in production" presented under VERIFIED PASS | **Incomplete.** True for production only; staging accepts mock webhooks; no test covers the refusal                              |
| 5   | CI/CD preparation | "Results are in `PHASE4-G4-FINAL-EVIDENCE-REPORT.md`"                                 | **Wrong.** No such file exists in the workspace                                                                                  |
| 6   | CI/CD preparation | The job is called "CI (ecommerce-api)"                                                | **Wrong.** That is the workflow name; the job is `quality`                                                                       |
| 7   | Runbook §2        | JWT keys and other secrets are "Future … add only when implemented"                   | **Stale.** They are implemented and required in staging / production                                                             |
| 8   | Runbook §5        | CI steps: "format, lint, typecheck, build, test, offline `prisma validate`"           | **Incomplete.** `prisma generate` and `openapi:check` were missing                                                               |
| 9   | Runbook §9        | "no further procedure is defined"                                                     | **Stale.** §9.1 was adopted on 2026-11-21                                                                                        |

## 6. Open gaps and who must act

### 6.1 Owner decision

| Item                                                                                                                                                                                                                               | Controls                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| **A9-F02:** classify the finding "the mock payment provider can start in production". This report treats it as a production-go-live blocker and not as an open S1 / S2 defect of the Phase 4 scope. The owner may decide otherwise | PW-08                             |
| Accept, or return, the security self-assessment draft (G4 criterion 4)                                                                                                                                                             | —                                 |
| Proposed deferrals DEF-A3 (MFA recovery codes), DEF-A4 (CAPTCHA), DEF-A5 (breached-password service), DEF-B3 (upload limits); staff password history                                                                               | AA-10 … AA-13, FU-05              |
| Retention periods and customer erasure / anonymisation (RD-11, OQ-38); personal-data field classification                                                                                                                          | DP-09, DP-10, DP-11               |
| Audit retention; dedicated Superadmin-bypass event (DC-04); logging of direct authentication e-mails (DEC-13c)                                                                                                                     | AL-07, AL-08, PR-09               |
| Refund recovery when no refund was issued (DEC-05-next); a procedure or formal acceptance for notifications left in `SENDING` (RK-03)                                                                                              | WK-08, WK-09                      |
| Hosting (DEC-08) with its secret manager, log service and backups; Node line (DEC-18); `.env.example` (DEC-10); Batch 9 / Batch 10 acceptance                                                                                      | SH-11, SH-12, CS-05, LM-06, BR-05 |
| A shared rate-limit store for more than one API instance (D-38 / OQ-35)                                                                                                                                                            | RL-05                             |
| Promotion "EXPIRED is final" alignment (DEC-06-impl, D-63)                                                                                                                                                                         | —                                 |

### 6.2 User execution

| Item                                                                     | Controls |
| ------------------------------------------------------------------------ | -------- |
| G2 backup / restore drill, from Step 1                                   | BR-02    |
| Push a branch or open a pull request so that CI runs on Node 22 (USR-06) | CS-02    |
| `npm audit` (needs the network)                                          | CS-04    |
| Template wording approval and seed execution after the database gates    | NP-08    |

### 6.3 Needs authorization (code, test, config or workflow change)

| Item                                                                                                   | Controls / finding                              |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| Schema rules: require webhook secrets and `PASSWORD_PEPPER` outside development; minimum pepper length | PW-07, SH-09; A9-F01, A9-F03                    |
| Start-up refusal of the mock payment provider in production                                            | PW-08; A9-F02                                   |
| Dockerfile corrections and a `.dockerignore`                                                           | SH-10, CS-06; A9-F04                            |
| Tests for the production mock-webhook refusal and for the required-secret and `COOKIE_SECURE` rules    | PW-06, SH-03, SH-04; A9-F05                     |
| CI: coverage gate, audit / SAST / secret scan, artefact check, container build, timeout                | CS-03, CS-04                                    |
| `$queryRawUnsafe('SELECT 1')`: accept, or change one line                                              | IV-04; A9-F06                                   |
| HSTS in staging                                                                                        | IV-07; A9-F07                                   |
| Worker liveness check; metrics and alerting                                                            | WK-10, LM-05                                    |
| Real-database concurrency tests (DEC-12) and gates G3, G7, G8                                          | CC-06, AA-14, JW-12, PW-10, AL-06, BR-03, BR-04 |

### 6.4 Blocked on an external dependency

Real payment provider (OQ-06), e-mail / WhatsApp vendor (OQ-08), Cloudinary verification (EXT-04),
a staging environment and DAST (DEC-08): controls PW-09, PR-10, NP-07, FU-06, CS-07, CS-08, WK-11.

## 7. Statements that could not be verified

| Statement                                                                                        | Why                                                                                                        |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| The 2026-11-18 local database snapshot in runbook §3                                             | Needs database access. Left marked "not re-verified"                                                       |
| "runtime adapter wired and live-verified" in runbook §4                                          | Needs a database. Marked "not re-verified" in the runbook §11                                              |
| `npm audit` result of 2026-11-19 (production 0, development 8 moderate)                          | Needs the network                                                                                          |
| The baseline gate results in the CI/CD document §8 (first six rows)                              | Reported by the orchestrator. This agent may not run the full suite, the build or the repository-wide lint |
| Whether `.env.example` matches the schema                                                        | `.env.*` files may not be opened                                                                           |
| Whether any secret was ever committed                                                            | No Git access                                                                                              |
| Dockerfile behaviour: `npm ci --omit=dev=false`, the `argon2` module on Alpine, the health check | The image was not built                                                                                    |
| The figures "166 guarded admin routes, 37 customer routes" in the 2026-11-20 section             | Not recounted. Only the total of 1,113 cases was confirmed                                                 |
| TC-008 and TC-010 references in the 2026-11-20 "Audit logging" row                               | Not individually re-checked                                                                                |
| Any behaviour on real MySQL, with real OS signals or with real providers                         | Out of reach offline                                                                                       |

## 8. Files touched and constraints observed

**Edited (three):**

- `docs/operations/SECURITY_SELF_ASSESSMENT-G4-DRAFT.md`
- `docs/operations/CI-CD-AND-DEPLOYMENT-PREPARATION.md`
- `docs/operations/DEPLOYMENT_AND_OPERATIONS.md`

**Created (one):**

- `docs/PHASE4-MASTER-AGENT9-SECURITY-CICD-OPERATIONS-REPORT.md` (this file)

**Formatting.** `npx prettier --write` was run on these four files only.

**Not modified:** `.github/workflows/ci.yml`, `Dockerfile`, `docs/operations/SECURITY_SELF_ASSESSMENT.md`
(interim), every source, test, configuration and package file.

**Constraints confirmed.**

- No `.env` or `.env.*` file was opened, read, printed or searched by this agent. Secret handling was assessed from the schema in `src/core/config/env.ts` only.
- No Git command and no `.git` access.
- No database connection and no network access. `npm audit`, deployment and remote workflows were
  not run.
- Tests were run per file with `npx vitest run <files>` only. The full suite, the build and the
  repository-wide lint and format checks were not run. No test was edited.
