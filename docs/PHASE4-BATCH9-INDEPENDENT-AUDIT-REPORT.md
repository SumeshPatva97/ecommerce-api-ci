# Phase 4 — Batch 9 Independent Post-Implementation Audit

| Field          | Value                                                                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document ID    | P4-BATCH9-AUDIT-01                                                                                                                                                |
| Date           | 2026-11-20                                                                                                                                                        |
| Authorization  | Owner, 2026-11-20: independent **read-only** audit of Batch 9                                                                                                     |
| Batch 9 status | **COMPLETE — PENDING USER ACCEPTANCE** (unchanged by this audit)                                                                                                  |
| Method         | Source inspection, recorded gate log (run started 20:59:43: 104 files / 1,344 tests PASS), metadata checks. No tests re-run; no files changed except this report. |

## 1. Executive verdict

**ACCEPT AFTER DOCUMENTATION CORRECTIONS.**

- **What is correct.** Batch 9 delivers the D-61 architecture at code and control-flow level:
  - the API never starts jobs;
  - the worker registers exactly the 10 existing jobs once, opens no HTTP listener, shuts down in the
    correct order with a 60 s forced exit, and ignores a second signal;
  - long jobs stop only between items;
  - no lock, queue, dependency, Dockerfile, schema or environment change was made.
- **No critical or high findings.**
- **Mandatory correction (documentation).** The Batch 9 report (§6 item 4) and the Batch 9 plan (§4,
  item 9) wrongly state that a refund interrupted after commit "stays retryable via the admin retry
  route". The retry route only accepts `FAILED` refunds (finding M-1).
- **Recommended corrections.** The canonical design documents (setup guide, BACKEND_STRUCTURE) still
  describe the BullMQ / Redis-lock target without pointing to D-61, which is misleading about the
  current architecture.
- **Not established.** Real OS signal behaviour, MySQL behaviour and multi-process safety are **not**
  verified (offline / mocked only).

## 2. Files and areas inspected

**Source:**

- `src/bootstrap.ts`, `src/server.ts`, `src/worker.ts`, `src/workerRuntime.ts`
- `src/core/lifecycle/workerLifecycle.ts`, `src/core/lifecycle/httpServer.ts` (for comparison)
- `src/jobs/scheduler.ts`, `src/jobs/registry.ts`
- `src/jobs/paymentReconciliation.ts`, `src/jobs/shipmentTrackingPoll.ts`, `src/jobs/notificationDispatcher.ts`
- `src/modules/shipping/shipping.shipments.ts` (`pollTracking`)
- `src/modules/notifications/notifications.dispatcher.ts` (`dispatchPending`, `processRow`)
- `src/modules/payments/payments.refunds.ts`, `src/modules/refunds/refunds.core.ts`
  (`executeGatewayRefund`), `src/modules/refunds/refunds.service.ts` (`retry`)
- `package.json`

**Tests:**

- `tests/unit/core/workerLifecycle.test.ts`
- `tests/unit/workerRuntime.test.ts`
- the cooperative-stop tests in `tests/unit/jobs/{scheduler,paymentReconciliation,shipmentTrackingPoll}.test.ts`
  and `tests/unit/modules/notifications/dispatcherJob.test.ts`

**Documentation:**

- the Batch 9 completion report and Batch 9 plan
- `docs/PHASE4-JOBS-AND-SCHEDULING.md`, `src/jobs/README.md`, `README.md`
- `docs/PHASE4-REMAINING-DECISIONS.md` (RD-12)
- `project-documentation/01-requirements/PROJECT_CONTEXT.md` (D-61)
- `project-documentation/04-backend/BACKEND_STRUCTURE.md` (§3 tree, §3.1, §14)
- `project-documentation/09-deployment/REPOSITORY_SETUP_GUIDE.md` (§6.2, troubleshooting, Day-1
  checklist)

## 3. API / worker separation

| Check                                         | Result                           | Evidence                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API never starts jobs                         | ✅                               | `server.ts` has no scheduler or registry import. `warnIfJobsEnabledForApi` logs a warning and does nothing else.                                                                                                                                                                                                                    |
| Worker starts exactly the 10 jobs             | ✅                               | `runWorker` → `createJobScheduler(buildScheduledJobs(container))`, once; the registry lists 10 jobs                                                                                                                                                                                                                                 |
| No job registered twice                       | ✅                               | One scheduler per `runWorker`; the scheduler throws on duplicate names; the test asserts 10 unique names                                                                                                                                                                                                                            |
| Disabled worker exits cleanly                 | ✅                               | `runWorker` returns `started: false` before connecting or creating anything; `worker.ts` flushes the log and calls `process.exit(0)`. The Prisma client is constructed but never connected.                                                                                                                                         |
| No HTTP listener in the worker                | ✅                               | No import of `app.ts` / express / `startHttpServer`; the test spies `net.Server.prototype.listen`                                                                                                                                                                                                                                   |
| Shared bootstrap without API behaviour change | ✅ with minor observable changes | Same guard, config, connect-or-continue, readiness, shutdown. **Observable differences:** API log lines now carry `process: "api"`; the DB connect-failure message text changed; the API shutdown hook no longer stops a scheduler. None is asserted by any test or tool (checked). Not mentioned in the Batch 9 report (Low, L-7). |

## 4. Lifecycle and shutdown

| Check                                | Result             | Notes                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SIGTERM / SIGINT                     | ✅                 | `registerWorkerShutdown`: one `onClose`, then exit 0                                                                                                                                                                                                                                                                                     |
| Second signal                        | ✅                 | `shuttingDown` guard: logged and ignored; `exitOnce` prevents a double exit                                                                                                                                                                                                                                                              |
| Scheduler stops accepting runs       | ✅                 | `stop()` sets `stopping` (so `execute` refuses new runs) and clears all timers                                                                                                                                                                                                                                                           |
| Running jobs awaited                 | ✅                 | `Promise.allSettled(inFlight)`. No new run can be added after `stopping` is set.                                                                                                                                                                                                                                                         |
| DB disconnect after jobs             | ✅                 | `onClose`: `clearInterval(heartbeat)` → `await scheduler.stop()` → `await database.disconnect()`                                                                                                                                                                                                                                         |
| Forced exit after 60 s               | ✅                 | `WORKER_HARD_EXIT_MS = 60_000`; timer cleared on normal completion                                                                                                                                                                                                                                                                       |
| Timer / listener leaks               | ✅ (minor notes)   | Heartbeat cleared in `onClose`; scheduler timers cleared. Four process listeners per `runWorker` (called once per process). The hard-exit timer is `unref()`'d: if cleanup were stuck on a promise with no live handle, Node would exit on its own (code 0, no "complete" log). The same design is used by the API helper (Low, L-3).    |
| Error paths                          | ✅                 | A cleanup rejection exits 1 (the hard-exit timer is cleared). A fatal error (`uncaughtException` / `unhandledRejection`) runs the same cleanup once, then exits 1.                                                                                                                                                                       |
| Shutdown invoked multiple times      | ✅                 | Guarded (`shuttingDown`, `exitOnce`)                                                                                                                                                                                                                                                                                                     |
| Race: job starting vs signal         | ✅                 | Once `stopping` is set, `execute` returns without starting. JavaScript is single-threaded, so there is no interleaving inside `stop()`.                                                                                                                                                                                                  |
| Race: signal during start-up         | Low                | Handlers are registered after `await connectDatabaseOrContinue`. A SIGTERM during the DB connect gets Node's default behaviour (immediate termination). Benign: nothing is running yet (L-2).                                                                                                                                            |
| Synchronous throw in a job's `run()` | Low (pre-existing) | `execute` calls `job.run(signal)` synchronously, outside the promise chain. A synchronous throw (e.g. `runShipmentTrackingPoll` → `buildShippingServices` with a missing courier adapter) would escape as an uncaught exception: the worker shuts down with exit 1 instead of logging a failed run. Unchanged from before Batch 9 (L-1). |

## 5. WP-O2 cooperative cancellation

| Job                    | Check location                                     | Current item finishes?                                                            | No new item after stop? | Consistency                                                                                                                                                    |
| ---------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| payment-reconciliation | Top of the per-payment loop                        | ✅ (capture/fail transaction and its post-commit refund call are inside the item) | ✅                      | Unprocessed payments keep their state and are re-selected next run. The fairness cursor was computed before the loop; it is in-memory and lost at exit anyway. |
| shipment-tracking-poll | Before each shipment (returns the partial summary) | ✅                                                                                | ✅                      | Events are per-event transactions with dedupe; re-polling is safe                                                                                              |
| notification-dispatch  | Before claiming each row                           | ✅                                                                                | ✅                      | Unclaimed rows stay `QUEUED`; the next pass (worker restart) picks them up. Nothing is marked sent unless sent.                                                |

**Wiring.** `registry.ts` passes the scheduler signal to exactly these three jobs. Verified by reading
the code; **not by any test** (M-2).

**Refunds (M-1, pre-existing, documentation error in Batch 9).**

> **Correction (2026-11-20, `PHASE4-M1-REFUND-PROCESSING-STATE-DOCUMENTATION-CORRECTION-REPORT.md`).**
> This audit originally said the interrupted refund stays `APPROVED`. In the code, `prepareGatewayRefund`
> moves it to `PROCESSING` in the same capture transaction, so the interrupted state is `PROCESSING`.
> The conclusion (not retryable; manual intervention) is unchanged. The bullets below are corrected
> in place.

- A late-capture auto-refund is created `APPROVED` and moved to `PROCESSING` in the capture
  transaction. The gateway call (`runRefundJob` → `executeGatewayRefund`) runs **after commit**.
- Cooperative stop never splits this (the check happens only between items).
- A **forced exit or crash** between the commit and the gateway call leaves the refund `PROCESSING`.
- `retry` accepts only `FAILED` refunds ("Only failed refunds can be retried"), so **no existing route
  re-executes it**.
- The row is visible, so it is not silently lost, but it requires manual intervention. A
  `PROCESSING` refund may also be legitimately awaiting a gateway result, so the gateway outcome must
  be checked first. _(Clarified 2026-11-20.)_
  - The existing `complete` route (accepts `PROCESSING`; records the refund, makes no gateway call)
    may be used **only** if the provider confirms the refund was completed.
  - If the gateway confirms no refund was issued, recovery is **undefined** (separate business
    decision), and `complete` must not be used.
- The Batch 9 report §6 item 4 and plan §4 item 9 say it "stays retryable via the admin retry route":
  **inaccurate**.

**Notifications.** A row in `SENDING` at a forced exit stays there (known B5; manual recovery).

**Not establishable offline:**

- timing of real gateway, courier or provider calls against the 60 s limit;
- MySQL rollback of an interrupted transaction;
- real signal delivery under a container runtime.

## 6. Multiple-worker limitation

- **No lock introduced:** no MySQL `GET_LOCK`, Redis, BullMQ or other lock or queue code. A search of
  `src` found only false positives such as "preDispatch".
- **Documented:** the single-worker rule ("exactly one worker; stop the old worker before starting a
  replacement") is in the worker start-up log, `PHASE4-JOBS-AND-SCHEDULING.md` §5, `src/jobs/README.md`
  and RD-12.
- **Not protected:** two simultaneous workers would run every job twice. This is a **known limitation**,
  pending future authorization and Batch 12 verification.

## 7. Test quality and coverage

**What the 15 new tests actually assert:**

- **Lifecycle (5).** Real behaviour of `registerWorkerShutdown` with an injected `EventEmitter` and
  `exit`:
  - exit waits for cleanup;
  - a double signal triggers one cleanup;
  - the hang boundary is exact (59,999 ms no exit; 60,000 ms exit 1);
  - cleanup rejection and `uncaughtException` exit 1.
  - `unhandledRejection` is **not** tested (Low).
- **Runtime (4).** Use the **real** registry and container:
  - 10 unique job names;
  - real log lines captured through a pino destination (start-up line, heartbeat after 60 s);
  - a real `net.Server#listen` spy;
  - ordering, using a real job whose promise is held open: disconnect and exit happen only after
    release, the job observed `signal.aborted`, and exit is called once;
  - an unreachable database at start.
- **API (2).** The warning helper's behaviour, plus a **static source check** that `server.ts` has no
  scheduler references. `server.ts`'s `main()` is not executed in tests (same as before Batch 9).
- **Cooperative stop (4).** Real job code with an `AbortController` aborted during the first item:
  item counts, the claim not made for the next notification, the scheduler-level current item
  completing.

**Verdict.** These tests check behaviour, not merely an expected call sequence.

**Gaps:**

- registry → job signal wiring (M-2);
- `unhandledRejection` path;
- `worker.ts` / `bootstrap.ts` exit paths;
- real processes and signals.

**Coverage.** `worker.ts` 0 % and `bootstrap.ts` ≈ 32 % are thin process entry points with
`process.exit` paths. All decision logic lives in `workerRuntime.ts` (100 % lines) and
`workerLifecycle.ts`, both tested. The repository floors are still met (lines 93.16 %, branches
81.85 %). **Acceptable; not blocking.**

## 8. Documentation inconsistencies

| #   | File / section                                                                                                                                                                                                                                                              | Statement                                                                                                     | Assessment                                                                                                                                                          | Correction                                                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1 | `ecommerce-api/docs/PHASE4-BATCH9-COMPLETION-REPORT.md` §6 item 4; `PHASE4-BATCH9-TECHNICAL-REVIEW-AND-IMPLEMENTATION-PLAN.md` §4 item 9                                                                                                                                    | "stays retryable via the admin retry route"                                                                   | **Inaccurate** (M-1)                                                                                                                                                | **Mandatory:** state that an interrupted post-commit refund stays `PROCESSING` (_corrected 2026-11-20 from `APPROVED`_) and needs manual intervention (the retry route accepts `FAILED` only) |
| D-2 | `project-documentation/09-deployment/REPOSITORY_SETUP_GUIDE.md` §6.2 scripts table (line 314)                                                                                                                                                                               | `dev:worker` purpose "BullMQ worker process (notifications, exports, reservation expiry)"                     | Table is labelled "illustrative" (target design), but **misleading** for the current worker (no BullMQ; jobs run in an in-process scheduler; exports not scheduled) | Recommended: purpose → "Dedicated background-job worker (D-61; in-process scheduler, no BullMQ)"                                                                                              |
| D-3 | Same guide, troubleshooting row (line 830) and Day-1 checklist (line 858)                                                                                                                                                                                                   | "Emails not appearing → Worker not running → npm run dev:worker; check Mailpit :8025"; `npm run db:up`        | Target / local-infrastructure design; Mailpit is not configured (fake email adapter). Partly misleading.                                                            | Recommended: note that emails go to the fake adapter in the worker process, and that the worker must run with `JOBS_ENABLED=true`                                                             |
| D-4 | `project-documentation/04-backend/BACKEND_STRUCTURE.md` §3 tree (`worker.ts # BullMQ worker process entry`, `scheduler.ts`), §3.1 "Process types" (worker horizontal, separate BullMQ `scheduler` "with a Redis lock"), §14 intro ("Each scheduled job takes a Redis lock") | —                                                                                                             | Target design ([PROPOSED]); **conflicts with D-61** (one worker, no multi-server, no Redis) and is not annotated                                                    | Recommended: a short note in §3.1 and §14 pointing to D-61 (current: single dedicated worker running the in-process scheduler; BullMQ / Redis lock deferred)                                  |
| D-5 | `ecommerce-api/README.md` "Project structure" tree                                                                                                                                                                                                                          | Lists `app.ts`, `server.ts` only                                                                              | Incomplete: omits `worker.ts`, `workerRuntime.ts`, `bootstrap.ts`, `jobs/`. Not misleading.                                                                         | Optional                                                                                                                                                                                      |
| D-6 | `ecommerce-api/.env.example` background-jobs comment                                                                                                                                                                                                                        | "In-process scheduler (…)" (known from the earlier audit; not re-read here, as `.env.*` access is prohibited) | Outdated                                                                                                                                                            | Blocked by B6 (pending revert decision)                                                                                                                                                       |

**Accurate:**

- `src/jobs/README.md` and `ecommerce-api/README.md` scripts table / getting started;
- `PHASE4-JOBS-AND-SCHEDULING.md` (status, §1, §5);
- RD-12 status note and the D-61 status note.

## 9. Scope compliance

| Item                        | Result                                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| New dependencies            | None. `package.json` gained only the two scripts (14 dependencies / 18 devDependencies, unchanged). `package-lock.json` last written 2026-11-19. |
| Dockerfile                  | Unchanged (last written 2026-11-17)                                                                                                              |
| `.env` / `.env.*`           | Not accessed by Batch 9 or this audit. Last-write metadata recorded during Batch 9 was unchanged (19:05:02 / 17:37:18 / 2026-11-18).             |
| Schema / migrations / seeds | No changes (no file under `prisma/` modified)                                                                                                    |
| MySQL / external services   | None                                                                                                                                             |
| Batch 10                    | Not implemented                                                                                                                                  |
| WP-O1 / O3 / O4 / O5        | Not implemented (no lock, no `SENDING` recovery, no container / health-check, no `.env.example` change)                                          |
| Git                         | No command run; `.git` not investigated                                                                                                          |

## 10. Findings by severity

| Severity   | ID      | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Critical   | —       | None                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| High       | —       | None                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Medium** | **M-1** | Interrupted post-commit refund stays `PROCESSING` (_corrected 2026-11-20 from `APPROVED`_) and is not retryable (retry accepts `FAILED` only); manual intervention after checking the gateway: `complete` only if the provider confirms completion, recovery undefined if no refund was issued (_clarified 2026-11-20_) (pre-existing; more exposed by the 60 s forced exit). The Batch 9 documentation wrongly calls it retryable (D-1). |
| Medium     | M-2     | Registry → job stop-signal wiring is not covered by any test (verified only by reading the code); a regression would go unnoticed                                                                                                                                                                                                                                                                                                         |
| Low        | L-1     | Synchronous throw in `job.run()` escapes as an uncaught exception, so the worker exits 1 (pre-existing)                                                                                                                                                                                                                                                                                                                                   |
| Low        | L-2     | Signal during start-up DB connect gets Node's default termination (benign)                                                                                                                                                                                                                                                                                                                                                                |
| Low        | L-3     | `unref()`'d hard-exit timer with an empty event loop: silent natural exit (same design as the API)                                                                                                                                                                                                                                                                                                                                        |
| Low        | L-4     | Scheduler start log still says "in-process job scheduler started (single instance only — D-38)"                                                                                                                                                                                                                                                                                                                                           |
| Low        | L-5     | `unhandledRejection` path and process-entry exit paths not tested                                                                                                                                                                                                                                                                                                                                                                         |
| Low        | L-6     | Documentation D-2 to D-5 (target-design wording, README tree)                                                                                                                                                                                                                                                                                                                                                                             |
| Low        | L-7     | Minor observable API logging changes (`process` field, connect-failure message) not mentioned in the Batch 9 report                                                                                                                                                                                                                                                                                                                       |
| —          | Known   | Two workers would double-run jobs (no lock; B3); `SENDING` rows after a forced exit (B5)                                                                                                                                                                                                                                                                                                                                                  |

## 11. Recommended corrections (not implemented)

1. **Mandatory before acceptance (documentation only):** correct D-1 in the Batch 9 completion report
   and the Batch 9 plan.
2. **Recommended (documentation; canonical files need approval):** D-2 to D-4 annotations pointing to
   D-61; optionally D-5.
3. **Tracked follow-ups (code, separate authorization; not blocking):**
   - M-1: a way to re-execute `PROCESSING` refunds whose gateway call never ran (_state corrected
     2026-11-20 from `APPROVED`_), e.g. a guarded retry path or a sweep that first checks the gateway.
     This is a business and security decision.
   - M-2: a registry wiring test (fits the Batch 10 registry test item).
   - L-1: wrap `job.run()` so synchronous throws are logged as failed runs.
   - L-4: log wording.

## 12. Recommendation

**ACCEPT AFTER DOCUMENTATION CORRECTIONS:** at minimum D-1. D-2 to D-4 are strongly recommended.
Acceptance would be for **offline / mocked scope only**.

## 13. MySQL and Batch 12 limitations

Not verified, pending G7/G8 authorization and Batch 12:

- worker and API running together on MySQL (connection pools);
- every job's database behaviour (row locks, compare-and-set, cascades, including the open Batch 7 /
  8 / M1 items);
- SIGTERM during a real transaction (rollback);
- post-commit gaps (M-1, `SENDING` rows) under real timing;
- real OS signal delivery and container behaviour (OQ-34);
- the effects of an accidental second worker and whether a database-level guard is needed.

**This audit changed no application code, tests, configuration or documentation other than creating
this report. Batch 9 is NOT marked accepted.**
