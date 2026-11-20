# Phase 4 — B1–B9 Decision Register (Approval Pack)

| Field       | Value                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------- |
| Document ID | P4-DEC-01                                                                                     |
| Phase       | Phase 4 — Backend Development (Increment B, gate before B1)                                   |
| Status      | **AWAITING USER DECISIONS — NO DECISION IS MADE BY THIS DOCUMENT**                            |
| Date        | 2026-11-18                                                                                    |
| Source      | `project-documentation/01-requirements/PROJECT_CONTEXT.md` §17.3 (canonical)                  |
| Scope       | The 12 open questions and 3 confirmations that block B1 (authentication, users, RBAC, audit)  |
| Rule        | No working assumption below is adopted, changed or implemented without explicit user approval |

> **This is a request for decisions, not a record of decisions.** Every "recommended default" is the
> **existing documented working assumption** copied from the approved documentation. Nothing here
> authorises code, schema, environment or dependency changes. Until each item is answered, B1 stays
> **NOT STARTED** and the dependent B2–B9 work stays blocked.
>
> Answers should be recorded in the "Decision" column of §4. A single reply such as
> `OQ-09 = documented default` (or `OQ-09 = <choice>`) is sufficient for items where the documented
> assumption is acceptable.

---

## 1. Why these 12 + 3 block B1

B1 builds authentication, user management, RBAC and the audit service. Each item below changes a
security-relevant behaviour or a persisted contract. Implementing first and deciding later would mean
rewriting token flows, permission evaluation, seed data and tests — and could silently encode an
unapproved security posture. `PROJECT_CONTEXT.md` §17.3 therefore makes all 15 items mandatory before
B1 starts. The remaining B2–B9 increments inherit several of these decisions (rate limits, permissions,
notifications, tax, checkout), so answering them now also unblocks later work.

---

## 2. Decision register — 12 open questions

Legend: **WA** = documented working assumption (the recommended default, not a decision).
"Approval" is **Mandatory** for all rows because §17.3 lists them as B1 gate items.

### OQ-09 — Verification method

| Field            | Value                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact question   | Verification by email link, email OTP, or mobile OTP (SMS/WhatsApp)?                                                                        |
| Why it matters   | Determines the `verification_tokens` flow, registration UX, resend logic, and whether SMS/WhatsApp cost and provider dependencies enter B1. |
| Recommended (WA) | Email link + optional mobile OTP                                                                                                            |
| Impact           | Security: link/OTP lifetime and single-use rules. Business: SMS/WhatsApp cost, deliverability, Indian DLT registration if SMS is used.      |
| Dependencies     | OQ-08 (notification provider), OQ-42 (login methods), confirmation C2 (local email capture)                                                 |
| Approval         | **Mandatory**                                                                                                                               |

### OQ-27 — Admin restriction and automatic permission grant

| Field            | Value                                                                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact question   | Restrict Admin via per-user overrides or only via roles? Auto-grant new permissions to Admin?                                                                                |
| Why it matters   | Defines the effective-permission algorithm and whether `user_permission_overrides` is used. Affects every admin route guard and the privilege-escalation rules (§7.2).       |
| Recommended (WA) | Per-user DENY overrides; new permissions auto-granted to the `ADMIN` role                                                                                                    |
| Impact           | Security: overrides can weaken or strengthen an Admin; auto-grant means a newly shipped permission is immediately held by every Admin. Audit must record permission changes. |
| Dependencies     | OQ-28 (who may create Admins), OQ-29 (extra actions), OQ-46 (Superadmin)                                                                                                     |
| Approval         | **Mandatory**                                                                                                                                                                |

### OQ-28 — Admins creating Admins

| Field            | Value                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| Exact question   | Can Admins create other Admins?                                                                                   |
| Why it matters   | Controls horizontal privilege escalation and the `admin_users.create` authorisation matrix.                       |
| Recommended (WA) | No — Superadmin only                                                                                              |
| Impact           | Security: a compromised Admin cannot mint peer Admins. Business: slower staff onboarding (Superadmin bottleneck). |
| Dependencies     | OQ-27, OQ-46                                                                                                      |
| Approval         | **Mandatory**                                                                                                     |

### OQ-29 — Extra permission actions

| Field            | Value                                                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact question   | Add `export` and `approve` actions beyond CRUD?                                                                                                    |
| Why it matters   | The permission catalogue is seeded and referenced by route guards and the admin UI. Adding actions later requires a data migration and UI changes. |
| Recommended (WA) | Yes (proposed)                                                                                                                                     |
| Impact           | Security: separates data export and approval authority from ordinary update rights. Business: finer delegation for finance/refund workflows.       |
| Dependencies     | OQ-68 (report access), R-14/R-15 (re-authentication scope), R-18 (idempotency)                                                                     |
| Approval         | **Mandatory**                                                                                                                                      |

### OQ-30 — Staff MFA

| Field            | Value                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Exact question   | MFA (TOTP) for staff? Mandatory for Superadmin?                                                                                          |
| Why it matters   | Changes the admin login flow, token issuance, secret storage, recovery-code handling and the R-13 MFA routes.                            |
| Recommended (WA) | Recommended; mandatory for Superadmin/Admin                                                                                              |
| Impact           | Security: materially reduces account-takeover risk on privileged accounts. Business: enrolment friction, support load, recovery process. |
| Dependencies     | OQ-92 (trust this browser), OQ-46 (recovery), confirmation C1 (signing keys)                                                             |
| Approval         | **Mandatory**                                                                                                                            |

### OQ-42 — Customer login methods

| Field            | Value                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Exact question   | Customer login methods: email+password, mobile OTP login, social login (Google)?                                                     |
| Why it matters   | Defines the customer identity surface, registration fields, and whether OTP and OAuth providers are in B1.                           |
| Recommended (WA) | Email+password; mobile OTP optional                                                                                                  |
| Impact           | Security: more methods widen the attack surface and require per-method rate limits. Business: OTP improves conversion but adds cost. |
| Dependencies     | OQ-09, OQ-109, OQ-80                                                                                                                 |
| Approval         | **Mandatory**                                                                                                                        |

### OQ-46 — Superadmin count, bootstrap and recovery

| Field            | Value                                                                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact question   | How many Superadmins; bootstrap & recovery procedure?                                                                                               |
| Why it matters   | The seed CLI, the "last active Superadmin" invariant and the account-recovery runbook all depend on it. A wrong bootstrap is unrecoverable locally. |
| Recommended (WA) | 1–2, created via seed CLI                                                                                                                           |
| Impact           | Security: too many Superadmins weakens accountability; too few risks lockout. Business: defines the break-glass procedure.                          |
| Dependencies     | OQ-27, OQ-28, OQ-30                                                                                                                                 |
| Approval         | **Mandatory**                                                                                                                                       |

### OQ-71 — CAPTCHA provider

| Field            | Value                                                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact question   | CAPTCHA provider (e.g. reCAPTCHA, hCaptcha, Turnstile)?                                                                                                    |
| Why it matters   | The lockout flow (§9: 5 failed attempts → 15-min lock + CAPTCHA) needs a provider and a verification adapter; it also adds an external runtime dependency. |
| Recommended (WA) | Provider-agnostic, on login/register/forgot-password after threshold                                                                                       |
| Impact           | Security: bot/credential-stuffing mitigation. Business: third-party data processing (privacy notice), availability dependency, possible cost.              |
| Dependencies     | OQ-109 (rate limits), OQ-09                                                                                                                                |
| Approval         | **Mandatory**                                                                                                                                              |

### OQ-76 — Refresh rotation grace window

| Field            | Value                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact question   | Accept a 10-second refresh-token rotation grace window for multi-tab races?                                                                       |
| Why it matters   | Directly changes reuse-detection semantics: without grace, legitimate multi-tab refreshes can trigger family revocation (`TOKEN_REUSE_DETECTED`). |
| Recommended (WA) | Yes, plus single-flight refresh in FE (Web Locks)                                                                                                 |
| Impact           | Security: a small replay window per rotated token; compensated by family revocation. Business: avoids mass logouts in multi-tab use.              |
| Dependencies     | R-10, OQ-92, confirmation C1                                                                                                                      |
| Approval         | **Mandatory**                                                                                                                                     |

### OQ-80 — Global email uniqueness

| Field            | Value                                                                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact question   | Global email uniqueness prevents a staff member from also holding a customer account with the same email — acceptable?                                      |
| Why it matters   | The schema already has a global unique index on `users.email_normalized`; this confirms the business rule and the registration/seed behaviour that follows. |
| Recommended (WA) | Yes; staff use a separate email to shop                                                                                                                     |
| Impact           | Security: one identity record per email simplifies lockout and audit. Business: staff cannot reuse their work email for customer purchases.                 |
| Dependencies     | B1 user model, R-07 (no account enumeration)                                                                                                                |
| Approval         | **Mandatory**                                                                                                                                               |

### OQ-92 — "Remember me" and MFA browser trust

| Field            | Value                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Exact question   | "Remember me" behaviour and default; staff "trust this browser" for MFA?                                                               |
| Why it matters   | Sets refresh-token lifetimes and cookie type per login, and whether MFA can be skipped on a trusted device.                            |
| Recommended (WA) | Unticked = session cookie; ticked = 30-day refresh. No MFA browser trust for staff                                                     |
| Impact           | Security: longer-lived refresh tokens increase exposure; browser trust would weaken MFA. Business: convenience vs. shared-device risk. |
| Dependencies     | OQ-30, OQ-76                                                                                                                           |
| Approval         | **Mandatory**                                                                                                                          |

### OQ-109 — Canonical rate-limit values

| Field            | Value                                                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact question   | Values differ between `API_DOCUMENTATION.md` §2.8 and `SECURITY_GUIDELINES.md` §9 (e.g. checkout 10/min vs 5/min; admin exports 10/min vs 10/hour; general per-IP 300/min vs 1 000/min backstop). Which set is canonical? |
| Why it matters   | Rate limits are security controls and acceptance-test expectations; inconsistent values make "passing" tests meaningless.                                                                                                 |
| Recommended (WA) | Only the general per-IP limiter exists (`RATE_LIMIT_DEFAULT_PER_MIN`, default 300, in-memory, D-38); route-class limits are decided before B1                                                                             |
| Impact           | Security: brute-force, scraping and enumeration resistance. Business: overly strict limits hurt conversion; loose limits invite abuse.                                                                                    |
| Dependencies     | OQ-35 (Redis), OQ-71, D-38 (single-instance limitation)                                                                                                                                                                   |
| Approval         | **Mandatory**                                                                                                                                                                                                             |

---

## 3. Decision register — 3 confirmations

### C1 — Access-token signing algorithm and key handling

| Field            | Value                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact question   | Confirm the **[PROPOSED]** access-token signing algorithm (EdDSA recommended in `AUTHENTICATION_AUTHORIZATION.md`; HS256 documented as not recommended) and key handling. |
| Why it matters   | Fixes the JWT library, the `JWT_ACCESS_PRIVATE_KEY` / `JWT_ACCESS_PUBLIC_KEY` / `JWT_KEY_ID` environment contract (R-46), and rotation procedure.                         |
| Recommended (WA) | EdDSA (Ed25519) with asymmetric keys; HS256 not used                                                                                                                      |
| Impact           | Security: asymmetric keys let verifiers hold only the public key; symmetric HS256 requires sharing the signing secret. Key loss/rotation must be documented.              |
| Dependencies     | R-46 (env names), B1 auth module, deployment key management (OQ-34)                                                                                                       |
| Approval         | **Mandatory**                                                                                                                                                             |

### C2 — Local verification/reset email capture (no Docker)

| Field            | Value                                                                                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact question   | How are verification/reset emails captured locally without Docker (D-37): fake email adapter or a native mail catcher?                                                |
| Why it matters   | B1 tests need deterministic access to verification/reset links without real provider credentials; the choice also determines what the developer must install locally. |
| Recommended (WA) | Provider-agnostic adapter; local capture method to be confirmed (fake adapter vs native mail catcher)                                                                 |
| Impact           | Security: no real email must be sent from development. Business: developer setup friction; test reliability.                                                          |
| Dependencies     | D-37, OQ-08, `src/integrations/email/emailProvider.ts`                                                                                                                |
| Approval         | **Mandatory**                                                                                                                                                         |

### C3 — `argon2` native install script under npm 11

| Field            | Value                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Exact question   | Approve the native `argon2` package's install script under npm 11's install-script policy (or use the documented bcrypt fallback)?                           |
| Why it matters   | Password hashing is security-critical and the dependency must build on this Windows machine; npm 11 blocks install scripts unless approved.                  |
| Recommended (WA) | Argon2id (fallback bcrypt cost ≥ 12) — approval of the install script still required                                                                         |
| Impact           | Security: Argon2id is the preferred memory-hard KDF; bcrypt ≥ 12 is the documented fallback. Build reproducibility depends on native toolchain availability. |
| Dependencies     | B1 auth module, CI (B0-c), Node line (OQ-110)                                                                                                                |
| Approval         | **Mandatory**                                                                                                                                                |

---

## 4. Decision record (to be completed by the owner)

| ID     | Decision (owner) | Date | Notes |
| ------ | ---------------- | ---- | ----- |
| OQ-09  |                  |      |       |
| OQ-27  |                  |      |       |
| OQ-28  |                  |      |       |
| OQ-29  |                  |      |       |
| OQ-30  |                  |      |       |
| OQ-42  |                  |      |       |
| OQ-46  |                  |      |       |
| OQ-71  |                  |      |       |
| OQ-76  |                  |      |       |
| OQ-80  |                  |      |       |
| OQ-92  |                  |      |       |
| OQ-109 |                  |      |       |
| C1     |                  |      |       |
| C2     |                  |      |       |
| C3     |                  |      |       |

**Acceptable shorthand:** `documented default` accepts the recommended/working-assumption value exactly
as written above. Any other value must state the chosen option, and for security items (OQ-30, OQ-71,
OQ-109, C1, C3) also state the rationale so it can be recorded in the audit trail.

---

## 5. What is unblocked without these decisions

Independent work that does **not** encode any of the above decisions can continue:

- G2 procedure finalisation and G3 read-only verification (user-gated sensitive steps unchanged).
- Documentation corrections, evidence checklists and this register.
- Database-independent quality gates (format, lint, typecheck, build, unit tests).
- Offline Prisma validation and guard tests.
- Review of the G4 endpoint catalogue to prepare the B1–B9 work breakdown (no code).

Everything that touches authentication, RBAC, audit semantics, rate limits, MFA, email capture or
password hashing stays **blocked** until §4 is completed.

---

## 6. Status

- B1–B9: **NOT STARTED** (unchanged).
- Decisions recorded: **0 of 15**.
- No code, schema, dependency, environment or database change was made by this register.
