# Phase 4 — Final D-61 Documentation Cleanup Report

| Field         | Value                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------ |
| Document ID   | P4-D61-DOC-CLEANUP-01                                                                      |
| Date          | 2026-11-20                                                                                 |
| Authorization | Explicit user authorization provided on 2026-11-20: N1, F15, F16, F22 (documentation only) |
| Status        | **COMPLETE — pending user review**                                                         |

## 1. Files changed

| File                                                                    | Finding | Change                                                                                      |
| ----------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------- |
| `project-documentation/09-deployment/REPOSITORY_SETUP_GUIDE.md`         | N1      | §15 "Emails not appearing" row rewritten (cause and fix per process)                        |
| `ecommerce-api/docs/PHASE4-BATCH9-COMPLETION-REPORT.md`                 | N1      | §6 item 7 corrected (dated correction marker)                                               |
| `ecommerce-api/docs/PHASE4-BATCH9-DOCUMENTATION-CORRECTION-REPORT.md`   | N1      | §2 Mailpit bullet corrected (dated correction marker)                                       |
| `project-documentation/02-architecture/REPOSITORY_ARCHITECTURE.md`      | F15     | §4.1 tree lines for `worker.ts`, `scheduler.ts`, `docker-compose.yml`; §5.3 `local` row     |
| `project-documentation/10-project-management/DEVELOPMENT_GUIDELINES.md` | F16     | §6.1 `worker.ts` comment                                                                    |
| `ecommerce-api/docs/PHASE4-REMAINING-DECISIONS.md`                      | F22     | RD-12 heading extended; dated status summary added below the existing Batch 9 status update |
| `ecommerce-api/docs/PHASE4-FINAL-D61-DOCUMENTATION-CLEANUP-REPORT.md`   | —       | Created (this report)                                                                       |

The three canonical `project-documentation` files were edited surgically. Prettier was not run on them,
and they keep LF line endings.

## 2. Corrections

### N1 — process-local fake email outbox

All three locations now say:

- The only provider is a fake development adapter, not SMTP or Mailpit.
- Its in-memory outbox is **process-local** (last 200 messages); the API and the worker do not share
  it.
- **Auth emails** (verification, account-exists, password reset / changed, security alerts) and
  **staff invites** are sent by the **API** process and stay in the API's outbox.
- **Notification emails** are delivered by the **worker** (`notification-dispatch`) and stay in the
  worker's outbox.

In the setup guide row:

- The cause column now separates "worker not running / `JOBS_ENABLED` not `true`" (notification
  emails) from "looking in the wrong process" (auth / staff-invite emails).
- "Exactly one worker (D-61)" is kept, and "Mailpit `:8025` is target design" is kept.

### F15 — `REPOSITORY_ARCHITECTURE.md`

| Location                     | Before                                         | After                                                                                                                                                      |
| ---------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §4.1 `worker.ts`             | "BullMQ worker entrypoint"                     | Dedicated worker entrypoint (D-61, current); BullMQ consumers = deferred target                                                                            |
| §4.1 `scheduler.ts`          | "repeatable jobs registration"                 | Target only; current: `src/jobs/scheduler.ts`, in-process, in the worker                                                                                   |
| §4.1 `docker-compose.yml`    | "local MySQL 8 + Redis (dev only)"             | Target only (not present); current: native MySQL (D-37), Redis deferred (D-38)                                                                             |
| §5.3 `local` environment row | "Docker MySQL/Redis, seed data, fake adapters" | Target text kept, plus current state: native MySQL, no Redis, no Docker Compose, fake adapters, API + exactly one worker (D-61), seed execution gated (G8) |

The future proposals were kept and labelled "target", not removed.

### F16 — `DEVELOPMENT_GUIDELINES.md` §6.1

`worker.ts # BullMQ worker entrypoint (separate process)` now reads "dedicated D-61 worker entrypoint
(separate process; in-process job scheduler; BullMQ deferred)".

### F22 — `PHASE4-REMAINING-DECISIONS.md` RD-12

- **Heading:** the original wording is kept and extended: "… implementation NOT authorized by the
  decision; later implemented in Batch 9, pending acceptance". No document links to the heading
  anchor (searched).
- **Kept unchanged:** the decision items 1–5 (the historical record) and the existing Batch 9 status
  update.
- **New dated "Status summary" block:**
  - D-61 decision: APPROVED.
  - The decision itself did not authorize implementation.
  - Batch 9 implementation was authorized separately (WP1–WP7 + WP-O2, B1–B7).
  - The worker was implemented under Batch 9; acceptance is PENDING.
  - Multi-server scheduling: DEFERRED.
  - Redis / BullMQ: not implemented and not authorized.

## 3. Code evidence checked (read only)

| Claim                                       | Evidence                                                                                                                                                                                                                                                                                           |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fake adapter, process-local outbox, 200 cap | `src/integrations/email/emailProvider.ts`: `FakeEmailProviderAdapter` has an instance field `outbox: CapturedEmail[]` and drops the oldest message beyond 200                                                                                                                                      |
| One adapter per process                     | `src/container.ts`: each container creates `new FakeEmailProviderAdapter()`; the API (`server.ts`) and the worker (`worker.ts`) each build their own runtime (`createProcessRuntime`)                                                                                                              |
| Only provider is fake                       | `src/core/config/env.ts`: `EMAIL_PROVIDER: z.enum(['fake'])`                                                                                                                                                                                                                                       |
| Auth emails sent by the API                 | `sendEmailSafe` (`src/modules/auth/auth.context.ts`) is called from `auth.service.ts` (VERIFICATION_REQUESTED, ACCOUNT_ALREADY_EXISTS), `password.service.ts` (PASSWORD_CHANGED, PASSWORD_RESET_REQUESTED), `credentials.ts` and `session.service.ts` (SECURITY_ALERT)                             |
| Staff invites sent by the API               | `src/modules/staff/staff.service.ts`: `providers.email.send` in `afterCommit` (STAFF_INVITED)                                                                                                                                                                                                      |
| Notifications delivered only by the worker  | `dispatchPending` is reached only through `runNotificationDispatch`, which only `src/jobs/registry.ts` (`notification-dispatch`) uses. The scheduler runs only in the worker. `createNotificationDispatchJob` has no caller. An admin resend creates a new `QUEUED` row (`notifications.admin.ts`) |
| D-61 worker facts                           | Verified in the earlier tasks of this session (`worker.ts`, `workerRuntime.ts`, `jobs/scheduler.ts`, `server.ts`); unchanged                                                                                                                                                                       |

## 4. Validation

| Check                              | Result                                                                                                                                                                                                                                             |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Re-read modified documents         | All changed sections re-read after editing                                                                                                                                                                                                         |
| Statements match code              | See §3                                                                                                                                                                                                                                             |
| D-61 consistency                   | `PROJECT_CONTEXT.md` not modified. Every edit keeps a single dedicated worker, multi-server deferred, and no Redis / BullMQ                                                                                                                        |
| API vs worker email responsibility | Stated identically in all three N1 locations and in the setup guide §13.2 (D-61 consistency task)                                                                                                                                                  |
| F15 / F16 / F22                    | Applied at the exact locations named in the D-61 consistency report                                                                                                                                                                                |
| Formatting                         | Prettier run only on the four changed `ecommerce-api` docs (three were already formatted); `npm run format:check` PASS. The three canonical files have 0 CR characters (LF kept) and were not run through Prettier                                 |
| No unauthorized files changed      | Modification-time scan of the workspace since 21:57 (excluding `node_modules`, `.git`, `dist`, `coverage`): only the seven files in §1. `.env*` metadata unchanged (`.env` 19:05:02, `.env.example` 17:37:18, `.env.migration.example` 2026-11-18) |

## 5. Remaining documentation inconsistencies (not corrected, not authorized)

- **`REPOSITORY_ARCHITECTURE.md` §4.1, outside the authorized lines:**
  - `jobs/ # queue processors`: current — interval jobs run by the in-process scheduler, no queues;
  - `lib/ # … redis, cache …`: Redis deferred.

  The tree also uses pre-R-45 folder names (`config/`, `middleware/`, `adapters/`). It has the same
  kind of drift that DEVELOPMENT_GUIDELINES §6.1 already notes as superseded by BACKEND_STRUCTURE §3.

- **Historical text:** the D-61 consistency report (`PHASE4-D61-DOCUMENTATION-CONSISTENCY-CORRECTION-REPORT.md`)
  still lists N1, F15, F16 and F22 as unresolved. It is a dated record and was not edited; this report
  supersedes those entries.
- **Optional DOC-06 findings:** F3 – F7, F12 and F17 – F21 are unchanged.
- **Other open items:** DOC-07 – DOC-12 (untouched), M-1, M-2.

## 6. Confirmation

No implementation was performed:

- No source code or tests were changed.
- No `.env`, `.env.example` or `.env.*` file was opened or modified (metadata only).
- No dependencies, package files, Dockerfiles, schema, migrations or seeds were changed.
- Worker and API behaviour, and architecture decisions, are unchanged.
- No database command, Git command or `.git` inspection was performed.
- No batch or gate was started. M-1 and M-2 were not implemented.

**Statuses:**

- Batch 9: **COMPLETE — PENDING USER ACCEPTANCE**
- Phase 4: **IN PROGRESS — NOT APPROVED**
- Gate G4: **NOT MET**
