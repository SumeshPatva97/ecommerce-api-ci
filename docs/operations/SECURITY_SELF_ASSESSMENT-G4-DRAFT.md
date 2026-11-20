# Security Self-Assessment — G4 Draft (`ecommerce-api`)

| Field      | Value                                                                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Document   | P4-SEC01-DRAFT-01 (roadmap SEC-01)                                                                                                       |
| Date       | 2026-11-20                                                                                                                               |
| Checklist  | `project-documentation/07-security/SECURITY_GUIDELINES.md` §23 "Release security checklist"                                              |
| Status     | **DRAFT — for owner review.** Not an acceptance. G4 criterion 4 is met only when you accept a completed assessment                       |
| Supersedes | Nothing yet. The interim `SECURITY_SELF_ASSESSMENT.md` (2026-11-17) is unchanged; this draft would replace it on acceptance              |
| Method     | Static code / test search and existing records only. No tests executed for this draft; no database, staging, network or external service |

Result codes:

- **MET:** code / test evidence found.
- **PARTIAL:** met with a documented gap or exception.
- **GAP:** not met.
- **NOT VERIFIABLE NOW:** needs staging, a database, Git / CI or a tool not available.
- **N/A:** not applicable to this repository or phase.

## Code & dependencies

| Checklist item                                                                                          | Result           | Evidence / note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New endpoints have Zod `.strict()` schemas and declared permissions; critical ones have `requireReauth` | **PARTIAL**      | **Bodies:** every request-body schema found is `z.strictObject` (91 strict objects; no non-strict `…Body` schema found). **Params / query:** 58 `z.object` schemas are non-strict, but the `validate` middleware replaces `req.body` / validated input, so unknown keys are stripped, not used. **Permissions / re-auth:** enforced at start-up by `assertAdminRoutesGuarded` (`src/core/http/routeTable.ts`; startup admin-route self-check, master report §10 2b) with one documented exemption (`POST /refunds/:refundId/reject`), plus the whole-app route-table test |
| Customer endpoints use ownership-scoped helpers; IDOR tests added                                       | **MET (mocked)** | IDOR-style tests: `tests/integration/modules/{cart,me-addresses,orders,payments,wishlist}` (another customer's resource → 404). Mocked DB only                                                                                                                                                                                                                                                                                                                                                                                                                            |
| No `$queryRawUnsafe`; no unsafe HTML; no secrets in code                                                | **PARTIAL**      | One `$queryRawUnsafe('SELECT 1')` in `src/core/db/prisma.ts` (readiness ping; constant string, no input). A literal deviation, no injection risk; record as an accepted exception or change to `$queryRaw` (code change needs authorization). `dangerouslySetInnerHTML`: N/A (no frontend). No secrets in code: static security sweep (master report §9); `sanitize-html` allowlist for product HTML                                                                                                                                                                      |
| Response DTOs: no sensitive fields                                                                      | **PARTIAL**      | `passwordHash` is selected only in `auth.repository.ts` (credential check). `costPrice` appears in admin product / inventory / report modules and in checkout (order snapshot), not in the storefront catalog module (search). Not exhaustively verified per DTO                                                                                                                                                                                                                                                                                                          |
| `npm audit` high / critical = 0; Dependabot triaged                                                     | **PARTIAL**      | Recorded 2026-11-19: production 0 vulnerabilities; dev 8 moderate (ESLint tooling). Not re-run in this draft (QA-05). Dependabot: NOT VERIFIABLE NOW (no Git / GitHub access)                                                                                                                                                                                                                                                                                                                                                                                             |
| SAST / secret scan green                                                                                | **GAP**          | `.github/workflows/ci.yml` has no SAST, secret-scan or audit step. No CI run evidence (QA-04)                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Configuration

| Checklist item                                                             | Result                 | Evidence / note                                                                                                                                                  |
| -------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CORS origins, CSP, security headers reviewed; CSP report-only reviewed     | **PARTIAL**            | `src/core/middleware/security.ts` (helmet with CSP), `cors.ts` (configured origins). CSP violation reports: NOT VERIFIABLE NOW (no deployed environment)         |
| New third-party domains justified / allow-listed                           | **N/A (Phase 4)**      | Only fake provider adapters; real providers are Phase 7                                                                                                          |
| Env schema updated; secrets created in the secrets manager per environment | **PARTIAL**            | `src/core/config/env.ts` validated schema. Secrets manager per environment: NOT VERIFIABLE NOW (hosting OQ-34 undecided). `.env.example` revert pending (DEC-10) |
| Migrations reviewed for DB grants (audit / tax tables insert-only)         | **NOT VERIFIABLE NOW** | Grants belong to the G3 procedure; baseline not applied (G7 / G8 not authorized)                                                                                 |

## Data & privacy

| Checklist item                                                    | Result           | Evidence / note                                                                                                                            |
| ----------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| New personal-data fields classified (purpose, retention, masking) | **PARTIAL**      | Retention periods are PROPOSED pending OQ-38 / RD-11. A field-by-field classification was not produced in this draft                       |
| Redaction list updated; redaction tests pass                      | **MET (mocked)** | Redaction tests: `tests/unit/core/logger.test.ts`, `tests/unit/core/libs.test.ts`, payments and settings integration tests (recorded PASS) |
| New exports / prints audited                                      | **MET (mocked)** | Audit-log export (`audit-logs.service.ts`, `EXPORT`), report exports (`reports.service.ts` `recordSafe`, `reportExport.ts` `EXPORT`)       |

## Auth & RBAC

| Checklist item                                                                    | Result           | Evidence / note                                                                                                                                        |
| --------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| New permission keys added (migration / seed), auto-granted to ADMIN, in CHANGELOG | **PARTIAL**      | 88 permission keys in the RBAC service; granted via the seed (seed **not executed**, G8). Migration-based grant not used. CHANGELOG entry not verified |
| Anti-escalation tests pass                                                        | **MET (mocked)** | `tests/integration/modules/staff/{roles,users}.test.ts`, `tests/unit/modules/staff/staff.policy.test.ts` (recorded PASS)                               |

## Operations

| Checklist item                                         | Result                 | Evidence / note                                                                                     |
| ------------------------------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------- |
| Monitoring / alerts for new jobs, queues, integrations | **GAP**                | Structured logs only (pino); no metrics or alerting (runbook §6; jobs doc §6 "No metrics/alerting") |
| Rollback plan documented; backups verified recent      | **GAP**                | Rollback guidance is generic (runbook §8); backup / restore drill G2 not completed                  |
| DAST on staging: no new high findings                  | **NOT VERIFIABLE NOW** | No staging environment (SEC-04, DEC-08)                                                             |
| Penetration test (launch / major releases)             | **N/A (Phase 4)**      | Applies to launch (Phase 9)                                                                         |

## Broader control areas (added 2026-11-20, session 3; code-verified by search)

Result codes:

- **VERIFIED PASS:** code (and a recorded mocked test) supports the control.
- **PARTIAL:** supported, with a gap.
- **NOT TESTED:** no test found.
- **DEFERRED / BLOCKED:** as stated.

| Area                         | Result                           | Evidence                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication               | VERIFIED PASS (mocked)           | Access tokens: EdDSA / Ed25519 JWT on `node:crypto`, with `alg` pinned per `kid` (rejects `none` / HS256), plus `iss`, exact `aud`, `typ` and `exp` checks (`core/security/jwt*.ts` header). Refresh-token rotation with a grace window (TC-004; concurrency needs DEC-12)                                                                   |
| Authorization / roles        | VERIFIED PASS (mocked)           | Start-up admin-route guard check (`core/http/routeTable.ts`); anti-escalation tests. **Executed route × role matrix** (`tests/integration/routeRoleMatrix.test.ts`, 1,113 cases, 2026-11-20): 166 guarded admin routes, 37 customer routes, no defect. Real-DB permission resolution and service-level ownership checks are not proven by it |
| Password handling            | PARTIAL                          | Argon2id with a pepper and a dummy hash for timing (`core/security/password.ts`). The breached-password check is an offline list only (FR-AUTH-010; external API deferred)                                                                                                                                                                   |
| Session / cookie security    | VERIFIED PASS (mocked)           | Refresh cookies on cookie-only endpoints, with an Origin + `X-Client` CSRF guard (`requireCookieOrigin`, `auth.routes.ts`). TC-006 tests assert HttpOnly, SameSite, Path, and `Secure` following `COOKIE_SECURE` (default secure outside development / test, `env.ts` line 414). Staff 30-minute lockout asserted (TC-003)                   |
| Rate limiting                | PARTIAL                          | Route-class limits exist; in-memory store, single instance only (`rateLimit.ts`, D-38)                                                                                                                                                                                                                                                       |
| Input validation             | VERIFIED PASS                    | Strict request bodies; params / query stripped; 422 envelope (`validate.ts`)                                                                                                                                                                                                                                                                 |
| SQL injection                | VERIFIED PASS                    | Prisma queries; raw SQL via tagged `$queryRaw` / `Prisma.sql`; report identifiers allow-listed (`reports.sql.ts`). One constant `$queryRawUnsafe('SELECT 1')` exception (see above)                                                                                                                                                          |
| XSS / output                 | VERIFIED PASS (API)              | JSON API; product HTML sanitised with the `sanitize-html` allowlist. Frontend output handling: Phases 5 / 6                                                                                                                                                                                                                                  |
| CSRF                         | VERIFIED PASS (cookie endpoints) | Bearer tokens for API calls; cookie endpoints require Origin + `X-Client`                                                                                                                                                                                                                                                                    |
| File upload                  | PARTIAL / DEFERRED               | Cloudinary signed uploads (no file bytes through the API); size / format limits not server-checked (FR-PV-012); Cloudinary verification deferred (EXT-04)                                                                                                                                                                                    |
| Sensitive information        | PARTIAL                          | Error handler never returns stacks or internal messages (`errorHandler.ts`); logger redaction tests. A per-DTO review was not done                                                                                                                                                                                                           |
| Audit logging                | VERIFIED PASS (mocked)           | Audit service with redaction. Tests assert: staff LOGIN audit with no secrets in any audit row (TC-063); DENY → 403 plus audit (TC-010); the Superadmin action audited as SUPERADMIN (TC-008; no dedicated bypass event, see DC-04)                                                                                                          |
| Payment / refund security    | PARTIAL                          | Server-side amounts, amount-mismatch handling, idempotent capture; maker-checker on refunds (SELF_APPROVAL test). M-1 (five paths) open (DEC-05)                                                                                                                                                                                             |
| Webhook verification         | VERIFIED PASS (mocked)           | Payments: `provider.verifyWebhook` before processing; invalid → 401 and security log (`payments.service.ts` `handleWebhook`). Shipping: always signature-verified; the mock provider is rejected in production (`shipping.shipments.ts` ~924). Email / WhatsApp webhooks blocked (OQ-08)                                                     |
| Error handling / logging     | VERIFIED PASS                    | Canonical error envelope; 5xx logged with stack server-side only; pino with redaction                                                                                                                                                                                                                                                        |
| Dependencies / configuration | PARTIAL                          | `npm audit` recorded 2026-11-19 (production 0); no CI scanning; zod-validated env; `.env.example` decision pending (DEC-10)                                                                                                                                                                                                                  |

**Defect classification (TESTING_STRATEGY §19, pending DEC-14):** no S1 / S2 security defect has
been identified.

The test-only work (2026-11-20, `PHASE4-G4-TEST-ONLY-WORK-COMPLETION-REPORT.md` §3) found one
**verified security-relevant defect**:

- **DF-02 (proposed S3):** the notification secret-variable guard does not block `upiId` /
  `razorpayPaymentId`, which NOTIFICATION_WORKFLOWS §9 forbids in stored payloads. No current caller
  passes them, and no template renders them.

It also found a related latent functional defect:

- **DF-01:** the same guard blocks `forgotPasswordUrl`.

Neither is fixed (test-only scope). The other open items are gaps or deferrals.

## Known security-relevant limitations (from Phase 4 records)

- In-memory rate limiting, sessions, idempotency and permission cache are single-instance only (D-38,
  SEC-03).
- M-1: refunds interrupted after commit stay `PROCESSING` (five code paths); `complete` relies on a
  procedural rule (provider confirmation), not enforced by code.
- Exactly-one-worker deployment rule, not enforced.
- MFA recovery codes blocked (schema SCP-1).
- All test evidence is mocked / offline.

## Summary

| Result             | Count |
| ------------------ | ----- |
| MET (mocked)       | 4     |
| PARTIAL            | 8     |
| GAP                | 3     |
| NOT VERIFIABLE NOW | 2     |
| N/A                | 2     |

**Gaps needing your decision or authorization before G4:**

- SAST / secret scan in CI (and a CI run at all, QA-04);
- monitoring / alerting, or a formal deferral;
- backup verification (G2) and the rollback plan;
- the `$queryRawUnsafe` exception (accept, or authorize a one-line change);
- a personal-data field classification;
- items needing staging or a database (DAST, grants, secrets manager), or their formal deferral (DEC-08 / DEC-12 / DEC-13).

This draft does not accept anything and changes no status.
