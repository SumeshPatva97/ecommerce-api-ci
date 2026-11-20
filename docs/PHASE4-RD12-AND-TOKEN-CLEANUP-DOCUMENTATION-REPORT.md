# Phase 4 — RD-12 Decision and Token-Cleanup Documentation Report

| Field         | Value                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Document ID   | P4-RD12-TOKDOC-01                                                                                                                                                        |
| Date          | 2026-11-20                                                                                                                                                               |
| Authorization | Owner, 2026-11-20: RD-12 architecture decision approved (implementation not authorized); documentation-only Tasks A and B                                                |
| Nature        | **Documentation only.** No application code, test, schema, migration, seed, dependency, configuration, environment, database or Git change; no runtime behaviour changed |

## 1. Task A — RD-12 recorded

**Decision (owner, 2026-11-20):**

1. Single dedicated worker process for background jobs and scheduled tasks.
2. API server and worker run as separate processes with separated responsibilities.
3. Multi-server / distributed scheduling is deferred.
4. No Redis, BullMQ or other queue infrastructure without a future approved decision.
5. **Architecture approved; implementation not authorized.**

**Date convention.** Owner decisions are recorded as `D-xx` rows in PROJECT_CONTEXT §17 with a dated
status (e.g. D-57 to D-60, "[CONFIRMED] 2026-11-19"). RD-12 is therefore recorded as **D-61** in a new
§17.7, "[CONFIRMED] 2026-11-20 (architecture only)".

**Files updated for Task A:**

| File                                                         | Change                                                                                                                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project-documentation/01-requirements/PROJECT_CONTEXT.md`   | New §17.7 "Owner decision of 2026-11-20 (RD-12 background-job architecture)" with D-61. Nothing else changed.                                                                   |
| `ecommerce-api/docs/PHASE4-REMAINING-DECISIONS.md`           | RD-12 heading; new decision block at the top; closing "Answer needed" line replaced by "Answer given 2026-11-20: option 3". The analysis and options table are kept as history. |
| `ecommerce-api/docs/PHASE4-JOBS-AND-SCHEDULING.md`           | §1 scheduler sentence; §5 "Rule until RD-12 is decided" bullet; §5 options bullet relabelled "considered … option 3 chosen"                                                     |
| `ecommerce-api/docs/PHASE3-PHASE4-MASTER-PROGRESS-REPORT.md` | New headline row "RD-12 (job architecture)"; new §15                                                                                                                            |

**RD-12 wording, before and after:**

| Location                                | Before                                                                                                                      | After                                                                                                                                                                                                                                           |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PHASE4-REMAINING-DECISIONS heading      | "RD-12 — Scheduler beyond one server (required before multi-instance)"                                                      | "RD-12 — Scheduler beyond one server (DECIDED 2026-11-20: single dedicated worker — implementation NOT authorized)"                                                                                                                             |
| PHASE4-REMAINING-DECISIONS closing line | "Answer needed from you: choose one before any multi-instance deployment. Until then: one process only."                    | "Answer given 2026-11-20: option 3, dedicated single worker process (see decision above). Until the worker is implemented: one process only."                                                                                                   |
| Jobs doc §1                             | "The dedicated background worker (RD-12, Batch 9) is NOT implemented … the scheduler currently runs inside the API process" | Adds "RD-12 is DECIDED (2026-11-20, D-61): single dedicated worker process, separate from the API; multi-server scheduling deferred; no Redis/BullMQ. The architecture is approved, but …"; the NOT implemented / API-process statement is kept |
| Jobs doc §5                             | "Rule until RD-12 is decided: run jobs in exactly one process."                                                             | "RD-12 decided 2026-11-20 (D-61): … Not implemented yet (Batch 9 not authorized). Rule until the worker exists: run jobs in exactly one process."                                                                                               |
| PROJECT_CONTEXT §17                     | (no entry)                                                                                                                  | D-61, as above                                                                                                                                                                                                                                  |

**Architecture documents not changed.** SYSTEM_ARCHITECTURE and BACKEND_STRUCTURE already describe a
separate worker service with its own entrypoint (`src/worker.ts`) as the target design (BullMQ-based,
which needs Redis). D-61 agrees with the process separation and keeps BullMQ/Redis deferred under D-38;
D-61 states this explicitly. No edit to those documents was necessary for the decision to be accurate.

## 2. Task B — token-cleanup audit

**Implementation (read-only verification of the code):**

| Fact                                                        | Evidence                                                                                                                                                                    |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Batch size 1 000 ids                                        | `src/jobs/tokenCleanup.ts`: `TOKEN_CLEANUP_BATCH = 1000`, used as `take`                                                                                                    |
| At most 50 batches per table per run                        | `tokenCleanup.ts`: `maxBatches = options.maxBatches ?? 50`                                                                                                                  |
| Every 24 h from process start, first run 10 min after start | `src/jobs/registry.ts`: `intervalMs: 24 * 60 * MINUTE`, `initialDelayMs: 10 * MINUTE`; `src/jobs/scheduler.ts`: `setTimeout(initialDelayMs)` then `setInterval(intervalMs)` |
| Not at a fixed off-peak IST time                            | No time-of-day logic in the scheduler or job. The fixed interval is a documented deviation (jobs doc §6).                                                                   |
| Runs only when enabled                                      | The scheduler starts only when `JOBS_ENABLED=true` (off by default), inside the API process (RD-12 worker not implemented)                                                  |

**Documentation before the correction:**

- **DATABASE_DESIGN §20** closing sentence: "Purge jobs run with small batches (`LIMIT 5000`) in off-peak
  IST hours …" (plus the Batch 8 `abandoned-carts` exception). This implied 5 000-row off-peak
  batches for the token purges.
- **BACKEND_STRUCTURE §14** `token-cleanup` row: "daily 03:00 IST … Batched deletes of 1 000 rows". The
  1 000 is correct; 03:00 IST is the target, and the deviation is documented in the jobs doc.

The reported mismatch is **confirmed**.

**Correction (smallest, documentation only).** One exception was appended to the same §20 closing
sentence in `project-documentation/05-database/DATABASE_DESIGN.md`:

> **Exception — `token-cleanup`** (refresh tokens, verification tokens, idempotency keys; current
> implementation): deletes in batches of **1 000** ids (at most 50 batches per table per run), on a fixed
> **24-hour interval from process start** (first run 10 minutes after start), not at a fixed off-peak
> IST time; the `LIMIT 5000` wording above does not apply to it.

**Preserved:**

- The general `LIMIT 5000` sentence (valid design wording for the notification-log purge, §20 row
  "Daily batch delete … LIMIT 5000 loop").
- The `abandoned-carts` exception: hourly, batches of 500.
- All retention periods and the §20 table rows. RD-11 is deferred, so the idempotency-key "Hourly purge"
  row was not touched (see §6).

## 3. Files inspected and modified

**Inspected:**

- `ecommerce-api/docs/PHASE4-REMAINING-DECISIONS.md`
- `ecommerce-api/docs/PHASE4-JOBS-AND-SCHEDULING.md`
- `ecommerce-api/docs/PHASE3-PHASE4-MASTER-PROGRESS-REPORT.md`
- `ecommerce-api/src/jobs/README.md` (read only)
- `project-documentation/01-requirements/PROJECT_CONTEXT.md` (§17)
- `project-documentation/04-backend/BACKEND_STRUCTURE.md` (§3 tree, §14)
- `project-documentation/02-architecture/SYSTEM_ARCHITECTURE.md` (worker references)
- `project-documentation/05-database/DATABASE_DESIGN.md` (§20)
- `ecommerce-api/src/jobs/tokenCleanup.ts`, `registry.ts`, `scheduler.ts` (read only, for evidence)

**Modified:**

1. `project-documentation/01-requirements/PROJECT_CONTEXT.md`: new §17.7 (D-61)
2. `ecommerce-api/docs/PHASE4-REMAINING-DECISIONS.md`: RD-12
3. `ecommerce-api/docs/PHASE4-JOBS-AND-SCHEDULING.md`: §1, §5
4. `ecommerce-api/docs/PHASE3-PHASE4-MASTER-PROGRESS-REPORT.md`: headline row, §15
5. `project-documentation/05-database/DATABASE_DESIGN.md`: §20 closing sentence (token-cleanup exception)
6. `ecommerce-api/docs/PHASE4-RD12-AND-TOKEN-CLEANUP-DOCUMENTATION-REPORT.md`: **new** (this report)

The two `project-documentation` files were edited by exact text replacement, with no formatter and LF
endings kept. Prettier was run only on the `ecommerce-api/docs` files above.

## 4. Validation results

| #   | Check                                            | Result                                                                                                                                     |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | RD-12 recorded as approved architecture decision | PASS: D-61 (PROJECT_CONTEXT §17.7), RD-12 heading and decision block, jobs doc, master report                                              |
| 2   | Single dedicated worker documented consistently  | PASS: same wording in all four documents; consistent with the SYSTEM_ARCHITECTURE / BACKEND_STRUCTURE separate worker entrypoint           |
| 3   | Multi-server / distributed scheduling deferred   | PASS: D-61, RD-12, jobs doc §5, master report §15                                                                                          |
| 4   | Worker explicitly NOT IMPLEMENTED                | PASS: D-61 "Current state", RD-12 point 5, jobs doc §1 and §5, master report row and §15                                                   |
| 5   | Batch 9 remains NOT AUTHORIZED                   | PASS: stated in D-61, RD-12, jobs doc, master report                                                                                       |
| 6   | Token-cleanup docs match implementation          | PASS: 1 000-id batches, ≤ 50 per table, 24 h from start, first run +10 min                                                                 |
| 7   | Notification-log purge configuration             | Unchanged (§20 row and general `LIMIT 5000` sentence). Note: no notification-log purge job is implemented yet; the §20 text is the design. |
| 8   | Abandoned-cart purge hourly, batches of 500      | Unchanged in DATABASE_DESIGN §20, BACKEND_STRUCTURE §14, jobs doc                                                                          |
| 9   | 30-day threshold / 90-day retention              | Unchanged                                                                                                                                  |
| 10  | Batch 8 + M1 acceptance scope                    | Still ACCEPTED — OFFLINE MOCKED SCOPE ONLY                                                                                                 |

## 5. Confirmations

- **No application code, tests, schema, migrations, seeds, dependencies or configuration changed; no
  runtime behaviour changed.** The scheduler still runs inside the API process when enabled.
- No MySQL or external service connection; no database command; no test run.
- No `.env` / `.env.*` inspected, read, printed, copied or modified.
- No Git command; `.git` not investigated.
- **Batch 9 and Batch 10 remain NOT AUTHORIZED.** The dedicated worker was not implemented.
- No production-readiness claim.

## 6. Remaining unresolved issues

1. **Idempotency-key purge mechanism.** DATABASE_DESIGN §20 says "24 h + 1 day grace | Hourly purge",
   but the implementation deletes keys at `expires_at` inside the daily token-cleanup. This is an
   RD-11 item (deferred, OQ-38) and was deliberately not changed.
2. **`ecommerce-api/src/jobs/README.md`** still says "Multi-server operation needs RD-12". Informational
   and in the source tree, which this task did not cover; it should be refreshed when Batch 9 is
   authorized.
3. **BACKEND_STRUCTURE §14 intro** ("Each scheduled job takes a Redis lock") and the BullMQ worker tree
   describe the long-term target. Under D-61 / D-38 the interim design has no Redis; D-61 records this,
   but the §14 intro itself was not edited.
4. **Other 2026-11-20 owner decisions** (RD-08 option B, RD-09 instant only, RD-10 option B, RD-13
   option B) are recorded in `PHASE4-REMAINING-DECISIONS.md` but not as `D-xx` rows in PROJECT_CONTEXT
   §17. Adding them needs separate authorization.

## 7. Status

Phase 4 **IN PROGRESS — NOT APPROVED** · Batch 8 + M1 **ACCEPTED — OFFLINE MOCKED SCOPE ONLY** · RD-12
**ARCHITECTURE APPROVED — IMPLEMENTATION NOT AUTHORIZED** · Batch 9 / Batch 10 **NOT AUTHORIZED** ·
MySQL / external integration verification **PENDING** required gates · production readiness **NOT
ESTABLISHED**.
