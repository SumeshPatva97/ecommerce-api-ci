# Phase 4 — Refund Risk Documentation Alignment Report

| Field         | Value                                                                                                           |
| ------------- | --------------------------------------------------------------------------------------------------------------- |
| Document ID   | P4-REFUND-RISK-DOC-01                                                                                           |
| Date          | 2026-11-20                                                                                                      |
| Authorization | Explicit user authorization provided on 2026-11-20 — documentation only; three named documents plus this report |
| Basis         | Read-only refund risk clarification review (2026-11-20, delivered in chat)                                      |

## 1. Scope

The task aligns three documents with the verified refund-risk findings:

- M-1 is not worker-specific;
- recovery is undefined when the gateway confirms no refund was issued;
- the customer can be notified prematurely;
- the `APPROVED` edge-case explanation was wrong.

No implementation, test, route, state transition or notification behaviour was changed.

## 2. Code verification (re-checked before editing, read only)

| Area                                | Code evidence                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker late capture                 | `src/jobs/paymentReconciliation.ts`: `capturePayment` in `withTransaction` (181), then `runRefundJob` after commit (194)                                                                                                                                                                                                                                                  |
| API late capture                    | `src/modules/payments/payments.service.ts` `verify` (capture in `withTransaction`, `runRefundJob` at 346) and `handleWebhook` (`runRefundJob` at 639)                                                                                                                                                                                                                     |
| Late-capture refund creation        | `payments.capture.ts`: `providerPaymentId` written (418) before `requireRefund` (450) → `payments.refunds.ts` `refundsModuleHook`: `createRefundForOrder(… status: 'APPROVED', method: 'ORIGINAL_PAYMENT_METHOD')` then `prepareGatewayRefund` in the same transaction                                                                                                    |
| Staff approval                      | `refunds.service.ts` `approve` (353): `REQUESTED → APPROVED`, credit note, audit, `notifyOrderEvent(… 'REFUND_INITIATED' …)`, `prepareGatewayRefund` — all in one transaction; then `runGateway` (`executeGatewayRefund`) after commit                                                                                                                                    |
| Customer self-cancel                | `orders.service.ts` `cancelMine` → `cancelOrderInTx` with `refund: { initiate: true, autoApprove: true }`, `notifyCustomer: true` (393–402) → `orders.cancel.ts`: refund created `APPROVED` (170–176); `ORDER_CANCELLED` with refund note "has been initiated" and `REFUND_INITIATED` (226–249); `prepareGatewayRefund` (254); after commit `finishCancel` → `runGateway` |
| Admin cancel / approve cancellation | `autoApprove: false` → refund `REQUESTED`, no gateway call in that request (not affected until staff approval)                                                                                                                                                                                                                                                            |
| `prepareGatewayRefund`              | `refunds.core.ts` 315–347: returns no job unless method is `ORIGINAL_PAYMENT_METHOD`, status `APPROVED`/`FAILED`, and a payment with a provider payment id exists; otherwise sets `PROCESSING` and returns the job                                                                                                                                                        |
| `executeGatewayRefund`              | `refunds.core.ts` 454: gateway call, then a second transaction: `COMPLETED` → `markRefundCompleted`; `FAILED` → `FAILED`; any other result only stores the provider refund id (stays `PROCESSING`)                                                                                                                                                                        |
| `retry`                             | `refunds.service.ts` 480–484: `FAILED` only                                                                                                                                                                                                                                                                                                                               |
| `complete`                          | `refunds.service.ts` 526–550: `BANK_TRANSFER` → `APPROVED`/`PROCESSING`; otherwise `PROCESSING` only; `markRefundCompleted` with `payoutReference: input.utr`; **no gateway call**                                                                                                                                                                                        |
| Notification creation               | `refunds.notify.ts` `notifyOrderEvent` → `notifications.service.ts` `enqueue(tx, …)` → `tx.notification.create` with status `QUEUED` (or `SKIPPED`) — **inside the caller's transaction**                                                                                                                                                                                 |
| Notification dispatch               | Worker job `notification-dispatch` (`registry.ts`, every 15 s) → `dispatchPending`; independent of any gateway outcome                                                                                                                                                                                                                                                    |
| Refund requires a paid payment      | `refunds.core.ts` `createRefundForOrder`: throws `ORDER_NOT_PAID` unless a paid payment exists (or a paid COD order, whose method is forced to `BANK_TRANSFER`)                                                                                                                                                                                                           |
| Automatic recovery of `PROCESSING`  | None found in `src/jobs`, `src/modules/refunds`, `src/modules/payments`                                                                                                                                                                                                                                                                                                   |

## 3. The four affected flows

| #   | Flow                              | Process    | State committed before the gateway call | `REFUND_INITIATED` committed before the call                                                                                        |
| --- | --------------------------------- | ---------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Late capture via reconciliation   | **Worker** | `PROCESSING`                            | No                                                                                                                                  |
| 2   | Staff refund approval             | API        | `PROCESSING` (original payment method)  | **Yes — verified**                                                                                                                  |
| 3   | Customer self-cancel              | API        | `PROCESSING` (prepaid, original method) | **Yes — verified** (independently confirmed in this task; also an `ORDER_CANCELLED` message saying the refund "has been initiated") |
| 4   | Late capture via verify / webhook | API        | `PROCESSING`                            | No                                                                                                                                  |

**`PROCESSING` interruption risk.** If the process stops between commit and the gateway call, the
refund stays `PROCESSING`. This is the same failure mode in all four flows.

- `retry` rejects `PROCESSING`, and no job recovers it.
- In flow 4, a redelivered webhook is treated as a duplicate and a repeated verify finds the payment
  already captured, so neither re-runs the gateway call.
- The risk is **pre-existing and not introduced by Batch 9.** Batch 9 moved flow 1 into the worker and
  set the 60 s worker forced exit; the API hard-exits after 30 s.
- Real interruption timing: **NOT VERIFIED**.

Bank-transfer refunds in flows 2 and 3 stay `APPROVED` with no gateway call, by design.

## 4. Undefined recovery: gateway confirms no refund

The only manual step supported by code and documentation is to **check the gateway outcome**. Then:

| Gateway outcome          | What may be done                                                                                                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Refund was completed     | The existing `complete` route may **record** it (API_DOCUMENTATION §4.11: "closed manually after provider confirmation")                                                                             |
| **No refund was issued** | **Undefined.** No documented or authorized procedure. `retry` rejects `PROCESSING`; `complete` must **not** be used (it would record a refund that never happened). **Unresolved business decision** |

No retry, manual gateway issuance or other recovery procedure was invented.

## 5. Premature customer notification

Notification rows are written with status `QUEUED` in the same transaction as the refund. They are
delivered by the worker independently of the gateway result. In flows 2 and 3, a customer may
therefore be told a refund was initiated even though the gateway call never happened.

| Flow                 | Status                                                                                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Staff approval       | **Verified**                                                                                                                                                            |
| Customer self-cancel | **Verified** in this task by code inspection (`orders.cancel.ts` 226–249 with `notifyCustomer: true` from `cancelMine`). The previous review had marked it NOT VERIFIED |
| Late captures        | Not affected (`REFUND_INITIATED` is emitted only by `orders.cancel.ts` and `refunds.service.ts`)                                                                        |

## 6. Corrected `APPROVED` edge case

**Legitimate case: bank transfer.** `prepareGatewayRefund` returns no job for a non-original method,
so the refund stays `APPROVED`. It is paid out manually and closed with `complete`, which accepts
`APPROVED` / `PROCESSING` for `BANK_TRANSFER`.

**Missing payment or provider payment id: an unreachable guard** in the reviewed paths.

- Capture writes the provider payment id before the refund hook runs.
- `createRefundForOrder` requires a paid payment. The only exception is a paid COD order, whose
  refunds are forced to bank transfer.
- If the guard were ever hit, the refund would stay `APPROVED` with no accepting route. Existing data
  cannot be checked offline (NOT VERIFIED).

**Distinction kept:**

- Normal approval: `APPROVED`.
- Gateway refund before the call: `PROCESSING`.
- Interrupted state: `PROCESSING`.

## 7. Documents corrected

| #   | File                                                                                      | Section(s)                                        | Correction                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ----------------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `ecommerce-api/docs/PHASE4-BATCH9-FINAL-ACCEPTANCE-REVIEW.md`                             | §7.1; §11 risk 1                                  | §7.1: the "issue the refund there" instruction is removed (dated correction note); gateway check kept; `complete` only after confirmed completion; recovery undefined when no refund was issued; four-flow table (worker vs API); premature-notification table; step 4 notes that other gateway results leave `PROCESSING`. §11 risk 1 rewritten: four flows, pre-existing, manual handling, premature notification (both verified). **Recommendation unchanged** (option 2) |
| 2   | `ecommerce-api/docs/PHASE4-M1-REFUND-PROCESSING-STATE-DOCUMENTATION-CORRECTION-REPORT.md` | §8                                                | Edge-case bullet replaced with the dated correction in §6 above. The first bullet's section reference corrected ("§7.1 and §11" → §7.1) with a dated note and a pointer to this alignment                                                                                                                                                                                                                                                                                    |
| 3   | `project-documentation/06-workflows/ADMIN_WORKFLOWS.md`                                   | §11.1 table, row 8 (+ dated note below the table) | Row 8 now covers both cases: bank transfer `APPROVED`/`PROCESSING`; gateway refund `PROCESSING` only, after checking the gateway and provider confirmation of completion. It **records** an already-completed refund (`utr` stored as the payout reference) and does not initiate a gateway refund. The note states recovery is undefined when the gateway confirms no refund. Edited surgically (no Prettier), LF kept                                                      |

`API_DOCUMENTATION.md` was **not** edited (see §11).

## 8. Changed files (exact)

1. `ecommerce-api/docs/PHASE4-BATCH9-FINAL-ACCEPTANCE-REVIEW.md`
2. `ecommerce-api/docs/PHASE4-M1-REFUND-PROCESSING-STATE-DOCUMENTATION-CORRECTION-REPORT.md`
3. `project-documentation/06-workflows/ADMIN_WORKFLOWS.md`
4. `ecommerce-api/docs/PHASE4-REFUND-RISK-DOCUMENTATION-ALIGNMENT-REPORT.md` (new; this report)

## 9. Validation

| Check                         | Result                                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Changed sections re-read      | Done                                                                                                                                                                      |
| Technical statements vs code  | Every statement traced to §2. Self-cancel notification upgraded from NOT VERIFIED to verified on code evidence only                                                       |
| Only authorized files changed | Modification-time scan of the workspace since 22:23 (excluding `node_modules`, `.git`, `dist`, `coverage`): exactly the four files in §8 (three authorized + this report) |
| Formatting                    | Prettier only on the three `ecommerce-api` files; `npm run format:check` **PASS**. `ADMIN_WORKFLOWS.md`: 0 CR characters (LF kept), not run through Prettier              |
| `.env*`                       | Timestamps unchanged (`.env` 19:05:02, `.env.example` 17:37:18, `.env.migration.example` 2026-11-18); files not opened                                                    |

## 10. Confirmation

Documentation only. Nothing else was changed:

- source code, tests, refund state transitions and business logic;
- recovery mechanisms, the gateway integration, routes and notification behaviour;
- packages, configuration, schema, migrations, seeds and Docker files;
- M-1 and M-2, the scheduler comment and the start-up log.

No database, Redis, gateway, courier or external service was accessed. No Git command was run, and
`.git` was not inspected. `.env*` files were not opened.

## 11. Unresolved business decisions and future recommendations (not edited)

**Unresolved business decisions:**

1. **Recovery when the gateway confirms no refund was issued** for a `PROCESSING` refund (all four
   flows): undefined. It needs a business decision and separate authorization (it may require code,
   e.g. a guarded re-execution, which is not authorized).
2. **Premature `REFUND_INITIATED` / "refund initiated" notifications** in staff approval and customer
   self-cancel: whether this behaviour is acceptable, or whether customers must be corrected
   manually.

**Future documentation recommendations (not authorized here):**

3. **`API_DOCUMENTATION.md` §4.11, `complete` row** says "in status `APPROVED`/`PROCESSING`" for both
   bank transfer and gateway refunds. The code accepts `APPROVED` only for `BANK_TRANSFER`; gateway
   refunds need `PROCESSING`. This is a small imprecision, not a contradiction that blocked this task.
4. **`ADMIN_WORKFLOWS.md` §11.1:**
   - Row 5 lists `REFUND_INITIATED` under "Processing (ONLINE) — system after approval", implying it
     follows the gateway call. The code commits it with the approval, before the call.
   - The state diagram does not show the cancel / approve paths moving to `PROCESSING` before the
     gateway call.
5. **The eight documents corrected by the M-1 state correction** say "check the gateway outcome first,
   then use `complete`". They do not state that `complete` is valid only when the gateway confirms
   completion, or that recovery is undefined when no refund was issued. This also applies to the
   recommended wording quoted in the acceptance review §7.2.
6. **Operations runbook** (`docs/operations/DEPLOYMENT_AND_OPERATIONS.md`, roadmap DOC-09): no M-1
   handling procedure yet.

**Statuses (unchanged):**

- Batch 9: **COMPLETE — PENDING USER ACCEPTANCE**
- Phase 4: **IN PROGRESS — NOT APPROVED**
- G4: **NOT MET**
- Production readiness: **NOT ESTABLISHED**
