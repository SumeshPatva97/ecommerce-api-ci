# Phase 4 — Background Jobs and Scheduling

**Status:** scheduler with 10 registered jobs, run by the **dedicated worker process** (`src/worker.ts`, Batch 9 — **ACCEPTED — OFFLINE MOCKED SCOPE ONLY**, owner, 2026-11-24; previously "COMPLETE, PENDING USER ACCEPTANCE") (Batch 8 added `abandoned-carts`; Batch 8 + M1 **accepted — offline mocked scope only**, 2026-11-20), tested with a **mocked DB** only. Not run against MySQL, not validated for production. **Off by default** (`JOBS_ENABLED=false`). **Single server only**: multi-server safety is **not** claimed (§5).
**Updated:** 2026-11-20 (batches 3–5, Batch 7 fixes D1–D5 + RD-10, Batch 8 abandoned carts + M1) · **Spec:** `project-documentation/04-backend/BACKEND_STRUCTURE.md` §14 · **Constraint:** D-38 / OQ-35 (Redis/BullMQ deferred)

## 1. Scheduler

| File                                     | Purpose                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/jobs/scheduler.ts`                  | `createJobScheduler(jobs, logger)`: fixed-interval timers; per-job overlap protection (a run is skipped while the previous one is in flight); errors logged, never thrown; `stop()` waits for in-flight runs; `runNow(name)`. Rejects duplicate names and intervals below 1 s. Timers are `unref()`'d.                                           |
| `src/jobs/registry.ts`                   | `buildScheduledJobs(container)`: the jobs below with their intervals.                                                                                                                                                                                                                                                                            |
| `src/core/config/env.ts`                 | `JOBS_ENABLED` (boolean, default `false`) → `config.jobs.enabled`.                                                                                                                                                                                                                                                                               |
| `src/worker.ts` / `src/workerRuntime.ts` | **Dedicated worker process** (D-61, Batch 9): runs the scheduler only when `JOBS_ENABLED=true` (otherwise logs and exits 0); no HTTP server; heartbeat log every minute; graceful shutdown (`src/core/lifecycle/workerLifecycle.ts`): stop signal → wait for running jobs → disconnect DB → exit; second signal ignored; forced exit after 60 s. |
| `src/server.ts`                          | API process: **never** starts the scheduler (Batch 9); `JOBS_ENABLED=true` there is ignored with a warning.                                                                                                                                                                                                                                      |

Enabling the scheduler in any environment is an owner decision. Nothing turns it on automatically. **RD-12 is DECIDED (2026-11-20, D-61): single dedicated worker process, separate from the API; multi-server scheduling deferred; no Redis/BullMQ.** **Batch 9 (ACCEPTED — OFFLINE MOCKED SCOPE ONLY, owner, 2026-11-24; previously "COMPLETE — PENDING USER ACCEPTANCE"; offline / mocked validation only)** implements it: jobs run only in the worker (`npm run dev:worker` / `npm run start:worker`, with `JOBS_ENABLED=true` for the worker only); the API process never runs them. Long jobs (payment reconciliation, tracking poll, notification dispatch) check a stop signal between items, so shutdown never interrupts an item halfway (WP-O2).

## 2. Job coverage against §14

| §14 job                  | Spec schedule         | Status                                                                                                                                                                                                                                                                                                                         | Interval here             | Source                                               |
| ------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- | ---------------------------------------------------- |
| `reservation-expiry`     | 1 min                 | **Scheduled**                                                                                                                                                                                                                                                                                                                  | 60 s                      | `reservationExpiry.ts`                               |
| `unpaid-order-cancel`    | 5 min                 | **Scheduled**                                                                                                                                                                                                                                                                                                                  | 5 min                     | `unpaidOrderCancel.ts`                               |
| `notification-retries`   | 5 min                 | **Scheduled** as `notification-dispatch` (sends due + retries failed)                                                                                                                                                                                                                                                          | 15 s                      | `notificationDispatcher.ts`                          |
| `payment-reconciliation` | 15 min                | **Scheduled** (batch 4): PENDING > 20 min → gateway status → same capture/fail service as the webhook                                                                                                                                                                                                                          | 15 min                    | `paymentReconciliation.ts`                           |
| `shipment-tracking-poll` | 30 min                | **Scheduled** (batch 4): only adapters implementing `getTracking`; a no-op with the default (webhook) mock                                                                                                                                                                                                                     | 30 min                    | `shipmentTrackingPoll.ts` → `shipments.pollTracking` |
| `promotion-activation`   | 1 min                 | **Scheduled** (batch 5): SCHEDULED→ACTIVE, →EXPIRED; compare-and-set + SYSTEM audit                                                                                                                                                                                                                                            | 60 s                      | `promotionActivation.ts`                             |
| `best-seller-refresh`    | nightly 02:00 IST     | **Scheduled** (batch 5): `total_sold` = net units, last 90 days (OQ-50 provisional)                                                                                                                                                                                                                                            | 24 h, first run +20 min   | `catalogAggregates.ts`                               |
| `rating-aggregate`       | on approve + nightly  | **Scheduled** (batch 5) nightly safety net; the on-approve recompute already existed                                                                                                                                                                                                                                           | 24 h, first run +30 min   | `catalogAggregates.ts`                               |
| `token-cleanup`          | daily 03:00 IST       | **Scheduled** (batch 3)                                                                                                                                                                                                                                                                                                        | 24 h, first run +10 min   | `tokenCleanup.ts`                                    |
| `low-stock-digest`       | daily 09:00 IST       | **Not implemented by decision**: RD-09 approved 2026-11-20 = instant alerts only (`inventory.alerts.ts`).                                                                                                                                                                                                                      | —                         | —                                                    |
| `abandoned-carts`        | hourly                | **Scheduled** (Batch 8, RD-08 option B; **accepted — offline mocked scope only**): ACTIVE idle > `cart.abandon_after_days` (default 30, valid 1–365) → ABANDONED; purged 90 days after `abandoned_at` (items by ON DELETE CASCADE); ACTIVE / CONVERTED never purged; compare-and-set guarded; reactivation by the cart service | 60 min, first run +15 min | `abandonedCarts.ts`                                  |
| `report-exports`         | queue + daily cleanup | Worker exists, **not scheduled**: needs a durable queue + private storage                                                                                                                                                                                                                                                      | —                         | `reportExport.ts`                                    |
| `coupon-expiry-sweep`    | hourly                | Not implemented: read-only metrics, no metrics backend                                                                                                                                                                                                                                                                         | —                         | —                                                    |

## 3. Job behaviour notes

**payment-reconciliation.** It fetches the gateway state by `providerPaymentId` when we have one, otherwise via the **optional** adapter method `fetchOrderPayments(providerOrderId)`; payments it cannot query are counted `unverifiable` and left untouched. A capture goes through `capturePayment` (source `RECONCILIATION`, actor SYSTEM, order row lock, amount check, OQ-59 late-capture refund executed after commit). A PENDING payment is failed only when every gateway payment is FAILED. **RD-10 (option B, Batch 7):** payments CANCELLED within the last 24 h (`updated_at` as the proxy; there is no `cancelled_at` column) are also re-checked, and only a gateway CAPTURE is applied, via the late-capture path. **D2:** an amount mismatch is recorded once per gateway payment. **D3:** rows are read in id order after a cursor kept by the registry, so unresolved rows cannot starve newer ones.

**shipment-tracking-poll.** It polls dispatched, non-terminal shipments (`SHIPPED`, `IN_TRANSIT`, `OUT_FOR_DELIVERY`, `DELIVERY_FAILED`, `RTO_INITIATED`) booked through a polling adapter (`provider` = `<adapter>:<courier>`), 200 per adapter per run, with an 8 s courier timeout (§15). **D4:** rows are read in id order after a per-adapter cursor kept by the registry, so every in-flight shipment is polled in turn. §14 names only SHIPPED/IN_TRANSIT; the other three are included so deliveries and returns are still detected. Events are applied by the same code as the webhook (`applyProviderEvents`, source `SYSTEM`). The dedupe hash is `sha256(provider:eventId)` whatever the source, so an event received by webhook and poll is stored once.

**promotion-activation.** Pricing and admin reads already evaluate dates (`effectiveStatus`), so the job keeps the stored status and the audit trail in line; correctness does not depend on it. **D1:** the compare-and-set matches status, `starts_at` and `ends_at` as read, so an admin date edit in between makes the write a no-op. §14's cache invalidation is not needed (no cache exists). _(Added 2026-11-24, D-63.)_ A stored `EXPIRED` is final: the job never selects such a row, and a `PATCH` leaves it `EXPIRED` even when the dates are edited. Known discrepancy: while the stored status is still `SCHEDULED` / `ACTIVE` after `ends_at` (the job has not run yet, or no worker is running), a `PATCH` that moves `ends_at` into the future makes the promotion effective again. No correction is authorized (DEC-06-impl).

**best-seller-refresh.** Units = `quantity − quantity_cancelled` on order lines whose order was confirmed in the last 90 days and is not PENDING_PAYMENT / PAYMENT_FAILED / CANCELLED. Returns are not subtracted. The OQ-50 admin pin **already exists** (`products.is_best_seller_pinned`, applied first by the catalogue sort); the job does not touch it. Only changed products are written.

**rating-aggregate.** Finds products whose stored values differ from APPROVED, non-deleted reviews. **D5:** each such product is then recomputed with `recomputeProductRating` inside a transaction that first locks the product row (`SELECT … FOR UPDATE`), so the job never overwrites a newer value written by a concurrent moderation. Limitation: two concurrent moderations of the same product (existing reviews-module path) are not serialised by this change.

**abandoned-carts (Batch 8).** Batched (500 ids, ≤ 20 batches per step per run). The UPDATE / DELETE repeat the full condition (status AND cut-off), so a cart used or reactivated between read and write is skipped, and an ACTIVE cart can never be deleted. Reactivation is done by the cart service, not the job: when a customer with no ACTIVE cart calls any cart route, their newest ABANDONED cart becomes ACTIVE again (items kept). The database unique `uq_carts_active_owner` guarantees one ACTIVE cart per customer. A request that loses a race re-reads the winner **outside a transaction**; add-item and merge resolve the cart before their transaction and claim it with a status- and owner-constrained `updateMany` (M1). No reminders (OQ-62); empty carts are not deleted early (§14 rule superseded by RD-08 B). **Batch 8 + M1 accepted — offline mocked scope only.** **MySQL concurrency and locking are NOT verified** (compare-and-set and claim semantics, REPEATABLE READ snapshots, P2002 under concurrency, lock interactions with checkout, cart-item cascade) — Batch 12, after G7/G8.

**token-cleanup.** Batched deletes (1 000 ids per batch, up to 50 batches per table per run). **All periods are PROPOSED, NOT APPROVED**: they come from DATABASE_DESIGN §20, whose whole retention table is "[PROPOSED] pending OQ-38" (RD-11). Refresh tokens: expired or revoked more than **30 days** ago (§20: "30 days after expiry/revocation"). Verification tokens: expired, consumed or invalidated more than **7 days** ago (§20: "7 days after expiry/consumption"; "invalidated" is an extension). Idempotency keys: past `expires_at`, daily; this **deviates** from §20 (24 h + 1 day grace, hourly purge). Audit logs are never touched. RD-11 and D6 are not implemented (Batch 7 restriction).

## 4. Idempotency and failure handling (tested, mocked DB)

| Job                    | Re-run / concurrent run                                                                                 | Per-item failure                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| payment-reconciliation | second run on the same stale row → `ALREADY_CAPTURED` (no double capture)                               | gateway error on one payment → counted, others continue, retried next run |
| shipment-tracking-poll | re-poll → dedupe hash hit, nothing written                                                              | courier error on one shipment → counted, others continue                  |
| promotion-activation   | lost compare-and-set → no audit row; nothing due → no writes                                            | failing update on one promotion → counted, others continue                |
| best-seller / rating   | unchanged values → no writes                                                                            | whole run fails and is logged; next interval retries                      |
| abandoned-carts        | second run → no rows match, nothing written; mid-run customer activity → compare-and-set skips the cart | whole run fails and is logged; next hour retries                          |
| token-cleanup          | deletes only rows matching the cut-offs                                                                 | whole run fails and is logged; next interval retries                      |
| scheduler              | overlapping tick skipped while a run is in flight                                                       | job error logged; schedule continues; `stop()` waits for in-flight runs   |

Tests: `tests/unit/jobs/{scheduler,paymentReconciliation,shipmentTrackingPoll,catalogJobs}.test.ts`, `tests/unit/modules/payments/jobs.test.ts`.

## 5. Distributed locking: required before more than one server

- **Today:** no lock. Only the dedicated worker runs jobs (the API never does). Running two workers would run every job twice. §14 requires `lock:job:<name>` per job.
- **Why the jobs are still written defensively:** row locks plus compare-and-set (orders, promotions), dedupe hashes (tracking), and idempotent capture/fail services. A duplicate run _should_ not corrupt data, but it doubles gateway, courier and notification work. This has **not** been verified on MySQL or across processes.
- **RD-12 decided 2026-11-20 (D-61); implemented in Batch 9 (accepted for offline mocked scope only on 2026-11-24; previously "pending acceptance"):** a single dedicated worker process runs all jobs; multi-server / distributed scheduling is **deferred**; no Redis/BullMQ without a future decision. **Operational rule (B3, deployment discipline):** run **exactly one** worker process, and **stop the old worker before starting a replacement** (no overlap during deployments). No database-level guard exists; that is evaluated in Batch 12.
- **Options considered for RD-12 (history; option 3 chosen):** BullMQ repeatable jobs + Redis lock (documented design, needs Redis); MySQL `GET_LOCK` per run (needs a design note for Prisma connection pooling, plus MySQL testing); a dedicated single worker process.

## 6. Other deviations

1. **Fixed intervals, not IST cron.** Daily jobs run every 24 h from process start.
2. **No persisted schedule state.** A restart resets the timers. Jobs select their work from the database, so nothing is lost, but timing shifts.
3. **No metrics/alerting.** Structured logs only (`job run finished` / `job run failed`, with the job's summary).

## 6a. Current limitations — clarification (2026-11-20, pre-acceptance documentation fix)

This section adds no behaviour. It records limitations of the current implementation; none of them is solved by documentation.

**Current implemented behaviour:**

- One dedicated worker process (`src/worker.ts` → `src/workerRuntime.ts`) runs all scheduled jobs, only when `JOBS_ENABLED=true`. The API never runs jobs.
- The in-process scheduler (`src/jobs/scheduler.ts`) prevents a job from overlapping itself **within one process** only.
- `notification-dispatch` (every 15 s) claims each due row with a conditional `QUEUED → SENDING` update, then sends it.
- Worker shutdown (`src/core/lifecycle/workerLifecycle.ts`): stop the scheduler (long jobs stop after their current item), wait for in-flight runs, disconnect the database. A second signal is ignored. Forced exit with code 1 after **60 s** (`WORKER_HARD_EXIT_MS`).

**Known operational limitations:**

1. **Exactly one worker.** This is required by deployment discipline (B3, D-61). There is no distributed lock and no runtime enforcement.
2. **Duplicate execution.** Running two workers executes every scheduled job twice (see §5).
3. **Notifications stuck in `SENDING`.** A forced termination during a send can leave a row in `SENDING`. No code reclaims such rows; manual recovery is required (B5).
4. **60 s forced exit.** It can interrupt a running job, or an operation that runs after a transaction has committed (e.g. a gateway refund call or a notification send). The open transaction rolls back; post-commit work is lost.
5. **M-1 refund interruption.**
   - **Flows.** It applies to five code paths _(count aligned 2026-11-24 with D-64 and the runbook §9; previously "four flows")_. Four are listed here and the fifth, the admin retry, is named below:
     - worker-side late-capture refund (`payment-reconciliation`);
     - API staff refund approval;
     - API customer self-cancel;
     - API-side late capture via payment verify or webhook.

     The admin retry of a `FAILED` gateway refund follows the same commit-then-call pattern.

   - **What happens.** The refund is committed as `PROCESSING` and the gateway call runs after commit. An interruption between the two leaves it **`PROCESSING`**. **No automatic recovery exists**: retry accepts only `FAILED`, and no job re-checks `PROCESSING` refunds.
   - **Manual handling.** A gateway refund may be recorded as completed (`POST /admin/refunds/:refundId/complete`, which records only and never calls the gateway) **only after the provider confirms the refund actually completed**. This is a procedural rule, not enforced by code. _(Added 2026-11-24.)_ The manual procedure adopted by D-64 is in `docs/operations/DEPLOYMENT_AND_OPERATIONS.md` §9.1: the provider-side status is established before any action. A "re-submit gateway refund" action is a proposal only and does not exist.
6. **Premature `REFUND_INITIATED`.** In staff approval and customer self-cancel, the notification is queued inside the transaction, before the gateway call. It may be delivered even if the gateway call never happens.

**Unresolved business decisions (not decided here):**

- Recovery when the provider confirms **no refund was issued** for a `PROCESSING` refund: **undefined**.
- Whether premature "refund initiated" notifications are acceptable.
- Whether late-capture automatic refunds should send `REFUND_INITIATED` (OQ-59; the current code sends none).

**Deferred architecture:** Redis / BullMQ, distributed locking and multi-server scheduling remain deferred (D-38, D-61). They are not implemented and not authorized.

References: `docs/PHASE4-REFUND-RISK-DOCUMENTATION-ALIGNMENT-REPORT.md`, `docs/PHASE4-BATCH9-UPDATED-FINAL-ACCEPTANCE-REVIEW.md`.

## 7. Validation levels

| Level                                                  | Status                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Offline (typecheck, lint, unit tests with fake timers) | Done: see the master progress report                                                  |
| Simulated DB (mocked Prisma, in-memory payment world)  | Done for every registered job                                                         |
| Actual MySQL integration                               | **Not done.** Blocked on DB gates (G2 pending, G3 not accepted, G7/G8 not authorized) |
| Real gateway / courier                                 | **Not done.** No vendor chosen (OQ-06 / OQ-07); mocks only                            |
| Production validation                                  | **Not done**                                                                          |
