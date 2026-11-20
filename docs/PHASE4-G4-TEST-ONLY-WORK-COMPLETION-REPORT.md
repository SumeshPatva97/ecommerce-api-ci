# Phase 4 — G4 Test-Only Work: Completion Report

| Field         | Value                                                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Document ID   | P4-G4-TESTONLY-01                                                                                                          |
| Date          | 2026-11-20 (23:35 – 23:58 IST)                                                                                             |
| Authorization | Owner instruction "Phase 4 Autonomous Completion — Execution Mode", §2 "Immediate authorization — test-only G4 work" (A–E) |
| Scope         | Test files and fixtures only. No application source, schema, migration, configuration, package or Docker change            |
| Evidence type | **Offline / mocked** (mocked Prisma client, fake providers). Not MySQL, provider or production evidence                    |

## 1. Results

| Item                                                          | Before (baseline run 23:35, same code) | After (run 23:52)                       |
| ------------------------------------------------------------- | -------------------------------------- | --------------------------------------- |
| Test files                                                    | 104 passed                             | **109 passed**                          |
| Tests                                                         | 1,344 passed                           | **2,855 passed, 6 todo, 0 failed**      |
| Coverage: statements                                          | 91.42 %                                | 91.83 %                                 |
| Coverage: branches                                            | 81.85 %                                | 82.33 %                                 |
| Coverage: functions                                           | 93.87 %                                | 94.48 %                                 |
| Coverage: lines                                               | 93.16 %                                | 93.58 %                                 |
| `format:check`, `lint`, `typecheck`, `openapi:check`, `build` | PASS (earlier today)                   | **PASS** (executed 23:50, Node 24.12.0) |

**Arithmetic check.** New tests = 2,855 − 1,344 = 1,511:

- 16 GST;
- 186 notification rendering;
- 181 state machine;
- 1,113 permission matrix;
- 15 added to existing files.

No existing test was removed. The work agents report that they added assertions only.

**Not run:** `prisma validate`. The schema is unchanged, and its configuration may resolve environment
files, which are restricted.

**Environment note.** On this machine, Vitest fails from a lower-case Git Bash path (`/c/...`) with
"Cannot read properties of undefined (reading 'config')". Run it from `C:/...` or PowerShell. No
code or configuration was changed for this.

## 2. Work packages

### A. Missing assertions (12 cases) — all PASS

| TC     | Test (file)                                                                                                                    | Asserts                                                                                                                                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-003 | `integration/modules/auth/adminAuth.test.ts`: "TC-003: 5 wrong staff passwords lock the account for 30 minutes (customer: 15)" | Lock at the 5th failure = login + 30 min; audit `auth.account_locked`; still refused at +29 min; allowed at +30 m 01 s                                                                                                |
| TC-006 | `adminAuth.test.ts` (×2), `customerAuth.test.ts`                                                                               | `adm_rt`: HttpOnly, SameSite=Strict, Path `/api/v1/admin/auth`. `sf_rt`: HttpOnly, SameSite=Lax, Path `/api/v1/auth`. `Secure` follows `COOKIE_SECURE` (absent in the test config; present with `COOKIE_SECURE=true`) |
| TC-008 | `staff/roles.test.ts`                                                                                                          | Superadmin with no roles creates a role (201); one CREATE audit row with `actorRole: SUPERADMIN`. **Judgement call:** the code writes no separate "bypass" event (`auth.ts` line 9: "still audited by the services")  |
| TC-009 | new `staff/effectivePermissions.test.ts`                                                                                       | A new ADMIN user's effective permissions = all 88 catalogue keys (real permission service, `/admin/auth/me`, a guarded request)                                                                                       |
| TC-010 | same file                                                                                                                      | DENY override → 403 `PERMISSION_DENIED` and an audit row (FAILURE, `authz.denied`, missing key) in one test                                                                                                           |
| TC-017 | `products/products.admin.test.ts`                                                                                              | Case / whitespace / tab / newline variants → 409 `DUPLICATE_RESOURCE` (normalized-name lookup)                                                                                                                        |
| TC-019 | `catalog/attributes.test.ts`                                                                                                   | Same value: 409 within one attribute, 201 in another                                                                                                                                                                  |
| TC-028 | `inventory/inventory.routes.test.ts` (×2)                                                                                      | STOCK_OUT writes one ledger row (delta, after, reason, actor) plus audit. No update / delete route, permission or write path (PUT / PATCH / DELETE → 404 even for Superadmin; source scan)                            |
| TC-044 | `orders/orders.routes.test.ts`                                                                                                 | After a rate change to 18 %, order detail and invoice keep the 3 % snapshot; tax master not consulted                                                                                                                 |
| TC-046 | `refunds/refunds.routes.test.ts`                                                                                               | Approving a refund on an invoiced order issues CN/2627/000001 with 4 negative tax rows; audit metadata carries the CN number                                                                                          |
| TC-057 | `unit/modules/refunds/refunds.test.ts`                                                                                         | Partial refund → `amountRefunded` / `refundedTotal` updated; payment and order `PARTIALLY_REFUNDED`; a second partial accumulates                                                                                     |
| TC-063 | `adminAuth.test.ts`                                                                                                            | Staff LOGIN audited (SUCCESS, `auth.login`); no audit row contains passwords, hashes, tokens, MFA challenge or TOTP secret                                                                                            |

### B. GST-01 … GST-17 (`tests/unit/lib/tax/gstCatalogue.test.ts`) — 16 PASS, 2 TODO

**Source:** `TESTING_STRATEGY.md` §6.2. **Result:**

- GST-01 … 07, 09 … 11, 13, 14, 16: PASS with the documented values (GST-04, previously missing,
  now passes: 27→07 inter-state IGST 30.00).
- GST-08 and GST-12 pass on the **alternative the table itself offers**:
  - GST-08: the odd paisa goes to CGST (0.02 + 0.01) per the provisional RD-01 rule;
  - GST-12: round-off +0.44 / payable 1235.00 per TAX_AND_GST_WORKFLOWS §11 half-up.

  Both depend on the open RD-01 tax-professional question.

- GST-15: the pure part passes (`NO_ASSIGNMENT`, not a silent 0 %). Blocking the order is DB-backed:
  TODO.
- GST-17: TODO, DEFERRED (B2B disabled, OQ-24).

### C. Route × role permission matrix (`tests/integration/routeRoleMatrix.test.ts`) — 1,113 PASS, no defect

**Coverage:** generated from the real route table of the full app:

- 166 permission-guarded admin routes (26 also need re-auth; 79 distinct keys);
- 5 admin self-service routes;
- 37 customer routes.

**Per admin route:**

- no token → 401;
- customer token → 401 (audience);
- staff without the route's keys → 403 `PERMISSION_DENIED` with an audit row naming exactly those
  keys;
- staff with exactly the keys → passes;
- Superadmin → passes;
- re-auth routes without re-auth → 403 `REAUTH_REQUIRED`.

**Customer routes:**

- no token → 401;
- admin token → 401;
- customer token → passes.

**Not proven:**

- real database permission resolution;
- ownership checks inside services;
- partial-key cases for multi-key routes;
- public optional-auth routes, webhooks and login routes;
- rate limiting (off in tests).

### D. Notification rendering (`tests/unit/modules/notifications/eventRendering.test.ts`) — 186 PASS, 3 TODO (defects)

**Coverage:**

- all 22 `NotificationEvent` values;
- e-mail templates for all 22 (every variant); WhatsApp for 18 (the 4 e-mail-only events match the
  design).

**Each event is checked for:**

- allowed variables only;
- rendering through the real dispatcher with a fake provider;
- no unrendered `{{`;
- WhatsApp parameter order;
- no sensitive data (card, CVV, UPI, gateway ids / signatures, tokens, passwords, OTP, account
  numbers).

**Token-bearing events** are refused by `enqueue`. Dedupe keys are distinct, and a repeat enqueue
creates nothing.

### E. Order state machine (`tests/unit/modules/orders/stateMachineMatrix.test.ts`) — 181 PASS, 1 TODO (doc conflict)

**Coverage:** all 12 × 12 = 144 status pairs asserted on both `canTransition` and
`ORDER_TRANSITIONS` (18 allowed, 126 rejected). This is **exhaustive for the implemented machine**.

**Also checked:**

- terminal states;
- no cancellation from SHIPPED onward;
- reachability;
- `staffCanCancel`.

## 3. Defects and conflicts found (no implementation changed)

Severity uses `TESTING_STRATEGY.md` §19 (S1–S4), **pending DEC-14**.

| ID    | Finding                                                                                                                                                                                                          | Evidence                                                                                                                                                                                                                       | Proposed severity                                                                | Proposed action (separate authorization)                         |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| DF-01 | `SECRET_VARIABLE` (`/pass(word)?                                                                                                                                                                                 | …/i`) matches `forgotPasswordUrl`, which the PASSWORD_CHANGED and SECURITY_ALERT templates require. These events can never be sent through the outbox with their reset link. Latent today: the auth module sends them directly | `notifications.catalog.ts` line 96; seed lines 100, 300; verified with the regex | S3 (latent)                                                      | Rename the variable or refine the guard; add a test |
| DF-02 | `SECRET_VARIABLE` misses `upiId` and `razorpayPaymentId`, which NOTIFICATION_WORKFLOWS §9 forbids in payloads. They would be stored in `notifications.payload` if a caller passed them. No template renders them | Regex test: both `false`                                                                                                                                                                                                       | S3 (privacy guard gap)                                                           | Extend the guard (`upi`, `paymentId`, `razorpay…`); add a test   |
| DF-03 | The COD out-for-delivery message (`order_out_for_delivery_cod_v1`, "Amount to pay: ₹…") from NOTIFICATION_WORKFLOWS §4.11 has no template, although `codAmount` is an allowed variable                           | Test todo; seed has no variant                                                                                                                                                                                                 | S3 (missing feature)                                                             | Add the template variant (needs wording approval)                |
| DC-01 | PAYMENT_FAILED → CANCELLED is implemented (OQ-58, R-06, USER_WORKFLOWS §15.6) but missing from the PROJECT_CONTEXT §5.1 diagram                                                                                  | `orderStateMachine.ts` lines 6, 13                                                                                                                                                                                             | Documentation                                                                    | Add the edge to the diagram (canonical document, needs approval) |
| DC-02 | GST-15 table expects `INTERNAL_ERROR`; the code returns `VALIDATION_ERROR` / `TAX_NOT_CONFIGURED`                                                                                                                | `checkout.quote.ts`                                                                                                                                                                                                            | Documentation                                                                    | Align the test-strategy row, or confirm the intended code        |
| DC-03 | GST-08 / GST-12 expectations depend on the provisional RD-01 rounding rule                                                                                                                                       | Engine header; TAX_AND_GST §8.1 / §11                                                                                                                                                                                          | Decision (DEC-07)                                                                | Tax professional confirmation                                    |
| DC-04 | TC-008 "bypass is audited": no dedicated bypass event; the service audit row carries `SUPERADMIN`                                                                                                                | `auth.ts` line 9                                                                                                                                                                                                               | Interpretation                                                                   | Confirm this satisfies TC-008, or request a dedicated event      |

**Observations (no test):**

- The notification template seed is deliberately not wired into `prisma/seed/index.ts` (wording
  approval pending).
- All WhatsApp templates are DRAFT.
- The direct verification e-mail uses different variable names from the seeded template.

**No S1 / S2 defect was found.**

## 4. QA-03 impact (P1 rows, previously PARTIAL)

| Now covered (mocked)                                                                | Remains partial                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-003, 006, 008 (see DC-04), 009, 010, 014, 017, 019, 028, 044, 046, 054, 057, 063 | TC-043: complete except GST-15 (DB part) and GST-17 (deferred). TC-060: three defects. **Need a real database (DEC-12):** TC-004, 030, 041, 045, 048, 051. **Not in scope of this package:** TC-025 (UI half), TC-033 (barcode decode), TC-047 (golden report dataset), TC-070 (FE half) |

The QA-03 draft carries a dated verification section reflecting this.

## 5. Files

**Created (test files):**

- `tests/unit/lib/tax/gstCatalogue.test.ts`
- `tests/integration/routeRoleMatrix.test.ts`
- `tests/unit/modules/notifications/eventRendering.test.ts`
- `tests/unit/modules/orders/stateMachineMatrix.test.ts`
- `tests/integration/modules/staff/effectivePermissions.test.ts`

**Modified (test files, assertions added only):**

- `tests/integration/modules/auth/adminAuth.test.ts`
- `tests/integration/modules/auth/customerAuth.test.ts`
- `tests/integration/modules/staff/roles.test.ts`
- `tests/integration/modules/products/products.admin.test.ts`
- `tests/integration/modules/catalog/attributes.test.ts`
- `tests/integration/modules/inventory/inventory.routes.test.ts`
- `tests/integration/modules/orders/orders.routes.test.ts`
- `tests/integration/modules/refunds/refunds.routes.test.ts`
- `tests/unit/modules/refunds/refunds.test.ts`

**Not changed** (verified by modification-time scan): `src/`, `prisma/`, `scripts/`,
`package.json`, `package-lock.json`, config and Docker files. `.env*` was not opened; `.git` was not
accessed. No database or external service was used.

**Build output:** `dist/` was regenerated by `npm run build`, and `coverage/` by the coverage run
(both generated, git-ignored outputs).

## 6. Statuses (unchanged)

- Batch 9: **COMPLETE — PENDING USER ACCEPTANCE**
- Batch 10: **NOT AUTHORIZED**
- G4: **NOT MET**
- Phase 4: **IN PROGRESS — NOT APPROVED**
