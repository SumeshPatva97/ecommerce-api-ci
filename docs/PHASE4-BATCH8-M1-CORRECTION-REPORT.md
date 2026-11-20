# Phase 4 — Batch 8 Correction M1: Transactional Lost-Race Recovery

| Field            | Value                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------- |
| Document ID      | P4-BATCH8-M1-01                                                                         |
| Date             | 2026-11-20                                                                              |
| Authorization    | Owner, 2026-11-20: "ONE narrowly scoped correction: M1"                                 |
| Batch 8 status   | **ACCEPTED — OFFLINE MOCKED SCOPE ONLY** (owner, 2026-11-20, including this correction) |
| Validation level | **Offline / mocked DB only**: no MySQL, no seed, no external service                    |

## 1. Defect (from the independent verification)

`POST /cart/items` (`addItem`) and `POST /cart/merge` (`merge`) resolved the customer's ACTIVE cart
**inside** their interactive transaction (`ensureCartId(tx, …)` as the first statement). Under MySQL's
default REPEATABLE READ, the transaction's snapshot is fixed at its first ordinary read. When a
concurrent request created or reactivated the customer's ACTIVE cart:

1. the reactivation compare-and-set (a current read) updated 0 rows, or the INSERT hit P2002 from
   `uq_carts_active_owner`;
2. the recovery **re-read was an ordinary snapshot read**, so it did not see the winner;
3. the code fell through to create, hit P2002 again, re-read nothing, and the error escaped;
4. the client got **409 DUPLICATE_RESOURCE**.

A realistic trigger is login, when the storefront calls `POST /cart/merge` and `GET /cart` together:
guest items were then not merged unless the client retried.

No duplicate ACTIVE cart and no item loss occurred; the database index prevents that.

## 2. Approaches evaluated

| Approach                                           | Pros                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Cons                                                                                                                                                                                                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Resolve before the transaction**              | Recovery runs in autocommit, where each statement sees the latest committed rows. No P2002 is ever caught inside a transaction, so nothing relies on Prisma continuing a transaction after a failed statement.                                                                                                                                                                                                                                                                        | Alone, it leaves a gap between resolution and the transaction: the cart could be converted by checkout or abandoned by the job in between, and items would go to a non-ACTIVE cart.                                                                   |
| **B. Locking/current read inside the transaction** | Atomic.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Still catches P2002 inside the transaction (Prisma continuation after a failed statement is unverified). Needs raw `SELECT … FOR UPDATE` for the re-reads. Later ordinary reads still use the snapshot, unless the first statement is a locking read. |
| **Chosen: A + a locking claim**                    | Resolution in autocommit (reliable recovery). The transaction's **first statement** is an `UPDATE carts SET last_activity_at = now WHERE id = :resolved AND user_id = :customer AND status = 'ACTIVE'`. An UPDATE is a MySQL **current read**: it sees the latest committed row and locks it until commit. If it matches 0 rows, the cart changed, so the transaction ends with nothing written and resolution runs once more; a second failure returns **409 CONFLICT** (retryable). | A cart created or reactivated during resolution stays committed even if the add/merge later fails. This is the same cart `GET /cart` would have produced, so it is harmless.                                                                          |

**Why the chosen approach best preserves the business rules:**

- **Transactional correctness.** No error is swallowed inside a transaction. Because the first
  statement is the locking claim, the snapshot for later reads is _expected_ to be taken **after**
  the lock is held, so item reads see the latest committed state. **Reasoned, not verified:** this
  holds only if Prisma sends `updateMany` to MySQL as a single `UPDATE` (see §8 risk 1).
- **Ownership.** The claim requires `user_id` to be the authenticated customer.
- **Item integrity.** The claimed cart row stays locked until commit, so checkout conversion or the
  abandonment job waits instead of racing the item writes. Concurrent add/merge requests of the same
  customer are serialised on the cart row.
- **Existing rules unchanged.** Same quantity caps, line limit, R-04 merge rule and warnings.
  `last_activity_at` is now set by the claim instead of a trailing update (same value).
- **No schema, constraint, migration or dependency change.** The claim uses Prisma `updateMany`.

## 3. Files changed

| File                                                           | Change                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/modules/cart/cart.repository.ts`                          | New `claimActiveCart(db, id, userId, now)`: conditional `updateMany`, returns `count === 1`                                                                                                                                                                                                                                                                                                     |
| `src/modules/cart/cart.service.ts`                             | New `withActiveCart` (resolve outside the transaction, claim first inside it, one retry, then 409 CONFLICT). `addItem` and `merge` use it (no more `ensureCartId(tx, …)`; the trailing `last_activity_at` update is replaced by the claim). `merge` resets its warnings per attempt. Corrected the resolution comment (transactional vs non-transactional recovery). `CART_CLAIM_ATTEMPTS = 2`. |
| `tests/integration/modules/cart/fixtures.ts`                   | `primeCart` answers the claim (`cart.updateMany` → `{ count: 1 }`); used by the cart and wishlist tests                                                                                                                                                                                                                                                                                         |
| `tests/integration/modules/cart/cartReactivation.test.ts`      | In-memory model answers the claim for the current ACTIVE cart                                                                                                                                                                                                                                                                                                                                   |
| `tests/integration/modules/cart/cartTransactionalRace.test.ts` | **New**, 7 tests (§5)                                                                                                                                                                                                                                                                                                                                                                           |
| `docs/PHASE4-BATCH8-COMPLETION-REPORT.md`                      | Inaccurate M1 statements corrected (§3 table, §5, §6, header)                                                                                                                                                                                                                                                                                                                                   |
| `docs/PHASE4-BATCH8-M1-CORRECTION-REPORT.md`                   | This report (new)                                                                                                                                                                                                                                                                                                                                                                               |

Unchanged:

- `BACKEND_STRUCTURE.md` §14 (needs separate approval).
- The master progress report (still shows the pre-M1 totals 101 / 1,322; it will be synchronised
  when you accept, so as not to widen M1 beyond its scope).

_Update 2026-11-20 (documentation synchronization after acceptance): both items above have since been
updated: §14 `abandoned-carts` row, and the master progress report §14 with 102 / 1,329. See
`PHASE4-BATCH8-DOCUMENTATION-SYNCHRONIZATION-REPORT.md`._

- Checkout, order, wishlist source, schema, migrations, seeds, `.env*`.

## 4. Behaviour before and after

| Situation                                                                            | Before                                                                           | After                                                                                                                                          |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /cart/items` while a concurrent request reactivates or creates the ACTIVE cart | 409 DUPLICATE_RESOURCE (on MySQL, by analysis)                                   | Item added to the winner's ACTIVE cart; 201                                                                                                    |
| `POST /cart/merge` in the same race (login flow)                                     | 409, guest items not merged                                                      | Guest items merged into the winner's cart; 200                                                                                                 |
| Cart converted or abandoned between resolution and write                             | Ordinary read in the transaction; items could go to a cart that had just changed | Claim matches 0 rows: rollback, resolve again; a second failure gives 409 CONFLICT with **nothing written** (the client keeps the guest items) |
| Unrelated database error during resolution or claim                                  | Propagated                                                                       | Propagated (no retry; a lock-wait timeout still maps to 409 CONFLICT through `withTransaction`)                                                |
| Normal add/merge without any race                                                    | One transaction                                                                  | One resolution (autocommit) + one transaction; same result and status codes                                                                    |

## 5. New tests (`cartTransactionalRace.test.ts`, MOCKED)

1. `addItem`, lost reactivation compare-and-set → item goes to the winner cart, no new cart, 201.
2. `addItem`, P2002 on first-visit create → item goes to the cart the concurrent request created;
   `cart.create` is called once (no duplicate ACTIVE cart).
3. `merge`, P2002 on reactivation → **every guest item** lands in the winner cart, no warnings.
4. Claim fails once (cart replaced after resolution) → re-resolved; items written only to the
   current cart; nothing written in the failed attempt.
5. Claim fails twice → **409 CONFLICT**, no item created or updated (guest items not silently lost).
6. The claim is the transaction's first statement (before variant and item reads and writes),
   scoped to `{ id, userId, status: 'ACTIVE' }`.
7. Unrelated errors (create: connection lost; claim: server gone away) propagate as 500, with no
   retry and no item writes.

**Limitations:** an in-memory model stands in for MySQL, and "concurrency" is simulated by changing
that model at the moment the losing statement runs. The tests prove the **service's control flow**.
They do **not** prove REPEATABLE READ snapshots, that an UPDATE is a current read that locks the row,
that MySQL raises P2002 from `uq_carts_active_owner`, or real concurrent timing.

## 6. Results (Node 24.12.0, `C:\Program Files\nodejs\node.exe`)

| Check                      | Result                                                                         |
| -------------------------- | ------------------------------------------------------------------------------ |
| format:check               | PASS                                                                           |
| lint (`--max-warnings 0`)  | PASS                                                                           |
| typecheck                  | PASS                                                                           |
| build                      | PASS                                                                           |
| openapi:check              | PASS (no route or status change)                                               |
| prisma validate            | PASS (no database connection)                                                  |
| Full test suite (mocked)   | **102 files, 1,329 tests PASS** (Batch 8: 101 / 1,322; +7 tests in 1 new file) |
| Coverage                   | lines 93.32 %, statements 91.57 %, functions 93.98 %, branches 81.90 %         |
| `cart.service.ts` coverage | 99.44 % lines                                                                  |

During development, one new test initially expected 500 for a "lock wait timeout" error; the
existing `withTransaction` maps lock-wait timeouts to 409 CONFLICT by design. The test input was
changed to a plain connection error, and that mapping is documented in the test.

## 7. Confirmations

- No MySQL connection, database command, migration or seed.
- No `.env`, `.env.example` or `.env.*` access or modification.
- No Git command, no external service, no new dependency or infrastructure.
- No checkout or order change; no Batch 9 or Batch 10 work; no change to `BACKEND_STRUCTURE.md`.

## 8. Remaining MySQL-only risks (for the integration suite after G7/G8)

1. That `UPDATE … WHERE id, user_id, status = 'ACTIVE'` as the first statement takes the row lock and
   sees the latest committed row under REPEATABLE READ, and that later reads see post-lock state.
2. P2002 from `uq_carts_active_owner` under real concurrent create/reactivate (resolution runs in
   autocommit, so the recovery re-read sees the winner).
3. Lock interaction with checkout conversion and the abandonment job (they now wait on the cart row).
   This adds no new lock order with inventory, so no new deadlock cycle is expected; to be verified.
4. The two-attempt limit under heavy contention (409 CONFLICT is returned and is retryable).
