# Phase 4 — M-1 Refund `PROCESSING` State: Documentation Correction Report

| Field         | Value                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------- |
| Document ID   | P4-M1-STATE-DOC-01                                                                                  |
| Date          | 2026-11-20                                                                                          |
| Authorization | Explicit user authorization provided on 2026-11-20 (M-1 refund-state documentation correction only) |
| Basis         | `docs/PHASE4-BATCH9-FINAL-ACCEPTANCE-REVIEW.md` §7.2 (finding R-15)                                 |
| Nature        | **Documentation only**                                                                              |

## 1. Scope

The task corrects the description of the refund state left behind when the process stops after the
late-capture transaction commits but before the gateway refund call. Eight documents said
`APPROVED` / `approved`; the code leaves the refund in **`PROCESSING`**.

No code, test, refund logic, route, M-2 item, scheduler comment or start-up log message was changed.

## 2. Code evidence (re-checked before editing, read only)

| Step | Code                                                                                                                                                                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | `src/modules/payments/payments.refunds.ts` `refundsModuleHook`: `createRefundForOrder(tx, { …, status: 'APPROVED', method: 'ORIGINAL_PAYMENT_METHOD' })` (line 31) — the refund is **created `APPROVED`**                                                    |
| 2    | Same function, line 38: `return await prepareGatewayRefund(tx, refund.id, args.now)` — **same transaction**                                                                                                                                                  |
| 3    | `src/modules/refunds/refunds.core.ts` `prepareGatewayRefund` (315): if `APPROVED` or `FAILED` (333), with original method and a captured provider payment id, it updates the refund to **`PROCESSING`** (338) and returns the gateway job                    |
| 4    | `src/jobs/paymentReconciliation.ts`: `capturePayment` inside `withTransaction` (181), then `runRefundJob(container, result.refundJob)` **after commit** (194). The API's verify / webhook paths (`payments.service.ts`) follow the same pattern              |
| 5    | `refunds.core.ts` `executeGatewayRefund` (454): gateway call, then a second transaction records `COMPLETED` or `FAILED`. Any other result only stores the provider refund id, and the refund **stays `PROCESSING`** (legitimately awaiting a gateway result) |
| 6    | `src/modules/refunds/refunds.service.ts` `retry` (480–484): `refund.status !== 'FAILED'` → "Only failed refunds can be retried."                                                                                                                             |
| 7    | Same file, `complete` (526–536): allowed states `BANK_TRANSFER` → `APPROVED`, `PROCESSING`; otherwise → **`PROCESSING`** only. Records a manual completion with a payout reference; **no gateway call**                                                      |
| 8    | No job selects or recovers `PROCESSING` refunds (searched `src/jobs`, `src/modules/refunds`, `src/modules/payments`)                                                                                                                                         |

**Conclusion:** a stop after the commit but before the gateway call leaves the refund `PROCESSING`.

- It cannot be retried, because retry accepts `FAILED` only.
- Nothing recovers it automatically.
- Manual recovery: check the gateway outcome first. _(Clarified 2026-11-20, final refund and
  notification documentation alignment.)_
  - The existing `complete` route (accepts `PROCESSING`) may be used for a gateway refund **only after
    the provider confirms that the refund actually completed**.
  - `complete` **records** the completion. It does **not** initiate or call a gateway refund.
  - If the provider confirms no refund was issued, recovery is undefined (an open business decision),
    and `complete` must not be used.

A `PROCESSING` refund is **not necessarily interrupted**. One that is awaiting a gateway result is
also `PROCESSING` (step 5), so the gateway must always be checked before completing it.

**Distinction kept in the documents:**

- Normal initial approval: `APPROVED`.
- Subsequent state before the gateway call: `PROCESSING`.
- Interrupted state: `PROCESSING`.
- Retry accepts: `FAILED` only.
- Manual completion accepts: `PROCESSING` (and `APPROVED` only for `BANK_TRANSFER`). For a gateway
  refund, use it only after provider confirmation of completion. A bank-transfer refund is closed
  with its UTR after the transfer outside the system. _(Clarified 2026-11-20.)_

## 3. Corrected documents

| #   | File                                                                           | Section(s) corrected                                                                             | Before                                                                                                         | After                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `ecommerce-api/docs/PHASE4-BATCH9-COMPLETION-REPORT.md`                        | §6 item 4                                                                                        | "may remain `approved`"; "cannot retry an `approved` refund"                                                   | Created `APPROVED`, moved to `PROCESSING` in the same transaction; remains **`PROCESSING`**; retry accepts `FAILED` only; no automatic recovery; check the gateway first, then `complete`; not every `PROCESSING` refund is interrupted. Dated correction marker |
| 2   | `ecommerce-api/docs/PHASE4-BATCH9-TECHNICAL-REVIEW-AND-IMPLEMENTATION-PLAN.md` | §4 item 9 (refunds bullet)                                                                       | "may remain `approved`"                                                                                        | Same facts; dated note keeps the DOC-01 history and adds the state correction                                                                                                                                                                                    |
| 3   | `ecommerce-api/docs/PHASE3-PHASE4-MASTER-PROGRESS-REPORT.md`                   | §16 "Known limitation (M-1)"                                                                     | "recorded as `approved` … stays `approved`"                                                                    | Created `APPROVED`, moved to `PROCESSING`; stays `PROCESSING`; retry `FAILED` only; no job; check the gateway, then `complete`. Dated marker                                                                                                                     |
| 4   | `ecommerce-api/docs/PHASE4-BATCH9-DOCUMENTATION-CORRECTION-REPORT.md`          | §2 refund bullets; §4 first bullet                                                               | "may remain `approved`"; "stay `approved`"                                                                     | `PROCESSING`, with the transition explained; manual recovery wording; dated markers                                                                                                                                                                              |
| 5   | `ecommerce-api/docs/PHASE4-DOC06-CORRECTION-REPORT.md`                         | §6 M-1 bullet                                                                                    | "refund left `approved`"                                                                                       | "refund left `PROCESSING`", with a dated marker                                                                                                                                                                                                                  |
| 6   | `ecommerce-api/docs/PHASE4-BATCH9-INDEPENDENT-AUDIT-REPORT.md`                 | §5 refunds (correction block + bullets); §8 D-1 row; §10 M-1 row; §11 M-1 follow-up              | "created `APPROVED`"; "leaves the refund `APPROVED`"; "stays `APPROVED`" (×2); "re-execute `APPROVED` refunds" | Dated correction block preserving the original finding's history; bullets, D-1 and M-1 rows and the follow-up now say `PROCESSING`; manual-recovery bullet requires the gateway check first                                                                      |
| 7   | `ecommerce-api/docs/PHASE4-MASTER-COMPLETION-ROADMAP.md`                       | DOC-01 row (106), M-1 row (397); also DOC-09 (114), IMP-08 (131), Batch 9 verification row (370) | `APPROVED` (×5)                                                                                                | `PROCESSING`, with dated markers; DOC-09 / M-1 rows add "check the gateway outcome, then `complete`"                                                                                                                                                             |
| 8   | `project-documentation/04-backend/BACKEND_STRUCTURE.md`                        | §22 current-implementation note (worker shutdown, "Exception")                                   | "a refund left `approved`"                                                                                     | Created `APPROVED` → `PROCESSING` in the same transaction; left `PROCESSING`; retry `FAILED` only; check the gateway outcome first, then `complete`. Dated marker. Edited surgically (no Prettier), LF kept                                                      |

> **Clarification (2026-11-20, final refund and notification documentation alignment).** The "After"
> column records the wording applied at the time ("check the gateway first, then `complete`"). That
> wording was later made more precise in each of these documents:
>
> - `complete` may be used for a gateway refund **only after the provider confirms the refund
>   completed**.
> - It **records** completion and does not initiate a gateway refund.
> - If no refund was issued, recovery is undefined and `complete` must not be used.
>
> See `PHASE4-FINAL-REFUND-DOCUMENTATION-CONSISTENCY-REPORT.md`. Bank-transfer completion from
> `APPROVED` / `PROCESSING` is unaffected.

**Notes on rows 6 and 7:**

- The acceptance review cited only one or two lines in these two files. The same wrong state appeared
  in further rows **within the same authorized documents**, and those were corrected too.
- In the audit (row 6), the follow-up suggestion was reworded to "a guarded retry path or a sweep that
  first checks the gateway". It remains a proposal for a future decision; nothing was implemented.

**Left unchanged by design:**

- Other columns, such as the roadmap DOC-01 row's status.
- Historical context in every file. Original wording is recorded in the dated markers, not erased.

## 4. Retry and manual-completion limitations (as now documented)

| Route / mechanism      | Accepts                                                                   | Effect on an interrupted refund                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retry`                | `FAILED` only                                                             | Rejected (`PROCESSING` is not `FAILED`); cannot re-trigger the gateway call                                                                                                                                                                                                                                                                                                                                     |
| `complete`             | `PROCESSING` (gateway refunds); `APPROVED` / `PROCESSING` (bank transfer) | **Records** completion only; it does **not** initiate or call a gateway refund. For a gateway refund, use it only after checking the gateway **and** the provider confirming the refund actually completed. If the provider confirms no refund was issued, it must not be used (recovery undefined). _(Condition added 2026-11-20; originally: "Use only after checking the refund's outcome at the gateway".)_ |
| Automatic recovery     | None                                                                      | No job re-checks `PROCESSING` refunds                                                                                                                                                                                                                                                                                                                                                                           |
| Gateway refund webhook | Handles `PROCESSING` refunds                                              | Only arrives if the gateway call was actually made, so it cannot help when the call never ran                                                                                                                                                                                                                                                                                                                   |

No further recovery steps were documented, and no automatic recovery is claimed.

## 5. Validation

| Check                                           | Result                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Every changed section re-read                   | Done                                                                                                                                                                                                                                                                                                                                             |
| Statements verified against code                | See §2. Each corrected statement uses only facts 1–8                                                                                                                                                                                                                                                                                             |
| No inaccurate claim left in the eight documents | Searched all eight for `` `approved` `` / `` `APPROVED` ``. Every remaining occurrence is either the normal creation state ("created `APPROVED` and moved to `PROCESSING`") or a dated correction marker quoting the old wording. BACKEND_STRUCTURE §8 "auto-`APPROVED` full refund" (cancel order) is the normal approval step and is unrelated |
| Other documents                                 | Searched `ecommerce-api` and `project-documentation`. No other document states the interrupted state wrongly. `PHASE4-BATCH9-FINAL-ACCEPTANCE-REVIEW.md` quotes the old wording as the finding (correct as is); `PHASE4-G4-REVIEW-REPORT.md` and `CHANGELOG.md` matches concern Phase 3 approval (unrelated)                                     |
| Formatting                                      | Prettier run only on the eight changed `ecommerce-api` files (seven corrected docs + this report); `npm run format:check` **PASS** (audit and roadmap tables re-padded only). BACKEND_STRUCTURE: 0 CR characters, not run through Prettier                                                                                                       |
| Changed-file list                               | Modification-time scan of the workspace since 22:10 (excluding `node_modules`, `.git`, `dist`, `coverage`): exactly the nine files in §6. `.env*` metadata unchanged (`.env` 19:05:02, `.env.example` 17:37:18, `.env.migration.example` 2026-11-18)                                                                                             |

## 6. Changed files (exact)

1. `ecommerce-api/docs/PHASE4-BATCH9-COMPLETION-REPORT.md`
2. `ecommerce-api/docs/PHASE4-BATCH9-TECHNICAL-REVIEW-AND-IMPLEMENTATION-PLAN.md`
3. `ecommerce-api/docs/PHASE3-PHASE4-MASTER-PROGRESS-REPORT.md`
4. `ecommerce-api/docs/PHASE4-BATCH9-DOCUMENTATION-CORRECTION-REPORT.md`
5. `ecommerce-api/docs/PHASE4-DOC06-CORRECTION-REPORT.md`
6. `ecommerce-api/docs/PHASE4-BATCH9-INDEPENDENT-AUDIT-REPORT.md`
7. `ecommerce-api/docs/PHASE4-MASTER-COMPLETION-ROADMAP.md`
8. `project-documentation/04-backend/BACKEND_STRUCTURE.md`
9. `ecommerce-api/docs/PHASE4-M1-REFUND-PROCESSING-STATE-DOCUMENTATION-CORRECTION-REPORT.md` (new; this report)

## 7. Confirmation

This was **documentation only**. Nothing else was changed:

- source code, tests, refund logic, state transitions, retry behaviour and routes;
- M-2, the worker lifecycle and the scheduler, including its comment and start-up log message;
- packages, configuration, schema, migrations, seeds and Docker files;
- `.env` / `.env.*`, which were not opened (metadata only).

No database, Redis, gateway or external service was accessed. No Git command was run, and `.git` was
not inspected.

## 8. Remaining related documentation inconsistencies (not edited)

- **The acceptance review's own wording** (`PHASE4-BATCH9-FINAL-ACCEPTANCE-REVIEW.md` §7.1)
  describes manual recovery with an extra step: "issue the refund there if it was not issued".
  _(Corrected 2026-11-20: this bullet originally said "§7.1 and §11"; only §7.1 contained the step.
  The review has since been aligned by `PHASE4-REFUND-RISK-DOCUMENTATION-ALIGNMENT-REPORT.md`.
  `complete` is appropriate only after the gateway confirms the refund was completed; recovery is
  undefined if the gateway confirms no refund was issued.)_
- **A wider pre-existing gap not limited to the worker.** The same post-commit pattern applies to:
  - staff `approve` (`REQUESTED → APPROVED → PROCESSING`);
  - customer self-cancel refunds;
  - API-side late captures (verify / webhook).

  These run in the API process (30 s hard exit). They are covered by the same M-1 limitation but are
  described only for the worker case. Not edited (outside scope).

- **`APPROVED` without a gateway job (corrected 2026-11-20).** This bullet originally said that a
  missing captured provider payment id "legitimately" leaves an auto-approved refund `APPROVED`. That
  explanation was inaccurate.
  - **Legitimate case: bank transfer.** `prepareGatewayRefund` returns no job for a non-original
    method. A bank-transfer refund (COD orders, or a staff-chosen method) therefore stays `APPROVED`
    by design. It is paid out manually and closed with `complete`, which accepts `APPROVED` /
    `PROCESSING` for `BANK_TRANSFER`.
  - **Missing payment / provider payment id: an unreachable guard** in the reviewed code paths.
    - `capturePayment` writes `providerPaymentId` (`payments.capture.ts` line 418) before the refund
      hook runs.
    - Refunds are created only for paid orders, linked to a paid payment.
    - If the guard were ever hit, the refund would stay `APPROVED` with no route accepting it. That
      cannot be checked offline against existing data (NOT VERIFIED).
  - Both cases differ from the interrupted case, which is `PROCESSING` with a gateway call pending.
    Normal approval is `APPROVED`; the interrupted state is `PROCESSING`.
- **Still open:** DOC-07 – DOC-12, M-1 (code) and M-2, and the scheduler comment / start-up log wording
  (R-16), are unchanged.

**Statuses (unchanged):**

- Batch 9: **COMPLETE — PENDING USER ACCEPTANCE**
- Phase 4: **IN PROGRESS — NOT APPROVED**
- G4: **NOT MET**
- Production readiness: **NOT ESTABLISHED**
