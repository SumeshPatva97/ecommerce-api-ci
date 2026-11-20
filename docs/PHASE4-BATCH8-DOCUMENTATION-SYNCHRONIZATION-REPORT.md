# Phase 4 — Batch 8 Acceptance: Documentation Synchronization Report

| Field         | Value                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| Document ID   | P4-BATCH8-DOCSYNC-01                                                                                   |
| Date          | 2026-11-20                                                                                             |
| Authorization | Owner, 2026-11-20: documentation-only synchronization after Batch 8 + M1 acceptance                    |
| Nature        | **Documentation only.** No code, test, schema, migration, seed, environment, database or Git operation |

## 1. Recorded decision

Batch 8 (RD-08 option B) and its M1 correction are **ACCEPTED — OFFLINE MOCKED SCOPE ONLY**.

- Recorded validation: **102 test files, 1,329 tests passed**; Node.js **24.12.0**.
- All tests and gates ran against mocked infrastructure.
- No MySQL, real payment gateway, real courier or production concurrency validation was performed.
- The seed definition for `cart.abandon_after_days` exists; the seed has **not** been executed.

## 2. Files modified

| #   | File                                                                                                    | Sections changed                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `ecommerce-api/docs/PHASE3-PHASE4-MASTER-PROGRESS-REPORT.md` (canonical master Phase 4 progress report) | §1 headline row "Batch 8"; §9 rows "vitest --coverage" and "Coverage"; §13 status sentence and the reactivation bullet; **new §14** "Batch 8 + M1 accepted — offline mocked scope only" |
| 2   | `project-documentation/04-backend/BACKEND_STRUCTURE.md`                                                 | §14 table, the `abandoned-carts` row only (line 598; byte-level check: no other line changed; LF endings preserved; no formatter run)                                                   |
| 3   | `ecommerce-api/docs/PHASE4-BATCH8-COMPLETION-REPORT.md`                                                 | Header "Acceptance status"; §10 limitation 4 (canonical-doc conflict now resolved); §13 acceptance status                                                                               |
| 4   | `ecommerce-api/docs/PHASE4-BATCH8-M1-CORRECTION-REPORT.md`                                              | Header "Batch 8 status"; §2 snapshot-timing sentence (now labelled reasoned, not verified); §3 dated note that the two previously "unchanged" documents are now synchronised            |
| 5   | `ecommerce-api/docs/PHASE4-BATCH8-DOCUMENTATION-SYNCHRONIZATION-REPORT.md`                              | **New** (this report)                                                                                                                                                                   |

Files 3 and 4 were changed only because real inconsistencies remained: both still said "COMPLETE — NOT YET
ACCEPTED". File 3 also still described the §14 conflict as open. File 4 stated a MySQL snapshot property
as fact, which the independent review had flagged as unverified.

## 3. Before and after

### `BACKEND_STRUCTURE.md` §14, `abandoned-carts` row

- **Before:** "`carts` `ACTIVE` with `updated_at` older than **24 h** (setting) → `ABANDONED` (**if no
  items: delete**). Customer reminder notification not in v1 unless approved." Safety column: OQ-62
  only.
- **After:**
  - Tagged "RD-08 option B — approved 2026-11-20; implemented and accepted for offline mocked scope
    only, Batch 8".
  - `ACTIVE` carts with `last_activity_at` older than `cart.abandon_after_days` (default **30**, valid
    1–365) → `ABANDONED` (`abandoned_at` = now).
  - `ABANDONED` carts purged **90 days after `abandoned_at`**; cart items deleted with their cart (ON
    DELETE CASCADE).
  - `ACTIVE` and `CONVERTED` carts never purged; empty carts not deleted early.
  - Reactivation by the cart service: newest `ABANDONED` cart, items kept, then normal
    availability/coupon checks.
  - Reminders still not in v1.
  - Safety column: compare-and-set UPDATE/DELETE; re-runs are no-ops; batches of 500; one ACTIVE
    cart per user via `uq_carts_active_owner`; "MySQL behaviour not yet verified (Batch 12)"; the OQ-62
    note is kept verbatim.

### Master progress report

| Item          | Before                                                                    | After                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Batch 8" row | COMPLETE — NOT YET ACCEPTED (§13)                                         | **ACCEPTED — OFFLINE MOCKED SCOPE ONLY** (§13–§14), including M1 and both reports                                                                                      |
| Tests row     | 101 files / 1 322                                                         | **102 files / 1 329** (pre-M1 101 / 1 322 kept for reference)                                                                                                          |
| Coverage row  | lines 93.29 % · statements 91.53 % · functions 93.91 % · branches 81.86 % | lines 93.32 % · statements 91.57 % · functions 93.98 % · branches 81.90 % (the recorded M1 run)                                                                        |
| §13           | Said "lost races re-read the winner"                                      | Marked as corrected: true outside transactions only; M1 fixed add/merge                                                                                                |
| §14 (new)     | —                                                                         | Acceptance record; lifecycle rules; M1 summary ("verified at code / control-flow level only"); the 7 pending MySQL / Prisma verifications; known limitations; statuses |

### Batch 8 reports

- Both status headers changed from COMPLETE — NOT YET ACCEPTED to **ACCEPTED — OFFLINE MOCKED SCOPE
  ONLY**.
- The completion report's §10 item 4 now records the §14 conflict as resolved.
- The M1 report's snapshot sentence is now labelled reasoned, not verified, conditional on Prisma
  emitting a single UPDATE.

## 4. Confirmation: the 24-hour conflict is resolved

The `abandoned-carts` row in BACKEND_STRUCTURE §14 no longer contains "24 h", `updated_at` or "if no
items: delete". A search of BACKEND_STRUCTURE.md for "24 h" now finds only line 509, which is the
idempotency-key TTL and is unrelated. The 30-day and 90-day rules agree across:

- **BACKEND_STRUCTURE §14:** 30 days, configurable; 90 days after `abandoned_at`.
- **DATABASE_DESIGN.md:** index note "ACTIVE carts idle > 30 days → ABANDONED"; §20 "90 days after
  ABANDONED".
- **USER_WORKFLOWS §9.3:** 30 days, `cart.abandon_after_days`.
- **Batch 8 reports and master report §13–§14.**

## 5. Confirmation: limitations are preserved

- **Pending MySQL / Prisma verification** (Batch 12, after G7/G8), in master report §14 and M1 report
  §8:
  1. SQL emitted by `updateMany`;
  2. REPEATABLE READ snapshot behaviour;
  3. real row locking;
  4. P2002 under concurrency;
  5. lock interactions with checkout and the abandonment job;
  6. cart-item cascade deletion;
  7. frequency of the second-attempt failure.
- **Known limitations** (master report §14, completion report §10):
  - checkout does not reactivate an abandoned cart by itself;
  - viewing a cart is not activity;
  - the pre-existing checkout/cart race is outside Batch 8 scope;
  - small mocked-test gaps remain tracked.
- **M1 presentation:** described as verified at code / control-flow level only. No document presents
  MySQL snapshot, locking or concurrency behaviour as proven.
- **Readiness:** no document describes Batch 8 as production-ready.

## 6. Scope compliance

- **No application source, tests, Prisma schema, migrations or seeds** were touched.
- **No migrations, seeds, database commands, MySQL or external services**, and no application test run.
- **No `.env`, `.env.example` or `.env.*`** read, printed or modified (metadata only, last write
  times unchanged: 19:05:02, 17:37:18, 2026-11-18).
- **No Git command of any kind.** The unexplained `.git/FETCH_HEAD` / `.git/objects` updates remain an
  external, unresolved incident, not investigated or attributed.
- No Batch 9 / Batch 10 work, no best-seller change, no dependency or infrastructure change.
- **No unrelated documentation changed.** BACKEND_STRUCTURE.md: one line only. Prettier was run only
  on the four `ecommerce-api/docs` files listed above (that folder is format-checked), never on
  `project-documentation`.

## 7. Remaining documentation inconsistencies (not changed: outside this authorization)

1. **DATABASE_DESIGN.md §20, retention table:** "Abandoned carts | 90 days after ABANDONED | **Weekly
   purge**". The accepted job purges **hourly**. The period matches; only the mechanism frequency
   differs.
2. **`ecommerce-api/docs/PHASE4-REMAINING-DECISIONS.md` RD-08:** still reads "Implemented in Batch 8
   … not yet accepted".
3. **`ecommerce-api/docs/PHASE4-JOBS-AND-SCHEDULING.md`:** the `abandoned-carts` row and note do not
   state the acceptance.
4. **`ecommerce-api/src/jobs/README.md`:** no acceptance status (informational only).

Items 1–3 need a separate documentation authorization if you want them aligned.

## 8. Statuses (preserved)

| Item                                                 | Status                               |
| ---------------------------------------------------- | ------------------------------------ |
| Phases 1–3                                           | APPROVED — COMPLETE                  |
| Phase 4                                              | IN PROGRESS — NOT APPROVED           |
| Batch 7                                              | ACCEPTED — OFFLINE MOCKED SCOPE ONLY |
| Batch 8 + M1                                         | ACCEPTED — OFFLINE MOCKED SCOPE ONLY |
| Batch 9 / Batch 10                                   | NOT YET AUTHORIZED                   |
| G2                                                   | USER EXECUTION PENDING               |
| G3                                                   | NOT ACCEPTED                         |
| G7 / G8                                              | NOT AUTHORIZED                       |
| Batch 12 (MySQL / external integration verification) | Pending required gate authorization  |
| Production readiness                                 | NOT ESTABLISHED                      |
