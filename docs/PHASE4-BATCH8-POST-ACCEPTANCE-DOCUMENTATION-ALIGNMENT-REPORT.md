# Phase 4 — Batch 8 Post-Acceptance Documentation Alignment Report

| Field         | Value                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document ID   | P4-BATCH8-DOCALIGN-01                                                                                                                             |
| Date          | 2026-11-20                                                                                                                                        |
| Authorization | Owner, 2026-11-20: documentation-only alignment of the three inconsistencies listed in `PHASE4-BATCH8-DOCUMENTATION-SYNCHRONIZATION-REPORT.md` §7 |
| Nature        | **Documentation only.** No code, test, schema, migration, seed, environment, database or Git operation                                            |

## 1. Files modified

| #   | File                                                                                 | Section changed                                                                                                                    |
| --- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| A   | `project-documentation/05-database/DATABASE_DESIGN.md`                               | §20 Data retention, the row "Abandoned carts", **Mechanism column only** (one line; LF endings kept; no formatter run)             |
| B   | `ecommerce-api/docs/PHASE4-REMAINING-DECISIONS.md`                                   | RD-08: heading and status paragraph; new dated status-update paragraph. Conflict table and recommendation kept unchanged.          |
| C   | `ecommerce-api/docs/PHASE4-JOBS-AND-SCHEDULING.md`                                   | Header lines "Status" and "Updated"; §1 scheduler-location sentence; §2 `abandoned-carts` row; §3 `abandoned-carts (Batch 8)` note |
| —   | `ecommerce-api/docs/PHASE4-BATCH8-POST-ACCEPTANCE-DOCUMENTATION-ALIGNMENT-REPORT.md` | **New** (this report)                                                                                                              |

## 2. Before and after

**A. DATABASE_DESIGN.md §20**

|        | Retention                                 | Mechanism                                                                                             |
| ------ | ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Before | 90 days after `ABANDONED`                 | Weekly purge                                                                                          |
| After  | 90 days after `ABANDONED` (**unchanged**) | Hourly `abandoned-carts` job, batched (RD-08 option B, 2026-11-20; replaces the earlier weekly purge) |

No other retention row and no other §20 text was changed.

**B. PHASE4-REMAINING-DECISIONS.md, RD-08**

- **Before:**
  - Heading "Abandoned carts (documentation conflict; NOT implemented)".
  - Status "Implemented in Batch 8 (mocked tests only; not yet accepted)".
- **After:**
  - Heading "Abandoned carts (decided: option B; ACCEPTED — OFFLINE MOCKED SCOPE ONLY)".
  - The implementation summary is kept.
  - New dated paragraph: RD-08 option B and the M1 correction are both **ACCEPTED — OFFLINE MOCKED
    SCOPE ONLY**; MySQL / Prisma verification remains **pending Batch 12 after G7/G8**; not
    production-ready.
  - The original conflict table and recommendation are preserved as written.
  - No other RD entry was touched.

**C. PHASE4-JOBS-AND-SCHEDULING.md**

| Location     | Before                                                                                                               | After                                                                                                                                                                                                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status line  | "10 registered jobs (Batch 8 added `abandoned-carts`)"                                                               | Adds "Batch 8 + M1 accepted — offline mocked scope only, 2026-11-20"                                                                                                                                                                                                          |
| Updated line | batches 3–5, Batch 7                                                                                                 | Adds "Batch 8 abandoned carts + M1"                                                                                                                                                                                                                                           |
| §1 scheduler | "Until the dedicated worker (RD-12, Batch 9) is implemented and accepted, the scheduler runs inside the API process" | "The dedicated background worker (RD-12, Batch 9) is **NOT implemented** (Batch 9 not yet authorized), so the scheduler **currently runs inside the API process**"                                                                                                            |
| §2 row       | "ACTIVE idle > `cart.abandon_after_days` (30) … ABANDONED > 90 days → deleted"                                       | Hourly; default 30, valid 1–365; purged **90 days after `abandoned_at`**; ACTIVE / CONVERTED never purged; reactivation by the cart service; **accepted — offline mocked scope only**                                                                                         |
| §3 note      | "a request that loses a race re-reads the winner" (pre-M1, inaccurate)                                               | Re-read recovery is **outside a transaction**; add-item and merge resolve first, then claim with a status- and owner-constrained `updateMany` (M1). Acceptance recorded as offline mocked scope only. **MySQL concurrency and locking NOT verified** (Batch 12, after G7/G8). |

## 3. Confirmations

1. **Purge frequency:** DATABASE_DESIGN §20 now says hourly, matching the jobs doc (60-minute
   interval), BACKEND_STRUCTURE §14 ("hourly") and the registry.
2. **30-day / 90-day rules:** 30 days, configurable `cart.abandon_after_days` (1–365), and 90 days
   after `abandoned_at` are stated consistently in BACKEND_STRUCTURE §14, DATABASE_DESIGN (index
   note and §20), USER_WORKFLOWS §9.3, the jobs doc, RD-08, the master report §14 and the Batch 8
   reports.
3. **Acceptance scope:** RD-08 and M1 are recorded as accepted **only for offline mocked scope**,
   with Batch 12 MySQL / Prisma verification pending.
4. **Dedicated worker:** documented as **not implemented** (Batch 9 not yet authorized); the
   scheduler runs inside the API process.
5. **Readiness:** no production-readiness claim was introduced.
6. **Unrelated content:** no other decisions or statuses were changed.

## 4. Scope compliance

- Only the three authorized documents and this report were modified.
- No application source, tests, Prisma schema, migrations or seeds.
- No database commands, MySQL or external service, and no application test run.
- No `.env`, `.env.example` or `.env.*` access or change.
- No Git command.
- No Batch 9 / 10 work, no best-seller change, no dependency or infrastructure change.
- Prettier was run only on the `ecommerce-api/docs` files changed here (format-checked folder), never
  on `project-documentation`.

## 5. Remaining documentation inconsistencies (not changed: outside this authorization)

1. **DATABASE_DESIGN.md §20 closing sentence:** "Purge jobs run with small batches (`LIMIT 5000`) in
   off-peak IST hours". The `abandoned-carts` job purges in batches of 500 every hour, not only
   off-peak. This sentence covers all purge jobs, so it was left unchanged.
2. **RD-12 recording:** the owner's status list gives RD-12 as "single dedicated worker —
   multi-server deferred", but `PHASE4-REMAINING-DECISIONS.md` RD-12 still asks for a choice, and the
   jobs doc §5 still calls RD-12 undecided. Recording that decision needs separate authorization.
3. **`ecommerce-api/src/jobs/README.md`:** carries no acceptance status (informational; source tree,
   not authorized here).

## 6. Statuses (preserved)

| Item                 | Status                               |
| -------------------- | ------------------------------------ |
| Phases 1–3           | APPROVED — COMPLETE                  |
| Phase 4              | IN PROGRESS — NOT APPROVED           |
| Batch 7              | ACCEPTED — OFFLINE MOCKED SCOPE ONLY |
| Batch 8 + M1         | ACCEPTED — OFFLINE MOCKED SCOPE ONLY |
| Batch 9 / Batch 10   | NOT YET AUTHORIZED                   |
| G2                   | USER EXECUTION PENDING               |
| G3                   | NOT ACCEPTED                         |
| G7 / G8              | NOT AUTHORIZED                       |
| Batch 12             | Pending required gate authorization  |
| Production readiness | NOT ESTABLISHED                      |
