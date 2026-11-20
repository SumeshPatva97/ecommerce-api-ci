# Deployment & Operations (B0-c Scaffold)

**Status:** scaffold/in-progress documentation. Not a complete production runbook. Validate all steps in target environment.

## 1. Application

- Service: `ecommerce-api` (Node.js + Express, TypeScript build -> `dist/`)
- Health (API process only; updated 2026-11-20, previously "extend with DB/provider checks when implemented"):
  - `GET /health/live`: liveness.
  - `GET /health/ready`: readiness. One implemented dependency check, `database` (`SELECT 1` through Prisma, 1 s timeout), plus "not shutting down". Responses: `200 {"status":"ready",…}` or `503 {"status":"not_ready",…}`.
  - No provider checks are implemented.
  - The background worker has no health endpoint.
  - This is a probe only, not database monitoring.
- Default port: `4000` (configurable via `PORT`)
- Process model (D-61; implemented in Batch 9, which is **COMPLETE — PENDING USER ACCEPTANCE**; updated 2026-11-20, previously "background jobs TBD"). Two processes from the same build:
  - the stateless HTTP API (`node dist/server.js`), which never runs scheduled jobs;
  - **exactly one** dedicated background worker (`npm run start:worker` = `node dist/worker.js`). It runs the in-process job scheduler only when `JOBS_ENABLED=true`; otherwise it logs and exits. It has no HTTP listener and force-exits after 60 s on shutdown.
- A second worker would run every job twice (no lock). Redis / BullMQ and multi-server scheduling remain deferred (D-38, D-61). Real-process and MySQL behaviour are not yet verified.

## 2. Configuration & secrets

- All config via environment variables validated in `src/core/config/env.ts`; see `.env.example`.
- **Never commit real credentials.** Use hosting secret manager / CI secrets (OQ-34 pending for final choices).
- Required (current): `NODE_ENV`, `APP_TIMEZONE=Asia/Kolkata`, `TZ=UTC`, `API_BASE_URL`, `STOREFRONT_URL`, `ADMIN_URL`, `CORS_ORIGINS`, `DATABASE_URL` (placeholder in dev; real secret in runtime).
- Future: JWT secrets/keys, provider keys (payment/email/WhatsApp/Cloudinary), webhook secrets, etc. — add only when implemented and documented.

## 3. Database (MySQL 8, Prisma)

- Access only via `ecommerce-api`/Prisma (approved architecture).
- **Current state (2026-11-18):** MySQL 8.4 is installed locally (`MySQL84` service); `ecommerce_dev` is empty; runtime user `ecommerce_app@localhost` has DML only. Increment B's reviewed baseline candidate is **G6 PASS — ACCEPTED** for G7 preparation but **not applied**. Gates **G2** (backup/restore drill) and **G3** (migration user) are **NOT STARTED**; G7/G8 require separate authorization.
  - _Status update (2026-11-20; the G2 / G3 statement above is superseded; source: `docs/PHASE3-PHASE4-MASTER-PROGRESS-REPORT.md` §1 and `docs/G2-EXECUTION-LOG.md`):_
    - **G2:** user execution in progress, **NOT ACCEPTED**. Step 0 prerequisites PASS; Step 1 not verified (2026-11-19).
    - **G3:** **NOT ACCEPTED**. Procedure v1.2.1 independently reviewed; execution needs separate approval.
    - **G7 / G8:** not authorized.
    - The rest of this 2026-11-18 database snapshot has not been re-verified.
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

## 5. CI

- Workflow scaffold: `.github/workflows/ci.yml` (format, lint, typecheck, build, test, offline `prisma validate`). Add DB service/integration/migration jobs when available.

## 6. Observability & logging

- Structured logging (pino) with request IDs and redaction in foundation; extend per-module logs/metrics/traces and error monitoring integration as implemented.
- Do not log secrets/PII/sensitive tokens.

## 7. Security operations (summary)

- Enforce HTTPS/TLS in non-local envs, least-privilege DB users, secret rotation, dependency monitoring, and incident response per approved security guidelines. See `SECURITY_SELF_ASSESSMENT.md`.

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

**Steps:**

1. **Identify candidates.**
   - List refunds with `status = PROCESSING` (`GET /admin/refunds?status=PROCESSING`).
   - For each, open the detail. A candidate has **no provider refund id** and a processing time well in the past (e.g. more than 30 minutes; agree the threshold with finance).
   - A `PROCESSING` refund **with** a provider refund id is waiting for the gateway result: leave it alone.
2. **Establish the provider-side status before any action.**
   - Look the refund up in the payment provider's dashboard or API using the refund id. The API sends it as the refund reference / idempotency key.
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
