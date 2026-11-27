# CI/CD and Deployment Preparation (`ecommerce-api`)

| Field        | Value                                                                                                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document     | P4-CICD-PREP-01                                                                                                                                                                                                                 |
| Date         | 2026-11-21                                                                                                                                                                                                                      |
| Last updated | 2026-11-24 (Agent 9 — every statement re-checked against the files named under "Sources"; corrections are dated; §7 and §8 added)                                                                                               |
| Status       | **Preparation only.** No push, CI run, deployment, hosting account or live configuration change was made                                                                                                                        |
| Sources      | `.github/workflows/ci.yml`, `package.json`, `src/core/config/env.ts` (schema only; no `.env*` file was read), D-61, runbook. _(2026-11-24: also `Dockerfile`, `.nvmrc`, `vitest.config.ts`, `tsconfig.build.json`, read only.)_ |

**Not claimed:** a CI run, a container build, a staging deployment or production readiness. None
exists.

## 1. CI workflow (as it exists)

`.github/workflows/ci.yml` (job "CI (ecommerce-api)"):

_(Correction 2026-11-24: "CI (ecommerce-api)" is the **workflow** name. The single job is named
`quality`.)_

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

_(Update 2026-11-24, later: the workflow now has twelve steps. A step "Build artefacts present" (`test -f dist/server.js && test -f dist/worker.js`) follows the build, and the last step runs `npm run test:coverage` instead of `npm test`, so the coverage floors apply. Neither change has been observed in a CI run.)_

**Verified details (2026-11-24):**

- **Triggers:** `push` and `pull_request` on branches `main` and `develop`.
- **Runner and permissions:** `ubuntu-latest`; `permissions: contents: read`.
- **Actions:** `actions/checkout@v4`, `actions/setup-node@v4` with the npm cache keyed on
  `package-lock.json`.
- **Node version:** `.nvmrc` contains `22`, so the newest 22.x release is installed.
  `package.json` requires `>=22.13.0`.
- **Environment:** placeholders only, no secret. `NODE_ENV=test`, `DATABASE_URL` is a placeholder
  (no database connection), `LOG_LEVEL=silent`, `http://localhost` URLs.
- **No database job.** The workflow comment says database integration and migration jobs are to be
  added later. The real-database tests (`tests/db/`, DEC-12) are not part of CI.
- **The staging / production configuration rules are not exercised by a CI start-up.** CI runs with
  `NODE_ENV=test`. Those rules are covered only by unit tests (`tests/unit/core/env.test.ts`), and
  only in part (see §3).

**Gaps:**

| Gap                                                      | Impact                                                        | Proposal (needs authorization)                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **No CI run evidence** on the current code (QA-04)       | Node 22 compatibility not proven; local runs use Node 24.12.0 | Owner pushes a branch / opens a PR (USR-06); attach the run log                                          |
| No coverage gate in CI (`npm test`, not `test:coverage`) | Coverage floors (80 / 80 / 80 / 75) enforced only locally     | Switch the step to `npm run test:coverage` _(Done 2026-11-24; not observed in CI)_                       |
| No dependency audit / SAST / secret scan                 | Security checklist §23 "SAST / secret scan green" unmet       | Add `npm audit --omit=dev --audit-level=high`, CodeQL or Semgrep, gitleaks                               |
| No worker build artefact check                           | `dist/worker.js` existence not asserted                       | Add a step asserting `dist/server.js` and `dist/worker.js` exist _(Done 2026-11-24; not observed in CI)_ |
| Prisma validate needs a `DATABASE_URL` value             | CI uses a placeholder; no DB connection                       | Keep the placeholder, no secret                                                                          |
| `.nvmrc` = 22 vs local 24 (OQ-110 / DEC-18)              | Version drift                                                 | Decide the Node line; add a 22 + 24 matrix if both are supported                                         |

_(2026-11-24: the coverage floors are lines 80, statements 80, functions 80, branches 75
(`vitest.config.ts`). `src/server.ts` and `src/types/**` are excluded from coverage.)_

_Added 2026-11-24:_

| Gap                                              | Impact                                                             | Proposal (needs authorization)                               |
| ------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------ |
| No container build in CI                         | The `Dockerfile` is never built; its problems (§2) stay undetected | Add a build-only job after the Dockerfile corrections        |
| Actions pinned by major tag (`@v4`), not by hash | A changed tag would run unreviewed code                            | Pin to commit hashes when the supply-chain policy is decided |
| No job timeout                                   | A hung test run uses the default six-hour limit                    | Add `timeout-minutes`                                        |

**Local equivalent (verified 2026-11-21, Node 24.12.0):** `format:check`, `lint`, `typecheck`,
`openapi:check`, `build` and the full test suite with coverage. Results are in
`PHASE4-G4-FINAL-EVIDENCE-REPORT.md`.

_(Correction 2026-11-24: no file named `PHASE4-G4-FINAL-EVIDENCE-REPORT.md` exists in the
workspace. The current local results are in §8.)_

## 2. Release / build artefacts

- **Build:** `npm run build` (tsc → `dist/`).
  - _(2026-11-24: the script is `tsc -p tsconfig.build.json`. The generated Prisma client
    (`src/generated/`) is not committed, so `npx prisma generate` must run before the build, as CI
    does.)_
- **API start:** `npm start` (= `node dist/server.js`).
- **Worker start:** `npm run start:worker` (= `node dist/worker.js`). Requires `JOBS_ENABLED=true` for
  the worker; without it the worker exits 0.
- **Exactly one worker (D-61).** Configure the worker service with a desired / max count of **1**.
  Stop the old worker before starting a new one (no overlap during deploys).
- **Docker:** a `Dockerfile` scaffold exists. It was **not** validated here: build, non-root user,
  health checks and secret injection must be validated before use (runbook §4). No worker container
  or health endpoint exists (WP-O4 deferred).
  - _(Clarification 2026-11-24: the image defines a health check for the **API** (`/health/live` on
    port 4000). The **worker** has no health endpoint and no image or stage of its own.)_

**Shutdown timing (code-verified 2026-11-24).** Give each service a termination grace period that
is at least as long as its own limit:

| Process | Behaviour on SIGTERM / SIGINT                                                           | Forced exit | Source                                  |
| ------- | --------------------------------------------------------------------------------------- | ----------- | --------------------------------------- |
| API     | Marks itself not ready, stops accepting connections, drains for up to 25 s, disconnects | 30 s        | `src/core/lifecycle/httpServer.ts`      |
| Worker  | Stops scheduling, signals long jobs to stop after the current item, waits, disconnects  | 60 s        | `src/core/lifecycle/workerLifecycle.ts` |

**Dockerfile review (read only, 2026-11-24; the image was never built).** The file is a scaffold.
These points must be resolved before it is used. Changing the Dockerfile needs authorization.

| #   | Observation                                                                                                                                                                                                     | Effect                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **No `.dockerignore` exists.** The build stage runs `COPY . .` _(Update 2026-11-24, later: a `.dockerignore` now excludes `.env*`, `node_modules`, `dist`, `coverage` and `.git`. Never validated by a build.)_ | Any `.env*` file, `node_modules`, `dist` and `coverage` in the directory enter the build stage. The final stage copies only `dist`, `prisma` and `prisma.config.ts` |
| 2   | **No `prisma generate` step.** `src/generated/` is not committed                                                                                                                                                | A build from a clean checkout has no Prisma client sources for `npm run build`                                                                                      |
| 3   | The dependency stage runs `npm ci --omit=dev=false` while `NODE_ENV=production` is set                                                                                                                          | Whether the build tools (TypeScript) are installed was **not verified**                                                                                             |
| 4   | The `HEALTHCHECK` calls `/health/live` on port 4000                                                                                                                                                             | Correct for the API. A worker started from the same image would always be reported unhealthy; its health check must be disabled                                     |
| 5   | `ENV NODE_ENV=production` is set in the image                                                                                                                                                                   | A staging container must set `NODE_ENV=staging` explicitly if staging behaviour is wanted                                                                           |
| 6   | The base image is `node:22-alpine`, not pinned by digest                                                                                                                                                        | Resolves to the newest 22.x. Whether the native `argon2` module loads on it was **not verified**                                                                    |
| 7   | The final stage has production dependencies only                                                                                                                                                                | The Prisma CLI is a development dependency, so migrations cannot run from this image                                                                                |
| 8   | The final stage creates and uses a non-root user (`app`)                                                                                                                                                        | As intended; not verified by a build                                                                                                                                |

## 3. Environment-variable inventory (from the validated schema `src/core/config/env.ts`)

Values are never stored in the repository. Secrets go to the host's secret manager.

_(2026-11-24: the inventory below was compared with the schema. All 62 variables of the schema are
listed and no listed variable is missing from the schema.)_

**Strict environments.** For `NODE_ENV` = `staging` or `production` the schema **additionally
requires**:

- `JWT_ACCESS_PRIVATE_KEY`, `JWT_ACCESS_PUBLIC_KEY`, `REFRESH_TOKEN_PEPPER`, `FIELD_ENCRYPTION_KEY`;
- `COOKIE_SECURE` not `false`;
- `https://` for `API_BASE_URL`, `STOREFRONT_URL`, `ADMIN_URL` and all `CORS_ORIGINS`;
- `RATE_LIMIT_ENABLED` not `false`;
- `LOG_PRETTY` not `true`.

_(Verified 2026-11-24 in `crossFieldProblems`. The `https`, rate-limit and log rules have a unit
test. The four required secrets and the `COOKIE_SECURE` rule have no negative test; they are
code-verified only.)_

**Rules for every environment (added 2026-11-24, from the same function):**

- `STOREFRONT_URL` and `ADMIN_URL` must have different origins, and both origins must be listed in
  `CORS_ORIGINS`;
- `JWT_ACCESS_PRIVATE_KEY` and `JWT_ACCESS_PUBLIC_KEY` must be set together;
- `JWT_PREVIOUS_KEY_ID` is required when `JWT_PREVIOUS_PUBLIC_KEY` is set;
- `JWT_AUDIENCE_ADMIN` must differ from `JWT_AUDIENCE_STOREFRONT`;
- the three `CLOUDINARY_*` credentials are required when `MEDIA_PROVIDER=cloudinary`;
- `APP_TIMEZONE` must be `Asia/Kolkata` and `TZ` must be `UTC`.

**Checked after the schema, at process start (added 2026-11-24):** the JWT keys must be Ed25519
(`src/core/security/jwt.ts`) and `FIELD_ENCRYPTION_KEY` must decode to 32 bytes
(`src/core/security/fieldCipher.ts`). A wrong value stops the process.

**Not enforced by the schema in strict environments (added 2026-11-24).** Set these deliberately:

| Variable                                            | Why it matters                                                                                                                                 |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `PASSWORD_PEPPER`                                   | Optional. Adding or changing it after accounts exist invalidates their password hashes                                                         |
| `PAYMENT_WEBHOOK_SECRET`, `SHIPPING_WEBHOOK_SECRET` | Optional. If unset, the mock adapters verify webhooks with **public test values**. Mock webhooks are refused only when `NODE_ENV=production`   |
| `JWT_KEY_ID`                                        | Defaults to `dev-ephemeral`. Give the real key a real id so that key rotation can work                                                         |
| `APP_NAME`, `MFA_ISSUER`                            | Default to `[BRAND_NAME]` placeholders. `MFA_ISSUER` is what staff see in their authenticator app                                              |
| `TRUST_PROXY`                                       | Defaults to 0. Behind a load balancer the client IP, and therefore every per-IP rate limit, is wrong unless it equals the number of proxy hops |
| `COOKIE_DOMAIN_STOREFRONT`, `COOKIE_DOMAIN_ADMIN`   | Optional. Decide them with the final domain layout                                                                                             |

**Both processes use the same schema.** The worker calls the same loader as the API
(`src/bootstrap.ts`). In a strict environment the worker therefore needs the complete strict set
too, not only `DATABASE_URL` and `JOBS_ENABLED`.

| Group            | Variables                                                                                                                                                                                                                                                                                                                                                 | Secret?                               | Notes                                                                                                                                                                            |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime          | `NODE_ENV` (development / test / staging / production), `APP_NAME`, `PORT` (4000), `APP_TIMEZONE` (= Asia/Kolkata), `TZ` (= UTC), `TRUST_PROXY`, `REQUEST_BODY_LIMIT`                                                                                                                                                                                     | No                                    | `TRUST_PROXY` = number of proxy hops (1 behind a load balancer)                                                                                                                  |
| URLs / CORS      | `API_BASE_URL`, `STOREFRONT_URL`, `ADMIN_URL`, `CORS_ORIGINS`                                                                                                                                                                                                                                                                                             | No                                    | https in strict environments                                                                                                                                                     |
| Logging          | `LOG_LEVEL`, `LOG_PRETTY`                                                                                                                                                                                                                                                                                                                                 | No                                    |                                                                                                                                                                                  |
| Rate limiting    | `RATE_LIMIT_ENABLED`, `RATE_LIMIT_DEFAULT_PER_MIN`                                                                                                                                                                                                                                                                                                        | No                                    | In-memory, single instance (D-38)                                                                                                                                                |
| Database         | `DATABASE_URL`                                                                                                                                                                                                                                                                                                                                            | **Yes**                               | Runtime DML user. Migration credentials are separate (`.env.migration`, G3)                                                                                                      |
| Tokens           | `JWT_ACCESS_PRIVATE_KEY`, `JWT_ACCESS_PUBLIC_KEY`, `JWT_KEY_ID`, `JWT_PREVIOUS_PUBLIC_KEY`, `JWT_PREVIOUS_KEY_ID`, `JWT_ISSUER`, `JWT_ACCESS_TTL`, `JWT_AUDIENCE_STOREFRONT`, `JWT_AUDIENCE_ADMIN`, `REFRESH_TTL_STOREFRONT_DAYS`, `REFRESH_ADMIN_ABSOLUTE_HOURS`, `REFRESH_ADMIN_IDLE_HOURS`, `REFRESH_TOKEN_PEPPER`                                     | **Keys / pepper: yes**                | EdDSA keys; key rotation via the `PREVIOUS_*` pair                                                                                                                               |
| Cookies          | `COOKIE_DOMAIN_STOREFRONT`, `COOKIE_DOMAIN_ADMIN`, `COOKIE_SECURE`                                                                                                                                                                                                                                                                                        | No                                    |                                                                                                                                                                                  |
| Passwords / auth | `PASSWORD_HASH_MEMORY_KIB`, `PASSWORD_HASH_ITERATIONS`, `PASSWORD_PEPPER`, `REAUTH_WINDOW_MINUTES`, `LOGIN_MAX_ATTEMPTS_*`, `LOGIN_LOCK_MINUTES_*`, `PERMISSION_CACHE_TTL_SECONDS`, `VERIFICATION_TOKEN_TTL_MINUTES`, `PASSWORD_RESET_TTL_MINUTES`, `CAPTCHA_PROVIDER` (none), `MFA_ISSUER`, `SUPERADMIN_MAX`                                             | **`PASSWORD_PEPPER`: yes**            | `PASSWORD_PEPPER` is **not** enforced in strict environments by the schema. Recommend setting it before first production data (changing it later invalidates hashes)             |
| Encryption       | `FIELD_ENCRYPTION_KEY`                                                                                                                                                                                                                                                                                                                                    | **Yes**                               | AES-256-GCM field cipher (TOTP secrets)                                                                                                                                          |
| Providers        | `EMAIL_PROVIDER` (fake), `WHATSAPP_PROVIDER` (fake), `PAYMENT_PROVIDER` (mock), `PAYMENT_WEBHOOK_SECRET`, `SHIPPING_PROVIDER` (mock), `SHIPPING_WEBHOOK_SECRET`, `MEDIA_PROVIDER` (mock / cloudinary), `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `CLOUDINARY_UPLOAD_FOLDER`, `MEDIA_MAX_UPLOAD_MB`, `MEDIA_ALLOWED_FORMATS` | **Webhook / Cloudinary secrets: yes** | Only fake / mock payment, e-mail, WhatsApp and shipping adapters exist; real providers are Phase 7. The mock payment / shipping providers are refused in production for webhooks |
| Checkout         | `RESERVATION_TTL_MINUTES`                                                                                                                                                                                                                                                                                                                                 | No                                    | See FR-AD-008 (setting `checkout.reservation_ttl_minutes`)                                                                                                                       |
| Worker           | `JOBS_ENABLED`                                                                                                                                                                                                                                                                                                                                            | No                                    | `true` **only** for the single worker process                                                                                                                                    |

**Consequences of mock-only providers (added 2026-11-24, code-verified).**

- **No e-mail or WhatsApp message leaves the system.** In any environment, staging included, the
  fake adapters record messages in memory. Reset and verification links are not delivered.
- **Payments are simulated.** The mock payment adapter's client-signature secret is a public
  constant that configuration cannot change. An environment that runs it holds test data only.
- **No start-up rule refuses the mock payment provider in production.** Only the two webhook
  handlers check for it. Production must not be started until a real provider exists (Phase 7).
  See finding A9-F02 in `SECURITY_SELF_ASSESSMENT-G4-DRAFT.md`.
  - _Correction 2026-11-24 (D1): a start-up rule now exists. The API and the worker exit with code 1 when `NODE_ENV=production` and the payment provider is the mock (`src/container.ts`, `src/bootstrap.ts`), and `POST /payments/verify` refuses the mock in production. Tested with mocks only; no real process was started. Production still cannot run until a real provider exists._

## 4. Staging deployment prerequisites (none met yet)

1. **Hosting decision (DEC-08):** provider, region, budget, owner-created accounts.
2. **Database:**
   - managed MySQL 8 with PITR;
   - the baseline applied via the reviewed migration path (G7 / G8 equivalent for staging);
   - a runtime user with DML only;
   - a separate migration identity (G3 model).
3. **Secrets** in the host's secret manager (§3 strict list plus `DATABASE_URL`, `PASSWORD_PEPPER`).
   - _(2026-11-24: also `PAYMENT_WEBHOOK_SECRET` and `SHIPPING_WEBHOOK_SECRET`; see §3.)_
4. **Services:** `api` (≥ 1 instance; in-memory rate limits and sessions are per instance, D-38 — run
   one API instance until Redis is decided) and `worker` (**exactly 1**).
   - _(Precision 2026-11-24: refresh-token sessions and idempotency keys are stored in the
     database. Per instance are the rate-limit counters, re-auth markers, MFA challenges, OTP
     cooldowns, the refresh grace window and the permission cache.)_
5. **Health:** load-balancer readiness on `GET /health/ready` (database check only); there is no
   worker health endpoint.
6. **TLS / https** for all public URLs; CORS origins = the deployed storefront / admin origins.
7. **Logs:** structured pino logs shipped to the host's log service; no metrics or alerting exist
   (security self-assessment GAP).
8. **Seeds:** permissions, roles, states, settings and templates (template seed pending wording
   approval), then the Superadmin CLI. All user-executed, after the DB gates.

## 5. Rollback procedure (draft)

| Change type                        | Rollback                                                                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application release (API / worker) | Redeploy the previous image / build. Stop the worker first, start the previous worker after the API is healthy                                                                                                |
| Configuration change               | Restore the previous secret / config version in the secret manager; restart the services                                                                                                                      |
| Database migration                 | Forward-only migrations (expand / contract). Roll back by restoring the verified pre-migration backup (G2-style drill) or a compensating migration. Never run destructive DDL without a fresh verified backup |
| Data incident                      | PITR restore to a scratch instance, reconcile, then a targeted fix (owner-approved)                                                                                                                           |

**Prerequisite:** the backup / restore drill (G2) must PASS before any rollback plan is trusted.

_(2026-11-24: G2 is still in user execution and **not accepted** — Step 0 PASS, Step 1 not verified
(`docs/G2-EXECUTION-LOG.md`). This rollback draft has never been rehearsed.)_

## 6. Deployment evidence to collect (when authorized)

- the CI run URL / log on Node 22;
- the image digest / build id;
- the deployed version;
- health-check output;
- the worker start log ("exactly ONE worker process must run (D-61)");
- a smoke-test transcript (health, login, catalogue read);
- the rollback rehearsal record.

None of these exist yet.

## 7. Pre-deployment validation checklist (added 2026-11-24)

**Status of every item: not done.** This is a preparation checklist for the first staging
deployment. Nothing in it has been executed.

### 7.1 Decisions and acceptances (owner)

- [ ] Hosting chosen (DEC-08).
- [ ] Node line chosen (DEC-18).
- [ ] Security self-assessment accepted (G4 criterion 4), including the reading of finding A9-F02. _(A9-F02 was classified S2 and fixed on 2026-11-24, D1.)_
- [x] Batch 9 and Batch 10 accepted, with the risk acknowledgement (RK-01 … RK-13). _(Done 2026-11-24: both are ACCEPTED — OFFLINE MOCKED SCOPE ONLY. The acceptance does not cover deployment readiness, and the acknowledged risks stay open.)_
- [ ] Real-database test execution decided (DEC-12). _(Clarification 2026-11-27: the requirement was decided on 2026-11-27 — real MySQL verification of the six concurrency scenarios is mandatory for G4. This item is not ticked by that decision, and it is not evidence that execution has occurred: the six scenarios remain PREPARED — NOT EXECUTED. Execution requires G7 PASS and a separate explicit written owner authorization. G7 PASS alone is insufficient.)_

### 7.2 Code and quality gates

- [ ] `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run build`,
      `npm run openapi:check` and `npm run test:coverage` all pass locally on the chosen Node line.
- [ ] The same steps pass in a CI run on Node 22; the run URL is recorded.
- [ ] `dist/server.js` and `dist/worker.js` exist in the build output.
- [ ] `npm audit --omit=dev` shows no high or critical finding (needs the network).
- [ ] No open S1 / S2 defect (D-62).

### 7.3 Database gates

- [ ] G2 backup / restore drill passed and accepted.
- [ ] G3 migration identity created and accepted.
- [ ] Baseline and seeds applied to the staging database through the reviewed path (G7 / G8
      equivalent).
- [ ] The runtime user has DML rights only; the migration credential is stored separately.
- [ ] Backups are enabled on the staging database and one restore was tested.

### 7.4 Configuration (per service: API **and** worker)

- [ ] `NODE_ENV=staging`.
- [ ] `JWT_ACCESS_PRIVATE_KEY`, `JWT_ACCESS_PUBLIC_KEY` (Ed25519), `REFRESH_TOKEN_PEPPER` and
      `FIELD_ENCRYPTION_KEY` (32 bytes) are present, generated for this environment and never
      reused from development.
- [ ] `JWT_KEY_ID` is set to a real key id.
- [ ] `PASSWORD_PEPPER` is set **before** the first account is created.
- [ ] `PAYMENT_WEBHOOK_SECRET` and `SHIPPING_WEBHOOK_SECRET` are set to private values.
- [ ] `API_BASE_URL`, `STOREFRONT_URL`, `ADMIN_URL` and `CORS_ORIGINS` use `https`; the two
      frontend origins differ and both are listed.
- [ ] `COOKIE_SECURE` is unset or `true`; cookie domains are decided.
- [ ] `TRUST_PROXY` equals the number of proxy hops in front of the API.
- [ ] `RATE_LIMIT_ENABLED` is not `false`; `LOG_PRETTY` is not `true`; `LOG_LEVEL` is `info`.
- [ ] `APP_NAME` and `MFA_ISSUER` no longer contain `[BRAND_NAME]`.
- [ ] `JOBS_ENABLED=true` is set for the worker only.
- [ ] A start with one required value removed stops with a message that names the variable and
      prints no value.

### 7.5 Services

- [ ] One API instance (in-memory state, D-38).
- [ ] Exactly one worker: desired and maximum count 1; the old worker stops before the new one
      starts.
- [ ] Readiness probe on `GET /health/ready`; liveness on `GET /health/live` (API only).
- [ ] No HTTP health check on the worker.
- [ ] Termination grace period at least 30 s for the API and 60 s for the worker.
- [ ] Logs from both processes reach the host's log service.

### 7.6 Container image (only if the Dockerfile is used)

- [ ] Observations 1–7 of the Dockerfile review in §2 are resolved, and observation 8 is confirmed by a build.
- [ ] The image builds from a clean checkout.
- [ ] No `.env*` file is present in any image layer.
- [ ] The process runs as the non-root user and the native `argon2` module loads.

### 7.7 Smoke tests after deployment

- [ ] `GET /health/live` → 200; `GET /health/ready` → 200 with `database: ok`.
- [ ] Staff login and customer login succeed; refresh cookies carry `Secure` and `HttpOnly`.
- [ ] A public catalogue read succeeds.
- [ ] Repeated wrong logins give 429 with `Retry-After`.
- [ ] A webhook call with a wrong signature gives 401.
- [ ] A request from an origin that is not allow-listed gives 403.
- [ ] The worker log shows "background worker started: exactly ONE worker process must run (D-61)…"
      and a "worker heartbeat" line every minute.
- [ ] The API log shows no "JOBS_ENABLED=true is ignored by the API process" warning.

### 7.8 Rollback readiness

- [ ] The previous build is available for redeployment.
- [ ] A database backup was taken immediately before the deployment.
- [ ] The rollback steps of §5 were rehearsed once.

## 8. Current local gate results (added 2026-11-24)

**These are local results on Node 24.12.0 with a mocked database. They are not CI results.** CI
uses Node 22 and has no recorded run.

| Gate                              | Result                                                                                                                                  | Source                                                     |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `npm run typecheck`               | PASS                                                                                                                                    | Phase 4 orchestrator's baseline run, 2026-11-24            |
| `npm run build`                   | PASS                                                                                                                                    | Same                                                       |
| `npm run openapi:check`           | PASS                                                                                                                                    | Same                                                       |
| Full test suite with coverage     | PASS — 113 test files; 3,005 passed, 3 todo, 0 failed. Coverage: statements 92.05 %, branches 82.59 %, functions 94.67 %, lines 93.80 % | Same                                                       |
| `npm run lint`                    | **FAIL** — only in unfinished real-database harness files, which another work stream is repairing                                       | Same                                                       |
| `npm run format:check`            | **FAIL** — the same harness files, plus two unformatted documents. One was this document; it is formatted now                           | Same                                                       |
| Security-relevant test files only | PASS — 58 test files, 2,152 tests                                                                                                       | Run by Agent 9 on 2026-11-24 with `npx vitest run <files>` |

**Reading these results.**

- Agent 9 did not run the full suite, the build or the repository-wide lint and format checks. The
  first six rows repeat the orchestrator's baseline.
- `lint` and `format:check` must be run again after the harness repair. Until both pass, the local
  equivalent of the CI workflow is **not green**.
- Coverage is above all four floors (80 / 80 / 80 / 75).
- The earlier local record of 2026-11-21 (§1) is not re-stated here.

**Update 2026-11-24 — after the harness repair and after the D1 fix (orchestrator runs, local, Node
24.12.0, mocked database; still not CI).** The table above is the baseline and is kept as the
earlier record.

| Gate                                                | After the harness repair                  | After the D1 fix                          |
| --------------------------------------------------- | ----------------------------------------- | ----------------------------------------- |
| `npm run format:check`                              | PASS                                      | PASS                                      |
| `npm run lint`                                      | PASS                                      | PASS                                      |
| `npm run typecheck`                                 | PASS                                      | PASS                                      |
| `npm run build`                                     | PASS                                      | PASS                                      |
| `npm run openapi:check`                             | PASS                                      | PASS                                      |
| Full suite with coverage                            | 119 files; 3,110 passed, 3 todo, 0 failed | 120 files; 3,124 passed, 3 todo, 0 failed |
| Coverage: statements / branches / functions / lines | 92.08 / 82.63 / 94.70 / 93.81 %           | 92.11 / 82.69 / 94.74 / 93.86 %           |

The local equivalent of the CI workflow is green. No CI run has been recorded.
