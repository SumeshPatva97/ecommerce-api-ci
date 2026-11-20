# Phase 4 — Live Blocker Register and Completion Roadmap

| Field       | Value                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------- |
| Document ID | P4-ROAD-01                                                                                |
| Phase       | Phase 4 — Backend Development (Increment B, B0-c, B1–B9, gate G4)                         |
| Status      | **PHASE 4 IN PROGRESS — NOT APPROVED**                                                    |
| Date        | 2026-11-18                                                                                |
| Mode        | Read-only review + documentation. No database, credential, migration or Git operation.    |
| Sources     | `PROJECT_CONTEXT.md` §17, `INCREMENT-B-IMPLEMENTATION-PLAN.md`, G2/G3/G7 documents, audit |

> This register records **actual** state. It does not advance any gate. Every row marked
> **USER ACTION** requires the owner; nothing in this document authorises database or credential work.

> **Status superseded on 2026-11-19 (snapshot kept for history).** Since this register was written:
> the 15 B1 decisions were answered (D-41 … D-55) and B2–B9 assumptions adopted provisionally (D-56);
> B1–B9 code exists (33 modules, 248 operations, mocked-DB tests only); D-57 … D-60 applied; G2 procedure
> is now **v1.1** and G3 Case A is **v1.2.1** (both independently reviewed, neither executed).
> Lines below such as "B1–B9 NOT STARTED", "0 of 80" and "Decisions recorded: 0 of 15" are **historical**.
> Live status: `PHASE3-PHASE4-MASTER-PROGRESS-REPORT.md`; open decisions: `PHASE4-REMAINING-DECISIONS.md`.
> Gate statuses are unchanged: G2 USER EXECUTION PENDING · G3 NOT ACCEPTED · G7/G8 NOT AUTHORIZED.

---

## 1. Status snapshot (preserved, unchanged)

| Item                       | Status                           |
| -------------------------- | -------------------------------- |
| Phase 1                    | COMPLETE                         |
| Phase 2                    | APPROVED — COMPLETE              |
| Phase 3                    | APPROVED — COMPLETE              |
| Increment A                | PASS                             |
| Increment B Stage 1        | COMPLETE OFFLINE                 |
| G6                         | **PASS — ACCEPTED**              |
| G2                         | **USER EXECUTION PENDING**       |
| G3                         | **USER EXECUTION PENDING**       |
| G7                         | **NOT READY — NOT AUTHORIZED**   |
| Increment B                | IN PROGRESS                      |
| Phase 4                    | **IN PROGRESS — NOT APPROVED**   |
| B1–B9                      | NOT STARTED                      |
| Business endpoints exposed | **0 of 80** (health routes only) |

---

## 2. Verified technical state (2026-11-18, re-confirmed this session)

| Check                                           | Actual result                                                                |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| `MySQL84` service                               | `Running`, `Automatic`                                                       |
| TCP 3306                                        | `LISTEN [::]:3306`                                                           |
| MySQL client                                    | `mysql.exe Ver 8.4.9`                                                        |
| `ecommerce_dev` existence                       | **Not yet verified by SQL** (privileged session required)                    |
| `ecommerce_migrator@localhost` existence        | **Not yet verified by SQL**                                                  |
| `ecommerce_app` grants                          | **Not yet re-verified by SQL**                                               |
| `.env`                                          | 80 bytes, **no BOM** (starts with a blank CRLF line — harmless)              |
| `.env.migration`                                | **Does not exist**                                                           |
| Baseline migration SHA-256                      | `154D2C8E4614609C4D8BF4879F7B1991B6DA0CCA704DAE5DEB09D53F2AB7A6BB` (matches) |
| `prisma validate` (runtime, placeholder)        | PASS                                                                         |
| `prisma validate --config` (migration)          | PASS with dummy scratch values                                               |
| Guard negative tests                            | 3/3 fail-closed (mismatch, system schema, missing URL), exit 1               |
| `format:check` / `lint` / `typecheck` / `build` | exit 0 / 0 / 0 / 0                                                           |
| `npm test`                                      | **10 files, 193 tests pass**                                                 |
| Saved MySQL login path                          | none (`mysql_config_editor print --all` empty)                               |
| Credential-free admin login                     | unavailable (expected; no secret was guessed)                                |

---

## 3. G3 12-step status (actual)

| #   | Step                            | Status                      | Evidence / next action                                 |
| --- | ------------------------------- | --------------------------- | ------------------------------------------------------ |
| 1   | MySQL service                   | **VERIFIED**                | `Name=MySQL84; Status=Running; StartType=Automatic`    |
| 2   | Port 3306                       | **VERIFIED**                | `LISTEN [::]:3306`                                     |
| 3   | `ecommerce_dev` exists          | **USER ACTION REQUIRED**    | run the read-only capture script (§5)                  |
| 4   | Identity creation               | **NOT STARTED**             | depends on step 3 + explicit approval                  |
| 5   | Grant execution                 | **NOT STARTED**             | exact SQL prepared, awaiting approval                  |
| 6   | Grant verification              | **PENDING**                 | `SHOW GRANTS` in the same privileged session           |
| 7   | Runtime privilege verification  | **PENDING**                 | `SHOW GRANTS FOR 'ecommerce_app'@'localhost'`          |
| 8   | `.env.migration` creation       | **NOT STARTED**             | private password entry; file must be UTF-8 without BOM |
| 9   | Encoding verification           | **PENDING**                 | byte-level BOM check only; never print contents        |
| 10  | Offline Prisma validation       | **VERIFIED (dummy values)** | re-run against the real file after step 8              |
| 11  | Fail-closed target verification | **VERIFIED**                | mismatch / system-schema / missing-URL all abort       |
| 12  | Redacted evidence report        | **PENDING**                 | assembled after 3–11                                   |

Independent checks already complete: repository and document set present; migration config and guard
read correctly; baseline hash unchanged; runtime test suite green.

---

## 4. G2 readiness review (procedure only — not executed)

Reviewed `docs/INCREMENT-B-G2-BACKUP-RESTORE-DRILL.md` against PowerShell 5.1 and safety rules.

| Area                         | Finding                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single-schema dump safety    | PASS — positional `ecommerce_dev`, no `--databases`; guard scan aborts on `CREATE DATABASE`/`USE`                                                             |
| PowerShell 5.1 compatibility | PASS — `--result-file` instead of `>`; `cmd /c` or `--execute="source …"` instead of `<`                                                                      |
| Restore target protection    | PASS — hard-coded `ecommerce_restore_check`; explicit equality guards; `CREATE DATABASE` without `IF NOT EXISTS`                                              |
| Pre-existing scratch DB      | PASS — pre-check aborts if it already exists                                                                                                                  |
| Hash evidence                | PASS — SHA-256 plus `.sha256` sidecar                                                                                                                         |
| Object counts                | PASS — 9 object types before/after + source-unchanged recheck                                                                                                 |
| Recovery / abort rules       | PASS — abort list covers empty/truncated dump, non-zero exits, count mismatch, changed source                                                                 |
| **Gap found and fixed**      | Added a **dump completeness marker** check (final `-- Dump completed` line) and evidence row **G2-19**. Without it, a truncated dump could pass a size check. |
| Evidence checklist           | PASS — G2-01…G2-18 + new G2-19; redaction rules present                                                                                                       |

No blocking defect remains in the procedure. **Execution is user-only** and has not been performed.

---

## 5. Blocker register (live)

| ID     | Blocker                                                      | Gate  | Owner | Exact unblock action                                                                                    |
| ------ | ------------------------------------------------------------ | ----- | ----- | ------------------------------------------------------------------------------------------------------- |
| BLK-01 | G2 backup/restore drill not executed                         | G2    | User  | Run `INCREMENT-B-G2-BACKUP-RESTORE-DRILL.md` §4 end-to-end and fill the G2 rows                         |
| BLK-02 | G3 privileged SQL evidence missing                           | G3    | User  | Run the read-only capture script (§6) once; it writes a redacted report the agent reads                 |
| BLK-03 | `CREATE USER` / `GRANT` approval pending                     | G3    | User  | Review the exact SQL in §7 and reply with explicit approval (or rejection)                              |
| BLK-04 | `.env.migration` absent                                      | G3    | User  | Enter the migration password privately; helper script available on request                              |
| BLK-05 | G7 scratch DB + scratch grant + authorization                | G7    | User  | After G2/G3 acceptance: create empty `ecommerce_migrate_test`, apply scratch-scoped grant, authorize G7 |
| BLK-06 | G8 authorization                                             | G8    | User  | After G7 acceptance: revoke scratch grant, switch target to `ecommerce_dev`, fresh backup, authorize G8 |
| BLK-07 | 15 B1 decisions unanswered                                   | B1    | User  | Complete `docs/PHASE4-B1-B9-DECISION-REGISTER.md` §4                                                    |
| BLK-08 | B2–B9 domain decisions (tax, payments, shipping, coupons, …) | B2–B9 | User  | Answer the per-increment decisions in `PROJECT_CONTEXT.md` §12 / roadmap §8                             |
| BLK-09 | Node line unconfirmed (OQ-110)                               | B1    | User  | Confirm Node 22 only, or 22+24; tests currently run on 24 only                                          |
| BLK-10 | Git commit/branch/remote not authorised (D-40)               | —     | User  | Separate explicit instruction; the agent performs no Git operations                                     |

Nothing else blocks the offline work: documentation, tests and non-DB configuration are unblocked.

---

## 6. The one user action that unblocks G3 (read-only)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\sumes\AppData\Local\Temp\opencode\g3-readonly-sql-check.ps1"
```

- Prompts for a privileged MySQL user (Enter = `root`) and a hidden password.
- Executes **only `SELECT` / `SHOW`**; no DDL, DML, `GRANT` or `REVOKE`.
- Removes `IDENTIFIED WITH … AS '…'` hashes and any URL before writing
  `C:\Users\sumes\AppData\Local\Temp\opencode\g3-sql-evidence.txt`.
- The agent reads that file; no copy-paste and no secret in chat.

Until this runs, steps 3–7 cannot be marked VERIFIED and BLK-03 cannot be finalised.

---

## 7. Privileged G3 Case A operation (not executed, not approved)

**Superseded (2026-11-18):** the previously sketched inline SQL (`CREATE USER IF NOT EXISTS`, `FLUSH PRIVILEGES`) is **not authoritative**. Any separately approved privileged execution must follow **`docs/INCREMENT-B-G3-CASE-A-EXECUTION-PROCEDURE.md` (P4-B-G3-02, hardened)** only.

**Current evidence (historical, read-only, 2026-11-18 21:11:15):** `ecommerce_dev` exists (`utf8mb4`/`utf8mb4_0900_ai_ci`), `ecommerce_migrator@localhost` absent, `ecommerce_app` DML-only on `` `ecommerce_dev`.* ``. A **fresh read-only precondition check immediately before any execution is mandatory** (fail-closed).

**Case A (identity absent, per fresh preconditions) — P4-B-G3-02 only:** single execution session with (1) mandatory read-only preconditions, (2) in-session SQL-mode normalization/enforcement and **fail-closed verification gate** (genuine SQL error stops batch before `CREATE USER`), (3) `CREATE USER 'ecommerce_migrator'@'localhost' ...` (**no `IF NOT EXISTS`**), (4) exact grant on `` `ecommerce_dev`.* `` only. **No `FLUSH PRIVILEGES`. No automatic retry/modification.**

**If the identity unexpectedly exists at precondition/execution time:** **STOP** — no `CREATE USER`, no `GRANT`, no auto-modification (separate reviewed/approved corrective action required).

| Property                    | Value                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target database             | `ecommerce_dev` only — **no `*.*`, no other schema**                                                                                                    |
| Privileges                  | `SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES, CREATE TEMPORARY TABLES, LOCK TABLES`                                          |
| Not granted                 | global privileges, `GRANT OPTION`, `FILE`, `PROCESS`, `SUPER`, `RELOAD`, `SHUTDOWN`, replication, `CREATE USER`, `TRIGGER`, `EVENT`, `EXECUTE`/routines |
| Runtime user                | untouched (`ecommerce_app` remains DML-only on `` `ecommerce_dev`.* ``)                                                                                 |
| G7 scratch access           | **not** granted (scratch grant is a separate G7 precondition, not G3 acceptance)                                                                        |
| Effect if approved/executed | allows migration identity to manage schema/data within `ecommerce_dev` only (later separately authorized gates)                                         |

---

## 8. Phase 4 completion criteria vs. current state

| #   | Criterion (G4)                                            | Current state                                               |
| --- | --------------------------------------------------------- | ----------------------------------------------------------- |
| 1   | All approved backend requirements implemented or deferred | **NOT MET** — B1–B9 not started                             |
| 2   | All applicable API endpoints implemented and documented   | **NOT MET** — 0 of 80 business endpoints                    |
| 3   | Authentication and authorization verified                 | **NOT MET** — not implemented                               |
| 4   | Security review completed                                 | **NOT MET** — self-assessment scaffold only                 |
| 5   | Required automated tests passing                          | **PARTIAL** — 193/193 foundation tests                      |
| 6   | Database migration and baseline gates accepted            | **PARTIAL** — G6 accepted; G2/G3 pending, G7/G8 not started |
| 7   | API acceptance tests passing                              | **NOT MET** — no business endpoints                         |
| 8   | Environment and deployment documentation completed        | **PARTIAL** — scaffolds only                                |
| 9   | No unresolved critical blockers                           | **NOT MET** — §5 has open blockers                          |
| 10  | Final independent review report prepared                  | **NOT MET**                                                 |
| 11  | Explicit user approval of Phase 4 completion              | **NOT GIVEN**                                               |

---

## 9. Roadmap (dependency-ordered)

| Stage | Scope                                                                                             | Entry condition                                                                                        | Output / gate                                                  |
| ----- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| A     | Finish G3: SQL evidence, identity + `ecommerce_dev.*` grant, `.env.migration`, offline validation | BLK-02 resolved; BLK-03 approved                                                                       | G3 evidence → review → acceptance                              |
| B     | G2 drill: dump, guard scan, hash, restore into `ecommerce_restore_check`, reconcile, drop         | Privileged session; ~30 min                                                                            | G2 evidence → acceptance                                       |
| C     | G7 dry run on `ecommerce_migrate_test`                                                            | G2 + G3 accepted; scratch DB empty; scratch grant; hash confirmed; explicit G7 authorization           | G7 PASS + probe results (R-16, D12, generated columns, status) |
| D     | G8 live baseline on `ecommerce_dev`                                                               | G7 accepted; scratch grant revoked; `.env.migration` switched; fresh backup; explicit G8 authorization | Baseline applied; `migrate status` clean                       |
| E     | B0-b part 2 finish: seeds, Prisma client wiring, DB readiness, error mapping, transaction helper  | Baseline applied; seed decisions                                                                       | DB-connected readiness verified                                |
| F     | B0-c finish: OpenAPI, CI DB jobs, provider fakes, deployment docs                                 | OQ-34, OQ-35, OQ-49 (or documented deferral)                                                           | Infra gate                                                     |
| G     | **B1** — auth & users, RBAC, audit, Superadmin CLI                                                | **All 15 decisions in P4-DEC-01 answered**                                                             | Auth/RBAC acceptance + security tests                          |
| H     | **B2–B9** — see §10                                                                               | B1 accepted; per-increment decisions                                                                   | Module acceptance tests                                        |
| I     | G4 exit: API acceptance, security self-assessment, runbook, independent review                    | B1–B9 accepted                                                                                         | **User approval required**                                     |

Nothing in stages A–D can be executed by the agent: they are user-run database operations by design.

---

## 10. B1–B9 work breakdown (scope only — no implementation authorisation)

| Increment | Scope                                                                                        | Blocking decisions                                     |
| --------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| B1        | Auth (customer + staff), users, roles/permissions, overrides, audit service, Superadmin CLI  | P4-DEC-01 (12 OQ + 3 confirmations)                    |
| B2        | Settings, states, tax masters, catalog masters (categories, brands, collections, attributes) | OQ-20, OQ-21, OQ-22, OQ-23, OQ-24, OQ-26, OQ-38, OQ-48 |
| B3        | Products, variants, images/media, Cloudinary signed uploads                                  | OQ-04, OQ-05, OQ-39, OQ-50, Cloudinary credentials     |
| B4        | Inventory movements, reservations, barcodes/labels                                           | OQ-17, OQ-18, OQ-19, OQ-40, OQ-47, OQ-65               |
| B5        | Cart, wishlist, pricing, coupons, promotions                                                 | OQ-14, OQ-15, OQ-16, OQ-51, OQ-57                      |
| B6        | Checkout, orders, payments, refunds                                                          | OQ-06, OQ-11, OQ-12, OQ-13, OQ-58, OQ-59, OQ-64        |
| B7        | Shipping, shipments, invoices/credit notes                                                   | OQ-07, OQ-26, OQ-48, OQ-67                             |
| B8        | Notifications, reviews, CMS                                                                  | OQ-08, OQ-31, OQ-82…OQ-85, provider credentials        |
| B9        | Reports, dashboard, hardening                                                                | OQ-45, OQ-54, OQ-68                                    |

Each increment must pass format, lint, typecheck, build, unit tests, safe integration tests, API
acceptance and security checks before it can be recorded as done.

---

## 11. Next actions

1. **User:** run the read-only capture script (§6). The agent then verifies steps 3–7.
2. **User:** approve or reject the exact grant (§7) once the identity state is known.
3. **User:** complete P4-DEC-01 §4 (15 decisions) — this is the gate for B1.
4. **User:** run the G2 drill (§4) when ready; evidence is independent of G3.
5. **Agent (automatic):** after the report exists, record redacted evidence, re-run offline validation
   against the real `.env.migration`, and prepare the G3 review summary without marking it accepted.

**Status remains:** G6 PASS — ACCEPTED · G2 USER EXECUTION PENDING · G3 USER EXECUTION PENDING ·
G7 NOT READY — NOT AUTHORIZED · Increment B IN PROGRESS · Phase 4 IN PROGRESS — NOT APPROVED.
