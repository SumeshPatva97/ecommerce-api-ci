# Increment B — G3 Migration Connection Configuration

| Field         | Value                                                                                                                                                                                                                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document ID   | P4-B-G3-01                                                                                                                                                                                                                                                                                         |
| Phase         | Phase 4 — Backend Development (Increment B, Gate G3)                                                                                                                                                                                                                                               |
| Status        | **CONFIGURATION IMPLEMENTED (offline-verified) — G3 GATE NOT STARTED (user-managed user/grants pending)**                                                                                                                                                                                          |
| Date          | 2026-11-18                                                                                                                                                                                                                                                                                         |
| Gate owner    | User (privileged local MySQL session). The agent must never create users or grants.                                                                                                                                                                                                                |
| Authoritative | `docs/INCREMENT-B-IMPLEMENTATION-PLAN.md` §7/§10; `docs/INCREMENT-B-RISK-ASSESSMENT.md` R-3/R-15; **privileged Case A execution (create identity + `ecommerce_dev.*` grant): `docs/INCREMENT-B-G3-CASE-A-EXECUTION-PROCEDURE.md` (P4-B-G3-02, hardened, 2026-11-18 — not executed, not approved)** |

> **G3 is not complete / not accepted.** This document records the implemented offline migration configuration and the remaining user-managed gate steps. **Privileged account-creation/grant execution** must follow **P4-B-G3-02 only** (separately authorized, fail-closed, manual). No MySQL connection, `CREATE USER`, `GRANT`, `REVOKE` or migration command has been executed by the agent. Any inline SQL shown below that conflicts with P4-B-G3-02 is superseded for execution.

---

## 1. Goal

Confine DDL rights to a dedicated migration identity:

- **Runtime:** `ecommerce_app@localhost` keeps `SELECT, INSERT, UPDATE, DELETE` on `ecommerce_dev.*`
  only — no DDL, unchanged by Increment B.
- **Migration:** `ecommerce_migrator@localhost` is used only by `prisma migrate deploy/status` against
  an explicitly named target database. It is never imported by application runtime code and never
  reaches production application config.

The gate G3 evidence is the user's confirmation that the identity exists and that both
`ecommerce_dev` grant sets (migration identity and runtime identity) are as approved. The
configuration in this repository cannot create or verify privileges itself.

### 1.1 Target and privilege map (read before running §4)

Four different things are involved. They use **different databases** and are verified at **different
gates**; do not merge them.

| Phase                       | Migration target database                 | Privileges that matter                                      | When set / verified                        |
| --------------------------- | ----------------------------------------- | ----------------------------------------------------------- | ------------------------------------------ |
| G3 — identity and dev grant | none (no connection)                      | `ecommerce_dev.*` grant for the identity                    | §4.1–§4.2; verified in §4.4                |
| G3 — configuration          | recorded target: `ecommerce_migrate_test` | none — offline validation only                              | §4.5; offline `prisma validate --config`   |
| G7 — scratch dry run        | **`ecommerce_migrate_test` only**         | temporary `ecommerce_migrate_test.*` grant (scratch-scoped) | §4.3, applied **after** G3 is accepted     |
| G8 — live baseline          | **`ecommerce_dev` only**                  | the permanent `ecommerce_dev.*` grant from §4.2             | §4.8 target switch, separate authorization |

Two facts that are easy to get wrong:

- A grant made on the `ecommerce_dev` schema gives the identity **no privileges at all** on
  `ecommerce_migrate_test`. MySQL grants are per schema; the dev grant does not imply scratch access.
- `MIGRATION_EXPECTED_DATABASE` is only a **name guard**. Setting it to `ecommerce_migrate_test` does
  not grant anything and does not prove that privileges exist. The guard stops a URL/name mismatch
  before Prisma connects; MySQL still enforces the actual privileges.

Both controls must agree: guard matches the phase's intended target **and** the identity holds the
grant for exactly that schema.

---

## 2. Implemented design

### 2.1 Two configuration files, two identities

| File                         | Used by                                                                  | Credential source                                   | Database connection       |
| ---------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------- | ------------------------- |
| `prisma.config.ts`           | `prisma validate`, `format`, `generate`, offline `migrate diff`, runtime | `DATABASE_URL` from `.env` (runtime user)           | none for offline commands |
| `prisma.migration.config.ts` | `prisma migrate deploy`, `migrate status`, `migrate resolve`             | `MIGRATION_DATABASE_URL` from `.env.migration` only | yes — gated               |

`prisma.migration.config.ts` deliberately does **not** load `.env` and does **not** read
`DATABASE_URL`. There is no fallback path from migration commands to the runtime credential.

### 2.2 Fail-closed guard

`src/core/config/migrationTarget.ts` (imported only by the migration config) enforces:

1. `MIGRATION_DATABASE_URL` is present and non-blank — otherwise the command aborts with a message
   naming the variable, not its value.
2. `MIGRATION_EXPECTED_DATABASE` is present and non-blank.
3. The URL parses and uses the `mysql://` (or `mariadb://`) scheme.
4. The URL contains exactly one database name.
5. The database is not a MySQL system schema (`mysql`, `information_schema`, `performance_schema`, `sys`).
6. The URL's database name **exactly equals** `MIGRATION_EXPECTED_DATABASE` — otherwise it refuses to
   run. This is the G7/G8 database-name guard.
7. If `DATABASE_URL` is also present in the process environment, it must not be identical to
   `MIGRATION_DATABASE_URL` (prevents accidentally migrating with the runtime user).

Error messages contain variable names and database names only — never the URL, user or password.

### 2.3 Files

| File                                      | Change                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| `prisma.migration.config.ts`              | New — migration-only Prisma config (`--config` target)                   |
| `src/core/config/migrationTarget.ts`      | New — pure, unit-tested guard                                            |
| `tests/unit/core/migrationTarget.test.ts` | New — 16 guard tests                                                     |
| `.env.migration.example`                  | New — placeholder-only template; safe to commit                          |
| `.gitignore`                              | Added `!.env.migration.example`; `.env.*` still ignores `.env.migration` |
| `package.json`                            | Added `db:migrate:status`, `db:migrate:deploy` scripts                   |
| `tsconfig.json`                           | Includes `prisma.migration.config.ts` so typecheck/lint cover it         |

### 2.4 Environment variables (migration-only)

| Variable                      | Purpose                                                                                     | Secret  |
| ----------------------------- | ------------------------------------------------------------------------------------------- | ------- |
| `MIGRATION_DATABASE_URL`      | Migration user's connection URL (contains the password)                                     | **yes** |
| `MIGRATION_EXPECTED_DATABASE` | Exact database name the URL must target (G7: `ecommerce_migrate_test`; G8: `ecommerce_dev`) | no      |

They live in `ecommerce-api/.env.migration`, which is git-ignored. They are **not** added to
`src/core/config/env.ts`, so runtime configuration cannot read them.

---

## 3. Compatibility (verified offline on 2026-11-18)

| Command                                                                            | Config             | Result                                                            |
| ---------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------- |
| `npx prisma validate` (placeholder `DATABASE_URL`)                                 | `prisma.config.ts` | PASS                                                              |
| `npx prisma validate --config prisma.migration.config.ts` (dummy migration values) | migration config   | PASS — config and TS import resolve                               |
| Same command with URL database ≠ `MIGRATION_EXPECTED_DATABASE`                     | migration config   | FAIL-CLOSED — `MigrationTargetError` … `Refusing to run` (exit 1) |
| `npm run typecheck`                                                                | —                  | PASS                                                              |
| `npm run lint`                                                                     | —                  | PASS                                                              |
| `npm test`                                                                         | —                  | PASS — 10 files, 193/193                                          |

No command above connected to MySQL. `prisma migrate deploy/status` were **not** run.

CI keeps using `prisma.config.ts` with a placeholder `DATABASE_URL`; it never sets `MIGRATION_*` and
never runs a migration command, so the guard cannot weaken CI.

---

## 4. User-managed steps (G3 gate)

Run in a privileged local MySQL session you control. The migrator password is typed only at the hidden
prompt of P4-B-G3-02 (v1.2.1: non-empty printable ASCII; letters, digits and `- _ . ~` recommended so it
needs no URL encoding in §4.5). Never paste it into chat, a script, or a command line. The PowerShell
snippets use `-p` so the admin password is typed at the prompt. _(2026-11-19 review: the earlier
`<TYPE_A_STRONG_PASSWORD_HERE>` placeholder belonged to the superseded inline SQL and was removed.)_

### 4.0 Before you start — service and database confirmation

1. **Verify the MySQL service** (PowerShell 5.1):

   ```powershell
   Get-Service -Name 'MySQL84' | Select-Object Name, Status, StartType
   Get-NetTCPConnection -LocalPort 3306 -State Listen -ErrorAction SilentlyContinue |
     Select-Object LocalAddress, LocalPort, State
   ```

   `Status` must be `Running` and port 3306 must be listening. If not, stop.

2. **Confirm the intended database** in the privileged session:

   ```sql
   SELECT VERSION();
   SHOW DATABASES LIKE 'ecommerce_dev';
   SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = 'ecommerce_dev';
   ```

   The database must exist. Do not create it, drop it, or run DDL/DML against it during G3.

### 4.1 Create the migration user (Case A — privileged, separately authorized)

**Superseded for execution.** Do **not** use `CREATE USER IF NOT EXISTS` or execute ad-hoc account SQL. Perform identity creation only via **`docs/INCREMENT-B-G3-CASE-A-EXECUTION-PROCEDURE.md` (P4-B-G3-02)**, which requires: fresh read-only preconditions (fail-closed), execution-session SQL-mode enforcement + fail-closed verification, `CREATE USER` **without** `IF NOT EXISTS`, exact scoped grant on `` `ecommerce_dev`.* `` only, no `FLUSH PRIVILEGES`, no automatic retry/modification, and post-execution read-only verification. Any `ALTER USER`/password reset/corrective action is a **separate** explicitly reviewed and approved operation.

### 4.2 Grant the `ecommerce_dev.*` scope (for G8 and normal dev migrations)

**Executed only as part of P4-B-G3-02** (same approved, fail-closed procedure/session as §4.1). The approved grant is:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE,
      CREATE, ALTER, DROP, INDEX, REFERENCES,
      CREATE TEMPORARY TABLES, LOCK TABLES
ON `ecommerce_dev`.* TO 'ecommerce_migrator'@'localhost';
```

No `FLUSH PRIVILEGES` (unnecessary for statement-based account management in MySQL 8.4). Do not grant outside `` `ecommerce_dev`.* ``.

This grant is required for **G8** (the live baseline apply on `ecommerce_dev`) and for later approved
dev-database migrations. It is applied at G3 so the identity is fully prepared, but it is **not used**
during G3 and **does not authorize** the G7 scratch database.

**Not granted (by design):** any `*.*`/global privilege, `FILE`, `PROCESS`, `SUPER`, `TRIGGER`,
`EVENT`, `EXECUTE`/routine privileges, `CREATE USER`, `GRANT OPTION`, rights on other schemas, or the
ability to create databases. Option B is the approved migration workflow, so **do not** create or
grant anything on `ecommerce_dev_shadow` (the Option A shadow block in plan §7 is non-selected
history).

> G7 needs a **separate** grant on `ecommerce_migrate_test` (see §4.3). The `ecommerce_dev.*` grant
> above does not cover it. Do not widen any user to `*.*`.

### 4.3 G7 scratch-database privileges (applied after G3 acceptance — not part of the G3 gate)

At the moment G3 is accepted, `ecommerce_migrator` holds **only** the `ecommerce_dev.*` grant from
§4.2. That is the correct G3 state. The scratch grant is deliberately deferred until the G7
preconditions (scratch database created and confirmed empty) are met.

G7 must run `migrate deploy` against the user-created `ecommerce_migrate_test`. **Recommended: a
temporary, database-scoped grant on `ecommerce_migrate_test` only.**

Rationale:

- the identity stays least-privileged and auditable;
- no `*.*` or global privilege is introduced;
- the grant exists only for the drill and is revoked immediately afterwards;
- `ecommerce_app` and all `ecommerce_dev` grants remain unchanged;
- a separate scratch identity adds a second credential without improving isolation for a single drill.

The user executes these statements manually; the agent must never run them.

```sql
-- Only after the user has created an empty ecommerce_migrate_test (separately authorized G7 precondition).
GRANT SELECT, INSERT, UPDATE, DELETE,
      CREATE, ALTER, DROP, INDEX, REFERENCES,
      CREATE TEMPORARY TABLES, LOCK TABLES
ON `ecommerce_migrate_test`.* TO 'ecommerce_migrator'@'localhost';
SHOW GRANTS FOR 'ecommerce_migrator'@'localhost';
```

Expected before G7: the `ecommerce_dev.*` list from §4.2 **plus exactly one**
`ecommerce_migrate_test.*` row. No `*.*`.

After G7 evidence is recorded and accepted, revoke the scratch grant and verify again:

```sql
REVOKE SELECT, INSERT, UPDATE, DELETE,
       CREATE, ALTER, DROP, INDEX, REFERENCES,
       CREATE TEMPORARY TABLES, LOCK TABLES
ON `ecommerce_migrate_test`.* FROM 'ecommerce_migrator'@'localhost';
SHOW GRANTS FOR 'ecommerce_migrator'@'localhost';
```

The scratch grant is **temporary** and requires the user's confirmation. It does not authorize G7;
G7 still needs separate explicit authorization.

### 4.4 Verify both identities

```sql
SHOW GRANTS FOR 'ecommerce_migrator'@'localhost';
SHOW GRANTS FOR 'ecommerce_app'@'localhost';
```

Required outcomes at G3 acceptance:

- migrator: exactly the approved list on `ecommerce_dev.*` — and **no** row for
  `ecommerce_migrate_test` yet (the scratch grant is §4.3, applied later);
- runtime: exactly the statement below, with nothing else (no DDL, no other schema, no
  `GRANT OPTION`):

  ```sql
  GRANT SELECT, INSERT, UPDATE, DELETE ON `ecommerce_dev`.* TO 'ecommerce_app'@'localhost';
  ```

Before G7 the expected migrator state becomes the `ecommerce_dev.*` list **plus** the single
`ecommerce_migrate_test.*` row from §4.3. Record each state separately.

Record only a non-sensitive confirmation (for example "migrator grants match §4.2; runtime grants
unchanged"). Do not paste password hashes or authentication strings.

### 4.5 Create the local migration environment file

```powershell
cd C:\Users\sumes\OneDrive\Desktop\ecommerce-workspace\ecommerce-api
Copy-Item .env.migration.example .env.migration
notepad .env.migration
```

**Password in the URL (review note, 2026-11-19):** choose the migrator password from letters, digits and
`- _ . ~` only — then it goes into the URL unchanged. Any other character must be percent-encoded by hand
inside Notepad (e.g. `@` → `%40`, `#` → `%23`, `/` → `%2F`, `?` → `%3F`, `%` → `%25`, `:` → `%3A`); never
encode it with a command that prints the result or stores it in shell history. An unencoded `#`, `/` or `?`
makes the URL unparseable and the guard refuses to run (fail-closed, verified offline in
`tests/unit/core/migrationTargetEncoding.test.ts`); an unencoded `%` can silently change the password and
produce `Access denied`.

Fill in for the **G7 dry run**:

- `MIGRATION_DATABASE_URL` — the migrator URL whose database path is `ecommerce_migrate_test`;
- `MIGRATION_EXPECTED_DATABASE=ecommerce_migrate_test` — the same name, exactly.

The URL and the expected name must agree, but that agreement is only a guard. It does **not** create
or prove privileges. At this point the migrator has no rights on `ecommerce_migrate_test`; they are
added in §4.3 after the scratch database exists.

> **Do not run `npm run db:migrate:status` or `db:migrate:deploy` during G3.** They connect to MySQL.
> If a later attempt fails with `Access denied for user 'ecommerce_migrator'` on
> `ecommerce_migrate_test`, the cause is a missing scratch database or missing scratch grant. **Never**
> "fix" that by changing the target to `ecommerce_dev` — that is precisely how a dry run would be
> pointed at live data.

For **G8** the same file is deliberately switched to `ecommerce_dev` — see §4.8. Never leave the G7
target in place for G8, and never use the G8 target for G7.

Save as **UTF-8 without BOM**. The file is git-ignored; never commit or share it. The BOM symptom and
the safe re-save/verification commands are documented in `docs/ENV-BOM-REMEDIATION.md`.

### 4.6 Redacted evidence to submit for review

Use the shared checklist: `docs/INCREMENT-B-G2-G3-EVIDENCE-CHECKLIST.md`. For G3, submit only:

| Item               | Redacted form                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity           | `ecommerce_migrator@localhost`                                                                                                                      |
| Grants at G3       | The `SHOW GRANTS` lines with the password/hash removed (the `IDENTIFIED WITH … AS …` clause must be removed); this must show `ecommerce_dev.*` only |
| Runtime grants     | Confirmation that `ecommerce_app` still shows only SELECT/INSERT/UPDATE/DELETE on `ecommerce_dev.*`                                                 |
| Configured target  | `ecommerce_migrate_test` (name only — a name is not proof of privileges)                                                                            |
| Guard              | "Offline validate PASS; wrong-target test aborted with Refusing to run"                                                                             |
| `.env.migration`   | `Exists: True` only — never its contents                                                                                                            |
| Runtime credential | "Not used for migration commands"                                                                                                                   |

G3 evidence must **not** claim the scratch grant. The `ecommerce_migrate_test.*` grant is G7 evidence,
submitted separately (checklist §3.1) after G7 is authorized.

Never send the password, a connection URL, a token, or the contents of `.env`/`.env.migration`.

### 4.7 Stop conditions

Stop immediately and report if:

- the MySQL service is not running or port 3306 is not listening;
- `ecommerce_dev` is not found (do **not** create it during G3);
- `CREATE USER` fails or the identity already exists with unknown grants;
- any `SHOW GRANTS` output contains `*.*`, `GRANT OPTION`, or a privilege outside the approved list;
- the `ecommerce_app` grants differ from §4.4;
- the offline migration-config validation fails, or the wrong-target test does not abort;
- `.env.migration` cannot be saved without a BOM, or the guard reports a target mismatch;
- the configured target is `ecommerce_dev` at G3/G7-preparation time, or `ecommerce_migrate_test` at
  G8 time;
- anyone proposes granting `*.*` or a privilege outside the approved list to make a command work.

Do not "fix" a failed verification by widening grants or by repointing the target at a database the
identity already holds. Both are stop conditions.

### 4.8 Between G7 and G8 — switching the migration target (do not skip)

The same identity and the same `.env.migration` file are used, but the **database target changes**.
Never create a second credential for this.

Preconditions: G7 evidence recorded and accepted; scratch grant from §4.3 revoked; `SHOW GRANTS`
re-checked; fresh G2 backup taken.

1. Edit `.env.migration` locally:
   - `MIGRATION_DATABASE_URL` — change only the database path to `ecommerce_dev`;
   - `MIGRATION_EXPECTED_DATABASE=ecommerce_dev`.
2. Save as UTF-8 without BOM.
3. Offline check (no connection): `npx prisma validate --config prisma.migration.config.ts`.
4. Optionally re-run the negative test (a temporary wrong expected name must abort).
5. Obtain **separate G8 authorization**, then run status/deploy.

The guard refuses any URL/name mismatch, but it cannot know which phase you intended. The operator
must confirm the target name before every connection. Treat a scratch target at G8 time — or a dev
target at G7 time — as an abort, not a configuration detail.

---

## 5. Verification procedure

### 5.1 Offline (safe now, no connection)

```powershell
npm run typecheck
npm run lint
npm test
$env:DATABASE_URL='mysql://user:placeholder@localhost:3306/ecommerce_ci'
npx prisma validate
```

### 5.2 Before G7 (still no migration execution)

At this stage `.env.migration` must name **`ecommerce_migrate_test`**. With the file in place, the
following proves the guard reads the right values without connecting (config load performs no
connection):

```powershell
npx prisma validate --config prisma.migration.config.ts
```

To prove the negative case, temporarily set `MIGRATION_EXPECTED_DATABASE` to a different name — the
command must abort with `Refusing to run`. Restore the correct value afterwards.

This check proves **target naming only**. It does not prove that `ecommerce_migrate_test` exists or
that the migrator has privileges on it. Those are G7 preconditions verified with SQL and
`SHOW GRANTS` (`docs/INCREMENT-B-G7-READINESS-REVIEW.md` §3).

### 5.3 G7-only (requires separate authorization)

Before running these, the scratch database must exist and be empty, and the scratch-scoped grant must
be applied and verified. The configured target must be `ecommerce_migrate_test`.

```powershell
npm run db:migrate:status   # connects to MIGRATION_EXPECTED_DATABASE (must be ecommerce_migrate_test)
npm run db:migrate:deploy   # applies to MIGRATION_EXPECTED_DATABASE
```

These commands connect to MySQL. They must not be run until G7 is separately authorized, G2/G3 are
accepted, and the scratch database exists and is empty.

### 5.4 G8-only (separate authorization; different target)

After G7 acceptance, scratch grant revocation and the §4.8 target switch, and a fresh G2 backup:

```powershell
npm run db:migrate:status   # now connects to ecommerce_dev
npm run db:migrate:deploy   # applies the baseline to ecommerce_dev
```

Never run these with `MIGRATION_EXPECTED_DATABASE=ecommerce_migrate_test`. The `ecommerce_dev.*` grant
from §4.2 is what authorizes them; the scratch grant is not involved.

---

## 6. Security properties and non-goals

- The runtime Zod schema and `AppConfig` are unchanged; runtime code cannot read `MIGRATION_*`.
- `.env.migration` is ignored by `.gitignore` (`.env.*`) and only the placeholder example is tracked.
- No fallback: migration commands fail if `MIGRATION_DATABASE_URL` is absent, even when
  `DATABASE_URL` is present.
- No shadow database and no shadow grants (Option B).
- The guard is defence in depth; it does not replace the user's grant discipline.

Non-goals: creating users/grants, connecting to MySQL, applying migrations, seeding, or proving that
the target database is empty (that is a G7 precondition).

---

## 7. Environment-file encoding (BOM)

The 2026-11-18 audit observed a UTF-8 byte-order mark (`EF BB BF`) at the start of the local
`ecommerce-api/.env`. Node's `process.loadEnvFile()` does not strip it, so the key becomes
`\uFEFFDATABASE_URL`, `DATABASE_URL` is not registered, and Prisma fails with
`PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_URL`.

A byte-level recheck during this review (2026-11-18) found **no BOM** in `.env` (first three bytes are
not `EF BB BF`). The remediation procedure is retained for recurrence in
`docs/ENV-BOM-REMEDIATION.md`; the file itself was not read or modified by the agent.

The same rule applies to `.env.migration`. Prisma has no fallback: a BOM makes the variable
unreadable even though the text looks correct.

---

## 8. Gate status

| Item                                                | Gate    | Status                         |
| --------------------------------------------------- | ------- | ------------------------------ |
| Migration configuration implemented                 | —       | **DONE (offline-verified)**    |
| Guard unit tests                                    | —       | **DONE (16 tests)**            |
| `ecommerce_migrator@localhost` created              | G3      | **NOT DONE — user**            |
| `ecommerce_dev.*` grant applied and verified        | G3      | **NOT DONE — user**            |
| `.env.migration` created with the G7 target         | G3      | **NOT DONE — user**            |
| `ecommerce_migrate_test` created and empty          | G7      | **NOT DONE — user**            |
| Temporary `ecommerce_migrate_test.*` grant verified | G7      | **NOT DONE — user**            |
| Scratch grant revoked and re-verified               | post-G7 | **NOT DONE — user**            |
| `.env.migration` switched to `ecommerce_dev`        | G8      | **NOT DONE — user**            |
| **G3 gate**                                         | G3      | **NOT STARTED / NOT ACCEPTED** |

G3 is accepted only when the user supplies the redacted verification evidence from §4.4 and confirms
§4.5. G3 acceptance does **not** include the scratch grant, scratch database or any G7 execution.
G7 remains blocked until G2 and G3 are accepted, and separately authorized.
