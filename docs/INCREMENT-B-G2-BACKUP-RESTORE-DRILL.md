# Increment B — G2 Backup & Restore Drill Procedure

| Field          | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document ID    | P4-B-G2-01                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Version        | 1.1 (independent review corrections, 2026-11-19)                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Phase          | Phase 4 — Backend Development (Increment B, Gate G2)                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Status         | **PROCEDURE REVIEWED — USER EXECUTION PENDING (not executed, not accepted)**                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Date           | 2026-11-18 (v1.0) · 2026-11-19 (v1.1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Gate owner     | User (privileged local MySQL session). The agent must never execute any command in this document.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Authoritative  | Derived from `docs/INCREMENT-B-IMPLEMENTATION-PLAN.md` §8/§9/§10 and `docs/INCREMENT-B-RISK-ASSESSMENT.md` R-12                                                                                                                                                                                                                                                                                                                                                                                                   |
| Review         | `docs/G2-FINAL-INDEPENDENT-REVIEW.md` (P4-B-G2-REV-01)                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Change summary | v1.1: every native command now **stops automatically** on a non-zero exit (with a carry-over STOP flag so later pasted blocks refuse to run); scratch pre-check is machine-checked; before/after/source counts and per-table row counts are **saved to evidence files and compared automatically**; the drop step requires a recorded reconciliation; backup retention and recovery-evidence rules added (§4.11). Dump, guard, hash, create and restore commands are unchanged (verified by offline dummy tests). |

> **This is a procedure, not evidence.** G2 remains **USER EXECUTION PENDING** until the user runs the
> drill and the evidence is reviewed. No backup, restore, database creation or drop has been performed
> by the agent.

---

## 1. Purpose and gate position

G2 is a mandatory user-executed gate before G7/G8. It proves that `ecommerce_dev` can be backed up
**and actually restored** into a separate scratch database before any migration is applied. If the
drill fails, Increment B stops — there is no reduced-privilege workaround and no destructive fallback
(plan §8/§10; risk R-12).

Scope of this drill:

- one logical dump of the single schema `ecommerce_dev`;
- one restore into a **separate, explicitly named** scratch database `ecommerce_restore_check`;
- object-count and per-table row-count reconciliation before and after;
- an integrity hash of the dump file;
- a redacted evidence record kept with the backup.

Out of scope: production backup infrastructure (PITR, off-site storage, encryption at rest) — deferred
per plan §8.

---

## 2. Hard safety rules

1. **Never restore into `ecommerce_dev`.** The restore target is `ecommerce_restore_check` only.
2. **Do not use `--databases`.** With `--databases`, `mysqldump` writes `CREATE DATABASE` and a `USE`
   statement naming `ecommerce_dev` into the file. Restoring that file would silently target the
   source database. The positional form (`mysqldump … ecommerce_dev`) omits both statements, and the
   restore target is then chosen solely by the `mysql` command line. This supersedes the
   illustrative `--databases ecommerce_dev` snippet in the plan's G2 row.
3. **Do not use the runtime or migration user for the dump.** `ecommerce_app` has DML only and
   `ecommerce_migrator` has no global privileges; `--routines`/`--events` need a privileged local
   account (admin/root). The dump is a local drill performed by the user.
4. **No password on any command line.** Use the interactive `-p` prompt (you will be asked for the
   password once per `mysql`/`mysqldump` command).
5. **No PowerShell redirection (`>` or `<`).** PowerShell 5.1 writes `>` as UTF-16 and does not
   support `<`. Use `--result-file` for the dump and `cmd /c … <` (or `--execute="source …"`) for the
   restore.
6. **Dumps stay outside the repository** and are never committed or synced. `C:\db-backups\ecommerce`
   is the approved backup directory.
7. **Drop only `ecommerce_restore_check`**, and only after the reconciliation is recorded.
8. **Never print credentials, `.env`/`.env.migration` contents or full connection URLs** in the
   evidence.
9. **STOP means stop.** Every block below ends in `throw` on failure and sets `$global:G2Stop`. Any later
   block refuses to run while that flag is set. Never clear the flag to "try again" — report instead (§6).

---

## 3. Preconditions

| #   | Precondition                                                                                            | Check                                                              |
| --- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| P1  | MySQL 8.4 client tools installed                                                                        | `C:\Program Files\MySQL\MySQL Server 8.4\bin\mysqldump.exe` exists |
| P2  | `MySQL84` service running and `localhost:3306` reachable                                                | service status / successful `SELECT 1`                             |
| P3  | A privileged local account is available to you (password typed interactively)                           | —                                                                  |
| P4  | `ecommerce_dev` exists and its object count matches the expected state **at this point in the project** | §4.2 count                                                         |
| P5  | `ecommerce_restore_check` does **not** already exist                                                    | §4.6 pre-check (machine-checked)                                   |
| P6  | `C:\db-backups\ecommerce` is outside the repository and excluded from any sync/commit                   | —                                                                  |
| P7  | Enough free disk space for the dump and a second copy of the schema                                     | —                                                                  |
| P8  | One PowerShell 5.1 window used for the whole drill (variables and the STOP flag live in that session)   | —                                                                  |

> **Repository note:** the working repository root is `ecommerce-api` itself. Do not place backups in
> it or anywhere under `C:\Users\sumes\OneDrive\Desktop\ecommerce-workspace` (OneDrive-synced).

---

## 4. PowerShell 5.1 procedure (user-executed)

Set `$adminUser` to your privileged local account. Never put a password in this script. The `<` and
`>` characters are reserved by PowerShell 5.1, so no placeholder in this section uses them. Run the
blocks **in order, in one window**.

### 4.1 Session setup, paths, guards and helpers

```powershell
$mysqlBin    = 'C:\Program Files\MySQL\MySQL Server 8.4\bin'
$mysqldump   = Join-Path $mysqlBin 'mysqldump.exe'
$mysql       = Join-Path $mysqlBin 'mysql.exe'
$backupDir   = 'C:\db-backups\ecommerce'
$sourceDb    = 'ecommerce_dev'
$restoreDb   = 'ecommerce_restore_check'
$adminUser   = 'root'                 # replace with your privileged local account
$stamp       = Get-Date -Format 'yyyyMMdd_HHmmss'
$dump        = Join-Path $backupDir ("{0}_{1}_G2.sql" -f $sourceDb, $stamp)
$evidenceDir = Join-Path $backupDir ("G2_evidence_{0}" -f $stamp)
$global:G2Stop = $false

function Stop-G2([string]$reason) {
    $global:G2Stop = $true
    throw "G2 STOP: $reason Do not continue; report this (procedure section 6)."
}
function Assert-G2Ready {
    if ($global:G2Stop) { throw 'G2 STOP: an earlier step failed. Do not continue; report it.' }
}
function Assert-G2Exit([string]$step) {
    if ($LASTEXITCODE -ne 0) { Stop-G2 "$step failed (exit code $LASTEXITCODE)." }
    "${step}: exit code 0"
}

# Guards: the restore target must never be the source database.
if ($restoreDb -eq $sourceDb) { Stop-G2 'Restore target equals the source database.' }
if ($restoreDb -ne 'ecommerce_restore_check') { Stop-G2 'Unexpected restore target.' }
if ($sourceDb -ne 'ecommerce_dev') { Stop-G2 'Unexpected source database.' }
if ($backupDir -like 'C:\Users\*') { Stop-G2 'Backup directory must be outside the user profile/OneDrive.' }
foreach ($exe in $mysql, $mysqldump) { if (-not (Test-Path -LiteralPath $exe)) { Stop-G2 "Missing client: $exe" } }

New-Item -ItemType Directory -Force -Path $backupDir   | Out-Null
New-Item -ItemType Directory -Force -Path $evidenceDir | Out-Null
"dump file    : $dump"
"evidence dir : $evidenceDir"
```

### 4.2 Count helpers and before-counts (source `ecommerce_dev`)

The helpers run **read-only** `SELECT` statements and capture the tab-separated output (`-N -B`). The
password prompt is written to the console, not to the captured output.

```powershell
Assert-G2Ready

function Get-G2ObjectCounts([string]$db) {
    $sql = @"
SELECT 'tables', COUNT(*) FROM information_schema.tables WHERE table_schema = '$db'
UNION ALL SELECT 'columns', COUNT(*) FROM information_schema.columns WHERE table_schema = '$db'
UNION ALL SELECT 'indexes', COUNT(DISTINCT table_name, index_name) FROM information_schema.statistics WHERE table_schema = '$db'
UNION ALL SELECT 'table_constraints', COUNT(*) FROM information_schema.table_constraints WHERE table_schema = '$db'
UNION ALL SELECT 'foreign_keys', COUNT(*) FROM information_schema.referential_constraints WHERE constraint_schema = '$db'
UNION ALL SELECT 'check_constraints', COUNT(*) FROM information_schema.check_constraints WHERE constraint_schema = '$db'
UNION ALL SELECT 'routines', COUNT(*) FROM information_schema.routines WHERE routine_schema = '$db'
UNION ALL SELECT 'triggers', COUNT(*) FROM information_schema.triggers WHERE trigger_schema = '$db'
UNION ALL SELECT 'events', COUNT(*) FROM information_schema.events WHERE event_schema = '$db';
"@
    $out = & $mysql -h 127.0.0.1 -P 3306 -u $adminUser -p -N -B -e $sql
    Assert-G2Exit "object counts ($db)" | Out-Null
    $lines = @($out | Where-Object { $_ -ne '' })
    if ($lines.Count -ne 9) { Stop-G2 "Expected 9 object-count lines for $db, got $($lines.Count)." }
    return $lines
}

function Get-G2RowCounts([string]$db) {
    $tablesSql = "SELECT table_name FROM information_schema.tables WHERE table_schema = '$db' AND table_type = 'BASE TABLE' ORDER BY table_name;"
    $tables = @(& $mysql -h 127.0.0.1 -P 3306 -u $adminUser -p -N -B -e $tablesSql | Where-Object { $_ -ne '' })
    Assert-G2Exit "table list ($db)" | Out-Null
    if ($tables.Count -eq 0) { return @('no base tables') }
    $parts = $tables | ForEach-Object { "SELECT '$_', COUNT(*) FROM ``$db``.``$_``" }
    $rowSql = ($parts -join ' UNION ALL ') + ';'
    $rows = @(& $mysql -h 127.0.0.1 -P 3306 -u $adminUser -p -N -B -e $rowSql | Where-Object { $_ -ne '' })
    Assert-G2Exit "row counts ($db)" | Out-Null
    if ($rows.Count -ne $tables.Count) { Stop-G2 "Row-count output incomplete for $db." }
    return $rows
}

$beforeObjects = Get-G2ObjectCounts $sourceDb
$beforeRows    = Get-G2RowCounts $sourceDb
$beforeObjects | Set-Content -Path (Join-Path $evidenceDir 'source-object-counts-before.txt') -Encoding ASCII
$beforeRows    | Set-Content -Path (Join-Path $evidenceDir 'source-row-counts-before.txt') -Encoding ASCII
$beforeObjects
$beforeRows
```

`Get-G2RowCounts` builds one `COUNT(*)` per base table from `information_schema` names of the given
schema only (backtick-quoted), so it reads data counts without modifying anything.

### 4.3 Dump

```powershell
Assert-G2Ready
& $mysqldump `
  -h 127.0.0.1 -P 3306 -u $adminUser -p `
  --single-transaction --routines --events --triggers `
  --default-character-set=utf8mb4 --no-tablespaces --set-gtid-purged=OFF `
  --result-file="$dump" `
  $sourceDb
Assert-G2Exit 'mysqldump'
```

`--single-transaction` gives a consistent InnoDB snapshot without locking. `--no-tablespaces` avoids
requiring the `PROCESS` privilege. `--set-gtid-purged=OFF` keeps the dump restorable without
`SUPER`/GTID privileges. The positional `$sourceDb` (no `--databases`) keeps `CREATE DATABASE`/`USE`
out of the file.

### 4.4 Guard scan (mandatory)

```powershell
Assert-G2Ready
if (-not (Test-Path -Path $dump)) { Stop-G2 'Dump file is missing.' }
$dumpSize = (Get-Item -Path $dump).Length
if ($dumpSize -eq 0) { Stop-G2 'Dump file is empty.' }
"dump size (bytes): $dumpSize"

# Completeness marker: mysqldump writes a final "-- Dump completed" line.
if (-not (Select-String -Path $dump -Pattern '^-- Dump completed' -Quiet)) {
    Stop-G2 'Dump file has no completion marker; treat it as truncated and do not restore it.'
}
'Completeness marker present: Dump completed.'

$forbidden = Select-String -Path $dump -Pattern '^\s*(CREATE\s+DATABASE|USE\s+)' -CaseSensitive:$false
if ($forbidden) {
    $forbidden | ForEach-Object { "ABORT near line $($_.LineNumber): $($_.Line)" }
    Stop-G2 'Dump contains database-selection statements. Do not restore this file.'
}
'Guard scan clean: no CREATE DATABASE / USE statements.'
```

If a match appears inside a stored routine body, inspect it manually before deciding; the flag stays
set until you have reported it. Anything at statement level is an automatic abort.

### 4.5 SHA-256 evidence

```powershell
Assert-G2Ready
$hash     = (Get-FileHash -Path $dump -Algorithm SHA256).Hash
$hashFile = $dump + '.sha256'
"$hash  $dump" | Set-Content -Path $hashFile -Encoding ASCII
Get-Content -Path $hashFile
```

### 4.6 Create the scratch restore database (user only)

The pre-check is **machine-checked**: anything other than `0` stops the drill. Do not overwrite or
drop an existing schema as part of this drill.

```powershell
Assert-G2Ready
$existsSql = "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = 'ecommerce_restore_check';"
$exists = & $mysql -h 127.0.0.1 -P 3306 -u $adminUser -p -N -B -e $existsSql
Assert-G2Exit 'scratch pre-check'
if ("$exists".Trim() -ne '0') { Stop-G2 "ecommerce_restore_check already exists (db_exists = $exists)." }
'db_exists = 0' | Set-Content -Path (Join-Path $evidenceDir 'scratch-precheck.txt') -Encoding ASCII
'Scratch pre-check: db_exists = 0'
```

Then create it. `CREATE DATABASE` is deliberately used **without** `IF NOT EXISTS`, so it fails instead
of reusing an existing schema.

```powershell
Assert-G2Ready
& $mysql -h 127.0.0.1 -P 3306 -u $adminUser -p `
  -e 'CREATE DATABASE `ecommerce_restore_check` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;'
Assert-G2Exit 'create scratch database'
```

### 4.7 Restore into the scratch database

```powershell
Assert-G2Ready
$restoreCmd = '"' + $mysql + '" --default-character-set=utf8mb4 -h 127.0.0.1 -P 3306 -u ' + $adminUser + ' -p ' + $restoreDb + ' < "' + $dump + '"'
cmd /c $restoreCmd
Assert-G2Exit 'restore'
```

`cmd /c` is required because PowerShell 5.1 does not support `<`. The only database named on this
command line is `$restoreDb` (`ecommerce_restore_check`). If your environment blocks the password
prompt inside `cmd /c`, use this equivalent form instead (run **one** of the two, never both):

```powershell
Assert-G2Ready
& $mysql --default-character-set=utf8mb4 -h 127.0.0.1 -P 3306 -u $adminUser -p $restoreDb `
  --execute="source $($dump -replace '\\','/')"
Assert-G2Exit 'restore (source form)'
```

### 4.8 After-counts (scratch database) and automatic reconciliation

```powershell
Assert-G2Ready
$afterObjects = Get-G2ObjectCounts $restoreDb
$afterRows    = Get-G2RowCounts $restoreDb
$afterObjects | Set-Content -Path (Join-Path $evidenceDir 'scratch-object-counts.txt') -Encoding ASCII
$afterRows    | Set-Content -Path (Join-Path $evidenceDir 'scratch-row-counts.txt') -Encoding ASCII

$objectDiff = Compare-Object -ReferenceObject $beforeObjects -DifferenceObject $afterObjects
$rowDiff    = Compare-Object -ReferenceObject $beforeRows    -DifferenceObject $afterRows
if ($objectDiff -or $rowDiff) {
    $objectDiff; $rowDiff
    'mismatch' | Set-Content -Path (Join-Path $evidenceDir 'reconciliation.txt') -Encoding ASCII
    Stop-G2 'Scratch counts differ from the source (failed drill).'
}
'match' | Set-Content -Path (Join-Path $evidenceDir 'reconciliation.txt') -Encoding ASCII
'Reconciliation: match (all object types and per-table row counts identical).'
```

### 4.9 Confirm the source database was not touched

```powershell
Assert-G2Ready
$sourceAfterObjects = Get-G2ObjectCounts $sourceDb
$sourceAfterRows    = Get-G2RowCounts $sourceDb
$sourceAfterObjects | Set-Content -Path (Join-Path $evidenceDir 'source-object-counts-after.txt') -Encoding ASCII
$sourceAfterRows    | Set-Content -Path (Join-Path $evidenceDir 'source-row-counts-after.txt') -Encoding ASCII
if ((Compare-Object $beforeObjects $sourceAfterObjects) -or (Compare-Object $beforeRows $sourceAfterRows)) {
    'changed' | Set-Content -Path (Join-Path $evidenceDir 'source-unchanged.txt') -Encoding ASCII
    Stop-G2 'Source ecommerce_dev changed during the drill. Do not drop anything.'
}
'unchanged' | Set-Content -Path (Join-Path $evidenceDir 'source-unchanged.txt') -Encoding ASCII
'Source ecommerce_dev unchanged.'
```

Any difference means a command targeted the source database — stop, do not drop anything, and report.

### 4.10 Drop only the scratch database

Runs **only after** the reconciliation and source check are recorded as files:

```powershell
Assert-G2Ready
foreach ($f in 'reconciliation.txt', 'source-unchanged.txt') {
    if (-not (Test-Path (Join-Path $evidenceDir $f))) { Stop-G2 "Missing evidence file $f." }
}
if ((Get-Content (Join-Path $evidenceDir 'reconciliation.txt')) -ne 'match')       { Stop-G2 'Reconciliation is not match.' }
if ((Get-Content (Join-Path $evidenceDir 'source-unchanged.txt')) -ne 'unchanged') { Stop-G2 'Source not confirmed unchanged.' }

& $mysql -h 127.0.0.1 -P 3306 -u $adminUser -p `
  -e 'DROP DATABASE `ecommerce_restore_check`;'
Assert-G2Exit 'drop scratch database'
'dropped' | Set-Content -Path (Join-Path $evidenceDir 'scratch-dropped.txt') -Encoding ASCII
```

Do not drop `ecommerce_dev`. Do not drop any other schema.

### 4.11 Backup retention and recovery evidence

| Item               | Rule                                                                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What is kept       | `$dump`, `$dump.sha256` and the `G2_evidence_<stamp>` folder (counts, pre-check, reconciliation, source-unchanged, drop marker)                                                                                                             |
| Where              | `C:\db-backups\ecommerce` only — outside the repository and outside OneDrive; never committed, synced, emailed or pasted                                                                                                                    |
| How long           | At least until **G8 PASS** and the **fresh pre-G8 backup** (G8 precondition) has itself been dumped, hashed and verified. Deleting earlier files is a manual owner decision, noted in the evidence record                                   |
| Protection         | The dump contains the full schema and any rows present (possibly personal data once the store has customers). Keep the folder readable by your Windows account only                                                                         |
| Integrity re-check | Before any restore from this file, recompute `Get-FileHash … -Algorithm SHA256` and compare with `.sha256`; a mismatch means the file must not be used                                                                                      |
| Recovery use       | A real recovery always restores into a **new scratch schema first** (§4.6–§4.9 pattern), verifies it, and only then follows a separately reviewed recovery plan. Never restore over `ecommerce_dev` from this procedure; no automatic reset |

---

## 5. Evidence record (redacted)

Record the following in the Increment B report (or in a separate user-held note). **No passwords, no
`.env` contents, no full connection URLs.** The same fields are laid out as a submission template in
`docs/INCREMENT-B-G2-G3-EVIDENCE-CHECKLIST.md` §2 — use it when sending evidence for review. The
evidence folder files are the source for the counts.

| Field                    | Value |
| ------------------------ | ----- |
| Drill date/time          |       |
| Dump file path           |       |
| Dump size (bytes)        |       |
| SHA-256                  |       |
| `mysqldump` exit code    |       |
| Dump completeness marker |       |
| Guard scan result        |       |
| Before object counts     |       |
| Before row counts        |       |
| After object counts      |       |
| After row counts         |       |
| Reconciliation result    |       |
| Source unchanged         |       |
| Restore target confirmed |       |
| Scratch database dropped |       |
| Evidence folder path     |       |
| Any error / abort        |       |

Gate acceptance wording (to be used only after the user supplies the evidence and it is reviewed):

> G2 — backup/restore drill executed by the owner; dump hash recorded; restore into
> `ecommerce_restore_check` reconciled (object and row counts); source unchanged; scratch database
> dropped. **ACCEPTED** (date).

---

## 6. Abort conditions

Stop and report — do not continue to G7 — if any of the following occurs (each is enforced by a
`Stop-G2` in §4 where it can be detected automatically):

- any `mysql`/`mysqldump` exit code is non-zero;
- the dump file is missing, empty or has no completion marker;
- the guard scan finds `CREATE DATABASE`/`USE` statements;
- `ecommerce_restore_check` already exists before the create step;
- before/after object counts or per-table row counts differ;
- the source database counts change after the restore;
- the restore accidentally targets `ecommerce_dev` (detected by a changed source count);
- any credential would have to be printed or pasted into a command line.

After a STOP: do **not** clear `$global:G2Stop`, do not rerun blocks, do not drop anything unless the
evidence shows exactly which schema is the scratch copy. Recovery from a failed drill is the G2 backup
itself plus the approved forward-fix process (plan §6). No destructive reset is permitted. A new drill
is a fresh run in a **new** PowerShell window after the failure has been reviewed.

---

## 7. Status

- **G2: USER EXECUTION PENDING.** No command in this document has been executed by the agent.
- G3 prerequisite: see `docs/INCREMENT-B-G3-MIGRATION-CONNECTION.md` and P4-B-G3-02 v1.2.
- G7 remains blocked until G2 and G3 are accepted.
