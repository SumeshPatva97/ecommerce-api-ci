# Phase 4 — D-61 Documentation Consistency Correction Report

| Field         | Value                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| Document ID   | P4-D61-DOC-CONSISTENCY-01                                                                              |
| Date          | 2026-11-20                                                                                             |
| Authorization | Explicit user authorization provided on 2026-11-20: findings F8, F9, F11, F14, F13, F1, F2 (DOC-06 §4) |
| Nature        | Documentation only                                                                                     |
| Status        | **COMPLETE — pending user review**                                                                     |

DOC-06 was accepted by the owner on 2026-11-20 as a completed documentation-only task.

## 1. Files changed

| File                                                                           | Findings    | Change                                                                                                                           |
| ------------------------------------------------------------------------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `project-documentation/09-deployment/REPOSITORY_SETUP_GUIDE.md`                | F8, F9      | §13.1 ports table + current-state note; §13.2 current procedure and smoke test added; old diagram / smoke test labelled deferred |
| `project-documentation/04-backend/BACKEND_STRUCTURE.md`                        | F11, F1, F2 | §22, §13 and §13.1: D-61 current-implementation notes                                                                            |
| `project-documentation/09-deployment/DEPLOYMENT_ARCHITECTURE.md`               | F14         | §12 Worker row split into current / deferred; D-61 worker-constraint note                                                        |
| `project-documentation/02-architecture/SYSTEM_ARCHITECTURE.md`                 | F13         | §5.1: D-61 current-architecture note                                                                                             |
| `ecommerce-api/docs/PHASE4-D61-DOCUMENTATION-CONSISTENCY-CORRECTION-REPORT.md` | —           | Created (this report)                                                                                                            |

All four canonical files were edited surgically. Prettier was not run on them, and they keep LF line
endings (0 CR characters each).

**Approach:** the target-design text is kept and labelled. A current-state note is added next to it.
Nothing was rewritten wholesale, and no new architecture decision was introduced.

## 2. Findings addressed

### F8 — `REPOSITORY_SETUP_GUIDE.md` §13.1 Ports

- "API worker (BullMQ)" is renamed "Dedicated background worker (D-61; `npm run dev:worker`)", with
  "no HTTP listener".
- The Redis and Mailpit rows are labelled "deferred target design; not a current local service".
- A note lists the active local services: the API (`:4000`), the single worker (no port) and MySQL
  (`:3306`, native per D-37). It also says the storefront / admin ports are target design, because
  those repositories do not exist yet.

### F9 — `REPOSITORY_SETUP_GUIDE.md` §13.2 Start sequence and smoke test

**New "Current procedure"** (uses only scripts that exist in `package.json`):

1. Start the local MySQL server manually. No `db:up` script, no compose file, no Redis or Mailpit.
2. `db:migrate:deploy` / `db:seed` exist but are gated (G7 / G8). Do not run them without that
   authorization.
3. `npm run dev` starts the API on port 4000; it runs no jobs.
4. `npm run dev:worker` with `JOBS_ENABLED=true` for the worker only. Exactly one worker; without the
   flag it logs and exits 0.

**New "Current smoke test":**

- `/health/live` → `200 {"status":"ok"}`.
- `/health/ready` → `200 {"status":"ready","checks":{"database":"ok"}}`, or `503` with
  `"database":"fail"`. There is no Redis check.
- The worker start-up log line and a 60 s heartbeat appear.
- Email uses the fake adapter's in-memory outbox in whichever process sends:
  - auth flows and staff invites from the API;
  - queued notifications from the worker.

  There is no inbox UI.

**Kept but labelled "Target design (deferred — not current …)":** the original diagram (`db:up`,
mysql / redis / mailpit healthy) and the original smoke test (`redis: "up"`, Mailpit email).

### F11 — `BACKEND_STRUCTURE.md` §22 Health checks and graceful shutdown

The note says the readiness table and shutdown steps 3–4 (BullMQ `worker.close()`, Redis disconnect)
are target design; steps 1, 2 and 5 match the API. Current behaviour:

- **Readiness:** one check, `database`, plus "not shutting down". `Retry-After: 5` on 503. No Redis
  check and no migrations flag.
- **API shutdown:** 25 s drain, then database disconnect, then exit; hard exit after 30 s.
- **Worker shutdown** (`workerLifecycle.ts`; no HTTP listener, no health endpoint): cleanup runs once:
  1. stop the scheduler (long jobs stop after their current item);
  2. wait for in-flight runs;
  3. disconnect the database;
  4. exit 0, or 1 on error.

  A second signal is ignored. Forced exit 1 after **60 s**.

- **Interrupted work:** picked up again from the database on the next run. The exception is
  post-commit side effects; M-1 is cited.
- Exactly one worker.

### F14 — `DEPLOYMENT_ARCHITECTURE.md` §12 Scaling

- The Worker row now reads: **Current (D-61):** exactly one worker task, no autoscaling, fixed at 1.
  **Deferred proposal:** BullMQ queue-depth scaling, max 4.
- The new note states:
  - one worker; no lock, so a second worker would duplicate every job;
  - the Queues / Redis rows are target design;
  - more than one worker, or autoscaling, needs a **future architecture decision and a separate
    implementation authorization**.

### F13 — `SYSTEM_ARCHITECTURE.md` §5.1 Container responsibilities

The note separates three things:

- **Approved (D-61):** a single dedicated worker; multi-server scheduling deferred.
- **Implemented (Batch 9, pending acceptance):**
  - `src/worker.ts` with the in-process interval scheduler, only when `JOBS_ENABLED=true`;
  - no separate scheduler process;
  - no HTTP on the worker at all;
  - the API runs no jobs;
  - exactly one worker.
- **Not implemented (deferred):** Redis, BullMQ, queues, distributed locks, multiple workers.

The Worker service row's "Must NOT: expose HTTP (except health)" is target design. Today the worker
has no health endpoint either; the note states this.

### F1 — `BACKEND_STRUCTURE.md` §13 Domain events, outbox and queues

The note says the BullMQ / Redis parts are a deferred proposal. Current behaviour:

- `notifications` rows are still written in the business transaction with status `QUEUED`.
- Nothing is enqueued.
- `notification-dispatch` (every 15 s, in the single worker):
  - claims each row with a conditional `QUEUED → SENDING` update;
  - also retries failed rows with attempts left. The registry comment says it "covers
    `notification-retries`"; there is no separately named job.
- The email adapter is fake.
- Rows left in `SENDING` after a forced kill are not recovered automatically.

### F2 — `BACKEND_STRUCTURE.md` §13.1 Queues

The note says none of the queues exist (Redis / BullMQ deferred) and that jobs run on fixed intervals
in the single worker (§14). The table is a deferred proposal.

## 3. Validation

| Check                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Re-read every modified section            | Done for all four canonical files after editing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Statements match implementation           | Checked against source code (read only). `package.json` scripts: no `db:up`; `db:migrate:deploy`, `db:seed`, `dev`, `dev:worker` exist. `env.ts`: `PORT` default 4000, `JOBS_ENABLED` default false, `EMAIL_PROVIDER` fake only. `server.ts`: only the `database` readiness check; onClose disconnects the DB. `health.routes.ts`: response bodies and `Retry-After: 5`. `httpServer.ts`: 25 s / 30 s. `workerLifecycle.ts`: once-only cleanup, second signal ignored, `WORKER_HARD_EXIT_MS = 60_000`. `workerRuntime.ts`: start-up and heartbeat messages, 60 s heartbeat. `registry.ts`: `notification-dispatch` every 15 s, covers retries. Direct API email sends: `auth.context.ts`, `staff.service.ts` |
| D-61 unchanged                            | `PROJECT_CONTEXT.md` not modified; the notes only cite D-61                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Exactly-one-worker requirement            | Stated in all four files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Current vs deferred distinguished         | Every edited location has an explicit "Current" label and a "deferred / target design" label                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Setup steps need no non-existent services | The current procedure uses only existing scripts and native MySQL. `db:up`, Docker, Redis and Mailpit appear only under deferred labels                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| No unauthorized files changed             | Modification-time scan of the workspace (excluding `node_modules`, `.git`, `dist`, `coverage`) since the task started: only the five files in §1. `.env*` metadata unchanged (`.env` 19:05:02, `.env.example` 17:37:18, `.env.migration.example` 2026-11-18)                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Formatting                                | Prettier run only on this report; `npm run format:check` PASS. The canonical files are outside the `ecommerce-api` Prettier scope and were not formatted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## 4. Unresolved findings

### 4.1 Read-only, not authorized in this task

| #   | Exact location                                                                                                                       | Existing statement                                                                                                                                                                                    | Recommended correction                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F15 | `project-documentation/02-architecture/REPOSITORY_ARCHITECTURE.md` §4.1 tree, lines 115, 116, 126; §5.3 environments table, line 262 | `worker.ts # BullMQ worker entrypoint`; `scheduler.ts # repeatable jobs registration`; `docker-compose.yml # local MySQL 8 + Redis (dev only)`; local: "Docker MySQL/Redis, seed data, fake adapters" | Annotate as in BACKEND_STRUCTURE §3 (DOC-01): `worker.ts` = D-61 worker entry; current scheduler is `src/jobs/scheduler.ts`; compose file is target design (absent). Local row: native MySQL (D-37), Redis deferred (D-38) |
| F16 | `project-documentation/10-project-management/DEVELOPMENT_GUIDELINES.md` §6.1, line 190                                               | `worker.ts # BullMQ worker entrypoint (separate process)`                                                                                                                                             | `worker.ts # dedicated worker entrypoint (separate process, D-61; BullMQ deferred)`                                                                                                                                        |
| F22 | `ecommerce-api/docs/PHASE4-REMAINING-DECISIONS.md` RD-12 heading, line 234                                                           | "DECIDED 2026-11-20: single dedicated worker — implementation NOT authorized"                                                                                                                         | Append "— implemented in Batch 9, pending acceptance" (the body already has the Batch 9 status note)                                                                                                                       |

### 4.2 New finding from this task (read-only, not corrected)

**N1. The email outbox location is partly misstated.**

The API process also sends email directly:

- auth flows: `src/modules/auth/auth.context.ts`;
- staff invites: `src/modules/staff/staff.service.ts`.

So with the fake adapter, those messages sit in the **API** process's in-memory outbox. Only
dispatched notifications sit in the worker's. Three statements say all of it lives in the worker
process:

| Location                                                                          | Statement                                                                                                   |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `project-documentation/09-deployment/REPOSITORY_SETUP_GUIDE.md` §15, line 850     | "Emails not appearing" row (DOC-01): fake adapter "keeps messages in the worker process's in-memory outbox" |
| `ecommerce-api/docs/PHASE4-BATCH9-COMPLETION-REPORT.md` §6 item 7, line 194       | "the fake email adapter's in-memory outbox now lives in the worker process"                                 |
| `ecommerce-api/docs/PHASE4-BATCH9-DOCUMENTATION-CORRECTION-REPORT.md` §2, line 41 | Same claim                                                                                                  |

**Recommended correction:** "API-sent emails (auth, staff invites) stay in the API process's outbox;
dispatched notifications in the worker's". The §15 row's cause ("worker not running") applies only to
notification emails.

Not edited, because it lies outside the seven authorized findings. The new §13.2 text in this task
already states it correctly.

### 4.3 Other open items

- The remaining optional findings from DOC-06 §4 (F3 – F7, F12, F17 – F21) are unchanged.
- DOC-07 – DOC-12 are open.
- M-1 and M-2 are open.

## 5. Confirmation

Documentation only:

- No source code or tests were changed.
- No `.env`, `.env.example` or `.env.*` file was opened or modified (metadata only).
- No package files, dependencies, Dockerfiles or Docker configuration were changed.
- The Prisma schema, migrations and seeds were not changed.
- Redis, BullMQ, Mailpit and SMTP were not implemented.
- Worker and shutdown behaviour were not changed, and D-61 was not changed.
- No database command, Git command or `.git` inspection was performed.
- No batch or gate was started. M-1 and M-2 were not implemented.

**Statuses:**

- Batch 9: **COMPLETE — PENDING USER ACCEPTANCE**
- Phase 4: **IN PROGRESS — NOT APPROVED**
- Gate G4: **NOT MET**
