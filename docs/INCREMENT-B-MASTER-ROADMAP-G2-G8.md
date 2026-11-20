# Increment B — Master Roadmap (G2 → G3 → F5 → G7 → G8 → Post-G8)

| Field                | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document ID          | P4-B-ROADMAP-01                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Date                 | 2026-11-18                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Status               | **ROADMAP (controlled) — no gate auto-authorized · no DB operation performed**                                                                                                                                                                                                                                                                                                                                                                                                          |
| Scope                | Remaining Increment B gates through G8 and post-G8 readiness reassessment (no B1–B9 implementation)                                                                                                                                                                                                                                                                                                                                                                                     |
| Authoritative inputs | `INCREMENT-B-IMPLEMENTATION-PLAN.md`, `INCREMENT-B-G3-MIGRATION-CONNECTION.md` (P4-B-G3-01), `INCREMENT-B-G3-CASE-A-EXECUTION-PROCEDURE.md` (P4-B-G3-02 **v1.2.1**), `INCREMENT-B-G2-BACKUP-RESTORE-DRILL.md` (P4-B-G2-01), `INCREMENT-B-G2-G3-EVIDENCE-CHECKLIST.md` (P4-B-EVID-01), `INCREMENT-B-G7-READINESS-REVIEW.md`, `INCREMENT-B-G6-RE-REVIEW-ACCEPTANCE.md`, `PHASE4-BLOCKER-REGISTER-AND-ROADMAP.md` (P4-ROAD-01), `project-documentation/01-requirements/PROJECT_CONTEXT.md` |

> **Global rule:** one gate at a time. Each gate requires its own evidence, independent review, and **separate explicit approval/acceptance** as stated. No approval is inferred or bundled. **G3 acceptance does not authorize G7 or G8. G7 approval/acceptance does not authorize G8.** Phase 4 remains **IN PROGRESS — NOT APPROVED** until every required criterion and approval gate is satisfied.

---

## Gate G2 — Backup and restore drill (user-executed)

**Purpose:** prove a recoverable, verified backup/restore path for `ecommerce_dev` before any baseline application to live dev (and as a G7/G8 prerequisite), without touching live data.

**Preconditions:** MySQL service/port available; `ecommerce_dev` exists; user has privileged local access; G2 procedure and evidence checklist reviewed (`P4-B-G2-01`, `P4-B-EVID-01`). No prior gate approval required beyond procedure readiness.

**Allowed actions (user-executed, per procedure):** take single-schema dump of `ecommerce_dev` (positional, no `--databases`), verify completeness/guard/hash/size, restore into **user-controlled scratch** `ecommerce_restore_check` only (manually pre-created by user context as per procedure rules — never auto-create/drop by agent; any creation/drop is user action per procedure), compare object counts, confirm `ecommerce_dev` unchanged, drop scratch only as documented by user, record redacted evidence.

**Prohibited actions:** restore into `ecommerce_dev`; automatic database creation/drop by agent; embedding `CREATE DATABASE`/`USE ecommerce_dev` in dump; modifying live data/schema; privileged changes unrelated to drill; Git/env/credential changes.

**Required evidence:** P4-B-EVID-01 §2 (G2-01…G2-22; procedure P4-B-G2-01 v1.1, guide `G2-USER-EXECUTION-GUIDE.md`): dump exists/size/SHA-256/exit 0/completeness marker/guard clean, source & scratch object counts reconciled, source unchanged, restore target confirmed `ecommerce_restore_check`, drill performed by owner, scratch dropped, errors none.

**Failure conditions:** non-zero command, missing/empty/truncated dump (no completion marker), guard scan finds `CREATE DATABASE`/`USE`, scratch pre-exists, count mismatch, source changed, restore directed at `ecommerce_dev`, or any stop condition in P4-B-G2-01/P4-B-EVID-01.

**Recovery approach:** STOP, preserve evidence, do not "repair" by reusing `ecommerce_dev` or altering targets; investigate and repeat as a new user-executed drill only after review.

**Explicit approval required:** separate **G2 acceptance decision** by owner/reviewer after independent evidence review (not implied by procedure preparation).

**Completion criteria:** all G2 evidence rows complete/consistent, reconciliation `match`, `ecommerce_dev` unchanged, and G2 explicitly recorded **ACCEPTED**.

---

## Gate G3 — Migration account preparation (identity + `ecommerce_dev.*` grant + config verification)

**Purpose:** establish least-privilege migration identity/configuration for later authorized migrations without affecting runtime privileges or live schema/data.

**Preconditions:** G2 status independent (G3 technical/config work and evidence review can proceed per plan, but overall baseline readiness remains gated); fresh read-only evidence available; authoritative docs reviewed: `P4-B-G3-01`, **`P4-B-G3-02` (hardened Case A execution, authoritative for privileged execution)**, `P4-B-EVID-01`.

**Allowed actions (only as separately authorized and specified):**

- **Read-only verification:** existing G3 read-only evidence workflow (SELECT/SHOW only).
- **Privileged Case A (user-executed, separate explicit approval required):** execute P4-B-G3-02 exactly — mandatory fresh preconditions, fail-closed in-session SQL-mode enforcement/verification, `CREATE USER` (no `IF NOT EXISTS`) + exact grant on `` `ecommerce_dev`.* `` only, no `FLUSH PRIVILEGES`, no auto-retry/modification.
- **Offline/config:** `.env.migration` creation/encoding/guard validation per P4-B-G3-01 when appropriate (user-managed secrets, never committed/printed); migration config offline validation.

**Prohibited actions:** any SQL/account/grant execution without separate explicit approval of the exact operation; `IF NOT EXISTS` for Case A execution; `FLUSH PRIVILEGES`; `*.*`/global/`GRANT OPTION`/prohibited privileges; any other schema or `ecommerce_migrate_test` grant (scratch grant is a **G7 precondition**, not G3 acceptance); modification of `ecommerce_app`; migrations/db writes/`db push`; `.env` runtime credential changes; fallback to `DATABASE_URL` for migrations.

**Required evidence:** P4-B-EVID-01 §3 (G3-01…G3-15): service/db confirmed, migrator identity, redacted `SHOW GRANTS` showing **`ecommerce_dev.*` only** (exact approved set, no extras), `ecommerce_app` unchanged, `.env.migration` exists (no BOM, contents never shared) with correct phase target as applicable, offline guard pass + wrong-target abort, runtime credentials not used. Post-execution read-only verification must detect **unexpected** additional privileges.

**Failure conditions:** precondition/stop condition triggered, identity exists unexpectedly (no auto-modify), any unintended privilege/global/other-schema/`GRANT OPTION`, `ecommerce_app` changed, guard mismatch/failure, ambiguous result, or evidence missing/secret-containing.

**Recovery approach:** STOP; capture read-only evidence; no automatic cleanup/retry/drop/grant correction; any corrective privileged action requires separate explicit review/approval (see P4-B-G3-02 §7).

**Explicit approval required:** (1) separate explicit approval for the **exact** Case A privileged execution (if performed); (2) separate **G3 acceptance decision** after consolidated evidence review. **G3 acceptance does not authorize G7 or G8.**

**Completion criteria:** all documented G3 conditions/evidence satisfied and independently reviewed, exact privilege scope confirmed, `ecommerce_app` unchanged, config fail-closed verified, and G3 explicitly recorded **ACCEPTED**.

---

## Gate F5 — Readiness review (before G7)

**Purpose:** confirm all prerequisites, decisions, and risk controls required before any scratch migration (G7) are satisfied or formally deferred with traceable acceptance.

**Preconditions:** G2 and G3 evidence packages available for review (F5 decision itself requires re-checking canonical state; G7 execution remains blocked until G2/G3 accepted per §G7).

**Allowed actions:** read canonical documentation, re-read unresolved questions/confirmations, inspect repo/config/migration artifacts read-only, run safe offline checks, classify/record decisions and formal deferrals, produce readiness decision report.

**Prohibited actions:** inventing answers, silently closing open questions, executing SQL/migrations, creating/modifying `.env.migration` secrets beyond separately authorized steps, starting G7/G8, implementing B1–B9.

**Required evidence:** readiness report covering (a) canonical unresolved-question inventory and classification, (b) G2/G3/F5 dependency status, (c) candidate baseline SQL/hash/target-guard readiness, (d) Node/runtime and dependency-constraint confirmation, (e) explicit READY/NOT READY decision with blockers/deferrals.

**Canonical unresolved questions/confirmations (re-read required — list not assumed complete):** at minimum **OQ-09, OQ-27, OQ-28, OQ-29, OQ-30, OQ-42, OQ-46, OQ-71, OQ-76, OQ-80, OQ-92, OQ-109, OQ-110, C1, C2, C3** (per `PROJECT_CONTEXT.md` §17.3 and P4-DEC-01). Also re-verify status of OQ-106–OQ-108 and any other open/partly-resolved items in canonical docs. For each item record: **must resolve before G7 / must resolve before G8 / can be formally deferred / blocks Phase 4 acceptance**. Discover and include any additional canonical blockers.

**Failure conditions:** required item unresolved without accepted formal deferral for G7, conflicting canonical status, missing prerequisite evidence, or unreviewed migration/target risk.

**Recovery approach:** resolve or formally defer items with documented owner approval; update canonical tracking; re-run F5 review.

**Explicit approval required:** separate **F5 readiness decision** (READY/NOT READY) recorded by owner/reviewer. F5 READY does not authorize G7 execution.

**Completion criteria:** authoritative list reconciled, every item classified (resolved/deferred with rationale and approval where required), prerequisites for G7 satisfied or explicitly gated, and F5 recorded **READY** (or NOT READY with blockers).

---

## Gate G7 — Scratch baseline migration (dry run)

**Purpose:** validate the reviewed baseline migration and probes on an isolated, empty scratch database before any application to `ecommerce_dev`.

**Preconditions:** **G2 PASS, G3 PASS, F5 READY** (and all G7 readiness items satisfied): reviewed candidate SQL and independently confirmed SHA-256 (`154D2C8E4614609C4D8BF4879F7B1991B6DA0CCA704DAE5DEB09D53F2AB7A6BB` unless re-approved), `ecommerce_migrate_test` **manually created by user** and confirmed empty, temporary scratch-scoped grant on `ecommerce_migrate_test.*` only verified (and later revoked per plan), `.env.migration`/guard targeting **`ecommerce_migrate_test`** only, recovery/failure procedure reviewed.

**Allowed actions (only after separate explicit G7 authorization):** run approved migration commands **against `ecommerce_migrate_test` only** per readiness/preflight procedure; verify schema objects/counts/constraints/indexes/generated columns/FKs/CHECKs/migration history; run required integrity probes and safe tests; capture redacted before/after evidence.

**Prohibited actions:** targeting/connecting to/modifying `ecommerce_dev`; automatic create/drop/recreate/reset of any database; `prisma db push`; privilege broadening; using runtime credentials for migration; fallback to `DATABASE_URL`; applying unreviewed/changed SQL; inferring G8 approval.

**Required evidence:** target identity proof (`MIGRATION_EXPECTED_DATABASE` and actual target = `ecommerce_migrate_test`), pre-state (empty), command outputs (redacted), post-state object/constraint/history verification, probe outcomes (incl. documented open probes e.g. R-16/D12 as applicable), confirmation no live dev changes, scratch-grant revocation evidence when completed.

**Failure conditions:** any precondition unmet, target/hash mismatch, unexpected pending migration, command/connect error, probe/verification failure, evidence of wrong target or unintended change.

**Recovery approach:** STOP; no automatic retry/reset/drop/recreate. Preserve evidence, analyze, and require review/approval before any further action. Do not apply to `ecommerce_dev`.

**Explicit approval required:** separate **G7 authorization** before any migration command, and separate **G7 PASS** acceptance after full independent verification.

**Completion criteria:** baseline applied and verified on `ecommerce_migrate_test` only with complete evidence and all required probes/checks passed/reviewed; G7 explicitly recorded **PASS**.

---

## Gate G8 — Development baseline migration (`ecommerce_dev`)

**Purpose:** apply the reviewed/approved baseline to `ecommerce_dev` under controlled, recoverable conditions.

**Preconditions:** **G2 PASS, G3 PASS, G7 PASS**, F5 conditions satisfied, recovery plan reviewed, final baseline SQL/checksum reviewed & approved, **fresh backup of `ecommerce_dev` completed and independently verified** with restore readiness, scratch grant revoked and `.env.migration` switched to **`ecommerce_dev`** with guard/target verification, `ecommerce_app` remains DML-only, migration identity grants correct for `ecommerce_dev.*` only.

**Allowed actions (only after separate explicit G8 authorization):** apply the **exact approved** baseline migration to **`ecommerce_dev` only** with documented command/expected changes; capture redacted pre/post evidence; verify migration history/objects/constraints/Prisma status/tests/health/runtime connectivity/privileges.

**Prohibited actions:** targeting any database other than `ecommerce_dev`; `prisma db push`; automatic reset/repair/drop/create; unreviewed SQL or hash mismatch; privilege broadening; runtime credential misuse; fallback URLs; inferring approval from G7 or any prior gate.

**Required evidence:** final approval package (target, migration file/hash, SQL summary, expected object counts, fresh backup evidence+integrity+restore readiness, migration/runtime account verification, exact command, success criteria, failure/recovery) and post-execution verification (history, objects/constraints, identity, Prisma status, tests/health, runtime DML-only unchanged, no unintended changes).

**Failure conditions:** any precondition/identity/target/hash/backup mismatch, command failure, verification discrepancy, or unexpected schema/data change.

**Recovery approach:** STOP immediately; follow reviewed recovery/restore plan; **never automatically reset or repair**; require review before further action.

**Explicit approval required:** separate **G8 authorization** (with explicit statement that G8 modifies `ecommerce_dev`) and separate post-execution acceptance.

**Completion criteria:** approved baseline applied to `ecommerce_dev` only, all verifications pass, evidence complete, and G8 explicitly recorded **PASS**.

---

## After G8 (no automatic progression)

**Purpose:** reassess true readiness without assuming completion.

**Allowed actions:** re-verify Increment B completion status, reassess Phase 4 acceptance criteria (incl. API implementation/acceptance, security, CI/build, operational readiness, documentation, open questions/deferrals, mandatory deliverables), produce a **new implementation readiness report**.

**Prohibited actions:** automatically starting B1–B9, starting Phase 5, marking Phase 4 complete/approved without every required criterion satisfied and independently verified.

**Required evidence/outcomes:** gap analysis against current canonical criteria; updated blockers/deferrals; explicit statement that **Phase 4 remains IN PROGRESS — NOT APPROVED** until all gates/criteria pass and are approved.

**Explicit approval required:** separate approvals for any subsequent implementation gate (including B1) as applicable.

**Completion criteria (for this roadmap stage):** post-G8 reassessment report issued; next actions and approvals clearly identified.

---

## Gate status snapshot (unchanged by this roadmap)

- **G2:** USER EXECUTION PENDING — Step 1 NOT VERIFIED (`G2-EXECUTION-LOG.md`). Step 0 prerequisites PASS (2026-11-19). Step 1 awaits real console output; Step 2 must not start before then. The earlier evidence review (`G2-EVIDENCE-REVIEW.md`) found no evidence. Not accepted. (Updated 2026-11-20; the autonomous code round did not touch any gate.)
- **G3:** NOT ACCEPTED
- **G7:** NOT STARTED / NOT AUTHORIZED
- **G8:** NOT STARTED / NOT AUTHORIZED
- **Phase 4:** IN PROGRESS — NOT APPROVED

This document records a controlled plan only. It performs **no** database operation and grants **no** authorization.
