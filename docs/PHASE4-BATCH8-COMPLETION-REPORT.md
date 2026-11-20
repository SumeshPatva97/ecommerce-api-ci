# Phase 4 — Batch 8 Completion Report: RD-08 Abandoned-Cart Lifecycle

| Field             | Value                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Document ID       | P4-BATCH8-01                                                                                                                               |
| Date              | 2026-11-20                                                                                                                                 |
| Authorization     | Batch 8 — RD-08 only (owner, 2026-11-20)                                                                                                   |
| Acceptance status | **ACCEPTED — OFFLINE MOCKED SCOPE ONLY** (owner, 2026-11-20, together with the M1 correction, see `PHASE4-BATCH8-M1-CORRECTION-REPORT.md`) |
| Validation level  | **Offline / mocked DB only**: no MySQL, no seed run, no external service                                                                   |

## 1. Objective

Implement RD-08 option B (approved 2026-11-20). ACTIVE carts idle for `cart.abandon_after_days` (30)
become ABANDONED. A returning customer without an ACTIVE cart gets their newest ABANDONED cart back
with its items. ABANDONED carts are purged 90 days after abandonment. One ACTIVE cart per customer is
preserved, ACTIVE carts are never deleted, and the job is safe to run repeatedly.

## 2. Scope

**In scope:** setting definition, cart reactivation, `abandoned-carts` job, registry entry, tests,
documentation.

**Out of scope (unchanged):**

- Checkout and order behaviour.
- The dedicated worker (Batch 9).
- Abandoned-cart reminders (OQ-62, out of v1).
- Schema, migrations and constraints.
- Environment files.

## 3. Pre-implementation findings (inspected code, not assumed)

| Question                                        | Finding (evidence)                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How are ACTIVE carts selected?                  | `findFirst where { userId, status: 'ACTIVE' }` (`cart.repository.ts`); every cart route resolves the cart through `loadCart` / `ensureCartId` (`cart.service.ts`).                                                                                                                                                                          |
| How are abandoned carts identified?             | Nothing marked carts ABANDONED before this batch. The schema already has `status = ABANDONED`, `abandoned_at` and index `ix_carts_abandon (status, last_activity_at)`.                                                                                                                                                                      |
| How are cart settings loaded?                   | Pattern `loadMaxQtyPerLine`: `setting.findUnique` with a validated fallback default. `cart.abandon_after_days` was not seeded.                                                                                                                                                                                                              |
| Can reactivation create duplicate ACTIVE carts? | **No, at database level.** The baseline migration has `active_owner_key` GENERATED AS `IF(status = 'ACTIVE', user_id, NULL)` and `UNIQUE INDEX uq_carts_active_owner`. A second ACTIVE cart is rejected (Prisma P2002). **No schema or constraint change is needed.**                                                                       |
| Concurrent reactivation of the same cart?       | Reactivation is a compare-and-set (`UPDATE … WHERE id AND status = 'ABANDONED'`). The loser updates 0 rows and re-reads the ACTIVE cart. _(M1 correction: this re-read is reliable only outside a transaction; the transactional paths now resolve before the transaction.)_                                                                |
| Do items and variants stay valid?               | Items are kept. Every cart read re-evaluates lines (unavailable flagged, quantity reduced, invalid coupon detached with a warning), so a reactivated cart is checked like any other. Hard-deleted variants cascade their cart items (existing FK).                                                                                          |
| Could a purge affect orders or checkout?        | **No.** Only `cart_items.cart_id` references `carts` (ON DELETE CASCADE). `carts.converted_order_id` points from cart to order. CONVERTED carts are never touched.                                                                                                                                                                          |
| Can the scheduler register the job?             | Yes: the existing registry and scheduler (overlap protection, error logging, off by default).                                                                                                                                                                                                                                               |
| Existing race in cart creation                  | `loadCart` / `ensureCartId` did find-then-create without handling P2002, so two first requests at once could fail one with 500. The new resolution handles P2002 by re-reading, which also covers this case. _(M1 correction: true for the non-transactional `GET /cart`; inside the add/merge transactions it was not, until the M1 fix.)_ |

## 4. Files

**Created:**

- `src/jobs/abandonedCarts.ts`
- `tests/unit/jobs/abandonedCarts.test.ts`
- `tests/integration/modules/cart/cartReactivation.test.ts`
- `docs/PHASE4-BATCH8-COMPLETION-REPORT.md` (this file)

**Modified:**

| File                                           | Change                                                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `src/modules/cart/cart.repository.ts`          | `findNewestAbandonedCartRef`, `reactivateCart` (compare-and-set)                                                                      |
| `src/modules/cart/cart.service.ts`             | Active-cart resolution: ACTIVE → reactivate newest ABANDONED → create; P2002 / lost compare-and-set → re-read; `loadAbandonAfterDays` |
| `src/modules/cart/cart.rules.ts`               | Constants: setting key, default 30, max 365, purge 90 days                                                                            |
| `src/modules/cart/index.ts`                    | Exports for the job                                                                                                                   |
| `src/modules/settings/settings.values.ts`      | Validation rule `cart.abandon_after_days`: integer 1–365                                                                              |
| `prisma/seed/settings.seed.ts`                 | Seed **definition** `cart.abandon_after_days = 30` (NUMBER, not public). **Not executed.**                                            |
| `src/jobs/registry.ts`                         | `abandoned-carts`: hourly, first run after 15 min                                                                                     |
| `src/jobs/README.md`                           | Job list; scheduler-in-API-process note                                                                                               |
| `docs/PHASE4-JOBS-AND-SCHEDULING.md`           | Coverage row, behaviour note, idempotency row, scheduler location                                                                     |
| `docs/PHASE4-REMAINING-DECISIONS.md`           | RD-08 status                                                                                                                          |
| `docs/PHASE3-PHASE4-MASTER-PROGRESS-REPORT.md` | §13, headline row, test totals                                                                                                        |
| `tests/unit/jobs/scheduler.test.ts`            | Registry list includes `abandoned-carts`                                                                                              |
| `tests/unit/modules/staff/seeds.test.ts`       | Seed value and validation-rule assertions                                                                                             |

## 5. Implementation details

**Cart resolution** (`cart.service.ts`; every cart route: view, add, update, remove, merge, coupon):

1. Use the ACTIVE cart if one exists.
2. Otherwise reactivate the newest ABANDONED cart, ordered by `abandoned_at DESC, last_activity_at
DESC, id DESC`. The update is a compare-and-set: `status = ABANDONED → ACTIVE`, `abandoned_at =
NULL`, `last_activity_at = now`. Then re-read the ACTIVE cart.
3. Otherwise create an empty cart.
4. If the compare-and-set loses (0 rows), or reactivate/create hits P2002 (another request already
   made an ACTIVE cart), re-read and use the winner's ACTIVE cart. Other errors propagate. If the
   winner is a different cart, the abandoned cart stays ABANDONED and remains recoverable later.

**Corrected after the independent verification (M1, see `PHASE4-BATCH8-M1-CORRECTION-REPORT.md`):**
the recovery in step 4 is reliable only **outside a transaction**, where each autocommit statement
sees the latest committed rows. That applies to `GET /cart` (`loadCart`) and `DELETE /cart/coupon`.
The original Batch 8 code ran the same resolution **inside** the `POST /cart/items` and
`POST /cart/merge` transactions. Under MySQL REPEATABLE READ, the re-read there uses the transaction's
snapshot and may not see the winner, so the request ended with 409 DUPLICATE_RESOURCE. The earlier
claim that a losing request always "re-reads and uses the winner" was therefore inaccurate for those
two paths. After the M1 fix they resolve the cart **before** the transaction and claim it with a
locking UPDATE as the transaction's first statement.

**Job** (`abandonedCarts.ts`, hourly):

- **Abandon:** `UPDATE … SET status = ABANDONED, abandoned_at = now WHERE id IN (batch) AND status =
ACTIVE AND last_activity_at < now − N days`, with N from the setting (default 30; invalid values
  fall back).
- **Purge:** `DELETE … WHERE id IN (batch) AND status = ABANDONED AND abandoned_at < now − 90 days`.
  Items go through the database cascade.
- Batches of 500, at most 20 per step per run.
- Re-running is a no-op.
- The DELETE requires ABANDONED, so ACTIVE carts are never deleted.

**Scheduler location:** the job uses the existing in-process scheduler (`JOBS_ENABLED`, off by default,
single process). **Until Batch 9 (dedicated worker, RD-12) is implemented and accepted, the scheduler
runs inside the API process.**

## 6. Tests and results (Node 24.12.0, mocked DB)

**New:**

- `abandonedCarts.test.ts` (7 tests), over an in-memory carts table that honours the job's conditions:
  - 31 days abandoned, 29.99 days kept, CONVERTED untouched;
  - purge at 91 days, kept at 89 days, ACTIVE and CONVERTED never deleted;
  - second run changes nothing;
  - compare-and-set skips a cart touched or reactivated between read and write;
  - setting 45 honoured, invalid value falls back to 30;
  - bounded batches continue on the next run;
  - static check of the baseline migration (cascade, only FK to `carts`, unique active-owner index).
- `cartReactivation.test.ts` (6 tests, through the real routes):
  - newest abandoned cart reactivated with items, no new cart;
  - lost compare-and-set uses the other request's cart;
  - P2002 on reactivation uses the winning ACTIVE cart, with no second cart;
  - P2002 on first-visit creation returns the winner;
  - `POST /cart/items` adds to the reactivated cart and keeps its items;
  - unrelated errors are not swallowed.

**Updated:**

- Seeds test: value 30, NUMBER, not public, group `cart`; rule rejects 0 and 366.
- Scheduler registry list.

**Full gates:**

| Check                                                                | Result                                                                 |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| format:check, lint, typecheck, build, openapi:check, prisma validate | PASS                                                                   |
| Tests                                                                | **101 files, 1,322 passed** (was 99 / 1,309)                           |
| Coverage                                                             | lines 93.29 %, statements 91.53 %, functions 93.91 %, branches 81.86 % |
| `abandonedCarts.ts`                                                  | 100 % lines                                                            |
| `cart.service.ts`                                                    | 97.67 % lines                                                          |

**What the mocks prove and cannot prove:**

- They prove the queries, compare-and-set conditions, cut-offs, re-run behaviour and the service's
  decisions after a lost race.
- They do **not** prove MySQL behaviour: the unique index raising P2002 under real concurrency,
  `UPDATE … WHERE` semantics under concurrency, or the cascade delete of `cart_items`. These belong in
  the planned MySQL integration suite (Batch 12), runnable only after G7/G8.
- **Correction (M1):** the original Batch 8 tests exercised lost-race recovery only on the
  non-transactional `GET /cart` path. The transactional paths were not covered, and the mocks cannot
  model REPEATABLE READ snapshots, which is why the defect was not caught. After the M1 fix, P2002 is
  no longer caught inside any transaction; 7 additional mocked tests cover the transactional paths
  (`cartTransactionalRace.test.ts`).
- **Gate results after M1:** 102 files, 1,329 tests PASS; all other gates PASS (see the M1 report).

## 7. Security considerations

- Reactivation is scoped to the authenticated customer (`userId` in every query), so no cart of
  another customer can be reactivated.
- No new endpoint, permission or input surface.
- Purging reduces retained personal data (DATABASE_DESIGN §20 / DPDP minimisation). The 90-day period
  is the approved RD-08 value.
- No audit row is written for system cart transitions; no audit category for carts exists in the
  approved audit catalogue. Noted, not changed.

## 8. Database impact

- **No Prisma schema change, no migration change, no constraint change** (verified: no file under
  `prisma/schema.prisma` or `prisma/migrations` changed).
- **Seed:** one new row in the seed definition. **The seed was not executed.** Running it waits for G8.
  Until seeded, the code uses the default of 30 days.
- No database connection or write was made.

## 9. External integration impact

None (no notifications; reminders are out of v1, OQ-62).

## 10. Known limitations

1. **Mock-only validation** (§6). MySQL concurrency guarantees are inferred from the schema, not tested.
2. **Checkout does not reactivate.** `POST /checkout/summary` / `orders` read only the ACTIVE cart
   (unchanged by restriction). A customer whose cart was abandoned and who goes straight to checkout
   without any cart call gets the existing "cart is empty" response; any cart call (the storefront
   loads the cart first) reactivates it.
3. **Viewing a cart does not count as activity.** `last_activity_at` changes only on cart writes and on
   reactivation, so a cart that is only viewed for 30 days is abandoned and then silently reactivated on
   the next view. Items are never lost before the 90-day purge.
4. **Canonical docs conflict (resolved 2026-11-20).** BACKEND_STRUCTURE §14 (24 h, delete empty carts)
   differed from RD-08 option B. With owner approval, the §14 `abandoned-carts` row now states the
   30-day / 90-day rules and reactivation (`PHASE4-BATCH8-DOCUMENTATION-SYNCHRONIZATION-REPORT.md`).
5. The scheduler runs inside the API process until Batch 9.
6. **Side finding (not changed):** a `catalog.best_seller_window_days` setting exists, but the Batch 5
   best-seller job hard-codes 90 days. Proposed for Batch 10.

## 11. Remaining work

Batch 9 (dedicated worker), Batch 10 (Batch 7 review follow-ups, plus the best-seller setting), Batch
11 (documentation sync, including the §14 conflict), Batch 12 (MySQL integration suite), the gate
track, and vendor integrations.

## 12. Confirmations

- No Prisma schema or migration changes.
- No database constraint changes.
- No seed executed; no database connection.
- No `.env`, `.env.example` or `.env.migration.example` modification (last writes 19:05:02, 17:37:18
  and 2026-11-18; all before this batch).
- No Git command.
- No new dependency.
- No checkout or order code changed.
- Batch 9 not started.

## 13. Acceptance status

**ACCEPTED — OFFLINE MOCKED SCOPE ONLY** (owner, 2026-11-20, including M1). It is not production-ready;
the MySQL / Prisma verifications in the M1 report §8 remain pending (Batch 12, after G7/G8). Phase 4
remains **IN PROGRESS — NOT APPROVED**.
