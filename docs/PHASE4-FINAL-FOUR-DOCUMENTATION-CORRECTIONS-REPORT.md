# Phase 4 — Final Four Documentation Corrections Report

| Field         | Value                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------- |
| Document ID   | P4-FINAL-FOUR-DOC-01                                                                            |
| Date          | 2026-11-20                                                                                      |
| Authorization | Explicit user authorization provided on 2026-11-20 — documentation only; four named corrections |
| Basis         | `docs/PHASE4-FINAL-REFUND-AND-NOTIFICATION-DOCUMENTATION-ALIGNMENT-REPORT.md` §3                |

## 1. Files and sections changed

| #   | File                                                                                      | Section                                                    | Correction       |
| --- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------- |
| 1   | `project-documentation/04-backend/API_DOCUMENTATION.md`                                   | §4.11 `POST /admin/refunds` field table, `bankDetails` row | 1 — bankDetails  |
| 2   | `ecommerce-api/docs/PHASE4-M1-REFUND-PROCESSING-STATE-DOCUMENTATION-CORRECTION-REPORT.md` | §4 table, `complete` row                                   | 2 — §4 condition |
| 3   | `ecommerce-api/docs/operations/DEPLOYMENT_AND_OPERATIONS.md`                              | §1 "Health" bullet; §4 "Start" bullet                      | 3 and 4          |
| 4   | `ecommerce-api/docs/PHASE4-FINAL-FOUR-DOCUMENTATION-CORRECTIONS-REPORT.md`                | New (this report)                                          | —                |

`API_DOCUMENTATION.md` was edited surgically. Prettier was not run on it, and it keeps LF line
endings.

## 2. Corrections and source evidence

### 2.1 `bankDetails` (API_DOCUMENTATION §4.11)

**Before:** "required for `BANK_TRANSFER`: `{ accountName, accountNumber, ifsc }` — stored encrypted,
shown masked, purged after completion [OPEN — OQ-63]".

**After:**

- **Not accepted by the current implementation.** The body is strict, so `bankDetails` is rejected as
  an unknown field with 422 `VALIDATION_ERROR`.
- No bank details are received or stored.
- A `BANK_TRANSFER` refund is created without them; the payout is arranged outside the system and
  closed via `complete { utr, transferredAt }`.
- The previous text is kept, labelled "Proposed design, not implemented … [OPEN — OQ-63]".

**Evidence:**

- `src/modules/refunds/refunds.schemas.ts`:
  - `CreateRefundBody = z.strictObject({ orderId, items?, shippingRefund?, amount?, method?,
reasonCode (default 'OTHER'), reason })`, with no `bankDetails` key;
  - header comment: "`bankDetails` (OQ-63, OPEN) is deliberately NOT accepted … never received or
    stored. COD bank-transfer payouts are arranged by finance outside the system and closed with
    `POST …/complete { utr }`".
- `src/core/middleware/validate.ts` (line 28 comment; line 56 `AppError('VALIDATION_ERROR', …)`) and
  `src/core/errors/errorCodes.ts` (`VALIDATION_ERROR: 422`): an unknown key in a strict object fails
  validation, giving 422.

### 2.2 M-1 correction report §4 — `complete` row

**Before:** "Can close the refund, but makes **no** gateway call. Use only after checking the
refund's outcome at the gateway".

**After:**

- `complete` **records** completion only; it does not initiate or call a gateway refund.
- For a gateway refund, use it only after checking the gateway **and** the provider confirming the
  refund actually completed.
- If the provider confirms no refund was issued, it must not be used (recovery undefined).
- The original wording is quoted in a dated marker.

The other §4 rows, §2 / §3 and every earlier dated note are unchanged.

**Evidence:** `src/modules/refunds/refunds.service.ts` `complete` (526–550):

- allowed `BANK_TRANSFER` → `APPROVED` / `PROCESSING`, otherwise `PROCESSING`;
- calls `markRefundCompleted(tx, gatewayDeps, { refundId, now, payoutReference: input.utr })`;
- no payment-provider call.

### 2.3 Runbook §1 — health line

**Before:** "`GET /health/ready` (readiness; extend with DB/provider checks when implemented)".

**After:**

- Health endpoints exist on the API process only.
- `/health/ready` has one implemented dependency check, `database` (`SELECT 1` through Prisma, 1 s
  timeout), plus "not shutting down". Responses: 200 ready / 503 not_ready.
- No provider checks are implemented, and the worker has no health endpoint.
- "This is a probe only, not database monitoring."

**Evidence:**

- `src/server.ts`: `const readiness = new Readiness();` and
  `readiness.register('database', async () => { await database.ping(); })`.
- `src/core/db/prisma.ts` `ping()`: `client.$queryRawUnsafe('SELECT 1')`.
- `src/core/health/readiness.ts`: `DEFAULT_CHECK_TIMEOUT_MS = 1000`; `ready = allOk && !shuttingDown`.
- `src/core/health/health.routes.ts`: `200 { status: 'ready', checks }` /
  `503 { status: 'not_ready', checks }`.
- The worker files (`worker.ts`, `workerRuntime.ts`) have no HTTP listener, as verified earlier this
  session.

### 2.4 Runbook §4 — start commands

**Before:** "Start: `node dist/server.js`".

**After:**

- **API:** `npm start` (= `node dist/server.js`). It never runs jobs; `JOBS_ENABLED=true` on the API
  is ignored with a warning.
- **Worker:** `npm run start:worker` (= `node dist/worker.js`), with `JOBS_ENABLED=true` set for the
  worker; without it the worker logs and exits 0.
- Exactly one worker (D-61); no lock; stop the old worker before starting a replacement.

**Evidence:**

- `package.json` scripts: `"start": "node dist/server.js"`, `"start:worker": "node dist/worker.js"`.
- `src/workerRuntime.ts`: `if (!config.jobs.enabled)` logs "JOBS_ENABLED is not true … worker
  exiting" and returns `started: false`; `src/worker.ts` then calls `process.exit(0)`.
- `src/bootstrap.ts` `warnIfJobsEnabledForApi`.
- The worker start-up log: "exactly ONE worker process must run (D-61); stop the old worker before
  starting a replacement".

## 3. Items deliberately left unchanged

| Item                                                                                                                             | Reason                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Runbook header "scaffold/in-progress documentation. Not a complete production runbook"                                           | Preserved as instructed                                                       |
| Runbook §3 2026-11-18 database snapshot (MySQL installed, `ecommerce_dev` empty, user grants)                                    | Cannot be re-verified without database access; still marked "not re-verified" |
| API_DOCUMENTATION §4.11 create-refund table has no `reasonCode` row (the code accepts an optional `reasonCode`, default `OTHER`) | Not one of the four authorized corrections; reported as a remaining gap       |
| API_DOCUMENTATION §4.11 `orderId` rule "order payment `CAPTURED` or `PARTIALLY_REFUNDED`" and other field rules                  | Not verified in this task; unchanged                                          |
| OQ-59, OQ-63 and M-1 recovery                                                                                                    | Open business decisions; none decided or implemented                          |

## 4. Validation

| Check                                  | Result                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Changed sections re-read               | Done                                                                                                                                                                                                                                                                                                                                       |
| Each statement traced to code          | §2 above                                                                                                                                                                                                                                                                                                                                   |
| No invented behaviour                  | No bank-details payload, monitoring or operational guarantee described as implemented; the proposed OQ-63 design is labelled "not implemented"                                                                                                                                                                                             |
| Changed-file list, formatting, `.env*` | Modification-time scan since 22:40 (excluding `node_modules`, `.git`, `dist`, `coverage`): exactly the four files in §1. `npm run format:check` **PASS**. `API_DOCUMENTATION.md`: 0 CR, not run through Prettier. `.env*` timestamps unchanged (`.env` 19:05:02, `.env.example` 17:37:18, `.env.migration.example` 2026-11-18); not opened |

## 5. Confirmation

Documentation only. Nothing else was changed:

- source code and tests;
- refund, payment, notification, worker, scheduler and database behaviour;
- package scripts, configuration, Docker and deployment files.

No MySQL, Redis, payment gateway or external service was accessed. No Git command was run, and `.git`
was not inspected. `.env` / `.env.*` were not opened, read or modified (timestamps only). That
includes the `.env` file open in the editor.

**Statuses (unchanged):**

- Batch 9: **COMPLETE — PENDING USER ACCEPTANCE**
- Phase 4: **IN PROGRESS — NOT APPROVED**
- G4: **NOT MET**
- Production readiness: **NOT ESTABLISHED**
