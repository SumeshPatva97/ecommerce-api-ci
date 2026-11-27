# Phase 4 Master — Agent 8: Database Test Harness Preparation

| Field       | Value                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------- |
| Document id | P4-MASTER-AGENT8                                                                                   |
| Date        | 2026-11-24                                                                                         |
| Status      | **RESTRICTED — PREPARE ONLY**                                                                      |
| Decision    | DEC-12 ("prepare, do not execute")                                                                 |
| Scope       | `tests/db/**`, `tests/unit/dbHarness/**`, this report. No other file was created or modified.      |
| Predecessor | Work started on 2026-11-21 by a previous agent and interrupted; inspected, kept and completed here |

> **NOT EXECUTED.** No database was contacted at any point. The six scenarios have never run and
> are **unverified until the owner authorizes DEC-12** and executes `tests/db/README.md`.

## 1. Result in one paragraph

The real-database harness for TC-004, TC-030, TC-041, TC-045, TC-048 and TC-051 is complete as a
prepared, non-executed package: a fail-closed guard, a guarded Prisma client, the real application
wired on that client, six scenario files (`*.dbtest.ts`), a dedicated vitest configuration, SQL
preflight / cleanup files and an owner procedure. The previous agent's eight files were kept; their
formatting and lint problems were fixed and the guard was tightened. Everything that can be checked
without a database is checked by 133 unit tests in the default suite, all passing. What cannot be
checked without a database — the scenarios themselves — is stated as unverified. Three behaviours
of the application that the scenarios may expose are listed in section 9 as **predictions from code
reading, not findings**.

## 2. File inventory

State before = as found on 2026-11-24, before any change. COMPLETE / PARTIAL / BROKEN describe the
file against what the task requires of it; hygiene (Prettier / ESLint) is shown separately.

| File                                                            | Before                                                                            | After                                                                          |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `tests/db/harness/guard.ts`                                     | COMPLETE for the six stated rules; Prettier FAIL                                  | COMPLETE — kept, three rules added (section 4), formatted                      |
| `tests/db/harness/client.ts`                                    | COMPLETE; Prettier FAIL                                                           | COMPLETE — formatting only                                                     |
| `tests/db/harness/cleanup.ts`                                   | COMPLETE (never checked against the schema)                                       | COMPLETE — unchanged; now verified offline against the baseline                |
| `tests/db/harness/fixtures.ts`                                  | PARTIAL — no auth-only customers; Prettier FAIL                                   | COMPLETE as code — `seedAccounts` added, formatted; behaviour unverified       |
| `tests/db/harness/race.ts`                                      | BROKEN for the lint gate (1 ESLint error, line 49); Prettier FAIL; logic complete | COMPLETE — error fixed, formatted, unit-tested                                 |
| `tests/db/sql/cleanup.sql`                                      | COMPLETE (order unverified)                                                       | COMPLETE — run instruction made PowerShell-compatible; order verified offline  |
| `tests/db/sql/setup.sql`                                        | COMPLETE (read-only preflight)                                                    | COMPLETE — run instruction made PowerShell-compatible                          |
| `tests/unit/dbHarness/guard.test.ts`                            | COMPLETE for the rules then present; Prettier FAIL; not run before modification   | COMPLETE — all original cases kept, new rules covered, passing                 |
| `tests/db/harness/options.ts`                                   | missing                                                                           | NEW — iteration count parser (pure)                                            |
| `tests/db/harness/world.ts`                                     | missing                                                                           | NEW — guard → client → real container + real app                               |
| `tests/db/harness/http.ts`                                      | missing                                                                           | NEW — supertest helpers and typed response readers                             |
| `tests/db/harness/scenario.ts`                                  | missing                                                                           | NEW — shared checkout preparation                                              |
| `tests/db/setup/globalGuard.ts`                                 | missing                                                                           | NEW — vitest global setup: aborts unless the guard passes                      |
| `tests/db/setup/workerGuard.ts`                                 | missing                                                                           | NEW — vitest per-file setup: repeats the guard                                 |
| `tests/db/vitest.db.config.ts`                                  | missing                                                                           | NEW — only `tests/db/**/*.dbtest.ts`, one fork, long timeouts, `envDir: false` |
| `tests/db/scenarios/tc-004-refresh-token-replay.dbtest.ts`      | missing                                                                           | NEW — unverified until DEC-12                                                  |
| `tests/db/scenarios/tc-030-last-unit-oversell.dbtest.ts`        | missing                                                                           | NEW — unverified until DEC-12                                                  |
| `tests/db/scenarios/tc-041-coupon-last-redemption.dbtest.ts`    | missing                                                                           | NEW — unverified until DEC-12                                                  |
| `tests/db/scenarios/tc-045-invoice-number-sequence.dbtest.ts`   | missing                                                                           | NEW — unverified until DEC-12                                                  |
| `tests/db/scenarios/tc-048-idempotency-key-replay.dbtest.ts`    | missing                                                                           | NEW — unverified until DEC-12                                                  |
| `tests/db/scenarios/tc-051-webhook-vs-verify-capture.dbtest.ts` | missing                                                                           | NEW — unverified until DEC-12                                                  |
| `tests/db/README.md`                                            | missing                                                                           | NEW — prerequisites, owner procedure, safety, evidence, rollback               |
| `tests/unit/dbHarness/options.test.ts`                          | missing                                                                           | NEW — 16 tests                                                                 |
| `tests/unit/dbHarness/race.test.ts`                             | missing                                                                           | NEW — 5 tests                                                                  |
| `tests/unit/dbHarness/cleanupPlan.test.ts`                      | missing                                                                           | NEW — 15 tests (cleanup vs baseline migration)                                 |
| `tests/unit/dbHarness/isolation.test.ts`                        | missing                                                                           | NEW — 15 tests (static isolation rules)                                        |
| `tests/unit/dbHarness/failClosed.test.ts`                       | missing                                                                           | NEW — 11 tests (every entry point refuses before a client exists)              |
| `tests/unit/dbHarness/httpPlumbing.test.ts`                     | missing                                                                           | NEW — 5 tests (helpers vs the real routes, fake client)                        |

State before, as measured:

```text
$ npx prettier --check tests/db tests/unit/dbHarness
[warn] tests/db/harness/client.ts
[warn] tests/db/harness/fixtures.ts
[warn] tests/db/harness/guard.ts
[warn] tests/db/harness/race.ts
[warn] tests/unit/dbHarness/guard.test.ts
[warn] Code style issues found in 5 files. Run Prettier with --write to fix.

$ npx eslint tests/db tests/unit/dbHarness --max-warnings 0
tests\db\harness\race.ts
  49:39  error  Template literal expression is unnecessary and can be simplified  @typescript-eslint/no-unnecessary-template-expression
✖ 1 problem (1 error, 0 warnings)

$ npx tsc --noEmit -p tsconfig.json
(no output, exit 0)
```

## 3. What changed

1. **Hygiene of the existing files.** Prettier applied to the five unformatted files; the ESLint
   error in `race.ts` fixed (`` `${error.name}` `` → `error.name`). No lint rule was disabled
   anywhere; there is no `eslint-disable` comment in the harness.
2. **Guard tightened** (section 4): production-like `NODE_ENV`, the migration credential,
   administrative / shared user names and two more forbidden database names are now refused.
3. **Missing pieces written**: world, HTTP helpers, options, the two vitest setup files, the DB
   vitest configuration, six scenarios, the README.
4. **Offline verification added** to the default suite (section 7), including a check of
   `cleanup.sql` against all 67 tables and all 115 foreign keys of the baseline migration, which
   confirmed the previous agent's deletion order without a correction.
5. `fixtures.ts`: added `seedAccounts` (customers without address or cart, for TC-004). The
   existing fixtures were not changed.

## 4. Guard rules (`tests/db/harness/guard.ts`)

Pure function `resolveDbTestTarget(env)`; no I/O, no `process.env` access of its own. All rules
must pass, in this order:

| #   | Rule                                                                                                                                                    | Origin   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 0   | `NODE_ENV` is not `production` / `staging`                                                                                                              | added    |
| 1   | `DB_TESTS_CONFIRM` is exactly `ecommerce_test` (second, explicit opt-in)                                                                                | kept     |
| 2   | URL comes only from `DB_TEST_DATABASE_URL`; no fallback to `DATABASE_URL`; must not equal `DATABASE_URL` or `MIGRATION_DATABASE_URL`                    | extended |
| 3   | URL (raw and percent-decoded, case-insensitive) contains none of `ecommerce_dev`, `ecommerce_prod`, `ecommerce_staging`, `ecommerce_live`, `production` | extended |
| 4   | Scheme is `mysql:` or `mariadb:`                                                                                                                        | kept     |
| 5   | Database name is EXACTLY `ecommerce_test` (case-sensitive, single path segment)                                                                         | kept     |
| 6   | Host is `localhost` / `127.0.0.1`, unless `DB_TESTS_ALLOW_NON_LOCAL_HOST` equals the host name exactly                                                  | kept     |
| 7   | A user name is present, is not `root`, and is not the user name of `DATABASE_URL` / `MIGRATION_DATABASE_URL`                                            | extended |
| 8   | Port, when given, is 1–65535                                                                                                                            | kept     |

Error messages name variables and rules only; they never contain the URL, user, password or host.
The resolved target keeps the password non-enumerable (never serialised or inspected). After
connecting, `client.ts` additionally requires the server to report `SELECT DATABASE()` =
`ecommerce_test`, and `cleanup.sql` begins with a statement that fails on any other database.

Environment variable names: `DB_TEST_DATABASE_URL`, `DB_TESTS_CONFIRM`,
`DB_TESTS_ALLOW_NON_LOCAL_HOST` (normally unset), `DB_TESTS_ITERATIONS` (optional, 1–50,
default 3; an invalid value aborts the run).

## 5. Scenarios

All files are under `tests/db/scenarios/`. Each calls `assertDbTestGuard()` and then `openWorld()`
in `beforeAll`. Each iteration starts with `world.reset()` (cleanup, then fresh seed) and each file
ends with `world.close()` (cleanup, disconnect). Setup and cleanup are DML only, inside
`ecommerce_test`: Prisma `create` / `createMany` / `upsert` for data, `tests/db/sql/cleanup.sql`
for removal. There is no `DROP`, `TRUNCATE`, `ALTER` or `CREATE` anywhere.

| TC     | Driven through                                                                       | Concurrency                                                                 | Setup (per iteration)                                                     | Invariant asserted                                                                                                                                                                                                                                                                      |
| ------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-004 | real session service (`refresh`), application clock = real time + offset             | (a) 5 parallel, same user agent; (b) 3 parallel after 11 s; (c) 3, other UA | one customer, one issued session                                          | (a) exactly one rotation and one successor row; every success carries the same successor pair; losers get 401 only and the same pair on retry; family not revoked; no reuse audit; session live. (b)(c) all refused; whole family revoked; `TOKEN_REUSE_DETECTED` audited; session dead |
| TC-030 | HTTP `POST /checkout/orders` on the real app                                         | 10 parallel customers                                                       | reference data; one variant with 1 unit; 10 customers with cart and quote | exactly one 201; nine 409 `INSUFFICIENT_STOCK`; `on_hand = 1`, `reserved = 1`; one ACTIVE reservation; one RESERVATION ledger row; one order; one payment                                                                                                                               |
| TC-041 | HTTP `POST /checkout/orders`                                                         | 10 parallel customers; limit 1 (every iteration) and limit 3 (once)         | as TC-030 with ample stock and one coupon on every cart                   | `used_count` equals the limit and never exceeds it; that many live `coupon_usage` rows and orders; the rest 422 `COUPON_INVALID`; stock reserved only for the winners; coupon detached from refused carts                                                                               |
| TC-045 | `issueInvoiceForOrder` / `issueCreditNote` in `withTransaction` (production options) | per kind: 10 parallel cold start, then 16 parallel (10 + 3 rollbacks + 3)   | 23 real COD orders placed through the checkout service                    | numbers exactly `INV/<FY>/000001…000023` and `CN/<FY>/000001…000023`: distinct, consecutive, no gap; a rolled-back allocation consumes no number; a repeated request creates nothing; `next_value = 24`; cold-start refusals, if any, are `CONFLICT` only                               |
| TC-048 | HTTP `POST /checkout/orders`, one Idempotency-Key                                    | 5 parallel identical requests                                               | one customer with cart and quote; stock 5                                 | one order; exactly one executed 201; the others 201-replayed with the same order or 409 `IN_PROGRESS`; one `idempotency_keys` row; later replay returns the same order; a different body is 409 `PAYLOAD_MISMATCH`                                                                      |
| TC-051 | HTTP `POST /payments/verify` and `POST /webhooks/payments/mock`                      | 2 parallel (order of scheduling alternates)                                 | one customer places a real ONLINE order                                   | both 200; one CAPTURE row; one transition to CONFIRMED; reservation COMMITTED once; one ORDER_DEDUCTION (`on_hand` 5 → 4, `reserved` 0); one PAYMENT_SUCCEEDED and one ORDER_CONFIRMED per channel; duplicate event and redelivery change nothing                                       |

Repetition: `DB_TESTS_ITERATIONS` (default 3; TESTING_STRATEGY §8 asks for 5 in PR CI and ≥ 20
nightly). Test timeouts scale with the iteration count.

## 6. Fail-closed evidence (no database involved)

Before the runs below, the presence of the variables in the agent's shell was checked by name
only; all were unset:

```text
DB_TEST_DATABASE_URL: unset
DB_TESTS_CONFIRM: unset
DB_TESTS_ALLOW_NON_LOCAL_HOST: unset
DB_TESTS_ITERATIONS: unset
DATABASE_URL: unset
MIGRATION_DATABASE_URL: unset
NODE_ENV: unset
```

### 6.1 The harness unit tests pass in the default suite

```text
$ npx vitest run tests/unit/dbHarness

 RUN  v4.1.12 C:/Users/sumes/OneDrive/Desktop/ecommerce-workspace/ecommerce-api

 Test Files  7 passed (7)
      Tests  133 passed (133)
   Duration  6.09s
```

The complete default suite, run once at the end, is also green (other agents were editing other
files at the same time, so this figure is a snapshot):

```text
$ npx vitest run

 Test Files  119 passed (119)
      Tests  3110 passed | 3 todo (3113)
   Duration  106.01s
```

### 6.2 The default configuration does not collect the scenarios

```text
$ npx vitest list tests/db
(no output, exit 0)

$ npx vitest run tests/db
No test files found, exiting with code 1
filter: tests/db
include: tests/**/*.test.ts
exclude:  **/node_modules/**, **/.git/**

$ npx vitest list --filesOnly | grep -c "dbtest"
0
```

`vitest list --filesOnly` under the default configuration lists test files; the only entries
related to this work are the seven files under `tests/unit/dbHarness/`.

### 6.3 The DB configuration finds the six scenarios but refuses to start

File discovery only (`--filesOnly` globs; no file is imported):

```text
$ npx vitest list --filesOnly --config tests/db/vitest.db.config.ts
tests/db/scenarios/tc-004-refresh-token-replay.dbtest.ts
tests/db/scenarios/tc-030-last-unit-oversell.dbtest.ts
tests/db/scenarios/tc-041-coupon-last-redemption.dbtest.ts
tests/db/scenarios/tc-045-invoice-number-sequence.dbtest.ts
tests/db/scenarios/tc-048-idempotency-key-replay.dbtest.ts
tests/db/scenarios/tc-051-webhook-vs-verify-capture.dbtest.ts
```

Run with no variable set (each variable also removed explicitly with `env -u`):

```text
$ npx vitest run --config tests/db/vitest.db.config.ts

 RUN  v4.1.12 C:/Users/sumes/OneDrive/Desktop/ecommerce-workspace/ecommerce-api

No test files found, exiting with code 1

include: tests/db/**/*.dbtest.ts
exclude:  **/node_modules/**, **/.git/**

⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯
DbTestGuardError: [DEC-12 guard] DB_TESTS_CONFIRM must be set to exactly "ecommerce_test". Refusing to run real-database tests.
 ❯ resolveDbTestTarget tests/db/harness/guard.ts:102:11
 ❯ Object.setup tests/db/setup/globalGuard.ts:13:18
 ❯ TestProject._initializeGlobalSetup node_modules/vitest/dist/chunks/cli-api.B0Pz1_R7.js:10813:50
 ❯ Vitest.initializeGlobalSetup node_modules/vitest/dist/chunks/cli-api.B0Pz1_R7.js:13812:35

exit code 1
```

Run with only the confirmation set and still no URL variable:

```text
$ DB_TESTS_CONFIRM=ecommerce_test npx vitest run --config tests/db/vitest.db.config.ts
DbTestGuardError: [DEC-12 guard] DB_TEST_DATABASE_URL is not set (there is no fallback to DATABASE_URL). Refusing to run real-database tests.
 ❯ resolveDbTestTarget tests/db/harness/guard.ts:110:11

exit code 1
```

Why no connection was possible in these runs:

- the guard threw inside vitest's global setup. In vitest 4.1.12 the run sequence is
  `await this.initializeGlobalSetup(specs)` and only then `this.pool.runTests(specs, …)`
  (`cli-api` chunk, lines 13655–13657), so no worker was started and no scenario file was
  imported. `No test files found` is how vitest summarises a run with zero executed files;
- `tests/db/setup/globalGuard.ts` imports only `guard.ts` and `options.ts`, and those two files
  import nothing. No Prisma client, driver or application module was loaded
  (asserted by `isolation.test.ts`);
- three further layers were not even reached: the per-file setup, `assertDbTestGuard()` in each
  scenario and the guard call at the top of `openWorld()`.

No run was made with any URL variable set, real or fake. The refuse paths that need a URL
(wrong database, remote host, shared user, …) are proven by the unit tests, where the module that
constructs the client is replaced by a mock.

## 7. What is verified offline (default suite, `tests/unit/dbHarness`)

| File                   | Tests | What it proves                                                                                                                                                                                                                       |
| ---------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `guard.test.ts`        | 66    | Every accept and refuse path of the guard with fake URLs; secrecy of messages and of the resolved target                                                                                                                             |
| `options.test.ts`      | 16    | Iteration count: default, accepted range, refusal of anything else                                                                                                                                                                   |
| `race.test.ts`         | 5     | Barrier releases all operations together; results keep call order; labels never include error messages                                                                                                                               |
| `cleanupPlan.test.ts`  | 15    | `cleanup.sql` passes the allow-list; names all 67 baseline tables exactly once; deletes every child before its parent for all 115 foreign keys; clears the two `RESTRICT` self-references; DDL, `USE`, `WHERE`, `INSERT` are refused |
| `isolation.test.ts`    | 15    | Default suite cannot collect a scenario; DB config collects only `*.dbtest.ts`, one fork, guard setups, `envDir: false`; only `client.ts` constructs a client; only `world.ts` and the setups read `process.env`; no DDL in any file |
| `failClosed.test.ts`   | 11    | `openWorld()`, the global setup and the per-file setup refuse before the (mocked) client factory is called; when the guard passes, the factory receives the validated target once and the real app is built                          |
| `httpPlumbing.test.ts` | 5     | The helpers' requests are accepted by the real routes on a fake in-memory client: bearer session, Idempotency-Key, strict request bodies, signed raw webhook; replay / conflict / mismatch readers                                   |

`httpPlumbing.test.ts` reduces, but does not remove, the risk in the HTTP-driven scenarios: it
shows that a request reaches the service layer, not what MySQL does afterwards.

## 8. Lint, format and type check

```text
$ npx prettier --check tests/db tests/unit/dbHarness
Checking formatting...
All matched files use Prettier code style!

$ npx eslint tests/db tests/unit/dbHarness --max-warnings 0
(no output, exit 0)        25 TypeScript files linted, 0 errors, 0 warnings

$ npx tsc --noEmit -p tsconfig.json
(no output, exit 0)        whole project, including tests/db/**/*.ts
```

How the repository tooling treats the harness file types (`eslint.config.js` read, behaviour
confirmed by running the tools):

| File type                                       | ESLint                                                                                                                                                 | Prettier                                                         | TypeScript                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------- |
| `*.dbtest.ts`                                   | Linted like any `tests/**/*.ts` file: strict type-checked rules, with the two test relaxations (`no-unsafe-member-access`, `no-unsafe-assignment` off) | checked                                                          | checked (`tsconfig` includes `tests/**`) |
| `vitest.db.config.ts`, harness and setup `*.ts` | same as above                                                                                                                                          | checked                                                          | checked                                  |
| `*.sql`                                         | Not linted. Passing a `.sql` file explicitly gives the warning "File ignored because no matching configuration was supplied"; a directory run skips it | Not checked in a directory run; an explicit file has "No parser" | n/a                                      |
| `*.md`                                          | Not linted (same warning when passed explicitly)                                                                                                       | checked — `tests/db/README.md` and this report pass              | n/a                                      |

## 9. Predictions from code reading (not findings — to be confirmed or dismissed at DEC-12)

These come from reading `src/**` while writing the scenarios. None was reproduced; no `src/` file
was changed. They are listed so that a red scenario is interpreted quickly.

1. **TC-041 may fail on the current code (coupon over-redemption).**
   `placeOrder` runs `computeQuote` (plain reads) before it takes any row lock, so under
   `REPEATABLE READ` the transaction's read view predates a competing commit. Later
   `coupons.reserveUsage` (`src/modules/coupons/coupons.service.ts`, about lines 408–445) locks
   the coupon with a raw `SELECT … FOR UPDATE` and then reads `used_count` and counts usages with
   ordinary Prisma reads. Ordinary reads use the old read view, so a losing transaction could
   still see `used_count = 0`, pass the limit check and increment. If that is what MySQL does, all
   ten orders succeed and `used_count` reaches 10. The stock check does not have this problem (it
   uses the values returned by the locking read itself). Confidence: moderate; the scenario
   decides.
2. **TC-004(a): a request that loses a simultaneous rotation is answered 401 first.** The session
   service rolls the loser back and relies on the client's retry, which then receives the same
   successor pair. CC-07(a) can be read as requiring the second parallel request itself to receive
   the pair. The scenario asserts what the code documents (401 only, no revocation, same pair on
   retry) and reports how many requests took each path.
3. **TC-045 cold start: `CONFLICT` on the first document of a financial year.** `allocateNumber`
   does `SELECT … FOR UPDATE` on a row that does not exist yet and then inserts it; several
   transactions doing this together can deadlock in InnoDB, and the production callers do not use
   `retryOnDeadlock`. Numbering stays gap-free either way. The scenario allows `CONFLICT` only in
   the cold-start phase and is strict afterwards. The same pattern applies to the first order
   number of each day.

## 10. Limitations

- **Nothing was executed against a database.** Fixture validity (required columns, generated
  columns, SQL-only unique indexes), assertion details, pool sizing and timings of the six
  scenarios are unverified until DEC-12. A first run may fail for a harness reason; the README
  asks the owner to run one scenario at a time for that reason.
- TC-004 and TC-045 call services directly, not HTTP. TC-045 issues documents for real COD orders
  but does not drive the "mark shipped" / "approve refund" admin flows.
- One process only. The scenarios do not cover two API processes (RK-09's two-process part) nor
  the in-memory grace-window store across instances (D-38).
- Payment, shipping and e-mail are the project's mock / fake adapters.
- The cleanup uses `DELETE`, not `TRUNCATE` as worded in the DEC-12 proposal — deliberately, so
  the test user needs no `DROP` privilege.
- The guard cannot prove what the server behind a URL is; it restricts names, hosts and users, and
  the client checks the server-reported database name. The owner remains responsible for the URL.
- The "not the migration user" rule only applies when `MIGRATION_DATABASE_URL` is present in the
  shell; the migration configuration normally loads it from its own git-ignored file.

## 11. Proposals outside this agent's files (not made)

| #   | Proposal                                                                                                                                                                            | File(s)                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | Optional npm script `"test:db": "vitest run --config tests/db/vitest.db.config.ts"`. Not required: the README uses the `npx` command                                                | `package.json`                                                  |
| 2   | Review `reserveUsage` (and the per-customer limit count) for the stale-read risk of section 9.1 before DEC-12, e.g. an atomic conditional `UPDATE … WHERE used_count < usage_limit` | `src/modules/coupons/coupons.service.ts`                        |
| 3   | Decide whether the 401-then-retry behaviour of section 9.2 satisfies CC-07(a), and align the wording of CC-07 / TC-004 or the code                                                  | `TESTING_STRATEGY.md` §8, `src/modules/auth/session.service.ts` |
| 4   | Decide whether cold-start `CONFLICT` (section 9.3) is acceptable, or pre-create sequence rows / retry on deadlock                                                                   | `src/core/db/sequences.ts` and callers                          |
| 5   | Replace "truncating tables" by "deleting rows (DML only)" in the DEC-12 text; add `DB_TESTS_ITERATIONS` and the guard variables to the decision record                              | `docs/PHASE4-CONSOLIDATED-DECISION-PACKAGE.md`                  |
| 6   | Keep the four `DB_TEST*` variables out of every CI job and out of `.env.example`; they belong to an owner session only                                                              | CI configuration                                                |

## 12. Confirmations

- No database connection was attempted. No MySQL client was started. No DDL or DML was run. No
  migration was run. The DB test bodies were never executed; the only runs of
  `tests/db/vitest.db.config.ts` were the two refusals in section 6.3 and one file listing.
- No `.env` or `.env.*` file was opened, read, searched, created or edited. Variable presence was
  checked by name only. No connection string was printed or logged. The only URLs in the harness
  tests are fake values written in the test files.
- No Git command was run and `.git` was not accessed.
- No network access was made. Supertest in the unit tests uses loopback HTTP sockets to the
  in-process app, as the existing integration tests do.
- Files created or modified: only `tests/db/**`, `tests/unit/dbHarness/**` and this report.
  Read-only use was made of `src/**`, `prisma/**`, `tests/helpers/**`, configuration files and
  project documentation.
