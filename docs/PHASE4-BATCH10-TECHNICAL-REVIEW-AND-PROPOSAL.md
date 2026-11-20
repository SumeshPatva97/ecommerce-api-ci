# Phase 4 — Batch 10 Technical Review and Proposal

| Field        | Value                                                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document ID  | P4-BATCH10-REVIEW-01                                                                                                                               |
| Date         | 2026-11-20                                                                                                                                         |
| Roadmap item | B10-REV (`PHASE4-MASTER-COMPLETION-ROADMAP.md` §4-B, §6)                                                                                           |
| Basis        | Owner instruction of 2026-11-20 ("Phase 4 autonomous completion"), which permits documentation-only planning for Batch 10                          |
| Status       | **PROPOSED — NOT AUTHORIZED.** No code, test or configuration was changed. Implementation needs your explicit approval of the scope below (DEC-04) |

## 1. Scope source

Batch 10 is defined only as proposals:

- `PHASE4-BATCH8-COMPLETION-REPORT.md` §11 ("Batch 7 review follow-ups, plus the best-seller
  setting");
- `PHASE4-BATCH9-TECHNICAL-REVIEW-AND-IMPLEMENTATION-PLAN.md` §7;
- roadmap items IMP-01 … IMP-07.

Nothing outside these was added, and no new batch was invented.

## 2. Verification of each candidate item against current code (read only)

| Item   | Claim                                                                                    | Verified in code                                                                                                                                                                                                                                                                                                                                                                                                        | Verdict                                                             |
| ------ | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| IMP-01 | Registry wiring is untested: cursor carry-over and stop-signal hand-off (M-2)            | `src/jobs/registry.ts` keeps `reconciliationCursor` / `trackingCursor` between runs and passes `signal` to three jobs. The only registry test (`tests/unit/jobs/scheduler.test.ts` line 86) checks names and intervals. Cursor paging is tested only by calling the jobs directly                                                                                                                                       | **Confirmed gap**                                                   |
| IMP-02 | `best-seller-refresh` / `rating-aggregate` lack per-item error isolation                 | `src/jobs/catalogAggregates.ts` loops (lines 55, 89) have no per-item `try`; one failing product update aborts the rest of the run (the scheduler logs `job run failed`; the next run retries everything)                                                                                                                                                                                                               | **Confirmed**                                                       |
| IMP-03 | Reconciliation-level tests missing for stock-out late capture and cancelled-order refund | `paymentReconciliation.test.ts` covers the RD-10 cancelled path (`lateCaptured: 1`) but not the stock-out branch through reconciliation, and does not assert that the post-commit refund job runs (`refund` is stubbed "unused"). Stock-out is tested only at service level (`tests/unit/modules/payments/capture.test.ts`)                                                                                             | **Confirmed gap**                                                   |
| IMP-04 | OpenAPI content types wrong for file downloads                                           | `docs/openapi/openapi.json` documents `200 application/json` for five operations that send files: `POST /admin/audit-logs/export` (CSV), `POST /admin/barcodes/labels` (PDF), `GET /admin/orders/{orderId}/invoice` (PDF), `GET /me/orders/{orderNumber}/invoice` (PDF), `POST /admin/reports/{reportKey}/export` (CSV / XLSX / PDF on 200; JSON on 202). `GET /admin/report-exports/{exportId}` correctly returns JSON | **Confirmed (5 operations)**                                        |
| IMP-05 | Best-seller job ignores `catalog.best_seller_window_days`                                | The job uses the constant `BEST_SELLER_WINDOW_DAYS = 90` (`catalogAggregates.ts` line 23). The setting exists with validation `int(1, 730)` (`settings.values.ts` line 40) and seed value 90 (`settings.seed.ts`; seed **not executed**, G8)                                                                                                                                                                            | **Confirmed**                                                       |
| IMP-06 | Batch 8 mocked-test gaps                                                                 | Existing tests cover reactivation races, claim failure once / twice, and the 30-day / 90-day rules (`cartReactivation`, `cartTransactionalRace`, `abandonedCarts` tests). Master report §14 lists the remaining gaps: re-resolution that must **create** a new cart, the add-item retry path, and exact-boundary tests. To be confirmed test by test during implementation                                              | **Partially confirmed** (exact scope fixed at implementation start) |
| IMP-07 | Is promotion `EXPIRED` final?                                                            | Status is derived from dates (`promotions.rules.ts` line 73: `now ≥ endsAt → EXPIRED`), so changing `ends_at` could make an expired promotion active again. Whether that is allowed is a business rule                                                                                                                                                                                                                  | **Needs decision DEC-06**: excluded until decided                   |

## 3. Proposed work packages

| WP     | Item   | Change type                                                                         | Description                                                                                                                                                                                                         | Tests                                                                                  | Acceptance criteria                                                                         |
| ------ | ------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| WP10-1 | IMP-01 | **Tests only**                                                                      | Registry tests with the job modules mocked: (a) the reconciliation and tracking cursors returned by run N are passed into run N+1; (b) the scheduler's `AbortSignal` reaches the three long jobs                    | New `tests/unit/jobs/registryWiring.test.ts`                                           | Removing `signal` or the cursor carry-over from `registry.ts` makes a test fail; M-2 closed |
| WP10-2 | IMP-02 | Source (`catalogAggregates.ts`)                                                     | Wrap each product update in `try/catch`; log the product id and error; count `errors`; continue                                                                                                                     | Unit: one product update throws, the others still update; summary reports `errors: 1`  | One bad row no longer aborts the run; summary shape documented                              |
| WP10-3 | IMP-03 | **Tests only**                                                                      | Reconciliation-level tests: (a) a capture on a `PAYMENT_FAILED` order with no stock → order cancelled and the post-commit refund executed through the mock gateway; (b) a cancelled-order capture → refund executed | Extend `paymentReconciliation.test.ts`                                                 | Both paths asserted end-to-end (mocked), including the post-commit refund call              |
| WP10-4 | IMP-04 | Generator (`scripts/generate-openapi.ts`) + regenerated `docs/openapi/openapi.json` | Document the real `200` content types for the five download operations (and keep `202` JSON for queued report exports)                                                                                              | `tests/unit/scripts/openapi.test.ts` asserts the content types; `openapi:check` passes | No runtime behaviour change; contract matches the routes                                    |
| WP10-5 | IMP-05 | Source (`catalogAggregates.ts`)                                                     | Read `catalog.best_seller_window_days` (valid 1–730); fall back to 90 when missing or invalid (seed not executed yet)                                                                                               | Unit: honours a configured value; falls back to 90                                     | Window configurable; default behaviour unchanged                                            |
| WP10-6 | IMP-06 | **Tests only** (expected)                                                           | Fill the listed Batch 8 gaps                                                                                                                                                                                        | Cart integration tests (mocked DB)                                                     | Gaps covered. If a test reveals a defect: **stop and report**, do not fix silently          |

### Optional, if you include them (need explicit approval)

- **IMP-09 / audit L-1 and L-4 / R-16** (small, low risk):
  - catch a synchronous throw from `job.run()` in `scheduler.ts` and log it as a failed run (today it
    escapes as an uncaught exception and the worker exits 1);
  - update the stale scheduler comment (lines 6–8) and start-log wording.
- **Excluded:**
  - **IMP-07:** needs DEC-06.
  - **IMP-08 (M-1 recovery):** a business / security decision (DEC-05); not a Batch 10 candidate
    until decided.
  - **Also excluded:** schema changes (RD-03), MySQL work (Batch 12), external sandboxes (Phase 7),
    RD-11, RD-13 A, deferred items.

## 4. Impact assessment

| Dimension             | Assessment                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Existing code reuse   | All WPs extend existing modules and test kits (`mockDb`, `buildModuleTestApp`, mock gateway / courier)             |
| Database impact       | **None.** No schema, migration or seed change. WP10-5 reads an existing setting                                    |
| API impact            | WP10-4 changes the **documented** contract only (OpenAPI content types). No route or behaviour change              |
| Frontend / admin      | None (repositories not started)                                                                                    |
| Security              | Neutral. WP10-2 improves resilience; no auth, permission or data-exposure change                                   |
| Tests                 | 3 WPs are test-only; 2 add unit tests for small source changes; 1 adds generator tests                             |
| Rollback              | Plain code / test changes; reversible by reverting the files; no data or config to roll back                       |
| External dependencies | None                                                                                                               |
| Complexity and order  | Small to medium. Suggested order: WP10-1, WP10-3, WP10-6 (tests first) → WP10-2, WP10-5 → WP10-4 → optional IMP-09 |

## 5. Gates for Batch 10 (when authorized)

- `format:check`, `lint`, `typecheck`, `build`, `openapi:check`, `prisma validate` (offline), and the
  full Vitest suite with coverage (floors 80 / 80 / 80 / 75).
- No `.env*`, schema, migration, seed, package or Docker change.
- Implementation report, then an independent audit, then your acceptance (offline mocked scope).

## 6. Batches 11 and 12

- **Batch 11:** not defined in any authoritative document (roadmap DEC-19). Nothing is proposed here.
- **Batch 12:** MySQL verification (roadmap §10, DB-07 / DB-08). It depends on G2 → G3 → F5 → G7 → G8
  (user-executed, not authorized). Its technical review cannot be grounded until the baseline exists
  on a real database. It remains NOT STARTED.

## 7. Decision requested (DEC-04)

Approve, amend or reject:

- Batch 10 = WP10-1 … WP10-6;
- optionally + IMP-09.

Until then Batch 10 stays **NOT AUTHORIZED**.
