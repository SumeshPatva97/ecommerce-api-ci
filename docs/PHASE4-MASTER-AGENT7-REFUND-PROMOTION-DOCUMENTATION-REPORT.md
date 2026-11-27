# Phase 4 Master Completion — Agent 7: Refund and Promotion Documentation

| Field       | Value                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------- |
| Document ID | P4-MASTER-AGENT7                                                                                    |
| Date        | 2026-11-24                                                                                          |
| Nature      | Read-only review with proposed edits. No source, test or existing document was changed              |
| Scope       | Documentation consistency for DEC-05 (D-64, refund recovery) and DEC-06 (D-63, promotion `EXPIRED`) |
| Authority   | `project-documentation/01-requirements/PROJECT_CONTEXT.md` §17.8, D-62 … D-66                       |
| Evidence    | Code and documents read on 2026-11-24. Nothing was executed (no tests, no build, no database)       |
| Output      | This file only. The orchestrator applies any approved edit                                          |

## 1. Summary

**DEC-05 (D-64).** 59 statements checked: 38 consistent, 9 inconsistent, 12 incomplete.

- No document claims automatic recovery, and no document presents the "re-submit gateway refund"
  action as available.
- The five code paths, the `complete` rule and the gateway / bank-transfer distinction are stated
  correctly in the runbook (§9, §9.1).
- The nine inconsistencies are wording that D-64 or the code has overtaken:
  - "no further procedure is defined" (R-03) and "four flows" (R-15);
  - three places that omit `retry` from the re-authentication scope (R-29, R-46, R-57);
  - the late-capture row in USER_WORKFLOWS (R-51);
  - the refund webhook "amount matches" check (R-41);
  - the bank-transfer `FAILED` / retry step (R-44);
  - the permission named for refund completion in FR-PAY-011 (R-56).
- One real gap in the runbook procedure was found: after an admin retry, a refund can be stuck in
  `PROCESSING` **with** a provider refund id from an earlier failed attempt. Step 1 of §9.1 tells
  staff to leave such refunds alone (finding R-08, proposed edit PE-02).

**DEC-06 (D-63).** 20 statements checked: 11 consistent, 1 inconsistent, 8 incomplete.

- A promotion whose **stored** status is `EXPIRED` is already final in code: no route revives it.
- The known discrepancy is confirmed and is wider than documented. It is not limited to the
  one-minute job interval, because the worker is off by default (`JOBS_ENABLED=false`).
- A second path was found that the proposed narrow guard would not cover: a `PAUSED` promotion past
  `ends_at` can have its dates extended and then be resumed (§3.1 case C, owner decision OD-02).
- No canonical document states the D-63 rule outside PROJECT_CONTEXT.

**Proposed edits:** 30 (§4). **Owner decisions:** 11 (§5). None is decided here.

## 2. DEC-05 — refund recovery consistency (D-64)

### 2.1 Code facts used as the reference

Read in `src/modules/refunds/refunds.service.ts`, `refunds.core.ts`, `refunds.routes.ts`,
`refunds.schemas.ts`, `src/modules/payments/payments.refunds.ts`, `payments.service.ts`,
`payments.capture.ts`, `src/modules/orders/orders.cancel.ts`, `orders.service.ts`,
`src/jobs/paymentReconciliation.ts` and `src/integrations/payments/paymentProvider.ts`.

| #    | Fact                                                                                                                                                                                                                  | Where                                                                                                                  |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| C-01 | `prepareGatewayRefund` sets `PROCESSING` inside the caller's transaction, only for `ORIGINAL_PAYMENT_METHOD` with a provider payment id, from `APPROVED` or `FAILED`. It returns `null` for bank transfer             | `refunds.core.ts` 315–347                                                                                              |
| C-02 | `executeGatewayRefund` calls the provider after commit, with the refund `id` (UUID) as the idempotency key, and records the result in a second transaction: `COMPLETED`, `FAILED`, or the provider refund id only     | `refunds.core.ts` 454–510                                                                                              |
| C-03 | Five callers commit `PROCESSING` and then call the gateway: reconciliation job, staff approve, customer self-cancel, verify / webhook late capture, admin retry                                                       | `paymentReconciliation.ts` 194; `refunds.service.ts` 428, 522; `orders.service.ts` 178; `payments.service.ts` 346, 639 |
| C-04 | `retry` accepts only `FAILED` (else 409), at most 5 retries. It does not clear a stored provider refund id                                                                                                            | `refunds.service.ts` 480–524                                                                                           |
| C-05 | `complete` accepts a gateway refund only from `PROCESSING`, a bank-transfer refund from `APPROVED` / `PROCESSING`. It calls `markRefundCompleted` only; no provider call. The `utr` is stored as the payout reference | `refunds.service.ts` 526–567                                                                                           |
| C-06 | `complete` body: `utr` 1–40 characters, `transferredAt` not in the future, optional `note`. Route: `refunds.update` + re-authentication + `Idempotency-Key`. `retry` has the same guards                              | `refunds.schemas.ts` 82–88; `refunds.routes.ts` 97–120                                                                 |
| C-07 | Only two places set a refund `FAILED`: the post-commit gateway result, and the refund webhook matched by provider refund id. A bank-transfer refund can reach neither                                                 | `refunds.core.ts` 493–501; `payments.service.ts` 197–225                                                               |
| C-08 | The refund webhook finds the refund by provider refund id. A refund whose gateway call never ran has none, so no webhook can complete or fail it. The webhook does not compare amounts                                | `payments.service.ts` 197–225                                                                                          |
| C-09 | `REFUND_INITIATED` is queued inside the approval transaction (every method) and inside the self-cancel transaction, before any gateway call. The late-capture path queues none. `retry` queues none                   | `refunds.service.ts` 414–425; `orders.cancel.ts` 236–249; `payments.capture.ts`                                        |
| C-10 | Late capture with no stock: the order becomes `CANCELLED`, `ORDER_CANCELLED` is queued, and the refund is created `APPROVED` then `PROCESSING`                                                                        | `payments.capture.ts` 487–523                                                                                          |
| C-11 | No job and no route re-submits or re-checks a `PROCESSING` refund                                                                                                                                                     | whole `src/jobs`, refunds routes                                                                                       |
| C-12 | The mock adapter returns `mock_rfnd_<refund id>` (46 characters) as the provider refund id                                                                                                                            | `paymentProvider.ts` 301–308                                                                                           |

### 2.2 Consistency table

Status is judged against D-64 and the code facts above.

| ID   | Document / section                                          | Statement                                                                                               | Status       | Note                                                                                                                                      |
| ---- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| R-01 | DEPLOYMENT_AND_OPERATIONS §9, lines 70–76                   | Five code paths commit `PROCESSING` before the gateway call                                             | CONSISTENT   | Each path verified (C-03)                                                                                                                 |
| R-02 | DEPLOYMENT_AND_OPERATIONS §9, lines 78–80                   | Refund stays `PROCESSING`; nothing recovers it; retry accepts only `FAILED`                             | CONSISTENT   | C-04, C-11                                                                                                                                |
| R-03 | DEPLOYMENT_AND_OPERATIONS §9, line 82                       | "Operational rules (no further procedure is defined)"                                                   | INCONSISTENT | §9.1 of the same file defines the D-64 procedure. PE-01                                                                                   |
| R-04 | DEPLOYMENT_AND_OPERATIONS §9, lines 84–86                   | Verify the gateway first; `complete` only after confirmation; no-refund case undefined                  | CONSISTENT   | C-05                                                                                                                                      |
| R-05 | DEPLOYMENT_AND_OPERATIONS §9, line 87                       | "Refund initiated" is queued before the gateway call in staff approval and self-cancel                  | CONSISTENT   | C-09                                                                                                                                      |
| R-06 | DEPLOYMENT_AND_OPERATIONS §9.1, lines 93–101                | Scope is gateway refunds only; bank transfer is a separate normal path and stays `APPROVED`             | CONSISTENT   | C-01                                                                                                                                      |
| R-07 | DEPLOYMENT_AND_OPERATIONS §9.1, line 103                    | `refunds.view` to identify; `refunds.update` plus re-authentication to complete                         | CONSISTENT   | C-06                                                                                                                                      |
| R-08 | DEPLOYMENT_AND_OPERATIONS §9.1 step 1, lines 108–110        | A candidate has no provider refund id; one **with** an id is waiting and must be left alone             | INCOMPLETE   | After a retry, an id from the earlier failed attempt can remain (C-02, C-04). Such an interrupted refund would never be identified. PE-02 |
| R-09 | DEPLOYMENT_AND_OPERATIONS §9.1 step 2, lines 112–114        | Look the refund up "using the refund id"; lookup method not yet defined (OQ-06)                         | INCOMPLETE   | Does not say that the id is the UUID `id`, not the `RFD-…` number (C-02). PE-03                                                           |
| R-10 | DEPLOYMENT_AND_OPERATIONS §9.1 step 3, line 116             | Provider confirms completed: call `complete` with the provider reference as `utr`                       | INCOMPLETE   | Correct, but omits the 40-character limit, the header and where the value is stored (C-05, C-06, C-12). PE-04                             |
| R-11 | DEPLOYMENT_AND_OPERATIONS §9.1 step 3, lines 117–122        | Pending: wait. No refund issued: stop, do not `complete`, do not refund at the gateway, escalate        | CONSISTENT   | Matches D-64                                                                                                                              |
| R-12 | DEPLOYMENT_AND_OPERATIONS §9.1, lines 123–128               | No automatic recovery; "re-submit" is a proposal only                                                   | CONSISTENT   | Matches D-64, C-11                                                                                                                        |
| R-13 | DEPLOYMENT_AND_OPERATIONS §9.1, line 130                    | Automated evidence in `manualRecoveryContract.test.ts`                                                  | CONSISTENT   | File exists and its cases match the sentence. Not executed by this review                                                                 |
| R-14 | PHASE4-JOBS-AND-SCHEDULING §6a item 4, line 95              | The 60 s forced exit can cut off a post-commit gateway refund call                                      | CONSISTENT   | —                                                                                                                                         |
| R-15 | PHASE4-JOBS-AND-SCHEDULING §6a item 5, lines 97–103         | "It applies to four flows", with the admin retry named in a following sentence                          | INCONSISTENT | Count wording differs from D-64 and the runbook ("five code paths"). The content is complete. PE-05                                       |
| R-16 | PHASE4-JOBS-AND-SCHEDULING §6a item 5, line 105             | Stays `PROCESSING`; no automatic recovery; no job re-checks                                             | CONSISTENT   | C-11                                                                                                                                      |
| R-17 | PHASE4-JOBS-AND-SCHEDULING §6a item 5, line 106             | `complete` only after the provider confirms; procedural rule                                            | INCOMPLETE   | No reference to the D-64 procedure (runbook §9.1). PE-06                                                                                  |
| R-18 | PHASE4-JOBS-AND-SCHEDULING §6a item 6, line 107             | Premature `REFUND_INITIATED` in staff approval and self-cancel                                          | CONSISTENT   | C-09                                                                                                                                      |
| R-19 | PHASE4-JOBS-AND-SCHEDULING §6a, lines 111–113               | Unresolved: no-refund recovery; premature notification; late-capture `REFUND_INITIATED`                 | CONSISTENT   | All three are still open after D-64                                                                                                       |
| R-20 | PHASE4-REMAINING-USER-DECISIONS §1, RK-04                   | Five code paths; manual procedure documented (D-64, runbook §9.1)                                       | CONSISTENT   | —                                                                                                                                         |
| R-21 | PHASE4-REMAINING-USER-DECISIONS §1, RK-05                   | Premature "refund initiated" notifications, unchanged                                                   | CONSISTENT   | C-09                                                                                                                                      |
| R-22 | PHASE4-REMAINING-USER-DECISIONS §2, DEC-05-next             | "Re-submit gateway refund" is a proposal only                                                           | CONSISTENT   | Matches D-64                                                                                                                              |
| R-23 | PHASE4-CONSOLIDATED-DECISION-PACKAGE status update, line 17 | DEC-05 → B, documentation / manual procedure only                                                       | CONSISTENT   | Matches D-64                                                                                                                              |
| R-24 | PHASE4-CONSOLIDATED-DECISION-PACKAGE DEC-05, lines 84–93    | Five paths; the refund "stays `PROCESSING` with no provider refund id"                                  | INCOMPLETE   | Not always true after an admin retry (see R-08). PE-08                                                                                    |
| R-25 | PHASE4-CONSOLIDATED-DECISION-PACKAGE DEC-05, lines 97–101   | Outcomes: completed → `complete`; pending → wait; no refund → undefined                                 | CONSISTENT   | C-05, C-08                                                                                                                                |
| R-26 | PHASE4-CONSOLIDATED-DECISION-PACKAGE DEC-05, line 114       | Option B includes a stale-refund filter and a guarded re-submit action                                  | CONSISTENT   | Neither exists in code. The status update (line 17) limits the decision to documentation only                                             |
| R-27 | PHASE3-PHASE4-MASTER-PROGRESS-REPORT §16, lines 382–394     | M-1 in the worker path plus four API paths; recovery undefined if no refund was issued                  | INCOMPLETE   | Facts are right (five paths in total). No reference to D-64 or the procedure. PE-07                                                       |
| R-28 | API_DOCUMENTATION §2, line 137                              | `Idempotency-Key` required on refund approve / retry / complete                                         | CONSISTENT   | C-06                                                                                                                                      |
| R-29 | API_DOCUMENTATION §2, line 219                              | Re-authentication scope: "refund approve/complete"                                                      | INCONSISTENT | `retry` also requires it (R-15 of PROJECT_CONTEXT §15, the route, and line 1360 of the same file). PE-11                                  |
| R-30 | API_DOCUMENTATION §3.10, lines 869 and 881                  | Self-cancel: auto-`APPROVED`, then `PROCESSING`; emits `REFUND_INITIATED` where applicable              | CONSISTENT   | C-09. Timing caveat is in §4.11                                                                                                           |
| R-31 | API_DOCUMENTATION §4.11 approve, line 1358                  | "`REQUESTED → APPROVED → PROCESSING` (gateway call post-commit)"                                        | INCOMPLETE   | True for gateway refunds only; a bank-transfer refund stays `APPROVED` (C-01). D-64 requires the distinction. PE-09                       |
| R-32 | API_DOCUMENTATION §4.11 retry, line 1360                    | Only from `FAILED`; max 5; gateway call after commit; interruption leaves `PROCESSING` (M-1)            | CONSISTENT   | C-04                                                                                                                                      |
| R-33 | API_DOCUMENTATION §4.11 complete, line 1361                 | Records a completion; never calls the gateway; gateway refund only from `PROCESSING` after confirmation | CONSISTENT   | C-05, C-06                                                                                                                                |
| R-34 | API_DOCUMENTATION §4.11, line 1363                          | Completion by gateway result or webhook; `REFUND_INITIATED` queued before the gateway call              | INCOMPLETE   | Correct. No reference to D-64, and it does not say that no recovery or re-submission route exists. PE-10                                  |
| R-35 | API_DOCUMENTATION §6 webhooks, line 1593                    | Refund processed / failed → `COMPLETED` / `FAILED`                                                      | CONSISTENT   | C-08                                                                                                                                      |
| R-36 | ADMIN_WORKFLOWS §3.2, line 107                              | Re-authentication for refund approve / retry / complete                                                 | CONSISTENT   | C-06                                                                                                                                      |
| R-37 | ADMIN_WORKFLOWS §9, line 263                                | `ORDER_CANCELLED` now, `REFUND_INITIATED` later (refund `REQUESTED`)                                    | CONSISTENT   | Sent at the later staff approval                                                                                                          |
| R-38 | ADMIN_WORKFLOWS §11.1 diagram, lines 297–305                | `APPROVED → PROCESSING` in the same transaction; bank transfer `APPROVED → COMPLETED`                   | CONSISTENT   | C-01, C-05                                                                                                                                |
| R-39 | ADMIN_WORKFLOWS §11.1 note, lines 309–311                   | Commit-then-call in every path; no automatic recovery; no defined recovery if no refund was issued      | INCOMPLETE   | Correct. No reference to D-64 or to the procedure. PE-12                                                                                  |
| R-40 | ADMIN_WORKFLOWS §11.1 row 5, line 319                       | `PROCESSING` set in the transaction; `REFUND_INITIATED` queued before the gateway call                  | CONSISTENT   | C-09                                                                                                                                      |
| R-41 | ADMIN_WORKFLOWS §11.1 row 6, line 320                       | Completion by webhook: "Signature; amount matches"                                                      | INCONSISTENT | The code does not compare the amount and also completes on the direct gateway result (C-02, C-08). PE-13, OD-09                           |
| R-42 | ADMIN_WORKFLOWS §11.1 row 7, line 321                       | Retry from `FAILED`, max 5, `refunds.update`, re-authentication                                         | CONSISTENT   | C-04, C-06                                                                                                                                |
| R-43 | ADMIN_WORKFLOWS §11.1 row 8 and note, lines 322–324         | `complete` records only; gateway refund from `PROCESSING` after confirmation                            | CONSISTENT   | C-05                                                                                                                                      |
| R-44 | ADMIN_WORKFLOWS §11.2 step 5, line 333                      | "Failed transfer (wrong IFSC) → `FAILED`, staff corrects details and retries"                           | INCONSISTENT | No API path sets a bank-transfer refund to `FAILED` (C-07), so `retry` can never apply. PE-14, OD-10                                      |
| R-45 | ADMIN_WORKFLOWS §21, A21 and A22                            | One gateway refund per approval; gateway failure → `FAILED`, retry                                      | CONSISTENT   | —                                                                                                                                         |
| R-46 | BACKEND_STRUCTURE §5.1, line 336                            | `requireReauth` scope: "refund approve/complete"                                                        | INCONSISTENT | `retry` omitted (same as R-29). PE-16                                                                                                     |
| R-47 | BACKEND_STRUCTURE §11, line 504                             | `Idempotency-Key` on refund approve / retry / complete                                                  | CONSISTENT   | C-06                                                                                                                                      |
| R-48 | BACKEND_STRUCTURE §22 note, line 839                        | Worker stop after commit leaves `PROCESSING`; manual intervention; undefined if no refund issued        | INCOMPLETE   | Correct. No reference to D-64 or to the procedure. PE-15                                                                                  |
| R-49 | NOTIFICATION_WORKFLOWS §3.1, line 116                       | `REFUND_INITIATED` trigger: "Refund → `PROCESSING` (after approval)"                                    | INCOMPLETE   | Sent at approval for every method (bank transfer stays `APPROVED`) and before the gateway call (C-09). No timing caveat. PE-17            |
| R-50 | NOTIFICATION_WORKFLOWS §3.3, lines 135 and 142–148          | Late capture sends no `REFUND_INITIATED`; `REFUND_COMPLETED` only on a recorded completion              | CONSISTENT   | C-09, C-10                                                                                                                                |
| R-51 | USER_WORKFLOWS §16, line 638                                | Late capture, no stock: refunded "(`REFUND_INITIATED`), order stays `PAYMENT_FAILED`"                   | INCONSISTENT | The code cancels the order and sends no `REFUND_INITIATED` (C-09, C-10). PE-18                                                            |
| R-52 | USER_WORKFLOWS §20.1, line 729                              | Self-cancel: auto-`APPROVED` full refund if paid online                                                 | CONSISTENT   | —                                                                                                                                         |
| R-53 | USER_WORKFLOWS §21 diagram, lines 762–763                   | "`APPROVED → PROCESSING`: sent to gateway / bank transfer initiated"                                    | INCOMPLETE   | `PROCESSING` is set before the gateway call, and a bank-transfer refund does not pass through `PROCESSING` (C-01, C-05). PE-19            |
| R-54 | USER_WORKFLOWS §21 table and bullets, lines 770–775         | "Refund initiated" shown for `APPROVED` / `PROCESSING`; bank transfer completed by staff                | CONSISTENT   | C-09, C-05                                                                                                                                |
| R-55 | PROJECT_REQUIREMENTS FR-PAY-010, FR-PAY-013, FR-PAY-014     | Refund lifecycle; manual / bank-transfer completion via `complete`; failed refunds retryable            | CONSISTENT   | —                                                                                                                                         |
| R-56 | PROJECT_REQUIREMENTS FR-PAY-011, line 432                   | "Refund approval/completion requires `refunds.approve`"                                                 | INCONSISTENT | `complete` requires `refunds.update` in the code, the API document and the runbook (C-06). PE-20, OD-08                                   |
| R-57 | PROJECT_REQUIREMENTS FR-AUTH-011, line 496                  | Re-authentication scope: "refund approve/complete"                                                      | INCONSISTENT | `retry` omitted (same as R-29). PE-21                                                                                                     |
| R-58 | PROJECT_REQUIREMENTS AC-09, line 721                        | Self-cancel queues `ORDER_CANCELLED` and `REFUND_INITIATED`                                             | CONSISTENT   | C-09                                                                                                                                      |
| R-59 | `src/jobs/README.md`; PHASE4-REMAINING-DECISIONS            | No statement about refund recovery                                                                      | CONSISTENT   | Nothing to check; nothing contradicts D-64                                                                                                |

## 3. DEC-06 — promotion `EXPIRED` consistency (D-63)

### 3.1 Current code behaviour (verified by reading; not executed)

Read in `src/modules/promotions/promotions.service.ts` (`update` 224–304, `remove` 306–325, `pause`
327–339, `resume` 341–356), `promotions.rules.ts` (`scheduleStatus` 68–76, `effectiveStatus` 78–86,
`canPause`, `canDelete`), `promotions.schemas.ts`, `promotions.mapper.ts`, `promotions.routes.ts`,
`pricing.loader.ts` (280–309) and `src/jobs/promotionActivation.ts`.

**How status works.**

- `effectiveStatus` re-derives the status from the dates **only** when the stored status is
  `SCHEDULED` or `ACTIVE`. A stored `DRAFT`, `PAUSED` or `EXPIRED` is returned unchanged.
- Pricing loads only rows whose stored status is `SCHEDULED` / `ACTIVE` and whose dates include now.
- The activation job selects only stored `SCHEDULED` / `ACTIVE` rows.

**Case A — editing the dates of a promotion whose stored status is `EXPIRED`.**

- `PATCH` without a `status` field is **accepted**. The new dates are saved, and so is any other
  field (name, discount, targets, priority). Audit action `UPDATE`.
- The status **stays `EXPIRED`**: `update` recomputes the status only when it is `SCHEDULED` or
  `ACTIVE` (line 268).
- `PATCH` with a `status` field (`DRAFT` or `SCHEDULED`) is rejected with 409
  `INVALID_STATE_TRANSITION` (lines 260–266).
- The promotion is not priced, not touched by the job, and cannot be paused or resumed.
- Result: **not revived; consistent with D-63.** Side effect: the row can show `EXPIRED` with an end
  date in the future.

**Case B — editing a promotion stored `ACTIVE` (or `SCHEDULED`) whose `ends_at` has passed.**

- Its effective status is `EXPIRED`, but the stored status is unchanged until the activation job
  writes it.
- `PATCH` that moves `endsAt` into the future, without a `status` field, is **accepted**. Line 269
  calls `scheduleStatus` with the **new** dates and returns `ACTIVE` (or `SCHEDULED`). The promotion
  is priced again at once. **This revives it and contradicts D-63.**
- The audit row is a plain `UPDATE` with the date change. No `STATUS_CHANGE` is recorded, because
  the stored status did not change.
- The job's compare-and-set matches the dates as read (D1), so it does not undo the edit.
- `PATCH` with a `status` field is rejected with 409 (effective status is `EXPIRED`).
- `PATCH` that leaves the past dates in place (for example a name change) stores `EXPIRED`, which is
  then final.
- The window is **not** bounded to one minute. The job runs only in the worker, which is off by
  default (`JOBS_ENABLED` defaults to `false`, `src/core/config/env.ts` line 163); it handles at most
  200 rows per run and skips rows that fail.

**Case C — resuming a `PAUSED` promotion after `ends_at`.**

- `resume` requires the stored status `PAUSED`. It is accepted (200) and stores
  `scheduleStatus(startsAt, endsAt, now)` = **`EXPIRED`**. Audit `STATUS_CHANGE`,
  `promotion.resumed`. The promotion is then final. Consistent with D-63.
- Not covered by D-63's wording: a `PAUSED` promotion is never reported as `EXPIRED`, and the job
  never touches it. Its dates can be edited while paused (status stays `PAUSED`), and a later
  `resume` then returns `ACTIVE` / `SCHEDULED`. A promotion paused before its end date and left
  past it can therefore be extended and reactivated.

**Case D — pause.** Allowed only when the effective status is `ACTIVE` or `SCHEDULED`. A promotion
that is effectively `EXPIRED` (stored or by date) → 409 `INVALID_STATE_TRANSITION`.

**Case E — delete.**

- Allowed when the **effective** status is `DRAFT`, `SCHEDULED` or `EXPIRED` **and** no order item
  references the promotion. It is a soft delete (`deleted_at`); audit `DELETE`.
- Otherwise 409 `CONFLICT` with `details[].code = IN_USE`. `ACTIVE` and `PAUSED` promotions can
  never be deleted.
- The name of a deleted promotion stays reserved (names are unique, including soft-deleted rows).

**Other facts.**

- `POST` rejects `endsAt ≤ now` (422), so a promotion cannot be created already expired.
- A `DRAFT` with a past end date that is published (`PATCH status: SCHEDULED`) is stored `EXPIRED`.
- There is no "duplicate promotion" route. D-63 says "duplicate it instead"; today that means
  creating a new promotion with a different name.

### 3.2 Consistency table

| ID   | Document / section                                         | Statement                                                                                            | Status       | Note                                                                                                                                   |
| ---- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| P-01 | PHASE4-JOBS-AND-SCHEDULING §2, line 27                     | `promotion-activation`: `SCHEDULED→ACTIVE`, `→EXPIRED`; compare-and-set + SYSTEM audit               | CONSISTENT   | Matches the job                                                                                                                        |
| P-02 | PHASE4-JOBS-AND-SCHEDULING §3, line 42                     | Reads evaluate dates; D1: a date edit in between makes the job's write a no-op                       | INCOMPLETE   | Correct. Does not record D-63 or that D1 lets a case B edit stand. PE-28                                                               |
| P-03 | PHASE4-JOBS-AND-SCHEDULING §4, line 58                     | Lost compare-and-set → no audit row; per-item failure counted                                        | CONSISTENT   | —                                                                                                                                      |
| P-04 | `src/jobs/README.md`, line 20                              | `promotion-activation` (1 min), scheduled                                                            | CONSISTENT   | Name and interval only                                                                                                                 |
| P-05 | PHASE4-REMAINING-USER-DECISIONS §2, DEC-06-impl            | Discrepancy: an update before the job writes `EXPIRED` can extend `ends_at` and revive the promotion | INCOMPLETE   | Accurate (case B). Missing: case A is already compliant, the window is unbounded with the worker off, and case C. PE-29                |
| P-06 | PHASE4-CONSOLIDATED-DECISION-PACKAGE status, line 16       | DEC-06 → A (rule adopted; implementation discrepancy recorded)                                       | CONSISTENT   | Matches D-63                                                                                                                           |
| P-07 | PHASE4-CONSOLIDATED-DECISION-PACKAGE summary, line 33      | "A: EXPIRED is final"                                                                                | CONSISTENT   | —                                                                                                                                      |
| P-08 | PHASE4-CONSOLIDATED-DECISION-PACKAGE DEC-06, lines 127–129 | "Editing `ends_at` into the future could therefore make an expired promotion active again"           | INCOMPLETE   | True only while the stored status is still `SCHEDULED` / `ACTIVE` (case B), not for a stored `EXPIRED` (case A). PE-30                 |
| P-09 | PHASE4-CONSOLIDATED-DECISION-PACKAGE DEC-06, line 133      | Option A: reject edits that would revive it; duplicate instead                                       | CONSISTENT   | Rule adopted by D-63; guard not implemented and not authorized                                                                         |
| P-10 | API_DOCUMENTATION §4.9, lines 1312–1313                    | List filters; create: the server derives `SCHEDULED` / `ACTIVE` from the dates                       | CONSISTENT   | Create rejects a past `endsAt`                                                                                                         |
| P-11 | API_DOCUMENTATION §4.9, line 1314                          | `PATCH` / `DELETE`: delete only `DRAFT` / `SCHEDULED` / `EXPIRED` never applied to orders, else 409  | INCOMPLETE   | Delete rule matches case E. Nothing says `EXPIRED` is final or how `PATCH` treats an expired promotion. PE-22                          |
| P-12 | API_DOCUMENTATION §4.9, line 1315                          | Pause: `ACTIVE` / `SCHEDULED → PAUSED`, else 409                                                     | CONSISTENT   | Case D                                                                                                                                 |
| P-13 | API_DOCUMENTATION §4.9, line 1316                          | Resume: `PAUSED → ACTIVE` (or `SCHEDULED` / `EXPIRED` per dates)                                     | CONSISTENT   | Case C                                                                                                                                 |
| P-14 | ADMIN_WORKFLOWS §14.1 diagram, lines 404–413               | `EXPIRED` has no outgoing transition                                                                 | CONSISTENT   | Matches D-63. The diagram omits pause from `SCHEDULED` and resume into `SCHEDULED` / `EXPIRED`                                         |
| P-15 | ADMIN_WORKFLOWS §14.1 row 2, line 418                      | Edit: changing an `ACTIVE` promotion's discount is allowed and audited                               | INCOMPLETE   | Nothing about editing an expired promotion. PE-23                                                                                      |
| P-16 | ADMIN_WORKFLOWS §14.1 row 3, line 419                      | "Resume only if `now < endsAt`"                                                                      | INCONSISTENT | The code accepts the resume after `endsAt` and stores `EXPIRED` (case C). API_DOCUMENTATION line 1316 says the same as the code. PE-24 |
| P-17 | ADMIN_WORKFLOWS §14.1 row 4, line 420                      | Delete: "Only DRAFT/SCHEDULED/EXPIRED"                                                               | INCOMPLETE   | Omits "never applied to an order" (case E). PE-25                                                                                      |
| P-18 | ADMIN_WORKFLOWS §14.2, line 429; §21 A29                   | A job flips `SCHEDULED→ACTIVE→EXPIRED` every minute; status also derived at read time                | CONSISTENT   | Status content is right. "BullMQ" is target design, superseded by D-61 (outside this review)                                           |
| P-19 | BACKEND_STRUCTURE §14, line 617                            | `promotion-activation`: `ACTIVE → EXPIRED` when `ends_at ≤ now`; status compare-and-set              | INCOMPLETE   | Correct as far as it goes. No D-63 statement. PE-27                                                                                    |
| P-20 | PROJECT_REQUIREMENTS FR-PRM-003, line 476                  | Status derived (`SCHEDULED`, `ACTIVE`, `EXPIRED`) plus manual `PAUSED`                               | INCOMPLETE   | "Derived" alone suggests a date edit re-derives the status. No D-63 statement. PE-26                                                   |

No statement about promotion status or expiry was found in PHASE4-REMAINING-DECISIONS,
PHASE3-PHASE4-MASTER-PROGRESS-REPORT §16, DEPLOYMENT_AND_OPERATIONS, NOTIFICATION_WORKFLOWS or
USER_WORKFLOWS.

## 4. Proposed edits

Rules applied:

- Nothing below is applied. The orchestrator decides and applies.
- Historical statements are kept; corrections are dated notes.
- Every BEFORE string was checked to occur exactly once in its file on 2026-11-24.
- Edits to `project-documentation` files are single-line replacements or single inserted lines.
  Those files are not run through Prettier.
- Priority: **P1** corrects a statement that contradicts the code or a decision; **P2** adds the
  missing D-63 / D-64 statement or reference; **P3** is an adjacent consistency fix (R-15).
- No edit describes the promotions guard or a refund re-submission as implemented or approved.

Paths are relative to the workspace root `C:/Users/sumes/OneDrive/Desktop/ecommerce-workspace`.

### 4.1 DEC-05 — refund recovery

#### PE-01 (P1) — `ecommerce-api/docs/operations/DEPLOYMENT_AND_OPERATIONS.md`, §9, line 82

BEFORE:

```text
**Operational rules (no further procedure is defined):**
```

AFTER:

```text
**Operational rules.** _(Updated 2026-11-24: the manual procedure adopted by D-64 is in §9.1. This line previously read "no further procedure is defined".)_
```

Why: §9.1 of the same file defines the procedure (finding R-03).

#### PE-02 (P1) — `ecommerce-api/docs/operations/DEPLOYMENT_AND_OPERATIONS.md`, §9.1 step 1, line 110

BEFORE:

```text
   - A `PROCESSING` refund **with** a provider refund id is waiting for the gateway result: leave it alone.
```

AFTER (two lines):

```text
   - A `PROCESSING` refund **with** a provider refund id is normally waiting for the gateway result: leave it alone.
   - _(Added 2026-11-24.)_ Exception for retried refunds (`retryCount` above 0): a retry does not clear the provider refund id stored by an earlier attempt. If the timeline shows `PROCESSING` later than `FAILED` and that time is well in the past, the id may belong to the failed attempt. Treat the refund as a candidate and continue with step 2.
```

Why: finding R-08. Sequence in code: the first gateway call returns a pending result with a provider
refund id (stored); the refund webhook then fails the refund; an admin retry sets `PROCESSING` again
without clearing the id (`prepareGatewayRefund` writes only status, `processingAt` and
`failureReason`); an interruption before the new gateway call leaves `PROCESSING` with the old id.
The refund detail exposes `retryCount`, `providerRefundId` and the timeline. The edit adds no new
action; it only widens which refunds are checked at the provider.

#### PE-03 (P2) — `ecommerce-api/docs/operations/DEPLOYMENT_AND_OPERATIONS.md`, §9.1 step 2, line 112

BEFORE:

```text
   - Look the refund up in the payment provider's dashboard or API using the refund id. The API sends it as the refund reference / idempotency key.
```

AFTER:

```text
   - Look the refund up in the payment provider's dashboard or API using the refund id. This is the `id` (UUID) shown in the refund detail, not the `RFD-…` refund number _(clarified 2026-11-24)_. The API sends it as the refund reference / idempotency key.
```

Why: finding R-09. `executeGatewayRefund` passes `refundId: job.refundId`, the row id.

#### PE-04 (P2) — `ecommerce-api/docs/operations/DEPLOYMENT_AND_OPERATIONS.md`, §9.1 step 3, line 116

BEFORE (end of the first bullet):

```text
`REFUND_COMPLETED` notification). It does **not** call the gateway.
```

AFTER:

```text
`REFUND_COMPLETED` notification). It does **not** call the gateway. _(Added 2026-11-24.)_ The request needs an `Idempotency-Key` header; `utr` accepts 1–40 characters; `transferredAt` must not be in the future. The value is stored as the payout reference, not as the provider refund id. A provider reference longer than 40 characters cannot be recorded this way; handling of that case is not defined.
```

Why: finding R-10. The limits come from `CompleteRefundBody` and the route. See OD-06.

#### PE-05 (P1) — `ecommerce-api/docs/PHASE4-JOBS-AND-SCHEDULING.md`, §6a item 5, line 97

BEFORE:

```text
   - **Flows.** It applies to four flows:
```

AFTER:

```text
   - **Flows.** It applies to five code paths _(count aligned 2026-11-24 with D-64 and the runbook §9; previously "four flows")_. Four are listed here and the fifth, the admin retry, is named below:
```

Why: finding R-15. The list and the retry sentence below it stay unchanged.

#### PE-06 (P2) — `ecommerce-api/docs/PHASE4-JOBS-AND-SCHEDULING.md`, §6a item 5, line 106

BEFORE:

```text
This is a procedural rule, not enforced by code.
```

AFTER:

```text
This is a procedural rule, not enforced by code. _(Added 2026-11-24.)_ The manual procedure adopted by D-64 is in `docs/operations/DEPLOYMENT_AND_OPERATIONS.md` §9.1: the provider-side status is established before any action. A "re-submit gateway refund" action is a proposal only and does not exist.
```

Why: finding R-17.

#### PE-07 (P2) — `ecommerce-api/docs/PHASE3-PHASE4-MASTER-PROGRESS-REPORT.md`, §16, insert after line 394

Line 394 is the end of the M-1 bullet and stays unchanged:

```text
  `docs/PHASE4-BATCH9-PRE-ACCEPTANCE-FINAL-DOCUMENTATION-FIX-REPORT.md` §3.
```

INSERT as a new bullet directly after it:

```text
- **Update 2026-11-24 (D-64, decided 2026-11-21).** The M-1 limitation is unchanged in code. A manual recovery procedure is adopted: `docs/operations/DEPLOYMENT_AND_OPERATIONS.md` §9.1. The provider-side status is established first; `complete` only records a provider-confirmed completed refund; recovery stays undefined when no refund was issued. There is no automatic recovery and no re-submission action.
```

Why: finding R-27. The 2026-11-20 record is not rewritten.

#### PE-08 (P2) — `ecommerce-api/docs/PHASE4-CONSOLIDATED-DECISION-PACKAGE.md`, DEC-05, line 93

BEFORE:

```text
If the process stops in between, the refund stays `PROCESSING` with no provider refund id.
```

AFTER:

```text
If the process stops in between, the refund stays `PROCESSING` with no provider refund id. _(Note 2026-11-24: after an admin retry, the provider refund id of an earlier failed attempt can still be stored; see the runbook §9.1 step 1.)_
```

Why: finding R-24. Apply only together with PE-02.

#### PE-09 (P1) — `project-documentation/04-backend/API_DOCUMENTATION.md`, §4.11 approve row, line 1358

BEFORE:

```text
`REQUESTED → APPROVED → PROCESSING` (gateway call post-commit).
```

AFTER:

```text
`REQUESTED → APPROVED`. A gateway refund (original payment method) is then set `PROCESSING` in the same transaction and the gateway call runs post-commit; a bank-transfer refund stays `APPROVED` until `complete` *(clarified 2026-11-24; previously "`REQUESTED → APPROVED → PROCESSING` (gateway call post-commit)")*.
```

Why: finding R-31. D-64 requires gateway and bank-transfer refunds to be told apart.

#### PE-10 (P2) — `project-documentation/04-backend/API_DOCUMENTATION.md`, §4.11, line 1363

BEFORE (end of the paragraph):

```text
so its delivery does not prove that a gateway refund was issued or completed.
```

AFTER:

```text
so its delivery does not prove that a gateway refund was issued or completed. *(Added 2026-11-24, D-64.)* A gateway refund left `PROCESSING` by an interruption is handled only by the manual procedure in `ecommerce-api/docs/operations/DEPLOYMENT_AND_OPERATIONS.md` §9.1, which establishes the provider-side status first. There is no automatic recovery and no re-submission route.
```

Why: finding R-34.

#### PE-11 (P3) — `project-documentation/04-backend/API_DOCUMENTATION.md`, §2, line 219

BEFORE:

```text
Scope per PROJECT_CONTEXT §15 R-15: refund approve/complete,
```

AFTER:

```text
Scope per PROJECT_CONTEXT §15 R-15: refund approve/retry/complete *(retry added 2026-11-24 to match R-15 and the route)*,
```

Why: finding R-29. R-15 reads "refund approve/retry/complete".

#### PE-12 (P2) — `project-documentation/06-workflows/ADMIN_WORKFLOWS.md`, §11.1 note, insert after line 311

Line 311 starts with the text below and stays unchanged:

```text
> - The complete route records an already-completed refund and never calls the gateway.
```

INSERT as a new line directly after line 311:

```text
> - **D-64 (decided 2026-11-21; note added 2026-11-24):** the manual recovery procedure for an interrupted gateway refund is `ecommerce-api/docs/operations/DEPLOYMENT_AND_OPERATIONS.md` §9.1. The provider-side status must be established before any action. There is no automatic recovery; a "re-submit gateway refund" action is a proposal only and is not implemented.
```

Why: finding R-39.

#### PE-13 (P1) — `project-documentation/06-workflows/ADMIN_WORKFLOWS.md`, §11.1 row 6, line 320

BEFORE:

```text
| — | Signature; amount matches |
```

AFTER:

```text
| — | Signature; amount matches *(2026-11-24: the current code matches the refund by provider refund id and does not compare the amount; a `COMPLETED` result of the post-commit gateway call also completes the refund)* |
```

Why: finding R-41. The design text is kept; the note records the difference. See OD-09.

#### PE-14 (P1) — `project-documentation/06-workflows/ADMIN_WORKFLOWS.md`, §11.2 step 5, line 333

BEFORE:

```text
5. Failed transfer (wrong IFSC) → `FAILED`, staff corrects details and retries.
```

AFTER:

```text
5. Failed transfer (wrong IFSC) → `FAILED`, staff corrects details and retries. *(2026-11-24: not implemented. No API path sets a bank-transfer refund to `FAILED`, and `retry` accepts only `FAILED`; the refund stays `APPROVED` until `complete`.)*
```

Why: finding R-44. See OD-10.

#### PE-15 (P2) — `project-documentation/04-backend/BACKEND_STRUCTURE.md`, §22 note, line 839

BEFORE (end of the line):

```text
Known limitation M-1. *(State corrected 2026-11-20; previously given as `approved`. Recovery wording clarified 2026-11-20.)*
```

AFTER:

```text
Known limitation M-1. *(State corrected 2026-11-20; previously given as `approved`. Recovery wording clarified 2026-11-20.)* *(Added 2026-11-24, D-64:)* the manual recovery procedure is `ecommerce-api/docs/operations/DEPLOYMENT_AND_OPERATIONS.md` §9.1; there is no automatic recovery and no re-submission action.
```

Why: finding R-48.

#### PE-16 (P3) — `project-documentation/04-backend/BACKEND_STRUCTURE.md`, §5.1 row 8, line 336

BEFORE:

```text
(refund approve/complete, tax settings and rates,
```

AFTER:

```text
(refund approve/retry/complete *(retry added 2026-11-24 to match R-15)*, tax settings and rates,
```

Why: finding R-46.

#### PE-17 (P1) — `project-documentation/06-workflows/NOTIFICATION_WORKFLOWS.md`, §3.1, line 116

BEFORE:

```text
| `REFUND_INITIATED` | Refund → `PROCESSING` (after approval) |
```

AFTER:

```text
| `REFUND_INITIATED` | Refund approved (staff approval, or auto-approved customer self-cancel). Queued in that transaction, **before** any gateway call: a gateway refund is `PROCESSING` and a bank-transfer refund `APPROVED` at that point, so delivery does not prove a refund was issued *(clarified 2026-11-24; previously "Refund → `PROCESSING` (after approval)"; late capture: §3.3)* |
```

Why: finding R-49.

#### PE-18 (P1) — `project-documentation/06-workflows/USER_WORKFLOWS.md`, §16 late-capture row, line 638

BEFORE:

```text
payment auto-refunded in full (`REFUND_INITIATED`), order stays `PAYMENT_FAILED`, customer notified with apology |
```

AFTER:

```text
payment auto-refunded in full (`REFUND_INITIATED`), order stays `PAYMENT_FAILED`, customer notified with apology *(2026-11-24, current implementation: the order becomes `CANCELLED` and an `ORDER_CANCELLED` notification is queued; no `REFUND_INITIATED` is sent for this flow — NOTIFICATION_WORKFLOWS §3.3, OQ-59 open)* |
```

Why: finding R-51. The design text is kept; OQ-59 stays open.

#### PE-19 (P2) — `project-documentation/06-workflows/USER_WORKFLOWS.md`, §21, insert after line 777

Line 777 stays unchanged:

```text
- Store credit/wallet: not in v1 (OQ-13).
```

INSERT as a new line directly after it:

```text
- *(Added 2026-11-24, aligned with the implementation.)* A gateway refund is recorded as `PROCESSING` before the gateway call is made; a bank-transfer refund stays `APPROVED` until staff record the UTR. `REFUND_INITIATED` is queued at approval / self-cancel, so "Refund initiated" does not prove that the gateway refund was issued (ADMIN_WORKFLOWS §11.1).
```

Why: finding R-53. The diagram is not edited.

#### PE-20 (P1, needs owner confirmation) — `project-documentation/01-requirements/PROJECT_REQUIREMENTS.md`, FR-PAY-011, line 432

BEFORE (last cell of the row):

```text
Without reauth → `403 REAUTH_REQUIRED`. |
```

AFTER:

```text
Without reauth → `403 REAUTH_REQUIRED`. *(2026-11-24: in the current implementation and API_DOCUMENTATION §4.11, `complete` and `retry` require `refunds.update` + re-auth; `approve` and `reject` require `refunds.approve`. Owner confirmation pending.)* |
```

Why: finding R-56. The requirement text is not changed; the note records the difference. See OD-08.

#### PE-21 (P3) — `project-documentation/01-requirements/PROJECT_REQUIREMENTS.md`, FR-AUTH-011, line 496

BEFORE:

```text
(`POST /admin/auth/reauth`): refund approve/complete,
```

AFTER:

```text
(`POST /admin/auth/reauth`): refund approve/retry/complete *(retry added 2026-11-24 to match R-15)*,
```

Why: finding R-57.

### 4.2 DEC-06 — promotion `EXPIRED`

#### PE-22 (P1) — `project-documentation/04-backend/API_DOCUMENTATION.md`, §4.9, line 1318

BEFORE:

```text
Promotion changes never alter placed orders (snapshots).
```

AFTER:

```text
Promotion changes never alter placed orders (snapshots). *(Added 2026-11-24, D-63.)* An `EXPIRED` promotion is final: editing its dates does not revive it; create a new promotion instead (no duplicate route exists and names are unique). Current implementation: `PATCH` on a promotion whose stored status is `EXPIRED` saves the fields and leaves the status `EXPIRED`; a `status` field is accepted only while the current status is `DRAFT` or `SCHEDULED`, else 409 `INVALID_STATE_TRANSITION`. Known discrepancy, correction not authorized: while the stored status is still `SCHEDULED` / `ACTIVE` after `endsAt`, a `PATCH` that moves `endsAt` into the future makes the promotion effective again.
```

Why: finding P-11. This is the one place where the rule and the discrepancy are stated in full; the
other promotion edits refer to it.

#### PE-23 (P2) — `project-documentation/06-workflows/ADMIN_WORKFLOWS.md`, §14.1 row 2, line 418

BEFORE (end of the row):

```text
carts re-price on next read (customers may see `PRICE_CHANGED` at checkout) |
```

AFTER:

```text
carts re-price on next read (customers may see `PRICE_CHANGED` at checkout). An `EXPIRED` promotion is final (D-63): editing its dates does not revive it; create a new promotion instead *(added 2026-11-24; implementation discrepancy: API_DOCUMENTATION §4.9)* |
```

Why: finding P-15. Apply together with PE-22.

#### PE-24 (P1) — `project-documentation/06-workflows/ADMIN_WORKFLOWS.md`, §14.1 row 3, line 419

BEFORE:

```text
| Resume only if `now < endsAt` |
```

AFTER:

```text
| Pause from `ACTIVE` / `SCHEDULED`. Resume from `PAUSED` only: the status is re-derived from the dates (`SCHEDULED` / `ACTIVE`); when `now ≥ endsAt` the call succeeds and stores `EXPIRED`, which is final (D-63) *(corrected 2026-11-24 to match the implementation; previously "Resume only if `now < endsAt`")* |
```

Why: finding P-16.

#### PE-25 (P2) — `project-documentation/06-workflows/ADMIN_WORKFLOWS.md`, §14.1 row 4, line 420

BEFORE:

```text
| Only DRAFT/SCHEDULED/EXPIRED; orders keep snapshots |
```

AFTER:

```text
| Only DRAFT/SCHEDULED/EXPIRED and never applied to an order, else 409 `IN_USE` *(aligned 2026-11-24 with API_DOCUMENTATION §4.9)*; orders keep snapshots |
```

Why: finding P-17.

#### PE-26 (P2) — `project-documentation/01-requirements/PROJECT_REQUIREMENTS.md`, FR-PRM-003, line 476

BEFORE (end of the row):

```text
activation/expiry takes effect within 1 min and invalidates caches. | M | [CONFIRMED] | — |
```

AFTER:

```text
activation/expiry takes effect within 1 min and invalidates caches. | M | [CONFIRMED] | `EXPIRED` is final: not revived by editing dates (D-63, 2026-11-21; note added 2026-11-24). Implementation alignment pending. |
```

Why: finding P-20. Only the empty notes cell changes.

#### PE-27 (P2) — `project-documentation/04-backend/BACKEND_STRUCTURE.md`, §14 `promotion-activation` row, line 617

BEFORE (last cell of the row):

```text
| Status compare-and-set update. |
```

AFTER:

```text
| Status compare-and-set update. *(Added 2026-11-24, D-63:)* a stored `EXPIRED` is final and is never selected again by this job; the implementation discrepancy for date edits made before `EXPIRED` is stored is recorded in API_DOCUMENTATION §4.9. |
```

Why: finding P-19. Apply together with PE-22.

#### PE-28 (P2) — `ecommerce-api/docs/PHASE4-JOBS-AND-SCHEDULING.md`, §3 `promotion-activation`, line 42

BEFORE (end of the paragraph):

```text
§14's cache invalidation is not needed (no cache exists).
```

AFTER:

```text
§14's cache invalidation is not needed (no cache exists). _(Added 2026-11-24, D-63.)_ A stored `EXPIRED` is final: the job never selects such a row, and a `PATCH` leaves it `EXPIRED` even when the dates are edited. Known discrepancy: while the stored status is still `SCHEDULED` / `ACTIVE` after `ends_at` (the job has not run yet, or no worker is running), a `PATCH` that moves `ends_at` into the future makes the promotion effective again. No correction is authorized (DEC-06-impl).
```

Why: finding P-02.

#### PE-29 (P2) — `ecommerce-api/docs/PHASE4-REMAINING-USER-DECISIONS.md`, §2 DEC-06-impl row, line 42

BEFORE (end of the options cell):

```text
(409 `INVALID_STATE_TRANSITION`), with a test. Authorize?
```

AFTER:

```text
(409 `INVALID_STATE_TRANSITION`), with a test. Authorize? _(Added 2026-11-24, code re-read.)_ Already in line with D-63: a promotion whose **stored** status is `EXPIRED` is not revived by `PATCH` (the dates are saved, the status stays `EXPIRED`), and resuming a `PAUSED` promotion after `ends_at` stores `EXPIRED`. The window is not limited to one minute when no worker is running (`JOBS_ENABLED=false` is the default). Not covered by the proposed fix: a `PAUSED` promotion past `ends_at` can have its dates extended and then be resumed.
```

Why: finding P-05. The question stays open; the note only makes it precise.

#### PE-30 (P2) — `ecommerce-api/docs/PHASE4-CONSOLIDATED-DECISION-PACKAGE.md`, DEC-06, insert after line 129

Line 129 stays unchanged:

```text
`ends_at` into the future could therefore make an expired promotion active again.
```

INSERT after it (a blank line, then the note):

```text
> **Clarification (2026-11-24, code re-read).** The last sentence holds only while the **stored** status is still `SCHEDULED` / `ACTIVE` after `ends_at`. Once `EXPIRED` is stored (activation job, resume, or a `PATCH` that keeps the past dates), a date edit is accepted but the status stays `EXPIRED`. D-63 adopted option A as the rule; the service guard is not authorized (DEC-06-impl).
```

Why: finding P-08. The decision record itself is not rewritten.

## 5. Items that need an owner decision

Nothing here is decided or recommended as approved.

| ID    | Topic                                    | Question                                                                                                                                                                                                                      | Related      |
| ----- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| OD-01 | DEC-06-impl: promotions guard            | Authorize a correction for case B or not. If yes, its scope: reject only date edits of an effectively expired promotion, or every edit of one (today a stored `EXPIRED` promotion can still be edited without being revived)? | D-63, P-05   |
| OD-02 | `PAUSED` promotion past `ends_at`        | Is a promotion that passed its end date while paused "expired" under D-63? Today its dates can be extended and it can then be resumed. The guard proposed in DEC-06-impl would not stop this                                  | Case C       |
| OD-03 | "Duplicate it instead"                   | D-63 names duplication as the alternative. No duplicate route exists and names are unique (a deleted promotion keeps its name reserved). Is a new promotion created by hand acceptable, or is a duplicate action wanted?      | D-63         |
| OD-04 | Refund: no refund issued at the provider | Recovery stays undefined (D-64). The "re-submit gateway refund" action remains a proposal (DEC-05-next); it needs the payment vendor (OQ-06)                                                                                  | D-64         |
| OD-05 | Refund: staleness threshold              | The runbook gives "more than 30 minutes" as an example and says to agree it with finance. No value is agreed                                                                                                                  | Runbook §9.1 |
| OD-06 | Refund: provider reference in `complete` | `utr` is limited to 40 characters and is stored as the payout reference, not the provider refund id. What should staff do when the provider reference is longer (the mock adapter's is 46 characters)?                        | R-10, PE-04  |
| OD-07 | Refund: retried refunds with an old id   | Confirm the rule proposed in PE-02 for refunds that keep an earlier attempt's provider refund id, including who decides that a refund is stale                                                                                | R-08         |
| OD-08 | Permission for refund completion         | FR-PAY-011 says completion requires `refunds.approve`. The code, the API document and the runbook use `refunds.update`. Which is intended?                                                                                    | R-56, PE-20  |
| OD-09 | Refund webhook amount check              | ADMIN_WORKFLOWS §11.1 row 6 requires "amount matches". The code does not compare the amount on a refund webhook. Is the check required?                                                                                       | R-41, PE-13  |
| OD-10 | Failed bank transfer                     | ADMIN_WORKFLOWS §11.2 step 5 describes `FAILED` and retry for a bank transfer. No route can record that failure. Is it needed?                                                                                                | R-44, PE-14  |
| OD-11 | `REFUND_INITIATED` timing                | Still open: whether the premature notification is acceptable (RK-05), and whether late-capture refunds should send it (OQ-59)                                                                                                 | R-18, R-50   |

## 6. Method and limits

**Method.**

1. Read D-62 … D-66 in PROJECT_CONTEXT §17.8, and R-13, R-15 and R-16 in §15.
2. Read the refund, payment, order-cancellation, reconciliation and promotion code named in §2.1 and
   §3.1, and derived the reference facts from it.
3. Searched each listed document for refund recovery, `PROCESSING`, `complete`, `retry`,
   `REFUND_INITIATED`, and for promotion status, `EXPIRED` and editing. Read every matching passage in
   full, including long table rows.
4. Compared each statement with the decision and the code facts.
5. Checked that each BEFORE string occurs exactly once in its file (read-only search).

**Limits.**

- Behaviour is established by reading code. No test, build, database or network call was run, so
  nothing here is runtime evidence. `manualRecoveryContract.test.ts` and `promotions.test.ts` were
  read, not executed.
- Only the mock payment adapter exists (OQ-06). Statements about a real provider's refund lookup,
  idempotency and reference format cannot be verified.
- Line numbers are those read on 2026-11-24. If another agent edits a file first, the BEFORE strings
  still identify the place; the line numbers may shift. DEPLOYMENT_AND_OPERATIONS is owned by another
  agent, so PE-01 … PE-04 are proposals to that owner.
- Counting: one row per statement or tightly related group of statements. Rows could be split
  differently; the findings would not change.
- Outside this review's scope, seen and not assessed: API_DOCUMENTATION §4.11 says approval restocks
  lines, while the code never moves stock on a refund; ADMIN_WORKFLOWS §14.1 gives `priority` 0–1000
  while the code accepts 1–100; ADMIN_WORKFLOWS §14.2 names BullMQ; USER_WORKFLOWS line 639 says a
  duplicate capture is refunded automatically, while the code records it for staff review.
- No `.env` file was opened. No Git command was run. No file other than this report was created or
  changed.
