# Increment B — G2/G3 Evidence Checklist (User Submission)

| Field       | Value                                                                                                                                                                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document ID | P4-B-EVID-01                                                                                                                                                                                                                                          |
| Phase       | Phase 4 — Backend Development (Increment B, Gates G2 and G3)                                                                                                                                                                                          |
| Status      | **TEMPLATE — awaiting user evidence. G2: USER EXECUTION PENDING · G3: NOT ACCEPTED (procedure v1.2.1 reviewed, not executed).** Updated 2026-11-19 after the independent G2/G3 reviews.                                                               |
| Date        | 2026-11-18                                                                                                                                                                                                                                            |
| Owner       | User (privileged local MySQL session). The agent never executes the procedures or collects secrets.                                                                                                                                                   |
| Used with   | `docs/INCREMENT-B-G2-BACKUP-RESTORE-DRILL.md` (P4-B-G2-01), `docs/INCREMENT-B-G3-MIGRATION-CONNECTION.md` (P4-B-G3-01), `docs/INCREMENT-B-G3-CASE-A-EXECUTION-PROCEDURE.md` (P4-B-G3-02, hardened — privileged execution only if separately approved) |

> Fill this in **after** completing each procedure. Submit only the redacted values described below.
> A gate is accepted only when the evidence is reviewed and the owner records the acceptance wording.
> **G3 Case A execution (if separately approved):** must follow P4-B-G3-02 (fail-closed preconditions/mode gate, `CREATE USER` without `IF NOT EXISTS`, no `FLUSH PRIVILEGES`, no auto-retry/modification). Evidence below must still prove exact scope and no unintended privileges.

---

## 1. Redaction rules (mandatory)

Never include in this checklist, chat, tickets or reports:

- passwords, password hashes, authentication strings (`IDENTIFIED WITH … AS …`);
- connection URLs (`mysql://…`) or any part of them;
- `.env` / `.env.migration` contents;
- tokens, keys, certificates or dumps.

You may state that a file **exists** and give its **size** and **hash**. The dump file itself contains
schema metadata only for the current state, but it must still never be pasted or committed.

If a `SHOW GRANTS` line contains an authentication clause, delete that clause and keep only the
privilege line (for example the line that starts `GRANT SELECT, INSERT ON` and ends with the identity).

---

## 2. G2 — Backup and restore drill evidence

Source procedure: `docs/INCREMENT-B-G2-BACKUP-RESTORE-DRILL.md` **v1.1** (step-by-step: `docs/G2-USER-EXECUTION-GUIDE.md`).

| #     | Item                                                  | Required value (redacted)                                                                                                                                    | User entry |
| ----- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| G2-01 | Drill date/time                                       | Local date and time                                                                                                                                          |            |
| G2-02 | Backup file path                                      | Full path under `C:\db-backups\ecommerce` (no credential)                                                                                                    |            |
| G2-03 | **Backup file exists**                                | `Test-Path` result = `True`                                                                                                                                  |            |
| G2-04 | **Backup file size (bytes)**                          | Non-zero integer                                                                                                                                             |            |
| G2-05 | **Backup SHA-256**                                    | 64 hex characters from `Get-FileHash`                                                                                                                        |            |
| G2-06 | `mysqldump` exit code                                 | `0`                                                                                                                                                          |            |
| G2-07 | Guard scan result                                     | `clean` — no `CREATE DATABASE` / `USE` statements                                                                                                            |            |
| G2-19 | Dump completeness marker                              | Final `-- Dump completed` line present (`True`)                                                                                                              |            |
| G2-08 | **Source object counts** (`ecommerce_dev`)            | tables / columns / indexes / constraints / FKs / checks / routines / triggers / events                                                                       |            |
| G2-09 | Restore target                                        | `ecommerce_restore_check` (exact name)                                                                                                                       |            |
| G2-10 | Scratch pre-check                                     | Database did not exist before create (`db_exists` = 0)                                                                                                       |            |
| G2-11 | Restore exit code                                     | `0`                                                                                                                                                          |            |
| G2-12 | **Scratch object counts** (`ecommerce_restore_check`) | same nine object types as G2-08                                                                                                                              |            |
| G2-13 | Reconciliation result                                 | `match` / `mismatch` — every object type identical                                                                                                           |            |
| G2-14 | **Source unchanged after restore**                    | Re-run counts on `ecommerce_dev` = identical to G2-08                                                                                                        |            |
| G2-15 | **No restore directed to `ecommerce_dev`**            | Explicit confirmation: the `mysql` command named only `ecommerce_restore_check`                                                                              |            |
| G2-16 | **Drill performed by owner**                          | Explicit statement that the drill was executed end-to-end                                                                                                    |            |
| G2-17 | Scratch database dropped                              | `DROP DATABASE` of `ecommerce_restore_check` succeeded (exit `0`)                                                                                            |            |
| G2-18 | Errors / aborts                                       | `none`, or a short redacted description                                                                                                                      |            |
| G2-20 | **Per-table row counts** (P4-B-G2-01 v1.1 §4.2/§4.8)  | `source-row-counts-before.txt` = `scratch-row-counts.txt` (or both `no base tables`)                                                                         |            |
| G2-21 | Evidence folder (v1.1 §4.1)                           | Path of `G2_evidence_<stamp>` and the file list (counts, pre-check, reconciliation, source-unchanged, scratch-dropped) — file **names** only, never the dump |            |
| G2-22 | STOP flag never raised                                | Statement that no `G2 STOP:` message appeared (or the exact message if one did)                                                                              |            |

> **Evidence review 2026-11-19 (P4-B-G2-EVREV-01, `docs/G2-EVIDENCE-REVIEW.md`):** all G2 rows empty and no
> evidence files found (the approved directory `C:db-backupsecommerce` does not exist) → **G2 BLOCKED —
> evidence missing**. Rows are filled only from supplied evidence; nothing was inferred.

A row is complete only when it has a value. Any mismatch in G2-13, G2-14 or G2-20 fails the drill.
The counts in G2-08/G2-12/G2-14/G2-20 are copied from the evidence-folder files written by procedure v1.1.

Aggregate acceptance wording (owner only, after review):

```text
G2 — backup/restore drill executed by the owner on <date>; dump SHA-256 recorded; restore into
ecommerce_restore_check reconciled (all object counts match); source ecommerce_dev unchanged;
scratch database dropped. ACCEPTED.
```

---

## 3. G3 — Migration identity and configuration evidence

Source procedure: `docs/INCREMENT-B-G3-MIGRATION-CONNECTION.md`.

| #     | Item                                         | Required value (redacted)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | User entry |
| ----- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| G3-01 | MySQL service                                | `MySQL84` = `Running`; port 3306 listening (`True`/`False`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |            |
| G3-02 | Intended database confirmed                  | `ecommerce_dev` exists (`SHOW DATABASES LIKE` returned it)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |            |
| G3-03 | **Migration identity name and host**         | `ecommerce_migrator@localhost` — **no password**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |            |
| G3-04 | Identity creation result                     | P4-B-G3-02 Phase 3 `EXECUTION_EXIT=0` (Case A). If the identity **pre-existed** (precondition line 2 ≠ 0) the procedure STOPs: that is **not** acceptable G3 evidence and needs a separately reviewed and approved corrective decision (review 2026-11-19 corrected the earlier "or existing user documented" wording)                                                                                                                                                                                                                                                                                                                                                                 |            |
| G3-05 | **Verified grants (complete set, redacted)** | Redacted `SHOW GRANTS` for `ecommerce_migrator@localhost` with authentication clause removed. Must show `USAGE ON *.*` + **exactly one** schema grant: the approved list on `` `ecommerce_dev`.* `` only; no missing/extra privileges, no `GRANT OPTION`, no other schema/database                                                                                                                                                                                                                                                                                                                                                                                                     |            |
| G3-06 | **Exact privilege-set & scope check**        | Output of P4-B-G3-02 v1.2.1 §6.1 (`PASS:` lines for both identities, or the `REJECT` diff). Complete comparison against approved set: `USER_PRIVILEGES` = `{USAGE}` only (`IS_GRANTABLE='NO'`); `SCHEMA_PRIVILEGES` for `ecommerce_dev` = **exactly** `{SELECT,INSERT,UPDATE,DELETE,CREATE,ALTER,DROP,INDEX,REFERENCES,CREATE TEMPORARY TABLES,LOCK TABLES}` (all `IS_GRANTABLE='NO'`); **no** rows for other schemas (incl. `ecommerce_migrate_test`, `ecommerce_restore_check`); no global privileges beyond `USAGE`; no prohibited privileges (`FILE/PROCESS/SUPER/RELOAD/SHUTDOWN/replication/CREATE USER/CREATE DATABASE-equivalent/TRIGGER/EVENT/EXECUTE/routines/GRANT OPTION`) |            |
| G3-07 | Runtime identity unchanged                   | `ecommerce_app@localhost` unchanged: global only `USAGE`; schema privileges on `` `ecommerce_dev`.* `` **exactly** `{SELECT,INSERT,UPDATE,DELETE}` (all `IS_GRANTABLE='NO'`); no DDL, no `GRANT OPTION`, no other schema                                                                                                                                                                                                                                                                                                                                                                                                                                                               |            |
| G3-08 | **Configured target name**                   | `MIGRATION_EXPECTED_DATABASE=ecommerce_migrate_test` (G7 target). A name is **not** proof that the scratch grant exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |            |
| G3-09 | `.env.migration` existence                   | `Exists: True` — **never the contents**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |            |
| G3-10 | `.env.migration` encoding                    | BOM present: `False`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |            |
| G3-11 | **Guard verification**                       | Offline `prisma validate --config prisma.migration.config.ts` = PASS                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |            |
| G3-12 | Guard negative test                          | Wrong expected database aborted with `Refusing to run` (exit 1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |            |
| G3-13 | Offline Prisma validation                    | `npx prisma validate` with placeholder `DATABASE_URL` = PASS                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |            |
| G3-14 | **Runtime credentials not used**             | Explicit confirmation that no migration command used `DATABASE_URL`/`ecommerce_app`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |            |
| G3-15 | Errors / aborts                              | `none`, or a short redacted description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |            |

Evidence must not include the migration URL, user password, password hash or any authentication
string. `SHOW GRANTS` output for MySQL 8.4 usually contains an `IDENTIFIED WITH … AS …` clause — remove
it before submitting.

Aggregate acceptance wording (owner only, after review):

```text
G3 — ecommerce_migrator@localhost created with database-scoped grants on ecommerce_dev.* verified via
SHOW GRANTS; ecommerce_app runtime grants unchanged; .env.migration present (UTF-8, no BOM) targeting
ecommerce_migrate_test for G7; offline migration configuration validation PASS; wrong-target guard
aborts as designed. ACCEPTED.
```

### 3.1 G7 preflight evidence (submitted separately — not part of G3 acceptance)

These items are required before G7 authorization. They are **not** G3 evidence, and G3 acceptance must
not depend on them.

| #     | Item                                        | Required value (redacted)                                          | User entry |
| ----- | ------------------------------------------- | ------------------------------------------------------------------ | ---------- |
| G7-01 | Configured G7 target                        | `MIGRATION_EXPECTED_DATABASE=ecommerce_migrate_test` (name only)   |            |
| G7-02 | Scratch database exists                     | `ecommerce_migrate_test` found in `information_schema.schemata`    |            |
| G7-03 | Scratch database **empty**                  | Table count `0` (no `_prisma_migrations`, no business tables)      |            |
| G7-04 | Scratch-scoped grant applied                | `ecommerce_migrate_test.*` row present in `SHOW GRANTS` (redacted) |            |
| G7-05 | Grant scope check                           | Only the approved privilege list; no `*.*`, no global privilege    |            |
| G7-06 | Dev grant unchanged                         | `ecommerce_dev.*` row unchanged; `ecommerce_app` unchanged         |            |
| G7-07 | Baseline SHA-256 independently confirmed    | `154D2C8E4614609C4D8BF4879F7B1991B6DA0CCA704DAE5DEB09D53F2AB7A6BB` |            |
| G7-08 | Offline guard re-check                      | `prisma validate --config prisma.migration.config.ts` = PASS       |            |
| G7-09 | No connection made with a mismatched target | Confirmation that the scratch target was used for scratch only     |            |
| G7-10 | Separate G7 authorization                   | Owner's explicit authorization (date)                              |            |

After G7 evidence is accepted, submit the **revocation** confirmation: the
`ecommerce_migrate_test.*` row is gone and `SHOW GRANTS` again shows `ecommerce_dev.*` only. The
`.env.migration` switch to `ecommerce_dev` is a separate G8 step (G3 doc §4.8).

---

## 4. Review rules (agent and owner)

The reviewer checks that:

- every required row has a value and the values are internally consistent (dates, counts, exit codes);
- G2 counts match between source and scratch, and the source counts are unchanged afterwards;
- G3 grants/privileges match the **complete approved set exactly** at G3 (`ecommerce_dev.*` only, no missing/extra privileges, no scratch row yet, no global beyond `USAGE`, no `GRANT OPTION`, no other-schema grants) — any mismatch is a **rejection**, not a note; `ecommerce_app` remains unchanged (exact DML-only scope);
- G7 evidence shows the scratch grant on `ecommerce_migrate_test.*` only, verified independently of
  the configured target name; the dev grant is not presented as scratch authorization;
- the target name matches the phase (scratch for G7, `ecommerce_dev` for G8) and is never inferred
  from the grant that happens to exist;
- no forbidden value (URL, password, hash, token, file contents) appears anywhere in the submission;
- the baseline SHA-256 is confirmed separately (`154D2C8E4614609C4D8BF4879F7B1991B6DA0CCA704DAE5DEB09D53F2AB7A6BB`).

A gate stays **NOT STARTED / NOT ACCEPTED** until this review completes. Evidence alone does not
authorize G7.

## 5. Stop conditions (user)

Stop the procedure and report instead of continuing if:

- any command exits non-zero, or a dump/restore file is missing or empty;
- the guard scan finds `CREATE DATABASE` or `USE`;
- `ecommerce_restore_check` already exists before the create step;
- source counts change after the restore;
- `SHOW GRANTS` shows any privilege outside the approved list, `*.*`, or `GRANT OPTION`;
- `.env.migration` cannot be saved without a BOM;
- the wrong-target test does not abort;
- an `Access denied` error is about to be "fixed" by repointing `MIGRATION_EXPECTED_DATABASE` at a
  database the identity already holds;
- the target is `ecommerce_dev` for G7 or `ecommerce_migrate_test` for G8;
- any step would require printing a password, URL or file contents.

Never "repair" a failed verification by widening grants, by reusing `ecommerce_dev`, or by changing
the target to match an existing grant.

## 6. Gate status (unchanged by this checklist)

| Gate        | Status                                      |
| ----------- | ------------------------------------------- |
| G2          | **BLOCKED — evidence missing (2026-11-19)** |
| G3          | **NOT ACCEPTED**                            |
| G7          | **NOT READY — NOT AUTHORIZED**              |
| Increment B | **IN PROGRESS**                             |
| Phase 4     | **IN PROGRESS — NOT APPROVED**              |
