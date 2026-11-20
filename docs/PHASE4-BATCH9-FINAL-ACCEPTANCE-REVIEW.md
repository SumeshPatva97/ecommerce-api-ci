# Phase 4 — Batch 9 Final Acceptance Review

| Field       | Value                                                                     |
| ----------- | ------------------------------------------------------------------------- |
| Document ID | P4-BATCH9-ACCEPT-REVIEW-01                                                |
| Review date | 2026-11-20 (22:02 – 22:20 IST)                                            |
| Subject     | Phase 4 Batch 9 — dedicated background worker (D-61)                      |
| Nature      | **Read-only review.** No implementation, fix or documentation edit        |
| Batch 9     | **COMPLETE — PENDING USER ACCEPTANCE** (unchanged; only the user decides) |

## 1. Scope and read-only declaration

This review checks the Batch 9 implementation and its evidence against the authorized scope. Report
claims were re-checked against source code and test files, not taken on trust.

Nothing was changed. The review did not:

- modify, create, delete, rename or reformat any file except this report;
- modify tests, configuration, packages, the schema, migrations, seeds or Docker files;
- access a database, Redis, a gateway, a courier, SMTP or any external service;
- run Git or inspect `.git`;
- open `.env` / `.env.*`.

Only clearly read-only checks were executed (§6).

**Deliberately not executed:**

| Check                 | Reason                                                                    |
| --------------------- | ------------------------------------------------------------------------- |
| Test suite (`vitest`) | Writes a results cache under `node_modules/.vite`; would create files     |
| `npm run build`       | Writes `dist/`                                                            |
| `npx prisma validate` | The Prisma configuration may resolve environment files; could read `.env` |

Before running `openapi:check` I confirmed that it does not write files and does not load `.env`:
`--check` only reads, and it uses `loadConfig`, not `loadConfigFromProcess`. A file
modification-time check after the gate runs found **no changed files** in the project.

## 2. Files inspected (43)

**Batch 9 records (`ecommerce-api/docs/`):**

1. `PHASE4-BATCH9-TECHNICAL-REVIEW-AND-IMPLEMENTATION-PLAN.md`
2. `PHASE4-BATCH9-COMPLETION-REPORT.md`
3. `PHASE4-BATCH9-INDEPENDENT-AUDIT-REPORT.md`
4. `PHASE4-BATCH9-DOCUMENTATION-CORRECTION-REPORT.md`
5. `PHASE4-FINAL-D61-DOCUMENTATION-CLEANUP-REPORT.md`
6. `PHASE4-DOC06-CORRECTION-REPORT.md`
7. `PHASE3-PHASE4-MASTER-PROGRESS-REPORT.md`
8. `PHASE4-MASTER-COMPLETION-ROADMAP.md`
9. `PHASE4-JOBS-AND-SCHEDULING.md` (targeted search)

**Other API documentation:**

10. `ecommerce-api/README.md` (targeted search)
11. `src/jobs/README.md` (targeted search)

**Canonical documentation (`project-documentation/`):**

12. `04-backend/BACKEND_STRUCTURE.md`
13. `09-deployment/REPOSITORY_SETUP_GUIDE.md`
14. `09-deployment/DEPLOYMENT_ARCHITECTURE.md`
15. `02-architecture/SYSTEM_ARCHITECTURE.md`
16. `02-architecture/REPOSITORY_ARCHITECTURE.md`

**Source (`ecommerce-api/src/` unless noted):**

17. `worker.ts`
18. `workerRuntime.ts`
19. `bootstrap.ts`
20. `server.ts`
21. `core/lifecycle/workerLifecycle.ts`
22. `jobs/scheduler.ts`
23. `jobs/registry.ts`
24. `jobs/paymentReconciliation.ts`
25. `jobs/shipmentTrackingPoll.ts`
26. `jobs/notificationDispatcher.ts`
27. `modules/shipping/shipping.shipments.ts` (signal check)
28. `modules/notifications/notifications.dispatcher.ts` (signal check, `SENDING` claim)
29. `modules/payments/payments.refunds.ts`
30. `modules/refunds/refunds.core.ts`
31. `modules/refunds/refunds.service.ts`
32. `modules/payments/payments.service.ts`
33. `core/config/index.ts`
34. `scripts/generate-openapi.ts`

**Package scripts:**

35. `package.json` (scripts listed earlier in this session; modification time 20:53, so unchanged since Batch 9)

**Tests (`ecommerce-api/tests/`):**

36. `unit/workerRuntime.test.ts`
37. `unit/core/workerLifecycle.test.ts`
38. `unit/jobs/scheduler.test.ts`
39. `unit/jobs/paymentReconciliation.test.ts`
40. `unit/jobs/shipmentTrackingPoll.test.ts`
41. `unit/modules/notifications/dispatcherJob.test.ts`

**Configuration (targeted search):**

42. `tsconfig*.json` (no incremental build output)
43. ESLint configuration (no cache, no environment loading)

## 3. Original Batch 9 scope (authorized 2026-11-20)

**Approved:** WP1–WP7 + WP-O2, with decisions B1–B7.

| Package | Scope                                       |
| ------- | ------------------------------------------- |
| WP1     | Shared bootstrap                            |
| WP2     | Worker graceful shutdown (60 s forced exit) |
| WP3     | Worker entrypoint                           |
| WP4     | Scheduler removed from the API              |
| WP5     | Scripts                                     |
| WP6     | Tests                                       |
| WP7     | Documentation                               |
| WP-O2   | Cooperative stop                            |

**Not approved:**

- WP-O1 (lock);
- WP-O3 (stuck-`SENDING` recovery);
- WP-O4 (container / health check);
- WP-O5 (`.env.example`);
- Redis / BullMQ;
- multi-server scheduling.

## 4. Implementation verification

"Code" means established by reading the source. "Test (recorded)" means a test exists and its PASS
was recorded in the completion report; tests were **not executed in this review**.

| #   | Claim                                    | Evidence                                                                                                                                                                                                                                                                                                                                                      | Evidence type                                     | Result                     |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------- |
| A1  | API no longer starts the scheduler       | `server.ts`: no `createJobScheduler` / `registry` import; calls `warnIfJobsEnabledForApi`. Static test `workerRuntime.test.ts` "API entrypoint never builds or starts the job scheduler"                                                                                                                                                                      | Code + test (recorded)                            | PASS                       |
| A2  | Worker entrypoint runs the intended jobs | `worker.ts` → `runWorker` → `createJobScheduler(buildScheduledJobs(container))`. The registry has exactly 10 jobs (reservation-expiry … token-cleanup). Tests: "registers all 10 jobs exactly once"; registry names / intervals in `scheduler.test.ts`                                                                                                        | Code + test (recorded)                            | PASS                       |
| A3  | `JOBS_ENABLED` behaviour                 | `workerRuntime.ts`: if not enabled, logs and returns `started: false` before connecting anything; `worker.ts` then exits 0. If enabled: connect, schedule, heartbeat (60 s). `env.ts` default `false` (seen earlier this session). Test "JOBS_ENABLED=false … starts/connects nothing"                                                                        | Code + test (recorded)                            | PASS                       |
| A4  | No HTTP listener in the worker           | No HTTP import in `worker.ts`, `workerRuntime.ts` or `workerLifecycle.ts`. Test spies `net.Server#listen` (not called); static import test                                                                                                                                                                                                                    | Code + test (recorded)                            | PASS                       |
| A5  | Shared bootstrap as reported             | `bootstrap.ts`: runtime guard, config load (variable names only), role-tagged logger, DB client, container, connect-or-continue, B2 warning — matches the report                                                                                                                                                                                              | Code                                              | PASS WITH LIMITATION       |
| A6  | Shutdown and signal behaviour            | `workerLifecycle.ts` handles SIGTERM / SIGINT / `unhandledRejection` / `uncaughtException`. Cleanup runs once; a second signal is logged and ignored; forced exit 1 after `WORKER_HARD_EXIT_MS = 60_000`; `exitOnce`. `onClose`: clear heartbeat → `scheduler.stop()` (abort, then await in-flight) → DB disconnect. 5 lifecycle tests + runtime SIGTERM test | Code + test (recorded, mocked process)            | PASS WITH LIMITATION       |
| A7  | Long jobs respect stop requests          | `scheduler.ts` passes one `AbortSignal` to every run and aborts it in `stop()`. Checks before each item: reconciliation (`paymentReconciliation.ts`:159), tracking poll (`shipping.shipments.ts`:1015, signal passed through by `shipmentTrackingPoll.ts`), dispatch (`notifications.dispatcher.ts`:399). Per-job tests exist                                 | Code + test (recorded)                            | PASS WITH LIMITATION (M-2) |
| A8  | Package scripts                          | `dev` = `tsx watch src/server.ts`; `start` = `node dist/server.js`; `dev:worker` = `tsx watch src/worker.ts`; `start:worker` = `node dist/worker.js`                                                                                                                                                                                                          | Code                                              | PASS                       |
| A9  | No unreported implementation changes     | Files modified in the Batch 9 window (20:50 – 20:57) match the completion report §3 list exactly. `package-lock.json` and the Dockerfile are not modified. Cart files at 20:00 – 20:03 belong to the earlier Batch 8 M1 correction                                                                                                                            | Modification times only (no Git, no content diff) | PASS WITH LIMITATION       |

**A5 limitation:**

- `bootstrap.ts` unit coverage is about 32 % and `worker.ts` 0 % (recorded).
- The process-exit paths are untested.
- Observable API logging changes (`process` field, connect-failure wording) were not mentioned in
  the completion report (audit L-7).

**A6 limitation:**

- Only mocked `processLike` / `exit` were exercised; real OS signals were not.
- A signal during the start-up DB connect gets Node's default behaviour (audit L-2).
- The `unhandledRejection` path is not tested (audit L-5).
- The hard-exit timer is `unref()`'d (audit L-3).

## 5. M-2 assessment — stop-request hand-off

**What is proven by tests (recorded PASS):**

- The scheduler aborts the signal on `stop()`, and a job that checks it returns after its current
  item (`scheduler.test.ts`).
- Each of the three long jobs stops between items when **called directly** with an aborted signal
  (reconciliation, tracking poll, dispatcher tests).
- The worker runtime passes the scheduler's signal to an **injected test job**
  (`workerRuntime.test.ts`).

**What is established only by code inspection:**

- The production registry passes the signal to the three real jobs (`registry.ts` lines 40, 45–49,
  58–62).
- `runShipmentTrackingPoll` forwards it to `pollTracking`.

The registry test checks only job names and intervals. A regression in that wiring (for example,
dropping `signal` from a `run` lambda) would not be caught.

**Classification:** wiring correct by code inspection, **PASS WITH LIMITATION**. Test proof of the
hand-off: **NOT VERIFIED**. Severity unchanged (Medium, audit M-2). The consequence of a regression
would be a slower shutdown (the job finishes its whole batch), bounded by the 60 s forced exit.

## 6. Test and quality evidence

| Item                                                         | Evidence                                                                                                                                           | Status                                    |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `npm run format:check`                                       | **Executed in this review** (Node 24.12.0): exit 0                                                                                                 | PASS                                      |
| `npm run lint` (`--max-warnings 0`)                          | **Executed in this review**: exit 0                                                                                                                | PASS                                      |
| `npm run typecheck` (`tsc --noEmit`)                         | **Executed in this review**: exit 0                                                                                                                | PASS                                      |
| `npm run openapi:check`                                      | **Executed in this review**: "openapi.json is up to date"                                                                                          | PASS                                      |
| `npm run build`                                              | Recorded PASS in the completion report (with `dist/worker.js`); not executed (writes `dist/`)                                                      | NOT VERIFIED (this review)                |
| `npx prisma validate`                                        | Recorded PASS; not executed (may read environment files)                                                                                           | NOT VERIFIED (this review)                |
| Full test suite: 104 files / 1,344 tests                     | Recorded PASS. Test-file count re-counted: **104**, matches. Test-case count not reproducible statically (parameterized tests); suite not executed | NOT VERIFIED (this review); recorded PASS |
| Coverage (lines 93.16 % · branches 81.85 %)                  | Recorded only                                                                                                                                      | NOT VERIFIED (this review)                |
| Worker runtime tests (6)                                     | Present (`workerRuntime.test.ts`; 6 cases, names match the report)                                                                                 | Exist; recorded PASS                      |
| Worker lifecycle tests (5)                                   | Present (`workerLifecycle.test.ts`; 5 cases, names match)                                                                                          | Exist; recorded PASS                      |
| Stop-request tests (4)                                       | Present (scheduler, reconciliation, tracking poll, dispatcher)                                                                                     | Exist; recorded PASS                      |
| API scheduler removal test                                   | Present (static source check + B2 warning test)                                                                                                    | Exist; recorded PASS                      |
| Disabled-worker test                                         | Present                                                                                                                                            | Exist; recorded PASS                      |
| Real process run (`npm run dev:worker`, real signals, MySQL) | None recorded                                                                                                                                      | NOT VERIFIED                              |

All recorded test evidence comes from **mocked / offline** runs.

## 7. M-1 assessment — refund interrupted after commit

### 7.1 Verified implementation

The late-capture refund path:

1. `capturePayment` runs inside a transaction (in the worker: `payment-reconciliation`; in the API:
   `payments.service.ts` verify and webhook).
2. It calls `refundsModuleHook`, which creates the refund with status `APPROVED`
   (`payments.refunds.ts`).
3. In the **same transaction**, `prepareGatewayRefund` changes it to **`PROCESSING`**
   (`refunds.core.ts` 315–347), when the method is `ORIGINAL_PAYMENT_METHOD` with a captured
   provider payment id.
4. After commit, `runRefundJob` → `executeGatewayRefund` calls the gateway. It records `COMPLETED` or
   `FAILED` in a second transaction; any other gateway result leaves the refund `PROCESSING`.

So a worker stopping **after commit but before the gateway call** leaves the refund in
**`PROCESSING`**, not `APPROVED`.

What can and cannot recover it:

- **`retry`** (`refunds.service.ts`:480): accepts only `FAILED` ("Only failed refunds can be
  retried."). It cannot re-trigger the call.
- **No job** recovers or re-checks `PROCESSING` refunds.
- **Gateway refund webhook:** handles `PROCESSING` refunds (`payments.service.ts`:214), but it can
  only arrive if the gateway call was made.
- **`complete`** (`refunds.service.ts`:526): accepts `PROCESSING` for gateway refunds ("closed
  manually"). It records a manual completion with a payout reference; it does not call the gateway.

**Manual intervention is therefore required.**

> **Correction (2026-11-20, `PHASE4-REFUND-RISK-DOCUMENTATION-ALIGNMENT-REPORT.md`).** An earlier
> version of this paragraph also told staff to "issue the refund there if it was not issued". No code,
> canonical document or approved procedure supports issuing a refund at the gateway, so that
> instruction has been removed.

- **Check the refund's outcome at the gateway first.** A `PROCESSING` refund is not necessarily
  interrupted: one awaiting a gateway result is also `PROCESSING`.
- **Gateway confirms the refund was completed:** the existing `complete` route may record it.
  - API_DOCUMENTATION §4.11 allows this for "a gateway refund being closed manually after provider
    confirmation".
  - `complete` makes **no** gateway call. It only records an already-completed refund (`COMPLETED`,
    payment / order roll-up, `REFUND_COMPLETED` notification).
- **Gateway confirms no refund was issued:** recovery is **undefined**.
  - No documented or authorized procedure exists.
  - `retry` rejects `PROCESSING`.
  - `complete` must **not** be used, because it would record a refund that never happened.
  - This is an unresolved business decision that needs separate authorization.

**Affected flows.** The same after-commit pattern exists in four flows. This is **pre-existing** and
was **not introduced by Batch 9**. Batch 9 only moved flow 1 from the API process into the dedicated
worker and set the worker's 60 s forced-exit limit.

| #   | Flow                            | Process    | Code path                                                                                                               | State committed before the gateway call |
| --- | ------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 1   | Late capture (reconciliation)   | **Worker** | `payment-reconciliation` → `capturePayment` → `refundsModuleHook` → after commit `runRefundJob`                         | `PROCESSING`                            |
| 2   | Staff refund approval           | API        | `refunds.service.ts` `approve` → after commit `runGateway`                                                              | `PROCESSING` (original payment method)  |
| 3   | Customer self-cancel            | API        | `orders.service.ts` `cancelMine` → `cancelOrderInTx` (`autoApprove: true`) → after commit `finishCancel` / `runGateway` | `PROCESSING` (prepaid, original method) |
| 4   | Late capture (verify / webhook) | API        | `payments.service.ts` `verify` / `handleWebhook` → `capturePayment` → `refundsModuleHook` → after commit `runRefundJob` | `PROCESSING`                            |

- Bank-transfer refunds in flows 2 and 3 stay `APPROVED` with no gateway call, by design.
- The API process hard-exits after 30 s on shutdown; the worker after 60 s. Real interruption timing
  is not verified.

**Premature customer notification.** `notifyOrderEvent` → `NotificationService.enqueue` writes
`QUEUED` notification rows through the caller's transaction. The worker's `notification-dispatch`
then delivers them whatever the gateway outcome. So:

| Flow                      | What is committed before the gateway call                                                                                                                    | Verification                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Staff approval            | `REFUND_INITIATED` (`refunds.service.ts` `approve`)                                                                                                          | **Verified**                                                          |
| Customer self-cancel      | `ORDER_CANCELLED` ("A refund of … has been initiated") and `REFUND_INITIATED`; `orders.cancel.ts` 226–249, `notifyCustomer: true` at `orders.service.ts` 401 | **Verified** (independently confirmed by code inspection, 2026-11-20) |
| Late-capture flows (1, 4) | No `REFUND_INITIATED`                                                                                                                                        | —                                                                     |

In flows 2 and 3, the customer may therefore be told a refund was initiated even though the gateway
call never happened.

### 7.2 Documentation accuracy — discrepancy found

The interrupted state is named **`approved`** instead of **`PROCESSING`** in:

| File                                                                           | Location                                        |
| ------------------------------------------------------------------------------ | ----------------------------------------------- |
| `ecommerce-api/docs/PHASE4-BATCH9-COMPLETION-REPORT.md`                        | §6 item 4 (line 187)                            |
| `ecommerce-api/docs/PHASE4-BATCH9-TECHNICAL-REVIEW-AND-IMPLEMENTATION-PLAN.md` | §4 item 9 (line 120)                            |
| `ecommerce-api/docs/PHASE3-PHASE4-MASTER-PROGRESS-REPORT.md`                   | §16 known limitation (line 383)                 |
| `ecommerce-api/docs/PHASE4-BATCH9-DOCUMENTATION-CORRECTION-REPORT.md`          | §2 (line 28), §4 (line 73)                      |
| `ecommerce-api/docs/PHASE4-DOC06-CORRECTION-REPORT.md`                         | §6 (line 122)                                   |
| `ecommerce-api/docs/PHASE4-BATCH9-INDEPENDENT-AUDIT-REPORT.md`                 | M-1 (§5 and line 205)                           |
| `ecommerce-api/docs/PHASE4-MASTER-COMPLETION-ROADMAP.md`                       | DOC-01 row (line 106), M-1 row (line 397)       |
| `project-documentation/04-backend/BACKEND_STRUCTURE.md`                        | §22 note (line 839, "a refund left `approved`") |

The original M-1 finding in the independent audit had this error, and all later corrections inherited
it. This review corrects the record; the files themselves were **not edited** (read-only).

This is **material for operations**. A manual recovery procedure that searches for `APPROVED` refunds
would miss the affected rows, which are `PROCESSING` with a `processingAt` time and no gateway
transaction. The conclusion (no automatic retry; manual intervention) is unaffected.

**Recommended documentation correction (not performed):**

> A refund may remain `PROCESSING` (created `APPROVED` and moved to `PROCESSING` in the commit) if the
> process stops after commit but before the gateway call. `retry` accepts only `FAILED`; no job
> re-checks `PROCESSING` refunds. Manual intervention: verify at the gateway, then close via
> `complete`.

_(Clarification 2026-11-20, final refund documentation consistency.)_ The recommended wording above
is incomplete:

- `complete` only **records** a refund and makes no gateway call.
- It may be used only if the provider confirms the refund was completed.
- If the gateway confirms no refund was issued, recovery is undefined (separate business decision)
  and `complete` must not be used.

See §7.1.

### 7.3 Classification

| Aspect                     | Result                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| M-1 limitation in the code | **PASS WITH LIMITATION** (pre-existing, not fixed, not in Batch 9 scope)                   |
| M-1 documentation          | **FAIL** (documentation only): wrong refund state named in eight files. Conclusion correct |

## 8. Operational and multi-process limitations

| Item                                                   | Evidence                                                                                                    | Classification                     |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Exactly one worker required                            | D-61; start-up log; all current docs                                                                        | PASS WITH LIMITATION               |
| Two workers would run every job twice                  | No lock in `scheduler.ts`; overlap protection is per process only                                           | Known limitation                   |
| Single-worker enforcement                              | Deployment discipline only; nothing in code prevents a second worker                                        | Known limitation                   |
| Forced shutdown can leave notifications in `SENDING`   | Dispatcher claims `QUEUED → SENDING` (line 284); no code reclaims stale `SENDING` rows (WP-O3 not approved) | Known limitation (manual recovery) |
| Forced exit can interrupt work after a database commit | Refunds (§7) and notification sends; the open transaction rolls back                                        | Known limitation                   |
| Real OS signal behaviour                               | Only mocked process objects tested                                                                          | NOT VERIFIED                       |
| Real MySQL behaviour (jobs, pools, two processes)      | No MySQL evidence (G7 / G8 not authorized; Batch 12)                                                        | NOT VERIFIED                       |
| Two-process concurrency, multi-server safety           | Not established; **the system is not multi-server safe**                                                    | NOT VERIFIED / DEFERRED            |
| Redis / BullMQ, distributed scheduling                 | Not implemented, not authorized (D-61, OQ-35)                                                               | DEFERRED                           |
| Worker health check / container                        | Not implemented (WP-O4 not approved; OQ-34)                                                                 | DEFERRED                           |
| Production readiness                                   | Not established                                                                                             | NOT VERIFIED                       |

## 9. Documentation consistency

| Topic                                                            | Where checked                                                                                                                                                                       | Result                                   |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| D-61 dedicated worker architecture                               | BACKEND_STRUCTURE §3.1 / §13 / §14 / §22, SYSTEM_ARCHITECTURE §5.1, DEPLOYMENT_ARCHITECTURE §12, setup guide §6.2 / §13, REPOSITORY_ARCHITECTURE, master report §1 / §15 / §16      | PASS                                     |
| API vs worker responsibilities                                   | Same; sweep found no remaining "scheduler inside the API" current-state claim                                                                                                       | PASS                                     |
| Fake email adapter, process-local outbox                         | Setup guide §13.2 and §15; completion report §6 item 7; DOC-01 report — matches code                                                                                                | PASS                                     |
| Auth / staff-invite emails (API) vs notification emails (worker) | Same; matches `sendEmailSafe` / `staff.service.ts` / registry                                                                                                                       | PASS                                     |
| Single-worker requirement                                        | Stated in all current-state notes                                                                                                                                                   | PASS                                     |
| Deferred Redis / BullMQ / multi-server                           | Labelled deferred everywhere a current-state note exists                                                                                                                            | PASS                                     |
| M-1 refund state                                                 | See §7.2                                                                                                                                                                            | **FAIL** (documentation only)            |
| Code comment, `src/jobs/scheduler.ts` lines 6–8                  | Still says "enabling it on more than one **API** process" and that it "must be replaced by BullMQ" before multi-instance use. Pre-D-61 wording; D-61 defers the multi-server choice | PASS WITH LIMITATION (low, comment only) |
| Scheduler start log (`scheduler.ts` line 91)                     | "single instance only — D-38" (audit L-4)                                                                                                                                           | PASS WITH LIMITATION (low)               |
| Optional or unauthorized items                                   | `REPOSITORY_ARCHITECTURE` §4.1 `jobs/` "queue processors" / `lib/` Redis; DOC-06 optional findings; DOC-07 – DOC-12                                                                 | Open (recorded earlier)                  |

## 10. Classified findings

| ID   | Finding                                                                                    | Classification                                 |
| ---- | ------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| R-01 | API never starts the scheduler (A1)                                                        | PASS                                           |
| R-02 | Worker entrypoint runs the 10 registry jobs (A2)                                           | PASS                                           |
| R-03 | `JOBS_ENABLED` gate (A3)                                                                   | PASS                                           |
| R-04 | No HTTP listener in the worker (A4)                                                        | PASS                                           |
| R-05 | Package scripts (A8)                                                                       | PASS                                           |
| R-06 | format / lint / typecheck / OpenAPI drift (executed now)                                   | PASS                                           |
| R-07 | Shared bootstrap (A5): low coverage of exit paths                                          | PASS WITH LIMITATION                           |
| R-08 | Worker shutdown (A6): mocked signals only                                                  | PASS WITH LIMITATION                           |
| R-09 | Cooperative stop (A7)                                                                      | PASS WITH LIMITATION                           |
| R-10 | M-2: registry → job signal hand-off proven only by code                                    | PASS WITH LIMITATION (test proof NOT VERIFIED) |
| R-11 | No unreported changes (A9), by modification time only                                      | PASS WITH LIMITATION                           |
| R-12 | Single worker by discipline; duplicate jobs if two run                                     | PASS WITH LIMITATION                           |
| R-13 | `SENDING` rows after forced kill need manual recovery                                      | PASS WITH LIMITATION                           |
| R-14 | M-1 limitation in code (pre-existing; manual intervention)                                 | PASS WITH LIMITATION                           |
| R-15 | **M-1 documentation names the wrong state (`approved` instead of `PROCESSING`)**           | **FAIL (documentation only)**                  |
| R-16 | Stale scheduler code comment / start log wording                                           | PASS WITH LIMITATION (low)                     |
| R-17 | Build, Prisma validate, full test suite, coverage (recorded, not re-run)                   | NOT VERIFIED (this review)                     |
| R-18 | Real OS signals, real MySQL, two-process behaviour                                         | NOT VERIFIED                                   |
| R-19 | Multi-server safety, production readiness                                                  | NOT VERIFIED                                   |
| R-20 | Redis / BullMQ, distributed scheduling, worker lock                                        | DEFERRED                                       |
| R-21 | Stuck-`SENDING` recovery (WP-O3), container / health check (WP-O4), `.env.example` (WP-O5) | DEFERRED                                       |

## 11. Final acceptance recommendation

**Recommendation: 2 — ACCEPTABLE ONLY AFTER USER ACKNOWLEDGES SPECIFIC RISKS.**

**Why not option 1.** One FAIL exists (R-15). The M-1 limitation is described with the wrong refund
state in eight documents, and that matters for whoever performs the manual recovery. The user should
knowingly accept it, or order a documentation correction first.

**Why not option 3.** The Batch 9 **implementation** matches its authorized scope:

- every claim in §4 is supported by source code;
- the changed-file set matches the report;
- the four read-only gates pass now;
- excluded packages were not implemented.

The FAIL concerns the documentation of a **pre-existing** limitation, not Batch 9 code. The test and
build evidence is recorded, not re-executed, and is consistent with the files present.

**Risks requiring explicit acknowledgement:**

1. **M-1 (pre-existing; not introduced by Batch 9)** _(risk statement updated 2026-11-20, refund-risk
   alignment)_:
   - **Scope.** A refund interrupted between commit and the gateway call stays **`PROCESSING`** with no
     automatic recovery. This affects four flows (§7.1):
     - the **worker** late-capture flow (reconciliation);
     - three **API** flows: staff refund approval, customer self-cancel, and late capture via
       verify / webhook.
   - **Manual handling.** Check the gateway outcome first.
     - Use `complete` **only** if the gateway confirms the refund was completed.
     - If the gateway confirms no refund was issued, recovery is **undefined**: an unresolved business
       decision. `complete` must not be used.
   - **Premature notification.** In staff approval and customer self-cancel (both verified), the
     customer can be told the refund was initiated although the gateway call never happened.
   - **Documentation.** The refund-state documentation was corrected to `PROCESSING` on 2026-11-20.
2. **Single worker by discipline only:** a second worker duplicates every job run.
3. **Notifications left in `SENDING`** after a forced kill need manual recovery.
4. **M-2:** the registry → job stop-signal wiring has no test. A regression would only lengthen
   shutdown, up to the 60 s forced exit.
5. **Mocked validation only:** real OS signals, real MySQL, connection pools and two-process behaviour
   are unverified (Batch 12, after G7 / G8).
6. **Test suite, build and Prisma validation** were not re-executed in this review; acceptance relies
   on the recorded results for those.
7. **Not production-ready and not multi-server safe.** Redis, BullMQ and distributed scheduling remain
   deferred.

## 12. Evidence still missing

- An execution of the full test suite, build and `prisma validate` in this review (blocked by the
  read-only constraints); the recorded results are from earlier today.
- A test proving the registry passes the stop signal to the three real jobs (M-2).
- Tests of the worker process entry / exit paths and of `unhandledRejection`.
- A real-process run of `npm run dev:worker` / `start:worker` with real SIGTERM / SIGINT.
- Any MySQL-backed run of the worker, the API and the worker together, or the jobs (G7 / G8, Batch 12).
- A content-level change audit (Git diff); only modification times were available.
- A documented manual-recovery procedure for `PROCESSING` refunds and `SENDING` notifications.

## 13. Statement

No implementation, fix, test change, documentation edit or configuration change was authorized or
performed. The only file created is this report; no existing file was modified.

- No database, Redis, gateway, courier, SMTP or other external service was accessed.
- No Git command was run, and `.git` was not inspected.
- No `.env`, `.env.*` or secret was opened.
- M-1 and M-2 were not fixed.
- No batch was started.

**Statuses (unchanged):**

- Batch 9: **COMPLETE — PENDING USER ACCEPTANCE**
- Phase 4: **IN PROGRESS — NOT APPROVED**
- G4: **NOT MET**
- Production readiness: **NOT ESTABLISHED**
