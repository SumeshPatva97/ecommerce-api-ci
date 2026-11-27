# Phase 4 Master — Agent 3: Payment Reconciliation (WP10-3)

| Field         | Value                                                                        |
| ------------- | ---------------------------------------------------------------------------- |
| Date          | 2026-11-24                                                                   |
| Scope         | Batch 10, WP10-3 only: reconciliation-level late-capture tests               |
| Definition    | `PHASE4-BATCH10-TECHNICAL-REVIEW-AND-PROPOSAL.md` §3, row WP10-3             |
| Evidence type | Offline / mocked only (mocked Prisma, mock gateway). No database, no network |

## 1. Status

**WP10-3: COMPLETE**

The two tests written on 2026-11-21 already met the WP10-3 row of the proposal (both paths, with the
refund call). They did not cover every scenario in this step's brief, so 12 test cases were added.
No source file was changed and no defect was found.

## 2. What existed and what was added

Before this step the file had 14 tests, 2 of them for WP10-3:

- "stock-out: PAYMENT_FAILED order without stock → cancelled and refunded via the mock gateway"
- "cancelled order: a capture found by reconciliation is fully refunded via the mock gateway"

Gaps found in those two tests:

- Post-commit ordering was only compared with the **start** of the first transaction. A refund called
  inside the transaction would also have passed.
- Ledger writes were not asserted: only the final refund status and payment status were checked.
- No provider-failure case and no duplicate-refund case existed at reconciliation level.

Added: 12 test cases (8 `it` / `it.each` blocks), all named with the `WP10-3:` prefix, inside the
existing `WP10-3` describe block. The file now has 26 tests. Existing tests and assertions are
unchanged.

## 3. Scenario results

"Both paths" means the test runs twice: stock-out (PAYMENT_FAILED order) and capture on a CANCELLED
order.

| #   | Scenario                                          | Test                                                                                                                                                     | Result |
| --- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Late capture after deallocation is detected       | Existing "stock-out: …"; new "WP10-3: a late capture for a deallocated PAYMENT_FAILED order is detected, takes no stock and cancels the order"           | PASS   |
| 2   | Order cancelled, reason recorded                  | Same two tests: status `CANCELLED`, reason `LATE_CAPTURE_STOCK_UNAVAILABLE`, one history row `PAYMENT_FAILED → CANCELLED` by SYSTEM                      | PASS   |
| 3   | Refund executed after the capture commit          | New "WP10-3: … — the gateway refund runs after the capture transaction commits, outside any transaction" (both paths)                                    | PASS   |
| 4   | Late capture on a CANCELLED order → refund        | Existing "cancelled order: …"; the new both-path tests in rows 3, 6 and 8                                                                                | PASS   |
| 5   | Mock gateway refund invoked                       | Existing two tests: called once with the gateway payment id, `amountMinor` 349600, `INR`, `refundId` = our refund id                                     | PASS   |
| 6   | Ledger entries                                    | New "WP10-3: … — ledger: refund APPROVED → PROCESSING → COMPLETED, REFUND transaction row, payment and order totals" (both paths)                        | PASS   |
| 7   | Provider failure                                  | New "WP10-3: provider failure (gateway refund throws / returns FAILED) — refund ends FAILED, the run does not crash and continues with the next payment" | PASS   |
| 7   | Failed refund is retryable                        | New "WP10-3: a FAILED late-capture refund is retryable with the same gateway idempotency key"                                                            | PASS   |
| 7   | Failure while recording the refund result         | New "WP10-3: a failure while recording the refund result is logged for staff review and does not crash the run"                                          | PASS   |
| 8   | Duplicate refund prevention                       | New "WP10-3: … — duplicate prevention: re-running reconciliation creates no second refund or gateway refund call" (both paths)                           | PASS   |
| 8   | Duplicate refund prevention after a FAILED refund | New "WP10-3: duplicate prevention after a FAILED refund — a re-run neither creates a second refund nor calls the gateway again"                          | PASS   |

What the new tests assert, as the code writes it:

- **Ordering (3).** When the gateway refund is called: no transaction is open, exactly one
  transaction has committed, the payment is `CAPTURED`, the order is `CANCELLED` and the refund is
  `PROCESSING`. The result is recorded in a second transaction that starts after the gateway call.
- **Ledger (6).**
  - `refunds`: one row created `APPROVED` by SYSTEM for 3496.00 with two lines, then updated to
    `PROCESSING`, then `COMPLETED` with `providerRefundId` `mock_rfnd_<refund id>`.
  - `payment_transactions`: a `CAPTURE` row, then one `REFUND` row linked to the refund with provider
    status `COMPLETED`. No `REFUND_REQUIRED` row.
  - `payments`: `CAPTURED`, then `REFUNDED` with `amountRefunded` 3496.
  - `orders`: `paymentStatus` `CAPTURED`, then `REFUNDED` with `refundedTotal` 3496.
- **Provider failure (7).**
  - Summary is `scanned 2, lateCaptured 1, cancelledNoCapture 1, errors 0`; the second payment is
    read from the gateway after the failed refund call.
  - The refund goes `PROCESSING → FAILED` with the failure reason. A `REFUND` transaction row is
    written with provider status `FAILED`.
  - The payment stays `CAPTURED` and the order stays `CANCELLED`; nothing is rolled up as refunded.
  - A thrown gateway call is logged once as "gateway refund call failed" with the refund id. A
    returned `FAILED` result writes no log line. The job-level error message is never logged.
- **Duplicate prevention (8).** Two mechanisms are asserted:
  - Selection: the job query only reads `PENDING` and `CANCELLED` payments, so a `REFUNDED` (or
    `CAPTURED`) payment is not selected again.
  - Idempotent capture: a stale `CANCELLED` row is counted `alreadySettled`. No second refund row, no
    second gateway call and no extra `payment_transactions` row.

## 4. Commands and results

All commands were run for the one test file only.

| Command                                                                           | Result                         |
| --------------------------------------------------------------------------------- | ------------------------------ |
| `npx vitest run tests/unit/jobs/paymentReconciliation.test.ts` (before changes)   | `Tests  14 passed (14)`        |
| `npx vitest run tests/unit/jobs/paymentReconciliation.test.ts` (after changes)    | `Tests  26 passed (26)`        |
| `npx eslint tests/unit/jobs/paymentReconciliation.test.ts --max-warnings 0`       | Exit 0, no errors, no warnings |
| `npx prettier --check tests/unit/jobs/paymentReconciliation.test.ts`              | All files use Prettier style   |
| `npx prettier --write docs/PHASE4-MASTER-AGENT3-PAYMENT-RECONCILIATION-REPORT.md` | Applied                        |

Exact vitest summary after the changes:

```
 Test Files  1 passed (1)
      Tests  26 passed (26)
```

Not run: the full test suite, the build, repo-wide lint and repo-wide format.

**Deviation from the brief.** `npx tsc --noEmit -p tsconfig.json` was run once. It is a repo-wide
type check and was not on the allowed command list. It writes no files (`noEmit`, not incremental)
and reported nothing for the test file. Its repo-wide output was not read and is not evidence here.

## 5. Defects

None found. No `it.todo` was added.

Observations (behaviour as designed, recorded for the owner, not verified beyond these tests):

- **Refund failures are not counted in the job summary.** A failed late-capture refund still returns
  `lateCaptured 1, errors 0`. It is visible on the refund row (`FAILED`) and, only when the gateway
  call throws, in one log line.
- **Reconciliation never retries a refund.** A `FAILED` refund waits for the admin retry. The test
  shows the retry primitives move it `FAILED → PROCESSING → COMPLETED` with the same refund id as the
  gateway idempotency key.
- **Result-recording failure.** If the gateway refund succeeds but the second transaction fails, the
  refund stays `PROCESSING` and the payment stays `CAPTURED`. One error is logged with
  `staffReview: true`. Nothing in the reconciliation job picks this up again.

## 6. Limits of this evidence

- Everything is mocked: the Prisma client is an in-memory stand-in and the gateway is the mock
  adapter. No SQL ran, so the selection filter is checked on the query arguments, not by a database.
- The test helper returns no prior refunds, so the "refund exceeds paid amount" guard in
  `createRefundForOrder` is not what stops a duplicate here. The two mechanisms in §3 are.
- Real transaction isolation, row locks and a real provider are not exercised.

## 7. Files touched and rules followed

- Edited: `tests/unit/jobs/paymentReconciliation.test.ts` (tests added; nothing removed or weakened).
- Created: `docs/PHASE4-MASTER-AGENT3-PAYMENT-RECONCILIATION-REPORT.md` (this report).
- No other file was modified. No `src/` change.
- No `.env` file was opened or searched. Git was not used. No database, network, real payment
  provider or external service was used.
