# Phase 4 Master Completion — Agent 2: Jobs, Registry and Scheduler

| Field       | Value                                                     |
| ----------- | --------------------------------------------------------- |
| Document ID | P4-MASTER-AGENT2                                          |
| Date        | 2026-11-24                                                |
| Scope       | WP10-1, WP10-2, WP10-5 and the scheduler fix (IMP-09)     |
| Executed by | Orchestrator                                              |
| Evidence    | Offline / mocked tests; mutation checks on scratch copies |

## Status

| Work package                           | Status           | Note                                                                               |
| -------------------------------------- | ---------------- | ---------------------------------------------------------------------------------- |
| WP10-1 Registry wiring tests (M-2)     | ALREADY COMPLETE | Verified in Step 3.2 with a mutation check; re-run today                           |
| WP10-2 Per-item error isolation        | ALREADY COMPLETE | Verified in Step 3.2; four tests added there                                       |
| WP10-5 Configurable best-seller window | ALREADY COMPLETE | Source from 2026-11-21 verified; five malformed-value test cases added in this run |
| Scheduler fix (IMP-09)                 | ALREADY COMPLETE | Source from 2026-11-21 verified; mutation check added in this run                  |

No source file was changed in this run.

## WP10-1 and WP10-2

See `PHASE4-STEP3-2-BATCH10-WP10-1-WP10-2-REPORT.md`. Re-run today: `registryWiring.test.ts`
5 passed; the WP10-2 tests pass within `catalogJobs.test.ts`.

## WP10-5 — `catalog.best_seller_window_days`

**Source** (`src/jobs/catalogAggregates.ts`, `loadBestSellerWindowDays`):

- reads the setting `catalog.best_seller_window_days`;
- uses it when it is a number, an integer, and between 1 and 730 (the same bounds as
  `settings.values.ts`);
- otherwise uses 90.

**Tests** (`tests/unit/jobs/catalogJobs.test.ts`):

| Case                                                                 | Result |
| -------------------------------------------------------------------- | ------ |
| Configured valid value (30 days) changes the query window            | Pass   |
| Bounds 1 and 730 accepted                                            | Pass   |
| Missing row → 90                                                     | Pass   |
| Invalid: 0, 731, 12.5 → 90                                           | Pass   |
| Malformed: string `'30'`, `null` → 90                                | Pass   |
| Malformed, added today: negative, `NaN`, boolean, object, array → 90 | Pass   |

**Limits:**

- If reading the setting itself fails (database error), the whole run fails and is logged by the
  scheduler. It does not silently continue with 90.
- The settings seed has not been executed, so 90 is the effective value today.

## Scheduler fix (IMP-09)

**Source** (`src/jobs/scheduler.ts`):

- `execute` starts the job through an async wrapper. A synchronous throw from `job.run()` becomes a
  rejected run, logged as `job run failed`, and the in-flight entry is cleared. The scheduler keeps
  running.
- The header comment and start log now describe one dedicated worker process (D-61), with
  multi-server execution deferred.

**Test:** `tests/unit/jobs/scheduler.test.ts` "synchronous throw from run() (IMP-09) › is logged as
a failed run, does not escape, and the schedule continues".

**Mutation check (scratch copy; `src/jobs/scheduler.ts` not edited):**

| Scheduler variant                                  | `scheduler.test.ts`                       |
| -------------------------------------------------- | ----------------------------------------- |
| Unmodified copy (control)                          | 6 passed                                  |
| Async wrapper removed (direct `job.run(...)` call) | **1 failed** ("Error: sync boom" escapes) |

## Tests executed today

| Command                                                                                                                       | Result             |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `npx vitest run tests/unit/jobs/catalogJobs.test.ts tests/unit/jobs/scheduler.test.ts tests/unit/jobs/registryWiring.test.ts` | 3 files, 37 passed |
| `npx eslint tests/unit/jobs/catalogJobs.test.ts --max-warnings 0`                                                             | Pass               |

## Files changed in this run

- `tests/unit/jobs/catalogJobs.test.ts`: five WP10-5 malformed-value cases added to an existing
  `it.each` table.
