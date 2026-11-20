# Phase 4 — Final Refund Documentation Consistency Report

| Field         | Value                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| Document ID   | P4-REFUND-DOC-FINAL-01                                                                                    |
| Review date   | 2026-11-20                                                                                                |
| Authorization | Explicit user authorization provided on 2026-11-20 — documentation only; named documents plus this report |
| Basis         | `docs/PHASE4-REFUND-RISK-DOCUMENTATION-ALIGNMENT-REPORT.md` §11 recommendations                           |

## 1. Scope

The task aligns the remaining refund documentation with the implementation. It covers the `complete`
route semantics, the gateway-confirmation requirement, notification timing, the M-1 operational
limitation, and the missing recovery procedure.

No refund behaviour, state transition, route, notification behaviour or code was changed.

## 2. Documents inspected

**Authorized for editing:**

- `project-documentation/04-backend/API_DOCUMENTATION.md`
- `project-documentation/06-workflows/ADMIN_WORKFLOWS.md`
- The eight M-1 documents (§5)
- `ecommerce-api/docs/PHASE4-BATCH9-FINAL-ACCEPTANCE-REVIEW.md`
- `ecommerce-api/docs/operations/DEPLOYMENT_AND_OPERATIONS.md`

**Read only (for the consistency search):**

- every `.md` file under `ecommerce-api/docs` and `project-documentation`, searched for recovery
  wording and `REFUND_INITIATED` timing;
- `NOTIFICATION_WORKFLOWS.md`, `USER_WORKFLOWS.md`, `PROJECT_REQUIREMENTS.md` and
  `ADMIN_WORKFLOWS.md` §9 (context only).

## 3. Source-code evidence used (read only; files unchanged since 2026-11-20 18:59)

| Fact                                        | Evidence                                                                                                                                                                                                                               |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `complete` accepted states                  | `refunds.service.ts` 526–536: `BANK_TRANSFER` → `APPROVED`/`PROCESSING`; otherwise `PROCESSING` only; error `INVALID_STATE_TRANSITION` (`invalidState`, 198–202)                                                                       |
| `complete` makes no gateway call            | `complete` → `markRefundCompleted` with `payoutReference: input.utr`; no provider call                                                                                                                                                 |
| Gateway refund prepared before commit       | `prepareGatewayRefund` (`refunds.core.ts` 315–347) called inside the approval (`refunds.service.ts` `approve`), self-cancel (`orders.cancel.ts` 254) and late-capture (`payments.refunds.ts` hook) transactions                        |
| Gateway call after commit; result recording | `executeGatewayRefund` (`refunds.core.ts` 454): `COMPLETED` → `markRefundCompleted`; `FAILED` → `FAILED`; otherwise stays `PROCESSING`                                                                                                 |
| Webhook completion                          | `payments.service.ts` ~200–222: refund found by `providerRefundId`; `REFUND_PROCESSED` → `markRefundCompleted`; failure → `FAILED`. A refund whose gateway call never ran has no provider refund id                                    |
| `retry`                                     | `refunds.service.ts` 480–484: `FAILED` only; a bank transfer (no gateway job) goes back to `PROCESSING` for manual completion (503–507)                                                                                                |
| Notification queued in transaction          | `notifyOrderEvent` → `notifications.service.ts` `enqueue(tx, …)` → `tx.notification.create` (`QUEUED`); `REFUND_INITIATED` emitted only by `refunds.service.ts` `approve` and `orders.cancel.ts` (self-cancel, `notifyCustomer: true`) |
| No automatic recovery                       | No job or route re-executes a `PROCESSING` refund's gateway call                                                                                                                                                                       |

## 4. Corrections — canonical documents

| Document               | Section                                             | Before                                                                                                                   | After                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_DOCUMENTATION.md` | §4.11, `POST /admin/refunds/:refundId/complete` row | "Allowed only for `BANK_TRANSFER` (or a gateway refund … after provider confirmation) in status `APPROVED`/`PROCESSING`" | Bank transfer: `APPROVED`/`PROCESSING`. Gateway refund: `PROCESSING` only, after the provider confirms completion. The route records a completion and does not initiate or call a gateway refund. It must not be used when the provider confirms no refund was issued (no defined recovery, M-1). Endpoint contract (body, response, permissions) unchanged                                               |
| `API_DOCUMENTATION.md` | §4.11 closing paragraph                             | "Gateway refund completion comes via payment webhook"                                                                    | Recorded automatically when the post-commit gateway call returns `COMPLETED`, or later via the refund webhook (matched by provider refund id). `REFUND_INITIATED` is queued before the gateway call, so its delivery does not prove a refund was issued or completed                                                                                                                                      |
| `ADMIN_WORKFLOWS.md`   | §11.1 state diagram                                 | `APPROVED --> PROCESSING : gateway refund API called / bank transfer initiated`; no bank-transfer completion edge        | `APPROVED --> PROCESSING`: prepared in the same transaction, before the post-commit gateway call. New edge `APPROVED --> COMPLETED`: bank transfer, UTR via complete route. `PROCESSING --> COMPLETED`: gateway result / webhook, or complete route after provider confirmation. Dated note below the diagram (M-1, bank transfer, `complete` semantics, undefined recovery). Other transitions unchanged |
| `ADMIN_WORKFLOWS.md`   | §11.1 row 5                                         | "system after approval … `REFUND_INITIATED` to customer"                                                                 | Refund set `PROCESSING` in the approval / self-cancel transaction; gateway call after commit. `REFUND_INITIATED` is queued inside that transaction, before the gateway call; its delivery does not prove a refund was issued or completed                                                                                                                                                                 |
| `BACKEND_STRUCTURE.md` | §22 current-implementation note                     | "check the gateway outcome first, then use the existing `complete` route"                                                | `complete` only if the provider confirms completion; records only; undefined recovery if no refund was issued; `complete` must not be used then. Dated                                                                                                                                                                                                                                                    |

The three canonical files were edited surgically. Prettier was not run on them, and they keep LF line
endings. Row 8 of ADMIN_WORKFLOWS §11.1 was already aligned on 2026-11-20 and was not changed.

## 5. Corrections — M-1 documents and the acceptance review

Recovery wording that read only "check the gateway, then `complete`" was clarified in each context.
A dated "clarified 2026-11-20" marker was added in every place; historical findings were left intact.

| Document                                                    | Location                            | Change                                                                                                                                                                     |
| ----------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PHASE4-BATCH9-COMPLETION-REPORT.md`                        | §6 item 4                           | Gateway-check bullet kept; new clarification bullet (`complete` only after confirmed completion; records only; undefined recovery)                                         |
| `PHASE4-BATCH9-TECHNICAL-REVIEW-AND-IMPLEMENTATION-PLAN.md` | §4 item 9 (refunds)                 | Same clarification inline                                                                                                                                                  |
| `PHASE3-PHASE4-MASTER-PROGRESS-REPORT.md`                   | §16 M-1 limitation                  | Same clarification, plus a pointer that the same pre-existing gap exists in three API flows                                                                                |
| `PHASE4-BATCH9-DOCUMENTATION-CORRECTION-REPORT.md`          | §2 refund bullet; §4 first bullet   | Same clarification                                                                                                                                                         |
| `PHASE4-DOC06-CORRECTION-REPORT.md`                         | §6                                  | **No change needed**: contains no recovery wording                                                                                                                         |
| `PHASE4-BATCH9-INDEPENDENT-AUDIT-REPORT.md`                 | §5 refunds bullet; §10 M-1 row      | Same clarification (sub-bullets / inline)                                                                                                                                  |
| `PHASE4-MASTER-COMPLETION-ROADMAP.md`                       | DOC-09 row; M-1 row (risk register) | Same clarification inline                                                                                                                                                  |
| `BACKEND_STRUCTURE.md`                                      | §22                                 | See §4                                                                                                                                                                     |
| `PHASE4-BATCH9-FINAL-ACCEPTANCE-REVIEW.md`                  | §7.2 recommended-correction quote   | Quote preserved; dated clarification note added below it (`complete` records only; only after confirmed completion; undefined recovery). §7.1 and §11 were already aligned |

## 6. Operations runbook

**Finding.** `ecommerce-api/docs/operations/DEPLOYMENT_AND_OPERATIONS.md` exists. It is labelled
"scaffold/in-progress … not a complete production runbook". As it is the existing operations
document, a new **§9 "Known limitation — refunds interrupted after commit (M-1)"** was added. It
covers:

- the four flows;
- the `PROCESSING` state and the absence of automatic recovery;
- verifying the gateway outcome first;
- `complete` only after confirmed completion (it never calls the gateway);
- recovery undefined when no refund was issued, needing a separate business decision;
- the premature "refund initiated" notification.

No operational recovery steps were invented, and no new runbook was created.

**Not changed:** the runbook's §1 "background jobs TBD" line. It predates Batch 9 and contradicts the
D-61 worker, but it is unrelated cleanup and remains open as roadmap DOC-09.

## 7. Validation

| Check                                                             | Result                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Changed documents re-read                                         | Done for every edited section                                                                                                                                                                                                                                                                                                                                                                                          |
| Statements vs code                                                | Every statement traced to §3                                                                                                                                                                                                                                                                                                                                                                                           |
| No document says `complete` initiates a gateway refund            | Searched the edited canonical documents and runbook: none. All edited locations state it records only                                                                                                                                                                                                                                                                                                                  |
| No document says a queued notification proves completion          | No such claim found. API_DOCUMENTATION §4.11, ADMIN_WORKFLOWS row 5 / note and the runbook now state the opposite explicitly                                                                                                                                                                                                                                                                                           |
| Recovery wording requires provider confirmation before `complete` | Workspace search for unqualified "then `complete`" wording. Remaining hits are (a) the acceptance review §7.2 historical quote, now followed by the clarification; (b) `PHASE4-M1-REFUND-PROCESSING-STATE-DOCUMENTATION-CORRECTION-REPORT.md` §2 / §3 (**not authorized**, see §8); (c) the alignment report quoting the issue                                                                                         |
| No-refund-issued case explicitly undefined                        | Stated in every edited location                                                                                                                                                                                                                                                                                                                                                                                        |
| Changed-file list, formatting, `.env*`                            | Modification-time scan since 22:30 (excluding `node_modules`, `.git`, `dist`, `coverage`): exactly the 12 files in §9. `npm run format:check` **PASS** (Prettier only on `ecommerce-api` docs; audit / roadmap tables re-padded). Canonical files: 0 CR characters, not run through Prettier. `.env*` timestamps unchanged (`.env` 19:05:02, `.env.example` 17:37:18, `.env.migration.example` 2026-11-18); not opened |

## 8. Remaining inconsistencies (not edited — need authorization)

1. **`ecommerce-api/docs/PHASE4-M1-REFUND-PROCESSING-STATE-DOCUMENTATION-CORRECTION-REPORT.md`
   §2 and §3 table.** These still say "check the gateway outcome first, then use the existing
   `complete` route" without the provider-confirmation condition or the undefined-recovery case. The
   file was not in this task's authorized list.
2. **`project-documentation/06-workflows/NOTIFICATION_WORKFLOWS.md` §3 (line 135).**
   - The document says a late-capture auto-refund is "sent as `REFUND_INITIATED` with a dedicated
     template variant (OQ-59)".
   - The code's late-capture refund hook (`payments.refunds.ts`) queues **no** refund notification.
   - This is a documentation / implementation mismatch: either the documented notification is missing
     in code, or the document is ahead of the implementation. It needs a decision; not corrected.
3. **`API_DOCUMENTATION.md` §4.11 `complete` row: "purges stored bank details (OQ-63)".** The code
   stores no bank details (`refunds.core.ts` header: PROVISIONAL OQ-63, no encrypted column). This is
   unrelated to the refund-state task and was not edited.
4. **`ecommerce-api/docs/operations/DEPLOYMENT_AND_OPERATIONS.md` §1:**
   - "background jobs TBD" is stale since Batch 9 (DOC-09).
   - §3 "G2 … NOT STARTED" also predates later records.

## 9. Exact changed-file list

**Existing files changed (11):**

1. `project-documentation/04-backend/API_DOCUMENTATION.md`
2. `project-documentation/06-workflows/ADMIN_WORKFLOWS.md`
3. `project-documentation/04-backend/BACKEND_STRUCTURE.md`
4. `ecommerce-api/docs/PHASE4-BATCH9-COMPLETION-REPORT.md`
5. `ecommerce-api/docs/PHASE4-BATCH9-TECHNICAL-REVIEW-AND-IMPLEMENTATION-PLAN.md`
6. `ecommerce-api/docs/PHASE3-PHASE4-MASTER-PROGRESS-REPORT.md`
7. `ecommerce-api/docs/PHASE4-BATCH9-DOCUMENTATION-CORRECTION-REPORT.md`
8. `ecommerce-api/docs/PHASE4-BATCH9-INDEPENDENT-AUDIT-REPORT.md`
9. `ecommerce-api/docs/PHASE4-MASTER-COMPLETION-ROADMAP.md`
10. `ecommerce-api/docs/PHASE4-BATCH9-FINAL-ACCEPTANCE-REVIEW.md`
11. `ecommerce-api/docs/operations/DEPLOYMENT_AND_OPERATIONS.md`

**New:**

12. `ecommerce-api/docs/PHASE4-FINAL-REFUND-DOCUMENTATION-CONSISTENCY-REPORT.md` (this report)

So: 11 existing files and 1 new report. `PHASE4-DOC06-CORRECTION-REPORT.md` was inspected and **not**
changed.

## 10. Confirmation

Documentation only. Nothing else was changed:

- source code, refund business logic, state transitions and retry / recovery mechanisms;
- the payment-gateway integration, and notification timing or delivery;
- tests, the schema, migrations, seeds, packages, configuration and Docker files.

No database, Redis, gateway, courier or external service was accessed. No Git command was run, and
`.git` was not inspected. `.env*` files were not opened.

## 11. Unresolved business decisions

1. **Recovery for a `PROCESSING` refund when the gateway confirms no refund was issued** (all four
   flows): undefined. It needs a separate business decision, and possibly code.
2. **Premature "refund initiated" notifications** (staff approval, customer self-cancel): accept the
   behaviour, or decide how affected customers are informed.
3. **Late-capture refund notification** (§8 item 2): decide whether the documented `REFUND_INITIATED`
   variant is required.

**Statuses (unchanged):**

- Batch 9: **COMPLETE — PENDING USER ACCEPTANCE**
- Phase 4: **IN PROGRESS — NOT APPROVED**
- G4: **NOT MET**
- Production readiness: **NOT ESTABLISHED**
