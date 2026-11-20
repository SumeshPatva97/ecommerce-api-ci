# Phase 4 — Autonomous Completion Status (live tracker)

| Field        | Value                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| Document     | P4-STATUS-LIVE                                                                                              |
| Last updated | 2026-11-20 (session 1 of the autonomous completion agent)                                                   |
| Task IDs     | From `PHASE4-MASTER-COMPLETION-ROADMAP.md` (the source of truth). This file records **current** status only |
| Agent        | `PHASE4-AUTONOMOUS-COMPLETION-AGENT.md` (instruction document; no persistent agent exists)                  |

## 1. Overall status (unchanged by this session)

| Item                 | Status                                                                                     | Evidence                                           |
| -------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| Phase 1 / 2 / 3      | APPROVED — COMPLETE                                                                        | Master report §1                                   |
| **Phase 4**          | **IN PROGRESS — NOT APPROVED**                                                             | Master report §1                                   |
| Batch 7              | ACCEPTED — OFFLINE MOCKED SCOPE ONLY                                                       | Master report §12                                  |
| Batch 8 + M1         | ACCEPTED — OFFLINE MOCKED SCOPE ONLY                                                       | Master report §14                                  |
| **Batch 9**          | **COMPLETE — PENDING USER ACCEPTANCE** (risk acknowledgement presented 2026-11-20; see §4) | `PHASE4-BATCH9-UPDATED-FINAL-ACCEPTANCE-REVIEW.md` |
| Batch 10             | **NOT AUTHORIZED.** Technical review and proposal done (2026-11-20)                        | `PHASE4-BATCH10-TECHNICAL-REVIEW-AND-PROPOSAL.md`  |
| Batch 11             | Not defined (DEC-19)                                                                       | Roadmap §4-G                                       |
| Batch 12             | NOT STARTED (blocked on G7 / G8)                                                           | Roadmap §10                                        |
| G2                   | USER EXECUTION IN PROGRESS — NOT ACCEPTED (Step 0 PASS; Step 1 not verified)               | `G2-EXECUTION-LOG.md`; master report §1            |
| G3                   | NOT ACCEPTED (procedure v1.2.1 reviewed; execution needs approval)                         | Master report §1                                   |
| G7 / G8              | NOT AUTHORIZED                                                                             | Master report §1                                   |
| **G4**               | **NOT MET**                                                                                | §6 below                                           |
| Production readiness | NOT ESTABLISHED                                                                            | —                                                  |

## 2. Completed in this session (2026-11-20)

| Task                                                                  | Result                                                                                                                                                                                                                                                                 | Evidence                                                                  |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Inventory and path verification                                       | Roadmap, master report and decisions verified. `IMPLEMENTATION_ROADMAP.md` lives in `project-documentation/10-project-management/` (not `ecommerce-api/docs/`)                                                                                                         | This file                                                                 |
| Fifth M-1 path verified                                               | Admin retry of a `FAILED` gateway refund: `prepareGatewayRefund` inside the transaction (`refunds.service.ts` `retry`), `runGateway(job)` after commit. Same commit-then-call risk. Bank-transfer retry makes no gateway call (not affected)                           | Code; `PHASE4-BATCH9-PRE-ACCEPTANCE-FINAL-DOCUMENTATION-FIX-REPORT.md` §3 |
| Five-path documentation reconciliation (current-state documents only) | Updated with dated notes: runbook §9 (five code paths), master report §16 (four API code paths incl. retry), ADMIN_WORKFLOWS §11.1 note (retry transaction). Already correct: API_DOCUMENTATION retry row, JOBS §6a. Historical reports left unchanged (dated records) | §7 below                                                                  |
| B10-REV                                                               | Batch 10 technical review and proposal: IMP-01 … IMP-06 verified in code, IMP-07 needs DEC-06; 6 work packages; no DB / API-behaviour change                                                                                                                           | `PHASE4-BATCH10-TECHNICAL-REVIEW-AND-PROPOSAL.md`                         |
| Agent definition                                                      | Instruction document (no persistent agent)                                                                                                                                                                                                                             | `PHASE4-AUTONOMOUS-COMPLETION-AGENT.md`                                   |
| QA-02 (draft)                                                         | FR "Must" API traceability matrix: see §5 (draft, pending verification)                                                                                                                                                                                                | `PHASE4-FR-MUST-API-TRACEABILITY-MATRIX-DRAFT.md`                         |
| Read-only gates                                                       | `format:check`, `lint`, `typecheck`, `openapi:check` PASS earlier today (22:46) on unchanged code (no source change since 20:57)                                                                                                                                       | `PHASE4-BATCH9-UPDATED-FINAL-ACCEPTANCE-REVIEW.md` §4                     |

## 3. Task register (current status of roadmap IDs)

The statuses below supersede the roadmap's 2026-11-20 morning statuses where newer evidence exists.

| ID        | Task                                                         | Current status                                                                                                                                              | Depends on                      | Authorization needed                                | User action                  | Evidence / next step                                                                     |
| --------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------- |
| DOC-01    | Batch 9 refund-retry correction                              | **COMPLETE**                                                                                                                                                | —                               | Done                                                | —                            | `PHASE4-BATCH9-DOCUMENTATION-CORRECTION-REPORT.md`; M-1 state / refund alignment reports |
| DOC-02…05 | Setup guide, BACKEND_STRUCTURE, README (D-61)                | **COMPLETE**                                                                                                                                                | —                               | Done                                                | —                            | Same report; `PHASE4-D61-…` reports                                                      |
| DOC-06    | Master report RD-12 row                                      | **COMPLETE**                                                                                                                                                | —                               | Done                                                | —                            | `PHASE4-DOC06-CORRECTION-REPORT.md`                                                      |
| DOC-07    | `IMPLEMENTATION_ROADMAP.md` Phase 4 status stale             | OPEN                                                                                                                                                        | —                               | Yes (canonical)                                     | Approve                      | Status row still says "B0-b … B9 outstanding" (verified today)                           |
| DOC-08    | Stale `PHASE4-G4-REVIEW-REPORT.md`                           | OPEN (part of ACC-01)                                                                                                                                       | ACC-01                          | Yes                                                 | —                            | —                                                                                        |
| DOC-09    | Runbook: worker operation, single worker, `SENDING`, M-1     | **PARTIAL.** Worker model, start commands, health, M-1 (§9) done; manual `SENDING` recovery procedure not written (needs DEC-05-like decision on procedure) | DEC-05                          | Yes                                                 | —                            | `operations/DEPLOYMENT_AND_OPERATIONS.md`                                                |
| DOC-10    | `.env.example` comment                                       | BLOCKED                                                                                                                                                     | DEC-10                          | Yes                                                 | Decide revert                | —                                                                                        |
| DOC-11    | G7 / G8 name collision note                                  | OPEN                                                                                                                                                        | —                               | Yes (canonical)                                     | Approve                      | —                                                                                        |
| DOC-12    | Record RD-08 / 09 / 10 / 13 B as D-xx                        | OPEN                                                                                                                                                        | —                               | Yes (canonical)                                     | Approve                      | —                                                                                        |
| ACC-02    | Batch 9 acceptance                                           | **PENDING USER DECISION**; prerequisites met (§4)                                                                                                           | DEC-02                          | **User only**                                       | Accept / reject              | §4                                                                                       |
| B10-REV   | Batch 10 technical review                                    | **COMPLETE (proposal)**                                                                                                                                     | —                               | —                                                   | —                            | `PHASE4-BATCH10-TECHNICAL-REVIEW-AND-PROPOSAL.md`                                        |
| IMP-01…06 | Batch 10 work packages                                       | NOT AUTHORIZED                                                                                                                                              | DEC-04                          | **Yes**                                             | Approve scope                | Proposal §3                                                                              |
| IMP-07    | Promotion EXPIRED final                                      | PENDING DECISION                                                                                                                                            | DEC-06                          | Yes                                                 | Decide                       | —                                                                                        |
| IMP-08    | M-1 recovery (five code paths)                               | PENDING DECISION                                                                                                                                            | DEC-05                          | Yes                                                 | Decide                       | —                                                                                        |
| IMP-09    | Scheduler sync-throw + log wording                           | Optional Batch 10 add-on                                                                                                                                    | DEC-04                          | Yes                                                 | Include / exclude            | Proposal §3                                                                              |
| IMP-10…12 | MFA recovery codes, email / WhatsApp webhooks, async exports | BLOCKED                                                                                                                                                     | DEC-09 / DEC-13                 | Yes                                                 | Decide / formally defer      | —                                                                                        |
| QA-01     | Offline gates                                                | Current for unchanged code (read-only gates 22:46; full suite / build recorded 20:59–21:01)                                                                 | —                               | —                                                   | —                            | Updated acceptance review §4                                                             |
| QA-02     | FR "Must" API traceability                                   | **DRAFT** (see §5)                                                                                                                                          | —                               | Draft prepared under this instruction; owner review | Review                       | `PHASE4-FR-MUST-API-TRACEABILITY-MATRIX-DRAFT.md`                                        |
| QA-03     | TESTING_STRATEGY TC mapping                                  | **DRAFT** (2026-11-20): of 66 backend-testable rows, 37 covered (mocked), 29 partial, 0 uncovered; P1: 28 covered, 26 partial                               | QA-02                           | Evidence assembly; owner review                     | Review                       | `PHASE4-TEST-CASE-CATALOGUE-MAPPING-DRAFT.md`; §5a                                       |
| QA-04     | CI on Node 22                                                | UNKNOWN                                                                                                                                                     | USR-06, DEC-18                  | Yes (Git push)                                      | **User**                     | —                                                                                        |
| QA-05     | `npm audit` refresh                                          | NOT RUN this session (network to npm registry; recorded 2026-11-19)                                                                                         | —                               | Low risk; run at G4 time                            | —                            | —                                                                                        |
| SEC-01    | Security self-assessment (§23)                               | **DRAFT** (2026-11-20): MET 4 · PARTIAL 8 · GAP 3 · not verifiable 2 · N/A 2                                                                                | QA-05                           | Evidence assembly; acceptance by user               | Review / accept              | `operations/SECURITY_SELF_ASSESSMENT-G4-DRAFT.md`                                        |
| SEC-02    | P0 / P1 defect register                                      | BLOCKED on the mapping only. The convention exists: TESTING_STRATEGY §19 S1–S4, release = 0 open S1 / S2                                                    | DEC-14                          | Yes                                                 | Confirm S1 / S2 = G4 P0 / P1 | `TESTING_STRATEGY.md` §19                                                                |
| SEC-04    | Staging / releases                                           | BLOCKED                                                                                                                                                     | DEC-08                          | Yes                                                 | Hosting decision             | Deliverable, not a G4 exit criterion (verified)                                          |
| SEC-06/07 | `.env` / `.git` metadata incidents                           | USER INVESTIGATION                                                                                                                                          | —                               | —                                                   | **User**                     | Not investigated (instructed)                                                            |
| DB-01…06  | G2 → G3 → F5 → G7 → G8 → seeds                               | USER EXECUTION / NOT AUTHORIZED                                                                                                                             | chain                           | Yes                                                 | **User**                     | `G2-EXECUTION-LOG.md`                                                                    |
| DB-07/08  | Batch 12 review / execution                                  | NOT STARTED / BLOCKED                                                                                                                                       | DB-05                           | Yes                                                 | —                            | —                                                                                        |
| DEC-13    | Formal deferral list                                         | PENDING DECISION                                                                                                                                            | —                               | Yes                                                 | Decide                       | G4 criterion 1                                                                           |
| ACC-01    | G4 evidence package                                          | NOT STARTED                                                                                                                                                 | QA-02 / 03, SEC-01 / 02, DEC-13 | —                                                   | —                            | —                                                                                        |
| ACC-05    | Client written approval of G4                                | NOT STARTED                                                                                                                                                 | ACC-01 … 04                     | **User / client only**                              | **User**                     | —                                                                                        |

## 4. Batch 9 — acceptance prerequisites and required acknowledgement

**Prerequisites:** all documentation corrections required by the audits and reviews are complete
(DOC-01 … DOC-06, M-1 state, refund alignment, pre-acceptance fixes). Code is unchanged since Batch 9;
the gates pass. **The only remaining prerequisite is your explicit decision.**

**Effect of the fifth M-1 path on acceptance:**

- It widens the documented M-1 scope (admin retry of a failed gateway refund, an API path).
- It is pre-existing and outside Batch 9's code.
- It does **not** change the Batch 9 recommendation; it is added to the acknowledgement below.

**Risks to acknowledge before Batch 9 can be recorded as ACCEPTED — OFFLINE MOCKED SCOPE ONLY:**

1. **Single worker.** Exactly one worker; no distributed lock or runtime enforcement.
2. **Duplicate jobs.** Two workers would run every scheduled job twice.
3. **M-1 (five code paths, pre-existing).**
   - The code paths: worker late capture; staff approval; customer self-cancel; API late capture;
     admin retry of a failed gateway refund.
   - An interrupted refund stays `PROCESSING`, with no automatic recovery.
   - `complete` records only. Use it only after the provider confirms completion; this is a
     procedural rule, not enforced by code.
   - Recovery is undefined if the provider confirms no refund was issued.
4. **Premature notifications.** "Refund initiated" notifications can be sent before the gateway call
   in staff approval and customer self-cancel.
5. **Stuck `SENDING`.** Notifications can remain in `SENDING` after a forced worker termination;
   manual recovery is needed.
6. **60 s forced exit.** It can interrupt running jobs and post-commit operations.
7. **M-2.** The registry stop-signal wiring has no dedicated test (Batch 10 WP10-1 proposes one).
8. **Offline / mocked evidence only.** No real OS-signal, MySQL, two-process or deployment evidence.
   The system is not multi-server safe and not production-ready.
9. **Coverage.** Worker / bootstrap exit paths have limited test coverage.

The acceptance would be limited to **offline mocked scope**. It would not cover MySQL, real
integrations, production or multi-server operation.

## 5. QA-02 traceability draft

See `PHASE4-FR-MUST-API-TRACEABILITY-MATRIX-DRAFT.md` (P4-QA02-DRAFT-01). It is a **DRAFT**: produced
by a read-only subagent through static search, with no tests executed. It is not G4 evidence until
reviewed.

**Summary (draft).**

- **Scope of the 257 "M" rows:** API 185 · MIXED 48 · DB 6 · FE 12 · INFRA / PROCESS 6.
- **Status of the 239 API / MIXED / DB rows:**
  - 215 implemented with a matching mocked test;
  - 8 implemented with no test found;
  - **14 PARTIAL**;
  - 2 blocked / deferred (FR-PAY-001 real gateway, FR-NTF-002 real e-mail / WhatsApp: Phase 7);
  - 0 missing.

**PARTIAL rows (G4 criterion 2 gaps; each needs a decision, a formal deferral or authorized work):**

| ID          | Gap                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------ |
| FR-PRM-004  | Listing and detail show no promotional price (`promotion: null`)                                       |
| FR-SF-004   | Collections are not filtered to ones with active products                                              |
| FR-PL-013   | Search does not cover brand, category or attribute values                                              |
| FR-PL-015   | Out-of-stock items are not sorted last                                                                 |
| FR-PV-012   | 30 vs 15 images per product; no server-side file size / format checks                                  |
| FR-INV-004  | No CSV bulk upload                                                                                     |
| FR-INV-006  | No actor filter on stock history                                                                       |
| FR-ORD-006  | Order search does not match SKU                                                                        |
| FR-AUTH-007 | CAPTCHA no-op; staff lockout not tested directly                                                       |
| FR-AUTH-010 | Breached-password check is offline only                                                                |
| FR-NTF-005  | Delivery webhooks blocked; direct auth e-mails are not logged                                          |
| FR-TAX-013  | No HSN summary on the invoice PDF                                                                      |
| FR-RPT-011  | Async exports are never run (IMP-12)                                                                   |
| FR-AD-008   | Two settings (`checkout.reservation_ttl_minutes`, `catalog.new_arrival_days`) are not read by the code |

**Weakly evidenced "tested" rows:**

- some report keys are covered only by the all-keys empty-data test;
- lock and race handling is tested only against mocks;
- the permission-cache 60 s limit is not asserted.

The draft also lists wording conflicts between requirements and code (§23 of the draft).

**Spot-check by the orchestrating session (2026-11-20).** These were confirmed in code:

- FR-PRM-004: `catalog.mapper.ts` comment "promotion / promotionLabel are null";
- FR-AD-008: `NEW_ARRIVAL_DAYS = 30` constant; the settings exist only in `settings.values.ts`;
- FR-SF-004: counts use active members, but there is no empty-collection filter (plausible, not
  exhaustively verified);
- four sampled test citations exist (`engine.test.ts` ×2, `users.test.ts` "X1 …", `libs.test.ts`).

**Second verification pass (session 2, 2026-11-20).** Eight further PARTIAL rows were checked against
both the requirement text and the code, and **all eight are confirmed**:

| ID          | Requirement asks for                           | Code                                                                             |
| ----------- | ---------------------------------------------- | -------------------------------------------------------------------------------- |
| FR-PL-013   | Search by brand, category and attribute values | `catalog.service.ts` searches only name, keywords, short description, SKU prefix |
| FR-PL-015   | Out-of-stock sorted last                       | No availability sort                                                             |
| FR-PV-012   | Max 15 images                                  | `MAX_IMAGES_PER_PRODUCT` 30, from API_DOCUMENTATION §4.3 "proposed"              |
| FR-INV-004  | CSV bulk upload                                | No CSV / multipart in the inventory module                                       |
| FR-INV-006  | Actor filter                                   | None in `inventory.schemas.ts`                                                   |
| FR-ORD-006  | SKU search                                     | `q` matches order number, email, phone, AWB only                                 |
| FR-AUTH-010 | Breached-password check                        | Offline common-password list only (`core/security/password.ts`)                  |
| FR-TAX-013  | HSN summary                                    | The invoice PDF has a per-line HSN column but no HSN-wise summary section        |

Three of these gaps are in parts the requirement itself marks **[PROPOSED]**: FR-PL-015 sort,
FR-INV-004 CSV, FR-PV-012 limits. They are natural candidates for the formal deferral list (DEC-13) or
a wording decision.

**Verified so far:** 11 of 14 PARTIAL rows (FR-PRM-004, FR-AD-008, FR-SF-004 earlier, plus the eight
above). FR-AUTH-007, FR-NTF-005 and FR-RPT-011 were not re-checked; they cite known blocked items
(EXT-05, IMP-11, IMP-12). The TESTED rows other than the 4 sampled citations are unverified.

## 5a. QA-03 test-case catalogue mapping (draft)

`PHASE4-TEST-CASE-CATALOGUE-MAPPING-DRAFT.md` (P4-QA03-DRAFT-01): `TESTING_STRATEGY.md` §16, 70 rows,
57 of them P1. Read-only subagent, static search; nothing was executed.

**Where each row can be tested:**

- API 57 · MIXED 8 · CONTRACT 1 (TC-070);
- FE / E2E 3 (TC-053, 067, 068: Phases 5–7);
- staging / performance 1 (TC-069).

**Status of the 66 backend-testable rows:**

- **37 covered** (mocked) and **29 partial**; none uncovered;
- of the 54 P1 rows among them, 28 are covered and **26 partial**.

**The 26 partial P1 rows fall into three groups:**

1. **Concurrency rows that mocks cannot prove** (TC-004, 030, 041, 045, 048, 051): need a real
   database (Batch 12 / DEC-12).
2. **Assertions missing from otherwise-existing tests** (TC-003 staff 30-min lock, 006 `Secure`
   flag, 008 audit row, 009, 010, 017, 019, 028, 044, 046, 057, 063): candidates for authorized
   test-only work.
3. **Larger gaps:**
   - TC-014: no executed route × role matrix;
   - TC-033: barcode images not decoded back to the SKU;
   - TC-043: **no table-driven GST-01…17 suite**. Rules are tested with different numbers; GST-04
     is absent; GST-17 deferred (B2B, OQ-24);
   - TC-047: no golden report dataset;
   - TC-054: state-machine check not exhaustive;
   - TC-060: not every notification event is rendered;
   - TC-025 / TC-070: their UI / FE halves lie outside this repository.

**Spot-check by the orchestrating session:**

- all 5 cited tests exist (`orders.routes.test.ts` IDOR, `adminAuth.test.ts` re-auth window,
  `refunds.routes.test.ts` SELF_APPROVAL, `tax/engine.test.ts` UTGST, `coupons.test.ts` usage-limit
  `it.each`);
- the claim "no test contains a GST-NN id" is confirmed.

**G4 implication:**

- Criterion 2 needs **new tests**, mostly test-only work, which needs your authorization.
- Concurrency proof needs a real database (DEC-12).
- None of this can be closed by documentation.

## 6. G4 criteria (verified definition, `IMPLEMENTATION_ROADMAP.md` Phase 4 "Exit criteria / Gate G4")

| #   | Criterion                                                              | Status                                                                                                                                                                                                                                               | Blocker / who acts                                                                      |
| --- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | All endpoints in API_DOCUMENTATION.md implemented or formally deferred | 80 / 80 documented endpoint headings present in OpenAPI (roadmap audit); email / WhatsApp webhooks need formal deferral                                                                                                                              | **DEC-13** (user)                                                                       |
| 2   | All FR "Must" API-side acceptance criteria pass in automated tests     | QA-02 draft exists; gaps to be confirmed; mocked tests only                                                                                                                                                                                          | Review of QA-02; possible new tests (need authorization); **DEC-12** on DB-backed tests |
| 3   | No open P0 / P1 defects                                                | A convention **does exist** (found 2026-11-20): `TESTING_STRATEGY.md` §19 defines severity S1–S4 (QA-set) and priority P1–P4 (product-owner-set); release criterion "**0 open S1/S2**". There is no "P0", so G4's wording does not match §19 exactly | **DEC-14** (user). Recommendation: read G4 "P0 / P1" as §19 "S1 / S2"                   |
| 4   | Security checklist self-assessment complete                            | Interim only (2026-11-17)                                                                                                                                                                                                                            | SEC-01 (agent can draft); acceptance by user                                            |
| 5   | Client written approval                                                | Not started                                                                                                                                                                                                                                          | **User / client** (after ACC-01)                                                        |

Phase 4 deliverables (not exit criteria): staging releases (SEC-04, blocked by DEC-08) and runbook
drafts (DOC-09, partial).

## 7. Files changed in this session

**Created:**

- `docs/PHASE4-AUTONOMOUS-COMPLETION-AGENT.md`
- `docs/PHASE4-AUTONOMOUS-COMPLETION-STATUS.md` (this file)
- `docs/PHASE4-BATCH10-TECHNICAL-REVIEW-AND-PROPOSAL.md`
- `docs/PHASE4-FR-MUST-API-TRACEABILITY-MATRIX-DRAFT.md` (subagent, read-only analysis)
- `docs/operations/SECURITY_SELF_ASSESSMENT-G4-DRAFT.md` (SEC-01 draft; the interim 2026-11-17 assessment is unchanged)

**Modified (dated notes):**

- `docs/operations/DEPLOYMENT_AND_OPERATIONS.md` §9
- `docs/PHASE3-PHASE4-MASTER-PROGRESS-REPORT.md` §16
- `project-documentation/06-workflows/ADMIN_WORKFLOWS.md` §11.1 note

**Not changed:** any source, test, configuration, package, schema, migration, seed, Docker, `.env*`
or `.git`. No database or external service was accessed.

## 8. Next eligible tasks

**The agent can do these without new authorization (documentation / evidence assembly):**

1. Deeper verification of the QA-02 draft (larger sample, especially the PARTIAL and "weak evidence" rows).
2. QA-03: map TESTING_STRATEGY P1 test cases to API tests.
3. Refine SEC-01 after QA-05 (`npm audit` refresh: needs npm-registry network access, low risk; confirm before running).
4. ACC-01 skeleton (G4 package index) once DEC-13 / DEC-14 are answered.

**Waiting for the user:**

- ACC-02 (Batch 9);
- DEC-04 (Batch 10 scope);
- DEC-05, 06, 08, 10, 12, 13, 14 (decisions);
- G2 / G3 execution;
- Git / CI (USR-06).

## 9. Session 3 update (2026-11-20, 23:35 – 00:00) — supersedes earlier rows where they differ

### 9.1 Test-only G4 work: COMPLETE (executed)

Authorized by the owner's "Execution Mode" instruction §2 (A–E). Report: `PHASE4-G4-TEST-ONLY-WORK-COMPLETION-REPORT.md`.

**Full suite (executed, mocked):**

- **Before:** 104 files, 1,344 passed.
- **After:** **109 files, 2,855 passed, 6 todo, 0 failed.**
- **Coverage:** statements 91.83 %, branches 82.33 %, functions 94.48 %, lines 93.58 % (all up).

**Gates (executed):** `format:check`, `lint`, `typecheck`, `openapi:check` and `build` PASS. `prisma validate` not run (environment-file restriction; schema unchanged).

**New coverage:**

- 12 missing assertions;
- GST-01 … 17 (16 pass; GST-15 DB part and GST-17 todo);
- route × role matrix (1,113 cases, no defect);
- notification rendering for all 22 events;
- exhaustive order state machine (144 pairs).

**No source, schema, configuration, package or Docker file changed.**

### 9.2 Defect / conflict register (severity per TESTING_STRATEGY §19, pending DEC-14)

| ID    | Item                                                                                                   | Proposed severity       | Status                              |
| ----- | ------------------------------------------------------------------------------------------------------ | ----------------------- | ----------------------------------- |
| DF-01 | Notification guard blocks `forgotPasswordUrl` (PASSWORD_CHANGED / SECURITY_ALERT via outbox)           | S3 (latent)             | OPEN: fix needs authorization       |
| DF-02 | Notification guard misses `upiId` / `razorpayPaymentId`                                                | S3                      | OPEN: fix needs authorization       |
| DF-03 | COD out-for-delivery template missing                                                                  | S3                      | OPEN: needs wording + authorization |
| M-1   | Refund interrupted after commit (five paths)                                                           | S3, or S2 if you decide | OPEN: DEC-05                        |
| M-2   | Registry stop-signal wiring untested                                                                   | S4                      | OPEN: Batch 10 WP10-1               |
| DC-01 | PAYMENT_FAILED → CANCELLED missing from the PROJECT_CONTEXT §5.1 diagram                               | Documentation           | OPEN: canonical edit needs approval |
| DC-02 | GST-15 error code: strategy says `INTERNAL_ERROR`; code says `VALIDATION_ERROR` / `TAX_NOT_CONFIGURED` | Documentation           | OPEN                                |
| DC-03 | GST-08 / 12 depend on the RD-01 rounding rule                                                          | Decision                | DEC-07                              |
| DC-04 | TC-008: no dedicated Superadmin-bypass audit event                                                     | Interpretation          | Your confirmation                   |

**No S1 / S2 defect identified** (subject to your M-1 severity decision).

### 9.3 G4 criteria — current position

| #   | Criterion                                      | Position                                                                                                                                                                                                                         |
| --- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Endpoints implemented or formally deferred     | All documented endpoints present except the email / WhatsApp webhooks → **DEC-13**                                                                                                                                               |
| 2   | Must API-side criteria pass in automated tests | QA-02 draft: 215 / 239 with tests, 14 PARTIAL (11 verified). QA-03 P1: most now covered (executed). **Remaining:** 6 real-DB cases (**DEC-12**); the 14 PARTIAL requirements need implementation or deferral (**DEC-13**); DF-03 |
| 3   | No open P0 / P1 defects                        | No S1 / S2 found; mapping needs **DEC-14**; M-1 severity is your call                                                                                                                                                            |
| 4   | Security self-assessment complete              | Draft extended and test-backed (`operations/SECURITY_SELF_ASSESSMENT-G4-DRAFT.md`); gaps: CI scanning, monitoring, backups; acceptance by you                                                                                    |
| 5   | Client written approval                        | After the G4 package                                                                                                                                                                                                             |

### 9.4 Decision package

All open decisions are consolidated in `PHASE4-CONSOLIDATED-DECISION-PACKAGE.md`: ACC-02 (Batch 9), DEC-04, 05, 06, 08, 10, 12, 13, 14, plus the next G2 step (Step 1, non-destructive).

### 9.5 Next eligible tasks

**No further autonomous test or implementation work is authorized.** The remaining items need decisions:

- DEC-04: Batch 10 implementation;
- a fix batch for DF-01 / 02 / 03;
- DEC-13: G4-gap implementation;
- DEC-12: real-database tests;
- DEC-08: staging;
- USR-06: CI.

**Documentation tasks still open:**

- deeper QA-02 sample verification;
- ACC-01 package index once DEC-13 / DEC-14 are answered.
