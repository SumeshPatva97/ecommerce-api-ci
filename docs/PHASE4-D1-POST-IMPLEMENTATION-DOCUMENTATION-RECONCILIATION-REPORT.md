# Phase 4 — D1 Post-Implementation Documentation Reconciliation Report

| Field    | Value                                                                                                                       |
| -------- | --------------------------------------------------------------------------------------------------------------------------- |
| Date     | 2026-11-24                                                                                                                  |
| Nature   | **Documentation only.** No source file and no test file was changed by this reconciliation                                  |
| Decision | D1 only: "I classify PW-08 / A9-F02 as S2 and authorize the fix in the security plan §1.5 Option B with the tests in §1.6." |
| Evidence | Local runs on Node 24.12.0 with a mocked database. Not CI, not a real database, not a real production process               |

**Status preserved:** Phase 4 IN PROGRESS — NOT APPROVED · G4 NOT MET · Batch 9 and Batch 10 PENDING
USER ACCEPTANCE · decisions D2 – D17 OPEN · no deferral approved.

Not opened: any `.env*` file. Not used: Git, MySQL, external services, deployment.

## 1. What was reconciled

D1 was implemented earlier on 2026-11-24. Three documents were updated at that time (security plan,
decision package, G4 evidence matrix). The security self-assessment draft, the master report, the
tracker and several related documents still described the state before the fix. This run brought
them into line. Earlier statements were kept and marked with dated notes; nothing was deleted.

## 2. Security self-assessment — reassessment of PW-08

Document: `docs/operations/SECURITY_SELF_ASSESSMENT-G4-DRAFT.md`. It stays a **draft for owner
review**.

**Control PW-08:** "Start-up refusal of the mock payment provider in production."

| Question                                    | Answer                                                                                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Does the code now do what the control says? | Yes. `createContainer` throws when the environment is production and the payment provider is the mock; `createProcessRuntime` turns that into exit code 1 for the API and the worker |
| Does a passing automated test exist?        | Yes. `tests/unit/core/container.test.ts` (refusal, injected non-mock accepted, message content) and `tests/unit/bootstrap.test.ts` (exit code 1 for both roles)                      |
| Is the control's wording met in full?       | Yes. The control asks for a start-up refusal, and that exists and is tested                                                                                                          |
| Result under the draft's own definitions    | **TESTED** ("An automated test exists and passes offline with a mocked database")                                                                                                    |
| Why not CODE-VERIFIED                       | That result means "no dedicated test was found". Dedicated tests exist                                                                                                               |
| What TESTED does **not** mean here          | No real process was started with a production configuration. No CI run exists. No production environment exists                                                                      |

PW-08 was therefore moved from **GAP** to **TESTED** and removed from the open-gap count. The
previous wording of the row is quoted inside it.

**Related rows.**

| Row                                                      | Change                                                                                                                                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PW-06 (mock adapters refused for webhooks in production) | **Result unchanged: CODE-VERIFIED.** Its note said "No test covers either line". The payments line is now tested; the courier line is not, so the control is not fully tested |
| Finding A9-F02                                           | Severity: S2 (owner). Status: fixed. The earlier cells are quoted                                                                                                             |
| Finding A9-F05 (missing tests)                           | Note added: the payments webhook refusal is now tested; the courier refusal and the required-secret / `COOKIE_SECURE` rules are still untested                                |
| "Webhook verification" row of the 2026-11-20 table       | Dated note added                                                                                                                                                              |
| S1 / S2 statement                                        | Dated note: A9-F02 is classified and fixed; M-1 still awaits classification                                                                                                   |

All other controls, gaps and findings are unchanged.

### 2.1 Recalculated totals

Counted by script from the 142 control rows of the "G4 control assessment" section, before and
after the update.

| Result         | Before D1 | After D1 |
| -------------- | --------- | -------- |
| TESTED         | 71        | **72**   |
| CODE-VERIFIED  | 15        | 15       |
| DOCUMENTED     | 9         | 9        |
| PREPARED       | 4         | 4        |
| BLOCKED        | 14        | 14       |
| USER-DEPENDENT | 12        | 12       |
| GAP            | 17        | **16**   |
| **Total**      | **142**   | **142**  |

Area 7 (payment webhooks and idempotency) is now TESTED 6, CODE-VERIFIED 1, GAP 1, BLOCKED 2. The
other fifteen areas are unchanged.

**The 16 open gaps:** AA-11, AA-12, AA-13, RL-05, PW-07, FU-05, DP-10, DP-11, WK-09, WK-10, SH-09,
SH-10, BR-05, LM-05, CS-03, CS-04.

The two older summary tables in the draft (the 19-item release checklist and the 16 broader areas,
both of 2026-11-20) were not reassessed and are unchanged.

## 3. Evidence recorded

| Evidence                                                      | Before D1                       | After D1                        |
| ------------------------------------------------------------- | ------------------------------- | ------------------------------- |
| Test files                                                    | 119                             | 120                             |
| Tests                                                         | 3,110 passed, 3 todo, 0 failed  | 3,124 passed, 3 todo, 0 failed  |
| Coverage (statements / branches / functions / lines)          | 92.08 / 82.63 / 94.70 / 93.81 % | 92.11 / 82.69 / 94.74 / 93.86 % |
| `format:check`, `lint`, `typecheck`, `build`, `openapi:check` | PASS                            | PASS                            |
| Focused tests                                                 | —                               | 3 files, 40 passed              |

**Implementation files (changed by the D1 fix, not by this reconciliation):**

- Source: `src/container.ts`, `src/bootstrap.ts`, `src/modules/payments/payments.service.ts`;
  comment only in `src/integrations/payments/paymentProvider.ts`.
- Tests: `tests/unit/core/container.test.ts` (6 cases added),
  `tests/integration/modules/payments/payments.routes.test.ts` (3 added),
  `tests/unit/bootstrap.test.ts` (new, 5 cases).

**Mutation checks (scratch copies of the source):**

| Guard removed                   | Result                                  |
| ------------------------------- | --------------------------------------- |
| None (three control copies)     | All pass                                |
| Start-up check in the container | 2 tests fail                            |
| Catch-and-exit in bootstrap     | 2 tests fail                            |
| `verify` guard                  | 1 test fails ("expected 200 to be 503") |
| Webhook guard                   | 1 test fails ("expected 200 to be 404") |

This reconciliation did not re-run the test suite: no source or test file changed after the D1 gate
run. `npm run format:check` was run after the documentation edits and passes.

## 4. Files changed by this reconciliation

All paths are under `ecommerce-api/docs/`.

| File                                                                   | Change                                                                                                                                                     |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operations/SECURITY_SELF_ASSESSMENT-G4-DRAFT.md`                      | New "Update of 2026-11-24 — D1" section; PW-08 reassessed; PW-06, A9-F02, A9-F05 and three other statements annotated; summary table recalculated          |
| `PHASE4-MASTER-COMPLETION-AND-G4-READINESS-REPORT.md`                  | New §19 (changed files, before / after evidence, findings, G4 blockers, what is outstanding); dated notes in the verdict, §10, §14, §15, §16, §17, §18     |
| `PHASE4-FINAL-OWNER-DECISION-PACKAGE.md`                               | Decision-status table (D1 RESOLVED, D2 – D17 OPEN); D1 heading marked resolved; gap count in the D11 text corrected to 16; one contradiction entry updated |
| `PHASE4-AUTONOMOUS-COMPLETION-STATUS.md`                               | New §11; dated notes in §10.2, §10.3, §10.4, §10.5                                                                                                         |
| `PHASE4-REMAINING-USER-DECISIONS.md`                                   | Mock-provider row marked resolved (earlier text quoted); one over-broad sentence corrected; new §7                                                         |
| `PHASE4-G4-CRITERIA-AND-EVIDENCE-MATRIX.md`                            | Finding marked resolved; mutation evidence and self-assessment totals recorded; explicit "still outstanding" list (CI, real process, real provider)        |
| `PHASE4-FINAL-SECURITY-REVIEW-AND-REMEDIATION-PLAN.md`                 | Notes that the self-assessment is now reconciled; counts after D1                                                                                          |
| `operations/CI-CD-AND-DEPLOYMENT-PREPARATION.md`                       | Correction to "No start-up rule refuses the mock payment provider"; checklist note; current gate results added under the stale baseline table              |
| `operations/DEPLOYMENT_AND_OPERATIONS.md`                              | One dated line in §2: production start is refused with the mock provider                                                                                   |
| `PHASE4-MASTER-COMPLETION-ROADMAP.md`                                  | One dated note in the §21 checklist                                                                                                                        |
| `PHASE3-PHASE4-MASTER-PROGRESS-REPORT.md`                              | One dated paragraph after §17                                                                                                                              |
| `PHASE4-OWNER-EXECUTION-RUNBOOK.md`                                    | Step 10: the start-up refusal removed from "preconditions that do not exist today", with a dated note                                                      |
| `PHASE4-D1-POST-IMPLEMENTATION-DOCUMENTATION-RECONCILIATION-REPORT.md` | This report (new)                                                                                                                                          |

Not changed: every file under `src/`, `tests/`, `prisma/`, `scripts/`, `.github/`; `package.json`,
the lockfile, the OpenAPI specification; every file under `project-documentation/`.

## 5. Decisions and statuses — what did not change

| Item                                                | Status                     |
| --------------------------------------------------- | -------------------------- |
| D1                                                  | RESOLVED (the only change) |
| D2 – D17                                            | OPEN                       |
| Batch 9, Batch 10                                   | PENDING USER ACCEPTANCE    |
| Proposed deferrals DEF-A1 … DEF-A5, DEF-B1 … DEF-B3 | NOT APPROVED               |
| Security self-assessment                            | DRAFT, not accepted        |
| M-1 severity                                        | Not classified             |
| G4                                                  | NOT MET                    |
| Phase 4                                             | IN PROGRESS — NOT APPROVED |

## 6. Remaining inconsistencies and limits

| #   | Item                                                                                                                                                            | Why it is left                                                                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | `PHASE4-MASTER-AGENT9-SECURITY-CICD-OPERATIONS-REPORT.md` still shows PW-08 as a gap and the totals 71 / 17                                                     | It is a dated workstream record. The self-assessment is the current source                       |
| 2   | Sections 1–18 of the master report and §1–§10 of the tracker keep the pre-D1 numbers and wording                                                                | History is preserved; dated notes point to the new sections                                      |
| 3   | PW-06 is still CODE-VERIFIED: the courier webhook refusal in production has no test                                                                             | Adding a test is a test change, which is not authorized here                                     |
| 4   | The required-secret and `COOKIE_SECURE` rules for staging / production have no test (finding A9-F05)                                                            | Same reason                                                                                      |
| 5   | The interim `SECURITY_SELF_ASSESSMENT.md` (2026-11-17) is unchanged                                                                                             | It is superseded only when you accept the draft                                                  |
| 6   | Canonical target design (`DEPLOYMENT_ARCHITECTURE.md`) expects a gateway sandbox in staging; today staging can only run the mock, because no provider is chosen | Not caused by D1; a Phase 7 matter (OQ-06). No canonical document was edited                     |
| 7   | The other mock adapters (e-mail, WhatsApp, courier, media) are not refused at start-up in production                                                            | Outside D1. A production process cannot start anyway while the payment mock is the only provider |
| 8   | Staging still accepts the mock payment gateway, and its webhook secrets are optional (PW-07, finding A9-F01)                                                    | Open gap, unchanged                                                                              |

## 7. Still outstanding for the D1 fix itself

- **CI:** no run exists. The new tests have run only locally on Node 24.12.0; CI uses Node 22.
- **Real production-process verification:** no API or worker process was started with a production
  configuration. The exit behaviour is shown by tests that intercept `process.exit`.
- **A real payment provider:** Phase 7. Until then no production process can start.
