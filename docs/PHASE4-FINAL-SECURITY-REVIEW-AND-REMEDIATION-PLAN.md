# Phase 4 — Final Security Review and Remediation Plan

| Field    | Value                                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Date     | 2026-11-24                                                                                                                                                                      |
| Nature   | Review and proposals of 2026-11-24. **Update, later the same day: the fix in §1 was authorized (D1) and implemented — see §1.9.** No other source change was made               |
| Evidence | Code reading on the current tree, plus the local mocked test run of 2026-11-24. No database, no network                                                                         |
| Status   | D1 is decided by the owner (PW-08 / A9-F02 classified S2, fix authorized). Nothing else here is approved. Other severities are recommendations; the owner / QA sets them (D-62) |

Not opened: any `.env*` file. Not used: Git, MySQL, external services.

Identifiers: this document uses the control IDs and finding IDs of
`operations/SECURITY_SELF_ASSESSMENT-G4-DRAFT.md` (for example PW-08, A9-F02). The labels
"SEC-F02", "SEC-F01" and "DB-P1 … DB-P3" in the 2026-11-24 master report are reference labels
written by that report for the same findings. They are not decision IDs.

## 1. Mock payment provider in production (control PW-08, finding A9-F02)

### 1.1 What the code does today (verified 2026-11-24)

| Step                | Fact                                                                                                                                                                                                | Where                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Provider selection  | `PAYMENT_PROVIDER` accepts only `mock`. There is no other implementation                                                                                                                            | `src/core/config/env.ts` line 139                                    |
| Start-up validation | The strict rules for `staging` / `production` cover keys, `https`, cookies, rate limiting and logs. None mentions the payment provider                                                              | `env.ts` `crossFieldProblems`, lines 227–256                         |
| Wiring              | The container always builds `MockPaymentProviderAdapter`. It passes only the webhook secret from configuration. The **client-signature secret is never configurable**                               | `src/container.ts` lines 138–144                                     |
| The secret          | `MOCK_PAYMENT_KEY_SECRET = 'mock-payment-key-test-secret'`, an exported constant in the source                                                                                                      | `src/integrations/payments/paymentProvider.ts` line 186              |
| Webhook endpoint    | Refuses the mock when `nodeEnv === 'production'` (404)                                                                                                                                              | `payments.service.ts` `handleWebhook`, lines 512–519                 |
| **Verify endpoint** | No environment check. It checks the client signature with the constant above, then asks the provider for the payment state                                                                          | `payments.service.ts` `verify`, lines 257–345                        |
| Mock payment state  | `fetchPayment` reports `CAPTURED` for any payment id that does not start with `mock_fail_` or `mock_pending_`, with the amount taken from the provider order id                                     | `paymentProvider.ts` lines 338–349                                   |
| Other mock uses     | Session creation (`initiate`), refunds, and the reconciliation job use the same provider object with no environment check                                                                           | `payments.session.ts`, `refunds.core.ts`, `paymentReconciliation.ts` |
| Existing tests      | No test starts the payments module with a production configuration. `tests/unit/core/env.test.ts` "accepts a valid production configuration" loads production **with the mock provider** and passes | `env.test.ts` lines 112–122                                          |
| Code comment        | "the mock is refused in production by the payments module" — true for the webhook only                                                                                                              | `paymentProvider.ts` line 184                                        |

### 1.2 Security impact

If the API were started with `NODE_ENV=production` today:

1. A signed-in customer places an online order and receives the provider order id in the response.
2. The customer computes the signature with the public constant and calls
   `POST /payments/verify` with any payment id.
3. The signature matches, the mock reports `CAPTURED` for the full amount, and the order is
   confirmed as paid. Stock is committed and the order moves to fulfilment.

No money moves. The result is goods shipped without payment, at will, by any account holder.

**Reachability.** Not reachable today: no production deployment exists, and no real provider
exists, so a production start could not take real payments at all. The risk is a future mistake: a
production environment brought up before Phase 7, or a real provider added while the mock stays
selectable.

**Staging.** The same path works in staging by design, because staging has only the mock gateway.
Staging holds test data, so this is accepted behaviour, but a staging URL must never be used to
take real orders.

### 1.3 Recommended severity

`TESTING_STRATEGY.md` §19 lists "payment captured without order" and "financial/legal error at
scale" under **S1** and "coupon over-redeems" under **S2**.

- **If a production deployment existed:** S1.
- **Recommended now: S2**, recorded as a release blocker for any production start. The defect is
  real in the code, but it cannot be triggered in any environment that exists.
- Under D-62 (G4 "P0 / P1" = S1 / S2), **either classification leaves G4 criterion 3 unmet until
  the fix is in**. I recommend fixing it before G4 rather than deferring it: the change is small
  and it should not depend on anyone remembering it in Phase 7.

This is a recommendation. The classification is yours.

### 1.4 Does the fix need both start-up validation and endpoint protection?

**Start-up refusal is required and is sufficient on its own** to close the hole: both processes
(API and worker) build their container through `createProcessRuntime` in `src/bootstrap.ts`, and
no other code path creates one.

**Endpoint protection on `verify` is recommended as a second layer**, for two reasons:

- the webhook handler already has exactly this check, so `verify` is the inconsistent one;
- it protects a container that is built some other way in future (a script, a new entrypoint).

Session creation, refunds and reconciliation need no check of their own: with the start-up refusal
no production process can hold the mock, and none of them uses the public secret to authenticate a
caller.

### 1.5 Proposed fix (not implemented — needs your authorization)

**Recommended: Option B.**

| Option | Start-up refusal placed in                                                                                                               | Existing tests that must change                                                                                                                                                      | Assessment                                                                                                                                                                                       |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A      | `env.ts` `crossFieldProblems`: production + `PAYMENT_PROVIDER=mock` is a configuration error                                             | Two: `env.test.ts` "accepts a valid production configuration" and `pipeline.test.ts` "adds HSTS (without preload) in production". Both load a production configuration with the mock | Earliest possible refusal, clean exit message. But no valid production configuration can then be expressed in tests until a real provider exists, so the production HSTS test needs a workaround |
| **B**  | `src/container.ts` `createContainer`: refuse when `config.nodeEnv === 'production'` and the resolved payment provider's `name` is `mock` | **None.** `buildTestApp` builds no container; module tests run with `NODE_ENV=test`                                                                                                  | Smallest change. Checks the provider object that will really be used, including an injected one                                                                                                  |

**Exact files and behaviour (Option B):**

1. `src/container.ts`
   - After the payment provider is resolved, if `config.nodeEnv === 'production'` and
     `provider.name === 'mock'`, throw an error whose message names the variable only:
     `PAYMENT_PROVIDER: the mock payment provider cannot run in production.`
   - No value, URL or secret appears in the message.
2. `src/bootstrap.ts`
   - `createProcessRuntime` lets that error stop the process: log one fatal line and exit with
     code 1, for the API and for the worker. (Today an exception there would end the process with
     a stack trace; the change only makes the exit clean.)
3. `src/modules/payments/payments.service.ts`
   - In the `gateway()` helper used by `verify`: when the provider is the mock and
     `config.nodeEnv === 'production'`, throw `SERVICE_UNAVAILABLE`. Nothing is written and no
     capture is attempted.
4. `src/integrations/payments/paymentProvider.ts`
   - Comment on line 184 corrected to say where the refusal happens. No behaviour change.

**Unchanged:** `development`, `test` and `staging` behave exactly as today. The mock adapter, its
test hooks and every existing test keep working. No dependency, schema, migration, seed or
`.env.example` change. No OpenAPI change (no new status code on a documented path beyond the
generic 503).

### 1.6 Regression tests (proposed)

| #   | Test                                                                                                                                                                                 | File                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| 1   | `createContainer` with a production configuration and no provider override throws, and the message names `PAYMENT_PROVIDER` only                                                     | `tests/unit/core/container.test.ts`                          |
| 2   | `createContainer` with `development`, `test` and `staging` configurations still returns the mock (`it.each`)                                                                         | same                                                         |
| 3   | `createContainer` in production with an injected non-mock provider succeeds (proves the rule tests the provider, not the environment)                                                | same                                                         |
| 4   | The thrown message contains no secret and no URL                                                                                                                                     | same                                                         |
| 5   | `POST /payments/verify` on a container forced to production + mock: 503, no `payment_transactions` row, order stays `PENDING_PAYMENT`, even with a correctly computed mock signature | `tests/integration/modules/payments/payments.routes.test.ts` |
| 6   | The same request in the normal test configuration still captures the payment (existing behaviour, asserted next to test 5)                                                           | same                                                         |
| 7   | `POST /webhooks/payments/mock` on a production + mock container: 404, nothing stored. This closes the existing test gap A9-F05 for the webhook refusal                               | same                                                         |
| 8   | Process start-up: `createProcessRuntime` with a production configuration exits with code 1 for both roles                                                                            | `tests/unit/workerRuntime.test.ts` or a new bootstrap test   |

**Mutation check to run with the change:** remove each new guard in a scratch copy and confirm that
test 1 (container) and test 5 (endpoint) fail.

**Gates afterwards:** `format:check`, `lint`, `typecheck`, `build`, `openapi:check`, full suite with
coverage.

### 1.7 Risks of the fix

| Risk                                                                                    | Handling                                                                                                                                                                         |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| After the fix, **no production process can start** until a real payment provider exists | Intended. It turns a silent risk into an explicit Phase 7 prerequisite. Document it in the runbook                                                                               |
| A production-like rehearsal before Phase 7 becomes impossible                           | Use `NODE_ENV=staging` for rehearsals; it has the same strict rules except this one and HSTS                                                                                     |
| Tests that build a production container in future                                       | They must inject a non-mock provider (test 3 shows how)                                                                                                                          |
| Scope creep to the other mock adapters (e-mail, WhatsApp, courier, media)               | Not included. They have no caller-authentication role. A production start is not functional with them either; propose a general "no mock provider in production" rule in Phase 7 |

### 1.8 Related finding: webhook secrets optional in staging (PW-07, A9-F01)

If `PAYMENT_WEBHOOK_SECRET` or `SHIPPING_WEBHOOK_SECRET` is unset in staging, webhooks are verified
with public test values. Recommended severity S3 (test data only). Smallest handling: keep it as a
pre-deployment checklist item (already in `CI-CD-AND-DEPLOYMENT-PREPARATION.md` §7.4). A schema
rule that requires both outside development is a separate, optional source change.

### 1.9 Implementation record (2026-11-24)

**Authorization (owner, 2026-11-24, D1 only):** "I classify PW-08 / A9-F02 as S2 and authorize the
fix in the security plan §1.5 Option B with the tests in §1.6."

**Scope check before editing.** The files and behaviour matched §1.5. No existing test builds a
production container, so nothing outside the plan had to change.

**Source changes (four files).**

| File                                           | Change                                                                                                                                                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/container.ts`                             | `createContainer` resolves the payment provider first and throws `ConfigError` when `nodeEnv` is `production` and the provider's `name` is `mock`. Message: `PAYMENT_PROVIDER: the mock payment provider cannot run in production.` An injected mock is refused too |
| `src/bootstrap.ts`                             | `createProcessRuntime` catches that `ConfigError`, logs one fatal line (variable names only) and exits with code 1. Other errors are re-thrown as before                                                                                                            |
| `src/modules/payments/payments.service.ts`     | `gateway()`, used by `verify`, throws `SERVICE_UNAVAILABLE` for the mock in production — the same rule the webhook handler already had                                                                                                                              |
| `src/integrations/payments/paymentProvider.ts` | Comment corrected. No behaviour change                                                                                                                                                                                                                              |

Not changed: `env.ts`, any schema, dependency, lockfile, OpenAPI file, seed or environment file.

**Security behaviour now.**

| Situation                                                                                                                                          | Result                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| API or worker started with `NODE_ENV=production` and the mock provider                                                                             | The process logs `start-up refused: invalid configuration` and exits with code 1. No server listens and no job runs                    |
| A container that holds the mock with a production configuration by some other route, `POST /payments/verify` with a correctly signed mock callback | 503 `SERVICE_UNAVAILABLE`. No transaction row, no stock movement, no status change, no notification; the order stays `PENDING_PAYMENT` |
| The same container, `POST /webhooks/payments/mock` with a correctly signed event                                                                   | 404. Nothing stored (existing rule, now tested)                                                                                        |
| `development`, `test`, `staging`                                                                                                                   | Unchanged. The mock works as before                                                                                                    |
| Production with a real (non-mock) provider                                                                                                         | Accepted. No such provider exists yet                                                                                                  |

**Consequence.** No production process can start until a real payment provider exists. Staging
still uses the mock and must never take real orders.

**Regression tests (§1.6) — all eight added, all pass.**

| #   | Test                                                                                                                                                                                                       | File                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | "production without a provider override: the container is not built; the error names PAYMENT_PROVIDER only"                                                                                                | `tests/unit/core/container.test.ts`                          |
| 2   | "%s still gets the mock payment provider" (development, test, staging)                                                                                                                                     | same                                                         |
| 3   | "production with an injected non-mock provider is accepted (the rule tests the provider)"                                                                                                                  | same                                                         |
| 4   | "the refusal message contains no secret, URL or configured value"                                                                                                                                          | same                                                         |
| 5   | "POST /payments/verify refuses a correctly signed mock callback: 503, nothing written, order unchanged"                                                                                                    | `tests/integration/modules/payments/payments.routes.test.ts` |
| 6   | "the same signed callback is still captured outside production (the mock stays usable in tests)"                                                                                                           | same                                                         |
| 7   | "POST /webhooks/payments/mock answers 404 for a correctly signed event and stores nothing"                                                                                                                 | same                                                         |
| 8   | "%s: production with the mock payment provider exits with code 1 and names the variable only" (api, worker), plus "%s: the runtime is created and the process is not stopped" (test, development, staging) | `tests/unit/bootstrap.test.ts` (new)                         |

Fourteen test cases in all. Tests 5 and 7 need a container that start-up now refuses, so they
assemble one by hand; it stands for a container built some other way.

**Mutation checks (scratch copies; the project source was not edited for them).**

| Variant                                          | Result                                                         |
| ------------------------------------------------ | -------------------------------------------------------------- |
| `container.ts` unchanged copy (control)          | 14 passed                                                      |
| `container.ts` without the start-up check        | 2 failed: tests 1 and 4 ("expected createContainer to refuse") |
| `bootstrap.ts` unchanged copy (control)          | 5 passed                                                       |
| `bootstrap.ts` without the catch-and-exit        | 2 failed: test 8 for api and worker                            |
| `payments.service.ts` unchanged copy (control)   | 26 passed                                                      |
| `payments.service.ts` without the `verify` guard | 1 failed: test 5, "expected 200 to be 503"                     |
| `payments.service.ts` without the webhook guard  | 1 failed: test 7, "expected 200 to be 404"                     |

The `verify`-guard result also confirms the original finding in a mocked test: without the guard, a
signed mock callback confirms the order.

**Gates after the change (local, Node 24.12.0, mocked database; not CI).**

| Check                                                 | Result                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| Focused tests (container, bootstrap, payments routes) | 3 files, 40 passed                                                              |
| `npm run typecheck`                                   | PASS                                                                            |
| `npm run lint`                                        | PASS (one type-import style error in the new test file was fixed first)         |
| `npm run format:check`                                | PASS                                                                            |
| `npm run build`                                       | PASS                                                                            |
| `npm run openapi:check`                               | PASS ("openapi.json is up to date")                                             |
| Full suite with coverage                              | **120 files, 3,124 passed, 3 todo, 0 failed** (before: 119 files, 3,110 passed) |
| Coverage                                              | Statements 92.11 %, branches 82.69 %, functions 94.74 %, lines 93.86 %          |

**Limits.** Mocked evidence only. No real process was started with a production configuration,
and no CI run exists. The other mock adapters (e-mail, WhatsApp, courier, media) are outside this
fix.

_(Clarification 2026-11-27: "no CI run exists" above is kept as written. Read it as: no CI run evidence is recorded in the reviewed project documentation. Whether a CI run happened was not checked.)_

**Not yet updated:** `operations/SECURITY_SELF_ASSESSMENT-G4-DRAFT.md` still lists PW-08 as a gap
and A9-F02 as open, and still counts 17 gaps and 71 tested controls. It was outside the D1
update list.

_(Update 2026-11-24: reconciled. The draft now shows PW-08 as TESTED, A9-F02 as fixed, 72 tested controls and 16 gaps. Record: `PHASE4-D1-POST-IMPLEMENTATION-DOCUMENTATION-RECONCILIATION-REPORT.md`.)_

## 2. Refund interrupted after commit (M-1, risk RK-04, control WK-08)

**Behaviour (verified in code).**

- A gateway refund is set to `PROCESSING` inside the transaction; the gateway call runs after the
  commit (`prepareGatewayRefund` / `executeGatewayRefund`, `refunds.core.ts`).
- Five code paths do this: worker late capture, staff approval, customer self-cancel, API late
  capture, admin retry of a failed refund.
- If the process stops between the commit and the call, the refund stays `PROCESSING`. `retry`
  accepts only `FAILED`. `complete` records a completion and never calls the gateway. No job
  re-checks such refunds.
- Two more cases leave the same state: the gateway refund succeeds but recording the result fails;
  and a retried refund can keep the provider refund id of the earlier failed attempt.
- In staff approval and self-cancel the customer's "refund initiated" message is queued before the
  gateway call.

**Documentation.** Consistent after the 2026-11-24 corrections: runbook §9 and §9.1 (manual
procedure, D-64), API_DOCUMENTATION §4.11, ADMIN_WORKFLOWS §11.1, jobs document §6a. No document
claims automatic recovery.

**Recommended severity: S3, with a written go-live condition.**

- The window is short and needs a process stop at the wrong moment.
- A manual procedure exists for two of the three outcomes (completed at the provider; pending).
- The third outcome — the provider confirms no refund was issued — has **no** recovery. A customer
  would be owed money with no system path to pay it. With real money this is an S2 condition.
- Phase 4 has only the mock gateway, so no real refund can be lost today.

**Recommended handling:**

| Choice                            | Assessment                                                                                                                                                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source fix now                    | **Not recommended.** A safe re-submission needs the real provider's idempotency and refund-lookup contract (OQ-06). You already ruled this out until verified (D-64)                                                         |
| Operational procedure only        | In place (runbook §9.1). Sufficient for Phase 4                                                                                                                                                                              |
| **Formal deferral (recommended)** | Record M-1 as S3 for G4 and defer the recovery action to the payment-provider integration (Phase 7), with the condition "no production payments until the recovery action exists and is tested against the provider sandbox" |

## 3. Coupon over-redemption under concurrency (prediction, not reproduced)

**Status: a prediction from code reading. It has not been reproduced. No database was contacted.**

**Sequence in the code:**

1. `checkout.service.ts` opens one transaction for `placeOrder` (line 491).
2. Inside it, `computeQuote(quoteDeps, tx, …)` prices the cart with ordinary reads (line 492). On
   MySQL's default isolation (REPEATABLE READ) the first ordinary read fixes the transaction's
   snapshot.
3. Later, `coupons.reserveUsage` locks the coupon row with
   `SELECT id FROM coupons WHERE id = ? FOR UPDATE` (`coupons.repository.ts` line 59).
4. It then reads the coupon and counts the customer's usages with **ordinary** Prisma reads
   (`coupons.service.ts` lines 411–433) and checks the limit in application code.
5. It increments `used_count` (line 440).

**The potential race.** Two orders, A and B, use a coupon with one redemption left.

- Both take their snapshot in step 2 and see `used_count = limit − 1`.
- A gets the lock, passes the check, increments and commits.
- B then gets the lock. Its ordinary reads in step 4 may still come from B's own older snapshot,
  so B also sees `limit − 1`, passes the check and increments. The coupon is then over-redeemed.

Whether step 4 sees A's commit depends on InnoDB's read-view rules, which a mocked client cannot
reproduce. Stock reservation does not share the pattern: its locking query returns the row values
themselves (`inventory.stock.ts` lines 123–129). Payment retry calls the same `reserveUsage`.

**What confirms or rejects it: scenario TC-041** (`tests/db/scenarios/tc-041-coupon-last-redemption.dbtest.ts`).

- Real MySQL 8.4, isolation REPEATABLE READ, database `ecommerce_test`.
- One fixed-amount coupon, `usage_limit = 1` (and one run with 3), `used_count = 0`, attached to
  the carts of 10 verified customers; enough stock for all.
- 10 parallel `POST /checkout/orders` released together.
- Pass: exactly `limit` orders with 201, the rest 422 `COUPON_INVALID`, `used_count = limit`,
  exactly `limit` live usage rows.
- Fail (prediction confirmed): more than `limit` successes, or `used_count > limit`.

**Recommended severity if reproduced: S2** ("coupon over-redeems" is the §19 example).

**Recommended handling:** run TC-041 early under DEC-12 and decide from evidence. If the real
database run will be delayed for long, a pre-emptive hardening is an option that is correct under
either outcome: replace the read-then-increment with one conditional update
(`… SET used_count = used_count + 1 WHERE id = ? AND (usage_limit IS NULL OR used_count < usage_limit)`)
and treat zero affected rows as "limit reached". That is a source change in
`coupons.service.ts` / `coupons.repository.ts` and is **not authorized**; the per-customer limit
would need the same care.

_(Clarification 2026-11-27 — the paragraph above is the 2026-11-24 recommendation and is kept as written. DEC-12 was decided by the owner on 2026-11-27: real MySQL verification of all six concurrency scenarios, including TC-041, is mandatory for G4. The words "If the real database run will be delayed for long, a pre-emptive hardening is an option" no longer describe an available route: coupon hardening is NOT AUTHORIZED, whether or not the run is delayed. Any consideration of coupon hardening requires review of the TC-041 evidence and a separate owner decision. TC-041 is the real-database evidence scenario for FR-CPN-008 / AC-03. It is PREPARED — NOT EXECUTED. G7 PASS is a prerequisite before execution, G7 PASS alone does not authorize execution, and a separate explicit written owner authorization is required.)_

## 4. Security self-assessment — owner review package

Source: `operations/SECURITY_SELF_ASSESSMENT-G4-DRAFT.md` (142 controls). It stays a **draft**
until you accept it. It is not a penetration test or a certification.

### 4.1 Verified and not verified

| Group                              | Result         | Controls | What it means                                                     |
| ---------------------------------- | -------------- | -------- | ----------------------------------------------------------------- |
| **Verified by test**               | TESTED         | 71       | A passing automated test exists. Every one uses a mocked database |
| **Verified by reading**            | CODE-VERIFIED  | 15       | Present in the code. No test                                      |
| Written down, behaviour not proven | DOCUMENTED     | 9        | A rule or procedure exists                                        |
| Ready, not executed                | PREPARED       | 4        | For example the database harness and the G2 guide                 |
| Cannot be assessed yet             | BLOCKED        | 14       | Needs a real database, a vendor, hosting or a schema change       |
| Waiting for you                    | USER-DEPENDENT | 12       | A decision or an execution only you can provide                   |
| **Not met**                        | GAP            | 17       | §4.2                                                              |

_(After D1, 2026-11-24: TESTED 72 and GAP 16; PW-08 moved from GAP to TESTED. The other counts are unchanged.)_

_(After the autonomous execution run, 2026-11-24, later: TESTED 74, CODE-VERIFIED 13, PREPARED 6, GAP 14. SH-03 and SH-04 are tested; SH-10 and CS-03 are prepared. 14 gaps remain open.)_

_(Clarification 2026-11-27: "GAP 14" is a draft count, not accepted (D11). It includes two reassessments not approved by the owner (SH-10 and CS-03, from GAP to PREPARED); without them the count is 16.)_

Limits of this review: the 142 rows were assessed by the security workstream on 2026-11-24, which
ran 58 test files (2,152 tests). In this closure review I re-checked in code the rows that carry
the most weight: PW-07, PW-08, SH-09, the courier-webhook production refusal, and the strict
environment rules. I did not re-check every row. Backup / restore and CI have no tested control,
because nothing in those areas has been executed.

**What "blocks G4" means below.** G4 criterion 4 asks for the self-assessment to be complete; it
does not ask for every control to be met. A gap blocks G4 only if it is an open S1 / S2 defect
(criterion 3) or leaves a "Must" requirement unmet without an approved deferral (criterion 2).

### 4.2 The 17 gaps (16 after D1: PW-08 is resolved)

| Control | Current evidence                                                                                          | Gap                                                                    | Recommended severity                  | Recommended remediation                                                               | Blocks G4?                                                 | Needs from the owner / external                                                                                                                                                                                     |
| ------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PW-08   | `container.ts` `createContainer`; `bootstrap.ts`; `payments.service.ts` `gateway()`; 14 test cases (§1.9) | Mock payment provider not refused in production — **fixed 2026-11-24** | S2 (owner classification, 2026-11-24) | Done (§1.9). Phase 7: add a real provider                                             | **No longer.** Fixed and tested (mocked)                   | Nothing further for the fix                                                                                                                                                                                         |
| PW-07   | `env.ts` 140, 143: both webhook secrets optional                                                          | Public test secrets used in staging when unset                         | S3                                    | Checklist item now; optional schema rule                                              | No                                                         | Decide checklist-only or schema rule                                                                                                                                                                                |
| SH-09   | `env.ts` 122: `PASSWORD_PEPPER` optional; no minimum length for peppers                                   | A pepper added after accounts exist invalidates their hashes           | S3                                    | Decide the pepper policy before the first real accounts; optional schema rule         | No                                                         | Policy decision                                                                                                                                                                                                     |
| SH-10   | `Dockerfile` (read, never built): no `.dockerignore`, `COPY . .` in the build stage                       | A local `.env*` file could enter the build stage                       | S3 (scaffold, never used)             | Add `.dockerignore`; correct the Dockerfile before it is first used                   | No                                                         | Authorization when containers are chosen (DEC-08) _(Update 2026-11-24, later: a `.dockerignore` was added and the control was reassessed GAP → PREPARED. Never validated by a build; the Dockerfile is unchanged.)_ |
| AA-11   | `env.ts` 131: `CAPTCHA_PROVIDER` accepts only `none`                                                      | No CAPTCHA (FR-AUTH-007, part)                                         | S3 (rate limits and lockout exist)    | Defer to the vendor decision (proposed deferral DEF-A4)                               | **Yes, until DEF-A4 is approved** (criterion 2)            | Deferral approval; vendor (OQ-71)                                                                                                                                                                                   |
| AA-12   | Offline common-password list (`password.ts`)                                                              | No external breached-password check (FR-AUTH-010, part)                | S3                                    | Defer (proposed deferral DEF-A5)                                                      | **Yes, until DEF-A5 is approved** (criterion 2)            | Deferral approval                                                                                                                                                                                                   |
| AA-13   | `password.service.ts` header: no history column in the approved schema                                    | Staff password reuse not prevented                                     | S3                                    | Needs a schema change; decide with the next schema proposal                           | No (no "Must" requirement was traced to it in this review) | Decision; schema approval                                                                                                                                                                                           |
| RL-05   | `RateLimiterMemory` only                                                                                  | Rate limits are per instance and reset on restart                      | S3 with one API instance              | Run one API instance (documented); shared store with the Redis decision (D-38)        | No                                                         | Accept the single-instance rule until D-38 / OQ-35                                                                                                                                                                  |
| FU-05   | No server-side size / type / count check on uploads                                                       | Upload limits rely on the signed-upload parameters (FR-PV-012, part)   | S3                                    | Defer (proposed deferral DEF-B3); verify with Cloudinary (EXT-04)                     | **Yes, until DEF-B3 is approved** (criterion 2)            | Deferral approval; Cloudinary verification                                                                                                                                                                          |
| DP-10   | `anonymizedAt` is only read; no code sets it                                                              | No customer erasure / anonymisation workflow                           | Not classified here                   | Obtain the legal position first; then decide scope                                    | No for G4; a go-live condition                             | Legal review; retention decision (RD-11)                                                                                                                                                                            |
| DP-11   | Not produced                                                                                              | No field-by-field personal-data classification                         | Documentation gap                     | Produce it with the retention decision                                                | No                                                         | RD-11, OQ-38                                                                                                                                                                                                        |
| WK-09   | `notifications.dispatcher.ts`: no reclaim of `SENDING` rows; runbook §10                                  | A stopped worker can strand notifications; no procedure                | S3 (RK-03)                            | Write a manual procedure, or authorize a reclaim rule with a test                     | No, if acknowledged with Batch 9                           | Acknowledge RK-03; authorize one of the two                                                                                                                                                                         |
| WK-10   | Heartbeat log line only                                                                                   | No worker liveness check                                               | S3 (RK-11, deferred)                  | With hosting: alert on a missing heartbeat, or add a health endpoint                  | No                                                         | DEC-08                                                                                                                                                                                                              |
| BR-05   | None; G2 drill not completed                                                                              | No automated backups, RPO / RTO or point-in-time recovery              | Go-live condition                     | Define with hosting; complete G2 first                                                | No for G4 (staging is a deliverable, not a criterion)      | G2 execution; DEC-08                                                                                                                                                                                                |
| LM-05   | Structured logs only                                                                                      | No metrics, alerting or error monitoring                               | Go-live condition; S3                 | Choose tooling with hosting; alert on failed jobs, stuck refunds, stuck notifications | No                                                         | DEC-08                                                                                                                                                                                                              |
| CS-03   | CI runs `npm test`, not the coverage run                                                                  | Coverage floors enforced only locally                                  | S4                                    | Switch the CI step to `npm run test:coverage`                                         | No                                                         | Authorization to edit `ci.yml` _(Update 2026-11-24, later: done — the CI test step runs `npm run test:coverage`; reassessed GAP → PREPARED. Not observed in CI.)_                                                   |
| CS-04   | No audit, SAST or secret-scan step; last `npm audit` record 2026-11-19, not re-run                        | Dependency and secret risks not checked automatically                  | S3                                    | Run `npm audit` now (owner); add the steps to CI                                      | No                                                         | Run `npm audit`; authorization to edit `ci.yml`                                                                                                                                                                     |

### 4.3 Other findings of the security workstream

| Finding | Summary                                                         | Recommended severity | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------- | --------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A9-F05  | Missing tests for some strict-environment rules                 | S4                   | **Correction:** tests do exist for `https`, rate limiting and plain logs in production and staging (`env.test.ts` line 96). Missing: required secrets, `COOKIE_SECURE`, and the webhook production refusal. The master report said "no tests for the strict-environment rules", which was too broad. _(Update 2026-11-24: the webhook production refusal is now tested — §1.9, test 7. Required secrets and `COOKIE_SECURE` remain untested.)_ _(Update 2026-11-24, later: both are now tested in `tests/unit/core/env.test.ts`. A9-F05 has no remaining item.)_ |
| A9-F06  | One literal `$queryRawUnsafe('SELECT 1')` in the readiness ping | S4                   | Constant string, no input. Accept, or change one line                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| A9-F07  | HSTS only in production                                         | S4                   | Decide whether staging should send it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

### 4.4 P0 / P1 position (D-62: P0 / P1 = S1 / S2)

| Item                                    | Position                                                                                           |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Confirmed S1 / S2 defects               | None confirmed by a test                                                                           |
| PW-08 / A9-F02                          | Classified S2 by the owner on 2026-11-24 and **fixed the same day** (§1.9). No longer an open P1   |
| M-1                                     | Recommended S3 with a formal deferral and a go-live condition. **Your classification is required** |
| Coupon concurrency                      | Unknown until TC-041 runs. S2 if reproduced                                                        |
| Promotion revived by a date edit (D-63) | Recommended S3; the service guard is not authorized (DEC-06-impl)                                  |

G4 criterion 3 cannot be stated as met until the first two are classified and the third is either
tested or explicitly accepted as untested.

_Update 2026-11-24: the first item is classified and fixed. Criterion 3 still needs your classification of M-1, and the coupon case either tested or accepted as untested. With PW-08 fixed, 16 of the 17 gaps in §4.2 remain._

_(Clarification 2026-11-27: "explicitly accepted as untested" is no longer available for G4. Under DEC-12, decided by the owner on 2026-11-27, the six real-database concurrency scenarios are mandatory evidence. G4 cannot treat them, or the coupon case for which TC-041 provides the evidence, as accepted untested. The "Coupon concurrency" row stays "Unknown until TC-041 runs": TC-041 has not been executed. Coupon hardening is NOT AUTHORIZED; any consideration of it requires review of the TC-041 evidence and a separate owner decision.)_
