# G2 — Evidence Review (User-Executed Backup/Restore Drill)

| Field       | Value                                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Document ID | P4-B-G2-EVREV-01                                                                                                                                                         |
| Date        | 2026-11-19                                                                                                                                                               |
| Procedure   | P4-B-G2-01 v1.1 · guide P4-B-G2-GUIDE-01                                                                                                                                 |
| Method      | File inspection only (Grep/Glob/Read and one non-recursive directory listing). **No MySQL connection, no SQL, no PowerShell command, no database or file modification.** |
| Result      | **G2 BLOCKED — evidence missing.** No PASS can be inferred from the statement that the drill was run.                                                                    |

## 1. What was inspected

| Location                                                              | Expected (procedure v1.1)                                         | Found                                                   |
| --------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------- |
| `docs/INCREMENT-B-G2-G3-EVIDENCE-CHECKLIST.md` §2, rows G2-01 … G2-22 | Values filled by the owner                                        | **All 22 "User entry" cells empty**                     |
| `C:\db-backups\ecommerce` (approved backup directory, §2 rule 6)      | `ecommerce_dev_<stamp>_G2.sql`, `.sha256`, `G2_evidence_<stamp>\` | **Directory does not exist** (nor does `C:\db-backups`) |
| `C:\` top level                                                       | —                                                                 | No backup/dump folder                                   |
| Workspace (`…\OneDrive\Desktop`), `Documents`, `Downloads`            | (should not contain dumps)                                        | No `*_G2.sql`, `*.sha256` or `G2_evidence_*`            |

Excluded on purpose: the agent's own **offline dry-run** artifacts (fake client, synthetic dumps) in the
session scratchpad. They were produced by the procedure review on 2026-11-19, contain no data from
`ecommerce_dev`, and are **not** evidence of the drill.

## 2. Row-by-row status

| Row   | Requirement                   | Status                       | Missing evidence                                                                                                      |
| ----- | ----------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| G2-01 | Drill date/time               | MISSING                      | Date/time                                                                                                             |
| G2-02 | Backup file path              | MISSING                      | Path under `C:\db-backups\ecommerce` — directory not found                                                            |
| G2-03 | Backup file exists            | MISSING / **not verifiable** | No dump file found                                                                                                    |
| G2-04 | Size (bytes)                  | MISSING                      | —                                                                                                                     |
| G2-05 | SHA-256                       | MISSING / **not verifiable** | No `.sha256` file; no dump to recompute against                                                                       |
| G2-06 | `mysqldump` exit code         | MISSING                      | Printed `mysqldump: exit code 0` line                                                                                 |
| G2-07 | Guard scan                    | MISSING                      | `Guard scan clean…` line                                                                                              |
| G2-19 | Completion marker             | MISSING / **not verifiable** | `Completeness marker present…` line; no dump to inspect                                                               |
| G2-08 | Source object counts          | MISSING                      | `source-object-counts-before.txt`                                                                                     |
| G2-09 | Restore target                | MISSING                      | Confirmation `ecommerce_restore_check`                                                                                |
| G2-10 | Scratch pre-check             | MISSING                      | `scratch-precheck.txt` (`db_exists = 0`)                                                                              |
| G2-11 | Restore exit code             | MISSING                      | `restore: exit code 0` line                                                                                           |
| G2-12 | Scratch object counts         | MISSING                      | `scratch-object-counts.txt`                                                                                           |
| G2-13 | Reconciliation                | MISSING                      | `reconciliation.txt` = `match`                                                                                        |
| G2-14 | Source unchanged              | MISSING                      | `source-object-counts-after.txt`, `source-row-counts-after.txt`, `source-unchanged.txt` = `unchanged`                 |
| G2-15 | No restore to `ecommerce_dev` | MISSING                      | Explicit confirmation                                                                                                 |
| G2-16 | Performed by owner            | PARTIAL                      | Your message states the drill was completed — accepted as the owner's statement only, **not** as evidence of any step |
| G2-17 | Scratch dropped               | MISSING                      | `scratch-dropped.txt`, `drop scratch database: exit code 0`                                                           |
| G2-18 | Errors / aborts               | MISSING                      | `none` or the message                                                                                                 |
| G2-20 | Per-table row counts          | MISSING                      | `source-row-counts-before.txt` and `scratch-row-counts.txt`                                                           |
| G2-21 | Evidence folder               | MISSING                      | `G2_evidence_<stamp>` path + file list                                                                                |
| G2-22 | STOP flag never raised        | MISSING                      | Statement / exact message                                                                                             |

Requested verifications and their outcome:

| Verification                                              | Outcome                                                   |
| --------------------------------------------------------- | --------------------------------------------------------- |
| Evidence files present                                    | **Not possible** — none found                             |
| Completion marker                                         | **Not verifiable**                                        |
| SHA-256                                                   | **Not verifiable**                                        |
| Source/restore separation                                 | **Not verifiable** (no command output, no evidence files) |
| Schema reconciliation, table counts, per-table row counts | **Not verifiable**                                        |
| `ecommerce_dev` unaffected during restore                 | **Not verifiable**                                        |

## 3. Possible explanations (none assumed)

1. The drill ran on another machine or user account, or wrote to a different folder.
2. The evidence folder was moved, deleted, or is on a drive not inspected.
3. The drill stopped early (a `G2 STOP:` would leave a partial evidence folder — none exists either).
4. The drill has not been run yet in the v1.1 form.

## 4. What is needed to unblock (no secrets)

Any **one** of the following:

- **Option A (preferred):** tell me the actual folder path. I will read only the small text files in
  `G2_evidence_<stamp>\`, the `.sha256` file, and recompute the dump's SHA-256 **without** reading or
  quoting its contents (reading the dump's last line only for the completion marker).
- **Option B:** fill rows G2-01 … G2-22 in the checklist yourself and paste the **contents of the small
  evidence text files** (they contain only object-type names, table names and numbers) plus the printed
  exit-code lines.
- **Option C:** if the drill was not run with v1.1, run `docs/G2-USER-EXECUTION-GUIDE.md` in one
  Windows PowerShell 5.1 window; the evidence folder is created automatically.

Never send: the dump file or its contents, passwords, `.env`/`.env.migration` contents, connection URLs.

## 5. Recommendation

**G2 BLOCKED — evidence missing.** No acceptance recommendation can be prepared. G2 acceptance remains
with the owner after a complete evidence review. G3, G7, G8 and Phase 4 status are unchanged.
