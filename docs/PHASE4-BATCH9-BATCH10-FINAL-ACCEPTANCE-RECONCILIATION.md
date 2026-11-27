# Phase 4 — Batch 9 and Batch 10 Final Acceptance Reconciliation

| Field    | Value                                                                                                                                                                                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Date     | 2026-11-24                                                                                                                                                                                                                                                                           |
| Nature   | **Documentation-only review.** No source or test file was changed. **This document accepts nothing**                                                                                                                                                                                 |
| Evidence | Code read on the current tree; the batch test files run locally on Node 24.12.0 with a mocked database                                                                                                                                                                               |
| Status   | When written: Batch 9 and Batch 10 PENDING USER ACCEPTANCE. **Update 2026-11-24: the owner accepted both batches, offline mocked scope only, on the basis of this document** (record: `PHASE3-PHASE4-MASTER-PROGRESS-REPORT.md` §18). Phase 4 IN PROGRESS — NOT APPROVED. G4 NOT MET |

Not opened: any `.env*` file. Not used: Git, MySQL, external providers, deployment.

Authoritative sources read: `PHASE4-BATCH9-TECHNICAL-REVIEW-AND-IMPLEMENTATION-PLAN.md`,
`PHASE4-BATCH9-COMPLETION-REPORT.md`, `PHASE4-BATCH9-INDEPENDENT-AUDIT-REPORT.md`,
`PHASE4-BATCH9-UPDATED-FINAL-ACCEPTANCE-REVIEW.md` (the risk register, §10),
`PHASE4-BATCH10-TECHNICAL-REVIEW-AND-PROPOSAL.md`, the Step 3.2 report, the Agent 2, 3, 4 and 5
reports, the master report (§1–§19), the owner decision package, the tracker, the G4 evidence matrix
and the D1 reconciliation report.

## 1. What changed since the Batch 9 review of 2026-11-20

The review covered code that had not changed since 20:57 on 2026-11-20. Since then:

| File                                                                                                                      | Changed                  | By                        | Effect on Batch 9                                                                            |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------- | -------------------------------------------------------------------------------------------- |
| `src/jobs/scheduler.ts`                                                                                                   | 2026-11-21               | Batch 10 scheduler fix    | A synchronous throw from a job is now caught. Header comment and start log now describe D-61 |
| `src/jobs/catalogAggregates.ts`                                                                                           | 2026-11-21               | Batch 10 (WP10-2, WP10-5) | Two worker jobs isolate per-product errors; the best-seller window is configurable           |
| `src/bootstrap.ts`                                                                                                        | 2026-11-24               | D1 security fix           | The API and worker exit with code 1 in production when the payment provider is the mock      |
| `src/worker.ts`, `src/workerRuntime.ts`, `src/core/lifecycle/workerLifecycle.ts`, `src/server.ts`, `src/jobs/registry.ts` | Not changed (2026-11-20) | —                         | —                                                                                            |

**Batch 9 tests re-run today (all pass):**

| Test file                                                | Tests |
| -------------------------------------------------------- | ----- |
| `tests/unit/workerRuntime.test.ts`                       | 6     |
| `tests/unit/core/workerLifecycle.test.ts`                | 5     |
| `tests/unit/jobs/scheduler.test.ts`                      | 6     |
| `tests/unit/jobs/shipmentTrackingPoll.test.ts`           | 6     |
| `tests/unit/modules/notifications/dispatcherJob.test.ts` | 3     |
| `tests/unit/jobs/paymentReconciliation.test.ts`          | 26    |

## 2. Batch 9 — risk-by-risk reconciliation

"Original wording" is verbatim from `PHASE4-BATCH9-UPDATED-FINAL-ACCEPTANCE-REVIEW.md` §10. That
register is not edited; this table records the state on 2026-11-24 next to it.

| ID    | Original wording                                                                                                   | Current verified state                                                                                                                                                                                                                                                                                                                                                                                       | Evidence                                                                                                                                                                                                                | Still needs acknowledgement?                               | Kind                                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------- |
| RK-01 | Single worker by discipline only; no lock / runtime enforcement                                                    | Unchanged. No lock exists; the start log says exactly one worker must run                                                                                                                                                                                                                                                                                                                                    | `src/jobs/scheduler.ts` header; `src/workerRuntime.ts` start log; no Redis / BullMQ dependency in `package.json`                                                                                                        | **Yes**                                                    | Genuine limitation (decided, D-61)                            |
| RK-02 | Two workers duplicate every scheduled job                                                                          | Unchanged. Only a per-process overlap guard exists                                                                                                                                                                                                                                                                                                                                                           | `scheduler.ts`                                                                                                                                                                                                          | **Yes**                                                    | Genuine limitation                                            |
| RK-03 | Forced termination can leave notifications in `SENDING`; no auto-recovery                                          | Unchanged. The dispatcher claims `QUEUED → SENDING` and selects only `QUEUED` rows. No manual procedure is written (runbook §10 records the fact only)                                                                                                                                                                                                                                                       | `notifications.dispatcher.ts` (claim; comment "A DB failure mid-row leaves it SENDING")                                                                                                                                 | **Yes**                                                    | Genuine limitation                                            |
| RK-04 | M-1: refund stays `PROCESSING` after an interruption; no auto-recovery; undefined recovery if no refund was issued | Unchanged in code. **Scope is wider than the review recorded:** five code paths, not four (worker late capture, staff approval, customer self-cancel, API late capture, admin retry). Two further cases leave the same state: the refund succeeds but recording the result fails; a retried refund can keep the provider refund id of the failed attempt. A manual procedure is adopted (D-64, runbook §9.1) | `refunds.core.ts` (`prepareGatewayRefund`, `executeGatewayRefund`); callers in `paymentReconciliation.ts`, `refunds.service.ts`, `orders.service.ts`, `payments.service.ts`; `manualRecoveryContract.test.ts` (6 tests) | **Yes**, with the updated scope                            | Genuine limitation (severity not yet classified by the owner) |
| RK-05 | Premature "refund initiated" notifications (flows 2, 3)                                                            | Unchanged. `REFUND_INITIATED` is queued inside the approval and self-cancel transactions, before the gateway call                                                                                                                                                                                                                                                                                            | `refunds.service.ts` line 418; `orders.cancel.ts` line 241                                                                                                                                                              | **Yes**                                                    | Genuine limitation (pre-existing)                             |
| RK-06 | 60 s forced exit can interrupt a running job / post-commit side effects                                            | Unchanged. `WORKER_HARD_EXIT_MS = 60_000`                                                                                                                                                                                                                                                                                                                                                                    | `workerLifecycle.ts` line 15; `workerLifecycle.test.ts` "forces exit 1 after 60 s when cleanup hangs, and only once"                                                                                                    | **Yes**                                                    | Genuine limitation (decided, B4)                              |
| RK-07 | M-2: registry → job signal wiring has no test                                                                      | **No longer true.** Tests exist and pass. A mutation check on 2026-11-24 showed that removing the wiring makes them fail                                                                                                                                                                                                                                                                                     | `tests/unit/jobs/registryWiring.test.ts` (5 tests): cursor carry-over (3) and stop-signal hand-off (2). Added by Batch 10 WP10-1                                                                                        | **No.** Noted as corrected. The test mocks the job modules | Corrected (through Batch 10, itself pending acceptance)       |
| RK-08 | No real OS-signal integration test                                                                                 | Unchanged. Tests inject a process-like event emitter and an exit function                                                                                                                                                                                                                                                                                                                                    | `workerRuntime.test.ts`, `workerLifecycle.test.ts`                                                                                                                                                                      | **Yes**                                                    | Unverified                                                    |
| RK-09 | No real MySQL / two-process concurrency test                                                                       | Unchanged: nothing was executed. A real-database harness with six scenarios is now **prepared** (`tests/db/`). It runs in one process, so it would not cover two worker processes even when executed                                                                                                                                                                                                         | `tests/db/README.md`; DEC-12 not decided                                                                                                                                                                                | **Yes**                                                    | Unverified                                                    |
| RK-10 | No production / deployment verification                                                                            | Unchanged. No hosting decision, no staging, no CI run                                                                                                                                                                                                                                                                                                                                                        | DEC-08 open                                                                                                                                                                                                             | **Yes**                                                    | Unverified                                                    |
| RK-11 | No worker HTTP health endpoint                                                                                     | Unchanged. The worker has no HTTP surface; a heartbeat log line every 60 s is the only signal                                                                                                                                                                                                                                                                                                                | No `express`, `listen(` or `startHttpServer` in `worker.ts`, `workerRuntime.ts`, `workerLifecycle.ts`; test "never listens on a port"                                                                                   | No                                                         | Deferred item (WP-O4 not approved)                            |
| RK-12 | Redis / BullMQ / multi-server scheduling                                                                           | Unchanged. Not implemented, not authorized. **The system is not multi-server safe**                                                                                                                                                                                                                                                                                                                          | No such dependency in `package.json`; D-38, D-61                                                                                                                                                                        | No                                                         | Deferred item                                                 |
| RK-13 | Low unit coverage of `worker.ts` / `bootstrap.ts` exit paths (L-5)                                                 | **Partly improved.** `worker.ts` is still not covered at all. `bootstrap.ts` rose from 35 % to 61.5 % of statements, because the D1 tests cover the new start-up refusal; its two older exit helpers (unsupported Node version, invalid configuration) are still untested. `workerRuntime.ts` 95 %, `workerLifecycle.ts` 89.7 %                                                                              | Coverage runs of 2026-11-24 before and after D1; `tests/unit/bootstrap.test.ts`                                                                                                                                         | **Yes**, with the updated figures                          | Genuine limitation (test gap)                                 |
| RK-14 | Stale scheduler code comment / start-log wording (R-16 / L-4)                                                      | **Corrected.** The header says "One dedicated worker process (D-61)" and the start log says "single dedicated worker process — D-61"                                                                                                                                                                                                                                                                         | `src/jobs/scheduler.ts` lines 6–9 and 93–95, changed 2026-11-21                                                                                                                                                         | No                                                         | Corrected (through Batch 10)                                  |
| RK-15 | Late-capture refunds send no `REFUND_INITIATED` (design says they should, OQ-59)                                   | Unchanged. Late capture queues `ORDER_CANCELLED` only; no `REFUND_INITIATED` in the payments module                                                                                                                                                                                                                                                                                                          | `payments.capture.ts`; no match for `REFUND_INITIATED` under `src/modules/payments/`                                                                                                                                    | No                                                         | Open business decision (OQ-59)                                |

**Result.** Ten risks still need acknowledgement: RK-01, RK-02, RK-03, RK-04, RK-05, RK-06, RK-08,
RK-09, RK-10, RK-13. Two are corrected (RK-07, RK-14). Two are deferred items (RK-11, RK-12). One
is an open business decision (RK-15). The review of 2026-11-20 asked for eleven acknowledgements;
the difference is RK-07.

### 2.1 Audit low findings listed in the review §8 (not in the RK register)

| Finding                                                                          | State on 2026-11-24                                                                                                              |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| L-1: a synchronous throw in `job.run()` escapes and exits the worker with code 1 | **Corrected** by the scheduler fix; `scheduler.test.ts` "is logged as a failed run, does not escape, and the schedule continues" |
| L-2: a signal during the start-up database connect gets Node's default handling  | Open. The signal handlers are registered after the connect attempt (`workerRuntime.ts` lines 54 and 67)                          |
| L-3: the forced-exit timer is `unref()`'d                                        | Open (`workerLifecycle.ts` line 58)                                                                                              |
| L-5: the `unhandledRejection` and process-entry paths are untested               | Open; see RK-13                                                                                                                  |

### 2.2 The review's own position

"Acceptance blockers within Batch 9's authorized scope: none identified." Recommendation:
"ACCEPTABLE WITH EXPLICIT USER RISK ACKNOWLEDGEMENT". Nothing found in this reconciliation changes
that recommendation. It remains a recommendation.

## 3. Batch 10 — work-package evidence

Scope decided as D-65: WP10-1 … WP10-6 and the scheduler fix. All test files below were run today
and pass. "Tagged" means the test name carries the work-package label.

| Work package                             | Source changed                                                         | Test file(s)                                                                                             | Tests                                         | What the tests show                                                                                                                                                                  | Limitations                                                                                                                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WP10-1 Registry wiring tests             | None (tests only)                                                      | `tests/unit/jobs/registryWiring.test.ts`                                                                 | 5                                             | Run N+1 receives the cursor returned by run N (reconciliation, tracking); registries do not share cursors; the scheduler's stop signal reaches the three long jobs. Mutation-checked | Job modules are mocked. It proves the wiring, not the jobs                                                                                                                      |
| WP10-2 Per-item error isolation          | `src/jobs/catalogAggregates.ts`                                        | `tests/unit/jobs/catalogJobs.test.ts`                                                                    | 26 in the file; 6 tagged WP10-2               | One product fails, the next still updates; summary `{ products: 2, updated: 1, errors: 1 }`; a failure outside the per-product loop still fails the run                              | Errors are logged and counted, but the run still ends as a normal run and nothing alerts                                                                                        |
| WP10-3 Reconciliation late-capture tests | None (tests only)                                                      | `tests/unit/jobs/paymentReconciliation.test.ts`                                                          | 26 in the file; 14 tagged WP10-3              | Both late-capture paths end in a refund; the gateway refund runs after the commit and outside any transaction; ledger rows; provider failure; retry; duplicate prevention            | Mock gateway and mocked database. A failed refund is not counted in the job summary. If recording the refund result fails, the refund stays `PROCESSING` (same family as RK-04) |
| WP10-4 OpenAPI download content types    | `scripts/generate-openapi.ts`; regenerated `docs/openapi/openapi.json` | `tests/unit/scripts/openapi.test.ts`                                                                     | 8 in the file; 2 tagged WP10-4                | Five download operations document what the routes send; `npm run openapi:check` passes (248 operations)                                                                              | No runtime change. The variant barcode image is still documented as JSON (DC-05, outside the five approved operations)                                                          |
| WP10-5 Configurable best-seller window   | `src/jobs/catalogAggregates.ts`                                        | `tests/unit/jobs/catalogJobs.test.ts`                                                                    | 13 tagged WP10-5                              | A valid setting changes the window; bounds 1 and 730; missing, invalid and malformed values fall back to 90                                                                          | The settings seed has not run, so 90 days applies today. A database error while reading the setting fails the whole run                                                         |
| WP10-6 Cart test gaps                    | None (tests only)                                                      | `tests/integration/modules/cart/cartTransactionalRace.test.ts`; `tests/unit/jobs/abandonedCarts.test.ts` | 11 and 10 in the files; 4 and 3 tagged WP10-6 | Re-resolution creates a fresh cart (add item, merge); retry race with one and with two failed claims; exact 30-day and 90-day boundaries                                             | **Mocked transactions.** These tests are not evidence of MySQL locking, isolation or uniqueness behaviour                                                                       |
| Scheduler fix (IMP-09)                   | `src/jobs/scheduler.ts`                                                | `tests/unit/jobs/scheduler.test.ts`                                                                      | 6 in the file; 1 for the fix                  | A synchronous throw from a job is logged as a failed run and the schedule continues. Mutation-checked. Comment and log wording match D-61                                            | None found                                                                                                                                                                      |

**Totals for the seven test files above:** 92 tests, all pass (5 + 26 + 26 + 8 + 11 + 10 + 6). Full
suite on 2026-11-24 after D1: 120 files, 3,124 passed, 3 todo, 0 failed.

**Source files changed by Batch 10:** `src/jobs/catalogAggregates.ts`, `src/jobs/scheduler.ts`,
`scripts/generate-openapi.ts`, and the generated `docs/openapi/openapi.json`. No schema, migration,
seed, dependency or API-behaviour change.

**Unresolved defects:** none found by the Batch 10 tests. Three observations are recorded as
limitations, not defects: job errors raise no alert; a failed late-capture refund is not counted in
the job summary; a failure while recording a refund result leaves the refund `PROCESSING`.

**What the evidence is not.** Every test uses a mocked database and the mock gateway. None of it is
real-MySQL, real-provider, CI or production evidence.

## 4. Exact remaining risks

**Batch 9 (to acknowledge):** RK-01, RK-02, RK-03, RK-04 (five paths), RK-05, RK-06, RK-08, RK-09,
RK-10, RK-13 (updated figures).

**Batch 9 (to note, not to acknowledge as open risks):** RK-07 and RK-14, corrected; RK-11 and
RK-12, deferred; RK-15, open business decision; audit lows L-2 and L-3, open.

**Batch 10 (to acknowledge):**

1. All evidence is mocked. The cart and reconciliation tests are not MySQL concurrency evidence.
2. WP10-1 proves the registry wiring with mocked job modules.
3. WP10-2: per-product errors are logged and counted; nothing alerts.
4. WP10-3: a failed late-capture refund is not counted in the job summary; a failure while recording
   a refund result leaves the refund `PROCESSING`.
5. WP10-4: the variant barcode image is still documented as JSON (DC-05).
6. WP10-5: the default of 90 days applies until the settings seed runs; a database error while
   reading the setting fails the run.

## 5. Proposed acceptance statements

Neither statement is in force. Each takes effect only if you send it, or your own wording.

_Update 2026-11-24: the owner sent an acceptance for each batch, in the owner's own wording, acknowledging the ten risks of statement A and the six limitations of statement B. The owner's exact words are recorded in `PHASE3-PHASE4-MASTER-PROGRESS-REPORT.md` §18. The statements below are kept as proposed._

### A. Batch 9

> **Batch 9 (dedicated background worker, D-61): ACCEPTED — OFFLINE MOCKED SCOPE ONLY.**
>
> I acknowledge these risks and limitations:
>
> 1. RK-01 — Single worker by discipline only; no lock / runtime enforcement.
> 2. RK-02 — Two workers duplicate every scheduled job.
> 3. RK-03 — Forced termination can leave notifications in `SENDING`; no auto-recovery, and no
>    manual procedure is written.
> 4. RK-04 — M-1: a gateway refund stays `PROCESSING` after an interruption, in five code paths
>    (worker late capture, staff approval, customer self-cancel, API late capture, admin retry);
>    no automatic recovery; recovery is undefined if no refund was issued. The manual procedure is
>    runbook §9.1.
> 5. RK-05 — Premature "refund initiated" notifications in staff approval and customer self-cancel.
> 6. RK-06 — The 60 s forced exit can interrupt a running job and post-commit side effects.
> 7. RK-08 — No real OS-signal integration test.
> 8. RK-09 — No real MySQL or two-process concurrency test. The prepared harness has not been
>    executed and does not cover two processes.
> 9. RK-10 — No production or deployment verification.
> 10. RK-13 — Limited unit coverage of process entry and exit paths: `worker.ts` is not covered and
>     `bootstrap.ts` is partly covered.
>
> I note, and do not acknowledge as open risks: RK-07 (the registry wiring now has tests) and RK-14
> (the scheduler comment and start log are corrected), both through Batch 10 changes; the deferred
> items RK-11 (no worker health endpoint) and RK-12 (no Redis / BullMQ / multi-server scheduling —
> the system is not multi-server safe); the open business decision RK-15 (late-capture refunds send
> no `REFUND_INITIATED`, OQ-59); and the open audit low findings L-2 and L-3.
>
> This acceptance covers the worker implementation as verified with mocked tests. It does not cover
> MySQL behaviour, real operating-system signals, two worker processes, real providers, deployment
> or production readiness. It does not accept Batch 10, approve any deferral, classify M-1, meet G4
> or approve Phase 4.

**To reject:** "Batch 9 is not accepted. Required before acceptance: …"
**To hold:** "Batch 9 stays pending until …"

### B. Batch 10

> **Batch 10 (WP10-1 to WP10-6 and the scheduler fix, D-65): ACCEPTED — OFFLINE MOCKED SCOPE ONLY.**
>
> I acknowledge these limitations:
>
> 1. All evidence is mocked: mocked database, mock payment gateway. The cart and reconciliation
>    tests are not evidence of MySQL locking, isolation or concurrency.
> 2. WP10-1 proves the registry wiring with mocked job modules, not the behaviour of the jobs.
> 3. WP10-2: per-product errors in the two catalogue jobs are logged and counted; the run still ends
>    as a normal run and nothing alerts.
> 4. WP10-3: a failed late-capture refund is not counted in the job summary, and a failure while
>    recording a refund result leaves the refund `PROCESSING`.
> 5. WP10-4: the variant barcode image is still documented as JSON in the OpenAPI specification
>    (DC-05).
> 6. WP10-5: the best-seller window is 90 days until the settings seed runs, and a database error
>    while reading the setting fails the run.
>
> No defect was found by the Batch 10 tests.
>
> This acceptance covers the seven items as verified with mocked tests. It does not cover MySQL
> behaviour, real providers, CI, deployment or production readiness. It does not accept Batch 9,
> approve any deferral or other decision, meet G4 or approve Phase 4.

**To reject:** "Batch 10 is not accepted. Required before acceptance: …"

## 6. What acceptance means

| Acceptance would mean                                                                 | Acceptance would not mean                                                       |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| You have seen the evidence and the listed risks, and accept the batch on that basis   | That the batch is verified on MySQL, with real signals or in a deployment       |
| The batch is recorded as "ACCEPTED — OFFLINE MOCKED SCOPE ONLY", like Batches 7 and 8 | That any risk is closed. Each stays open until fixed, verified or deferred      |
| The batch register for the G4 package is one step more complete                       | That G4 is met or Phase 4 approved. Batch acceptance is not a G4 exit criterion |

The two batches are independent decisions. Accepting Batch 9 without Batch 10 is possible: the
RK-07 tests and the RK-14 correction exist in the code either way.

## 7. Documents corrected by this review

| Document                                    | Correction                                                                                                                                                                                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PHASE4-FINAL-OWNER-DECISION-PACKAGE.md`    | Part 3: RK-07 no longer listed for acknowledgement (with the reason); RK-13 position updated; proposed wording replaced by statement A, the earlier wording kept as superseded. Part 4: pointer to statement B and the exact test counts |
| `PHASE4-G4-CRITERIA-AND-EVIDENCE-MATRIX.md` | Batch-acceptance row points to this document                                                                                                                                                                                             |

Not changed: the Batch 9 review and its risk register, every other report, all source and test
files. Both batches remain **PENDING USER ACCEPTANCE**. _(True when written. Both were accepted by the owner later on 2026-11-24.)_
