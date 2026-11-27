# Phase 4 — Master Completion Roadmap

| Field          | Value                                                                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Document ID    | P4-MASTER-ROADMAP-01                                                                                                                      |
| Date           | 2026-11-20. §1–§20 are the record of that date and are kept as written; updates of 2026-11-24 are in §21–§21.2 and of 2026-11-27 in §21.3 |
| Nature         | **Audit and planning only.** Nothing here authorizes implementation, gate execution or acceptance.                                        |
| Phase 4 status | **IN PROGRESS — NOT APPROVED** (Gate G4 NOT MET)                                                                                          |
| Companion      | `docs/PHASE4-MASTER-COMPLETION-ROADMAP-AUDIT-REPORT.md` (sources, contradictions, validation)                                             |

Status vocabulary: COMPLETE · ACCEPTED · IN PROGRESS · PENDING REVIEW · PENDING USER APPROVAL · PENDING USER
EXECUTION · BLOCKED · DEFERRED · UNKNOWN. **COMPLETE is not ACCEPTED.**

---

## 1. Executive summary

- **What "Phase 4 complete" means.** It is defined by **Gate G4** in
  `project-documentation/10-project-management/IMPLEMENTATION_ROADMAP.md` _(Canonical location, verified 2026-11-24. From 2026-11-21 until 2026-11-24 the file sat in `02-architecture/`; it was moved back on the owner's authorization and its content is unchanged.)_ (Phase 4 table, rows "Scope",
  "Deliverables", "Exit criteria / Gate G4"):
  - all endpoints in API_DOCUMENTATION.md implemented or formally deferred;
  - all FR "Must" API-side acceptance criteria pass in automated tests;
  - no open P0/P1 defects;
  - security checklist self-assessment complete;
  - **client written approval**.

  The scope and deliverables also name CI/CD, `dev`/`staging` environments, API releases on staging,
  OpenAPI per release, test reports (≥ 80 % services coverage) and runbook drafts.

- **What is done.** The offline implementation is far advanced:
  - every API_DOCUMENTATION endpoint heading (80) is implemented; 248 operations in total;
  - **104 test files / 1,344 tests pass** with **mocked** dependencies (Batch 9 run, 2026-11-20);
  - Batch 7 and Batch 8 + M1 are **ACCEPTED (offline mocked scope only)**.
- **What is missing.**
  - No database work has run: the baseline is not applied (G2 pending, G3 not accepted, F5 not started,
    G7/G8 not authorized).
  - Many earlier deliverables are COMPLETE but **not yet accepted** (B0-c, B1, B2–B9, hardening round,
    autonomous round, Batches 4–6, G2/G3 review round).
  - Batch 9 is pending acceptance; its mandatory documentation correction has **not** been made.
  - The G4 evidence package does not exist: FR traceability, security self-assessment, P0/P1 defect
    register, staging release.
- **Not countable yet.** A reliable total of remaining _work_ cannot be stated. The size of the FR "Must"
  API-side traceability task (257 "M" rows across all repos; API-side subset unidentified) and of
  Batch 10 / Batch 12 (not yet reviewed or approved) is **not yet measurable**. §4 tracks **92 items**:
  12 DOC, 1 B10-REV, 12 IMP, 6 QA, 9 DB, 5 EXT, 7 SEC, 19 DEC, 8 USR, 8 DEF (deferred, non-blocking
  unless you decide otherwise), 5 ACC. That is a count of tracked items, not of effort.
- **Production readiness: NOT ESTABLISHED.**

## 2. Verified current status

| Area                                                                             | Status                                                                                                                              | Evidence (file › section)                                                                                  |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Phases 1–3                                                                       | APPROVED — COMPLETE                                                                                                                 | `IMPLEMENTATION_ROADMAP.md` phase table rows 1–3; master report §1 "Phase 3"                               |
| Phase 4                                                                          | IN PROGRESS — NOT APPROVED; G4 NOT MET                                                                                              | master report `docs/PHASE3-PHASE4-MASTER-PROGRESS-REPORT.md` §1 rows "Phase 4", "G4 (Phase 4 exit)"        |
| B0-a                                                                             | ACCEPTED (APPROVED 2026-11-16)                                                                                                      | master report §1                                                                                           |
| Increment A                                                                      | VERIFIED (PASS, live evidence 2026-11-17)                                                                                           | master report §1                                                                                           |
| G6 (baseline SQL review)                                                         | ACCEPTED (2026-11-17)                                                                                                               | master report §1; `INCREMENT-B-G6-RE-REVIEW-ACCEPTANCE.md`                                                 |
| Baseline migration file                                                          | Unchanged since 2026-11-17; SHA-256 = `154D2C8E…A7A6BB` (**re-verified 2026-11-20 by local hash**)                                  | `prisma/migrations/20261117160425_baseline/migration.sql`; `INCREMENT-B-MASTER-ROADMAP-G2-G8.md` "Gate G7" |
| B0-b part 2                                                                      | IN PROGRESS (code done; seed run and DB readiness blocked by G8)                                                                    | master report §1                                                                                           |
| B0-c, B1, B2–B9                                                                  | COMPLETE — NOT YET ACCEPTED                                                                                                         | master report §1                                                                                           |
| Hardening round; G2/G3 review round; autonomous round (batches 1–3); Batches 4–6 | COMPLETE — NOT YET ACCEPTED                                                                                                         | master report §1, §10–§11                                                                                  |
| Batch 7                                                                          | ACCEPTED — OFFLINE MOCKED SCOPE ONLY                                                                                                | master report §1, §12                                                                                      |
| Batch 8 + M1                                                                     | ACCEPTED — OFFLINE MOCKED SCOPE ONLY                                                                                                | master report §1, §13–§14; `PHASE4-BATCH8-*` reports                                                       |
| RD-12 / D-61                                                                     | ARCHITECTURE APPROVED (single dedicated worker; multi-server deferred; no Redis/BullMQ)                                             | `PROJECT_CONTEXT.md` §17.7 D-61; `PHASE4-REMAINING-DECISIONS.md` RD-12                                     |
| Batch 9                                                                          | COMPLETE — PENDING USER ACCEPTANCE; audit verdict "ACCEPT AFTER DOCUMENTATION CORRECTIONS"                                          | `PHASE4-BATCH9-COMPLETION-REPORT.md` §8; `PHASE4-BATCH9-INDEPENDENT-AUDIT-REPORT.md` §1, §12               |
| Batch 9 documentation corrections                                                | **NOT DONE**: no correction report exists, and no authorization for them is recorded                                                | `docs/` directory listing; audit report §11                                                                |
| Batch 10                                                                         | NOT AUTHORIZED; scope **proposed only** ("Batch 7 review follow-ups, plus the best-seller setting"); **no technical review exists** | `PHASE4-BATCH8-COMPLETION-REPORT.md` §11; `PHASE4-BATCH9-TECHNICAL-REVIEW-AND-IMPLEMENTATION-PLAN.md` §7   |
| Batch 11                                                                         | **Proposed only** ("documentation sync")                                                                                            | `PHASE4-BATCH8-COMPLETION-REPORT.md` §11                                                                   |
| Batch 12                                                                         | **Proposed only** ("MySQL integration suite"); pending G7/G8; no plan document                                                      | `PHASE4-BATCH8-COMPLETION-REPORT.md` §11; master report §14, §16                                           |
| Batch 13                                                                         | **UNKNOWN: not defined in any repository document**                                                                                 | full-text search of `ecommerce-api/docs` and `project-documentation`                                       |
| G2                                                                               | PENDING USER EXECUTION (Step 0 PASS, Step 1 NOT VERIFIED)                                                                           | `G2-EXECUTION-LOG.md`; master report §1                                                                    |
| G3                                                                               | NOT ACCEPTED (procedure v1.2.1 reviewed; execution needs approval)                                                                  | master report §1; `INCREMENT-B-G3-CASE-A-EXECUTION-PROCEDURE.md`                                           |
| F5                                                                               | NOT STARTED                                                                                                                         | master report §1                                                                                           |
| G7 / G8                                                                          | NOT AUTHORIZED                                                                                                                      | master report §1                                                                                           |
| Storefront / admin repos                                                         | NOT STARTED (Phases 5 / 6)                                                                                                          | master report §1; `IMPLEMENTATION_ROADMAP.md` phases 5–6                                                   |
| Production readiness                                                             | NOT ESTABLISHED                                                                                                                     | all reports                                                                                                |

## 3. Completed and accepted work

**ACCEPTED** (by explicit user decision, as recorded):

- B0-a.
- Increment A (verified).
- G6.
- Batch 7 (offline mocked scope).
- Batch 8 + M1 (offline mocked scope).
- Documentation tasks after Batch 8: synchronization, alignment, final consistency, and RD-12 + token
  cleanup (master report §14–§15).
- D-61 (architecture).

**COMPLETE but NOT ACCEPTED** (implementation present; acceptance outstanding, see ACC-03 and ACC-04):

- B0-c, B1, B2–B9.
- Hardening round, G2/G3 review round.
- Autonomous round (batches 1–3), Batches 4–6.
- Batch 9.

## 4. Pending work inventory

Columns: ID · Task · Batch/area · Status · Depends on · User approval? · User execution? · Blocks Phase 4 (G4)?

### A. Documentation corrections

| ID     | Task (source)                                                                                                                                                                                                                                                                                                                                                                                                            | Batch | Status                | Depends on | Approval        | Execution | Blocks G4                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | --------------------- | ---------- | --------------- | --------- | --------------------------------------------- |
| DOC-01 | Correct the refund-retry statement: an interrupted post-commit refund stays `PROCESSING` (_state corrected 2026-11-20 from `APPROVED`_) and is **not** retryable (retry accepts `FAILED` only). Files: `PHASE4-BATCH9-COMPLETION-REPORT.md` §6 item 4; `PHASE4-BATCH9-TECHNICAL-REVIEW-AND-IMPLEMENTATION-PLAN.md` §4 item 9 (audit D-1, M-1)                                                                            | 9     | PENDING USER APPROVAL | —          | Yes             | No        | Yes (blocks Batch 9 acceptance per audit §12) |
| DOC-02 | `REPOSITORY_SETUP_GUIDE.md` §6.2 scripts table, `dev:worker` purpose "BullMQ worker process" → current D-61 worker (audit D-2)                                                                                                                                                                                                                                                                                           | 9     | PENDING USER APPROVAL | —          | Yes (canonical) | No        | No (recommended)                              |
| DOC-03 | `REPOSITORY_SETUP_GUIDE.md` troubleshooting row (Mailpit `:8025`) and Day-1 checklist (`npm run db:up`): emails go to the fake adapter in the worker; `JOBS_ENABLED=true` needed (audit D-3)                                                                                                                                                                                                                             | 9     | PENDING USER APPROVAL | —          | Yes             | No        | No                                            |
| DOC-04 | `BACKEND_STRUCTURE.md` §3 tree (`worker.ts # BullMQ…`), §3.1 "Process types", §14 intro "Redis lock": add a D-61 note (current = single worker, in-process scheduler) (audit D-4)                                                                                                                                                                                                                                        | 9     | PENDING USER APPROVAL | —          | Yes             | No        | No                                            |
| DOC-05 | `ecommerce-api/README.md` "Project structure": add `worker.ts`, `workerRuntime.ts`, `bootstrap.ts`, `jobs/` (audit D-5)                                                                                                                                                                                                                                                                                                  | 9     | PENDING USER APPROVAL | —          | Yes             | No        | No                                            |
| DOC-06 | Master report §1 row "RD-12 (job architecture)" still says "Implementation NOT AUTHORIZED — worker not implemented"; it contradicts row "Batch 9"                                                                                                                                                                                                                                                                        | 9     | PENDING USER APPROVAL | —          | Yes             | No        | No                                            |
| DOC-07 | `IMPLEMENTATION_ROADMAP.md` Phase 4 status (phase-table row 4 "B0-b … B9 not started"; Phase 4 "Status" row) is stale versus the master report                                                                                                                                                                                                                                                                           | —     | PENDING USER APPROVAL | —          | Yes (canonical) | No        | No (but required for an accurate G4 record)   |
| DOC-08 | `PHASE4-G4-REVIEW-REPORT.md` (2026-11-17) is stale ("B1–B9 not started"); supersede or refresh as part of the G4 package                                                                                                                                                                                                                                                                                                 | G4    | PENDING USER APPROVAL | ACC-01     | Yes             | No        | Yes (via ACC-01)                              |
| DOC-09 | `docs/operations/DEPLOYMENT_AND_OPERATIONS.md` ("background jobs TBD"): add worker operation, the single-worker / stop-old-first rule, manual `SENDING` recovery, manual handling of stuck `PROCESSING` refunds (check the gateway outcome; `complete` only if the provider confirms the refund was completed; recovery undefined if no refund was issued; _corrected 2026-11-20 from `APPROVED`; clarified 2026-11-20_) | G4    | PENDING USER APPROVAL | DEC-05     | Yes             | No        | Yes ("runbook drafts" deliverable)            |
| DOC-10 | `.env.example` background-jobs comment is outdated (mentions only 4 jobs, "in-process")                                                                                                                                                                                                                                                                                                                                  | —     | BLOCKED               | DEC-10     | Yes             | No        | No                                            |
| DOC-11 | Gate-name collision: "G7"/"G8" mean DB migration gates in `INCREMENT-B-MASTER-ROADMAP-G2-G8.md`, but Phase 7/8 exit gates in `IMPLEMENTATION_ROADMAP.md`. Add a clarifying note                                                                                                                                                                                                                                          | —     | PENDING USER APPROVAL | —          | Yes             | No        | No                                            |
| DOC-12 | Record the 2026-11-20 decisions RD-08 / RD-09 / RD-10 / RD-13 B as `D-xx` in `PROJECT_CONTEXT.md` §17 (only D-61 is recorded there)                                                                                                                                                                                                                                                                                      | —     | PENDING USER APPROVAL | —          | Yes             | No        | No                                            |

### B. Offline application implementation

| ID      | Task (source)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Batch         | Status                                                                                                                                                                     | Depends on                     | Approval     | Execution | Blocks G4                                                                                                  |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------ | --------- | ---------------------------------------------------------------------------------------------------------- |
| B10-REV | **Batch 10 technical review**: confirm the proposed scope against the code; produce a plan with work packages, tests, decisions (§6)                                                                                                                                                                                                                                                                                                                                                                                             | 10            | PENDING USER APPROVAL (to start the review)                                                                                                                                | ACC-02 recommended             | Yes          | No        | Indirect                                                                                                   |
| IMP-01  | Registry wiring tests: cursor carry-over + stop-signal hand-off (Batch 7 review; audit M-2)                                                                                                                                                                                                                                                                                                                                                                                                                                      | 10 (proposed) | NOT AUTHORIZED                                                                                                                                                             | B10-REV                        | Yes          | No        | No (quality)                                                                                               |
| IMP-02  | Per-item error isolation in `best-seller-refresh` / `rating-aggregate` (Batch 7 review)                                                                                                                                                                                                                                                                                                                                                                                                                                          | 10 (proposed) | NOT AUTHORIZED                                                                                                                                                             | B10-REV                        | Yes          | No        | No                                                                                                         |
| IMP-03  | Reconciliation-level tests: stock-out late capture and cancelled-order refund (Batch 7 review)                                                                                                                                                                                                                                                                                                                                                                                                                                   | 10 (proposed) | NOT AUTHORIZED                                                                                                                                                             | B10-REV                        | Yes          | No        | No                                                                                                         |
| IMP-04  | OpenAPI: correct content types for file-download routes (Batch 7 review)                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 10 (proposed) | NOT AUTHORIZED                                                                                                                                                             | B10-REV                        | Yes          | No        | No                                                                                                         |
| IMP-05  | Best-seller job to use the `catalog.best_seller_window_days` setting (Batch 8 report §10 item 6)                                                                                                                                                                                                                                                                                                                                                                                                                                 | 10 (proposed) | NOT AUTHORIZED                                                                                                                                                             | B10-REV                        | Yes          | No        | No                                                                                                         |
| IMP-06  | Batch 8 mocked-test gaps: re-resolution creating a new cart, add-item retry path, 30 / 90-day boundaries (master report §14)                                                                                                                                                                                                                                                                                                                                                                                                     | 10 (proposed) | NOT AUTHORIZED                                                                                                                                                             | B10-REV                        | Yes          | No        | No                                                                                                         |
| IMP-07  | Promotion "EXPIRED is final" behaviour (Batch 7 verification): decision first                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 10 (proposed) | PENDING USER APPROVAL                                                                                                                                                      | DEC-06                         | Yes          | No        | No                                                                                                         |
| IMP-08  | Interrupted post-commit refund recovery (`PROCESSING` refunds whose gateway call never ran; _corrected 2026-11-20 from `APPROVED`_) (audit M-1)                                                                                                                                                                                                                                                                                                                                                                                  | unassigned    | PENDING USER APPROVAL                                                                                                                                                      | DEC-05                         | Yes          | No        | Possibly (if classified P0/P1, see SEC-02)                                                                 |
| IMP-09  | Scheduler: log a synchronous throw in `job.run()` as a failed run (audit L-1); start-log wording (L-4)                                                                                                                                                                                                                                                                                                                                                                                                                           | unassigned    | PENDING USER APPROVAL                                                                                                                                                      | —                              | Yes          | No        | No                                                                                                         |
| IMP-10  | MFA recovery codes: needs schema change SCP-1 (RD-03)                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | —             | BLOCKED                                                                                                                                                                    | DEC-09                         | Yes (schema) | No        | Formal deferral needed                                                                                     |
| IMP-11  | `POST /webhooks/email`, `/webhooks/whatsapp` (PROJECT_CONTEXT §8.1): vendor unknown (OQ-08). _(Update 2026-11-24 — scope as approved:_ `POST /webhooks/email`, `POST /webhooks/whatsapp` and `GET /webhooks/whatsapp`, with the behaviour that depends on them (delivery, read and failure status callbacks; e-mail bounce and complaint suppression; inbound WhatsApp STOP / START handling). Condition: no real e-mail or WhatsApp provider is enabled before these are implemented and verified against the vendor sandbox_)_ | —             | **FORMALLY DEFERRED to Phase 7** — deferral record DEF-A1 approved by the owner on 2026-11-24 (decision D6 of the owner decision package). Not implemented. _Was: BLOCKED_ | DEC-13 — decided for this item | Yes          | No        | Deferral approved 2026-11-24; work belongs to Phase 7 (vendor choice OQ-08). _Was: Formal deferral needed_ |
| IMP-12  | Scheduled async report exports: need a queue and private storage, outside D-61 scope                                                                                                                                                                                                                                                                                                                                                                                                                                             | —             | BLOCKED                                                                                                                                                                    | DEC-13                         | Yes          | No        | Formal deferral needed                                                                                     |

### C. Automated testing and quality gates

| ID    | Task                                                                                                                                                                                 | Status                                       | Depends on | Approval       | Execution | Blocks G4                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- | ---------- | -------------- | --------- | ------------------------------- |
| QA-01 | Re-run the full offline gate suite after every change (see §8)                                                                                                                       | COMPLETE for current code (2026-11-20 20:59) | —          | No             | No        | Yes (at G4 time)                |
| QA-02 | **FR "Must" API-side traceability**: map each API-side "M" requirement (`PROJECT_REQUIREMENTS.md` §5 tables; 257 "M" rows in total, API-side subset unidentified) to automated tests | NOT STARTED (size UNKNOWN)                   | —          | Yes (scope)    | No        | **Yes** (G4 criterion 2)        |
| QA-03 | Map the `TESTING_STRATEGY.md` acceptance test cases (70 TC rows, 57 P1) to API-level tests; mark FE / E2E-only cases for Phases 5–7                                                  | NOT STARTED                                  | QA-02      | Yes            | No        | Yes (supports G4 criterion 2)   |
| QA-04 | CI run on **Node 22** (`.nvmrc` = 22; `.github/workflows/ci.yml`). No evidence of a CI run on the current code; local runs use Node 24.12.0 (OQ-110)                                 | UNKNOWN                                      | USR-06     | Yes (Git push) | Yes       | Yes (CI/CD is in Phase 4 scope) |
| QA-05 | `npm audit`: production 0 vulnerabilities, dev 8 moderate (2026-11-19); re-run at G4 (registry network access only)                                                                  | PENDING REVIEW                               | —          | No             | No        | Yes (part of SEC-01)            |
| QA-06 | DB-backed integration tests (after G8): run the Batch 12 suite                                                                                                                       | BLOCKED                                      | DB-06      | Yes            | Yes       | Yes (see DEC-12)                |

### D. Database / MySQL verification

| ID    | Task                                                                                      | Status                                       | Depends on                     | Approval            | Execution   | Blocks G4        |
| ----- | ----------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------ | ------------------- | ----------- | ---------------- |
| DB-01 | G2 backup / restore drill, Steps 1–11 (`G2-USER-EXECUTION-GUIDE.md`)                      | PENDING USER EXECUTION (Step 1 NOT VERIFIED) | —                              | Acceptance decision | **Yes**     | Yes              |
| DB-02 | G3 Case A migration identity (`INCREMENT-B-G3-CASE-A-EXECUTION-PROCEDURE.md` v1.2.1)      | PENDING USER APPROVAL then EXECUTION         | —                              | Yes                 | **Yes**     | Yes              |
| DB-03 | F5 readiness review (READY / NOT READY)                                                   | NOT STARTED                                  | DB-01, DB-02                   | Yes                 | No (review) | Yes              |
| DB-04 | G7 scratch baseline migration on `ecommerce_migrate_test`                                 | NOT AUTHORIZED                               | DB-01, DB-02 PASS; DB-03 READY | Yes                 | **Yes**     | Yes              |
| DB-05 | G8 baseline migration on `ecommerce_dev` (fresh verified backup first)                    | NOT AUTHORIZED                               | DB-04 PASS                     | Yes                 | **Yes**     | Yes              |
| DB-06 | Post-G8: `npm run db:seed` (includes `cart.abandon_after_days`), `npm run cli:superadmin` | BLOCKED                                      | DB-05                          | Yes                 | **Yes**     | Yes              |
| DB-07 | **Batch 12 technical review and plan** (MySQL verification suite; §10)                    | NOT STARTED (proposed)                       | DB-05                          | Yes                 | No          | Yes (see DEC-12) |
| DB-08 | Batch 12 execution (tests runnable only against the authorized DB)                        | BLOCKED                                      | DB-06, DB-07                   | Yes                 | Likely      | Yes (see DEC-12) |
| DB-09 | Evaluate a database-level single-worker guard (Batch 9 decision B3)                       | DEFERRED to Batch 12                         | DB-08                          | Yes                 | —           | No               |

### E. External service integration verification

| ID     | Task                                               | Status                                                                                                                                                          | Blocks G4                        |
| ------ | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| EXT-01 | Payment gateway sandbox (OQ-06)                    | DEFERRED: real provider sandboxes are **Phase 7** (`IMPLEMENTATION_ROADMAP.md` phase 7 "Real provider sandboxes"); Phase 4 objective = "fake provider adapters" | No, unless DEC-11 says otherwise |
| EXT-02 | Courier sandbox (OQ-07)                            | DEFERRED (Phase 7)                                                                                                                                              | No (same)                        |
| EXT-03 | Email / WhatsApp (OQ-08)                           | DEFERRED (Phase 7); vendor unknown. _(2026-11-24: the delivery webhooks are formally deferred under DEF-A1 — IMP-11)_                                           | No (same)                        |
| EXT-04 | Cloudinary asset verification (credentials, RD-06) | DEFERRED / BLOCKED                                                                                                                                              | No (same)                        |
| EXT-05 | CAPTCHA vendor (OQ-71 / D-48)                      | DEFERRED                                                                                                                                                        | No (same)                        |

### F. Security and operational verification

| ID     | Task                                                                                                                                                                                                                                   | Status                                                            | Depends on | Approval    | Blocks G4                         |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------- | ----------- | --------------------------------- |
| SEC-01 | **Security checklist self-assessment** against `SECURITY_GUIDELINES.md` §23 "Release security checklist". The existing `docs/operations/SECURITY_SELF_ASSESSMENT.md` (2026-11-17) is "Interim … not a G4-passing security assessment". | NOT STARTED                                                       | QA-05      | Yes (scope) | **Yes** (G4 criterion 4)          |
| SEC-02 | **P0/P1 defect register.** G4 requires "no open P0/P1 defects". The audits use Critical / High / Medium / Low, and no P0/P1 defect convention is documented (TESTING_STRATEGY P1/P2 are test-case priorities).                         | UNKNOWN / NEEDS USER CONFIRMATION                                 | DEC-14     | Yes         | **Yes**                           |
| SEC-03 | In-memory rate limits, sessions, idempotency and permission cache are single-instance only (D-38)                                                                                                                                      | Accepted limitation for one instance; DEFERRED for multi-instance | DEC-08     | Yes         | No (if staging is one instance)   |
| SEC-04 | **Staging environment and API releases v0.x on staging** (Phase 4 scope and deliverables); hosting undecided (OQ-34)                                                                                                                   | BLOCKED                                                           | DEC-08     | Yes         | **Yes**, unless formally deferred |
| SEC-05 | Runbook drafts (deliverable): see DOC-09                                                                                                                                                                                               | NOT STARTED                                                       | DOC-09     | Yes         | Yes                               |
| SEC-06 | `.env` last-write 2026-11-20 19:05:02 not attributable to any recorded command                                                                                                                                                         | PENDING USER EXECUTION (owner investigation)                      | —          | —           | No                                |
| SEC-07 | `.git/FETCH_HEAD` / `.git/objects` updates (20:09, 20:15, 20:25) not from any recorded command                                                                                                                                         | PENDING USER EXECUTION (owner investigation)                      | —          | —           | No                                |

> **Correction to SEC-02 (2026-11-20, autonomous completion session 2).** A defect convention **is**
> documented: `project-documentation/08-testing/TESTING_STRATEGY.md` §19 defines severity S1–S4 (set
> by QA) and priority P1–P4 (set by the product owner), with the release criterion "0 open S1/S2".
> G4's "P0/P1" wording does not match it exactly (there is no P0). DEC-14 therefore narrows to
> confirming the mapping; the recommendation is G4 "P0/P1" = §19 "S1/S2". Current statuses are in
> `docs/PHASE4-AUTONOMOUS-COMPLETION-STATUS.md`.

### G. Pending user decisions

| ID     | Decision (source)                                                                                                                                                                                  | Blocks                             |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| DEC-01 | Authorize DOC-01 (and optionally DOC-02 to DOC-06)                                                                                                                                                 | Batch 9 acceptance                 |
| DEC-02 | Accept Batch 9 (offline mocked scope) after DOC-01                                                                                                                                                 | ACC-02                             |
| DEC-03 | Accept or reject the earlier COMPLETE — NOT YET ACCEPTED deliverables (B0-c, B1, B2–B9, hardening round, G2/G3 review round, autonomous round, Batches 4–6), with or without a consolidated review | ACC-03 / G4                        |
| DEC-04 | Authorize the Batch 10 technical review, then approve the reviewed scope                                                                                                                           | Batch 10                           |
| DEC-05 | Recovery approach for interrupted post-commit refunds (M-1): business / security decision                                                                                                          | IMP-08, DOC-09                     |
| DEC-06 | Is a promotion in EXPIRED status final?                                                                                                                                                            | IMP-07                             |
| DEC-07 | RD-01 CGST/SGST odd-paisa rounding (CA answer)                                                                                                                                                     | Tax correctness                    |
| DEC-08 | OQ-34 hosting for `dev` / `staging` (and single-instance acceptance, D-38)                                                                                                                         | SEC-04                             |
| DEC-09 | RD-03 schema changes SCP-1 … SCP-6 (`PHASE3-SCHEMA-CHANGE-PROPOSAL.md`)                                                                                                                            | IMP-10                             |
| DEC-10 | Pending `.env.example` revert (Batch 3 incident)                                                                                                                                                   | DOC-10                             |
| DEC-11 | Confirm external sandbox verification is **Phase 7**, not G4                                                                                                                                       | EXT-01 … 05                        |
| DEC-12 | Confirm DB-backed verification (G2 → G8 + Batch 12) is required for G4 ("feature-complete on staging", B0-b part 2 DB readiness), or formally defer it                                             | QA-06, DB-07 / 08                  |
| DEC-13 | Formal deferral list for G4 ("implemented or formally deferred"): email / WhatsApp webhooks, async report exports, MFA recovery codes, low-stock digest (already decided: RD-09)                   | G4 criterion 1                     |
| DEC-14 | Defect-severity convention for G4 (map Critical / High → P0 / P1?)                                                                                                                                 | SEC-02                             |
| DEC-15 | RD-02 five extra catalogue routes; RD-04 unpaid-order cancel; RD-05 store legal name                                                                                                               | Canonical route / behaviour record |
| DEC-16 | RD-11 token retention (OQ-38 legal review); D6                                                                                                                                                     | DEFERRED until decided             |
| DEC-17 | RD-13 option A typed response schemas (OQ-49)                                                                                                                                                      | DEFERRED until decided             |
| DEC-18 | OQ-110 Node line (22-only vs 22 + 24)                                                                                                                                                              | QA-04                              |
| DEC-19 | Define (or drop) Batches 11, 12 and 13 as formal batches                                                                                                                                           | Sequencing                         |

_(Update 2026-11-27, row DEC-12 — decided by the owner: real MySQL verification is required for G4. The six prepared scenarios (TC-004, TC-030, TC-041, TC-045, TC-048, TC-051) must pass against `ecommerce_test` with reviewable evidence before G4 acceptance. The decision is an evidence requirement only and authorizes no database execution. The row above is kept as written; its words "G2 → G8 + Batch 12" and "feature-complete on staging" are wider than the decision: G8, seeds and staging are outside it, and the proposed Batch 12 suite is not addressed by it and stays open. Full record: `PHASE4-FINAL-OWNER-DECISION-PACKAGE.md`, D10; summary in §21.3.)_

### H. User-executed procedures and evidence

| ID     | Procedure                                                                           | Evidence                                                          |
| ------ | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| USR-01 | G2 Steps 1–11                                                                       | `G2-EXECUTION-LOG.md` rows; checklist G2-01 … G2-22               |
| USR-02 | G3 Case A (after approval)                                                          | Checklist G3-01 … G3-15 (redacted `SHOW GRANTS`)                  |
| USR-03 | G7 preparation (create empty `ecommerce_migrate_test`; scratch grant) and execution | `INCREMENT-B-MASTER-ROADMAP-G2-G8.md` "Gate G7" required evidence |
| USR-04 | G8: fresh verified backup, then migration on `ecommerce_dev`                        | "Gate G8" required evidence                                       |
| USR-05 | Seeds and superadmin CLI after G8                                                   | Seed counts; CLI output (no secrets)                              |
| USR-06 | Git push / CI run (only if authorized)                                              | CI run log on Node 22                                             |
| USR-07 | Investigate the `.env` / `.git` metadata incidents (SEC-06 / 07)                    | Owner statement                                                   |
| USR-08 | Provide client written approval for G4                                              | Signed / written approval                                         |

### I. Deferred / future scope (does **not** block G4 unless you decide otherwise)

| ID     | Item                                                                           | Basis                               |
| ------ | ------------------------------------------------------------------------------ | ----------------------------------- |
| DEF-01 | Multi-server / distributed scheduling, Redis, BullMQ, distributed lock (WP-O1) | D-61, D-38 / OQ-35                  |
| DEF-02 | Stuck-`SENDING` notification auto-recovery (WP-O3)                             | Batch 9 B5                          |
| DEF-03 | Worker container and health check (WP-O4)                                      | Batch 9 B4 → OQ-34                  |
| DEF-04 | Abandoned-cart reminders                                                       | OQ-62 (out of v1)                   |
| DEF-05 | Low-stock daily digest                                                         | RD-09 (instant only)                |
| DEF-06 | Real provider sandboxes (EXT-01 … 05)                                          | `IMPLEMENTATION_ROADMAP.md` Phase 7 |
| DEF-07 | Storefront / admin applications                                                | Phases 5 / 6                        |
| DEF-08 | Production go-live                                                             | Phase 9                             |

### J. Final acceptance

| ID     | Task                                                                                                                                                                                                                                                                                                                | Status                | Depends on          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------- |
| ACC-01 | **G4 evidence package**: endpoint coverage matrix, FR traceability (QA-02 / 03), test and coverage reports, security self-assessment (SEC-01), defect register (SEC-02), deferral register (DEC-13), staging release evidence (SEC-04) or its formal deferral, runbook draft (SEC-05), refreshed G4 report (DOC-08) | NOT STARTED           | most items above    |
| ACC-02 | Batch 9 acceptance                                                                                                                                                                                                                                                                                                  | PENDING USER APPROVAL | DOC-01, DEC-02      |
| ACC-03 | Acceptance of the earlier COMPLETE — NOT YET ACCEPTED deliverables                                                                                                                                                                                                                                                  | PENDING USER APPROVAL | DEC-03              |
| ACC-04 | Acceptance of Batch 10 (and any later batch) after audit                                                                                                                                                                                                                                                            | NOT STARTED           | Batch 10            |
| ACC-05 | **Client written approval of G4**                                                                                                                                                                                                                                                                                   | NOT STARTED           | ACC-01 … 04, USR-08 |

### Summary table

| ID          | Task                                   | Batch          | Status                                  | Dependency           | User approval? | Blocks Phase 4?      |
| ----------- | -------------------------------------- | -------------- | --------------------------------------- | -------------------- | -------------- | -------------------- |
| DOC-01      | Batch 9 refund-retry correction        | 9              | PENDING USER APPROVAL                   | —                    | Yes            | Yes                  |
| ACC-02      | Batch 9 acceptance                     | 9              | PENDING USER APPROVAL                   | DOC-01               | Yes            | Yes                  |
| ACC-03      | Accept earlier unaccepted deliverables | B0-c … Batch 6 | PENDING USER APPROVAL                   | DEC-03               | Yes            | Yes                  |
| B10-REV     | Batch 10 technical review              | 10             | PENDING USER APPROVAL                   | ACC-02 (recommended) | Yes            | Indirect             |
| IMP-01 … 07 | Batch 10 proposed items                | 10             | NOT AUTHORIZED                          | B10-REV              | Yes            | No                   |
| IMP-08      | Refund recovery (M-1)                  | —              | PENDING USER APPROVAL                   | DEC-05               | Yes            | Possibly             |
| QA-02 / 03  | FR / TC traceability                   | G4             | NOT STARTED                             | —                    | Yes            | Yes                  |
| QA-04       | CI on Node 22                          | G4             | UNKNOWN                                 | USR-06               | Yes            | Yes                  |
| SEC-01      | Security self-assessment §23           | G4             | NOT STARTED                             | QA-05                | Yes            | Yes                  |
| SEC-02      | P0/P1 defect register                  | G4             | UNKNOWN                                 | DEC-14               | Yes            | Yes                  |
| SEC-04      | Staging environment / release          | G4             | BLOCKED                                 | DEC-08               | Yes            | Yes, unless deferred |
| DB-01 … 06  | G2 → G8 + seeds                        | Increment B    | PENDING USER EXECUTION / NOT AUTHORIZED | chain                | Yes            | Yes (DEC-12)         |
| DB-07 / 08  | Batch 12 review and execution          | 12             | NOT STARTED / BLOCKED                   | DB-05                | Yes            | Yes (DEC-12)         |
| DEC-13      | Formal deferrals for G4                | G4             | PENDING USER APPROVAL                   | —                    | Yes            | Yes                  |
| ACC-01 / 05 | G4 package and client approval         | G4             | NOT STARTED                             | all                  | Yes            | Yes                  |

## 5. Batch 9 acceptance checklist

| #   | Check                                                                 | Result (evidence)                                                                                 |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | Authorized documentation corrections completed                        | **NO**: no correction report; DOC-01 not done; no authorization recorded                          |
| 2   | Refund-retry limitation accurately documented                         | **NO**: audit §5 / §8 D-1 is accurate; completion report §6 item 4 and plan §4 item 9 still wrong |
| 3   | Setup guide describes the current worker                              | **NO** (DOC-02)                                                                                   |
| 4   | Mailpit instructions match configuration                              | **NO** (DOC-03; fake email adapter, no Mailpit)                                                   |
| 5   | BACKEND_STRUCTURE distinguishes D-61 current from future              | **NO** (DOC-04)                                                                                   |
| 6   | API README lists worker / bootstrap files                             | Scripts table **yes**; project-structure tree **no** (DOC-05)                                     |
| 7   | `.env*` untouched by Batch 9                                          | **YES** (last-write metadata unchanged; audit §9)                                                 |
| 8   | No unauthorized source / test changes during documentation correction | **N/A**: no correction has been performed                                                         |
| 9   | Correction report accurate                                            | **N/A**: does not exist                                                                           |
| 10  | Unresolved audit findings needing decisions                           | M-1 (DEC-05), M-2 (IMP-01), L-1 / L-4 (IMP-09), L-7 noted; known limitations B3 / B5              |

**Batch 9 can be proposed for acceptance once item 1 (at least DOC-01) is done.** It remains PENDING
USER ACCEPTANCE until you explicitly accept it.

## 6. Batch 10 review and authorization plan

1. **Scope source.** Only proposals exist: "Batch 7 review follow-ups, plus the best-seller setting"
   (`PHASE4-BATCH8-COMPLETION-REPORT.md` §11) and the item list in
   `PHASE4-BATCH9-TECHNICAL-REVIEW-AND-IMPLEMENTATION-PLAN.md` §7 → IMP-01 … IMP-07.
2. **Technical review.** Not yet done. It should verify each item in code, define tests and acceptance
   criteria, and state which decisions it needs (DEC-06).
3. **Decisions.** DEC-06, and whether M-1 (IMP-08) or L-1 (IMP-09) join Batch 10.
4. **Authorization.** Separate user approval of the reviewed scope.
5. **Then:** implementation → offline gates → independent audit → user acceptance.

**Should not go into Batch 10:**

- MySQL verification (Batch 12);
- external sandboxes (Phase 7);
- RD-11 / D6;
- RD-13 A;
- schema changes (RD-03);
- deferred items (§4-I).

## 7. Remaining offline implementation (outside Batch 9 / 10)

- **Undecided items:** IMP-08 (M-1) and IMP-09 (L-1 / L-4) are not in any batch.
- **Blocked items:** IMP-10, IMP-11 and IMP-12 need either a decision or a formal deferral _(update 2026-11-24: IMP-11 is formally deferred to Phase 7 — DEF-A1; IMP-10 and IMP-12 are unchanged)_ (DEC-09,
  DEC-13).
- **Possible new work:** QA-02 may reveal untested "Must" criteria, and therefore new offline test or
  implementation work. This is **not measurable** until the traceability is done.

## 8. Quality-gate matrix

| Gate                            | Last result                                                                           | Scope                      | Recent?                                                 | Re-run needed?      | Needs DB / external? | Blocks       |
| ------------------------------- | ------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------- | ------------------- | -------------------- | ------------ |
| format:check                    | PASS                                                                                  | whole repo                 | 2026-11-20 (Batch 9 run, after which only docs changed) | After any change    | No                   | Yes          |
| lint (`--max-warnings 0`)       | PASS                                                                                  | src, tests, scripts, seeds | same                                                    | After any change    | No                   | Yes          |
| typecheck                       | PASS                                                                                  | same                       | same                                                    | After any change    | No                   | Yes          |
| build                           | PASS (incl. `dist/worker.js`)                                                         | src                        | same                                                    | After any change    | No                   | Yes          |
| unit + mocked integration tests | **104 files / 1,344 PASS**; coverage lines 93.16 %, branches 81.85 % (floors 80 / 75) | offline                    | same                                                    | After any change    | No                   | Yes          |
| openapi:check                   | PASS (248 ops)                                                                        | routes                     | same                                                    | After any change    | No                   | Yes          |
| prisma validate                 | PASS                                                                                  | schema                     | same                                                    | After schema change | No (placeholder URL) | Yes          |
| Baseline hash check             | MATCH `154D2C8E…A7A6BB`                                                               | migration SQL              | **re-verified 2026-11-20**                              | Before G7 / G8      | No                   | G7           |
| Migration ↔ schema drift        | **Not run** (needs a shadow DB)                                                       | schema vs SQL              | —                                                       | At G7               | Yes (DB)             | G7           |
| npm audit                       | prod 0 / dev 8 moderate                                                               | dependencies               | 2026-11-19                                              | At G4               | Network (registry)   | SEC-01       |
| CI on Node 22                   | **No evidence** for current code                                                      | `.github/workflows/ci.yml` | —                                                       | Yes                 | GitHub (Git push)    | QA-04        |
| DB-backed integration tests     | **Not run**                                                                           | Batch 12                   | —                                                       | After G8            | MySQL                | DEC-12       |
| Documentation consistency       | Known gaps (DOC-01 … 12)                                                              | docs                       | 2026-11-20                                              | After corrections   | No                   | Batch 9 / G4 |
| Security self-assessment        | Interim (2026-11-17)                                                                  | §23 checklist              | Stale                                                   | Yes                 | No                   | G4           |

## 9. G7 / G8 user-execution plan (and their prerequisites G2 → G3 → F5)

Authoritative procedure: `docs/INCREMENT-B-MASTER-ROADMAP-G2-G8.md`. **Note the gate-name collision**
(DOC-11): these are the DB-migration gates, not the Phase 7 / 8 exit gates of `IMPLEMENTATION_ROADMAP.md`.

| Gate | Purpose                                    | Prerequisites                                                                                                      | Executor                                                                      | Evidence                                                                                 | Status                                       |
| ---- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------- |
| G2   | Prove backup / restore of `ecommerce_dev`  | MySQL running; `ecommerce_dev` exists; privileged local access                                                     | **User** (guide `G2-USER-EXECUTION-GUIDE.md`); Claude reviews redacted output | G2-01 … G2-22 (dump size / hash / completion marker, reconciled counts, scratch dropped) | PENDING USER EXECUTION (Step 1 not verified) |
| G3   | Least-privilege migration identity         | Procedure v1.2.1 reviewed; separate execution approval                                                             | **User** (after approval)                                                     | G3-01 … G3-15 (redacted `SHOW GRANTS`, `ecommerce_app` unchanged, guard tests)           | NOT ACCEPTED                                 |
| F5   | Readiness decision before G7               | G2 / G3 evidence                                                                                                   | Claude prepares; **user decides**                                             | READY / NOT READY report                                                                 | NOT STARTED                                  |
| G7   | Baseline on empty `ecommerce_migrate_test` | **G2 PASS, G3 PASS, F5 READY**; hash confirmed; user-created empty scratch DB; scratch-scoped grant                | **User**; Claude reviews                                                      | Target proof, pre / post state, redacted outputs, probes, grant revocation               | NOT AUTHORIZED                               |
| G8   | Baseline on `ecommerce_dev`                | **G7 PASS**; fresh verified backup; `.env.migration` targeting `ecommerce_dev` (verified without sharing contents) | **User**; Claude reviews                                                      | Approval package, backup integrity, post-migration verification, Prisma status           | NOT AUTHORIZED                               |

**For every gate:**

- **State change.** G2 creates and drops a scratch database (reads `ecommerce_dev`). G3 changes MySQL
  users and grants. G7 changes the scratch database. G8 changes `ecommerce_dev`. F5 is review only.
- **Approvals.** Separate authorization before execution, and a separate PASS / ACCEPTED decision after
  evidence review.
- **Redaction.** No passwords, connection strings or `.env` contents. Only redacted command outputs,
  counts, hashes and `SHOW GRANTS` (without secrets).
- **Failure handling.** Per the "Failure conditions" of each gate: stop, preserve evidence, do not
  auto-retry destructive steps. G8 recovery is the restore from the pre-G8 backup.
- **Claude's role.** Claude can review the evidence the user pastes, provided it is redacted.
- **What is blocked.** Seeds (DB-06), Batch 12 (DB-07 / 08), DB-backed tests (QA-06) and every
  MySQL-only verification item.

**Execution states:** procedure documented ✅ (all five) · procedure prepared ✅ (G2 guide; G3 v1.2.1) ·
user execution pending (G2) · evidence received (G2 Step 0 only) · evidence reviewed (G2 Step 0) · gate
passed: none.

## 10. Batch 12 MySQL verification plan (proposed; scope not yet approved)

Items gathered from the accepted reports. **No item is verified**, and all of them need the G8 baseline.

| Area      | Item                                                                                                                                                                                                    | Source                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Baseline  | Objects, constraints and FKs match the reviewed SQL; Prisma migrate status clean                                                                                                                        | G7 / G8 evidence requirements                                                    |
| Cart (M1) | SQL emitted by Prisma `updateMany` for the claim; REPEATABLE READ snapshot after the claim; row lock; P2002 from `uq_carts_active_owner` under concurrency; cart-item cascade; second-attempt frequency | master report §14; M1 report §8                                                  |
| Batch 7   | D1 promotion compare-and-set; D2 mismatch serialization; D3 / D4 cursors; D5 `FOR UPDATE` + recompute; webhook-vs-reconciliation deadlock pattern; RD-10 late-capture paths                             | `PHASE4-BATCH8-*`, master report §12                                             |
| Batch 8   | Abandon / purge cut-offs and compare-and-set on MySQL; job versus customer write races                                                                                                                  | Batch 8 report §6                                                                |
| Batch 9   | Worker + API connection pools; SIGTERM during a transaction (rollback); post-commit gaps (refund `PROCESSING`, `SENDING`); duplicate-worker effects; DB-level guard evaluation (DB-09)                  | Batch 9 report §7; audit §13                                                     |
| General   | Inventory reservation and checkout concurrency (G4 risk "concurrency bugs (reservations, coupons)"); audit-log append-only grants                                                                       | `IMPLEMENTATION_ROADMAP.md` Phase 4 "Risks"; `ROLE_PERMISSION_AND_AUDIT_LOGS.md` |

**D-61 must be respected:** one worker; no Redis / BullMQ / distributed lock unless separately approved.

## 11. External integration verification plan

Per `IMPLEMENTATION_ROADMAP.md`, Phase 4 uses **fake provider adapters** and real provider sandboxes are
**Phase 7**. Today:

- payment, courier, email, WhatsApp and Cloudinary are **mock-only**;
- sandbox verification **not done**;
- live verification **not applicable to Phase 4**.

Prerequisites when the work is scheduled: vendor choices (OQ-06 / 07 / 08), sandbox credentials supplied
by you through the secret manager (never shared in chat), webhook signature schemes, and approval to
contact external services. **Do not treat sandbox success as production readiness.** Decision DEC-11
confirms the phase placement.

## 12. Open decisions and defect register

**Decisions:** DEC-01 … DEC-19 (§4-G).

**Defects and limitations:**

| ID        | Item                                                                                                                                                                                                                                                        | Source               | Classification                              |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------- |
| M-1       | Interrupted post-commit refund stays `PROCESSING` (_corrected 2026-11-20 from `APPROVED`_); no retry route; manual: check gateway; `complete` only if the provider confirms completion; recovery undefined if no refund was issued (_clarified 2026-11-20_) | Batch 9 audit        | Known defect; decision DEC-05               |
| M-2       | Registry signal wiring untested                                                                                                                                                                                                                             | Batch 9 audit        | Test gap → IMP-01                           |
| L-1 … L-7 | Synchronous throw, start-up signal window, unref timer, log wording, untested paths, docs, log-shape change                                                                                                                                                 | Batch 9 audit §10    | Low; IMP-09 / DOC-* / accepted              |
| B3 / B5   | Two workers double-run; `SENDING` rows after a forced exit                                                                                                                                                                                                  | Batch 9 decisions    | Accepted limitations (manual / operational) |
| D6        | Revoked refresh tokens deleted before expiry if TTL > 30 d                                                                                                                                                                                                  | Batch 7 audit        | DEFERRED (RD-11)                            |
| —         | Checkout / cart race; other cart paths not claim-locked                                                                                                                                                                                                     | Batch 8 verification | Accepted limitation (outside Batch 8)       |
| —         | In-memory single-instance stores                                                                                                                                                                                                                            | D-38                 | Accepted limitation (single instance)       |
| —         | Uploaded assets not verified                                                                                                                                                                                                                                | RD-06                | Vendor-blocked                              |
| —         | MFA recovery codes                                                                                                                                                                                                                                          | RD-03 / SCP-1        | Schema-blocked                              |
| —         | 8 moderate dev-dependency advisories                                                                                                                                                                                                                        | master report §9     | Low (dev only)                              |

## 13. Deferred work register

See §4-I (DEF-01 … DEF-08), plus DEC-16 (RD-11 / D6) and DEC-17 (RD-13 A) until decided. None of these
becomes mandatory without your decision.

## 14. Dependency-based execution sequence

Corrections to the proposed order:

- the DB gate track (G2 → G8) is **independent** of the offline batches and can proceed in parallel;
- the G4 package requires several items absent from the proposed order (FR traceability, security
  self-assessment, defect register, staging decision, acceptance of earlier deliverables).

| Step         | Action                                                                                            | Who                               | Depends on             |
| ------------ | ------------------------------------------------------------------------------------------------- | --------------------------------- | ---------------------- |
| 1            | Authorize and perform DOC-01 (plus chosen DOC-02 … 06); audit the correction                      | You approve; Claude               | —                      |
| 2            | Accept Batch 9 (ACC-02)                                                                           | You                               | 1                      |
| 3            | Decide DEC-03 (earlier unaccepted deliverables), DEC-11, DEC-12, DEC-13, DEC-14, DEC-19           | You                               | —                      |
| 4 (parallel) | G2 Steps 1–11 → G3 approval and execution → F5 → G7 → G8 → seeds (DB-01 … 06)                     | **You execute**; Claude reviews   | Each gate's prior PASS |
| 5            | Batch 10 technical review (B10-REV) → your approval → implementation → gates → audit → acceptance | You approve; Claude               | 2 (recommended)        |
| 6            | QA-02 / QA-03 traceability (may create new offline work)                                          | Claude, after your scope approval | 3                      |
| 7            | Batch 12 plan (DB-07) → approval → execution against the authorized DB (DB-08)                    | You approve and execute; Claude   | 4 (G8 PASS)            |
| 8            | SEC-01 security self-assessment; SEC-02 defect register; QA-04 CI on Node 22; QA-05 npm audit     | Claude; you (Git)                 | 3, 5, 6                |
| 9            | Staging (SEC-04) or its formal deferral (DEC-08 / DEC-13)                                         | You                               | 3                      |
| 10           | Resolve any P0 / P1 defects found                                                                 | Approved batches                  | 6–8                    |
| 11           | G4 evidence package (ACC-01), with DOC-07 / 08 refreshed                                          | Claude                            | 1–10                   |
| 12           | Client written approval of G4 (ACC-05)                                                            | **You**                           | 11                     |

"Batch 13" is **not an established batch**. Steps 11–12 are the documented G4 exit activity.

## 15. Phase 4 acceptance criteria (G4, authoritative)

From `IMPLEMENTATION_ROADMAP.md` (Phase 4 "Exit criteria / Gate G4"), with current evidence:

| Criterion                                                                                                                                | Current evidence                                                                                                        | Missing                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| All API_DOCUMENTATION endpoints implemented or formally deferred                                                                         | 80 / 80 documented endpoint headings implemented; §8.1 catalogue: all except email / WhatsApp webhooks (OQ-08)          | Formal deferral record (DEC-13)                   |
| All FR "Must" API-side acceptance criteria pass in automated tests                                                                       | Mocked suite 1,344 tests; **no traceability**                                                                           | QA-02 / QA-03; DB-backed tests if DEC-12 requires |
| No open P0 / P1 defects                                                                                                                  | No Critical / High findings in recent audits                                                                            | P0 / P1 convention (DEC-14); register (SEC-02)    |
| Security checklist self-assessment complete                                                                                              | Interim 2026-11-17 only                                                                                                 | SEC-01                                            |
| Client written approval                                                                                                                  | —                                                                                                                       | ACC-05                                            |
| Scope / deliverables: CI / CD, `dev` / `staging`, releases on staging, OpenAPI per release, test reports ≥ 80 % services, runbook drafts | CI workflow exists (no current run evidence); OpenAPI generated; coverage 93 % lines; runbook scaffold only; no staging | QA-04, SEC-04, SEC-05                             |

## 16. Risks and blockers

1. **Database work is entirely user-executed and unstarted beyond G2 Step 0.** Every MySQL-only risk
   stays open until G8.
2. **The FR traceability size is unknown.** It may reveal additional work.
3. **Hosting (OQ-34) is undecided**, which blocks the staging deliverable.
4. **Many deliverables are unaccepted**, so G4 cannot be proposed while they remain open.
5. **The two unexplained metadata incidents** (`.env`, `.git`) are unresolved.
6. **Documentation drift:** stale canonical status (DOC-06 / 07 / 08) and target-design wording
   (DOC-02 … 04).

## 17. Evidence requirements

- **Batch 9:** DOC-01 correction plus a correction report, then your acceptance.
- **DB gates:** the checklist rows in `INCREMENT-B-G2-G3-EVIDENCE-CHECKLIST.md` and the "Required
  evidence" of each gate in `INCREMENT-B-MASTER-ROADMAP-G2-G8.md`.
- **G4:** the items in §15.
- **All evidence must be redacted.** No secrets, connection strings or `.env` contents.

## 18. Tasks requiring your approval

DOC-01 … DOC-12; B10-REV and the Batch 10 scope; IMP-07 … IMP-12; QA-02 / QA-03 scope; QA-04 (Git);
G3 execution; G7; G8; seeds; Batch 12; SEC-01 / SEC-02 scope; DEC-01 … DEC-19; ACC-02 … ACC-05.

## 19. Tasks requiring your execution

USR-01 (G2), USR-02 (G3), USR-03 (G7), USR-04 (G8), USR-05 (seeds / superadmin), USR-06 (Git push / CI),
USR-07 (incident investigation), USR-08 (client written approval).

## 20. Final completion checklist (mark only with actual evidence)

- [ ] DOC-01 corrected and audited; Batch 9 accepted (ACC-02)
- [ ] Earlier COMPLETE — NOT YET ACCEPTED deliverables accepted or explicitly handled (ACC-03)
- [ ] Batch 10 reviewed, approved, implemented, audited, accepted (or explicitly dropped)
- [ ] G2 PASS · G3 PASS · F5 READY · G7 PASS · G8 PASS (or a formal decision under DEC-12)
- [ ] Seeds and superadmin executed after G8 (if DB scope applies)
- [ ] Batch 12 MySQL verification executed and reviewed (if DB scope applies)
- [ ] FR "Must" API-side traceability complete; all traced criteria pass in automated tests
- [ ] Formal deferral register approved (DEC-13)
- [ ] Security checklist self-assessment (SECURITY_GUIDELINES §23) complete
- [ ] Defect convention agreed; no open P0 / P1 defects
- [ ] CI passing on the agreed Node line
- [ ] Staging release, or its formal deferral
- [ ] Runbook draft complete
- [ ] G4 evidence package issued; canonical status documents refreshed
- [ ] **Client written approval of G4**

**Phase 4 remains IN PROGRESS — NOT APPROVED. Production readiness is NOT ESTABLISHED.**

## 21. Update 2026-11-24 — master completion run

This section records what changed since the roadmap was written. Earlier sections are kept as the
2026-11-20 record. Detail: `PHASE4-MASTER-COMPLETION-AND-G4-READINESS-REPORT.md`; live status:
`PHASE4-AUTONOMOUS-COMPLETION-STATUS.md` §10.

**Decided since (PROJECT_CONTEXT §17.8, 2026-11-21):** D-62 (G4 "P0 / P1" = S1 / S2), D-63 (an
`EXPIRED` promotion is final), D-64 (manual refund recovery procedure only), D-65 (Batch 10 scope),
D-66 (the four small DEC-13 items).

**Completed since (mocked / offline evidence):**

- DF-01, DF-02, DF-03 fixed and re-verified.
- Batch 10: WP10-1 … WP10-6 and the scheduler fix (IMP-01 … IMP-06, IMP-09). Awaiting acceptance. _(Update 2026-11-24: accepted for offline mocked scope only — §21.1.)_
- Test-only G4 work (GST catalogue, route × role matrix, state machine, notification rendering).
- DEC-13 small items: FR-ORD-006, FR-INV-006, FR-SF-004 complete; FR-AD-008 partial.
- QA-02 re-count: 219 tested, 7 no test, 11 partial, 2 blocked / deferred.
- SEC-01 draft rebuilt (142 controls); CI/CD preparation and runbook checked against the code.
- DEC-12 harness prepared under `tests/db/`. **Not executed.**

**§20 checklist — position on 2026-11-24 (nothing can be ticked without your action):**

| Checklist item                                     | Position                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Batch 9 accepted (ACC-02)                          | Pending your decision _(Update 2026-11-24: ACCEPTED — OFFLINE MOCKED SCOPE ONLY — §21.1.)_                                                                                                                                                                                                                                   |
| Earlier unaccepted deliverables handled (ACC-03)   | Pending your decision                                                                                                                                                                                                                                                                                                        |
| Batch 10 reviewed, implemented, audited, accepted  | Implemented and verified; acceptance pending _(Update 2026-11-24: ACCEPTED — OFFLINE MOCKED SCOPE ONLY — §21.1.)_                                                                                                                                                                                                            |
| G2 · G3 · F5 · G7 · G8                             | G2 at Step 1 (not accepted); the rest not started / not authorized                                                                                                                                                                                                                                                           |
| Seeds and superadmin                               | Blocked on G8                                                                                                                                                                                                                                                                                                                |
| Batch 12 MySQL verification                        | Harness prepared; execution blocked on DEC-12 and G7                                                                                                                                                                                                                                                                         |
| FR "Must" traceability complete; all criteria pass | Draft re-counted; 11 partial; six cases need a real database                                                                                                                                                                                                                                                                 |
| Formal deferral register approved (DEC-13)         | Partly decided on 2026-11-24: DEF-A1 approved, and HTTP serving of the OpenAPI specification deferred (§21.1). DEF-A2 … DEF-A5 and DEF-B1 … DEF-B3 still pending your decision                                                                                                                                               |
| Security self-assessment complete                  | Draft complete; your review pending                                                                                                                                                                                                                                                                                          |
| Defect convention agreed; no open P0 / P1          | Convention agreed (D-62); SEC-F02 and M-1 need your classification. _(Update 2026-11-24: SEC-F02 — control PW-08 — was classified S2 and fixed under D1. M-1 still needs your classification.)_                                                                                                                              |
| CI passing on the agreed Node line                 | No CI run recorded (USR-06, DEC-18)                                                                                                                                                                                                                                                                                          |
| Staging release, or its formal deferral            | Blocked on DEC-08                                                                                                                                                                                                                                                                                                            |
| Runbook draft complete                             | Partial (no `SENDING` procedure; refund recovery undefined when no refund was issued)                                                                                                                                                                                                                                        |
| G4 evidence package issued                         | Evidence index in the master completion report §14; canonical status (DOC-07) not refreshed _(Update 2026-11-24: dated status clarifications were added to the canonical `IMPLEMENTATION_ROADMAP.md` (header, banner and Phase 4 rows), `README.md` and `PROJECT_CONTEXT.md` (header and §17.9); the earlier text is kept.)_ |
| Client written approval of G4                      | Not started                                                                                                                                                                                                                                                                                                                  |

**Phase 4 remains IN PROGRESS — NOT APPROVED. G4 is NOT MET. Production readiness is NOT ESTABLISHED.**

### 21.1 Owner decisions taken on 2026-11-24, after the run recorded above

| Decision (owner decision package)        | Result                                                                                                                                                                                                                                                                                                                                                                                                                                         | Roadmap items affected  |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| D1 — mock payment provider in production | Classified S2; fix authorized, implemented and locally verified                                                                                                                                                                                                                                                                                                                                                                                | SEC-02                  |
| D12 — Batch 9                            | ACCEPTED — OFFLINE MOCKED SCOPE ONLY (ten risks acknowledged)                                                                                                                                                                                                                                                                                                                                                                                  | ACC-02                  |
| D13 — Batch 10                           | ACCEPTED — OFFLINE MOCKED SCOPE ONLY (six limitations acknowledged)                                                                                                                                                                                                                                                                                                                                                                            | IMP-01 … IMP-06, IMP-09 |
| D6 — e-mail and WhatsApp webhooks        | **Formal deferral DEF-A1 approved**, to Phase 7. Scope: `POST /webhooks/email`, `POST /webhooks/whatsapp` and `GET /webhooks/whatsapp`, with the behaviour that depends on them (delivery, read and failure status callbacks; e-mail bounce and complaint suppression; inbound WhatsApp STOP / START handling). Condition: no real e-mail or WhatsApp provider is enabled before these are implemented and verified against the vendor sandbox | IMP-11 (§4-B)           |
| D7 — `GET /api/v1/openapi.json`          | **Formal deferral approved**: serving the specification over HTTP is deferred; the generated, committed and drift-checked file `docs/openapi/openapi.json` stands for Phase 4; HTTP serving to be decided before the first frontend integration that needs it                                                                                                                                                                                  | G4 criterion 1          |

**Identifier note.** In §4, §7, §12 and §13 of this roadmap, "D6" is an earlier audit item about
deleting revoked refresh tokens (with RD-11 / DEC-16). It is **not** the owner decision D6 above.
The same label is also used for a delivery principle in `IMPLEMENTATION_ROADMAP.md`. The three are
unrelated.

**Still open:** owner decisions D2 – D5, D8 – D11 and D14 – D17; proposed deferrals DEF-A2 … DEF-A5
and DEF-B1 … DEF-B3; IMP-07, IMP-08, IMP-10 and IMP-12; the database gates; a CI run.

**Phase 4 remains IN PROGRESS — NOT APPROVED. G4 is NOT MET.**

### 21.2 Autonomous execution run of 2026-11-24 (later the same day)

Record: `PHASE3-PHASE4-MASTER-PROGRESS-REPORT.md` §20; live status: `PHASE4-AUTONOMOUS-COMPLETION-STATUS.md` §14.

| Roadmap item                                     | Position after the run                                                                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| QA-02 (traceability)                             | Tested 226, no test found 0, partial 11, blocked / deferred 2                                                                       |
| QA-03 (test-case catalogue)                      | TC-027, TC-034 (API part) and TC-049 covered; the state-machine conflict (DC-01) is closed; six P1 cases still need a real database |
| SEC-01                                           | Draft: 14 gaps (was 16). Not accepted (D11)                                                                                         |
| DOC-07                                           | Dated clarifications added to the canonical roadmap, README and PROJECT_CONTEXT header                                              |
| DOC-12                                           | Unchanged: open                                                                                                                     |
| Criterion 1 evidence                             | Independent contract audit done: `PHASE4-API-CONTRACT-CONFORMANCE-AUDIT.md`                                                         |
| QA-04 (CI run), DB-01 … DB-06, DEC items, ACC-03 | Unchanged: owner only                                                                                                               |

_(Clarification 2026-11-27, row SEC-01: "14 gaps" is a draft count, not accepted (D11). It includes two reassessments not approved by the owner (SH-10 and CS-03, from GAP to PREPARED); without them the count is 16. The row is kept as written.)_

**Phase 4 remains IN PROGRESS — NOT APPROVED. G4 is NOT MET.**

### 21.3 Owner decision DEC-12 (received 2026-11-27)

Full record: `PHASE4-FINAL-OWNER-DECISION-PACKAGE.md`, D10. "D10" is that package's reply label; DEC-12 is the decision identifier (§4-G).

- **DEC-12: DECIDED — REAL MYSQL VERIFICATION REQUIRED FOR G4.** The six prepared scenarios (TC-004, TC-030, TC-041, TC-045, TC-048, TC-051) are mandatory for G4. They must pass against the designated `ecommerce_test` database and produce reviewable evidence before G4 acceptance. Failures must be investigated, classified and resolved through separately authorized work.
- **Roadmap items affected.** The G4 criteria "Must criteria pass in automated tests" and "no open P0 / P1" (§15): the six scenarios are required evidence and remain outstanding. They are PREPARED — NOT EXECUTED. Rows QA-06, DB-07 and DB-08 concern the proposed Batch 12 suite and are not changed by this record.
- **Not authorized by the decision.** G2 backup or restore, G3 migrator-user or privilege operations, the G7 scratch-database migration, the G8 migration against `ecommerce_dev`, execution of the six scenarios, seeds, and any database user, grant, schema or data change. All existing prerequisites and separate explicit authorizations remain mandatory. Only the owner executes user-only database procedures.
- **G2.** Existing G2 authorization and status are unchanged: USER EXECUTION IN PROGRESS — NOT ACCEPTED. DEC-12 neither grants nor withdraws a G2 authorization. G2 is independent of DEC-12.
- **Batch 12 (DB-07, DB-08, §10).** Not addressed by the decision and not included in the six scenarios. It stays open pending separate owner clarification (see also DEC-19).
- **GST-15.** Excluded from DEC-12; a separate owner decision is required. Not approved, deferred, implemented or verified.
- **Coupon hardening.** NOT AUTHORIZED; to be considered separately after the TC-041 evidence has been reviewed.
- **Iteration count.** Not decided. Neither the harness default of 3 nor the testing-strategy values of 5 and 20 is selected; a separate decision is needed before scenario execution.
- **Outside the decision.** G8, seeds, staging, GST-15 and production database operations.

**Clarification 2026-11-27 (execution prerequisites and traceability).** G7 PASS is a prerequisite before any of the six scenarios is executed. G7 PASS alone does not authorize scenario execution: a separate explicit written authorization from the owner is also required. TC-041 is the real-database evidence scenario for requirement FR-CPN-008 and its acceptance criterion AC-03. TC-041 has not been executed. Coupon hardening remains NOT AUTHORIZED until the TC-041 evidence has been reviewed and a separate owner decision is made.

**Still open after this record:** D2 – D5, D8, D9, D11 and D14 – D17; the coupon-hardening question under D10; proposed deferrals DEF-A2 … DEF-A5 and DEF-B1 … DEF-B3; the database gates; a CI run.

**Phase 4 remains IN PROGRESS — NOT APPROVED. G4 is NOT MET.**
