# Phase 4 — Batch 8 Final Documentation Consistency Report

| Field         | Value                                                                                                                 |
| ------------- | --------------------------------------------------------------------------------------------------------------------- |
| Document ID   | P4-BATCH8-DOCFINAL-01                                                                                                 |
| Date          | 2026-11-20                                                                                                            |
| Authorization | Owner, 2026-11-20: documentation-only correction of the DATABASE_DESIGN §20 purge-batch sentence                      |
| Nature        | **Documentation only.** No code, test, schema, migration, seed, configuration, environment, database or Git operation |

## 1. Inconsistency found

`project-documentation/05-database/DATABASE_DESIGN.md` §20 (Data retention), closing sentence
(line 2465):

> Purge jobs run with small batches (`LIMIT 5000`) in off-peak IST hours to avoid long locks and
> replication lag.

It is phrased for all purge jobs, so it implied that the `abandoned-carts` purge also uses 5,000-row
batches off-peak. The accepted Batch 8 job (documented in `PHASE4-JOBS-AND-SCHEDULING.md` §3 and
`BACKEND_STRUCTURE.md` §14) runs **hourly** and deletes in batches of **500** cart ids (at most 20
batches per run). The `LIMIT 5000` wording is still valid for the notification-log purge (§20 row
"Notification logs … LIMIT 5000 loop"), so it was kept.

## 2. Correction made

- **File:** `project-documentation/05-database/DATABASE_DESIGN.md`
- **Section:** §20 Data retention, closing sentence below the retention table (line 2465; the only
  changed line; LF line endings preserved; no formatter run on `project-documentation`).

**Before:**

> Purge jobs run with small batches (`LIMIT 5000`) in off-peak IST hours to avoid long locks and
> replication lag.

**After:**

> Purge jobs run with small batches (`LIMIT 5000`) in off-peak IST hours to avoid long locks and
> replication lag. **Exception — `abandoned-carts`** (RD-08 option B; accepted 2026-11-20 for
> offline mocked scope only): this job runs **hourly** and deletes in batches of **500** cart ids (at
> most 20 batches per run), 90 days after `abandoned_at`; it never deletes `ACTIVE` or `CONVERTED`
> carts.

The general sentence is unchanged for the other purge jobs; the abandoned-cart job is now explicitly
distinguished. No retention period and no other purge-job configuration was changed.

## 3. Files inspected and modified

**Inspected (read-only):**

- `project-documentation/05-database/DATABASE_DESIGN.md` (§20)
- `project-documentation/04-backend/BACKEND_STRUCTURE.md` (§14 rows `abandoned-carts`, `token-cleanup`)
- `ecommerce-api/docs/PHASE4-JOBS-AND-SCHEDULING.md`
- `ecommerce-api/docs/PHASE4-REMAINING-DECISIONS.md` (RD-08, RD-12)
- `ecommerce-api/docs/PHASE3-PHASE4-MASTER-PROGRESS-REPORT.md` (§13–§14)

**Modified:**

1. `project-documentation/05-database/DATABASE_DESIGN.md`: §20 closing sentence (one line).
2. `ecommerce-api/docs/PHASE4-BATCH8-FINAL-DOCUMENTATION-CONSISTENCY-REPORT.md`: **new** (this report).

## 4. Validation results

| Check                               | Result                                                                                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Abandoned-cart schedule             | **Hourly** in DATABASE_DESIGN §20 (table row and closing sentence), BACKEND_STRUCTURE §14, PHASE4-JOBS-AND-SCHEDULING (§2 row, 60-minute interval) |
| Abandoned-cart batch size           | **500** in DATABASE_DESIGN §20 (new exception), BACKEND_STRUCTURE §14 ("batched (500)"), PHASE4-JOBS-AND-SCHEDULING §3 ("500 ids, ≤ 20 batches")   |
| 30-day threshold / 90-day retention | Unchanged: `cart.abandon_after_days` default 30 (1–365); purge 90 days after `abandoned_at`                                                        |
| Outdated rules                      | No "Weekly purge", "24 h (setting)" or "if no items: delete" remains in DATABASE_DESIGN.md or BACKEND_STRUCTURE.md                                 |
| Acceptance scope                    | Batch 8 + M1 recorded as **ACCEPTED — OFFLINE MOCKED SCOPE ONLY** (PHASE4-REMAINING-DECISIONS RD-08, master report §14)                            |
| MySQL verification                  | Still pending Batch 12, after G7/G8 (jobs doc, RD-08, master report, BACKEND_STRUCTURE §14)                                                        |
| Unrelated files                     | None modified (see §6)                                                                                                                             |

## 5. RD-12 remains pending

RD-12 (scheduler / worker architecture) was **not** changed:

- `PHASE4-REMAINING-DECISIONS.md` RD-12 still ends "Answer needed from you: choose one before any
  multi-instance deployment".
- `PHASE4-JOBS-AND-SCHEDULING.md` §5 still reads "Rule until RD-12 is decided".

No document was edited to imply approval, decision or implementation. The dedicated worker remains
**not implemented**.

## 6. Scope compliance

- **Not touched:** application code, tests, Prisma schema, migrations, seeds, configuration,
  dependencies.
- **Not done:** no MySQL or external connection, no database command, no test run.
- **`.env` / `.env.*`:** not inspected, read, printed, copied or modified.
- **Git:** no command run; `.git` not investigated.
- **Not started:** Batch 9, Batch 10, the dedicated worker.
- **Formatting:** Prettier was run only on this report (the `ecommerce-api/docs` folder is
  format-checked), never on `project-documentation`.

## 7. Remaining known documentation issues (not changed: outside this authorization)

1. **`token-cleanup` batch size.** The same §20 sentence still implies `LIMIT 5000` for token purges,
   but BACKEND_STRUCTURE §14 (`token-cleanup`: "Batched deletes of 1 000 rows") and the
   implementation use 1,000-row batches. The implementation also runs daily from process start, not
   at an off-peak time. Not changed, because the task excluded other purge-job configurations.
2. **RD-12 decision recording.** The owner's status list describes RD-12 as "single dedicated worker —
   multi-server deferred", while the decisions document still lists it as open. Left as is, by
   explicit instruction, pending the owner's decision.
3. **`ecommerce-api/src/jobs/README.md`** carries no acceptance status (informational; source tree).

## 8. Status (unchanged)

Phase 4 **IN PROGRESS — NOT APPROVED** · Batch 8 + M1 **ACCEPTED — OFFLINE MOCKED SCOPE ONLY** ·
Batch 9 / Batch 10 **NOT YET AUTHORIZED** · MySQL / external integration verification **PENDING**
required gates · production readiness **NOT ESTABLISHED**. This report does not claim Phase 4
completion.
