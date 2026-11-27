# Real-database concurrency tests (`tests/db`) — DEC-12

> ## NOT EXECUTED — requires explicit owner authorization (DEC-12)
>
> Nothing in this directory has ever been run against a database. The harness was prepared and
> checked **offline only** (formatting, lint, type check, unit tests with fake URLs and a fake
> client). The six scenarios are **unverified until the owner authorizes and runs them**.
> Do not run any command of section 4 before DEC-12 is decided and the prerequisites of
> section 2 are met. Agents never run these commands; the owner does, one step at a time.

| Item               | Value                                                                      |
| ------------------ | -------------------------------------------------------------------------- |
| Decision           | DEC-12 — "prepare, do not execute"                                         |
| Target database    | `ecommerce_test` only (never `ecommerce_dev`, never a production database) |
| Test cases         | TC-004, TC-030, TC-041, TC-045, TC-048, TC-051 (TESTING_STRATEGY §8, §16)  |
| Run command        | `npx vitest run --config tests/db/vitest.db.config.ts`                     |
| Part of `npm test` | No — the default suite cannot collect these files (see section 5)          |

**Update 2026-11-27 — DEC-12 is decided as an evidence requirement. Execution is still NOT authorized.** The header above is kept as written.

- **Decided (owner, received 2026-11-27):** real MySQL verification is required for G4. The six scenarios — TC-004, TC-030, TC-041, TC-045, TC-048 and TC-051 — must pass against `ecommerce_test` and produce reviewable evidence before G4 acceptance. Failures must be investigated, classified and resolved through separately authorized work.
- **Still not allowed:** running any command of section 4. The sentence above, "Do not run any command of section 4 before DEC-12 is decided", must now be read as: do not run any command of section 4 until the owner gives a separate explicit authorization to execute and the prerequisites of section 2 are met. DEC-12 does not give that authorization.
- **Not authorized by DEC-12:** creating `ecommerce_test`, applying the baseline, creating the test-only user, any grant, and any scenario run. Nor G2, G3, G7, G8 or seeds. Only the owner executes these steps.
- **Iteration count:** not decided. The default of `DB_TESTS_ITERATIONS` (3) and the testing-strategy values of 5 and 20 are not selected. A separate owner decision is needed before the scenarios are run.
- **Coupon code:** hardening is NOT AUTHORIZED. A passing or failing TC-041 result does not authorize a code change.
- **Not part of DEC-12:** GST-15 (no scenario exists here; separate owner decision required) and the proposed Batch 12 suite (open, not addressed).
- **G7 PASS (clarification 2026-11-27):** G7 PASS is a prerequisite before any of the six scenarios is executed. G7 PASS alone does not authorize scenario execution: a separate explicit written authorization from the owner is also required (section 2).
- **TC-041 (clarification 2026-11-27):** TC-041 is the real-database evidence scenario for requirement FR-CPN-008 and its acceptance criterion AC-03. It has not been executed. Coupon hardening remains NOT AUTHORIZED until the TC-041 evidence has been reviewed and a separate owner decision is made.

Nothing in this directory has been run. The scenarios are still PREPARED — NOT EXECUTED.

## 1. What is here

| Path                                           | Purpose                                                                                                                             |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `harness/guard.ts`                             | Pure, fail-closed guard. Decides from environment variables whether a run may start. No I/O.                                        |
| `harness/options.ts`                           | Pure parser of the optional iteration count.                                                                                        |
| `harness/client.ts`                            | The only place a Prisma client is constructed — from the guard-validated target, then `SELECT DATABASE()` must be `ecommerce_test`. |
| `harness/world.ts`                             | Guard → client → the real application container and the real Express app (all modules; mock payment / shipping / e-mail adapters).  |
| `harness/cleanup.ts` + `sql/cleanup.sql`       | Empties every application table of `ecommerce_test` with `DELETE` (children first). Allow-listed statements only.                   |
| `harness/fixtures.ts`                          | Test data (project seeds + one product / variant / shipping method / customers / carts / coupon). `example.test` addresses only.    |
| `harness/race.ts`                              | Barrier-started parallel execution, outcome tallies, `[DEC-12][TC-xxx] {…}` evidence lines.                                         |
| `harness/http.ts`, `harness/scenario.ts`       | Supertest helpers: real sign-in, quote, place order, verify payment, signed webhook; typed response readers.                        |
| `scenarios/tc-*.dbtest.ts`                     | The six scenarios.                                                                                                                  |
| `setup/globalGuard.ts`, `setup/workerGuard.ts` | Vitest global / per-file setup that abort the run unless the guard passes.                                                          |
| `sql/setup.sql`                                | Read-only preflight the owner runs with the test user (step 3).                                                                     |
| `vitest.db.config.ts`                          | Collects only `tests/db/**/*.dbtest.ts`; one fork; long timeouts; no `.env*` file is read.                                          |

Unit tests for all of the above run in the default suite: `tests/unit/dbHarness/*.test.ts`.

## 2. Prerequisites (all must be true before step 1)

- [ ] **DEC-12 authorized** by the owner, in writing, for this procedure. _(Clarification 2026-11-27: this item means a **separate written owner authorization to execute the six scenarios**. The DEC-12 decision of 2026-11-27 — real MySQL verification is required for G4 — does **not** satisfy it. As of 2026-11-27 no such authorization has been given, so this box stays unticked.)_
- [ ] **G2 PASS** — backup / restore drill accepted.
- [ ] **G3 PASS** — least-privilege migration identity accepted.
- [ ] **F5 READY** — readiness review accepted.
- [ ] **G7 PASS** — the baseline migration applied cleanly to the scratch database.
- [ ] Local MySQL 8.4 is running; default isolation level `REPEATABLE-READ`.
- [ ] An **empty** database named exactly `ecommerce_test`, created by the owner.
- [ ] The **baseline migration applied to `ecommerce_test` with the migration identity** (same
      command family as G7, target name hard-checked by `MIGRATION_EXPECTED_DATABASE`).
- [ ] A **test-only user** with `SELECT, INSERT, UPDATE, DELETE` on `` `ecommerce_test`.* `` and
      nothing else (no `DROP`, `ALTER`, `CREATE`, `GRANT`; nothing on `ecommerce_dev`; nothing on
      `*.*`). It must not be `root`, the runtime user or the migration user — the guard refuses
      those. It must be allowed at least 45 simultaneous connections (pool size 40).
- [ ] Node.js ≥ 22.13.0 and `npm ci` done; the default suite is green (`npm test`).

**Clarification 2026-11-27 — how to read this checklist.** Every item above is required; none replaces another. The procedure and its commands are unchanged.

- The first item is a separate written owner authorization to execute the six scenarios with this procedure. The DEC-12 decision of 2026-11-27 established only that real MySQL verification is required for G4. It is not that authorization.
- **G7 PASS** remains a prerequisite before scenario execution. G7 PASS alone does not authorize scenario execution.
- DEC-12 authorizes nothing in this checklist: not G2, G3 or G7, not the creation of `ecommerce_test`, not the baseline on it, not the test-only user, and not any scenario run. It also does not authorize G8, seeds or staging.

## 3. Environment variables (names only — never write values into a file in this repository)

| Variable                        | Required | Meaning                                                                                                                           |
| ------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `DB_TEST_DATABASE_URL`          | yes      | Connection URL of the test-only user for `ecommerce_test`. Dedicated variable: there is **no fallback** to `DATABASE_URL`.        |
| `DB_TESTS_CONFIRM`              | yes      | Second, explicit opt-in. Must be exactly `ecommerce_test`.                                                                        |
| `DB_TESTS_ALLOW_NON_LOCAL_HOST` | no       | Leave unset. Only if the server is not `localhost` / `127.0.0.1`: must equal the URL's host name exactly (per-host override).     |
| `DB_TESTS_ITERATIONS`           | no       | Repetitions per scenario, integer 1–50, default 3 (TESTING_STRATEGY §8: 5 for PR CI, ≥ 20 nightly). Anything else aborts the run. |

`DATABASE_URL`, `MIGRATION_DATABASE_URL` and `NODE_ENV` are **inspected, never used to connect**:
the run is refused when the test URL equals one of the two URLs, uses the same user name as one
of them, or when `NODE_ENV` is `production` / `staging`.

Set the variables **in the PowerShell session that runs the tests**. `vitest.db.config.ts` sets
`envDir: false`, so no `.env*` file is read for this suite, and none must be created for it.

## 4. Owner procedure — one step at a time

Stop after every step and have the output reviewed before the next one. Paste **only** the
output described under "Evidence"; never paste a connection URL or password.

All `npx` commands are run from the repository directory, opened with an upper-case drive letter
(`C:\…\ecommerce-api`).

### Step 1 — Create the empty database (privileged MySQL session, owner only)

```sql
CREATE DATABASE `ecommerce_test` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
SELECT COUNT(*) AS tables_in_ecommerce_test
FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'ecommerce_test';
```

Evidence: `tables_in_ecommerce_test = 0`. If the database already exists and is not empty: STOP.

Use the same `CREATE DATABASE` options that were approved for the G7 scratch database; the
statement above shows the options used for `ecommerce_dev`. Every baseline table declares its own
character set and collation, so the database default does not change the schema.

### Step 2 — Apply the baseline with the migration identity (owner only)

1. Privileged session — temporary scratch grant for the migration identity, exactly as for G7
   (`docs/INCREMENT-B-G3-MIGRATION-CONNECTION.md`), but on `` `ecommerce_test`.* ``.
2. Point the migration-only configuration at `ecommerce_test` (`MIGRATION_DATABASE_URL` and
   `MIGRATION_EXPECTED_DATABASE=ecommerce_test`, in the owner's git-ignored migration file).
3. Run, in this order, reviewing each output:

   ```powershell
   npm run db:migrate:status
   npm run db:migrate:deploy
   npm run db:migrate:status
   ```

4. Privileged session — revoke the scratch grant on `` `ecommerce_test`.* `` from the migration
   identity and restore the migration configuration to its previous target.

Evidence: the first status lists `20261117160425_baseline` as not applied; deploy applies exactly
that one migration; the second status reports the database schema is up to date.

### Step 3 — Create the test-only user and run the read-only preflight (owner only)

Privileged session (choose the password privately; it is never shared):

```sql
CREATE USER 'ecommerce_test_runner'@'localhost' IDENTIFIED BY '<chosen privately>';
GRANT SELECT, INSERT, UPDATE, DELETE ON `ecommerce_test`.* TO 'ecommerce_test_runner'@'localhost';
SHOW GRANTS FOR 'ecommerce_test_runner'@'localhost';
```

Then, **as the test user**, run the read-only preflight (it writes nothing and aborts with
ERROR 1242 when the current database is not exactly `ecommerce_test`):

```powershell
mysql --defaults-extra-file=<git-ignored option file of the test user> ecommerce_test -e "source tests/db/sql/setup.sql"
```

Evidence (redact the user name if desired): `current_database = ecommerce_test`; server `8.4.x`;
isolation `REPEATABLE-READ`; one applied migration `20261117160425_baseline`; `table_count = 68`;
grants = `USAGE` plus exactly `SELECT, INSERT, UPDATE, DELETE ON ecommerce_test.*`; the last
query returns no rows (all application tables empty).

### Step 4 — Prove the guard refuses (no variables set)

```powershell
Remove-Item Env:DB_TEST_DATABASE_URL, Env:DB_TESTS_CONFIRM -ErrorAction SilentlyContinue
npx vitest run --config tests/db/vitest.db.config.ts
```

Evidence: exit code 1 and
`DbTestGuardError: [DEC-12 guard] DB_TESTS_CONFIRM must be set to exactly "ecommerce_test". Refusing to run real-database tests.`
Vitest also prints `No test files found` in this case — that is how it reports a run aborted in
global setup; no test file was loaded and no connection was attempted.

### Step 5 — Set the variables for this session only

```powershell
$env:DB_TESTS_CONFIRM = 'ecommerce_test'
$secure = Read-Host 'Paste DB_TEST_DATABASE_URL (input is hidden)' -AsSecureString
$env:DB_TEST_DATABASE_URL = [System.Net.NetworkCredential]::new('', $secure).Password
Remove-Variable secure
```

Do not echo the variable. Evidence: none (nothing is printed).

### Step 6 — Run ONE scenario first

```powershell
npx vitest run --config tests/db/vitest.db.config.ts tests/db/scenarios/tc-030
```

Evidence: the line `[DEC-12] guard passed: database "ecommerce_test", loopback host: true, …`,
the `[DEC-12][HARNESS]` line, one `[DEC-12][TC-030] {…}` line per iteration and the vitest
summary. STOP here for review, whatever the result.

### Step 7 — Run the remaining scenarios, one command each

```powershell
npx vitest run --config tests/db/vitest.db.config.ts tests/db/scenarios/tc-048
npx vitest run --config tests/db/vitest.db.config.ts tests/db/scenarios/tc-051
npx vitest run --config tests/db/vitest.db.config.ts tests/db/scenarios/tc-041
npx vitest run --config tests/db/vitest.db.config.ts tests/db/scenarios/tc-045
npx vitest run --config tests/db/vitest.db.config.ts tests/db/scenarios/tc-004
```

Evidence after each command: its `[DEC-12][TC-xxx]` lines and the vitest summary.

### Step 8 — Full run (only after every single scenario was reviewed)

```powershell
npx vitest run --config tests/db/vitest.db.config.ts
```

Optionally repeat with `$env:DB_TESTS_ITERATIONS = '5'` (PR level) or `'20'` (nightly level).

### Step 9 — Close the session

```powershell
Remove-Item Env:DB_TEST_DATABASE_URL, Env:DB_TESTS_CONFIRM, Env:DB_TESTS_ITERATIONS -ErrorAction SilentlyContinue
```

Then follow section 8 (rollback).

**A failing assertion is a finding, not a harness problem to work around.** Do not weaken an
assertion, raise a retry count or re-run until green. Stop, keep the evidence lines, and report.

## 5. Safety controls

1. **File suffix.** Scenarios end in `.dbtest.ts`. The default configuration includes
   `tests/**/*.test.ts` only, so `npm test`, `npm run test:unit`, `npm run test:integration` and
   coverage runs never collect them (asserted by `tests/unit/dbHarness/isolation.test.ts`).
2. **Global guard.** `vitest.db.config.ts` runs `setup/globalGuard.ts` in the vitest main process
   before any worker starts. It imports only the pure guard, so a refusal happens before any
   database driver is even loaded.
3. **Per-file guard.** `setup/workerGuard.ts` repeats the guard in the worker before each
   scenario file is imported.
4. **Scenario guard.** Every scenario calls `assertDbTestGuard()` and then `openWorld()`, which
   runs the guard again before the client is built.
5. **Guard rules** (`harness/guard.ts`, all must pass): `NODE_ENV` not production-like;
   `DB_TESTS_CONFIRM = ecommerce_test`; URL only from `DB_TEST_DATABASE_URL`; not the runtime or
   migration credential; no `ecommerce_dev` / `ecommerce_prod` / `ecommerce_staging` /
   `ecommerce_live` / `production` anywhere in the URL (raw or percent-decoded, any case);
   `mysql:` / `mariadb:` only; database name **exactly** `ecommerce_test`; host `localhost` /
   `127.0.0.1` unless the per-host override names it; dedicated non-`root` user; valid port.
6. **Server-side check.** After connecting, `SELECT DATABASE()` must return `ecommerce_test`,
   otherwise the client is closed and the run aborts. The cleanup repeats the check, and
   `cleanup.sql` starts with a statement that fails unless the current database is
   `ecommerce_test`.
7. **DML only.** No `DROP`, `TRUNCATE`, `ALTER`, `CREATE`, `GRANT`. The cleanup file is parsed and
   every statement must match an allow-list; anything else refuses the whole file. `DELETE` is
   used instead of `TRUNCATE` (stricter than the DEC-12 proposal: the test user needs no `DROP`
   privilege).
8. **No secrets in output.** Guard errors name variables and rules only. Evidence lines carry
   counts, statuses, error codes, generated ids and document numbers — never URLs, user names,
   passwords or tokens. Token equality is asserted on booleans so a failure cannot print one.
9. **No `.env*`.** The suite reads no `.env*` file (`envDir: false`; `loadConfigFromProcess` is
   never called). The application configuration inside the harness is a fixed, secret-free
   record whose `DATABASE_URL` is a non-connectable placeholder.
10. **One fork, sequential files, no retries.** Scenarios never overlap on the shared database.

## 6. Scenarios and expected evidence

Each iteration starts from an emptied `ecommerce_test` and seeds its own data. `N` parallel
operations are released by one barrier.

| TC     | What runs in parallel                                                                                                         | Invariants asserted                                                                                                                                                                                                                            | Expected evidence line (per iteration)                                                                                                            |
| ------ | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-004 | (a) 5 × `refresh` of the same token, same user agent; (b) 3 × the rotated token after > 10 s; (c) 3 × from another user agent | (a) one rotation, one successor row, every success carries the same pair, losers get 401 only and receive the same pair on retry, family not revoked, no reuse audit. (b)(c) all refused, whole family revoked, `TOKEN_REUSE_DETECTED` audited | `[DEC-12][TC-004] {"case":"a-concurrent-replay","rotations":1,"familyRows":2,"reuseAudits":0,"sessionLive":true,…}`; (b)(c) `"sessionLive":false` |
| TC-030 | 10 × `POST /checkout/orders` for a variant with 1 unit                                                                        | exactly one 201; nine 409 `INSUFFICIENT_STOCK`; `on_hand = 1`, `reserved = 1`; one ACTIVE reservation; one RESERVATION ledger row; one order, one payment                                                                                      | `[DEC-12][TC-030] {"outcomes":{"201":1,"409:INSUFFICIENT_STOCK":9},"orders":1,"onHand":1,"reserved":1,…}`                                         |
| TC-041 | 10 × `POST /checkout/orders` with a coupon of `usage_limit` 1 (every iteration) and 3 (once)                                  | `used_count = limit` (never above); exactly `limit` live `coupon_usage` rows and orders; the rest 422 `COUPON_INVALID`; stock reserved only for the winners; coupon detached from refused carts                                                | `[DEC-12][TC-041] {"usageLimit":1,"outcomes":{"201":1,"422:COUPON_INVALID":9},"usedCount":1,"liveUsages":1,"orders":1,…}`                         |
| TC-045 | Per kind (INV, then CN): 10 issuances with no sequence row; then 10 issuances + 3 rolled-back allocations + 3 repeats         | numbers exactly `INV/<FY>/000001…000023` and `CN/<FY>/000001…000023`: distinct, consecutive, no gap; a rollback consumes no number; a repeat creates nothing; `next_value = 24`; cold-start refusals, if any, are `CONFLICT` only              | `[DEC-12][TC-045] {"kind":"INVOICE","first":"INV/2627/000001","last":"INV/2627/000023","documents":23,"nextValue":24,…}` (same for `CN/`)         |
| TC-048 | 5 × the same `POST /checkout/orders` with one Idempotency-Key                                                                 | one order; exactly one executed 201; the others 201-replayed (same order) or 409 `IDEMPOTENCY_CONFLICT` / `IN_PROGRESS`; one `idempotency_keys` row; later replay returns the same order; other body → 409 `PAYLOAD_MISMATCH`                  | `[DEC-12][TC-048] {"orders":1,"idempotencyRows":["COMPLETED"],"sequentialReplay":{"status":201,"replayed":true},…}`                               |
| TC-051 | `POST /payments/verify` and `POST /webhooks/payments/mock` for the same payment                                               | both 200; one CAPTURE row; one → CONFIRMED transition; reservation COMMITTED once; one ORDER_DEDUCTION (`on_hand` 5 → 4, `reserved` 0); one PAYMENT_SUCCEEDED per channel; duplicates and redeliveries change nothing                          | `[DEC-12][TC-051] {"verify":"200","webhook":"200","afterRace":{"captureRows":1,"orderDeductions":1,…},…}`                                         |

Concurrency levels: TC-004 5 / 3 / 3; TC-030 10; TC-041 10; TC-045 10 + 16 per kind; TC-048 5;
TC-051 2. `maxMs` in the evidence shows the slowest request of a burst.

Scope notes:

- TC-004 and TC-045 call the real services directly (session service; `issueInvoiceForOrder` /
  `issueCreditNote` inside `withTransaction`, as their production callers do). TC-030, TC-041,
  TC-048 and TC-051 go through HTTP against the real app.
- TC-045 issues documents for real COD orders; it does not drive the full "mark shipped" /
  "approve refund" admin flows.
- Payment, shipping and e-mail use the project's mock / fake adapters; no network call is made.
- Application time is real time plus an offset the scenario controls (TC-004 only).

## 7. Destructiveness

- **Destructive inside `ecommerce_test` only**: every iteration and the end of every scenario
  file delete all rows of all 67 application tables (`_prisma_migrations` is never touched) and
  insert fresh test data.
- Never run against a database whose data matters. The guard makes `ecommerce_dev` and
  production-named databases unreachable for this harness, but the owner remains responsible for
  the URL placed in `DB_TEST_DATABASE_URL`.
- No schema change, no `DROP DATABASE`, no user or grant management is performed by the harness.

## 8. Rollback / clean-up after the run (owner only)

1. Data: nothing to roll back — each scenario file leaves `ecommerce_test` empty. If a run was
   interrupted, empty it manually as the test user:

   ```powershell
   mysql --defaults-extra-file=<git-ignored option file of the test user> ecommerce_test -e "source tests/db/sql/cleanup.sql"
   ```

2. Session: remove the environment variables (step 9).
3. Privileged session, when the evidence is accepted:

   ```sql
   DROP USER 'ecommerce_test_runner'@'localhost';
   -- only if the database is no longer needed; the harness itself never drops anything:
   DROP DATABASE `ecommerce_test`;
   ```

4. Confirm the migration identity holds no grant on `` `ecommerce_test`.* `` and the migration
   configuration points at its previous target.

`ecommerce_dev` is not involved at any point, so it needs no rollback.

## 9. What was verified offline, and what was not

Verified without a database (default suite, `tests/unit/dbHarness`): every accept / refuse path
of the guard; that every entry point refuses before a client can exist; that the cleanup file
covers all 67 baseline tables in foreign-key order with DML only; the barrier helper; the
iteration parser; that the default suite cannot collect a scenario; and that the HTTP helpers
send requests the real routes accept (authentication, Idempotency-Key, strict bodies, signed
webhook) — against the real app on a fake in-memory client.

**Not verified**: any behaviour of the six scenarios on MySQL. Their fixtures, assertions and
timings have never run. Expect to review the first execution of each scenario (steps 6–7)
carefully; a red result may be a product defect or a harness mistake, and only the evidence can
tell which.
