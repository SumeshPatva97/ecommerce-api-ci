# G2 — User Execution Guide (Backup & Restore Drill)

| Field       | Value                                                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Document ID | P4-B-G2-GUIDE-01                                                                                                                             |
| Date        | 2026-11-19                                                                                                                                   |
| Procedure   | `INCREMENT-B-G2-BACKUP-RESTORE-DRILL.md` (P4-B-G2-01) **v1.1** — every command below is copied verbatim from it (generated and diff-checked) |
| Review      | `G2-FINAL-INDEPENDENT-REVIEW.md` — documentation review PASS                                                                                 |
| Who runs it | **You**, on your machine, in **one** Windows PowerShell 5.1 window. The agent never runs it.                                                 |
| Status      | **G2: USER EXECUTION PENDING** — running this guide does not accept G2; the evidence is reviewed afterwards                                  |

## Before you start

- About 15 minutes. You will type the MySQL admin password at a hidden prompt **once per command** (~14 times). Never paste it anywhere else.
- Use `Windows PowerShell` (not PowerShell 7), started normally (no admin rights needed). Turn off any transcript/recording.
- If any step prints a line starting with `G2 STOP:`, **stop**. Do not re-run blocks, do not drop anything, do not clear `$global:G2Stop`. Save what is on screen (without passwords) and report it.
- What you will keep: the dump file, its `.sha256` file and the `G2_evidence_<timestamp>` folder in `C:\db-backups\ecommerce`. Keep them until G8 has passed and the fresh pre-G8 backup has been verified. Never put them in OneDrive, the repository, email or chat.

---

## Step 0 — Prerequisite check (read-only; added 2026-11-19)

**Purpose:** confirm procedure preconditions P1, P2, P6, P7, P8 (§3) before anything is created:
PowerShell 5.1 Desktop, MySQL 8.4 client tools present, `MySQL84` running, port 3306 listening, backup
folder not yet present, free disk space. **Read-only:** no MySQL login (`--version` only prints the
client version; the port check is a TCP test), no files or databases created. This step is a guide
addition based on the procedure's §3 preconditions table, which has no commands of its own.

```powershell
"PS version : $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition))"
"mysql.exe  : $(Test-Path -LiteralPath 'C:\Program Files\MySQL\MySQL Server 8.4\bin\mysql.exe')"
"mysqldump  : $(Test-Path -LiteralPath 'C:\Program Files\MySQL\MySQL Server 8.4\bin\mysqldump.exe')"
& 'C:\Program Files\MySQL\MySQL Server 8.4\bin\mysqldump.exe' --version
Get-Service -Name 'MySQL84' | Select-Object Name, Status, StartType | Format-Table -AutoSize
"port 3306  : $(Test-NetConnection -ComputerName 127.0.0.1 -Port 3306 -InformationLevel Quiet -WarningAction SilentlyContinue)"
"C:\db-backups exists : $(Test-Path -LiteralPath 'C:\db-backups')"
"C: free GB : $([math]::Round((Get-PSDrive -Name C).Free / 1GB, 1))"
```

**Expected:** `PS version : 5.1.… (Desktop)`; `mysql.exe : True`; `mysqldump : True`; a version line
containing `Ver 8.4.`; service `MySQL84 Running Automatic`; `port 3306 : True`;
`C:\db-backups exists : False`; `C: free GB` ≥ 1.
**Stop if:** any value differs — wrong shell or edition, a `False` for a client tool, a `--version`
error, service not `Running`, port `False`, `C:\db-backups exists : True` (do not delete anything in it),
or less than 1 GB free.
**Save:** the whole output (it contains no secrets).

## Step 1 — Set up the session, guards and helpers

**Purpose:** define paths and the fixed source/target names, refuse unsafe values, create the backup and evidence folders, and load the STOP helpers. Change `$adminUser` only if your admin account is not `root`.

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

**Expected:** two lines `dump file : C:\db-backups\ecommerce\ecommerce_dev_<timestamp>_G2.sql` and `evidence dir : …\G2_evidence_<timestamp>`. No prompt yet.
**Stop if:** any `G2 STOP:` line (e.g. missing client, unexpected database name).
**Save:** the two printed paths.

## Step 2 — Count objects and rows in the source (`ecommerce_dev`)

**Purpose:** read-only baseline of the source: nine object counts and per-table row counts. Prompts up to 3 times.

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

**Expected:** nine lines `tables 0 … events 0` (all `0` while the baseline is not applied) and `no base tables` — or real counts if tables exist.
**Stop if:** `G2 STOP:` (failed query or incomplete output).
**Save:** files `source-object-counts-before.txt`, `source-row-counts-before.txt` (written automatically).

## Step 3 — Create the dump

**Purpose:** single-schema logical dump of `ecommerce_dev` (positional name, no `--databases`). One prompt.

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

**Expected:** `mysqldump: exit code 0`.
**Stop if:** `G2 STOP:` or any error text.
**Save:** the exit code line (evidence G2-06).

## Step 4 — Check the dump (size, completion marker, no database-selection statements)

**Purpose:** prove the file is complete and cannot redirect the restore to `ecommerce_dev`. No prompt.

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

**Expected:** `dump size (bytes): <number>`, `Completeness marker present: Dump completed.`, `Guard scan clean: no CREATE DATABASE / USE statements.`
**Stop if:** `G2 STOP:` (empty, truncated or `CREATE DATABASE`/`USE` found).
**Save:** the size and both result lines (G2-04, G2-19, G2-07).

## Step 5 — Hash the dump

**Purpose:** integrity fingerprint for later verification. No prompt.

```powershell
Assert-G2Ready
$hash     = (Get-FileHash -Path $dump -Algorithm SHA256).Hash
$hashFile = $dump + '.sha256'
"$hash  $dump" | Set-Content -Path $hashFile -Encoding ASCII
Get-Content -Path $hashFile
```

**Expected:** one line `<64 hex characters>  <dump path>`.
**Save:** the hash (G2-05). The `.sha256` file is written next to the dump.

## Step 6 — Confirm the scratch database does not exist

**Purpose:** machine-checked guarantee that no existing schema will be overwritten. One prompt.

```powershell
Assert-G2Ready
$existsSql = "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = 'ecommerce_restore_check';"
$exists = & $mysql -h 127.0.0.1 -P 3306 -u $adminUser -p -N -B -e $existsSql
Assert-G2Exit 'scratch pre-check'
if ("$exists".Trim() -ne '0') { Stop-G2 "ecommerce_restore_check already exists (db_exists = $exists)." }
'db_exists = 0' | Set-Content -Path (Join-Path $evidenceDir 'scratch-precheck.txt') -Encoding ASCII
'Scratch pre-check: db_exists = 0'
```

**Expected:** `scratch pre-check: exit code 0` and `Scratch pre-check: db_exists = 0`.
**Stop if:** `G2 STOP: ecommerce_restore_check already exists` — do **not** drop it; report.
**Save:** `scratch-precheck.txt` (automatic; G2-10).

## Step 7 — Create the scratch database

**Purpose:** create the empty, separately named target `ecommerce_restore_check` (fails if it exists). One prompt.

```powershell
Assert-G2Ready
& $mysql -h 127.0.0.1 -P 3306 -u $adminUser -p `
  -e 'CREATE DATABASE `ecommerce_restore_check` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;'
Assert-G2Exit 'create scratch database'
```

**Expected:** `create scratch database: exit code 0`.
**Stop if:** `G2 STOP:`.

## Step 8 — Restore into the scratch database

**Purpose:** load the dump into `ecommerce_restore_check` only. One prompt. Run this block **or** Step 8b — never both.

```powershell
Assert-G2Ready
$restoreCmd = '"' + $mysql + '" --default-character-set=utf8mb4 -h 127.0.0.1 -P 3306 -u ' + $adminUser + ' -p ' + $restoreDb + ' < "' + $dump + '"'
cmd /c $restoreCmd
Assert-G2Exit 'restore'
```

**Expected:** `restore: exit code 0`.
**Stop if:** `G2 STOP:` or any `ERROR` line.
**Save:** the exit code line (G2-11).

### Step 8b — Alternative restore (only if Step 8's password prompt does not work)

```powershell
Assert-G2Ready
& $mysql --default-character-set=utf8mb4 -h 127.0.0.1 -P 3306 -u $adminUser -p $restoreDb `
  --execute="source $($dump -replace '\\','/')"
Assert-G2Exit 'restore (source form)'
```

**Expected:** `restore (source form): exit code 0`.

## Step 9 — Count the scratch copy and reconcile automatically

**Purpose:** prove the restored copy matches the source (objects and rows). Prompts up to 3 times.

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

**Expected:** `Reconciliation: match (all object types and per-table row counts identical).`
**Stop if:** `G2 STOP: Scratch counts differ from the source` — the differing lines are printed above it.
**Save:** `scratch-object-counts.txt`, `scratch-row-counts.txt`, `reconciliation.txt` (G2-12, G2-13, G2-20).

## Step 10 — Confirm the source was not touched

**Purpose:** re-count `ecommerce_dev` and compare with Step 2. Prompts up to 3 times.

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

**Expected:** `Source ecommerce_dev unchanged.`
**Stop if:** `G2 STOP: Source ecommerce_dev changed during the drill` — do not drop anything; report.
**Save:** `source-object-counts-after.txt`, `source-row-counts-after.txt`, `source-unchanged.txt` (G2-14).

## Step 11 — Drop the scratch database

**Purpose:** remove only `ecommerce_restore_check`, and only when the evidence files say `match` and `unchanged`. One prompt.

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

**Expected:** `drop scratch database: exit code 0`.
**Stop if:** `G2 STOP:` (missing/negative evidence) — nothing is dropped in that case.
**Save:** `scratch-dropped.txt` (G2-17).

---

## After the drill — what to send for review

Fill `INCREMENT-B-G2-G3-EVIDENCE-CHECKLIST.md` §2 (rows G2-01 … G2-22) with: date/time, dump path, size,
SHA-256, exit codes, guard and marker results, the contents of the small count files (they contain only
object names and numbers), `match`, `unchanged`, `dropped`, and "no `G2 STOP:` appeared".

**Never send:** the dump file or its contents, any password, `.env`/`.env.migration` contents, or a
connection URL.

G2 is accepted only after the evidence is reviewed and you record the acceptance wording. G2 acceptance
does not authorize G3 execution, G7 or G8.
