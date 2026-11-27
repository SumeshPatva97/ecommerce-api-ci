# Deployment & Operations (B0-c Scaffold)

**Status:** scaffold/in-progress documentation. Not a complete production runbook. Validate all steps in target environment.

_Last checked against the code: 2026-11-24 (§1–§9.1; see §11). Corrections are dated notes; earlier statements are kept. No CI run, staging deployment or production deployment exists._

_(Clarification 2026-11-27, CI part only: the sentence above is kept as written. For the words "No CI run … exists", read: no CI run evidence is recorded in the reviewed project documentation. This does not establish whether a CI run occurred. This note does not change or assess the staging and production parts of the sentence.)_

## 1. Application

- Service: `ecommerce-api` (Node.js + Express, TypeScript build -> `dist/`)
- Health (API process only; updated 2026-11-20, previously "extend with DB/provider checks when implemented"):
  - `GET /health/live`: liveness.
  - `GET /health/ready`: readiness. One implemented dependency check, `database` (`SELECT 1` through Prisma, 1 s timeout), plus "not shutting down". Responses: `200 {"status":"ready",…}` or `503 {"status":"not_ready",…}`.
  - No provider checks are implemented.
  - The background worker has no health endpoint.
  - This is a probe only, not database monitoring.
- Default port: `4000` (configurable via `PORT`)
- Process model (D-61; implemented in Batch 9, which is **ACCEPTED — OFFLINE MOCKED SCOPE ONLY** (owner, 2026-11-24; previously "COMPLETE — PENDING USER ACCEPTANCE"); updated 2026-11-20, previously "background jobs TBD"). Two processes from the same build:
  - the stateless HTTP API (`node dist/server.js`), which never runs scheduled jobs;
  - **exactly one** dedicated background worker (`npm run start:worker` = `node dist/worker.js`). It runs the in-process job scheduler only when `JOBS_ENABLED=true`; otherwise it logs and exits. It has no HTTP listener and force-exits after 60 s on shutdown.
- A second worker would run every job twice (no lock). Redis / BullMQ and multi-server scheduling remain deferred (D-38, D-61). Real-process and MySQL behaviour are not yet verified.
- _Added 2026-11-24 (code-verified, `src/core/lifecycle/httpServer.ts`, `workerLifecycle.ts`):_ on SIGTERM / SIGINT the API marks itself not ready, drains connections for up to 25 s and force-exits after 30 s. The worker force-exits after 60 s. Set the termination grace period of each service at least that long.

## 2. Configuration & secrets

- All config via environment variables validated in `src/core/config/env.ts`; see `.env.example`.
- **Never commit real credentials.** Use hosting secret manager / CI secrets (OQ-34 pending for final choices).
- Required (current): `NODE_ENV`, `APP_TIMEZONE=Asia/Kolkata`, `TZ=UTC`, `API_BASE_URL`, `STOREFRONT_URL`, `ADMIN_URL`, `CORS_ORIGINS`, `DATABASE_URL` (placeholder in dev; real secret in runtime).
- Future: JWT secrets/keys, provider keys (payment/email/WhatsApp/Cloudinary), webhook secrets, etc. — add only when implemented and documented.
- _Correction 2026-11-24 — the two lines above are stale (source: `src/core/config/env.ts`):_
  - The JWT keys, the refresh-token pepper and the field-encryption key **are implemented**. For `NODE_ENV=staging` or `production` the schema requires `JWT_ACCESS_PRIVATE_KEY`, `JWT_ACCESS_PUBLIC_KEY`, `REFRESH_TOKEN_PEPPER` and `FIELD_ENCRYPTION_KEY`, `https` URLs and origins, `COOKIE_SECURE` not `false`, `RATE_LIMIT_ENABLED` not `false` and `LOG_PRETTY` not `true`.
  - `PASSWORD_PEPPER`, `PAYMENT_WEBHOOK_SECRET` and `SHIPPING_WEBHOOK_SECRET` exist but are **not** required by the schema. Set them deliberately.
  - Only fake / mock provider adapters exist. No real provider key is used yet (Phase 7).
  - _Added 2026-11-24 (owner decision D1; code-verified and tested with mocks):_ the API and the worker **refuse to start** when `NODE_ENV=production` and the payment provider is the mock. They log `start-up refused: invalid configuration`, naming `PAYMENT_PROVIDER`, and exit with code 1 (`src/container.ts`, `src/bootstrap.ts`). A production process therefore cannot run until a real payment provider exists. Use `NODE_ENV=staging` for rehearsals; staging runs the mock gateway and must never take real orders. No real process has been started to confirm this behaviour.
  - The worker loads the same validated configuration as the API, so it needs the same variables.
  - Full inventory and rules: `CI-CD-AND-DEPLOYMENT-PREPARATION.md` §3.

## 3. Database (MySQL 8, Prisma)

- Access only via `ecommerce-api`/Prisma (approved architecture).
- **Current state (2026-11-18):** MySQL 8.4 is installed locally (`MySQL84` service); `ecommerce_dev` is empty; runtime user `ecommerce_app@localhost` has DML only. Increment B's reviewed baseline candidate is **G6 PASS — ACCEPTED** for G7 preparation but **not applied**. Gates **G2** (backup/restore drill) and **G3** (migration user) are **NOT STARTED**; G7/G8 require separate authorization.
  - _Status update (2026-11-20; the G2 / G3 statement above is superseded; source: `docs/PHASE3-PHASE4-MASTER-PROGRESS-REPORT.md` §1 and `docs/G2-EXECUTION-LOG.md`):_
    - **G2:** user execution in progress, **NOT ACCEPTED**. Step 0 prerequisites PASS; Step 1 not verified (2026-11-19).
    - **G3:** **NOT ACCEPTED**. Procedure v1.2.1 independently reviewed; execution needs separate approval.
    - **G7 / G8:** not authorized.
    - The rest of this 2026-11-18 database snapshot has not been re-verified.
  - _Re-check 2026-11-24 (documents only; no database access):_
    - **G2:** unchanged. `docs/G2-EXECUTION-LOG.md` still shows Step 0 PASS, Step 1 "NOT VERIFIED — awaiting real output" and Steps 2–11 not started. **NOT ACCEPTED.**
    - **G3:** unchanged. **NOT ACCEPTED**; not executed.
    - **G7 / G8:** unchanged; not authorized, not executed.
    - The 2026-11-18 database snapshot is still **not re-verified**. It cannot be checked offline.
- **Migration credentials:** `migrate deploy/status` use `prisma.migration.config.ts` with `MIGRATION_DATABASE_URL` + `MIGRATION_EXPECTED_DATABASE` from git-ignored `.env.migration`. No fallback to `DATABASE_URL`. See `docs/INCREMENT-B-G3-MIGRATION-CONNECTION.md`.
- **Backup/restore drill:** user-executed procedure in `docs/INCREMENT-B-G2-BACKUP-RESTORE-DRILL.md` (dump to `C:\db-backups\ecommerce\`, guard scan, SHA-256, restore into `ecommerce_restore_check`, reconcile object counts, drop only the scratch DB).
- Backups/recovery beyond the drill: define RPO/RTO, automate logical/physical backups, protect credentials, encrypt backups at rest/in transit per policy — **not yet implemented**.

## 4. Build & runtime

- Install: `npm ci`
- Build: `npm run build` (outputs `dist/`)
- Start (updated 2026-11-20, previously only "`node dist/server.js`"):
  - **API:** `npm start` (= `node dist/server.js`). The API never runs scheduled jobs; `JOBS_ENABLED=true` set for the API is ignored with a warning.
  - **Worker:** `npm run start:worker` (= `node dist/worker.js`), with `JOBS_ENABLED=true` set for the worker process. Without it, the worker logs that jobs are disabled and exits 0.
  - **Exactly one worker** may run (D-61). There is no lock: stop the old worker before starting a replacement.
- Prisma: offline schema valid (`prisma validate`); client generated; runtime adapter wired and live-verified. Migration commands are gated and use the separate migration config; do not run them during a deployment rehearsal without G7/G8 approval.
- Dockerfile scaffold provided (`ecommerce-api/Dockerfile`); validate build/runtime, non-root, healthchecks, and secret injection before use.
  - _Added 2026-11-24:_ the Dockerfile was read, not built. Open points (no `.dockerignore`, no `prisma generate` step, a health check that does not suit a worker container) are listed in `CI-CD-AND-DEPLOYMENT-PREPARATION.md` §2.

## 5. CI

- Workflow scaffold: `.github/workflows/ci.yml` (format, lint, typecheck, build, test, offline `prisma validate`). Add DB service/integration/migration jobs when available.
- _Correction 2026-11-24:_ the list above is incomplete. The workflow also runs `npx prisma generate` (before the checks) and `npm run openapi:check` (after the build). It runs on Node 22 (`.nvmrc`). **No CI run has been recorded.** Details and gaps: `CI-CD-AND-DEPLOYMENT-PREPARATION.md` §1.

## 6. Observability & logging

- Structured logging (pino) with request IDs and redaction in foundation; extend per-module logs/metrics/traces and error monitoring integration as implemented.
- Do not log secrets/PII/sensitive tokens.
- _Added 2026-11-24 (code-verified):_ every log line carries the process role (`process: api` or `process: worker`). The worker writes a "worker heartbeat" line every 60 s. No metrics, alerting or error-monitoring integration exists.

## 7. Security operations (summary)

- Enforce HTTPS/TLS in non-local envs, least-privilege DB users, secret rotation, dependency monitoring, and incident response per approved security guidelines. See `SECURITY_SELF_ASSESSMENT.md`.
- _Added 2026-11-24:_ the G4 assessment is `SECURITY_SELF_ASSESSMENT-G4-DRAFT.md`. It is a **draft for owner review**, not an accepted assessment. It does not replace the interim document until the owner accepts it.

## 8. Rollback / change management

- Use versioned migrations (expand/contract), tested rollback/restore procedures, and staged deploys; do not perform destructive DB changes without backups and approval.

## 9. Known limitation — refunds interrupted after commit (M-1, added 2026-11-20)

**Affected code paths.** In five code paths, the refund is committed as `PROCESSING` and the payment-gateway refund call runs only **after** that commit. _(Updated 2026-11-20: previously "four flows"; the admin retry path was verified in code and added.)_

- worker late capture (payment reconciliation);
- staff refund approval;
- customer self-cancel;
- API late capture (payment verify / webhook);
- admin retry of a `FAILED` gateway refund (`POST /admin/refunds/:refundId/retry`). A bank-transfer retry makes no gateway call and is not affected.

If the process stops between the commit and the gateway call, the refund stays `PROCESSING`.

**What does not help.** Nothing recovers this state automatically. The retry route accepts only `FAILED` refunds.

**Operational rules (no further procedure is defined):**

_(Correction 2026-11-24: a manual procedure was adopted on 2026-11-21 — see §9.1. The rules below still apply.)_

- **Verify the gateway outcome first.** A `PROCESSING` refund may also be legitimately waiting for a gateway result.
- **`complete` only after confirmation.** `POST /admin/refunds/:refundId/complete` records an already-completed refund; it does **not** call the gateway. Use it for a gateway refund only when the provider confirms the refund was completed.
- **No refund issued: recovery undefined.** If the gateway confirms that **no refund was issued**, there is **no defined recovery**. Do **not** use `complete`, because it would record a refund that never happened. This needs a separate business decision.
- **Customer notifications.** In staff approval and customer self-cancel, the customer's "refund initiated" notification is queued before the gateway call. Its delivery does not prove a refund was made.

References: `docs/PHASE4-REFUND-RISK-DOCUMENTATION-ALIGNMENT-REPORT.md`, `docs/PHASE4-FINAL-REFUND-DOCUMENTATION-CONSISTENCY-REPORT.md`.

### 9.1 Manual recovery procedure for interrupted gateway refunds (D-64, adopted 2026-11-21)

**Scope.** Gateway refunds only (method `ORIGINAL_PAYMENT_METHOD`).

**Bank-transfer refunds are a different, normal path:**

1. After approval they stay `APPROVED`.
2. Finance pays outside the system.
3. Staff record the UTR with `complete`.

Nothing below applies to them.

**Roles.** A staff user with `refunds.view` identifies candidates. Completing needs `refunds.update` plus re-authentication. Every action is audited by the API.

_Request constraints (added 2026-11-24, code-verified in `src/modules/refunds/refunds.routes.ts` and `refunds.schemas.ts`):_

- `complete` requires an `Idempotency-Key` header.
- `utr` is limited to 40 characters.
- `transferredAt` must be an ISO-8601 date-time with an offset and must not be in the future.
- The `utr` value is stored as the payout reference, not as the provider refund id. A provider reference longer than 40 characters cannot be recorded this way; handling of that case is not defined.

**Steps:**

1. **Identify candidates.**
   - List refunds with `status = PROCESSING` (`GET /admin/refunds?status=PROCESSING`).
   - For each, open the detail. A candidate has **no provider refund id** and a processing time well in the past (e.g. more than 30 minutes; agree the threshold with finance).
   - A `PROCESSING` refund **with** a provider refund id is normally waiting for the gateway result: leave it alone.
   - _(Added 2026-11-24; known gap, rule pending owner confirmation.)_ Exception for retried refunds (`retryCount` above 0): a retry does not clear the provider refund id stored by an earlier attempt. If the timeline shows `PROCESSING` later than `FAILED` and that time is well in the past, the id may belong to the failed attempt. Treat the refund as a candidate and continue with step 2. This adds no new action; it only widens which refunds are checked at the provider.
2. **Establish the provider-side status before any action.**
   - Look the refund up in the payment provider's dashboard or API using the refund id. This is the `id` (UUID) shown in the refund detail, not the `RFD-…` refund number _(clarified 2026-11-24)_. The API sends it as the refund reference / idempotency key.
   - Record the outcome (screenshot or reference) in the incident log.
   - The exact lookup method depends on the chosen payment vendor (OQ-06) and is **not yet defined**.
3. **Act only on a confirmed outcome:**
   - **Provider confirms the refund COMPLETED:** call `POST /admin/refunds/:refundId/complete` with the provider's refund reference as `utr` and the provider's completion time as `transferredAt`. `complete` **records** the completion (status, payment / order totals, `REFUND_COMPLETED` notification). It does **not** call the gateway.
   - **Provider shows the refund PENDING:** do nothing; re-check later.
   - **Provider confirms NO refund was issued: STOP.**
     - Recovery is **undefined** (D-64). Do **not** call `complete`; it would record a refund that never happened.
     - Do **not** issue a refund manually at the gateway; this risks a duplicate refund if the original call is still in flight.
     - `retry` will reject the refund, because it is not `FAILED`.
     - Escalate to the owner / finance and record the case.
4. **Customer communication.** In staff approval and customer self-cancel, the customer may already have received "refund initiated". Do not send a contradicting message without owner approval.

**Not available today:**

- automatic recovery;
- a "re-submit gateway refund" action. It is a proposal only, until idempotency, the provider contract and duplicate-refund protection are verified and separately authorized.

**Automated evidence** for the rules above (mocked): `tests/unit/modules/refunds/manualRecoveryContract.test.ts`. `retry` rejects `PROCESSING`; `complete` rejects an `APPROVED` gateway refund, accepts a `PROCESSING` one and makes no provider call; bank transfer is accepted from `APPROVED` / `PROCESSING`.

## 10. Known limitation — notifications left in `SENDING` (added 2026-11-24)

**What happens (code-verified, `src/modules/notifications/notifications.dispatcher.ts`).** The worker claims each due notification by changing it from `QUEUED` to `SENDING`, and then sends it. If the worker is force-stopped, or a database write fails after the claim, the row stays `SENDING`.

**What does not help.** The dispatcher selects only `QUEUED` rows. No code reclaims a `SENDING` row.

**Procedure.** **None is defined.** This is the risk item RK-03 and the open roadmap item DOC-09. Do not change such rows by hand without an owner-approved procedure: the row alone does not show whether the message was already delivered.

## 11. Verification record (2026-11-24)

Checked against the code, offline. No `.env*` file, Git, database or network was used.

| Section | Checked against                                                                                                                                                                              | Result                                                                                        |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| §1      | `src/server.ts`, `src/worker.ts`, `src/workerRuntime.ts`, `src/bootstrap.ts`, `src/core/health/*`, `src/core/lifecycle/*`                                                                    | Accurate. Shutdown timing added                                                               |
| §2      | `src/core/config/env.ts`                                                                                                                                                                     | Two stale lines corrected                                                                     |
| §3      | `docs/G2-EXECUTION-LOG.md`, `docs/PHASE3-PHASE4-MASTER-PROGRESS-REPORT.md`, `prisma.migration.config.ts`                                                                                     | G2 / G3 status lines accurate. Database snapshot **not re-verified**                          |
| §4      | `package.json`, `Dockerfile` (read only)                                                                                                                                                     | Start commands accurate. The "live-verified" Prisma adapter statement was **not re-verified** |
| §5      | `.github/workflows/ci.yml`                                                                                                                                                                   | Step list corrected                                                                           |
| §6 – §8 | `src/core/logger/logger.ts`, `src/bootstrap.ts`, `src/workerRuntime.ts`                                                                                                                      | General guidance; two facts and one pointer added                                             |
| §9      | `src/modules/refunds/*`, `src/modules/payments/payments.refunds.ts`, `src/modules/payments/payments.service.ts`, `src/modules/orders/orders.service.ts`, `src/jobs/paymentReconciliation.ts` | Five code paths confirmed                                                                     |
| §9.1    | `src/modules/refunds/refunds.routes.ts`, `refunds.service.ts`, `refunds.schemas.ts`; `tests/unit/modules/refunds/manualRecoveryContract.test.ts` (passes)                                    | Accurate. Request constraints added. No recovery step was added or changed                    |
