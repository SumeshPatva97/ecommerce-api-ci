# Phase 4 — Decision Log (2026-11-19)

| Field       | Value                                                                           |
| ----------- | ------------------------------------------------------------------------------- |
| Document ID | P4-DEC-02                                                                       |
| Phase       | Phase 4 — Backend Development                                                   |
| Status      | **RECORDED — owner decisions given in session on 2026-11-19**                   |
| Supersedes  | The empty decision record in `PHASE4-B1-B9-DECISION-REGISTER.md` (P4-DEC-01) §4 |
| Canonical   | Mirrored in `project-documentation/01-requirements/PROJECT_CONTEXT.md` §17.6    |

The owner answered four bundled questions. Each answer adopted the **recommended option**, which in
every case was the documented working assumption. Nothing else was decided.

## 1. B1 decisions (FINAL)

| ID     | Decision                                                                                                                              | Implementation note                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| OQ-09  | Email **link** verification; mobile OTP optional (phone verification only)                                                            | No SMS/WhatsApp vendor is wired (OQ-08 open) — OTP goes through the provider interface (fake adapter)              |
| OQ-27  | Per-user **DENY** overrides; new permissions auto-granted to the `ADMIN` role. ALLOW overrides not adopted (ignored if present)       | `permission.service.ts`; seed grants ADMIN every key                                                               |
| OQ-28  | Admins **cannot** create Admins — Superadmin only                                                                                     | Staff service rule R3/R4                                                                                           |
| OQ-29  | `export` and `approve` actions adopted                                                                                                | 88-key catalogue `src/lib/permissions.ts`                                                                          |
| OQ-30  | TOTP MFA; **mandatory for Superadmin and Admin**, optional for other staff                                                            | Recovery codes need a schema change (no column/table in the approved schema) — **deferred, see §4**                |
| OQ-42  | Customer login = email + password (OTP login not enabled in v1)                                                                       | —                                                                                                                  |
| OQ-46  | 1–2 Superadmins, created via seed CLI (`SUPERADMIN_MAX=2`)                                                                            | `scripts/create-superadmin.ts` (never exposed over HTTP; not run)                                                  |
| OQ-71  | Provider-agnostic CAPTCHA after the failure threshold                                                                                 | `CAPTCHA_PROVIDER=none` until a vendor is chosen; the threshold logic exists, verification is a no-op adapter      |
| OQ-76  | 10-second refresh-rotation grace window (same user agent)                                                                             | `auth.refresh.graceSeconds = 10`                                                                                   |
| OQ-80  | Global email uniqueness accepted (staff use a separate email to shop)                                                                 | Existing unique index `users.email_normalized`                                                                     |
| OQ-92  | "Remember me" unticked = session cookie; ticked = 30-day refresh. **No** MFA "trust this browser" for staff                           | `sf_rt` Max-Age omitted when unticked                                                                              |
| OQ-109 | Route-class rate limits: **the stricter value per class** of API_DOCUMENTATION §2.8 vs SECURITY_GUIDELINES §9; general per-IP 300/min | `src/core/middleware/routeRateLimit.ts` (`RATE_CLASSES`); in-memory (D-38)                                         |
| C1     | Access tokens signed with **EdDSA (Ed25519)**; HS256 not used                                                                         | `src/core/security/jwt.ts` on `node:crypto` (no `jose` dependency). One key pair per canonical env contract (R-46) |
| C2     | Local verification/reset email capture = **in-process fake email adapter** (no install)                                               | `FakeEmailProviderAdapter` with an in-memory outbox                                                                |
| C3     | Argon2id via native `argon2` (install script allowed)                                                                                 | `argon2@0.45.1` pinned; prebuilt binary loaded on Windows/Node 24.12                                               |

## 2. B2–B9 decisions (PROVISIONAL)

**Decision:** implement B2–B9 on the documented working assumptions of every open question they depend
on (`PROJECT_CONTEXT.md` §12, §16.1, §17.2), each marked **PROVISIONAL** and reversible by the owner.
Vendor-specific items stay behind interfaces with fake/mock adapters only:

- Payment gateway (OQ-06) — `PAYMENT_PROVIDER=mock`
- Courier / aggregator (OQ-07) — `SHIPPING_PROVIDER=mock`
- Email provider and WhatsApp BSP (OQ-08) — fake adapters
- Cloudinary — signature generation is local HMAC; no Cloudinary API call is made without credentials

The authoritative list of provisional values is `PROJECT_CONTEXT.md` §12 "Working assumption" column.
Highlights that shape code: GST-inclusive prices (OQ-21), per-line half-up rounding + ₹1 invoice
round-off (OQ-23), single GSTIN (OQ-20), shipping tax proportional (OQ-22), 15-minute reservation TTL on
order placement (OQ-17), no backorders (OQ-18), single location (OQ-19), best-single-promotion + one
coupon (OQ-14), max 5 per line (OQ-57), 60-minute / 3-attempt payment retry (OQ-58), invoice on `SHIPPED`
(OQ-48), one invoice per order (OQ-67), `ORD-YYMMDD-NNNNN` / `INV/2627/000001` numbering (OQ-41/OQ-26),
cancellation policy (OQ-12), coupon restore only if cancelled before shipment (OQ-15), no
return/exchange flow in v1 (OQ-11), pre-moderated text reviews from verified purchasers (OQ-31).

## 3. Not decided (still open)

- **OQ-110** Node line (22 only vs 22 + 24) — not part of the four questions; `.nvmrc` stays 22, tests
  run on 24.12.
- **OQ-35** Redis — stays deferred (D-38); every in-memory store is single-instance only.
- All vendor selections (OQ-06/07/08), hosting (OQ-34), OpenAPI publication contract (OQ-49).

## 4. Consequences that need a later decision

| Item                           | Why it is not implemented                                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| MFA recovery codes (OQ-30)     | Needs `user_mfa_recovery_codes` table or a JSON column — a change to the approved Phase 3 schema (owner approval) |
| Staff password history (§4.2)  | Needs `users.password_history` — schema change                                                                    |
| Breached-password check (HIBP) | Outbound network call to a third party — needs owner approval and a privacy note                                  |
| Per-audience JWT key pairs     | Canonical env contract (R-46) defines one key pair; per-audience pairs would add new variable names               |
