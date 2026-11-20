# Phase 4 — Final Backend Hardening Report

| Field       | Value                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| Document ID | P4-HARD-01                                                                                            |
| Date        | 2026-11-19                                                                                            |
| Status      | **Phase 3 APPROVED AND COMPLETE · Phase 4 IN PROGRESS — NOT APPROVED**                                |
| Gates       | G2 USER EXECUTION PENDING · G3 NOT ACCEPTED · G7/G8 NOT AUTHORIZED                                    |
| Evidence    | All tests use a **mocked Prisma client**. No database integration or production readiness is claimed. |

## 1. Owner decisions applied

| #   | Decision                  | Result                                                                                                                                                                                                  | Record    |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 1   | Admin MFA enrolment       | `POST /admin/auth/mfa/enroll` + `/mfa/confirm` implemented; unenrolled Superadmin/Admin **cannot obtain a session**; refresh of such sessions refused and revoked                                       | D-60      |
| 2   | GSTIN settings            | Canonical `tax.seller_gstin` / `tax.seller_state_code`; duplicate `store.gstin` / `store.state_code` removed from validator and seed; `/settings/public` publishes `store.gstin` from the canonical key | D-57      |
| 3   | CGST/SGST rounding        | Kept **PROVISIONAL**; exact rule and CA question documented                                                                                                                                             | RD-01     |
| 4   | Five extra routes         | Reviewed: all supported by approved material; **kept**, documented in API_DOCUMENTATION §4.4 pending catalogue confirmation; nothing removed                                                            | RD-02     |
| 5   | Admin cancel permission   | `orders.update` **and** `orders.approve` (already implemented); explicit denial test added; API docs updated                                                                                            | D-58      |
| 6   | Schema-dependent features | Kept blocked; proposal written; `schema.prisma` and baseline untouched                                                                                                                                  | P3-SCP-01 |
| 7   | HTTP status consistency   | Forgot-password / resend: **202** identical for unknown accounts; lockout: **401** identical to wrong password; **429** only for route rate limits                                                      | D-59      |
| 8   | Infrastructure blockers   | Maintained; interfaces + mocks only                                                                                                                                                                     | RD-06     |

## 2. MFA enrolment design (decision 1)

| Step                                                        | Behaviour                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login / accept-invite (Superadmin or `ADMIN` role, MFA off) | Password verified (lockout rules apply) → **no session, no cookie**; 200 `{ mfaEnrollmentRequired, enrollmentToken, expiresIn: 900 }`; audited `LOGIN` FAILURE `MFA_ENROLLMENT_REQUIRED`                                                                                                                                     |
| `POST /admin/auth/mfa/enroll`                               | `enrollmentToken` (peeked, not consumed) **or** a signed-in staff Bearer (voluntary). Generates a TOTP secret held **encrypted in server memory** for 15 min; nothing written to the DB. Repeat call rotates the secret. Secret returned once (`Cache-Control: no-store`), never logged or audited                           |
| `POST /admin/auth/mfa/confirm`                              | Valid TOTP (±1 step, replay-protected) → `mfa_enabled = true`, encrypted secret stored (conditional update `WHERE mfa_enabled = false`), audit `auth.mfa_enrolled`; token flow then issues the session; invalid code → 401 `MFA_INVALID` + lockout counter; 5 failures discard the pending secret (`MFA_ENROLLMENT_EXPIRED`) |
| Refresh                                                     | Mandatory-MFA user without MFA (e.g. promoted after sign-in) → family revoked, 401 `MFA_ENROLLMENT_REQUIRED`                                                                                                                                                                                                                 |
| Customers                                                   | Unaffected (test)                                                                                                                                                                                                                                                                                                            |
| Recovery codes                                              | Still **blocked** (schema, SCP-1); `recoveryCode` → 422 `NOT_SUPPORTED`                                                                                                                                                                                                                                                      |

Residual limitation: an access token issued **before** a role promotion stays valid until expiry
(≤ 15 min) — the refresh check closes the session at the next rotation.

## 3. Files changed in this hardening round

**Source**

- `src/modules/admin-auth/mfa.ts` — `peekEnrollmentToken`, `startPendingEnrollment`, `verifyPending`
- `src/modules/admin-auth/admin-auth.service.ts` — enforcement in login / accept-invite / refresh; `enrollMfa`, `confirmMfa`; `runLogin` split
- `src/modules/admin-auth/admin-auth.controller.ts`, `admin-auth.routes.ts`, `admin-auth.schemas.ts` — two routes, strict bodies, enrollment payload
- `src/modules/settings/settings.values.ts`, `settings.service.ts` — duplicate GSTIN keys removed; public GSTIN from canonical key
- `prisma/seed/settings.seed.ts` — duplicate GSTIN rows removed (not run)
- `src/modules/orders/orders.routes.ts` — comment updated (D-58)

**Tests** (all MOCKED DB)

- New: `tests/integration/modules/auth/adminMfaEnrollment.test.ts` (10), `tests/integration/modules/auth/statusConsistency.test.ts` (5), `tests/integration/modules/settings/publicGstin.test.ts` (3)
- Updated: `tests/integration/modules/auth/adminAuth.test.ts` (enforcement assertion), `tests/integration/modules/orders/orders.routes.test.ts` (+1 cancel-permission test), `tests/unit/modules/staff/seeds.test.ts`

**Documentation**

- `project-documentation/04-backend/API_DOCUMENTATION.md` — §3.1 lockout/202 wording; §4.1 MFA routes, login/accept-invite enrolment variants, 202 forgot-password, `adm_rt` cookie routes; §4.4 implemented additions; §4.7 + §7 admin cancel permission
- `project-documentation/01-requirements/PROJECT_CONTEXT.md` — §8.1 MFA routes; §17.6 D-57 … D-60
- `project-documentation/05-database/DATABASE_DESIGN.md` — `store.gstin` / `store.state_code` marked superseded
- `ecommerce-api/docs/openapi/openapi.json` — regenerated (248 operations)
- New: `PHASE4-FINAL-BACKEND-HARDENING-REPORT.md`, `PHASE4-REMAINING-DECISIONS.md`, `PHASE3-SCHEMA-CHANGE-PROPOSAL.md`; updated `PHASE3-PHASE4-MASTER-PROGRESS-REPORT.md`

**Incident during this round (fixed):** a documentation edit script used JavaScript `String.replace`, whose
replacement pattern `` $` `` (present in the new `mfa/confirm` row text `^\d{6}$`) spliced a copy of the
first 916 lines of API_DOCUMENTATION.md into that row. Detected by a line-count check; repaired by
removing exactly the spliced segment after proving it byte-identical to the document prefix. Final file:
1 708 lines before the §4.4 addition (original 1 706 + 2 new rows), header present once. Later doc edits
used the Edit tool. No source file was affected (typecheck and tests would have failed).

## 4. Verification (executed 2026-11-19, Windows, Node 24.12.0)

| Check                                                 | Result                                                                                                                                 |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run format:check`                                | PASS                                                                                                                                   |
| `npm run lint` (`--max-warnings 0`)                   | PASS                                                                                                                                   |
| `npm run typecheck`                                   | PASS                                                                                                                                   |
| `npm run build`                                       | PASS                                                                                                                                   |
| `npx prisma validate` (placeholder URL, offline)      | PASS                                                                                                                                   |
| `npx prisma generate` (offline)                       | PASS — 75 files, unchanged                                                                                                             |
| `npm run openapi:check`                               | PASS — 248 operations, no drift                                                                                                        |
| `npx vitest run --coverage`                           | **88 files / 1 254 tests PASS** (mocked DB)                                                                                            |
| Coverage (floors 80/80/80/75)                         | lines 93.24 % · statements 91.45 % · functions 94.17 % · branches 81.63 %                                                              |
| Route-permission check (spec + whole-app route table) | PASS — every admin route guarded; critical keys carry re-auth (1 documented exemption); all customer routes require a storefront token |
| `npm audit --omit=dev`                                | 0 vulnerabilities                                                                                                                      |
| Schema / baseline                                     | Unchanged (67 models, 50 enums; baseline SHA-256 `154D2C8E…A6BB`)                                                                      |

## 5. In-memory state that needs shared storage before multi-server production (D-38 / OQ-35)

| Store key / component                         | Feature                             | Effect with >1 instance or restart                                                          |
| --------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------- |
| `RateLimiterMemory` (general + route classes) | Rate limiting                       | Limits multiply by instance count; reset on restart                                         |
| `authctx:*`, `rbac:version`                   | Permission cache (≤ 60 s)           | Version bump only reaches one instance → stale permissions up to TTL elsewhere              |
| `reauth:{sid}`                                | Re-auth window                      | Re-auth on instance A not seen by B → spurious `REAUTH_REQUIRED`                            |
| `mfa:challenge:*`, `mfa:laststep:*`           | MFA step-up, TOTP replay protection | Challenge not found on another instance; **replay protection per instance only**            |
| `mfa:enroll:*`, `mfa:pending:*`               | MFA enrolment                       | Enrolment must hit the same instance; restart loses pending enrolment (user signs in again) |
| `sfremember:*` (session service)              | "Remember me" persistence           | Restart loses the flag → next rotation may downgrade to a session cookie                    |
| `rtgrace:*` (session service)                 | 10 s refresh grace window           | Multi-tab race only protected per instance                                                  |
| `captcha:*`                                   | CAPTCHA-after-threshold counters    | Thresholds per instance                                                                     |
| `otp:*`, `resend:*`                           | OTP / resend cooldowns and caps     | Caps per instance (abuse limits weaker)                                                     |
| `checkout:quote:*`                            | PRICE_CHANGED old/new detail        | Detail missing across instances (still safe: prices re-validated)                           |
| `variants-preview:*`                          | Variant generate preview → commit   | Commit must hit the same instance                                                           |
| `settings:public`, `dashboard:*`              | Read caches                         | Staleness ≤ TTL; safe                                                                       |
| Notification dispatcher, report-export job    | Background jobs                     | No distributed locking/queue (BullMQ deferred) — run on exactly one instance                |

**Required before production:** Redis (or equivalent) for all of the above, a queue for jobs, and a
re-test of auth flows with ≥ 2 instances.

## 6. Limitations (unchanged by this round)

- No MySQL execution: constraints, generated columns, locking, raw SQL and migrations are unverified live.
- Vendors are mocks/fakes; no real payment, courier, email, WhatsApp, CAPTCHA or Cloudinary call.
- Node 22 runtime not exercised locally (CI uses `.nvmrc` 22).
- Real-signal graceful shutdown still to be verified on Linux.

## 7. Restrictions honoured

No MySQL connection, SQL, migration, seed, DB write, user/grant change, `.env`/`.env.migration` access,
G2/G3/G7/G8 action, Git operation, deployment, external account or real credential. No package installed
in this round.

## 8. Recommended next gate

**G2 — backup/restore drill (user-executed).** It is the first step that produces real-database evidence;
G3 Case A (procedure v1.2) can be reviewed in parallel. In the meantime the owner can answer RD-01 (CA),
RD-02, RD-04 and RD-05, and approve or reject SCP-1 … SCP-6.
