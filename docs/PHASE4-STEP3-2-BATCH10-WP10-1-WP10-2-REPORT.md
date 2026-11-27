# Phase 4 — Step 3.2: Batch 10 WP10-1 (Registry Wiring) and WP10-2 (Aggregate Error Isolation)

| Field         | Value                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------- |
| Document ID   | P4-STEP3-2-B10-01                                                                           |
| Date          | 2026-11-24                                                                                  |
| Authorization | Owner's Phase 4 Execution Authorization — G4 Closure; Step 3.2 brief (reconciliation first) |
| Scope         | WP10-1 and WP10-2 only                                                                      |
| Evidence type | Offline / mocked tests. No database, external service or production                         |

## 1. Status

| Work package                                  | Status               | Meaning                                                                                                                  |
| --------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| WP10-1 Registry wiring tests (M-2)            | **ALREADY COMPLETE** | The tests existed and pass. This step added mutation evidence for the "tests fail if removed" criterion; no file changed |
| WP10-2 Per-item error isolation in aggregates | **ALREADY COMPLETE** | The source change existed and is correct. This step added four focused tests; no source changed                          |

Batch 10 is **not** accepted by this report. G4 is NOT MET. Phase 4 is IN PROGRESS — NOT APPROVED.

## 2. Pre-change reconciliation

Git was not used. The reconciliation is based on file contents and modification times.

| File                                     | Last modified    | Finding                                                                                                                                        |
| ---------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/jobs/registry.ts`                   | 2026-11-20 20:51 | Unchanged since Batch 9. Keeps the reconciliation and tracking cursors between runs and passes `signal` to three jobs                          |
| `tests/unit/jobs/registryWiring.test.ts` | 2026-11-21 00:09 | Exists: 5 tests, real registry and real scheduler, the three long job modules mocked                                                           |
| `src/jobs/catalogAggregates.ts`          | 2026-11-21 00:03 | Per-product `try/catch` exists in both jobs; summary is `{ products, updated, errors }`. The file **also contains the WP10-5 change** (see §6) |
| `tests/unit/jobs/catalogJobs.test.ts`    | 2026-11-21 00:03 | Two WP10-2 tests existed (one failing product among three, per job)                                                                            |

**Definitions used:** `PHASE4-BATCH10-TECHNICAL-REVIEW-AND-PROPOSAL.md` §3, rows WP10-1 and WP10-2.

**Missing before this step:**

- WP10-1: proof that the tests fail when the wiring is removed. The earlier work argued this by
  reading and did not demonstrate it.
- WP10-2:
  - a test that a failure outside the per-product loop still fails the run;
  - the brief's literal two-product case.

## 3. WP10-1 — acceptance checklist and evidence

| #   | Criterion                                                         | Result  | Evidence                                                                                                                                                   |
| --- | ----------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Reconciliation cursor handed over between consecutive runs        | **MET** | "payment-reconciliation: run N+1 receives the nextCursor returned by run N": `after` across four runs = `[undefined, 'pay-100', 'pay-200', undefined]`     |
| 2   | Tracking cursor handed over between consecutive runs              | **MET** | "shipment-tracking-poll: run N+1 receives the per-courier cursor map returned by run N", including identity of the returned object                         |
| 3   | `AbortSignal` propagated to dispatch, reconciliation and tracking | **MET** | "the scheduler's AbortSignal reaches the three long jobs and is aborted by stop()" and "passes exactly the signal given to run() (direct registry call)"   |
| 4   | Tests exercise the real registry wiring                           | **MET** | The test imports `buildScheduledJobs` from `src/jobs/registry.js` and runs it through the real `createJobScheduler`; only the three job modules are mocked |
| 5   | Tests fail if cursor hand-off or signal propagation is removed    | **MET** | Mutation check below                                                                                                                                       |
| 6   | Test-only; `src/jobs/registry.ts` not modified                    | **MET** | Modification time unchanged (2026-11-20 20:51:36)                                                                                                          |

**Mutation check (criterion 5).** `src/jobs/registry.ts` was not edited.

- Copies of it were generated in the session scratchpad (outside the project), with imports rewritten
  to absolute paths.
- The unchanged test file was run against each copy through a module alias.

| Registry variant                             | Result of `registryWiring.test.ts`                                        |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| Real file (normal configuration)             | 5 passed                                                                  |
| Unmodified copy (control for the method)     | 5 passed                                                                  |
| `signal` removed from notification-dispatch  | **2 failed** ("expected undefined to be an instance of AbortSignal")      |
| `signal` removed from payment-reconciliation | **2 failed**                                                              |
| `signal` removed from shipment-tracking-poll | **2 failed**                                                              |
| Reconciliation cursor carry-over removed     | **1 failed** (`[undefined, undefined, …]` vs `[undefined, 'pay-100', …]`) |
| Tracking cursor carry-over removed           | **1 failed** (`[{}, {}, {}]` vs `[{}, { shiprocket: 'shp-10' }, …]`)      |

All five mutants are detected.

**M-2.** The audit finding (registry → job stop-signal wiring had no test) is closed at the level of
offline tests. Real process and real database behaviour remain unverified (unchanged limitation).

**No source defect** was found in `registry.ts`.

## 4. WP10-2 — acceptance checklist and evidence

| #   | Criterion                                                   | Result  | Evidence                                                                                                                                                                                                  |
| --- | ----------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | One failing product does not stop the others (both jobs)    | **MET** | "WP10-2: one failing product update is logged and counted; the others still update"; "WP10-2: one failing product transaction is logged and counted; the others still recompute"; and the new A / B tests |
| 2   | Error handling scoped to each individual product update     | **MET** | `catalogAggregates.ts`: the `try/catch` wraps only `db.product.update` (lines 86–99) and only the per-product transaction (lines 133–145). The queries before the loop are outside it                     |
| 3   | Summary reports accurate processed / updated / error counts | **MET** | `{ products: 3, updated: 2, errors: 1 }` and, new, `{ products: 2, updated: 1, errors: 1 }` for both jobs                                                                                                 |
| 4   | Errors are recorded, not swallowed                          | **MET** | Each failure is logged once at error level with `productId`, `err` and `job`, and counted in `errors` (asserted)                                                                                          |
| 5   | Existing successful behaviour intact                        | **MET** | The earlier success tests still pass with `errors: 0`                                                                                                                                                     |
| 6   | Job-level error handling intact                             | **MET** | New tests: a failing aggregate query or product read rejects the run, writes nothing and logs no per-product error. The scheduler then logs `job run failed` as before                                    |
| 7   | No schema, Prisma model or migration change                 | **MET** | None                                                                                                                                                                                                      |

**Compatibility check (consumers of the result).**

- The only callers of `runBestSellerRefresh` / `runRatingAggregate` are the two registry entries
  (`registry.ts` lines 77 and 83) and the unit tests.
- The registry returns the summary to the scheduler, which only logs it (`job run finished`).
- Nothing reads individual summary fields.
- The change to the summary is additive (`errors` added; `products` and `updated` unchanged).

## 5. Files changed during this step

| File                                                  | Change                                                                                                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/jobs/catalogJobs.test.ts`                 | Four tests added (two per job): "product A fails, product B succeeds → { products: 2, updated: 1, errors: 1 }" and "a failure outside the per-product loop still fails the whole run" |
| `docs/PHASE4-STEP3-2-BATCH10-WP10-1-WP10-2-REPORT.md` | New (this report)                                                                                                                                                                     |

**Not changed in this step:** `src/jobs/catalogAggregates.ts`, `src/jobs/registry.ts`,
`tests/unit/jobs/registryWiring.test.ts`, and every other source and test file.

Scratch files for the mutation check are in the session scratchpad only:
`C:\Users\sumes\AppData\Local\Temp\claude\a5448e9126e3e737\a448d3f8-74b5-4eb0-89c2-c55cb4a1803a\scratchpad\mut`.

## 6. Compatibility and regression concerns

1. **`catalogAggregates.ts` already contains WP10-5** (`loadBestSellerWindowDays`, the
   `catalog.best_seller_window_days` setting), and `catalogJobs.test.ts` already contains WP10-5
   tests. Both date from 2026-11-21 00:03. They were not written, changed or reviewed in this step,
   and they cannot be separated from the WP10-2 change without editing the file. WP10-5 needs its
   own reconciliation step.
2. **A run with per-product errors still ends as "job run finished".** The failures are visible in
   the per-product error log lines and in `errors` in the summary. No alerting exists, as documented
   in the jobs document.
3. **Failed products are retried only on the next scheduled run** (both jobs are daily). This is the
   behaviour the proposal defines.

## 7. Source defects outside the authorized scope

None discovered in this step.

## 8. Tests executed and actual results (2026-11-24, Node 24.12.0)

Run from `C:/…/ecommerce-api`.

| Command                                                      | Result                                      |
| ------------------------------------------------------------ | ------------------------------------------- |
| `npx vitest run tests/unit/jobs/registryWiring.test.ts`      | 1 file, **5 passed**                        |
| Mutation runs (scratch configuration, 1 control + 5 mutants) | Control 5 passed; each mutant failed (§3)   |
| `npx vitest run tests/unit/jobs/catalogJobs.test.ts`         | 1 file, **21 passed** (17 before this step) |
| `npx vitest run tests/unit/jobs`                             | 6 files, **62 passed**, 0 failed            |
| `npm run typecheck`                                          | **PASS**                                    |
| `npx eslint` on the two test files and the two source files  | PASS                                        |
| `npx prettier --check` on the same four files                | PASS                                        |

Repository-wide `format:check` and `lint` were **not run** in this step and are not claimed. The
seven unrelated files reported in Step 3.1 were not touched. The full test suite, build and OpenAPI
check were not run.

## 9. Confirmations

- **WP10-3, WP10-4, WP10-5, WP10-6 and the scheduler fix were not started, changed or verified in
  this step.** Code for them already exists from 2026-11-21 (earlier authorization). It was left
  exactly as found and still needs its own reconciliation.
- **No work** on notifications, the DEC-06 service guard, DEC-13 items or the database harness.
- **Not touched:** `.env`, `.env.*` and `.env.example` (not opened); Git (no command, commit or
  push); MySQL or any database; external providers; production; Prisma schema and migrations.
- **Statuses unchanged:** Batch 9 COMPLETE — PENDING USER ACCEPTANCE; Batch 10 not accepted;
  G4 NOT MET; Phase 4 IN PROGRESS — NOT APPROVED.

Step 3.2 ends here. WP10-3 and WP10-4 were not started.
