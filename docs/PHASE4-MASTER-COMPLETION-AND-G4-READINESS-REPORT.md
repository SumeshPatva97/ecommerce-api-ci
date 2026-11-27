# Phase 4 — Master Completion and G4 Readiness Report

| Field       | Value                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------ |
| Document ID | P4-MASTER-COMPLETION-01                                                                          |
| Date        | 2026-11-24                                                                                       |
| Prepared by | Orchestrator (Agent 0), from nine workstream reports and its own verification                    |
| Evidence    | Local, offline, mocked database and fake providers. Node 24.12.0. No CI run, no MySQL, no deploy |

## Verdict

- **G4 is NOT MET. Phase 4 remains IN PROGRESS — NOT APPROVED. Production readiness is NOT
  ESTABLISHED.**
- Every task that was already authorized is done and verified offline. All local gates pass.
- What remains needs your decision, your execution, or an authorization that has not been given
  (§15, §16).
- Nothing was accepted, approved or deferred on your behalf.

_Update 2026-11-24: one decision was taken afterwards. The owner classified the mock-payment-provider finding as S2 and authorized its fix (D1). It is implemented and locally verified — see §19. G4 remains NOT MET._

Status words used in this report: ALREADY COMPLETE, COMPLETE, PARTIAL, BLOCKED, USER DECISION
REQUIRED, RESTRICTED — PREPARE ONLY, NOT STARTED.

## 1. Initial baseline

Measured on 2026-11-24 before any workstream changed a file (Node 24.12.0, local).

| Check               | Result                                                                             |
| ------------------- | ---------------------------------------------------------------------------------- |
| Full Vitest suite   | 113 files, 3,005 passed, 3 todo, 0 failed                                          |
| Coverage            | Statements 92.05 %, branches 82.59 %, functions 94.67 %, lines 93.80 %             |
| `typecheck`         | PASS                                                                               |
| `build`             | PASS                                                                               |
| `openapi:check`     | PASS                                                                               |
| `lint`              | **FAIL** — 1 error in `tests/db/harness/race.ts` (partial harness from 2026-11-21) |
| `format:check`      | **FAIL** — 7 files (five harness files, two documents)                             |
| Source last changed | 2026-11-21 (no source file was changed on 2026-11-24)                              |

Authoritative statuses at the start, all unchanged at the end: Phases 1–3 APPROVED; Phase 4 IN
PROGRESS — NOT APPROVED; Batch 7 and Batch 8 + M1 ACCEPTED — OFFLINE MOCKED SCOPE ONLY; Batch 9
COMPLETE — PENDING USER ACCEPTANCE; G2 in user execution (Step 0 PASS); G3 not accepted; G7 / G8 not
authorized.

## 2. Agent assignments

| Agent | Workstream                                          | Executed by  | Files owned                                             | Report                                                          |
| ----- | --------------------------------------------------- | ------------ | ------------------------------------------------------- | --------------------------------------------------------------- |
| 0     | Orchestration, integration, central documents, G4   | Orchestrator | Central status documents; canonical documentation edits | This report                                                     |
| 1     | Notifications DF-01 / 02 / 03                       | Orchestrator | None changed                                            | `PHASE4-MASTER-AGENT1-NOTIFICATIONS-REPORT.md`                  |
| 2     | WP10-1, WP10-2, WP10-5, scheduler fix               | Orchestrator | `tests/unit/jobs/catalogJobs.test.ts`                   | `PHASE4-MASTER-AGENT2-JOBS-REGISTRY-SCHEDULER-REPORT.md`        |
| 3     | WP10-3 payment reconciliation                       | Subagent     | `tests/unit/jobs/paymentReconciliation.test.ts`         | `PHASE4-MASTER-AGENT3-PAYMENT-RECONCILIATION-REPORT.md`         |
| 4     | WP10-4 OpenAPI                                      | Orchestrator | None changed                                            | `PHASE4-MASTER-AGENT4-OPENAPI-CONTRACT-REPORT.md`               |
| 5     | WP10-6 cart tests                                   | Orchestrator | None changed                                            | `PHASE4-MASTER-AGENT5-CART-TESTS-REPORT.md`                     |
| 6     | DEC-13 traceability                                 | Subagent     | Read-only                                               | `PHASE4-MASTER-AGENT6-DEC13-TRACEABILITY-REPORT.md`             |
| 7     | Refund and promotion documentation (DEC-05, DEC-06) | Subagent     | Read-only; edits applied by the orchestrator            | `PHASE4-MASTER-AGENT7-REFUND-PROMOTION-DOCUMENTATION-REPORT.md` |
| 8     | Database harness preparation (offline)              | Subagent     | `tests/db/**`, `tests/unit/dbHarness/**`                | `PHASE4-MASTER-AGENT8-DB-HARNESS-REPORT.md`                     |
| 9     | Security, CI/CD, operations                         | Subagent     | Three files in `docs/operations/`                       | `PHASE4-MASTER-AGENT9-SECURITY-CICD-OPERATIONS-REPORT.md`       |

Agents 1, 2, 4 and 5 were run by the orchestrator because the audit showed their work was already
done; a separate worker would only have repeated the audit. No two workstreams wrote to the same
file. The runbook was edited by the orchestrator only after Agent 9 had finished with it.

## 3. Existing implementation discovered

The audit found that most of the requested work had been implemented on 2026-11-21 and never
reported, because that session was interrupted.

| Item                            | Found in the repository                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| DF-01, DF-02, DF-03             | Fixed in `notifications.catalog.ts`, `notifications.service.ts`, templates, dispatcher and seed; regression tests present      |
| WP10-1 registry wiring          | `tests/unit/jobs/registryWiring.test.ts` (5 tests)                                                                             |
| WP10-2 per-item error isolation | `src/jobs/catalogAggregates.ts` (per-product `try / catch`, error counts)                                                      |
| WP10-3 reconciliation tests     | Two tests present; scenario coverage incomplete                                                                                |
| WP10-4 download content types   | `FILE_DOWNLOADS` in `scripts/generate-openapi.ts`; specification regenerated                                                   |
| WP10-5 best-seller window       | `loadBestSellerWindowDays` with bounds 1–730 and fallback 90                                                                   |
| WP10-6 cart tests               | `cartTransactionalRace.test.ts`, `abandonedCarts.test.ts`                                                                      |
| Scheduler fix (IMP-09)          | Async wrapper in `src/jobs/scheduler.ts`; test present                                                                         |
| Four small DEC-13 items         | Implemented in checkout, catalogue, orders, inventory and collections modules                                                  |
| Database harness                | Partial: guard, client, cleanup, fixtures, race helper, two SQL files. No scenarios, no configuration, no README; lint failing |
| Never written                   | `PHASE4-AUTONOMOUS-COMPLETION-FINAL-REPORT.md`, `PHASE4-G4-FINAL-EVIDENCE-REPORT.md`                                           |

## 4. Work already complete

| Item                                   | Status           | Verification on 2026-11-24                                                                           |
| -------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------- |
| DF-01 `accountRecoveryUrl`             | ALREADY COMPLETE | Guard accepts it; `forgotPasswordUrl` still refused; tests pass                                      |
| DF-02 payment identifiers in the guard | ALREADY COMPLETE | 35 forbidden names; 8 names proven to write nothing before persistence                               |
| DF-03 COD out-for-delivery variant     | ALREADY COMPLETE | COD selects the variant; prepaid and missing amount fall back to the standard template               |
| WP10-1                                 | ALREADY COMPLETE | Mutation check: removing the signal wiring makes the test fail                                       |
| WP10-2                                 | ALREADY COMPLETE | One product fails, the next succeeds; a failure outside the loop still fails the run                 |
| WP10-4                                 | ALREADY COMPLETE | Five operations match what the routes send; `openapi:check` passes                                   |
| WP10-5                                 | ALREADY COMPLETE | Valid, boundary, missing, invalid and malformed values tested                                        |
| WP10-6                                 | ALREADY COMPLETE | Re-resolution, retry race and exact 30-day / 90-day boundaries tested                                |
| Scheduler fix                          | ALREADY COMPLETE | Mutation check: removing the wrapper makes the test fail                                             |
| FR-ORD-006, FR-INV-006, FR-SF-004      | ALREADY COMPLETE | Code and tests confirmed                                                                             |
| FR-AD-008                              | PARTIAL          | Settings read on the main paths; payment retry and the recently-viewed badge still ignore them (§12) |

## 5. New changes in this run

No source file was changed. No package, lockfile, schema, migration, seed, Docker or workflow file
was changed.

**Tests**

- `catalogJobs.test.ts`: five malformed-value cases for the best-seller window.
- `paymentReconciliation.test.ts`: 12 WP10-3 tests (post-commit ordering, ledger rows, provider
  failure, retry, recording failure, duplicate prevention). The file now has 26 tests.
- `eventRendering.test.ts` (Step 3.1, earlier today): five more forbidden names and COD `null` /
  `undefined` cases.

**Database harness (prepared, not executed)**

- Guard extended: refuses production-like `NODE_ENV`, the runtime or migration credential, `root`,
  and two more database names.
- Added: six scenarios (`TC-004`, `030`, `041`, `045`, `048`, `051`), a separate Vitest
  configuration, two guard setups, HTTP helpers, an owner procedure (`tests/db/README.md`).
- Added: six offline unit-test files (133 tests in the folder with the existing guard test).
- The lint error and the five formatting failures from 2026-11-21 are fixed.

**Documentation**

- 29 dated corrections for refund recovery (D-64) and promotion expiry (D-63) across 11 documents.
- Three dated notes in `API_DOCUMENTATION.md` for the items implemented on 2026-11-21.
- Traceability matrix: eight rows updated; counts re-stated; four wording conflicts added.
- Security self-assessment draft rebuilt (142 controls); CI/CD preparation and runbook corrected
  against the code (nine stale or wrong statements).
- Dated addenda in the tracker, roadmap, progress report, decision package, remaining-decisions
  list and test-catalogue mapping.

**One proposed edit was not applied:** a note on FR-PAY-011 in `PROJECT_REQUIREMENTS.md`. The
requirement and the code disagree about which permission completes a refund, and choosing between
them is your decision (DC-06).

## 6. Exact changed file list (2026-11-24)

Paths under `ecommerce-api/` unless they start with `project-documentation/`.

**Tests modified (3)**

- `tests/unit/jobs/catalogJobs.test.ts`
- `tests/unit/jobs/paymentReconciliation.test.ts`
- `tests/unit/modules/notifications/eventRendering.test.ts`

**Database harness — modified (7)**

- `tests/db/harness/client.ts`, `fixtures.ts`, `guard.ts`, `race.ts`
- `tests/db/sql/cleanup.sql`, `setup.sql`
- `tests/unit/dbHarness/guard.test.ts`

**Database harness — created (20)**

- `tests/db/harness/http.ts`, `options.ts`, `scenario.ts`, `world.ts`
- `tests/db/setup/globalGuard.ts`, `workerGuard.ts`
- `tests/db/vitest.db.config.ts`, `tests/db/README.md`
- `tests/db/scenarios/tc-004-refresh-token-replay.dbtest.ts`,
  `tc-030-last-unit-oversell.dbtest.ts`, `tc-041-coupon-last-redemption.dbtest.ts`,
  `tc-045-invoice-number-sequence.dbtest.ts`, `tc-048-idempotency-key-replay.dbtest.ts`,
  `tc-051-webhook-vs-verify-capture.dbtest.ts`
- `tests/unit/dbHarness/cleanupPlan.test.ts`, `failClosed.test.ts`, `httpPlumbing.test.ts`,
  `isolation.test.ts`, `options.test.ts`, `race.test.ts`

**Reports created (12)**

- `docs/PHASE4-STEP3-1-NOTIFICATION-DEFECTS-IMPLEMENTATION-REPORT.md`
- `docs/PHASE4-STEP3-2-BATCH10-WP10-1-WP10-2-REPORT.md`
- `docs/PHASE4-MASTER-AGENT1-NOTIFICATIONS-REPORT.md` … `PHASE4-MASTER-AGENT9-SECURITY-CICD-OPERATIONS-REPORT.md` (nine files)
- `docs/PHASE4-MASTER-COMPLETION-AND-G4-READINESS-REPORT.md` (this file)

**Documents modified in `ecommerce-api/docs/` (11)**

- `PHASE4-AUTONOMOUS-COMPLETION-STATUS.md`
- `PHASE4-MASTER-COMPLETION-ROADMAP.md`
- `PHASE3-PHASE4-MASTER-PROGRESS-REPORT.md`
- `PHASE4-CONSOLIDATED-DECISION-PACKAGE.md`
- `PHASE4-REMAINING-USER-DECISIONS.md`
- `PHASE4-FR-MUST-API-TRACEABILITY-MATRIX-DRAFT.md`
- `PHASE4-TEST-CASE-CATALOGUE-MAPPING-DRAFT.md`
- `PHASE4-JOBS-AND-SCHEDULING.md`
- `operations/SECURITY_SELF_ASSESSMENT-G4-DRAFT.md`
- `operations/CI-CD-AND-DEPLOYMENT-PREPARATION.md`
- `operations/DEPLOYMENT_AND_OPERATIONS.md`

**Canonical documents modified (6; dated notes, line endings kept, not run through Prettier)**

- `project-documentation/01-requirements/PROJECT_REQUIREMENTS.md`
- `project-documentation/04-backend/API_DOCUMENTATION.md`
- `project-documentation/04-backend/BACKEND_STRUCTURE.md`
- `project-documentation/06-workflows/ADMIN_WORKFLOWS.md`
- `project-documentation/06-workflows/NOTIFICATION_WORKFLOWS.md`
- `project-documentation/06-workflows/USER_WORKFLOWS.md`

**Not changed:** everything under `src/`, `prisma/`, `scripts/`, `.github/`; `package.json`, the
lockfile, `Dockerfile`, `docs/openapi/openapi.json`, every `.env*` file. `.env`, `.env.example` and
`.env.migration.example` still carry their earlier timestamps (2026-11-20, 2026-11-20, 2026-11-18);
none was opened.

## 7. Test commands and results

All commands were run in `ecommerce-api` on 2026-11-24 after integration, on Node 24.12.0.

| Command                                                                                       | Result                                             |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `npx vitest run --coverage` (full suite)                                                      | **119 files, 3,110 passed, 3 todo, 0 failed**      |
| Notifications (`tests/unit/modules/notifications`, `tests/integration/modules/notifications`) | 5 files, 292 passed                                |
| Jobs and worker (`tests/unit/jobs`, `tests/unit/workerRuntime.test.ts`)                       | 7 files, 85 passed                                 |
| Reconciliation (`tests/unit/jobs/paymentReconciliation.test.ts`)                              | 1 file, 26 passed                                  |
| Cart (`tests/integration/modules/cart`, `tests/unit/jobs/abandonedCarts.test.ts`)             | 4 files, 50 passed                                 |
| Permission matrix (`routeRoleMatrix.test.ts`, `effectivePermissions.test.ts`)                 | 2 files, 1,115 passed                              |
| State machine (`stateMachineMatrix.test.ts`)                                                  | 1 file, 181 passed, 1 todo                         |
| GST (`tests/unit/lib/tax`)                                                                    | 3 files, 56 passed, 2 todo                         |
| Contract (`tests/unit/scripts/openapi.test.ts`)                                               | 1 file, 8 passed                                   |
| Offline database-harness tests (`tests/unit/dbHarness`)                                       | 7 files, 133 passed                                |
| Refund recovery contract (`manualRecoveryContract.test.ts`)                                   | 1 file, 6 passed                                   |
| `npx vitest run --config tests/db/vitest.db.config.ts` with no variables (Agent 8)            | Exit 1, refused by the guard before any connection |

The three todo tests are GST-15 (database part, needs DEC-12), GST-17 (B2B, deferred) and one
state-machine case. The suite grew from 113 files / 3,005 tests to 119 files / 3,110 tests. _(Clarification 2026-11-27: "GST-15 (database part, needs DEC-12)" is the 2026-11-24 wording and is kept as written. GST-15 is outside DEC-12 and requires a separate owner decision — §23.)_ _(Clarification 2026-11-27: "GST-17 (B2B, deferred)" is the 2026-11-24 wording and is kept as written. GST-17 is not formally deferred. It remains pending OQ-24; no owner-approved deferral is recorded. The B2B portion of FR-TAX-018 and FR-RPT-009 remains subject to the owner's OQ-24 decision.)_

The six real-database scenarios were **not** run. The default suite cannot collect them (0 `.dbtest`
files listed).

## 8. Coverage

| Metric     | Baseline | After integration | Threshold |
| ---------- | -------- | ----------------- | --------- |
| Statements | 92.05 %  | 92.08 %           | 80 %      |
| Branches   | 82.59 %  | 82.63 %           | 75 %      |
| Functions  | 94.67 %  | 94.70 %           | 80 %      |
| Lines      | 93.80 %  | 93.81 %           | 80 %      |

No threshold was lowered, no test was skipped and no lint rule was suppressed.

## 9. Format, lint, typecheck, build and OpenAPI results

| Gate                    | Baseline | After integration         |
| ----------------------- | -------- | ------------------------- |
| `npm run format:check`  | FAIL (7) | **PASS**                  |
| `npm run lint`          | FAIL (1) | **PASS**                  |
| `npm run typecheck`     | PASS     | **PASS**                  |
| `npm run build`         | PASS     | **PASS**                  |
| `npm run openapi:check` | PASS     | **PASS** (248 operations) |

Not run: `prisma validate` (it needs the environment file, which is off-limits; the schema is
unchanged), `npm audit` (needs the network; last recorded 2026-11-19), CI (needs a Git push).

## 10. Security assessment

Source: `docs/operations/SECURITY_SELF_ASSESSMENT-G4-DRAFT.md`. Status: **draft for your review**.
It is not a penetration test or a certification.

| Result         | Controls | Meaning                                            |
| -------------- | -------- | -------------------------------------------------- |
| TESTED         | 71       | A passing automated test exists (mocked database)  |
| CODE-VERIFIED  | 15       | Read in the code; no test                          |
| DOCUMENTED     | 9        | Procedure or rule written down                     |
| PREPARED       | 4        | Ready, not executed                                |
| BLOCKED        | 14       | Needs a real database, a vendor or a schema change |
| USER-DEPENDENT | 12       | Needs your decision or execution                   |
| GAP            | 17       | Not implemented                                    |
| **Total**      | **142**  |                                                    |

**Finding that needs your classification — SEC-F02 (verified in code by the orchestrator).** _(Resolved later on 2026-11-24: classified S2 and fixed — §19. The text below is the finding as reported.)_

- The only payment provider is the mock. Nothing refuses it at start-up when `NODE_ENV=production`.
- Only the webhook handler refuses the mock in production. The customer `verify` endpoint does not.
- The mock's signing secret is a public constant, so in that configuration a signed-in customer
  could mark their own order as paid.
- It is not reachable today: there is no production deployment and no real provider.
- The fix (a start-up refusal and a test) is a source change and is **not authorized**.

**Other new findings (proposed S3 / S4):** webhook secrets optional in staging; `PASSWORD_PEPPER`
optional; Dockerfile gaps; no tests for the strict-environment rules; HSTS in production only; no
coverage, audit or secret-scan step in CI.

**Defect register (convention D-62: G4 "P0 / P1" = S1 / S2).**

| ID       | Item                                                        | Proposed severity                            | Status                                                        |
| -------- | ----------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------- |
| DF-01…03 | Notification defects                                        | S3                                           | FIXED                                                         |
| M-2      | Registry stop-signal wiring untested                        | S4                                           | CLOSED by test                                                |
| M-1      | Refund interrupted after commit (five paths)                | S3, or S2 if you decide                      | OPEN; manual procedure (D-64)                                 |
| SEC-F02  | Mock payment provider not refused in production             | S2 (owner, D1). _Was: "Your classification"_ | **FIXED 2026-11-24 (§19).** _Was: "OPEN; fix not authorized"_ |
| D-63     | Promotion revived by a date edit before `EXPIRED` is stored | S3                                           | OPEN; fix not authorized                                      |
| DB-P1    | Coupon over-redemption under concurrency (predicted)        | S2 if reproduced                             | NOT TESTED; needs DEC-12                                      |
| DC-05    | Barcode image documented as JSON in OpenAPI                 | S4                                           | OPEN; fix not authorized                                      |
| DC-06    | FR-PAY-011 permission wording against the code              | Decision                                     | OPEN                                                          |

_(Update 2026-11-24: SEC-F02 is classified S2 and fixed, §19. The sentence below still applies to M-1.)_

No S1 / S2 defect is confirmed. That statement depends on your classification of SEC-F02 and M-1,
and DB-P1 cannot be confirmed or dismissed without a real database. _(Clarification 2026-11-27: DB-P1 is the coupon over-redemption prediction. It is no longer waiting on a DEC-12 decision: DEC-12 was decided on 2026-11-27 and makes the real-database scenarios, including TC-041, mandatory G4 evidence. DB-P1 is still untested because TC-041 has not been executed — §23.)_

## 11. Database harness readiness

Status: **RESTRICTED — PREPARE ONLY. Prepared; never executed.**

| Aspect            | State                                                                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scenarios         | Six prepared: TC-004, TC-030, TC-041, TC-045, TC-048, TC-051                                                                                                                                                  |
| Isolation         | `.dbtest.ts` suffix; a separate configuration; `npm test` cannot collect them (proven by a test and by listing)                                                                                               |
| Guard             | Fail-closed, before any client exists: dedicated URL variable, database exactly `ecommerce_test`, second opt-in, loopback host, no `root`, no runtime or migration credential, no production-like environment |
| Fail-closed proof | Run with no variables: exit 1, refused in global setup, nothing connected                                                                                                                                     |
| Environment files | The suite reads none                                                                                                                                                                                          |
| Cleanup           | `DELETE` only, all 67 tables in foreign-key order (checked against the baseline migration offline)                                                                                                            |
| Owner procedure   | `tests/db/README.md`, nine steps, one scenario at a time                                                                                                                                                      |
| Prerequisites     | DEC-12 authorization, G2, G3, F5 and G7                                                                                                                                                                       |

_(Clarification 2026-11-27, row "Prerequisites" — "DEC-12 authorization" means a separate explicit written owner authorization to execute the scenarios. The DEC-12 decision of 2026-11-27 is not that authorization. G7 PASS is also required, and G7 PASS alone does not authorize execution — §23.)_

**What is not known.** Whether the scenarios pass, and whether their fixtures and timings are
right. A red result on first execution may be a product defect or a harness mistake.

**Predictions from code reading (not reproduced):**

1. **TC-041 may fail.** Inside the order transaction, the quote is read before the coupon is
   locked, and the usage count is then read without a lock. On MySQL's default isolation that read
   can be stale, so two racing orders could both take the last redemption. I confirmed the code
   pattern; stock reservation does not share it (it reads the locked row).
2. **TC-004:** the loser of a simultaneous token rotation gets a 401 first and the same pair only on
   retry.
3. **TC-045:** the first document number of a financial year can return `CONFLICT` under a
   deadlock; numbering stays gap-free.

## 12. DEC-13 status

Exactly **four** small items were implemented (D-66). No other requirement was implemented, and no
deferral was approved.

| Requirement | Status                 | Note                                                                                                                  |
| ----------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| FR-ORD-006  | ALREADY COMPLETE       | SKU search implemented and tested. "Export" is the separate orders report: confirm that this is enough                |
| FR-INV-006  | ALREADY COMPLETE       | `actorId` filter implemented and tested                                                                               |
| FR-SF-004   | ALREADY COMPLETE       | Empty collections hidden from the public list. The detail endpoint is unchanged                                       |
| FR-AD-008   | PARTIAL                | Payment retry uses the environment TTL; recently-viewed uses the 30-day badge default. Closing them is not authorized |
| FR-PRM-004  | USER DECISION REQUIRED | Not implemented. The requirement is itself `[PROPOSED]`; its ₹1 floor is `[PROPOSED]` and the engine floor is ₹0.01   |
| FR-PL-013   | USER DECISION REQUIRED | Not implemented. Search does not match brand, category or attribute values                                            |
| FR-TAX-013  | USER DECISION REQUIRED | Not implemented. A tax professional must say what is required first; the question is not yet written into RD-01       |

Recommendations and proposed acceptance criteria for the last three are in the Agent 6 report,
Part B. Estimated sizes: FR-PRM-004 medium (large with price filter and sort), FR-PL-013 medium,
FR-TAX-013 small.

Traceability matrix after the re-count (239 API-side "Must" rows): **219 tested (mocked), 7 with no
test, 11 partial, 2 blocked / deferred.** The matrix remains a draft.

Proposed deferrals DEF-A1 … DEF-A5 and DEF-B1 … DEF-B3 are **not approved**. _(Update 2026-11-24: DEF-A1 was approved later, under the owner decision D6 — §21. The other seven are still not approved.)_

## 13. Batch 9 acceptance status

**COMPLETE — PENDING USER ACCEPTANCE.** Unchanged by this run. _(Update 2026-11-24: Batch 9 and Batch 10 were accepted by the owner for offline mocked scope only — §20.)_

- Recommendation (unchanged): acceptable with explicit acknowledgement of the listed risks, for
  offline mocked scope only.
- Checklist: `PHASE4-REMAINING-USER-DECISIONS.md` §1 (RK-01 … RK-13).
- Changes since the review: RK-07 (untested stop-signal wiring) is now covered by a Batch 10 test;
  RK-04 has a documented manual procedure with one added caveat for retried refunds (OD-07); RK-09
  has a prepared harness.
- **Batch 10** is implemented and verified with mocked tests and is also **pending your
  acceptance**.

## 14. G4 exit-criteria matrix

Criteria from `project-documentation/10-project-management/IMPLEMENTATION_ROADMAP.md`. _(Canonical location, verified 2026-11-24. From 2026-11-21 until 2026-11-24 the file sat in `02-architecture/`; it was moved back on the owner's authorization and its content is unchanged.)_

| Criterion                                                              | Evidence                                                                                                                                                                | Status                    | Missing work                                                                                                                                                                                                                                                                                                                                              | Responsible party                                |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1. All endpoints in API_DOCUMENTATION implemented or formally deferred | 248 operations in OpenAPI; `openapi:check` passes; documented endpoint headings implemented (roadmap audit). `POST /webhooks/email` and `/webhooks/whatsapp` are absent | USER DECISION REQUIRED    | Approve or reject the deferral DEF-A1. Decide DC-05 (barcode content type). _(Update 2026-11-24: DEF-A1 approved under D6 and HTTP serving of the specification deferred under D7 — §21. DC-05 is still open. The evidence in this row is a method-and-path comparison, not request / response parity, and the criterion is not independently verified.)_ | User                                             |
| 2a. FR "Must" API-side criteria: implementation                        | Matrix draft: 219 tested, 7 no test, 11 partial, 2 blocked / deferred of 239                                                                                            | PARTIAL                   | 11 partial requirements: implement or formally defer (DEC-13a, 13b, 13c, 13d). Owner review of the draft matrix                                                                                                                                                                                                                                           | User decides; implementation needs authorization |
| 2b. FR "Must" criteria pass in automated tests                         | 3,110 tests pass, all mocked. Coverage 92 % statements                                                                                                                  | PARTIAL                   | Six concurrency cases (TC-004, 030, 041, 045, 048, 051) and GST-15 need a real database                                                                                                                                                                                                                                                                   | User (DEC-12, after G2, G3, F5, G7)              |
| 2c. Real-database harness                                              | `tests/db/` prepared; guard proven fail-closed                                                                                                                          | RESTRICTED — PREPARE ONLY | Execution                                                                                                                                                                                                                                                                                                                                                 | User                                             |
| 3. No open P0 / P1 defects                                             | Convention D-62. No confirmed S1 / S2. Register in §10                                                                                                                  | USER DECISION REQUIRED    | Classify M-1 (SEC-F02 was classified S2 and fixed on 2026-11-24, §19). DB-P1 needs DEC-12                                                                                                                                                                                                                                                                 | User                                             |
| 4. Security checklist self-assessment complete                         | 142 controls assessed; draft _(after D1: 72 tested, 16 gaps — §19)_                                                                                                     | USER DECISION REQUIRED    | Review and accept or return the draft. 17 gaps and 14 blocked controls listed                                                                                                                                                                                                                                                                             | User                                             |
| 5. Client written approval                                             | None                                                                                                                                                                    | NOT STARTED               | Written approval after criteria 1–4                                                                                                                                                                                                                                                                                                                       | User / client                                    |
| Deliverable: CI/CD                                                     | Workflow file exists; local gates pass on Node 24                                                                                                                       | BLOCKED                   | A CI run on Node 22 (needs a Git push, USR-06); Node line (DEC-18)                                                                                                                                                                                                                                                                                        | User                                             |
| Deliverable: staging releases                                          | None                                                                                                                                                                    | BLOCKED                   | Hosting decision (DEC-08)                                                                                                                                                                                                                                                                                                                                 | User                                             |
| Deliverable: runbook drafts                                            | Runbook checked against the code; refund procedure §9.1                                                                                                                 | PARTIAL                   | `SENDING` procedure; refund recovery when no refund was issued                                                                                                                                                                                                                                                                                            | User decision, then documentation                |
| Batch acceptance register                                              | Batch 9 and Batch 10 complete                                                                                                                                           | USER DECISION REQUIRED    | Accept or reject each                                                                                                                                                                                                                                                                                                                                     | User                                             |
| Database gates G2, G3, G7, G8                                          | G2 Step 0 PASS                                                                                                                                                          | BLOCKED                   | G2 from Step 1; G3; G7; G8                                                                                                                                                                                                                                                                                                                                | User                                             |

_(Clarification 2026-11-27, rows 2b and 3 — both are kept as written. DEC-12 is decided: the six concurrency cases are mandatory G4 evidence and have not been executed. GST-15 is outside DEC-12 and requires a separate owner decision. "DB-P1 needs DEC-12" now means that DB-P1 needs the TC-041 evidence; no DEC-12 decision is pending. Details: §23.)_

**Assessment: G4 is NOT MET.** Criteria 1 to 4 each have an open item that only you can close, and
criterion 5 has not started. The offline engineering work that was authorized is complete.

## 15. Remaining blockers

1. **Real-database evidence does not exist.** Six P1 concurrency cases, GST-15 and every
   MySQL-specific behaviour are unverified. This chain is G2 → G3 → F5 → G7 → DEC-12. _(Clarification 2026-11-27: the last link of this chain is no longer a pending decision. DEC-12 is decided; what remains after G7 PASS is a separate explicit written owner authorization and then the execution of the six scenarios. GST-15 is outside DEC-12 — §23.)_
2. **Eleven "Must" requirements are partial** with neither an implementation authorization nor an
   approved deferral.
3. **SEC-F02 and M-1 are unclassified**, so criterion 3 cannot be stated as met. _(Update 2026-11-24: SEC-F02 is classified S2 and fixed, §19. M-1 is still unclassified.)_
4. **The security self-assessment is a draft** until you accept it.
5. **No CI evidence** on the supported Node line, and no hosting decision for staging.
6. **Batch 9 and Batch 10 are not accepted.** _(Resolved 2026-11-24: both accepted, offline mocked scope only — §20.)_
7. **External providers** (payment, e-mail, WhatsApp, Cloudinary) are mock-only: Phase 7.

## 16. User-only action checklist

Nothing below was done or assumed.

**Acceptance**

- [x] ACC-02: accept or reject Batch 9, with the risk acknowledgement. _(Accepted 2026-11-24 — §20.)_
- [x] ACC-B10: accept or reject Batch 10. _(Accepted 2026-11-24 — §20.)_
- [ ] SEC-ACC: review the security self-assessment draft; accept or return it.

**Decisions**

- [x] SEC-F02: classify the severity; authorize the start-up refusal of the mock provider (recommended). _(Done 2026-11-24, D1 — §19.)_
- [ ] M-1: confirm S3 or raise to S2.
- [ ] DEC-06-impl: authorize the promotions guard or not; decide whether a paused promotion past its end date counts as expired (OD-02).
- [ ] DEC-08: hosting.
- [ ] DEC-10: `.env.example` annotation.
- [ ] DEC-12: authorize real-database execution (recommended after G7). _(Clarification 2026-11-27: the requirement part of DEC-12 is decided — real MySQL verification of the six scenarios is mandatory for G4. The execution authorization named in this item is separate and has not been given — §23.)_
- [ ] DEC-13a: approve or reject the proposed deferrals DEF-A1 … A5 and DEF-B1 … B3. _(Partly done 2026-11-24: DEF-A1 approved under D6. The other seven are open.)_
- [ ] DEC-13b: FR-PRM-004, FR-PL-013, FR-TAX-013 — implement or defer; obtain the tax professional's answer for FR-TAX-013.
- [ ] DEC-13c: logging of direct authentication e-mails (FR-NTF-005).
- [ ] DEC-13d: FR-AD-008 leftovers — authorize the small change or accept as partial.
- [ ] DC-04, DC-05, DC-06 and OD-03, OD-05, OD-06, OD-07, OD-09, OD-10 (`PHASE4-REMAINING-USER-DECISIONS.md` §6).
- [ ] DEC-18: Node line (22 only, or 22 and 24).

**Execution**

- [ ] G2 backup / restore drill, from Step 1.
- [ ] G3 restricted database setup.
- [ ] G7 and G8 real-database activities (each needs your explicit authorization).
- [ ] Real-database test run, following `tests/db/README.md`.
- [ ] Git commit and push, so that CI runs.
- [ ] `npm audit`.
- [ ] Deployment (not before the items above).

**Final**

- [ ] Client written approval of G4.

## 17. Recommended next steps

In order of leverage:

1. **Decide SEC-F02 and authorize its fix.** _(Done 2026-11-24 — §19.)_ It is small, it removes the one finding that could be
   read as a P1, and it should not wait for a real provider.
2. **Accept or reject Batch 9 and Batch 10.** _(Done 2026-11-24 — §20.)_ Both have complete evidence for offline mocked scope.
3. **Answer DEC-13.** Approving the eight proposed deferrals and deciding the four open
   requirements settles criterion 1 and most of criterion 2.
4. **Continue G2 from Step 1**, then G3. Everything that needs a database waits on this chain.
5. **Push a branch** so that CI runs on Node 22.
6. **After G7, authorize DEC-12** and run TC-041 early: it tests the one predicted concurrency
   defect. _(Clarification 2026-11-27: "authorize DEC-12" here means giving the separate explicit written authorization to execute the scenarios. DEC-12 itself was decided on 2026-11-27 and does not authorize execution; G7 PASS alone does not either — §23.)_
7. **Review the security draft** and choose the hosting option; these unlock criterion 4 and the
   staging deliverable.

Until then: **Phase 4 is IN PROGRESS — NOT APPROVED, G4 is NOT MET, and production readiness is
NOT ESTABLISHED.**

## 18. Addendum 2026-11-24 — final closure review (read-only)

Added after an independent re-check of this report, the remaining-decisions list and the tracker
against the current code. Sections 1–17 are kept as written. No source, test or configuration file
was changed by this review; no status changed. **G4 is NOT MET; Phase 4 is IN PROGRESS — NOT
APPROVED.**

### 18.1 Verified facts that correct or extend sections 1–17

| #   | Section          | Correction or addition (verified in the current tree)                                                                                                                                                                                                                                                                                                         |
| --- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | §14, criterion 1 | A comparison of every `METHOD /path` in API_DOCUMENTATION (202 distinct) with the 248 OpenAPI operations finds four documented operations with no implementation, not two: `POST /webhooks/email`, `POST /webhooks/whatsapp`, `GET /webhooks/whatsapp` (verification handshake) and `GET /api/v1/openapi.json`. The last one was not recorded anywhere before |
| 2   | §10              | "No tests for the strict-environment rules" was too broad. `tests/unit/core/env.test.ts` tests `https`, rate limiting and plain logs for production and staging. Not tested: required secrets, `COOKIE_SECURE`, and the webhook refusal of the mock in production                                                                                             |
| 3   | §10              | The mock-provider finding is control PW-08 / finding A9-F02 in the security draft. "SEC-F02" is this report's label for it, not a decision ID. The same applies to "DB-P1" (coupon concurrency prediction)                                                                                                                                                    |
| 4   | §10              | Additional facts on PW-08: the container always builds the mock adapter and never passes a client-signature secret from configuration; the mock reports `CAPTURED` for any payment id without a `mock_fail_` / `mock_pending_` prefix; two existing tests load a production configuration with the mock provider                                              |
| 5   | §12              | Anonymous catalogue responses are sent with `Cache-Control: public, max-age=60, stale-while-revalidate=300` (`src/modules/catalog/index.ts`). The DEC-13 traceability report said no cache header is set. This matters for FR-PRM-004                                                                                                                         |
| 6   | §13              | The authoritative Batch 9 review lists 15 risks and requires acknowledgement of 11 (RK-01 … RK-10, RK-13). Earlier summaries said "nine risks". RK-14 was corrected by the scheduler fix                                                                                                                                                                      |
| 7   | §16              | "Git commit and push, so that CI runs": the workflow runs only on a push to `main` or `develop`, or on a pull request targeting them                                                                                                                                                                                                                          |
| 8   | §16              | "G7 and G8 real-database activities": G7 is the baseline migration on the scratch database and G8 the migration on `ecommerce_dev`. Seed execution is a separate step after G8. No step-by-step seed procedure exists yet                                                                                                                                     |
| 9   | —                | `operations/CI-CD-AND-DEPLOYMENT-PREPARATION.md` §8 still shows the baseline results (lint and format failing, 113 files). The current results are in §7 and §9 of this report. That document has not been corrected yet                                                                                                                                      |

### 18.2 Proposals (not approved, not implemented)

- **Mock payment provider:** recommended severity S2 (S1 if a production deployment existed) and a
  three-file fix with eight tests. Plan: `PHASE4-FINAL-SECURITY-REVIEW-AND-REMEDIATION-PLAN.md` §1. _(Approved as D1 and implemented on 2026-11-24 — §19.)_
- **M-1:** recommended S3 for G4 with a formal deferral of the recovery action to the
  payment-provider integration and a go-live condition.
- **Requirements:** FR-AD-008 leftovers — implement; FR-PRM-004 — implement the display part;
  FR-PL-013 — implement the plain extension; FR-TAX-013 — tax professional first, defer until
  then; delivery webhooks — defer (DEF-A1, extended); OpenAPI-serving route — re-word the document. _(Decided 2026-11-24: the webhook deferral was approved as D6; for the OpenAPI-serving route the owner approved a formal deferral, D7, not a re-wording alone — §21.)_
- Exact decision wording for each: `PHASE4-FINAL-OWNER-DECISION-PACKAGE.md`.

### 18.3 Documents added by this review

- `PHASE4-FINAL-OWNER-DECISION-PACKAGE.md`
- `PHASE4-FINAL-SECURITY-REVIEW-AND-REMEDIATION-PLAN.md`
- `PHASE4-OWNER-EXECUTION-RUNBOOK.md`
- `PHASE4-G4-CRITERIA-AND-EVIDENCE-MATRIX.md`

## 19. Addendum 2026-11-24 — D1 implemented and locally verified

Sections 1–18 are kept as written; they describe the state before this change. Dated notes in
§10 and §14–§18 point here.

**Decision (owner, 2026-11-24, D1 only):** "I classify PW-08 / A9-F02 as S2 and authorize the fix in the security plan §1.5 Option B with the tests in §1.6."

### 19.1 Exact changed files

| Kind   | File                                                         | Change                                                                                                  |
| ------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Source | `src/container.ts`                                           | Start-up refusal: `ConfigError` when the environment is production and the payment provider is the mock |
| Source | `src/bootstrap.ts`                                           | The refusal becomes one fatal log line and exit code 1, for the API and the worker                      |
| Source | `src/modules/payments/payments.service.ts`                   | `POST /payments/verify` refuses the mock in production (503)                                            |
| Source | `src/integrations/payments/paymentProvider.ts`               | Comment only                                                                                            |
| Test   | `tests/unit/core/container.test.ts`                          | 6 cases added                                                                                           |
| Test   | `tests/integration/modules/payments/payments.routes.test.ts` | 3 cases added                                                                                           |
| Test   | `tests/unit/bootstrap.test.ts`                               | New file, 5 cases                                                                                       |

No existing test was changed. No schema, dependency, lockfile, OpenAPI, seed or environment file
was changed.

### 19.2 Before and after

| Evidence                                                                             | Before D1 (§7–§9)               | After D1                             |
| ------------------------------------------------------------------------------------ | ------------------------------- | ------------------------------------ |
| Test files                                                                           | 119                             | 120                                  |
| Tests                                                                                | 3,110 passed, 3 todo, 0 failed  | 3,124 passed, 3 todo, 0 failed       |
| Coverage: statements / branches / functions / lines                                  | 92.08 / 82.63 / 94.70 / 93.81 % | 92.11 / 82.69 / 94.74 / 93.86 %      |
| `format:check`, `lint`, `typecheck`, `build`, `openapi:check`                        | PASS                            | PASS                                 |
| Focused tests (container, bootstrap, payments routes)                                | —                               | 3 files, 40 passed                   |
| Production start with the mock payment provider                                      | Starts                          | Exits with code 1                    |
| `POST /payments/verify` with a signed mock callback under a production configuration | Order confirmed as paid         | 503, nothing written                 |
| Security self-assessment                                                             | TESTED 71, GAP 17               | TESTED 72, GAP 16 (PW-08 reassessed) |

**Mutation checks (scratch copies):** each of the three guards was removed in turn; the matching
test failed each time (container: 2 failed; bootstrap: 2 failed; `verify` guard: 1 failed, "expected
200 to be 503"; webhook guard: 1 failed, "expected 200 to be 404"). The unchanged copies passed.

All of this is local evidence on Node 24.12.0 with a mocked database.

### 19.3 Security findings after D1

| Item                                                                   | Status                                                             |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Mock payment provider in production (PW-08 / A9-F02; "SEC-F02" in §10) | **RESOLVED.** Classified S2 by the owner; fixed; tested with mocks |
| M-1 refund interrupted after commit                                    | Open; awaits the owner's classification                            |
| Coupon over-redemption under concurrency                               | Prediction only; untested (needs DEC-12)                           |
| Promotion revived by a date edit (D-63)                                | Open; guard not authorized                                         |
| The other 16 gaps of the self-assessment                               | Open, unchanged                                                    |

_(Clarification 2026-11-27, row "Coupon over-redemption under concurrency" — "needs DEC-12" is the 2026-11-24 wording. DEC-12 is decided; the item is still untested because TC-041 has not been executed. Coupon hardening remains NOT AUTHORIZED — §23.)_

### 19.4 G4 blocker status after D1

| Criterion                                     | Status                                                                                                                              |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1. Endpoints implemented or formally deferred | Unchanged: not met                                                                                                                  |
| 2. "Must" criteria pass in automated tests    | Unchanged: not met                                                                                                                  |
| 3. No open P0 / P1 defects                    | **Improved, still not confirmed.** The only item recommended as a P1 is closed. M-1 is unclassified and the coupon case is untested |
| 4. Security self-assessment complete          | Unchanged: draft awaits acceptance (it now shows 16 gaps)                                                                           |
| 5. Client written approval                    | Unchanged: not started                                                                                                              |

### 19.5 Still outstanding for this fix

- A CI run on Node 22 (none exists).
- Verification with a real process started under a production configuration (none was started).
- A real payment provider (Phase 7). Until then no production process can start.

**G4 is NOT MET. Phase 4 is IN PROGRESS — NOT APPROVED.** Batch 9 and Batch 10 are not accepted _(both were accepted later on 2026-11-24 — §20)_. No
deferral is approved. Decisions D2 – D17 of the decision package are open.

## 20. Addendum 2026-11-24 — Batch 9 and Batch 10 accepted (offline mocked scope only)

Sections 1–19 are kept as written. This addendum records a decision by the owner; no source or
test file changed with it.

| Batch                                           | Status before                                               | Status now                                                   |
| ----------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------ |
| Batch 9 (dedicated worker, D-61)                | COMPLETE — PENDING USER ACCEPTANCE                          | **ACCEPTED — OFFLINE MOCKED SCOPE ONLY** (owner, 2026-11-24) |
| Batch 10 (WP10-1 … WP10-6, scheduler fix, D-65) | Implemented and verified (mocked) — PENDING USER ACCEPTANCE | **ACCEPTED — OFFLINE MOCKED SCOPE ONLY** (owner, 2026-11-24) |

Basis: `PHASE4-BATCH9-BATCH10-FINAL-ACCEPTANCE-RECONCILIATION.md`.

**Batch 9 — the owner's words (verbatim):**

> Batch 9 (dedicated background worker, D-61): ACCEPTED — OFFLINE MOCKED SCOPE ONLY.
>
> I acknowledge RK-01, RK-02, RK-03, RK-04, RK-05, RK-06, RK-08, RK-09, RK-10 and RK-13 exactly as
> described in the proposed acceptance statement.
>
> I note RK-07 and RK-14 as corrected through Batch 10, RK-11 and RK-12 as deferred items, RK-15 as
> an open business decision, and L-2 and L-3 as open audit low findings.
>
> This acceptance does not approve any deferral, classify M-1, establish multi-server safety,
> establish real MySQL or production readiness, meet G4, or approve Phase 4.

**Risks acknowledged for Batch 9** (as described in the proposed statement,
`PHASE4-BATCH9-BATCH10-FINAL-ACCEPTANCE-RECONCILIATION.md` §5 A):

1. RK-01 — Single worker by discipline only; no lock / runtime enforcement.
2. RK-02 — Two workers duplicate every scheduled job.
3. RK-03 — Forced termination can leave notifications in `SENDING`; no auto-recovery, and no
   manual procedure is written.
4. RK-04 — M-1: a gateway refund stays `PROCESSING` after an interruption, in five code paths
   (worker late capture, staff approval, customer self-cancel, API late capture, admin retry); no
   automatic recovery; recovery is undefined if no refund was issued. The manual procedure is
   runbook §9.1.
5. RK-05 — Premature "refund initiated" notifications in staff approval and customer self-cancel.
6. RK-06 — The 60 s forced exit can interrupt a running job and post-commit side effects.
7. RK-08 — No real OS-signal integration test.
8. RK-09 — No real MySQL or two-process concurrency test. The prepared harness has not been
   executed and does not cover two processes.
9. RK-10 — No production or deployment verification.
10. RK-13 — Limited unit coverage of process entry and exit paths: `worker.ts` is not covered and
    `bootstrap.ts` is partly covered.

**Noted for Batch 9, not acknowledged as open risks:**

- RK-07 (the registry wiring now has tests) and RK-14 (the scheduler comment and start log are
  corrected): corrected through Batch 10.
- RK-11 (no worker health endpoint) and RK-12 (no Redis / BullMQ / multi-server scheduling — the
  system is not multi-server safe): deferred items.
- RK-15 (late-capture refunds send no `REFUND_INITIATED`, OQ-59): open business decision.
- L-2 (signal handlers are registered after the start-up database connect) and L-3 (the forced-exit
  timer is `unref()`'d): open audit low findings.

**Batch 10 — the owner's words (verbatim):**

> Batch 10 (WP10-1 to WP10-6 and the scheduler fix, D-65): ACCEPTED — OFFLINE MOCKED SCOPE ONLY.
>
> I acknowledge all six limitations described in the proposed Batch 10 acceptance statement,
> including the mocked evidence, notification/error-reporting limitations, refund reconciliation
> limitations, OpenAPI barcode content-type discrepancy, and settings-seed dependency.
>
> This acceptance does not establish real MySQL concurrency, real-provider integration, CI,
> deployment or production readiness. It does not approve any deferral, meet G4, or approve
> Phase 4.

**Limitations acknowledged for Batch 10** (as described in the proposed statement, same document
§5 B):

1. All evidence is mocked: mocked database, mock payment gateway. The cart and reconciliation
   tests are not evidence of MySQL locking, isolation or concurrency.
2. WP10-1 proves the registry wiring with mocked job modules, not the behaviour of the jobs.
3. WP10-2: per-product errors in the two catalogue jobs are logged and counted; the run still ends
   as a normal run and nothing alerts.
4. WP10-3: a failed late-capture refund is not counted in the job summary, and a failure while
   recording a refund result leaves the refund `PROCESSING`.
5. WP10-4: the variant barcode image is still documented as JSON in the OpenAPI specification
   (DC-05).
6. WP10-5: the best-seller window is 90 days until the settings seed runs, and a database error
   while reading the setting fails the run.

No defect was found by the Batch 10 tests.

**What the acceptances do not cover.** Neither acceptance covers MySQL behaviour, real operating-system signals, two worker processes,
real providers, CI, deployment, multi-server operation or production readiness. Neither approves a
deferral, classifies M-1, meets G4 or approves Phase 4.

### 20.1 Effect on G4

| Item                                                     | After the acceptances                                                               |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Batch acceptance register (§14, last-but-one row)        | Complete for Batches 7, 8, 9 and 10                                                 |
| Criterion 1 — endpoints implemented or formally deferred | Unchanged: not met                                                                  |
| Criterion 2 — "Must" criteria pass in automated tests    | Unchanged: not met                                                                  |
| Criterion 3 — no open P0 / P1 defects                    | Unchanged: not confirmed (M-1 unclassified; coupon-concurrency prediction untested) |
| Criterion 4 — security self-assessment                   | Unchanged: draft, not accepted                                                      |
| Criterion 5 — client written approval                    | Unchanged: not started                                                              |

Batch acceptance is not a G4 exit criterion. The acknowledged risks stay open.

**G4 is NOT MET. Phase 4 is IN PROGRESS — NOT APPROVED.** No deferral is approved. Decisions
D2 – D11 and D14 – D17 of the decision package are open.

## 21. Addendum 2026-11-24 — D6 and D7 approved (formal deferrals)

Sections 1–20 are kept as written. This addendum records two decisions by the owner; no source or
test file changed with them.

| Decision                                                                                                        | Status before                          | Status now                                                                                       |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| D6 — e-mail and WhatsApp webhooks (`POST /webhooks/email`, `POST /webhooks/whatsapp`, `GET /webhooks/whatsapp`) | Deferral DEF-A1 proposed, not approved | **Formal deferral approved** to Phase 7, with the dependent behaviour and one condition          |
| D7 — `GET /api/v1/openapi.json`                                                                                 | Open                                   | **Formal deferral approved**; the committed, drift-checked specification file stands for Phase 4 |

Exact wording and scope: `PHASE4-REMAINING-USER-DECISIONS.md` §3.1 and
`PHASE3-PHASE4-MASTER-PROGRESS-REPORT.md` §19.

| G4 criterion                                                   | After D6 and D7                                                                                                                                                   |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Endpoints implemented or formally deferred (§14, first row) | No documented operation is known to be both unimplemented and undeferred. Method-and-path check only; not independently verified; one shape mismatch open (DC-05) |
| 2. "Must" criteria pass in automated tests                     | Unchanged: not met                                                                                                                                                |
| 3. No open P0 / P1 defects                                     | Unchanged: not confirmed                                                                                                                                          |
| 4. Security self-assessment                                    | Unchanged: draft, not accepted                                                                                                                                    |
| 5. Client written approval                                     | Unchanged: not started                                                                                                                                            |

Publishing the specification as a release artefact remains **not verified**.

**G4 is NOT MET. Phase 4 is IN PROGRESS — NOT APPROVED.** Decisions D2 – D5, D8 – D11 and D14 – D17
are open. Proposed deferrals DEF-A2 … DEF-A5 and DEF-B1 … DEF-B3 are not approved.

## 22. Addendum 2026-11-24 — autonomous execution run (later the same day)

The run is recorded in `PHASE3-PHASE4-MASTER-PROGRESS-REPORT.md` §20. In short: one S4 defect fixed
(public ETag), 113 test cases added, an independent API contract audit completed, two
security-hygiene items prepared (CI coverage step, `.dockerignore`), and stale status statements
annotated. Full suite: 126 files, 3,237 passed, 2 todo, 0 failed; coverage statements 92.77 %, branches 84.07 %, functions 95.80 %, lines 94.32 %.

Sections 1 – 21 above are unchanged. Where they give test totals, traceability counts or the number
of security gaps, the newer figures are: tested 226 / no test 0 / partial 11 / blocked 2; security
controls TESTED 74, GAP 14.

_(Clarification 2026-11-27: "GAP 14" is a draft count, not accepted (D11). It includes two reassessments not approved by the owner (SH-10 and CS-03, from GAP to PREPARED); without them the count is 16.)_

**G4 is NOT MET. Phase 4 is IN PROGRESS — NOT APPROVED.** Decisions D2 – D5, D8 – D11 and D14 – D17
are open. Proposed deferrals DEF-A2 … DEF-A5 and DEF-B1 … DEF-B3 are not approved.

## 23. Addendum 2026-11-27 — DEC-12 decided (documentation clarification)

Sections 1 – 22 are kept as written. Each is the record of its date, and none of their test results is changed. This addendum states how their DEC-12 references must now be read. Record of the decision: `PHASE4-FINAL-OWNER-DECISION-PACKAGE.md`, D10; summary in `PHASE3-PHASE4-MASTER-PROGRESS-REPORT.md` §21.

- **DEC-12 is decided (owner, 2026-11-27).** Real MySQL verification of all six concurrency scenarios — TC-004, TC-030, TC-041, TC-045, TC-048 and TC-051 — is mandatory G4 evidence.
- **The six scenarios are PREPARED — NOT EXECUTED.** No real-MySQL evidence exists. None may be claimed until the scenarios have actually been executed and their results reviewed.
- **Execution prerequisites.** G7 PASS is a prerequisite. G7 PASS alone does not authorize execution. A separate explicit written authorization from the owner is also required. Where sections 1 – 22 say "DEC-12 authorization" or "authorize DEC-12" (§11, §16, §17), they mean that separate authorization, which has not been given.
- **GST-15 is outside DEC-12** and requires a separate owner decision. Where sections 1 – 22 place GST-15 under DEC-12 (§7, §14, §15), that is the wording of 2026-11-24. GST-15 is not approved, deferred, implemented or verified.
- **DB-P1** is this report's label for the coupon over-redemption prediction. It no longer waits on a decision. It is untested because TC-041 has not been executed. TC-041 is the real-database evidence scenario for FR-CPN-008 / AC-03.
- **Coupon hardening remains NOT AUTHORIZED** until the TC-041 evidence has been reviewed and a separate owner decision is made.
- **Not authorized by DEC-12:** G2, G3, G7 or G8 operations, seeds, staging, or any unrelated database operation. G2 and G3 statuses are unchanged.

**Statuses, unchanged:** Phase 4 IN PROGRESS — NOT APPROVED · G4 NOT MET · G2 USER EXECUTION IN PROGRESS — NOT ACCEPTED · G3 NOT ACCEPTED · G7 NOT AUTHORIZED · G8 NOT AUTHORIZED · six scenarios PREPARED — NOT EXECUTED · production readiness NOT ESTABLISHED. The closing line of §22 lists "D8 – D11" as open; as of 2026-11-27, D8, D9 and D11 are open and DEC-12 (reply label D10) is decided.
