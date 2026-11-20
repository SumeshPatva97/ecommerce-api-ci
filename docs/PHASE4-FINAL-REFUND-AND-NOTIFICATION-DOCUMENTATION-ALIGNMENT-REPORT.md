# Phase 4 — Final Refund and Notification Documentation Alignment Report

| Field         | Value                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| Document ID   | P4-REFUND-NOTIF-DOC-01                                                                                     |
| Date          | 2026-11-20                                                                                                 |
| Authorization | Explicit user authorization provided on 2026-11-20 — documentation only; four named files plus this report |
| Basis         | `docs/PHASE4-FINAL-REFUND-DOCUMENTATION-CONSISTENCY-REPORT.md` §8 items 1–4                                |

## 1. Files and sections changed

| #   | File                                                                                        | Section(s)                                                                                                      |
| --- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1   | `ecommerce-api/docs/PHASE4-M1-REFUND-PROCESSING-STATE-DOCUMENTATION-CORRECTION-REPORT.md`   | §2 "Conclusion" recovery bullet; §2 "Distinction kept" last bullet; §3 dated clarification note below the table |
| 2   | `project-documentation/06-workflows/NOTIFICATION_WORKFLOWS.md`                              | §3.3 table, "Late capture auto-refunded" row; new dated note below the §3.3 table; OQ table, OQ-59 row          |
| 3   | `project-documentation/04-backend/API_DOCUMENTATION.md`                                     | §4.11 `POST /admin/refunds/:refundId/complete` row (the "purges stored bank details" clause)                    |
| 4   | `ecommerce-api/docs/operations/DEPLOYMENT_AND_OPERATIONS.md`                                | §1 "Process model" bullet; §3 G2 / G3 status (dated update under the existing sentence)                         |
| 5   | `ecommerce-api/docs/PHASE4-FINAL-REFUND-AND-NOTIFICATION-DOCUMENTATION-ALIGNMENT-REPORT.md` | New (this report)                                                                                               |

The canonical files (2, 3) were edited surgically. Prettier was not run on them, and they keep LF line
endings.

## 2. Corrections and source evidence

### 2.1 M-1 correction report §2 / §3

**Change:**

- **§2.** The recovery bullet now says `complete` may be used for a gateway refund only after the
  provider confirms the refund actually completed. It records the completion and does not initiate a
  gateway refund. If no refund was issued, recovery is undefined and `complete` must not be used.
- The "Manual completion accepts" bullet keeps the bank-transfer behaviour (`APPROVED` / `PROCESSING`,
  closed with the UTR) and adds the gateway-confirmation condition.
- **§3.** The historical "After" column is **unchanged**, because it records what was applied at the
  time. A dated note below the table states the later clarification.

**Evidence:** `refunds.service.ts` `complete` (526–536): `BANK_TRANSFER` → `APPROVED` / `PROCESSING`;
otherwise `PROCESSING` only. It calls `markRefundCompleted` with `payoutReference: input.utr` and makes
no provider call.

### 2.2 NOTIFICATION_WORKFLOWS — late-capture auto-refund

**Change:**

- The §3.3 row keeps the design ("sent as `REFUND_INITIATED` with a dedicated template variant
  (OQ-59)"), labelled as design, and states that the current implementation sends no
  `REFUND_INITIATED`.
- A dated note below the table describes the current behaviour per case and records the open decision.
- The OQ-59 row in the OQ table is marked "design; not sent by the current code".

**Evidence (the code path):**

- `payments.capture.ts` `capturePayment`:
  - **Stock-unavailable branch (~478–520):** `requireRefund` (`LATE_CAPTURE_STOCK_UNAVAILABLE`), then
    `notifyOrder(… 'ORDER_CANCELLED', { refundNote: 'A full refund will be issued to your original
payment method.' })` in the same transaction.
  - **Already-cancelled / duplicate branch (436–462):** `requireRefund` and return; no `notifyOrder`
    call.
  - **`requireRefund` (285–318):** the hook is skipped for `DUPLICATE_CAPTURE`, which records
    `REFUND_REQUIRED` for staff review.
- `payments.refunds.ts` `refundsModuleHook`: `createRefundForOrder` + `prepareGatewayRefund` only; no
  notification.
- `REFUND_INITIATED` is emitted only by `refunds.service.ts` `approve` and `orders.cancel.ts`
  (searched `src` for `'REFUND_INITIATED'`).
- `REFUND_COMPLETED` is emitted by `markRefundCompleted` (`refunds.core.ts`). That is reached from the
  gateway result (`executeGatewayRefund`), the refund webhook (`payments.service.ts`) and the
  `complete` route.

**Not changed:**

- Notification behaviour.
- The design rows in §3.1 (line 116, "`REFUND_INITIATED` | Refund → `PROCESSING` (after approval)")
  and §4.14. They describe the event in general and are consistent with the approval / self-cancel
  flows.

### 2.3 API_DOCUMENTATION §4.11 — "purges stored bank details (OQ-63)"

**Change:** the clause is replaced by a dated clarification:

- this is **not current implemented behaviour**;
- the code accepts and stores no bank details, so nothing is purged;
- bank-detail handling remains the open decision OQ-63.

**Evidence:**

- `refunds.schemas.ts` header: "`bankDetails` (OQ-63, OPEN) is deliberately NOT accepted: the
  approved schema has no encrypted column for payout bank details, so they are never received or
  stored."
- `refunds.core.ts` header: "PROVISIONAL (OQ-63): no bank details are received or stored".
- No bank-detail or purge code in `src` (searched `bankDetails`, `ifsc`, `purge`).
- No bank-account columns in `prisma/schema.prisma` (searched; only the `BANK_TRANSFER` enum value).

### 2.4 DEPLOYMENT_AND_OPERATIONS.md

**§1 "Process model".** "background jobs TBD" is replaced by the D-61 process model, dated, with
"previously …" kept:

- the API (`node dist/server.js`), which never runs jobs;
- exactly one worker (`npm run start:worker`): jobs only with `JOBS_ENABLED=true`, no HTTP listener,
  60 s forced exit;
- no lock, so a second worker double-runs jobs;
- Redis / BullMQ and multi-server scheduling deferred;
- real-process and MySQL behaviour unverified;
- Batch 9 status: COMPLETE — PENDING USER ACCEPTANCE.

**Evidence:** `src/server.ts`, `src/worker.ts`, `src/workerRuntime.ts`, `workerLifecycle.ts`
(`WORKER_HARD_EXIT_MS = 60_000`), `package.json` `start:worker` — all verified earlier in this session
and unchanged since 20:57.

**§3 G2 / G3.** The 2026-11-18 sentence ("G2 and G3 NOT STARTED") is kept, followed by a dated status
update:

- **G2:** user execution in progress, NOT ACCEPTED; Step 0 prerequisites PASS; Step 1 not verified
  (2026-11-19).
- **G3:** NOT ACCEPTED; procedure v1.2.1 independently reviewed; execution needs separate approval.
- **G7 / G8:** not authorized.

**Evidence:** `docs/PHASE3-PHASE4-MASTER-PROGRESS-REPORT.md` §1 (G2, G3, G7, G8 rows);
`docs/G2-EXECUTION-LOG.md` header "G2: USER EXECUTION IN PROGRESS — NOT ACCEPTED". Neither G2 nor G3
is described as passed.

The "scaffold … not a complete production runbook" status line is preserved.

## 3. Statements deliberately left unchanged

| Statement                                                                                                                                                             | Why                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API_DOCUMENTATION §4.11 request-field row `bankDetails` ("required for `BANK_TRANSFER` … stored encrypted, shown masked, purged after completion **[OPEN — OQ-63]**") | Not in the authorized statement. Already labelled OPEN (a proposal). But the current code rejects `bankDetails`, which conflicts with "required". The new `complete`-row note points to it. **Needs authorization** to annotate |
| M-1 correction report §3 "After" column; §4 table (`complete` row: "Use only after checking the refund's outcome at the gateway")                                     | §3 is a historical record (clarified by the dated note). §4 was not in the authorized sections (§2 / §3); its wording lacks the explicit "provider confirms completion" condition. **Needs authorization**                      |
| DEPLOYMENT_AND_OPERATIONS §1 Health line ("readiness; extend with DB/provider checks when implemented")                                                               | The database readiness check now exists (`server.ts`), so this is stale. Not in the authorized items (process model, G2 line)                                                                                                   |
| DEPLOYMENT_AND_OPERATIONS §3 rest of the 2026-11-18 snapshot (MySQL installed, `ecommerce_dev` empty, user grants)                                                    | Cannot be verified without database access. Marked "not re-verified" in the dated note                                                                                                                                          |
| DEPLOYMENT_AND_OPERATIONS §4 "Start: `node dist/server.js`" (no worker start line)                                                                                    | Not in the authorized items. The worker start command is now stated in §1                                                                                                                                                       |
| NOTIFICATION_WORKFLOWS §3.1 / §4.14 `REFUND_INITIATED` design text                                                                                                    | Consistent with the approval / self-cancel flows; design text, not a current-state claim about late capture                                                                                                                     |

## 4. Unresolved business decisions

1. **Late-capture refunds and `REFUND_INITIATED`.** Should late-capture auto-refunds send
   `REFUND_INITIATED` (the OQ-59 design)? This is an open product / business decision; it is not
   implemented.
2. **Recovery when the provider confirms no refund was issued** for a `PROCESSING` refund (M-1, four
   flows). Undefined.
3. **Premature "refund initiated" notifications** in staff approval and customer self-cancel. Is this
   acceptable?
4. **OQ-63 bank-detail handling** (capture, encryption, masking, purge). Open; not implemented.

No decision was made, and none of these was turned into an implementation instruction.

## 5. Validation

| Check                                  | Result                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Changed sections re-read               | Done                                                                                                                                                                                                                                                                                                                                                                                  |
| Every changed statement traced         | §2 above (source code or the master progress report / G2 execution log)                                                                                                                                                                                                                                                                                                               |
| No unverified claim added              | Statements that could not be verified (database snapshot) were left unchanged and marked "not re-verified"                                                                                                                                                                                                                                                                            |
| Changed-file list, formatting, `.env*` | Modification-time scan since 22:36 (excluding `node_modules`, `.git`, `dist`, `coverage`): exactly the five files in §1. `npm run format:check` **PASS** (Prettier only on the three `ecommerce-api` files). Canonical files 0 CR, not run through Prettier. `.env*` timestamps unchanged (`.env` 19:05:02, `.env.example` 17:37:18, `.env.migration.example` 2026-11-18); not opened |

## 6. Confirmation

Documentation only. Nothing else was changed:

- application source code and tests;
- refund, payment, notification, worker and scheduler behaviour;
- configuration, environment files, the Prisma schema, migrations, packages, lockfiles, Docker files
  and deployment configuration.

No MySQL, Redis, payment gateway, courier or other external service was accessed. No Git command was
run, and `.git` was not inspected. `.env` / `.env.*` were not opened (timestamps only).

**Statuses (unchanged):**

- Batch 9: **COMPLETE — PENDING USER ACCEPTANCE**
- Phase 4: **IN PROGRESS — NOT APPROVED**
- G4: **NOT MET**
- Production readiness: **NOT ESTABLISHED**
