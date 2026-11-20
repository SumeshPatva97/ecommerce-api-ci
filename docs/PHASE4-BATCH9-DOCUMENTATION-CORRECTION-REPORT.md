# Phase 4 — Batch 9 Documentation Correction Report (DOC-01)

| Field         | Value                                                                       |
| ------------- | --------------------------------------------------------------------------- |
| Document ID   | P4-BATCH9-DOC-01                                                            |
| Date          | 2026-11-20                                                                  |
| Authorization | Explicit user authorization provided on 2026-11-20 (DOC-01 correction only) |
| Nature        | Documentation only: no source code, tests, configuration or schema changed  |
| Status        | **DOC-01 COMPLETE**                                                         |

## 1. Files changed

| File                                                                           | Correction                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ecommerce-api/docs/PHASE4-BATCH9-COMPLETION-REPORT.md`                        | §6 item 4: replaced "stays retryable via the admin retry route" with the accurate limitation (see §2). §6 item 8: dated pointer to this report.                                                                                 |
| `ecommerce-api/docs/PHASE4-BATCH9-TECHNICAL-REVIEW-AND-IMPLEMENTATION-PLAN.md` | §4 item 9: same refund correction.                                                                                                                                                                                              |
| `project-documentation/09-deployment/REPOSITORY_SETUP_GUIDE.md`                | §6.2 `dev:worker` row: now describes the D-61 dedicated worker, not BullMQ. §15 troubleshooting: "Emails not appearing" and "BullMQ jobs stuck" rows corrected. §16 Day-1 set-up: current-state note on `db:up` and the worker. |
| `project-documentation/04-backend/BACKEND_STRUCTURE.md`                        | §3 tree: `worker.ts` / `scheduler.ts` comments now distinguish target from current. §3.1 and §14: D-61 current-architecture notes added; the target-design text is kept and labelled deferred.                                  |
| `ecommerce-api/README.md`                                                      | "Project structure" tree: added `bootstrap.ts`, `worker.ts`, `workerRuntime.ts`, `jobs/` and `core/lifecycle/workerLifecycle.ts`.                                                                                               |
| `ecommerce-api/docs/PHASE4-BATCH9-DOCUMENTATION-CORRECTION-REPORT.md`          | Created (this report).                                                                                                                                                                                                          |

The two canonical `project-documentation` files were edited surgically. Prettier was not run on them, and they keep LF line endings.

## 2. Corrections

**Refund retry (audit finding M-1).** Both Batch 9 documents now state:

- A refund may remain **`PROCESSING`** if the worker stops or crashes after commit but before the gateway call. It is created `APPROVED` and moved to `PROCESSING` in the same transaction. _(Corrected 2026-11-20: this report originally said "may remain `approved`", which named the wrong state; see `PHASE4-M1-REFUND-PROCESSING-STATE-DOCUMENTATION-CORRECTION-REPORT.md`.)_
- The admin retry route accepts only `FAILED` refunds.
- Manual intervention is required. Check the gateway outcome first; use the existing `complete` route (accepts `PROCESSING`; records the refund, makes no gateway call) **only** if the provider confirms the refund was completed. If the gateway confirms no refund was issued, recovery is **undefined** (separate business decision) and `complete` must not be used. _(Clarified 2026-11-20.)_
- This is a known limitation, **not fixed**.

**Worker description (setup guide §6.2).**

- `dev:worker` starts the single dedicated worker process.
- That process runs the in-process job scheduler only when `JOBS_ENABLED=true`; otherwise it logs and exits.
- BullMQ / Redis is explicitly marked not implemented (deferred target design).

**Mailpit troubleshooting and Day-1 instructions.** Corrected according to project evidence, not removed:

- `EMAIL_PROVIDER` accepts only `fake` (`src/core/config/env.ts`). The fake adapter keeps messages in a **process-local** in-memory outbox; the API and the worker do not share it. _(Corrected 2026-11-20, N1: the earlier text said "in the worker process".)_
  - Notification emails are delivered by the worker.
  - Auth and staff-invite emails are sent by the API process and stay in the API's outbox.
- No Mailpit, SMTP, compose file or `db:up` script exists in `ecommerce-api` (`package.json`, `src` and the project root were searched).
- The Mailpit, `db:up` and BullMQ rows are kept as target design, each with a current-state note.

**BACKEND_STRUCTURE §3.1 / §14.** The process table and the Redis-lock sentence stay as the deferred multi-server proposal. The new notes describe the current state:

- `api` process: `src/server.ts`; never starts the scheduler.
- `worker` process: `src/worker.ts` → `src/workerRuntime.ts`.
- Shared start-up: `src/bootstrap.ts`.
- Worker shutdown: `src/core/lifecycle/workerLifecycle.ts`.
- Scheduler and jobs: `src/jobs/scheduler.ts` (fixed intervals, overlap-protected per job) and `src/jobs/registry.ts`.
- Exactly one worker, by discipline. No separate scheduler process, Redis, BullMQ or distributed lock.

**API README.** The project tree now lists the actual worker and bootstrap files.

## 3. Validation

| Check                        | Result                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Changed docs re-read         | Done for every edited section                                                                                                                                                                                                                                                                                                                                                               |
| Statements verified in code  | Retry accepts only `FAILED`: `refunds.service.ts` "Only failed refunds can be retried." `server.ts` never references the scheduler; it calls `warnIfJobsEnabledForApi`. `workerRuntime.ts`: `runWorker`, `JOBS_ENABLED` gate, 60 s heartbeat. `workerLifecycle.ts`: `WORKER_HARD_EXIT_MS = 60_000`. `scheduler.ts`: fixed intervals, overlap protection. `src/scheduler.ts` does not exist. |
| Referenced paths exist       | `src/bootstrap.ts`, `src/worker.ts`, `src/workerRuntime.ts`, `src/core/lifecycle/workerLifecycle.ts`, `src/jobs/scheduler.ts`, `src/jobs/registry.ts`, `docs/PHASE4-JOBS-AND-SCHEDULING.md`                                                                                                                                                                                                 |
| Line endings                 | All edited files: 0 CR characters (LF preserved)                                                                                                                                                                                                                                                                                                                                            |
| D-61 consistency             | Single worker; multi-server scheduling deferred; no Redis / BullMQ / lock. D-61 text in `PROJECT_CONTEXT.md` not touched                                                                                                                                                                                                                                                                    |
| Scope / unauthorized changes | The workspace modification-time scan (excluding `node_modules`, `.git`, `dist`, `coverage`) shows only the six files in §1 written during DOC-01 (21:31:49 – 21:32:54). The roadmap files (21:26 / 21:27) predate DOC-01. No `src`, `tests`, `prisma`, package or Docker file changed (newest: Batch 9 at 20:53 – 20:57).                                                                   |
| `.env*` metadata             | Unchanged: `.env` 19:05:02, `.env.example` 17:37:18, `.env.migration.example` 2026-11-18 (metadata only; contents not opened)                                                                                                                                                                                                                                                               |
| Formatting (`ecommerce-api`) | Prettier applied only to the four `ecommerce-api` docs; `npm run format:check` PASS ("All matched files use Prettier code style!")                                                                                                                                                                                                                                                          |

## 4. Unresolved limitations

- **M-1 is not fixed.** Interrupted post-commit refunds stay `PROCESSING` _(corrected 2026-11-20 from `approved`)_ and need manual intervention: check the gateway outcome; use `complete` only if the provider confirms the refund was completed; recovery is undefined if no refund was issued _(clarified 2026-11-20)_. No recovery was implemented.
- **M-2 is not addressed.** The hand-off test was not added (not authorized).
- `PHASE3-PHASE4-MASTER-PROGRESS-REPORT.md` §1 row RD-12 still says the worker is not implemented. That is DOC-06, not authorized here.
- Other canonical sections that still describe the BullMQ / Redis target were not edited (BACKEND_STRUCTURE §13 queues; setup guide Docker / Redis sections). They are target design and outside the DOC-01 scope.
- The Mailpit / `db:up` notes reflect the state on 2026-11-20 and must be revisited if a compose file or SMTP provider is added.
- No runtime verification: documentation statements were checked against source code only (no process was started, no database was used).

## 5. Confirmation

No application source code, tests, package files, Dockerfiles, Prisma schema, migrations or seeds were changed. No `.env`, `.env.example` or `.env.*` file was opened or modified (metadata only). No database command, external-service operation or Git command was run, and no `.git` internals were inspected. Refund recovery was not implemented, and worker and scheduler behaviour are unchanged. Batch 9 remains **COMPLETE — PENDING USER ACCEPTANCE**; Phase 4 **IN PROGRESS — NOT APPROVED**; Gate G4 **NOT MET**.
