# Phase 4 — Batch 9 Completion Report: Dedicated Background Worker (D-61)

| Field            | Value                                                                             |
| ---------------- | --------------------------------------------------------------------------------- |
| Document ID      | P4-BATCH9-01                                                                      |
| Date             | 2026-11-20                                                                        |
| Authorization    | Owner, 2026-11-20: Batch 9 = WP1–WP7 + WP-O2; decisions B1–B7                     |
| Status           | **COMPLETE — PENDING USER ACCEPTANCE**                                            |
| Validation level | **Offline / mocked only**: no MySQL, no external service, no real process signals |

## 1. Work packages

| WP                             | Result                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WP1 Shared bootstrap           | **Done.** `src/bootstrap.ts`: runtime guard, config load, role-tagged logger (`process: 'api' \| 'worker'`), database client, container; shared DB connect-or-continue; B2 warning helper.                                                                                                                                             |
| WP2 Worker graceful shutdown   | **Done.** `src/core/lifecycle/workerLifecycle.ts`, `registerWorkerShutdown`: SIGTERM/SIGINT (or a fatal error) run cleanup **once** (stop scheduler → wait for running jobs → disconnect DB); a second signal is logged and ignored; exit 0 (1 on cleanup error or fatal error); forced exit 1 after **60 s** (`WORKER_HARD_EXIT_MS`). |
| WP3 Worker entrypoint          | **Done.** `src/worker.ts` (thin entry) + `src/workerRuntime.ts` (`runWorker`, testable).                                                                                                                                                                                                                                               |
| WP4 Scheduler removed from API | **Done.** `src/server.ts` no longer imports or starts the scheduler; `JOBS_ENABLED=true` is ignored with a warning (B2). All other API behaviour unchanged.                                                                                                                                                                            |
| WP5 Scripts                    | **Done.** `package.json`: `dev:worker` = `tsx watch src/worker.ts`, `start:worker` = `node dist/worker.js` (names from REPOSITORY_SETUP_GUIDE). No dependency change; `package-lock.json` untouched.                                                                                                                                   |
| WP6 Tests                      | **Done** (§4).                                                                                                                                                                                                                                                                                                                         |
| WP7 Documentation              | **Done** (§3).                                                                                                                                                                                                                                                                                                                         |
| WP-O2 Cooperative stop         | **Done.** The scheduler passes an `AbortSignal` to every run and aborts it in `stop()`. Payment reconciliation, the shipment tracking poll and notification dispatch check it **before** starting each item, so the current item always completes.                                                                                     |

**Not implemented, as instructed:**

- WP-O1 (MySQL / distributed lock);
- WP-O3 (stuck-`SENDING` recovery);
- WP-O4 (container / health-check infrastructure; the Dockerfile is unchanged);
- WP-O5 (`.env.example`);
- Redis, BullMQ or any queue;
- multi-server scheduling.

## 2. Architecture and lifecycle

**API process (`npm run dev` / `npm start`):**

- HTTP only.
- Never creates the job scheduler.
- A `JOBS_ENABLED=true` value logs: "JOBS_ENABLED=true is ignored by the API process: scheduled jobs
  run only in the dedicated worker process (D-61 …)".

**Worker process (`npm run dev:worker` / `npm run start:worker`):**

1. Node.js runtime guard.
2. Configuration (same schema and environment as the API; no new variable).
3. Logger tagged `process: 'worker'`.
4. `JOBS_ENABLED` check (B1):
   - if not `true`: log "JOBS_ENABLED is not true … worker exiting", connect nothing, **exit 0**;
   - if `true`: continue.
5. Connect the database (a failure is logged; job runs fail and are retried on their next interval).
6. Build the 10 registry jobs once in one scheduler.
7. Heartbeat log every 60 s. The heartbeat timer is not `unref()`'d, so it keeps the process alive;
   the scheduler's own timers are.
8. Graceful shutdown (WP2).
9. Start-up log: "background worker started: exactly ONE worker process must run (D-61); stop the old
   worker before starting a replacement".
10. No HTTP listener is ever created.

**Registered jobs** (unchanged logic, intervals and initial delays):

- reservation-expiry
- unpaid-order-cancel
- notification-dispatch
- payment-reconciliation
- shipment-tracking-poll
- promotion-activation
- best-seller-refresh
- rating-aggregate
- abandoned-carts
- token-cleanup

**Single worker (B3).** By deployment discipline only: exactly one worker process; stop the old one
before starting a replacement. No lock. Running two workers would run every job twice (the jobs are
written to be idempotent, unverified on MySQL).

**Cooperative stop.** Only the check before each item was added; job business logic is unchanged.

- Reconciliation: before each payment.
- Tracking poll: before each shipment.
- Dispatch: before claiming each notification; unclaimed rows stay `QUEUED` for the next pass.

## 3. Files changed

**Created:**

- `src/bootstrap.ts`
- `src/worker.ts`
- `src/workerRuntime.ts`
- `src/core/lifecycle/workerLifecycle.ts`
- `tests/unit/core/workerLifecycle.test.ts`
- `tests/unit/workerRuntime.test.ts`
- `docs/PHASE4-BATCH9-COMPLETION-REPORT.md` (this report)

**Modified (source):**

| File                                                                                                              | Change                                                                        |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `src/server.ts`                                                                                                   | Uses `bootstrap.ts`; scheduler removed; B2 warning                            |
| `src/jobs/scheduler.ts`                                                                                           | `run(signal)`; `stop()` aborts the signal once, then waits for in-flight runs |
| `src/jobs/registry.ts`                                                                                            | Passes the signal to the three long jobs (job list unchanged)                 |
| `src/jobs/paymentReconciliation.ts`                                                                               | Optional `signal`; check before each payment                                  |
| `src/jobs/shipmentTrackingPoll.ts`, `src/modules/shipping/shipping.shipments.ts` (`pollTracking`)                 | Optional `signal`; check before each shipment                                 |
| `src/jobs/notificationDispatcher.ts`, `src/modules/notifications/notifications.dispatcher.ts` (`dispatchPending`) | Optional `signal`; check before each row                                      |
| `package.json`                                                                                                    | Two scripts                                                                   |

**Modified (tests):** `tests/unit/jobs/scheduler.test.ts`, `paymentReconciliation.test.ts`,
`shipmentTrackingPoll.test.ts`, `tests/unit/modules/notifications/dispatcherJob.test.ts`
(cooperative-stop tests added).

**Modified (documentation):**

- `docs/PHASE4-JOBS-AND-SCHEDULING.md` (status line, §1 table, scheduler paragraph, §5)
- `src/jobs/README.md`
- `README.md` (scripts table, getting started)
- `docs/PHASE4-REMAINING-DECISIONS.md` (RD-12 status note)
- `project-documentation/01-requirements/PROJECT_CONTEXT.md` (dated status note under D-61; decision
  text unchanged)
- `docs/PHASE3-PHASE4-MASTER-PROGRESS-REPORT.md` (headline row, §16)

**Not changed:**

- `Dockerfile`
- `package-lock.json`
- Prisma schema, migrations, seeds
- `.env`, `.env.example`, `.env.migration.example` (last write times unchanged: 19:05:02, 17:37:18,
  2026-11-18)

## 4. Tests (all offline, mocked)

**New:**

- `workerLifecycle.test.ts` (5):
  - 60 s limit constant;
  - SIGTERM waits for cleanup, then exits 0;
  - a second signal does not repeat cleanup;
  - a hang forces exit 1 at exactly 60 s, once;
  - a cleanup error or `uncaughtException` exits 1.
- `workerRuntime.test.ts` (6):
  - disabled worker logs and starts/connects nothing;
  - enabled worker registers the **10 jobs exactly once**, never calls `net.Server#listen`, logs the
    start-up and heartbeat lines, and shuts down cleanly;
  - SIGTERM waits for a running job (which sees the stop signal), then disconnects, then exits 0 once;
  - an unreachable database at start is logged and the worker keeps running;
  - the API's `JOBS_ENABLED=true` warning;
  - static check: `server.ts` never references the scheduler/registry, and the worker files never
    import the HTTP app or start a server.
- Cooperative stop (4):
  - scheduler stop raises the signal, and the current item completes;
  - reconciliation stops between payments;
  - tracking poll stops between shipments;
  - dispatch stops before claiming the next notification.

**Existing tests unchanged** (job business logic, lifecycle, health, registry list).

**Gate results** (Node.js 24.12.0):

| Gate                      | Result                                                                                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| format:check              | PASS                                                                                                                                                                                          |
| lint (`--max-warnings 0`) | PASS                                                                                                                                                                                          |
| typecheck                 | PASS                                                                                                                                                                                          |
| build                     | PASS (`dist/worker.js`, `dist/workerRuntime.js`, `dist/bootstrap.js` produced)                                                                                                                |
| openapi:check             | PASS (no route change)                                                                                                                                                                        |
| prisma validate           | PASS (no DB connection)                                                                                                                                                                       |
| Full test suite           | **104 files, 1,344 tests PASS** (before Batch 9: 102 / 1,329)                                                                                                                                 |
| Coverage                  | lines 93.16 % · statements 91.42 % · functions 93.87 % · branches 81.85 % (floors met)                                                                                                        |
| Coverage, new files       | `workerRuntime.ts` 100 % lines; `worker.ts` 0 % (thin process entrypoint, like the untested `server.ts`); `bootstrap.ts` ≈ 32 % lines (exit-on-error and real-database paths not unit-tested) |

All tests used mocked / offline dependencies.

## 5. Skipped or blocked work

None of the approved packages was skipped or blocked. The excluded optional packages are listed in
§1.

## 6. Known limitations

1. **Mocked validation only.** Real OS signal delivery, container runtimes, MySQL behaviour and
   two-process connection usage are not verified.
2. **Single worker by discipline only.** A second worker would duplicate every job run.
3. **Notifications stuck in `SENDING`** after a forced kill still need the manual recovery procedure
   (B5). The 60 s limit makes this less likely but does not remove it.
4. **Post-commit side effects can be cut by the forced exit.** For example, a gateway refund after a
   late capture. _(Corrected 2026-11-20, DOC-01; the earlier text said the refund "stays retryable
   via the admin retry route", which is inaccurate.)_
   - The refund is created `APPROVED` and moved to `PROCESSING` in the same transaction; the gateway
     call runs after that transaction commits.
   - If the worker stops or crashes after that commit but before the gateway call, the refund remains
     **`PROCESSING`**. _(Corrected 2026-11-20, M-1 state correction: the DOC-01 text said it "may
     remain `approved`", which named the wrong state.)_
   - The admin retry route accepts only `FAILED` refunds ("Only failed refunds can be retried"), so it
     cannot retry a `PROCESSING` refund. No job recovers this state automatically.
   - Manual intervention is required. Check the refund's outcome at the gateway first. Not every
     `PROCESSING` refund is interrupted: one still awaiting a gateway result is also `PROCESSING`.
   - _(Clarified 2026-11-20, final refund documentation consistency.)_
     - The existing `complete` route (accepts `PROCESSING`) may be used **only** if the provider
       confirms the refund was completed. It records the refund; it does not call the gateway.
     - If the gateway confirms **no refund was issued**, recovery is **undefined**. That needs a
       separate business decision, and `complete` must not be used.
   - This is a **known limitation, not fixed** in Batch 9 (audit finding M-1).
5. **No worker health check or container definition** (deferred to OQ-34).
6. **Low unit coverage of `worker.ts` / `bootstrap.ts`** (process entry and exit paths).
7. **Local development: the fake email adapter's outbox is process-local.** _(Corrected 2026-11-20, N1;
   the earlier text said the outbox "now lives in the worker process", which is only partly true.)_
   - Each process builds its own adapter, with its own in-memory outbox (last 200 messages). The API and
     the worker do not share it.
   - Notification emails are delivered by the worker (`notification-dispatch`), so they appear in the
     worker's outbox.
   - Auth emails and staff-invite emails are sent directly by the API process, so they stay in the
     API's outbox.
   - This is a fake development adapter, not SMTP or Mailpit.
8. **Canonical documents still describe the target design.** `REPOSITORY_SETUP_GUIDE` lists
   `dev:worker` as a "BullMQ worker process", and BACKEND_STRUCTURE §14 mentions Redis locks. Not edited
   in Batch 9. _(Update 2026-11-20: D-61 current-state notes added by DOC-01; see
   `docs/PHASE4-BATCH9-DOCUMENTATION-CORRECTION-REPORT.md`.)_

## 7. Pending Batch 12 verification (after G7/G8)

- Worker and API running together on MySQL: connection pools and limits.
- All job behaviour on MySQL, including the open Batch 7 / 8 / M1 items.
- SIGTERM during an active job: transaction rollback and post-commit gaps.
- Effects of an accidental second worker, and whether a database-level guard is needed (B3).
- Signal handling under the chosen container runtime (OQ-34).

## 8. Status

Batch 9: **COMPLETE — PENDING USER ACCEPTANCE**. Phase 4 **IN PROGRESS — NOT APPROVED** · Batch 8 + M1
**ACCEPTED — OFFLINE MOCKED SCOPE ONLY** · RD-12 / D-61 **ARCHITECTURE APPROVED**, implementation
delivered in Batch 9 pending acceptance · Batch 10 **NOT AUTHORIZED** · MySQL / external verification
**PENDING** (Batch 12) · production readiness **NOT ESTABLISHED**.
