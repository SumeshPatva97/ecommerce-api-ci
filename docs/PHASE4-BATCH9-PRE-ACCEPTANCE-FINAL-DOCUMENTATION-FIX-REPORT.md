# Phase 4 — Batch 9 Pre-Acceptance Final Documentation Fix Report

| Field         | Value                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------- |
| Document ID   | P4-BATCH9-PREACCEPT-DOC-01                                                               |
| Date          | 2026-11-20                                                                               |
| Authorization | Explicit user authorization provided on 2026-11-20 — documentation only, corrections A–C |
| Basis         | `docs/PHASE4-BATCH9-UPDATED-FINAL-ACCEPTANCE-REVIEW.md` §12 (DC-1, DC-2, DC-3)           |

## 1. Files and sections changed

| #   | File                                                                                | Section                                                       | Correction |
| --- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------- |
| 1   | `project-documentation/04-backend/API_DOCUMENTATION.md`                             | §4.11 `POST /admin/refunds/:refundId/retry` row               | A          |
| 1   | (same file)                                                                         | §4.11 `POST /admin/refunds` field table: new `reasonCode` row | B          |
| 2   | `ecommerce-api/docs/PHASE4-JOBS-AND-SCHEDULING.md`                                  | New §6a "Current limitations — clarification (2026-11-20)"    | C          |
| 3   | `ecommerce-api/docs/PHASE4-BATCH9-PRE-ACCEPTANCE-FINAL-DOCUMENTATION-FIX-REPORT.md` | New (this report)                                             | —          |

**File-count note.** The instruction expected "exactly three existing documentation files". The three
authorized corrections fall in **two** files: A and B are both in `API_DOCUMENTATION.md`, and C is in
`PHASE4-JOBS-AND-SCHEDULING.md`. No other file was modified to reach three. The actual result is
**two existing files plus one new report**.

`API_DOCUMENTATION.md` was edited surgically. Prettier was not run on it, and it keeps LF line
endings.

## 2. Corrections, before / after, and source evidence

### A. Retry row (API_DOCUMENTATION §4.11)

**Before:** Perm "`refunds.update`; `Idempotency-Key`"; Behaviour "Only from `FAILED`; re-submits to
gateway."

**After:**

- **Perm:** `refunds.update` + **Reauth** (R-15; enforced by the route); `Idempotency-Key`.
- **Body:** optional `note` (1–500).
- **Allowed from `FAILED` only**, else 409 `INVALID_STATE_TRANSITION`. At most 5 retries, else 409
  `CONFLICT` with `RETRY_LIMIT_REACHED`.
- Each retry increments the count, writes an `UPDATE` audit row, and moves the refund to
  `PROCESSING`.
- **Gateway refund:** gateway call after commit. The result is recorded as `COMPLETED` or `FAILED`;
  anything else leaves it `PROCESSING`. A retry does not guarantee success, and an interruption
  leaves it `PROCESSING` (M-1).
- **Bank transfer:** back to `PROCESSING` for manual completion; **no gateway call**.
- The old wording is recorded in a dated marker.

**Evidence:**

| Fact                     | Source                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| State / limit checks     | `src/modules/refunds/refunds.service.ts` `retry` (480–524): `refund.status !== 'FAILED'` → `invalidState(… ['FAILED'], 'Only failed refunds can be retried.')`; `retryCount >= MAX_REFUND_RETRIES` → `AppError('CONFLICT', 'Retry limit reached; escalate to finance.', code RETRY_LIMIT_REACHED)`; `MAX_REFUND_RETRIES = 5` (line 44)                                    |
| Count, audit             | `retryCount: { increment: 1 }`; `audit.record(… action: 'UPDATE', after: { status: 'PROCESSING' … })`                                                                                                                                                                                                                                                                     |
| Gateway vs bank transfer | `prepareGatewayRefund(tx, …)` (sets `PROCESSING` and returns a job for an original-method refund with a provider payment id). If it returns `null`, the code sets `PROCESSING` with the comment "Bank transfer (or no gateway reference): back to PROCESSING for manual completion". After commit: `runGateway(job)` → `executeGatewayRefund` (no-op when `job === null`) |
| Result recording         | `refunds.core.ts` `executeGatewayRefund`: `COMPLETED` → `markRefundCompleted`; `FAILED` → `FAILED`; otherwise only the provider refund id is stored                                                                                                                                                                                                                       |
| Route guards and body    | `refunds.routes.ts` (96–106): `perm('refunds.update')`, `c.auth.requireReauth()`, `idem()`, `validate({ body: RetryRefundBody })`. Header comment: re-auth per R-15 "supersedes the API_DOCUMENTATION table (no re-auth listed for retry)". `refunds.schemas.ts` `RetryRefundBody = z.strictObject({ note: … min(1).max(500).optional() })`                               |
| HTTP statuses            | `src/core/errors/errorCodes.ts`: `INVALID_STATE_TRANSITION: 409`, `CONFLICT: 409`                                                                                                                                                                                                                                                                                         |

### B. `reasonCode` (API_DOCUMENTATION §4.11 create-refund table)

**Before:** no `reasonCode` row.

**After:** a new row:

- optional string; after trimming it must match `^[A-Z_]{2,40}$`, else 422 `VALIDATION_ERROR`;
- default `OTHER`;
- stored in `refunds.reason_code` (`VARCHAR(40)`);
- **no fixed enumeration** in the current code.

**Evidence:**

| Fact                          | Source                                                                                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Validation, optional, default | `refunds.schemas.ts` `CreateRefundBody`: `reasonCode: z.string().trim().regex(/^[A-Z_]{2,40}$/, 'Use an UPPER_SNAKE_CASE reason code.').default('OTHER')`      |
| No enum                       | The code uses a regex, not an enum. The Prisma `Refund` model has `reasonCode String @map("reason_code") @db.VarChar(40)` (schema line 1501), not an enum type |
| Passed through                | `refunds.service.ts` `create`: `reasonCode: input.reasonCode`                                                                                                  |
| 422                           | `errorCodes.ts` `VALIDATION_ERROR: 422`; `validate` middleware                                                                                                 |

No accepted-value list was invented. Other fields were not modified.

### C. Jobs and scheduling limitations (`PHASE4-JOBS-AND-SCHEDULING.md`)

**Before:** no consolidated limitation section. §5 covered the lock and single worker; there was
nothing on `SENDING`, the 60 s forced exit, M-1 or notification timing.

**After:** a new dated §6a, inserted before §7. It separates:

- **Current implemented behaviour:** one worker, `JOBS_ENABLED`, a per-process overlap guard only,
  `QUEUED → SENDING` dispatch, the shutdown sequence, and the 60 s forced exit.
- **Known operational limitations (1–6):**
  - exactly one worker, with no lock or enforcement;
  - duplicate execution if two workers run;
  - `SENDING` rows after a forced kill need manual recovery;
  - the 60 s forced exit can interrupt jobs and post-commit operations;
  - M-1: four flows (plus retry), committed `PROCESSING`, no automatic recovery, `complete` only after
    provider confirmation (a procedural rule, not enforced);
  - premature `REFUND_INITIATED` in staff approval and customer self-cancel.
- **Unresolved business decisions:** recovery when no refund was issued (undefined); acceptability
  of premature notifications; OQ-59 late-capture notification.
- **Deferred architecture:** Redis / BullMQ, distributed locking, multi-server scheduling.

§1–§7 were not rewritten. The section states that documentation solves none of these risks.

**Evidence:**

| Item                    | Source                                                                                                                                                                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker, `JOBS_ENABLED`  | `src/workerRuntime.ts` (`if (!config.jobs.enabled)` … return `started: false`); `src/server.ts` (no scheduler import)                                                                                                                                                                                                           |
| Overlap guard, no lock  | `src/jobs/scheduler.ts` `execute`: skips while `inFlight.has(job.name)` (per process); no lock code anywhere                                                                                                                                                                                                                    |
| Dispatch / `SENDING`    | `src/jobs/registry.ts` (`notification-dispatch`, 15 000 ms); `notifications.dispatcher.ts` (`status: 'SENDING'` claim, line 284); no stale-`SENDING` reclaim (0 matches)                                                                                                                                                        |
| Shutdown, 60 s          | `src/core/lifecycle/workerLifecycle.ts`: `WORKER_HARD_EXIT_MS = 60_000`, second signal ignored; `workerRuntime.ts` `onClose` (`scheduler.stop()` aborts and awaits, then DB disconnect)                                                                                                                                         |
| M-1 flows               | `payments.refunds.ts` `refundsModuleHook` → `prepareGatewayRefund`; `paymentReconciliation.ts` (181 / 194); `payments.service.ts` `verify` / `handleWebhook` (`runRefundJob` after commit); `refunds.service.ts` `approve` / `retry` (`runGateway` after commit); `orders.cancel.ts` (254) → `orders.service.ts` `finishCancel` |
| No automatic recovery   | No job or route re-executes a `PROCESSING` refund's gateway call; `retry` `FAILED`-only                                                                                                                                                                                                                                         |
| `complete` records only | `refunds.service.ts` `complete` → `markRefundCompleted`; no provider call                                                                                                                                                                                                                                                       |
| Premature notification  | `refunds.service.ts` `approve` and `orders.cancel.ts` (226–249) call `notifyOrderEvent(… 'REFUND_INITIATED')` before `prepareGatewayRefund`; `notifications.service.ts` `enqueue(tx, …)` → `tx.notification.create` (`QUEUED`)                                                                                                  |
| OQ-59                   | 0 occurrences of `'REFUND_INITIATED'` in `payments.capture.ts` / `payments.refunds.ts`                                                                                                                                                                                                                                          |

## 3. Findings not previously listed, and items not verified

- **Retry has the same commit-then-call pattern as M-1.** An admin retry of a `FAILED` gateway refund
  commits `PROCESSING`, then calls the gateway after commit. This was not in the earlier "four flows"
  list.
  - It is recorded in the new §6a and in the retry row.
  - It does not change the four-flow statements elsewhere, which were not edited.
  - Strictly, there are **five** code paths with this pattern.
- **Retry re-auth.** The code enforces re-auth on retry (R-15), which the API documentation previously
  omitted. It is now documented in the retry row's Perm column.
- **Not verified in this task:** real behaviour (gateway, MySQL, OS signals, two processes). Only the
  code was inspected. No statement claims runtime verification.

## 4. Validation

| Check                                    | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Changed sections re-read                 | Done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Every statement traced to code           | §2 above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Retry verified separately per method     | Gateway path (`prepareGatewayRefund` returns a job) and bank-transfer path (`null` → `PROCESSING`, no call) both traced                                                                                                                                                                                                                                                                                                                                                                              |
| `reasonCode` optional / default / values | Verified: optional with default `OTHER`; regex-validated; no enum                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Changed-file list, formatting, `.env*`   | Modification-time scan since 22:55 (excluding `node_modules`, `.git`, `dist`, `coverage`): exactly `API_DOCUMENTATION.md`, `PHASE4-JOBS-AND-SCHEDULING.md` and this report. `npm run format:check` **PASS**. Prettier was applied to the jobs document; it was already formatted, so only the new §6a was affected. `API_DOCUMENTATION.md`: 0 CR, not run through Prettier. `.env*` timestamps unchanged (`.env` 19:05:02, `.env.example` 17:37:18, `.env.migration.example` 2026-11-18); not opened |

## 5. Confirmations

- **No source code changed,** including `src/jobs/scheduler.ts` (its stale comment / log wording
  remains, R-16). Tests, scripts, packages, lockfile, configuration, schema, migrations, seeds,
  Docker and deployment files were not modified either.
- **No acceptance review or historical completion report was modified.**
  `PHASE4-BATCH9-FINAL-ACCEPTANCE-REVIEW.md`, `PHASE4-BATCH9-UPDATED-FINAL-ACCEPTANCE-REVIEW.md` and
  `PHASE4-BATCH9-COMPLETION-REPORT.md` are unchanged.
- **No excluded systems accessed:** no MySQL, Redis, payment gateway, courier or external service;
  no Git command and no `.git` access; `.env` / `.env.*` not opened (timestamps only).
- **Batch 9 remains COMPLETE — PENDING USER ACCEPTANCE.** It was not accepted on your behalf.

**Statuses (unchanged):**

- Phase 1–3: **APPROVED — COMPLETE**
- Phase 4: **IN PROGRESS — NOT APPROVED**
- Batch 7: **ACCEPTED — OFFLINE MOCKED SCOPE ONLY**
- Batch 8 + M1: **ACCEPTED — OFFLINE MOCKED SCOPE ONLY**
- Batch 9: **COMPLETE — PENDING USER ACCEPTANCE**
- Batch 10: **NOT AUTHORIZED**
- G4: **NOT MET**
- Production readiness: **NOT ESTABLISHED**
