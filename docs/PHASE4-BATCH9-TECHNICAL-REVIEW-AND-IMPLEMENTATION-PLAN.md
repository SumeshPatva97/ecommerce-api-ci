# Phase 4 — Batch 9 Technical Review and Implementation Plan (Dedicated Worker, D-61)

| Field              | Value                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Document ID        | P4-BATCH9-PLAN-01                                                                                                                               |
| Date               | 2026-11-20                                                                                                                                      |
| Authorization      | Owner, 2026-11-20: read-only technical review and plan **only**                                                                                 |
| Status             | **PROPOSAL — NOT APPROVED. No implementation performed.**                                                                                       |
| Governing decision | D-61 (PROJECT_CONTEXT §17.7) / RD-12: single dedicated worker process, separate from the API; multi-server scheduling deferred; no Redis/BullMQ |

## 1. Executive summary

- **Where jobs run today.** All ten scheduled jobs run through an in-process scheduler that `src/server.ts`
  starts **inside the API process** when `JOBS_ENABLED=true` (default `false`). There is no
  `src/worker.ts` and no worker script, and the Dockerfile starts only `dist/server.js`.
- **The jobs are portable.** Every job depends only on stateless container services (database, clock,
  logger, audit, provider adapters). None depends on API request state, the HTTP server, or the
  in-memory stores (rate limiter, sessions, idempotency, permission cache). Moving them into a separate
  process is therefore technically straightforward.
- **Scope.** Batch 9 can implement D-61 with no new dependency, no Redis/BullMQ, and no schema change:
  - a shared bootstrap;
  - a `src/worker.ts` entrypoint with its own graceful shutdown;
  - removal of the scheduler from the API process;
  - the `dev:worker` / `start:worker` scripts the canonical setup guide already names;
  - tests;
  - documentation.
- **Decisions needed before implementation (§14):** the worker's on/off switch, API behaviour when
  `JOBS_ENABLED=true`, single-worker enforcement, health checks / deployment files, recovery of
  notifications stuck in `SENDING`, and `.env.example` documentation (blocked by the pending revert
  decision).
- **No Batch 10 item is a prerequisite.**

## 2. Current implementation findings (verified in code)

| Area                   | Finding                                                                                                                                                                                                                   | Evidence                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Entrypoints            | Only `src/server.ts` (API). **No `src/worker.ts`.**                                                                                                                                                                       | `ls src/*.ts` → `app.ts`, `container.ts`, `server.ts`                             |
| Scheduler start        | `server.ts`: after `startHttpServer`, `config.jobs.enabled ? createJobScheduler(buildScheduledJobs(container), logger) : undefined`; `scheduler?.start()`; shutdown hook `scheduler?.stop()` then `database.disconnect()` | `src/server.ts`                                                                   |
| Scheduler              | Fixed intervals; per-job overlap protection (`inFlight` map); errors logged, never thrown; `stop()` clears timers and awaits in-flight runs; `runNow`; timers `unref()`'d                                                 | `src/jobs/scheduler.ts`                                                           |
| Registry               | 10 jobs; in-memory fairness cursors for reconciliation and tracking poll (reset on restart)                                                                                                                               | `src/jobs/registry.ts`                                                            |
| Config                 | `JOBS_ENABLED` (stringbool, default `false`) → `config.jobs.enabled`                                                                                                                                                      | `src/core/config/env.ts`                                                          |
| Shutdown helper        | `registerGracefulShutdown({ server, readiness, logger, onClose, processLike?, exit?, drainTimeoutMs = 25 s, hardExitMs = 30 s })`; **needs an HTTP server**; `processLike` / `exit` are injectable for tests              | `src/core/lifecycle/httpServer.ts`, `tests/integration/lifecycle.test.ts`         |
| Runtime guard          | `assertSupportedNode()` (Node ≥ 22.13.0) called first in `server.ts`                                                                                                                                                      | `src/core/runtime/nodeVersion.ts`                                                 |
| Scripts                | `dev` = `tsx watch src/server.ts`, `start` = `node dist/server.js`; **no worker scripts**                                                                                                                                 | `package.json`                                                                    |
| Canonical script names | REPOSITORY_SETUP_GUIDE: `dev:worker` = `tsx watch src/worker.ts`, `start:worker` = `node dist/worker.js`                                                                                                                  | REPOSITORY_SETUP_GUIDE §scripts table                                             |
| Docker                 | Single image; `CMD ["node","dist/server.js"]`; `HEALTHCHECK` = HTTP `/health/live` on port 4000 (does not suit a worker)                                                                                                  | `Dockerfile`                                                                      |
| Architecture docs      | SYSTEM_ARCHITECTURE / BACKEND_STRUCTURE: separate **worker service**, same codebase, entrypoint `src/worker.ts`, **BullMQ-based** (target design; BullMQ/Redis deferred by D-38 / D-61)                                   | `SYSTEM_ARCHITECTURE.md` (worker service), `BACKEND_STRUCTURE.md` §3 tree and §14 |
| Not scheduled          | `report-exports` worker (needs a durable queue and private storage); `low-stock-digest` (RD-09 = instant only)                                                                                                            | `src/jobs/reportExport.ts`, RD-09                                                 |

**Job dependencies** (each job receives the whole container but uses only these parts):

| Job                    | Interval / first run | Uses                                                                    | Process-local state?                                                                                                                                 |
| ---------------------- | -------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| reservation-expiry     | 1 min / +1 min       | db, clock, logger; `captureDepsFor` (inventory, coupons, notifications) | No                                                                                                                                                   |
| unpaid-order-cancel    | 5 min / +5 min       | db, clock, logger; `captureDepsFor`                                     | No                                                                                                                                                   |
| notification-dispatch  | 15 s / +15 s         | db, logger; `providers.email` / `.whatsapp`                             | **Fake email adapter keeps an in-memory outbox (last 200)**: in a worker the outbox lives in the worker process. No API route reads it (tests only). |
| payment-reconciliation | 15 min / +15 min     | db, clock, logger; `providers.payment` (mock); refunds hook             | In-memory fairness cursor (registry); mock gateway's test-only `simulate*` state                                                                     |
| shipment-tracking-poll | 30 min / +30 min     | `buildShippingServices` → `providers.shipping` registry                 | In-memory per-courier cursor; the default mock is not polled                                                                                         |
| promotion-activation   | 1 min / +1 min       | db, clock, audit, logger                                                | No                                                                                                                                                   |
| best-seller-refresh    | 24 h / +20 min       | db, clock                                                               | No                                                                                                                                                   |
| rating-aggregate       | 24 h / +30 min       | db (+ `recomputeProductRating`)                                         | No                                                                                                                                                   |
| abandoned-carts        | 60 min / +15 min     | db, clock, logger; settings                                             | No                                                                                                                                                   |
| token-cleanup          | 24 h / +10 min       | db, clock                                                               | No                                                                                                                                                   |

**Relevant tests that exist today:**

- `tests/unit/jobs/*` (scheduler, registry list, all jobs);
- `tests/integration/lifecycle.test.ts` (API shutdown);
- `tests/unit/core/env.test.ts` (`JOBS_ENABLED` default);
- `tests/unit/core/container.test.ts`.

## 3. D-61 compliance assessment

| D-61 requirement                               | Today                         | After Batch 9 (proposed)                                  |
| ---------------------------------------------- | ----------------------------- | --------------------------------------------------------- |
| Single dedicated worker process runs jobs      | ✗ jobs run in the API process | ✓ `src/worker.ts` runs the scheduler; the API never does  |
| API and worker are separate runtime processes  | ✗                             | ✓ separate entrypoints, scripts, logs                     |
| Multi-server / distributed scheduling deferred | ✓ (none)                      | ✓ (none added)                                            |
| No Redis / BullMQ / queue infrastructure       | ✓                             | ✓ (none added)                                            |
| Worker not claimed as implemented before it is | ✓ documented                  | Docs updated only after implementation **and** acceptance |

## 4. Proposed Batch 9 architecture

1. **API process (`src/server.ts`).** HTTP only: routes, auth, webhooks, and **writes** that create work
   (orders, reservations, queued notifications). It never constructs or starts the scheduler.
2. **Worker process (`src/worker.ts`).** No HTTP listener. Runtime guard → config → logger (with a
   `process: 'worker'` field) → database client → container → `createJobScheduler(buildScheduledJobs(container))`
   → `start()`. It writes only through the existing job code.
3. **Shared bootstrap.** The common start-up (runtime guard, config load with clear error, logger,
   database, container) moves from `server.ts` into one helper used by both entrypoints. Behaviour
   stays identical for the API.
4. **Job registration.** `buildScheduledJobs(container)` is unchanged (same 10 jobs, intervals, initial
   delays, cursors).
5. **Single executor (no distributed lock, per D-61).** Enforced by **deployment discipline**: exactly
   one worker process, and the API never runs jobs. Defence in depth: the worker logs a prominent
   "single-worker" line at start with its process id. An optional MySQL advisory-lock guard is a
   decision (§14 B3), not included by default.
6. **Startup.** If the database is unreachable at start, the worker logs it and keeps running. Each job
   run fails and is logged, then retried on its next interval. This matches today's API behaviour
   (`database connection failed during startup … continuing`).
7. **Shutdown.** New HTTP-free helper (e.g. `registerWorkerShutdown`, same injectable `processLike` /
   `exit` pattern):
   - on SIGTERM/SIGINT: stop scheduling, wait for in-flight runs (`scheduler.stop()`), disconnect the
     database, exit 0;
   - a second signal is ignored;
   - hard-exit timer with code 1 (proposed 60 s, a code constant, not an environment variable).
8. **Overlap and duplicates.** Unchanged:
   - the scheduler prevents a job overlapping itself;
   - jobs are idempotent (compare-and-set, dedupe keys, row locks);
   - cross-job interaction on the same order is serialised by order row locks (reasoned, MySQL
     unverified).
9. **Restart and recovery.**
   - Timers and fairness cursors restart from zero; the work itself is selected from the database, so
     nothing is lost.
   - Daily jobs run once 10–30 minutes after each start, so frequent restarts mean extra (idempotent)
     runs, never missed ones.
   - A hard exit mid-run rolls back the open transaction. Post-commit side effects (gateway refund
     call, notification send) can be interrupted:
     - refunds: the refund is created `APPROVED` and moved to `PROCESSING` in the same transaction,
       and the gateway call runs after commit. If the worker stops or crashes after that commit but
       before the gateway call, the refund remains `PROCESSING`. The admin retry route accepts only
       `FAILED` refunds, and no job recovers this state, so manual intervention is required.
       Check the gateway outcome first; use the existing `complete` route (accepts `PROCESSING`;
       records the refund, makes no gateway call) **only** if the provider confirms the refund was
       completed. If the gateway confirms no refund was issued, recovery is **undefined** (separate
       business decision) and `complete` must not be used _(clarified 2026-11-20)_. This is a known
       limitation, not fixed (corrected 2026-11-20, DOC-01: the earlier text wrongly said
       refunds "stay retryable via the existing admin retry route"; state corrected 2026-11-20 from
       `approved` to `PROCESSING`);
     - notifications left in `SENDING` are **not** auto-recovered today (§6 R5, decision B5).
10. **Health and logging.** Structured logs already exist per run (`job run finished` / `job run
failed`). Proposed: a start-up line (jobs, intervals, pid) and a periodic heartbeat log line.
    HTTP health endpoints stay API-only. Container health checks for the worker are a deployment
    decision (§14 B4).
11. **Configuration.** No new environment variable in the mandatory scope. The worker uses the same
    config schema and `.env` as the API: same codebase, the API-specific settings are present but
    unused. `JOBS_ENABLED`'s role must be decided (§14 B1/B2). The worker needs the same `DATABASE_URL`
    and secrets as the API; nothing is printed (config errors already name variables only).
12. **Deployment and local development.**
    - **Local:** two terminals, `npm run dev` + `npm run dev:worker`; with `JOBS_ENABLED=false` (default)
      the worker idles or exits (B1).
    - **Container:** same image with the command overridden to `node dist/worker.js`, or a separate
      service. That is infrastructure, deferred to the hosting decision (OQ-34) unless you approve
      Dockerfile/compose changes (B4).
    - **Rolling deploys** must stop the old worker before starting the new one (no overlap).
    - **Two processes mean two Prisma connection pools:** size the MySQL connection limits accordingly
      (Batch 12).

## 5. Job-by-job migration plan

All ten jobs move unchanged, by switching **where** `buildScheduledJobs` is called. No job code
changes in the mandatory scope.

| Job                    | Migration action              | Worker-specific notes                                                                                                                                                           |
| ---------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| reservation-expiry     | Move                          | Order row locks shared with API checkout and capture (MySQL-only verification)                                                                                                  |
| unpaid-order-cancel    | Move                          | Same as above                                                                                                                                                                   |
| notification-dispatch  | Move                          | Fake email outbox now in the worker process (local dev visibility: worker logs). Stuck-`SENDING` gap (B5).                                                                      |
| payment-reconciliation | Move                          | Long worst case (up to 100 gateway calls × 10 s timeout) exceeds a 60 s hard exit; each payment is its own transaction, so it is safe to cut; optional cooperative stop (WP-O2) |
| shipment-tracking-poll | Move                          | Uses the container's courier registry (single instance per process); default mock not polled                                                                                    |
| promotion-activation   | Move                          | —                                                                                                                                                                               |
| best-seller-refresh    | Move                          | Window setting gap (Batch 10, not a prerequisite)                                                                                                                               |
| rating-aggregate       | Move                          | Lock-then-recompute per product (D5)                                                                                                                                            |
| abandoned-carts        | Move                          | Cart row locks interact with API add/merge claims (M1), MySQL-only                                                                                                              |
| token-cleanup          | Move                          | —                                                                                                                                                                               |
| report-exports         | **Not scheduled** (unchanged) | Needs a queue + private storage: outside D-61 scope                                                                                                                             |

## 6. Risks and dependencies

| #   | Risk / dependency                                                                      | Severity   | Mitigation                                                                                                                         |
| --- | -------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Two workers run simultaneously (manual mistake, rolling deploy): every job runs twice  | Medium     | Jobs are idempotent; deployment rule "stop old worker first"; start-up log; optional advisory-lock guard (B3, MySQL-verified only) |
| R2  | API keeps running jobs if old config / old code is deployed alongside the worker       | Medium     | API never starts the scheduler after Batch 9; warning log if `JOBS_ENABLED=true` in the API (B2)                                   |
| R3  | Hard exit during long runs                                                             | Low–Medium | Per-item transactions; optional cooperative stop between items (WP-O2)                                                             |
| R4  | Fake email outbox no longer in the API process (local dev)                             | Low        | Worker logs the send summary; no route depends on it                                                                               |
| R5  | Notification stuck in `SENDING` after a kill (no automatic recovery)                   | Medium     | Decision B5: stale-`SENDING` re-queue (at-least-once, possible duplicate send) or keep the operator procedure                      |
| R6  | Second Prisma pool doubles connections                                                 | Low        | MySQL connection-limit sizing (Batch 12)                                                                                           |
| R7  | API start-up / shutdown regressions from extracting the bootstrap                      | Low        | Existing lifecycle and health tests must stay green unchanged                                                                      |
| R8  | Worker against MySQL is impossible before G7/G8                                        | —          | Offline validation only; Batch 12                                                                                                  |
| R9  | `.env.example` cannot document the worker / `JOBS_ENABLED` while its revert is pending | Process    | Decision B6                                                                                                                        |

**Dependencies on open decisions:**

- D-61 (decided).
- D-38 / OQ-35 (Redis deferred: honoured).
- OQ-34 hosting (container and worker service definition).
- The pending `.env.example` revert.
- None of RD-01…RD-05 / RD-11 / RD-13 A affects Batch 9.

## 7. Batch 10 dependency assessment

| Batch 10 item                                                 | Prerequisite for Batch 9? | Note                                                                                                                                                                        |
| ------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registry cursor carry-over test                               | No                        | Batch 9 keeps the `buildScheduledJobs` API, so the test applies unchanged afterwards. A worker start-up test may assert the registry is used, but not the cursor behaviour. |
| Per-item error isolation in rating / best-seller jobs         | No                        | Independent of the job's host process                                                                                                                                       |
| Reconciliation-level stock-out / cancelled-order refund tests | No                        | —                                                                                                                                                                           |
| OpenAPI content types for file downloads                      | No                        | Unrelated                                                                                                                                                                   |
| Best-seller window setting                                    | No                        | —                                                                                                                                                                           |
| EXPIRED-promotion-final decision                              | No                        | —                                                                                                                                                                           |
| Batch 8 test gaps                                             | No                        | —                                                                                                                                                                           |

**No Batch 10 item must precede Batch 9.** None is absorbed into Batch 9.

## 8. Proposed work packages

**Mandatory**

| WP                            | Content                                                                                                                                                                                                              | Files likely to change                                                                                                                                           | Depends on   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| WP1 Shared bootstrap          | Extract runtime guard + config + logger + database + container creation from `server.ts` into one helper; API behaviour identical                                                                                    | `src/server.ts`, new `src/bootstrap.ts` (or `src/core/lifecycle/bootstrap.ts`)                                                                                   | —            |
| WP2 Worker lifecycle helper   | HTTP-free graceful shutdown: signals → `scheduler.stop()` → `database.disconnect()` → exit; second signal ignored; hard exit 60 s; injectable `processLike` / `exit`                                                 | new `src/core/lifecycle/workerLifecycle.ts`                                                                                                                      | —            |
| WP3 Worker entrypoint         | `src/worker.ts`: bootstrap → scheduler per B1 → start-up and heartbeat logs → shutdown helper                                                                                                                        | new `src/worker.ts`                                                                                                                                              | WP1, WP2, B1 |
| WP4 Remove scheduler from API | Delete the scheduler block from `server.ts`; behaviour when `JOBS_ENABLED=true` per B2                                                                                                                               | `src/server.ts`                                                                                                                                                  | WP1, B2      |
| WP5 Scripts                   | `dev:worker` = `tsx watch src/worker.ts`, `start:worker` = `node dist/worker.js` (names from REPOSITORY_SETUP_GUIDE); `build` already compiles all of `src`                                                          | `package.json` (scripts only; **no dependency change**)                                                                                                          | WP3          |
| WP6 Tests                     | See §9                                                                                                                                                                                                               | new `tests/unit/core/workerLifecycle.test.ts`, `tests/unit/worker.test.ts` (or integration), possibly `tests/integration/lifecycle.test.ts` (unchanged expected) | WP1–WP4      |
| WP7 Documentation             | Jobs doc (§1, §5, §6), `src/jobs/README.md`, ecommerce-api `README.md` scripts table, master progress report, Batch 9 completion report; PROJECT_CONTEXT D-61 "current state" note updated **only after acceptance** | docs listed                                                                                                                                                      | WP1–WP6      |

**Optional (each needs your decision)**

| WP                             | Content                                                                                                                           | Decision                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| WP-O1 Single-worker guard      | MySQL `GET_LOCK('ecommerce:worker', 0)` on a dedicated connection held for the worker's lifetime; refuse to start if not acquired | B3: needs a design for Prisma pooling; only verifiable on MySQL |
| WP-O2 Cooperative stop         | Long jobs (reconciliation, tracking poll, notification dispatch) check a stop flag between items                                  | Recommended; small, job-local                                   |
| WP-O3 Stale-`SENDING` recovery | Re-queue notifications stuck in `SENDING` longer than N minutes (at-least-once)                                                   | B5: business decision (possible duplicate message)              |
| WP-O4 Container / deployment   | Dockerfile or compose worker service, worker health check (heartbeat file or process liveness)                                    | B4: infrastructure; OQ-34                                       |
| WP-O5 `.env.example`           | Document the worker and `JOBS_ENABLED` per `env.ts` rule §9.4                                                                     | B6: blocked by the pending revert decision                      |

## 9. Test and acceptance criteria

**Required tests (offline, mocked):**

1. **Worker lifecycle helper** (injected `processLike` / `exit`, fake scheduler and database):
   - SIGTERM waits for an in-flight job, then disconnects the database, then exits 0, in that order;
   - a second signal is ignored;
   - a hanging stop triggers the hard exit with code 1;
   - a disconnect error exits 1.
2. **Worker entrypoint** (bootstrap with injected parts):
   - starts the scheduler with exactly the 10 registry jobs when enabled, and does not when disabled
     (per B1);
   - logs start-up and heartbeat lines;
   - never opens an HTTP listener;
   - survives an unreachable database at start (job runs fail and are logged).
3. **API:**
   - `server.ts` no longer creates a scheduler, even with `JOBS_ENABLED=true` (B2 behaviour asserted);
   - existing lifecycle and health tests pass unchanged.
4. **Regression:**
   - the scheduler and job tests pass unchanged;
   - the full suite passes;
   - format, lint, typecheck, build (produces `dist/worker.js`), openapi:check (no route change) and
     prisma validate all pass.

**Acceptance criteria:**

- The worker runs jobs and the API never does.
- Graceful shutdown is tested.
- No new dependency, no Redis / BullMQ / queue.
- No schema, migration, seed or environment-file change (unless B6 is approved).
- Documentation states the worker is implemented and validated **offline only**.
- All gates pass on Node 24.12.0.

## 10. Rollback plan

- **Code.** Changes are additive (new `worker.ts`, new lifecycle helper, new scripts) plus one block
  removed from `server.ts`. Rollback = restore the scheduler block in `server.ts` and stop the worker.
  `buildScheduledJobs` and `createJobScheduler` are unchanged, so either host works.
- **Runtime.** `JOBS_ENABLED` defaults to `false`, so a default deployment runs no jobs in either
  process; rollback carries no data risk.
- **Data.** None: no schema or data migration.

## 11. Offline validation scope

Verifiable offline:

- Process wiring (entrypoint, bootstrap).
- Signal handling and shutdown ordering (injected process / exit).
- Scheduler start and stop, and job registration.
- That the API no longer schedules.
- Build output (`dist/worker.js`).

**Not** verifiable offline:

- Real MySQL behaviour of any job.
- Two-process connection usage.
- Real signal behaviour under a container runtime.
- Advisory-lock semantics.

## 12. Batch 12 verification requirements (pending G7/G8)

1. Worker and API running against MySQL at the same time: connection-pool sizing and limits.
2. All job behaviour on MySQL (order / cart / payment row locks, compare-and-set semantics, cascade
   deletes), including the open Batch 7 / Batch 8 / M1 items.
3. SIGTERM during an active job: transaction rollback and the post-commit side-effect gaps (refund job,
   `SENDING` rows).
4. Accidental duplicate worker: observed effects and, if WP-O1 is approved, the lock guard.
5. Container-runtime signal delivery and worker health checks (if WP-O4 is approved).

## 13. Confirmation: no implementation performed

This review changed **no** application code, tests, schemas, migrations, seeds, configuration,
dependencies or package scripts. No worker or scheduler was started; no database or external service
was contacted; no `.env` / `.env.*` file was read; no Git command was run. Files written in this task:

- this plan (new);
- the master progress report §15, recording the owner's acceptance of the documentation work (a
  separately authorized status update).

## 14. Blockers requiring your decision

| ID     | Question                                      | Options                                                                                                                                                                                    | Recommendation                                                                                 |
| ------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| **B1** | What switches jobs on in the worker?          | (a) Keep `JOBS_ENABLED` (default `false`) as the worker's on-switch; with `false` the worker logs "jobs disabled" and exits 0. (b) The worker always runs jobs; `JOBS_ENABLED` is removed. | **(a)**: no environment-schema change, safe default, matches today's off-by-default policy     |
| **B2** | API behaviour when `JOBS_ENABLED=true`        | (a) Ignore it and log a warning that jobs run only in the worker (D-61). (b) Refuse to start.                                                                                              | **(a)**: avoids breaking existing local configs; the warning makes it visible                  |
| **B3** | Single-worker enforcement                     | (a) Deployment discipline + start-up log only. (b) Add the MySQL advisory-lock guard (WP-O1).                                                                                              | **(a)** now; consider (b) with a design note in Batch 12, since it is verifiable only on MySQL |
| **B4** | Worker health check and container definition  | (a) Logs only in Batch 9; Docker/compose deferred to the hosting decision (OQ-34). (b) Add a Dockerfile/compose worker service now.                                                        | **(a)**: (b) is infrastructure needing separate approval                                       |
| **B5** | Notifications stuck in `SENDING` after a kill | (a) Keep the operator procedure (documented). (b) Add stale-`SENDING` recovery (WP-O3), accepting a possible duplicate message.                                                            | Decide separately; **(a)** for Batch 9, revisit with real vendors (OQ-08)                      |
| **B6** | Documenting the worker in `.env.example`      | Resolve the pending `.env.example` revert first, then authorize the edit, or keep the documentation in README / docs only                                                                  | Your call: `.env.*` edits are currently prohibited                                             |
| **B7** | Approval of the scope itself                  | Mandatory WP1–WP7, plus any optional WPs you select                                                                                                                                        | WP1–WP7 + WP-O2                                                                                |

**Statuses (unchanged):** Phase 4 **IN PROGRESS — NOT APPROVED** · Batch 8 + M1 **ACCEPTED — OFFLINE
MOCKED SCOPE ONLY** · RD-12 / D-61 **ARCHITECTURE APPROVED — IMPLEMENTATION NOT AUTHORIZED** · Batch 9 /
Batch 10 **NOT AUTHORIZED** · MySQL / external verification **PENDING** · production readiness **NOT
ESTABLISHED**.
