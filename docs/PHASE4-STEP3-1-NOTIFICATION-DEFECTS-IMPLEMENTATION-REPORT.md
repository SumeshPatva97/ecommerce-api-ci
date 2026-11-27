# Phase 4 — Step 3.1: Notification Defects DF-01, DF-02, DF-03 — Implementation Report

| Field         | Value                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------- |
| Document ID   | P4-STEP3-1-NOTIF-01                                                                         |
| Date          | 2026-11-24                                                                                  |
| Authorization | Owner's Phase 4 Execution Authorization — G4 Closure; Step 3.1 brief (reconciliation first) |
| Severity      | DF-01, DF-02, DF-03 remain **S3** (no new evidence to change it)                            |
| Evidence type | Offline / mocked tests. No database, external service or production                         |

## 1. Defect status

| Defect | Status                                                                            |
| ------ | --------------------------------------------------------------------------------- |
| DF-01  | **ALREADY COMPLETE** — verified as correct before this step; no new change needed |
| DF-02  | **ALREADY COMPLETE** — verified as correct before this step; no new change needed |
| DF-03  | **ALREADY COMPLETE** — verified as correct before this step; no new change needed |

"No new change needed" refers to the implementation. This step added regression-test cases only
(§4), so that the tests name the exact keys and cases listed in the Step 3.1 brief.

## 2. Pre-change audit

Git was not used (not permitted). The audit is based on the current file contents and file
modification times.

### 2.1 Files already changed before this step (2026-11-21, 00:04 – 00:07)

| File                                                           | Change found                                                                                                           |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `src/modules/notifications/notifications.catalog.ts`           | Variable renamed to `accountRecoveryUrl` in two event specs; guard extended; `COD_VARIANT` and `implicitVariant` added |
| `src/modules/notifications/notifications.service.ts`           | `enqueue` uses `input.variant ?? implicitVariant(event, variables)`                                                    |
| `src/modules/notifications/notifications.templates.ts`         | A variant can carry its own WhatsApp parameter order                                                                   |
| `src/modules/notifications/notifications.dispatcher.ts`        | WhatsApp parameters use the resolved variant's order                                                                   |
| `src/modules/notifications/notifications.admin.ts`             | A staff edit of a variant keeps its stored WhatsApp parameter order                                                    |
| `prisma/seed/notification-templates.seed.ts`                   | Templates use `accountRecoveryUrl`; COD e-mail variant and WhatsApp variant `order_out_for_delivery_cod_v1` added      |
| `tests/unit/modules/notifications/eventRendering.test.ts`      | Three former `it.todo` entries converted to real tests; DF-01 / 02 / 03 regression tests added                         |
| `tests/unit/modules/notifications/notifications.test.ts`       | Seed allow-list test accepts WhatsApp-only variants and checks variant parameter names                                 |
| `tests/integration/modules/shipping/shipping.branches.test.ts` | Asserts COD payloads carry `variant: 'COD'` and prepaid payloads carry none                                            |

Nothing under `src`, `tests`, `prisma`, `scripts` or the package files has changed since
2026-11-21 00:07 (checked at the start of this step).

### 2.2 Audit answers

1. **Which changes already exist.** All three fixes (§2.1).
2. **Correct and complete?** Yes, against the Step 3.1 criteria (§3).
3. **Do the tests exercise the behaviour?** Yes. They call the real guard, the real `enqueue`
   and the real dispatcher with a fake provider. They do not only inspect constants.
4. **What was missing.** No implementation. Only literal test cases for `gatewayRef`,
   `accountNumber`, `passwordHash`, a reset-token name, and a `null` / `undefined` COD amount.
5. **Unrelated changes or weakened security?** None found.
   - The guard was tightened, not relaxed. No existing pattern was removed.
   - The changes to `notifications.templates.ts`, `notifications.dispatcher.ts` and
     `notifications.admin.ts` are needed for DF-03, because the COD WhatsApp variant has three
     parameters instead of two.
   - Send timing, consent handling and dedupe keys are unchanged.

## 3. Per-defect evidence

### 3.1 DF-01 — safe password-recovery URL

**Names actually in use:**

- `accountRecoveryUrl`: the PASSWORD_CHANGED and SECURITY_ALERT event specs, and both seeded e-mail
  templates.
- `forgotPasswordUrl`: only `src/modules/auth/auth.service.ts` line 161, in the directly sent
  ACCOUNT_ALREADY_EXISTS e-mail. That path does not pass through the notification guard.

**Implementation.** The variable was renamed to a neutral name. The guard was not given an
exception. Consequences:

- `accountRecoveryUrl` passes the guard.
- `forgotPasswordUrl` is still refused by the guard. Nothing sends it through the outbox, so no
  exception is necessary. This follows the brief's "allow only the necessary safe URL fields".
- A URL is not trusted because of its name. The link is the public storefront "forgot password"
  page; NOTIFICATION_WORKFLOWS §4.20 states "no token in this email".

**Decision for the owner:** if `forgotPasswordUrl` must also be accepted by the outbox, that needs a
narrow named exception in the guard. It is not implemented because no caller needs it.

**Regression tests** (`eventRendering.test.ts`):

- "PASSWORD_CHANGED / SECURITY_ALERT — the recovery link `accountRecoveryUrl` is not refused by
  SECRET_VARIABLE (DF-01)".
- "DF-01 %s enqueues with the token-free account-recovery link and renders it" (two events):
  `enqueue` succeeds, the payload keeps the link, the link has no token or query string, and the
  rendered e-mail contains it.
- `password`, `newPassword`, `passwordHash`, `resetToken`, `passwordResetToken`, `otp`,
  `accessToken`, `refreshToken` are refused (forbidden-name table).

### 3.2 DF-02 — sensitive payment identifiers

**Implementation.** `SECRET_VARIABLE` is now
`/pass(word)?|secret|token|otp|cvv|card|vpa|upi|signature|account_?number|razorpay|gateway|payment_?id/i`.
Every earlier pattern is preserved.

**Keys named in the brief** (checked directly against the regex in this step):

| Key                 | Result  |
| ------------------- | ------- |
| `upiId`             | Refused |
| `razorpayPaymentId` | Refused |
| `paymentId`         | Refused |
| `gatewayRef`        | Refused |
| `accountNumber`     | Refused |

**Legitimate fields still accepted:** `paymentMethod`, `orderNumber`, `amount`, `codAmount`,
`reference`, `trackingUrl`, `orderUrl`, and every variable allowed by every event spec.

**Regression tests:**

- "DF-02 guard refuses forbidden variable name "%s"": 35 names after this step (executed: 45 DF-02
  tests passed in total, counting the tests below).
- "DF-02 guard never blocks a variable allowed by any EVENT_SPECS entry".
- "DF-02 enqueue refuses "%s" and queues nothing": 8 names after this step. Each asserts the error
  and that `notification.create` was never called, so rejection happens before persistence.

No payment identifier was added to any template or payload.

### 3.3 DF-03 — COD out-for-delivery variant

**Requirement.** NOTIFICATION_WORKFLOWS §4.11: "Amount to pay: ₹{{3}}" variant
`order_out_for_delivery_cod_v1` for COD.

**Amount source (authoritative, not calculated).** Both callers pass
`codAmount: toMoneyString(order.grandTotal)` only when the payment method is COD:

- `src/modules/shipping/shipping.shipments.ts` lines 445–446;
- `src/modules/orders/orders.service.ts` lines 546–547.

`order.grandTotal` is the stored order total. The shipping module gives the courier the same value
as the COD amount (`shipping.shipments.ts` lines 693–694). These lines existed before the fix and
were not changed.

**Implementation:**

- `implicitVariant` selects the COD variant for ORDER_OUT_FOR_DELIVERY only when `codAmount` is
  present and not empty.
- Prepaid orders have no `codAmount`, so they keep the standard template.
- A missing, empty or `null` amount falls back to the standard template. A COD message is never sent
  without an amount.
- The seed defines the COD e-mail variant and the WhatsApp variant `order_out_for_delivery_cod_v1`
  with parameters `firstName`, `orderNumber`, `codAmount`.

**Regression tests:**

- "ORDER_OUT_FOR_DELIVERY — COD variant `order_out_for_delivery_cod_v1` … renders the amount
  (email + WhatsApp)".
- "prepaid out-for-delivery keeps the existing message (no amount to pay)".
- "enqueue selects the COD variant only when codAmount is present (prepaid stays on the base)",
  including the missing / empty / `null` / `undefined` cases.
- "ORDER_OUT_FOR_DELIVERY allows codAmount and only the COD variant uses it".
- Seed registration: the seed allow-list test in `notifications.test.ts`.
- Callers: `shipping.branches.test.ts` asserts `variant: 'COD'` on COD payloads and no variant on
  prepaid payloads.

## 4. Files changed during this step

| File                                                                | Change                                                                                                                                                                                                                              |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/modules/notifications/eventRendering.test.ts`           | Test cases added only: `gatewayRef`, `accountNumber`, `account_number`, `passwordHash`, `passwordResetToken` in the forbidden-name table; four more names in the "queues nothing" table; `null` / `undefined` COD amount assertions |
| `docs/PHASE4-STEP3-1-NOTIFICATION-DEFECTS-IMPLEMENTATION-REPORT.md` | New (this report)                                                                                                                                                                                                                   |

No source file, seed, schema, migration, package or configuration file was changed in this step.
No assertion was removed or weakened.

## 5. Test commands and actual results (2026-11-24, Node 24.12.0)

Run from `C:/…/ecommerce-api`. Vitest fails from a lower-case `/c/…` path on this machine.

| Command                                                                                                                      | Result                                     |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `npx vitest run tests/unit/modules/notifications/eventRendering.test.ts`                                                     | 1 file, **241 passed**, 0 failed, 0 todo   |
| `npx vitest run tests/unit/modules/notifications tests/integration/modules/notifications tests/integration/modules/shipping` | 7 files, **344 passed**, 0 failed          |
| `npx eslint <notification source, seed and tests> --max-warnings 0`                                                          | PASS                                       |
| `npx prettier --check <notification source, seed and tests>`                                                                 | PASS                                       |
| `npm run typecheck`                                                                                                          | **PASS**                                   |
| `npm run format:check` (whole repository)                                                                                    | **FAIL** — 7 files, none in this step (§6) |
| `npm run lint` (whole repository)                                                                                            | **FAIL** — 1 error, not in this step (§6)  |

The full test suite, build and OpenAPI check were not run in this step. No full-suite result is
claimed here.

## 6. Unresolved issues (outside Step 3.1; not changed)

1. **Repository-wide `format:check` and `lint` currently fail.** The cause is unfinished work from
   2026-11-21, not the notification changes:
   - `tests/db/harness/client.ts`, `fixtures.ts`, `guard.ts`, `race.ts` and
     `tests/unit/dbHarness/guard.test.ts` are unformatted, and `race.ts` line 49 has one lint error
     (`no-unnecessary-template-expression`). These come from the real-database test-harness
     preparation, which stopped part-way when its worker failed. The harness is incomplete: no
     README, no `.dbtest.ts` files.
   - `docs/operations/CI-CD-AND-DEPLOYMENT-PREPARATION.md` and
     `docs/PHASE4-REMAINING-USER-DECISIONS.md` are unformatted.

   They were left untouched because Step 3.1 forbids unrelated changes. They need a separate
   decision: finish or remove the harness files, and format the two documents.

2. **Seeded databases.** The seed never overwrites existing template rows. A database that was
   already seeded keeps the old `forgotPasswordUrl` wording and has no COD variant until those rows
   are updated. No database has been seeded in this project so far.
3. **Template seed not wired.** `prisma/seed/index.ts` does not call the template seed (a deliberate
   earlier decision, pending wording approval). All WhatsApp templates, including the COD variant,
   are DRAFT.
4. **Stale wording in earlier documents.** `PHASE4-AUTONOMOUS-COMPLETION-STATUS.md`,
   `PHASE4-G4-TEST-ONLY-WORK-COMPLETION-REPORT.md` and the security self-assessment draft still list
   DF-01 / 02 / 03 as open. They were not edited in this step.

## 7. Final change summary and confirmations

- **Changed in this step:** one test file (cases added) and this report.
- **Not touched:** `.env`, `.env.*` and `.env.example` (not opened); Git (no command run, no commit,
  no push); MySQL or any database; e-mail, SMS, WhatsApp or payment providers; production; Prisma
  schema and migrations; Batch 10 code; the DEC-06 service guard; Batch 9 acceptance.
- **Statuses unchanged:** Batch 9 COMPLETE — PENDING USER ACCEPTANCE; G4 NOT MET; Phase 4
  IN PROGRESS — NOT APPROVED.

Step 3.1 ends here. No further step was started.
