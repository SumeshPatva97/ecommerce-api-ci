# CI/CD and Deployment Preparation (`ecommerce-api`)

| Field    | Value                                                                                                                         |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Document | P4-CICD-PREP-01                                                                                                               |
| Date     | 2026-11-21                                                                                                                    |
| Status   | **Preparation only.** No push, CI run, deployment, hosting account or live configuration change was made                     |
| Sources  | `.github/workflows/ci.yml`, `package.json`, `src/core/config/env.ts` (schema only; no `.env*` file was read), D-61, runbook   |

## 1. CI workflow (as it exists)

`.github/workflows/ci.yml` (job "CI (ecommerce-api)"):

1. checkout;
2. Node from `.nvmrc` (= 22);
3. `npm ci`;
4. `npx prisma validate` (offline);
5. `npx prisma generate`;
6. `format:check`;
7. `lint`;
8. `typecheck`;
9. `build`;
10. `openapi:check`;
11. `npm test`.

**Gaps:**

| Gap                                                    | Impact                                                    | Proposal (needs authorization)                                      |
| ------------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------- |
| **No CI run evidence** on the current code (QA-04)     | Node 22 compatibility not proven; local runs use Node 24.12.0 | Owner pushes a branch / opens a PR (USR-06); attach the run log     |
| No coverage gate in CI (`npm test`, not `test:coverage`) | Coverage floors (80 / 80 / 80 / 75) enforced only locally  | Switch the step to `npm run test:coverage`                          |
| No dependency audit / SAST / secret scan               | Security checklist §23 "SAST / secret scan green" unmet    | Add `npm audit --omit=dev --audit-level=high`, CodeQL or Semgrep, gitleaks |
| No worker build artefact check                         | `dist/worker.js` existence not asserted                    | Add a step asserting `dist/server.js` and `dist/worker.js` exist   |
| Prisma validate needs a `DATABASE_URL` value           | CI uses a placeholder; no DB connection                    | Keep the placeholder, no secret                                     |
| `.nvmrc` = 22 vs local 24 (OQ-110 / DEC-18)            | Version drift                                              | Decide the Node line; add a 22 + 24 matrix if both are supported    |

**Local equivalent (verified 2026-11-21, Node 24.12.0):** `format:check`, `lint`, `typecheck`,
`openapi:check`, `build` and the full test suite with coverage. Results are in
`PHASE4-G4-FINAL-EVIDENCE-REPORT.md`.

## 2. Release / build artefacts

- **Build:** `npm run build` (tsc → `dist/`).
- **API start:** `npm start` (= `node dist/server.js`).
- **Worker start:** `npm run start:worker` (= `node dist/worker.js`). Requires `JOBS_ENABLED=true` for
  the worker; without it the worker exits 0.
- **Exactly one worker (D-61).** Configure the worker service with a desired / max count of **1**.
  Stop the old worker before starting a new one (no overlap during deploys).
- **Docker:** a `Dockerfile` scaffold exists. It was **not** validated here: build, non-root user,
  health checks and secret injection must be validated before use (runbook §4). No worker container
  or health endpoint exists (WP-O4 deferred).

## 3. Environment-variable inventory (from the validated schema `src/core/config/env.ts`)

Values are never stored in the repository. Secrets go to the host's secret manager.

**Strict environments.** For `NODE_ENV` = `staging` or `production` the schema **additionally
requires**:

- `JWT_ACCESS_PRIVATE_KEY`, `JWT_ACCESS_PUBLIC_KEY`, `REFRESH_TOKEN_PEPPER`, `FIELD_ENCRYPTION_KEY`;
- `COOKIE_SECURE` not `false`;
- `https://` for `API_BASE_URL`, `STOREFRONT_URL`, `ADMIN_URL` and all `CORS_ORIGINS`;
- `RATE_LIMIT_ENABLED` not `false`;
- `LOG_PRETTY` not `true`.

| Group             | Variables                                                                                                                                                                        | Secret? | Notes |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----- |
| Runtime           | `NODE_ENV` (development / test / staging / production), `APP_NAME`, `PORT` (4000), `APP_TIMEZONE` (= Asia/Kolkata), `TZ` (= UTC), `TRUST_PROXY`, `REQUEST_BODY_LIMIT`            | No      | `TRUST_PROXY` = number of proxy hops (1 behind a load balancer) |
| URLs / CORS       | `API_BASE_URL`, `STOREFRONT_URL`, `ADMIN_URL`, `CORS_ORIGINS`                                                                                                                    | No      | https in strict environments |
| Logging           | `LOG_LEVEL`, `LOG_PRETTY`                                                                                                                                                        | No      | |
| Rate limiting     | `RATE_LIMIT_ENABLED`, `RATE_LIMIT_DEFAULT_PER_MIN`                                                                                                                               | No      | In-memory, single instance (D-38) |
| Database          | `DATABASE_URL`                                                                                                                                                                   | **Yes** | Runtime DML user. Migration credentials are separate (`.env.migration`, G3) |
| Tokens            | `JWT_ACCESS_PRIVATE_KEY`, `JWT_ACCESS_PUBLIC_KEY`, `JWT_KEY_ID`, `JWT_PREVIOUS_PUBLIC_KEY`, `JWT_PREVIOUS_KEY_ID`, `JWT_ISSUER`, `JWT_ACCESS_TTL`, `JWT_AUDIENCE_STOREFRONT`, `JWT_AUDIENCE_ADMIN`, `REFRESH_TTL_STOREFRONT_DAYS`, `REFRESH_ADMIN_ABSOLUTE_HOURS`, `REFRESH_ADMIN_IDLE_HOURS`, `REFRESH_TOKEN_PEPPER` | **Keys / pepper: yes** | EdDSA keys; key rotation via the `PREVIOUS_*` pair |
| Cookies           | `COOKIE_DOMAIN_STOREFRONT`, `COOKIE_DOMAIN_ADMIN`, `COOKIE_SECURE`                                                                                                               | No      | |
| Passwords / auth  | `PASSWORD_HASH_MEMORY_KIB`, `PASSWORD_HASH_ITERATIONS`, `PASSWORD_PEPPER`, `REAUTH_WINDOW_MINUTES`, `LOGIN_MAX_ATTEMPTS_*`, `LOGIN_LOCK_MINUTES_*`, `PERMISSION_CACHE_TTL_SECONDS`, `VERIFICATION_TOKEN_TTL_MINUTES`, `PASSWORD_RESET_TTL_MINUTES`, `CAPTCHA_PROVIDER` (none), `MFA_ISSUER`, `SUPERADMIN_MAX` | **`PASSWORD_PEPPER`: yes** | `PASSWORD_PEPPER` is **not** enforced in strict environments by the schema. Recommend setting it before first production data (changing it later invalidates hashes) |
| Encryption        | `FIELD_ENCRYPTION_KEY`                                                                                                                                                           | **Yes** | AES-256-GCM field cipher (TOTP secrets) |
| Providers         | `EMAIL_PROVIDER` (fake), `WHATSAPP_PROVIDER` (fake), `PAYMENT_PROVIDER` (mock), `PAYMENT_WEBHOOK_SECRET`, `SHIPPING_PROVIDER` (mock), `SHIPPING_WEBHOOK_SECRET`, `MEDIA_PROVIDER` (mock / cloudinary), `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `CLOUDINARY_UPLOAD_FOLDER`, `MEDIA_MAX_UPLOAD_MB`, `MEDIA_ALLOWED_FORMATS` | **Webhook / Cloudinary secrets: yes** | Only fake / mock payment, e-mail, WhatsApp and shipping adapters exist; real providers are Phase 7. The mock payment / shipping providers are refused in production for webhooks |
| Checkout          | `RESERVATION_TTL_MINUTES`                                                                                                                                                        | No      | See FR-AD-008 (setting `checkout.reservation_ttl_minutes`) |
| Worker            | `JOBS_ENABLED`                                                                                                                                                                   | No      | `true` **only** for the single worker process |

## 4. Staging deployment prerequisites (none met yet)

1. **Hosting decision (DEC-08):** provider, region, budget, owner-created accounts.
2. **Database:**
   - managed MySQL 8 with PITR;
   - the baseline applied via the reviewed migration path (G7 / G8 equivalent for staging);
   - a runtime user with DML only;
   - a separate migration identity (G3 model).
3. **Secrets** in the host's secret manager (§3 strict list plus `DATABASE_URL`, `PASSWORD_PEPPER`).
4. **Services:** `api` (≥ 1 instance; in-memory rate limits and sessions are per instance, D-38 — run
   one API instance until Redis is decided) and `worker` (**exactly 1**).
5. **Health:** load-balancer readiness on `GET /health/ready` (database check only); there is no
   worker health endpoint.
6. **TLS / https** for all public URLs; CORS origins = the deployed storefront / admin origins.
7. **Logs:** structured pino logs shipped to the host's log service; no metrics or alerting exist
   (security self-assessment GAP).
8. **Seeds:** permissions, roles, states, settings and templates (template seed pending wording
   approval), then the Superadmin CLI. All user-executed, after the DB gates.

## 5. Rollback procedure (draft)

| Change type                            | Rollback                                                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Application release (API / worker)     | Redeploy the previous image / build. Stop the worker first, start the previous worker after the API is healthy |
| Configuration change                   | Restore the previous secret / config version in the secret manager; restart the services                       |
| Database migration                     | Forward-only migrations (expand / contract). Roll back by restoring the verified pre-migration backup (G2-style drill) or a compensating migration. Never run destructive DDL without a fresh verified backup |
| Data incident                          | PITR restore to a scratch instance, reconcile, then a targeted fix (owner-approved)                            |

**Prerequisite:** the backup / restore drill (G2) must PASS before any rollback plan is trusted.

## 6. Deployment evidence to collect (when authorized)

- the CI run URL / log on Node 22;
- the image digest / build id;
- the deployed version;
- health-check output;
- the worker start log ("exactly ONE worker process must run (D-61)");
- a smoke-test transcript (health, login, catalogue read);
- the rollback rehearsal record.

None of these exist yet.
