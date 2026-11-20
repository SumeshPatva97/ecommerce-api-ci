# Phase 4 — Batch 9 Updated Final Acceptance Review

| Field       | Value                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------- |
| Document ID | P4-BATCH9-ACCEPT-REVIEW-02                                                                                            |
| Review date | 2026-11-20 (22:46 – 22:55 IST)                                                                                        |
| Nature      | **Read-only evidence review.** No implementation, fix, documentation edit or status change                            |
| Supersedes  | Nothing. It updates `PHASE4-BATCH9-FINAL-ACCEPTANCE-REVIEW.md` (P4-BATCH9-ACCEPT-REVIEW-01) with the current evidence |
| Batch 9     | **COMPLETE — PENDING USER ACCEPTANCE** (unchanged; acceptance is the user's decision only)                            |

## 1. Scope and files inspected

**Scope:** the Batch 9 implementation (WP1–WP7 + WP-O2, decisions B1–B7) against current source,
tests and artifacts; the previous acceptance review; and the refund / notification documentation
alignment reports.

**Source (`ecommerce-api/src/`):**

- `worker.ts`, `workerRuntime.ts`, `bootstrap.ts`, `server.ts`
- `core/lifecycle/workerLifecycle.ts`, `core/lifecycle/httpServer.ts`, `core/health/readiness.ts`
- `jobs/scheduler.ts`, `jobs/registry.ts`, `jobs/paymentReconciliation.ts`, `jobs/shipmentTrackingPoll.ts`, `jobs/notificationDispatcher.ts`
- `modules/notifications/notifications.dispatcher.ts`, `modules/notifications/notifications.service.ts`
- `modules/refunds/refunds.service.ts`, `modules/refunds/refunds.core.ts`
- `modules/payments/payments.refunds.ts`, `modules/payments/payments.capture.ts`, `modules/payments/payments.service.ts`
- `modules/orders/orders.service.ts`, `modules/orders/orders.cancel.ts`
- `modules/shipping/shipping.shipments.ts`

Part of the source was re-read in full during this session; the rest was re-checked by targeted
search in this review.

**Tests (`ecommerce-api/tests/`):**

- `unit/workerRuntime.test.ts`
- `unit/core/workerLifecycle.test.ts`
- `unit/jobs/scheduler.test.ts`, `unit/jobs/paymentReconciliation.test.ts`, `unit/jobs/shipmentTrackingPoll.test.ts`
- `unit/modules/notifications/dispatcherJob.test.ts`

**Artifacts (read only):**

- `package.json` scripts
- `dist/{server,worker,workerRuntime,bootstrap}.js` (modification times)
- `coverage/index.html` (totals)
- `node_modules/.vite/vitest/<hash>/results.json` (last run summary)

**Reports (`ecommerce-api/docs/`):**

- `PHASE4-BATCH9-FINAL-ACCEPTANCE-REVIEW.md`
- `PHASE4-BATCH9-COMPLETION-REPORT.md`
- `PHASE4-BATCH9-INDEPENDENT-AUDIT-REPORT.md`
- `PHASE4-BATCH9-DOCUMENTATION-CORRECTION-REPORT.md`
- `PHASE4-M1-REFUND-PROCESSING-STATE-DOCUMENTATION-CORRECTION-REPORT.md`
- `PHASE4-REFUND-RISK-DOCUMENTATION-ALIGNMENT-REPORT.md`
- `PHASE4-FINAL-REFUND-DOCUMENTATION-CONSISTENCY-REPORT.md`
- `PHASE4-FINAL-REFUND-AND-NOTIFICATION-DOCUMENTATION-ALIGNMENT-REPORT.md`
- `PHASE4-FINAL-FOUR-DOCUMENTATION-CORRECTIONS-REPORT.md`
- `PHASE4-JOBS-AND-SCHEDULING.md`
- `PHASE3-PHASE4-MASTER-PROGRESS-REPORT.md` (statuses)
- `operations/DEPLOYMENT_AND_OPERATIONS.md`

**Canonical documentation (`project-documentation/`):**

- `04-backend/API_DOCUMENTATION.md` §4.11
- `06-workflows/ADMIN_WORKFLOWS.md` §9, §11
- `06-workflows/NOTIFICATION_WORKFLOWS.md` §3
- `04-backend/BACKEND_STRUCTURE.md` §13, §14, §22
- Targeted search across all `.md` files for "retryable", M-1 resolution claims and `REFUND_INITIATED`

**Not accessed:** `.env` / `.env.*`, `.git`, MySQL, Redis, gateways, couriers, any external service.

## 2. Has anything changed since the previous review?

- **Source, tests, scripts, Prisma, package files, Docker, tsconfig, ESLint, Vitest, CI:** no file
  modified after **20:57** on 2026-11-20 (newest: `src/jobs/README.md` 20:57;
  `tests/unit/jobs/shipmentTrackingPoll.test.ts` 20:56). This is the end of the Batch 9 window.
  The implementation reviewed by P4-BATCH9-ACCEPT-REVIEW-01 is therefore **unchanged**.
- **Since then, only documentation changed** (the refund / notification alignment tasks). None of
  those changes alters behaviour.

## 3. Implementation findings (current source)

| #   | Claim                                                 | Current evidence                                                                                                                                                                                                                 | Result                            |
| --- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| I1  | API never starts the scheduler                        | `server.ts`: 0 matches for `createJobScheduler`, `buildScheduledJobs`, `jobs/registry`, `jobs/scheduler`; calls `warnIfJobsEnabledForApi`                                                                                        | PASS                              |
| I2  | Dedicated worker entrypoint runs the 10 registry jobs | `worker.ts` → `runWorker` → `createJobScheduler(buildScheduledJobs(container))`; registry lists 10 jobs                                                                                                                          | PASS                              |
| I3  | `JOBS_ENABLED` gate                                   | `workerRuntime.ts` `if (!config.jobs.enabled)` → log, `started: false`, nothing connected; `worker.ts` exits 0; default `false` (`env.ts`)                                                                                       | PASS                              |
| I4  | No HTTP listener in the worker                        | 0 matches for `express`, `startHttpServer(` or `.listen(` in `worker.ts`, `workerRuntime.ts`, `workerLifecycle.ts`                                                                                                               | PASS                              |
| I5  | Shared bootstrap                                      | `bootstrap.ts`: runtime guard, config, role-tagged logger, DB client, container, connect-or-continue, B2 warning                                                                                                                 | PASS (low coverage of exit paths) |
| I6  | SIGTERM / SIGINT graceful shutdown                    | `workerLifecycle.ts`: handlers for SIGTERM, SIGINT, `unhandledRejection`, `uncaughtException`; cleanup once (`onClose`: clear heartbeat → `scheduler.stop()` → DB disconnect)                                                    | PASS (mocked process only)        |
| I7  | Second signal ignored; forced exit                    | "worker shutdown already in progress; signal ignored"; `WORKER_HARD_EXIT_MS = 60_000`, forced exit 1, `exitOnce`                                                                                                                 | PASS (mocked process only)        |
| I8  | Stop requests                                         | `scheduler.ts` `stop()`: `stopController.abort()`, then awaits in-flight runs. Registry passes `signal` to dispatch, reconciliation, tracking poll (3 sites). Each job checks before its next item                               | PASS WITH LIMITATION (M-2)        |
| I9  | Notification dispatch                                 | Worker job every 15 s; conditional `QUEUED → SENDING` claim; no reclaim of stale `SENDING` rows (0 matches)                                                                                                                      | PASS WITH LIMITATION              |
| I10 | Single-worker limitation                              | No lock anywhere; per-process overlap guard only; start-up log demands exactly one worker                                                                                                                                        | Known limitation                  |
| I11 | Scripts and build output                              | `start` = `node dist/server.js`; `start:worker` = `node dist/worker.js`; `dev:worker` = `tsx watch src/worker.ts`. `dist/{server,worker,workerRuntime,bootstrap}.js` exist, dated 20:59:30 (after the last source change, 20:57) | PASS (build not re-run)           |

## 4. Test and validation evidence

| Evidence                                                            | Type                                                                                              | Result                                                                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `npm run format:check`                                              | **Executed in this review** (Node 24.12.0)                                                        | PASS                                                                                                                  |
| `npm run lint` (`--max-warnings 0`)                                 | **Executed in this review**                                                                       | PASS                                                                                                                  |
| `npm run typecheck`                                                 | **Executed in this review**                                                                       | PASS                                                                                                                  |
| `npm run openapi:check`                                             | **Executed in this review** (read-only: `--check` does not write; no `.env` loading)              | PASS ("openapi.json is up to date")                                                                                   |
| Gate side effects                                                   | **Checked in this review**                                                                        | No project file modified by the four gates (modification-time check against a marker)                                 |
| Test-file count                                                     | **Counted in this review**                                                                        | 104 `*.test.ts` files                                                                                                 |
| Last recorded test run                                              | **Existing artifact, read only** (Vitest results cache, 21:01:40, after the last source change)   | 104 files recorded, **0 failed files**. Individual test count not shown by the cache                                  |
| Coverage                                                            | **Existing artifact, read only** (`coverage/index.html`, 21:01:42)                                | Statements 91.42 % · Branches 81.85 % · Functions 93.87 % · Lines 93.16 %. Identical to the Batch 9 completion report |
| Full test suite (1,344 tests)                                       | Historical (completion report)                                                                    | Recorded PASS. **Not re-executed** (Vitest writes its results cache; the config loader may read `.env`)               |
| `npm run build`                                                     | Historical + artifact dates                                                                       | Recorded PASS. **Not re-executed** (writes `dist/`)                                                                   |
| `npx prisma validate`                                               | Historical                                                                                        | Recorded PASS. **Not re-executed** (may resolve environment files)                                                    |
| Batch 9 tests                                                       | Present: `workerRuntime.test.ts` (6), `workerLifecycle.test.ts` (5), stop-request tests (4 files) | Exist; recorded PASS; consistent with the 0-failed cache                                                              |
| Real process run, real OS signals, MySQL, two processes, deployment | None                                                                                              | **NOT VERIFIED**                                                                                                      |

All test evidence is **offline / mocked**.

## 5. Comparison with the previous acceptance review (P4-BATCH9-ACCEPT-REVIEW-01)

| Previous finding                                                    | Status now                                                                                                                                                                                |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-01 … R-06 PASS (A1–A4, scripts, gates)                            | Still PASS. Code unchanged; gates re-executed and passing                                                                                                                                 |
| R-07 … R-14 PASS WITH LIMITATION                                    | Unchanged (same code)                                                                                                                                                                     |
| **R-15 FAIL: M-1 documented with the wrong state (`approved`)**     | **Resolved (documentation).** All eight documents now say `PROCESSING` (M-1 state correction report). Recovery wording was further aligned in three later tasks. No implementation change |
| R-16 stale scheduler comment / start log                            | **Still open** (`scheduler.ts` lines 6–8 and 91); code comment and log text only                                                                                                          |
| R-17 build / Prisma / full suite not re-run                         | Still not re-run. Additional read-only evidence now: build artifacts post-date the last source change; Vitest cache shows 0 failed files; coverage totals match                           |
| R-18 / R-19 real signals, MySQL, multi-server, production readiness | Still NOT VERIFIED                                                                                                                                                                        |
| R-20 / R-21 deferred items                                          | Still DEFERRED                                                                                                                                                                            |
| §7.1 "issue the refund there" instruction                           | Removed (dated correction); recovery when no refund was issued is stated as **undefined**                                                                                                 |
| Risk 1 (M-1, worker only)                                           | Expanded to **four flows** (one worker, three API), all pre-existing                                                                                                                      |
| New since the previous review                                       | Premature "refund initiated" notifications (two flows, verified); late-capture flows send no `REFUND_INITIATED` (verified); undefined recovery when the provider confirms no refund       |

**Previous recommendation:** "ACCEPTABLE ONLY AFTER USER ACKNOWLEDGES SPECIFIC RISKS".

**Assessment:** still justified in substance. The one FAIL that kept it from option 1 (R-15) is now
resolved in the documentation. The new findings are pre-existing refund / notification behaviours
outside Batch 9's code changes; they add risks to acknowledge, not blockers. See §12.

## 6. Updated M-1 refund-risk assessment (current code)

| #   | Flow                                        | Process    | Committed before the gateway call                                               | `REFUND_INITIATED` before the call                    |
| --- | ------------------------------------------- | ---------- | ------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 1   | Late capture via `payment-reconciliation`   | **Worker** | Refund `APPROVED` → `PROCESSING` (`refundsModuleHook` → `prepareGatewayRefund`) | No                                                    |
| 2   | Staff refund approval (`approve`)           | API        | `REQUESTED → APPROVED → PROCESSING`                                             | **Yes**                                               |
| 3   | Customer self-cancel (`cancelMine`)         | API        | Refund created `APPROVED` → `PROCESSING` (prepaid, original method)             | **Yes** (plus `ORDER_CANCELLED` "refund … initiated") |
| 4   | Late capture via `verify` / `handleWebhook` | API        | Same hook as flow 1                                                             | No                                                    |

Each statement below was checked against the current code:

| Statement                                                                     | Status                                                                                                                                                            |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A refund may be committed in `PROCESSING` before the gateway call             | **Accurate** (`prepareGatewayRefund` sets `PROCESSING` inside the caller's transaction)                                                                           |
| An interruption between commit and the gateway call can leave it `PROCESSING` | **Accurate** (the call runs only after commit; a forced exit or crash in between leaves the state). Real timing NOT VERIFIED                                      |
| No automatic recovery for interrupted `PROCESSING` refunds                    | **Accurate.** No job or route re-executes the call. The refund webhook matches by `providerRefundId`, which an un-called refund lacks                             |
| Retry accepts only `FAILED`                                                   | **Accurate** ("Only failed refunds can be retried.")                                                                                                              |
| `complete` records a refund; it does not initiate a gateway refund            | **Accurate** (`markRefundCompleted`; no provider call)                                                                                                            |
| Gateway refunds may be completed only after provider confirmation             | **Accurate as a documented rule.** The code accepts `PROCESSING` for gateway refunds; the confirmation requirement is a procedural rule, **not enforced by code** |
| If the provider confirms no refund was issued, recovery is undefined          | **Accurate.** Open business decision                                                                                                                              |
| Bank-transfer refunds have a separate legitimate completion path              | **Accurate** (`complete` accepts `APPROVED` / `PROCESSING` for `BANK_TRANSFER`; no gateway job)                                                                   |
| `REFUND_INITIATED` can be queued before the gateway call in flows 2 and 3     | **Accurate** (`enqueue(tx, …)` → `tx.notification.create` with `QUEUED`)                                                                                          |
| Late-capture automatic refunds send no `REFUND_INITIATED`                     | **Accurate.** 0 occurrences in `payments.capture.ts` / `payments.refunds.ts`                                                                                      |

**Documentation does not imply the risk is solved.** No document claims M-1 is fixed or that recovery
is implemented. Every current description states "not fixed", "no automatic recovery" and "recovery
undefined" where relevant. The documentation corrections are **not** implementation fixes.

**Scope:** M-1 is **pre-existing**. Batch 9 moved flow 1 into the worker (60 s forced exit) and did
not introduce the pattern. Flows 2–4 are outside Batch 9's code.

## 7. Notification timing and behaviour

- Notification rows are written with status `QUEUED` in the business transaction (outbox). The
  worker's `notification-dispatch` (every 15 s) claims each row with a conditional
  `QUEUED → SENDING` update.
- A forced kill during a send can leave the row in `SENDING`. No code reclaims stale `SENDING` rows
  (WP-O3 not approved); manual recovery is needed.
- In flows 2 and 3, `REFUND_INITIATED` (and the self-cancel `ORDER_CANCELLED` refund note) is
  delivered regardless of the gateway outcome. Delivery does **not** prove a refund. This is verified
  and pre-existing.
- Late-capture flows:
  - **Stock unavailable:** `ORDER_CANCELLED` ("A full refund will be issued…") is queued at capture.
  - **Already-cancelled order / duplicate capture:** nothing is sent.
  - **`REFUND_COMPLETED`:** sent only on recorded completion.
- The fake email adapter's outbox is process-local. API-sent emails (auth, staff invites) and
  worker-dispatched notifications are held in different processes.

## 8. Worker lifecycle, shutdown and the single-worker requirement

- **Shutdown** waits for running jobs (long jobs stop after their current item). The 60 s forced exit
  can still interrupt a job mid-item: the open transaction rolls back, but post-commit side effects
  (refund gateway call, notification send) can be cut off.
- **Exactly one worker** is required by D-61 and by deployment discipline only. There is no
  distributed lock or runtime enforcement; two workers would run every scheduled job twice. The jobs
  are designed to be idempotent (compare-and-set, unique keys), but this is **unverified on MySQL**.
- **No worker health endpoint.** The worker has no HTTP surface at all (WP-O4 / OQ-34 deferred).
- **Real OS signals** were never delivered in tests. Only mocked `processLike` / `exit` were used.
- **Audit low findings still open:**
  - L-1: a synchronous throw in `job.run()` escapes and exits the worker with code 1;
  - L-2: a signal during the start-up DB connect gets Node's default handling;
  - L-3: the hard-exit timer is `unref()`'d;
  - L-5: the `unhandledRejection` and process-entry paths are untested.

## 9. M-2 — stop-request wiring and tests

| Aspect                                                         | Evidence                                                                                                       | Result                                            |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Scheduler aborts the signal on stop                            | Code + `scheduler.test.ts` ("stop() raises the run signal …")                                                  | PASS (test exists, recorded PASS)                 |
| Each long job stops between items when given an aborted signal | Code + reconciliation / tracking-poll / dispatcher tests (called directly)                                     | PASS (tests exist, recorded PASS)                 |
| Worker passes the scheduler signal to a job                    | `workerRuntime.test.ts` with an **injected** test job                                                          | PASS                                              |
| Production registry passes the signal to the three real jobs   | **Code inspection only** (`registry.ts`: 3 `signal` pass-through sites; `runShipmentTrackingPoll` forwards it) | **PASS WITH LIMITATION**; test proof NOT VERIFIED |

A regression in the registry wiring would go undetected. Its effect would be bounded: shutdown would
take longer, up to the 60 s forced exit.

## 10. Risk register

| ID    | Risk                                                                                                               | Severity   | Evidence                              | Batch 9 scope?                                             | Acceptance implication                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------ | ---------- | ------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------- |
| RK-01 | Single worker by discipline only; no lock / runtime enforcement                                                    | Medium     | Code (no lock), D-61, start-up log    | In scope: B3 decision, by design                           | Known limitation; **acknowledge**                        |
| RK-02 | Two workers duplicate every scheduled job                                                                          | Medium     | Code (per-process overlap guard only) | In scope (consequence of RK-01)                            | Known limitation; **acknowledge**                        |
| RK-03 | Forced termination can leave notifications in `SENDING`; no auto-recovery                                          | Medium     | Code (no stale-`SENDING` reclaim); B5 | In scope (B5); recovery WP-O3 not approved                 | Known limitation; **acknowledge**                        |
| RK-04 | M-1: refund stays `PROCESSING` after an interruption; no auto-recovery; undefined recovery if no refund was issued | Medium     | Code (four flows)                     | Pre-existing; flow 1 runs in the worker; flows 2–4 outside | Known limitation; **acknowledge** (not a Batch 9 defect) |
| RK-05 | Premature "refund initiated" notifications (flows 2, 3)                                                            | Low–Medium | Code                                  | Outside (API refund / cancel code)                         | Known pre-existing behaviour; **acknowledge**            |
| RK-06 | 60 s forced exit can interrupt a running job / post-commit side effects                                            | Medium     | Code (`WORKER_HARD_EXIT_MS`)          | In scope (B4 decision)                                     | Known limitation; **acknowledge**                        |
| RK-07 | M-2: registry → job signal wiring has no test                                                                      | Low        | Code + tests (absence)                | In scope (WP-O2)                                           | Known gap; **acknowledge** (bounded impact)              |
| RK-08 | No real OS-signal integration test                                                                                 | Medium     | Tests (mocked only)                   | In scope, but offline-only acceptance                      | Unverified; **acknowledge**                              |
| RK-09 | No real MySQL / two-process concurrency test                                                                       | Medium     | No evidence; G7 / G8 not authorized   | Deferred (Batch 12)                                        | Unverified; **acknowledge**                              |
| RK-10 | No production / deployment verification                                                                            | Medium     | No evidence; hosting OQ-34 open       | Deferred                                                   | Unverified; **acknowledge**                              |
| RK-11 | No worker HTTP health endpoint                                                                                     | Low        | Code                                  | Deferred (WP-O4 not approved)                              | Deferred item                                            |
| RK-12 | Redis / BullMQ / multi-server scheduling                                                                           | —          | D-61, code                            | Deferred, not authorized                                   | Deferred item; **not multi-server safe**                 |
| RK-13 | Low unit coverage of `worker.ts` / `bootstrap.ts` exit paths (L-5)                                                 | Low        | Coverage report                       | In scope                                                   | Known gap; **acknowledge**                               |
| RK-14 | Stale scheduler code comment / start-log wording (R-16 / L-4)                                                      | Low        | Code                                  | In scope (cosmetic)                                        | Not a blocker                                            |
| RK-15 | Late-capture refunds send no `REFUND_INITIATED` (design says they should, OQ-59)                                   | Low        | Code + NOTIFICATION_WORKFLOWS         | Outside (payments code)                                    | Open business decision                                   |

**Acceptance blockers within Batch 9's authorized scope:** none identified.

## 11. Explicitly unverified

- Real OS signal delivery and container behaviour (OQ-34)
- Any MySQL behaviour:
  - worker and API together;
  - connection pools;
  - job idempotency under real locking;
  - rollback on forced exit.
- Two concurrent worker processes
- Production deployment and operation
- Real gateway timing against the 60 s limit
- Behaviour of an interrupted refund under real conditions
- Re-execution of the full test suite, build and `prisma validate` in this review (artifacts and
  recorded results only)
- Existing database data (the `APPROVED`-without-job guard; runbook 2026-11-18 snapshot)

## 12. Code / documentation inconsistencies found (not fixed)

| #    | Location                                                                              | Inconsistency                                                                                                                                                                                               | Severity |
| ---- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| DC-1 | `project-documentation/04-backend/API_DOCUMENTATION.md` §4.11 retry row               | "Only from `FAILED`; re-submits to gateway". For a bank-transfer refund (no gateway job), retry moves it back to `PROCESSING` for manual completion without any gateway call (`refunds.service.ts` 503–507) | Low      |
| DC-2 | `API_DOCUMENTATION.md` §4.11 create-refund table                                      | No `reasonCode` row; the code accepts an optional `reasonCode` (default `OTHER`). Reported earlier                                                                                                          | Low      |
| DC-3 | `ecommerce-api/docs/PHASE4-JOBS-AND-SCHEDULING.md` (payment-reconciliation paragraph) | Says the late-capture refund is "executed after commit" but does not mention the M-1 interruption limitation or the `SENDING` limitation                                                                    | Low      |
| DC-4 | `src/jobs/scheduler.ts` lines 6–8 and 91 (code comment / log text)                    | Pre-D-61 wording ("more than one API process"; "single instance only — D-38"). R-16                                                                                                                         | Low      |
| DC-5 | Gateway-refund `complete` rule                                                        | Documentation requires provider confirmation, but nothing in code enforces it; it relies on staff procedure. Correctly documented as a rule, not as an enforced control                                     | Info     |

No inconsistency was found in which documentation claims M-1, premature notifications or the
single-worker limitation are fixed.

## 13. Final acceptance recommendation

**Recommendation: ACCEPTABLE WITH EXPLICIT USER RISK ACKNOWLEDGEMENT.**

**Why:**

- **The implementation matches its authorized scope.**
  - Every Batch 9 claim (I1–I11) is supported by the current source.
  - The source has not changed since Batch 9.
  - Four read-only gates pass now.
  - Existing artifacts (build output, 0-failed Vitest cache, identical coverage totals) are
    consistent with the recorded results.
  - Excluded packages (lock, `SENDING` recovery, health / container, `.env.example`, Redis / BullMQ)
    were not implemented.
- **The previous review's only FAIL (R-15) is resolved** at documentation level. The refund
  documentation now accurately describes the four flows, the `PROCESSING` state, the `complete`
  semantics, the undefined recovery case and the notification timing. None of it claims a fix.
- **No acceptance blocker within Batch 9's scope.** The open items are either:
  - known limitations decided or accepted in the Batch 9 decisions (B3 single worker, B4 60 s exit,
    B5 `SENDING`);
  - pre-existing refund / notification behaviours outside Batch 9's code (M-1 flows 2–4, premature
    notifications, OQ-59);
  - deferred verification consistent with the offline-mocked acceptance basis used for Batches 7 and
    8 (real signals, MySQL, deployment).
- **Not "ACCEPTABLE ONLY AFTER SPECIFIED EVIDENCE GAPS ARE CLOSED".** The remaining gaps (MySQL,
  real signals, two processes) require gates (G7 / G8, Batch 12) that are not authorized and are
  outside an offline-mocked acceptance. If you require them before acceptance, that option applies
  instead.

**Risks requiring your explicit acknowledgement:** RK-01 to RK-10 and RK-13 (§10). In particular:

1. Exactly one worker, by discipline only; a second worker duplicates every job.
2. M-1 (four flows, pre-existing):
   - an interrupted refund stays `PROCESSING` with no automatic recovery;
   - `complete` only after the provider confirms completion (a procedural rule, not enforced);
   - recovery is undefined if no refund was issued.
3. Premature "refund initiated" notifications in staff approval and customer self-cancel.
4. `SENDING` notifications after a forced kill need manual recovery.
5. M-2 wiring is untested.
6. Validation is offline / mocked only. There is no real OS-signal, MySQL, two-process or deployment
   evidence. The system is **not multi-server safe** and **not production-ready**.

If accepted, the precedent suggests "ACCEPTED — OFFLINE MOCKED SCOPE ONLY". **This review does not
accept Batch 9.**

## 14. Safeguards

- **Exactly one new file created:** this report. No existing file was modified (modification-time
  check).
- **Executed commands were read-only:** file listings and searches; `format:check`, `lint`,
  `typecheck`, `openapi:check` (verified to modify nothing). Gate output was written to the session
  scratchpad, outside the project.
- **Prettier** was applied only to this new report.
- **Not touched:** source code, tests, configuration, packages, lockfile, schema, migrations, seeds,
  Docker files, `.env*` (not opened) and `.git` (not accessed).
- **No database or external service was accessed.**

**Statuses (unchanged):**

- Phase 1–3: **APPROVED — COMPLETE**
- Phase 4: **IN PROGRESS — NOT APPROVED**
- Batch 7: **ACCEPTED — OFFLINE MOCKED SCOPE ONLY**
- Batch 8 + M1: **ACCEPTED — OFFLINE MOCKED SCOPE ONLY**
- Batch 9: **COMPLETE — PENDING USER ACCEPTANCE**
- Batch 10: **NOT AUTHORIZED**
- G4: **NOT MET**
- Production readiness: **NOT ESTABLISHED**
