# Increment B — G3 Case A Execution Procedure (Hardened, Review-Only)

| Field                        | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document ID                  | P4-B-G3-02                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Version                      | 1.2.1 (documentation clarifications from the independent review, 2026-11-19 — **execution script logic identical to 1.2**)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Change summary (v1.2.1)      | Independent review (`docs/G3-V1.2-FINAL-INDEPENDENT-REVIEW.md`): §3.2 text aligned with the v1.2 printable-ASCII rule and a URL-safe password recommendation added; §4.1 backtick statement corrected; script header comment says v1.2; new §6.1 exact read-only privilege verification (SELECT only, order-independent comparison, offline-tested with a fake client); §8 notes on `MYSQL_PWD` and stream reading. No change to SQL, scope, privileges or the Phase 1/3 script logic.                                                                                                                                                                                                                                                              |
| Date                         | 2026-11-18 (v1.1) · 2026-11-19 (v1.2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Change summary (v1.2)        | Offline dummy-string test (node reading stdin, no MySQL) showed the Phase 3 stdin bytes depend on the host: `$OutputEncoding` selects the character encoding (Windows PowerShell 5.1 default ASCII → non-ASCII characters silently become `?`), and on a UTF-8 console code page .NET prefixes a **BOM** taken from `[Console]::InputEncoding` regardless of `$OutputEncoding`. Fixes: (1) both `[Console]::InputEncoding` and `$OutputEncoding` pinned to UTF-8 **without BOM** around the Phase 3 pipe only and restored in `finally` (verified offline: exact bytes, no BOM); (2) migrator password restricted to **printable ASCII** (fail-closed STOP otherwise); (3) `$execExit` initialised before `try`. No SQL, scope or privilege change. |
| Status                       | **PROCEDURE HARDENED — NOT EXECUTED · G3 NOT ACCEPTED · AWAITING INDEPENDENT HUMAN REVIEW**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Change summary (v1.1)        | Replaced object-dependent PREPARE/EXECUTE sentinel (non-existent table) with **object-independent syntax-error sentinel**; corrected PowerShell 5.1 Phase 1 capture to **true separate stdout/stderr** via .NET `Process` (removed inaccurate `2>&1` merge/classification claim); documented PS↔SQL quoting/escaping transformations; strengthened exact privilege-set verification; preserved fail-closed boundaries/no-execution rules.                                                                                                                                                                                                                                                                                                           |
| Supersedes (execution steps) | Unsafe/insufficient inline account-creation steps previously shown in `INCREMENT-B-G3-MIGRATION-CONNECTION.md` §4.1–4.2 and `INCREMENT-B-IMPLEMENTATION-PLAN.md` §7 (e.g. `CREATE USER IF NOT EXISTS`, `FLUSH PRIVILEGES`, no fail-closed SQL-mode gate, no strict precondition parsing, no stdin/TTY-safe execution path). Prior **object-dependent** sentinel forms are superseded and must not be used. Non-executable historical records may remain elsewhere but are not authoritative.                                                                                                                                                                                                                                                        |
| Authoritative for            | **G3 Case A (privileged, user-executed, separately authorized):** create `ecommerce_migrator@localhost` and grant the exact approved privileges on `ecommerce_dev.*` only, after mandatory fresh read-only preconditions and a fail-closed execution-session SQL-mode gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Related                      | `INCREMENT-B-G3-MIGRATION-CONNECTION.md` (P4-B-G3-01), `INCREMENT-B-G2-G3-EVIDENCE-CHECKLIST.md` (P4-B-EVID-01), `INCREMENT-B-IMPLEMENTATION-PLAN.md`, `INCREMENT-B-G7-READINESS-REVIEW.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## 0. Absolute boundary (no execution by agent/tooling)

This document is **documentation and offline-reviewed procedure only**. It does **not** authorize, perform, or request execution.

- **MUST NOT (under this document/review):** execute SQL; connect to MySQL for testing; create/alter/drop/lock/modify any MySQL account, database, schema, table, grant, or privilege; run migrations/`prisma migrate deploy`/`prisma db push`/seeds/db writes; modify `.env` or `.env.migration`; request/collect/print/store real passwords; execute this PowerShell procedure; run G2/G7/G8; start B1–B9; perform Git ops; deploy; mark G3 accepted or Phase 4 complete/approved.
- **Privileged execution (if ever performed):** only by the user, manually, locally, after **separate explicit approval** naming this exact operation/scope, with fresh read-only preconditions satisfied and post-execution read-only evidence reviewed. **G3 acceptance does not authorize G7 or G8.**

## 1. Purpose, scope, and exact privilege target

**Purpose:** prepare the dedicated migration identity for later, separately authorized migration gates while preserving least privilege and runtime isolation.

| Item                      | Value                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Account                   | `'ecommerce_migrator'@'localhost'`                                                                                                                                                                                                                                                                                                                                             |
| Schema scope              | `` `ecommerce_dev`.* `` **only**                                                                                                                                                                                                                                                                                                                                               |
| Exact intended privileges | `SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES, CREATE TEMPORARY TABLES, LOCK TABLES`                                                                                                                                                                                                                                                                 |
| Explicitly prohibited     | Global/`*.*`; `GRANT OPTION`; `FILE`, `PROCESS`, `SUPER`, `RELOAD`, `SHUTDOWN`, replication privileges; `CREATE USER`; `CREATE DATABASE`/rights to create DBs; `TRIGGER`, `EVENT`, `EXECUTE`/routine privileges; any other schema (including `ecommerce_migrate_test`, `ecommerce_restore_check`); any scratch grant (G7, separate/later); any modification to `ecommerce_app` |
| `FLUSH PRIVILEGES`        | **Not used** (unnecessary for statement-based `CREATE USER`/`GRANT` in MySQL 8.4; avoid extra privileged op)                                                                                                                                                                                                                                                                   |
| Runtime account           | `ecommerce_app@localhost` must remain **unchanged** (DML on `` `ecommerce_dev`.* `` only, `IS_GRANTABLE=NO`)                                                                                                                                                                                                                                                                   |

**G3 Case A precondition (historical evidence, 2026-11-18 21:11:15, read-only):** `ecommerce_dev` exists (`utf8mb4`/`utf8mb4_0900_ai_ci`), `ecommerce_migrator@localhost` absent, `ecommerce_app` scoped correctly. **Historical observations do not replace** the mandatory fresh read-only precondition immediately before execution.

## 2. Mandatory fresh read-only preconditions (fail-closed, immediately before execution)

Preconditions are checked in a **read-only** session (Phase 1) and must **all** pass. Any failure/ambiguity => **STOP, no `CREATE USER`, no `GRANT`**.

| Check                              | Required                                                                                                                                  | On failure                                                  |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Client/connection                  | `mysql.exe` present; command exit `0`; **stderr empty** (separately captured)                                                             | STOP                                                        |
| Output shape                       | **Exactly 3 stdout lines** (db count, migrator count, `@@SESSION.sql_mode`)                                                               | STOP                                                        |
| Database baseline                  | Line 1 == `1` for: `SCHEMA_NAME='ecommerce_dev' AND DEFAULT_CHARACTER_SET_NAME='utf8mb4' AND DEFAULT_COLLATION_NAME='utf8mb4_0900_ai_ci'` | STOP (missing or differs from approved baseline)            |
| Migration account                  | Line 2 == `0` for `User='ecommerce_migrator' AND Host='localhost'`                                                                        | STOP — **never auto-modify an unexpected/existing account** |
| SQL mode capture                   | Line 3 is a single unambiguous line (may be empty) representing `@@SESSION.sql_mode`                                                      | STOP if missing/extra/malformed                             |
| Any warning/extra/malformed output | No stderr output; no unexpected line count/format                                                                                         | STOP                                                        |

Stdout and stderr are captured via **separate redirected streams** (.NET `ProcessStartInfo.RedirectStandardOutput/RedirectStandardError`, `UseShellExecute=false`), not merged.

## 3. Execution-session SQL-mode normalization and fail-closed gate (same session, before `CREATE USER`)

**Rationale:** password literal escaping depends on whether `NO_BACKSLASH_ESCAPES` is active. A cross-connection mode capture is unsafe. The execution session must **enforce, verify, and gate** mode in the **same connection** and **before** any account-management statement.

### 3.1 Normalization (exact delimited token removal)

1. Read `@@SESSION.sql_mode` in the **execution session**.
2. Remove `NO_BACKSLASH_ESCAPES` as an **exact comma-delimited token** (not substring): wrap with commas, replace `,NO_BACKSLASH_ESCAPES,` with `,`, trim edge commas.
3. `SET SESSION sql_mode = @m;` (invalid result => SQL error => batch stops).

Single logical delimited-token removal (no iterative comma-replacement loop). For a well-formed mode string the token appears at most once; if a malformed duplicate were to remain, the verification gate below must fail closed.

### 3.2 Escaping aligned to verified mode

- Gate requires `NO_BACKSLASH_ESCAPES` **absent** in active `@@SESSION.sql_mode`.
- Under that mode, escape password for a single-quoted literal by: `\` → `\\`, `'` → `''` (applied in-memory; no echo/file/arg). Since v1.2 the password must be **non-empty printable ASCII** (`\x20`–`\x7E`); empty values, control characters and any non-ASCII character are **rejected** (fail-closed) before SQL construction.
- **Recommended character set (v1.2.1):** the same password is later placed in `MIGRATION_DATABASE_URL`. Prefer letters, digits and `- _ . ~` only (no URL encoding needed). Any other character must be **percent-encoded** in the URL (`encodeURIComponent`); unencoded `#`, `/`, `?` make the URL unparseable and the migration guard refuses to run (verified offline, `tests/unit/core/migrationTargetEncoding.test.ts`).

### 3.3 Fail-closed in-session verification gate (object-independent, syntax-error sentinel)

After `SET SESSION sql_mode = @m;` and **before** `CREATE USER`, run a conditional `PREPARE/EXECUTE` in the **same session**:

- **Good branch** (`LOCATE('NO_BACKSLASH_ESCAPES', @@SESSION.sql_mode)=0`): prepare/execute a harmless valid statement: `SELECT 'MODE_OK' AS mode_check`.
- **Bad branch**: prepare/execute **deliberately malformed SQL syntax**: `SELECT 'G3_STOP_NO_BACKSLASH_ESCAPES' FROM` (incomplete `SELECT ... FROM` with no table reference) — **independent of database objects, schemas, tables, permissions, or existing names**.

**Why this is fail-closed (MySQL 8.4 semantics; not live-validated):**

1. **PREPARE rejects syntax errors:** `PREPARE` parses/checks the statement text; an incomplete/invalid `SELECT ... FROM` is a syntax/parse error (e.g. ER_PARSE_ERROR) detected at **PREPARE** time.
2. **EXECUTE not reached on bad branch:** if `PREPARE` fails, the prepared statement is not validly created for successful execution in that path; the batch error occurs at/with `PREPARE`.
3. **Batch stops by default:** the `mysql` client in batch/stdin mode stops on the **first error** by default. `--force` is **prohibited**. Therefore a bad-branch syntax error stops the batch.
4. **Unreachable statements:** `DEALLOCATE`, `CREATE USER`, and `GRANT` (and any subsequent statements) are **not reached** after the bad-branch error.
5. **PowerShell handling:** Phase 3 does not parse execution stdout/stderr for success; it checks `$LASTEXITCODE` **immediately** after the native `mysql` invocation and treats any non-zero exit as **STOP** (no success claim, no retry). The PowerShell pipeline does not override the MySQL client’s own stop-on-error behavior.
6. **Client options:** safety assumes default client behavior; no `--force` and no option overriding stop-on-error is permitted.

The gate evaluates the **active** session mode post-SET in the same session. It does not rely on empty result sets, `check_constraint_checks`, division-by-zero behavior, or existence/non-existence of database objects. (A `HAVING COUNT(*)=1`/empty-result pattern and any object-dependent sentinel are **prohibited**.)

> **CHECK alternative (evaluated, not used):** a `CHECK (ok=1)` violating `INSERT` raises ER 3819 in MySQL 8.0.16+/8.4 and stops a default batch when enforced, but can fail open if `check_constraint_checks` is OFF; not dependency-free.

## 4. Exact SQL payload (execution session, in order)

```sql
-- (A) Normalize and enforce session SQL mode (exact comma-delimited token removal)
SET @m = @@SESSION.sql_mode;
SET @m = CONCAT(',', @m, ',');
SET @m = REPLACE(@m, ',NO_BACKSLASH_ESCAPES,', ',');
SET @m = TRIM(BOTH ',' FROM @m);
SET SESSION sql_mode = @m;

-- (B) Fail-closed gate (object-independent syntax error if NO_BACKSLASH_ESCAPES remains)
SET @__g3_mode_gate_sql = IF(
  LOCATE('NO_BACKSLASH_ESCAPES', @@SESSION.sql_mode) = 0,
  'SELECT ''MODE_OK'' AS mode_check',
  'SELECT ''G3_STOP_NO_BACKSLASH_ESCAPES'' FROM'
);
PREPARE __g3_mode_gate_stmt FROM @__g3_mode_gate_sql;
EXECUTE __g3_mode_gate_stmt;
DEALLOCATE PREPARE __g3_mode_gate_stmt;
SET @__g3_mode_gate_sql = NULL;

-- (C) Account + exact scoped grant (NO IF NOT EXISTS; fails on existing/race; no FLUSH PRIVILEGES)
CREATE USER 'ecommerce_migrator'@'localhost' IDENTIFIED BY '<password_escaped_for_verified_mode>';
GRANT SELECT, INSERT, UPDATE, DELETE,
      CREATE, ALTER, DROP, INDEX, REFERENCES,
      CREATE TEMPORARY TABLES, LOCK TABLES
ON `ecommerce_dev`.* TO 'ecommerce_migrator'@'localhost';
```

### 4.1 PowerShell ↔ SQL quoting/escaping transformations (explicit)

- **PowerShell string construction (execution payload):** the payload is built by concatenating **double-quoted** PowerShell string fragments and variables. In PowerShell double-quoted strings, `$` and `` ` `` are special; single quotes are literal characters. The mode/gate SQL contains no PowerShell variable expansions and no backtick characters. The only backticks are the MySQL identifier quotes of the `GRANT` target, written as doubled backticks inside the double-quoted PowerShell string (see "Identifiers" below); the only concatenated value is the escaped password.
- **MySQL string literals inside SQL:** single quotes within a MySQL string literal are escaped by doubling: `''` (e.g. `'SELECT ''MODE_OK'' AS mode_check'` represents the SQL string value `SELECT 'MODE_OK' AS mode_check`). The bad branch `'SELECT ''G3_STOP_NO_BACKSLASH_ESCAPES'' FROM'` represents `SELECT 'G3_STOP_NO_BACKSLASH_ESCAPES' FROM` (syntactically incomplete).
- **Resulting SQL (gate):** PowerShell source `"  'SELECT ''MODE_OK'' AS mode_check',"` → PS string contains two single-quote chars around `MODE_OK` → emitted to MySQL as `''MODE_OK''` inside the outer SQL string literal (correct). No MySQL backtick identifiers are used in the gate, so no PowerShell backtick escaping is required.
- **Password literal:** after the gate verifies `NO_BACKSLASH_ESCAPES` is absent, the password is escaped in-memory as `\`→`\\` and `'`→`''` and inserted between single quotes in the `CREATE USER` statement (`$stmtCreate = "CREATE USER ... IDENTIFIED BY '" + $escaped + "';"`). The value is not otherwise reinterpreted by PowerShell (concatenation of string values).
- **Identifiers:** MySQL identifiers in statements use backticks in SQL (e.g. `` `ecommerce_dev` ``); in PowerShell double-quoted strings a literal backtick is written as two backticks (` `` `). The procedure uses this where needed (e.g. grant target).

## 5. Exact PowerShell 5.1 procedure (Windows, MySQL 8.4) — manual, user-executed only if separately approved

> **Do not run without separate explicit approval of this exact operation/scope.** Run in a local PowerShell 5.1 console with transcription off. No transcript, no file writes of secrets, no sharing of passwords.

```powershell
# === G3 CASE A (v1.2) — MANUAL / PRIVILEGED — DO NOT RUN WITHOUT SEPARATE EXPLICIT APPROVAL ===
# Fresh read-only precondition mandatory immediately before execution. Fail-closed on any ambiguity.
# Single execution session: enforce+verify SQL mode (object-independent syntax-error gate), then CREATE USER (no IF NOT EXISTS), then GRANT on ecommerce_dev.* only.
# No FLUSH PRIVILEGES. No --force. No automatic modification/retry. No files written. No secrets echoed.

$ErrorActionPreference = 'Continue'
$mysql    = 'C:\Program Files\MySQL\MySQL Server 8.4\bin\mysql.exe'
$admin    = 'root'      # local MySQL admin user name
$hostName = '127.0.0.1'
$port     = '3306'
# v1.2: deterministic stdin bytes for the Phase 3 pipe — UTF-8 without BOM. $OutputEncoding picks the
# character encoding (PS 5.1 default ASCII = lossy); [Console]::InputEncoding decides whether .NET writes a
# BOM first (it does on UTF-8 console hosts). Both are pinned only around the pipe in Phase 3.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Redact-Admin([string]$s) {
  if ($null -eq $s) { return '' }
  return ([string]$s -replace "(?i)Access denied for user '[^']*'@", "Access denied for user '<redacted>'@")
}

if (-not (Test-Path -LiteralPath $mysql)) { Write-Host 'STOP: mysql client not found.' -ForegroundColor Red; return }

# --- PHASE 1 (read-only, connection 1): mandatory precondition ---
# -e with interactive -p (no stdin SQL). stdout/stderr captured via SEPARATE redirected streams (.NET Process).
# RedirectStandardInput=false so the child may use the console for the interactive -p prompt (environment-dependent).
$preSql = @(
  "SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='ecommerce_dev' AND DEFAULT_CHARACTER_SET_NAME='utf8mb4' AND DEFAULT_COLLATION_NAME='utf8mb4_0900_ai_ci';"
  "SELECT COUNT(*) FROM mysql.user WHERE User='ecommerce_migrator' AND Host='localhost';"
  "SELECT @@SESSION.sql_mode;"
) -join ' '

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $mysql
$psi.Arguments = "--protocol=TCP -h $hostName -P $port -u $admin -p -N -B -e `"$preSql`""
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.RedirectStandardInput = $false
$psi.CreateNoWindow = $false
$p = New-Object System.Diagnostics.Process
$p.StartInfo = $psi
[void]$p.Start()
$stdoutText = $p.StandardOutput.ReadToEnd()
$stderrText = $p.StandardError.ReadToEnd()
$p.WaitForExit()
$preExit = $p.ExitCode

$stdoutLines = @()
if ($stdoutText.Length -gt 0) { $stdoutLines = @($stdoutText -split "`r?`n") }
if ($stdoutLines.Count -gt 0 -and $stdoutLines[$stdoutLines.Count - 1] -eq '') { $stdoutLines = @($stdoutLines[0..($stdoutLines.Count - 2)]) }
$stderrLines = @()
if ($stderrText.Trim().Length -gt 0) { $stderrLines = @(($stderrText -split "`r?`n") | ForEach-Object { Redact-Admin $_ } | Where-Object { $_ -ne '' }) }

$preOk = $true; $reason = $null
if ($preExit -ne 0) { $preOk = $false; $reason = "precondition command failed (exit=$preExit)" }
elseif ($stderrLines.Count -ne 0) { $preOk = $false; $reason = "stderr output present ($($stderrLines.Count) line(s))" }
elseif ($stdoutLines.Count -ne 3) { $preOk = $false; $reason = "expected exactly 3 stdout lines, got $($stdoutLines.Count)" }
else {
  $dbCount  = $stdoutLines[0].Trim()
  $migCount = $stdoutLines[1].Trim()
  # $stdoutLines[2] = @@SESSION.sql_mode (single unambiguous line; may be empty)
  if ($dbCount -notmatch '^\d+$' -or $migCount -notmatch '^\d+$') { $preOk = $false; $reason = 'non-numeric or malformed count value(s)' }
  elseif ($dbCount -ne '1') { $preOk = $false; $reason = "database baseline check failed (expected 1, got $dbCount): missing or charset/collation differs from utf8mb4/utf8mb4_0900_ai_ci" }
  elseif ($migCount -ne '0') { $preOk = $false; $reason = "migrator account check failed (expected 0, got $migCount): ecommerce_migrator@localhost exists — never auto-modify" }
}
if (-not $preOk) {
  Write-Host "STOP: precondition not satisfied ($reason). No CREATE USER/GRANT executed. No changes made." -ForegroundColor Red
  if ($stderrLines.Count -gt 0) { $stderrLines | ForEach-Object { Write-Host $_ } }
  return
}
Write-Host 'PRECONDITION PASS: ecommerce_dev baseline OK (utf8mb4/utf8mb4_0900_ai_ci), ecommerce_migrator@localhost absent, mode captured (3 stdout lines, 0 stderr, exit 0).' -ForegroundColor Cyan

# --- PHASE 2: migrator password (hidden, in-memory; fail-closed on empty/control chars) ---
$secure = Read-Host 'New password for ecommerce_migrator@localhost (input hidden)' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $migPw = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr); $bstr = [IntPtr]::Zero }
if ([string]::IsNullOrEmpty($migPw) -or ($migPw -cmatch '[^\x20-\x7E]')) {
  $migPw = $null; $secure = $null; Remove-Variable migPw,secure -ErrorAction SilentlyContinue
  Write-Host 'STOP: password must be non-empty printable ASCII (no control or non-ASCII characters). No changes made.' -ForegroundColor Red
  return
}
# Escaping for verified session mode (NO_BACKSLASH_ESCAPES removed & gated): \ -> \\ and ' -> ''
$escaped = $migPw.Replace('\', '\\').Replace("'", "''")

# --- PHASE 3 (execution, connection 2): single session — normalize+set+verify mode, then CREATE USER, then GRANT ---
# SQL via stdin (no CLI arg). No -p (avoids stdin/TTY conflict). Admin auth via short-lived MYSQL_PWD (cleared in finally).
$modeAndGate = @(
  "SET @m = @@SESSION.sql_mode;"
  "SET @m = CONCAT(',', @m, ',');"
  "SET @m = REPLACE(@m, ',NO_BACKSLASH_ESCAPES,', ',');"
  "SET @m = TRIM(BOTH ',' FROM @m);"
  "SET SESSION sql_mode = @m;"
  "SET @__g3_mode_gate_sql = IF(LOCATE('NO_BACKSLASH_ESCAPES', @@SESSION.sql_mode) = 0, 'SELECT ''MODE_OK'' AS mode_check', 'SELECT ''G3_STOP_NO_BACKSLASH_ESCAPES'' FROM');"
  "PREPARE __g3_mode_gate_stmt FROM @__g3_mode_gate_sql;"
  "EXECUTE __g3_mode_gate_stmt;"
  "DEALLOCATE PREPARE __g3_mode_gate_stmt;"
  "SET @__g3_mode_gate_sql = NULL;"
) -join "`n"
$stmtCreate = "CREATE USER 'ecommerce_migrator'@'localhost' IDENTIFIED BY '" + $escaped + "';"
$stmtGrant  = "GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES, CREATE TEMPORARY TABLES, LOCK TABLES ON ``ecommerce_dev``.* TO 'ecommerce_migrator'@'localhost';"
$sql = $modeAndGate + "`n" + $stmtCreate + "`n" + $stmtGrant

$adminSecure = $null; $abstr = [IntPtr]::Zero; $execExit = $null
$prevInputEncoding = [Console]::InputEncoding; $prevOutputEncoding = $OutputEncoding
try {
  $adminSecure = Read-Host "MySQL admin password for execution connection (input hidden)" -AsSecureString
  $abstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($adminSecure)
  $env:MYSQL_PWD = [Runtime.InteropServices.Marshal]::PtrToStringAuto($abstr)
  # v1.2: pin stdin to UTF-8 without BOM for the pipe only (restored in finally).
  [Console]::InputEncoding = $utf8NoBom
  $OutputEncoding = $utf8NoBom
  # stdin carries SQL only. mysql stops on first error by default (no --force).
  $sql | & $mysql --protocol=TCP -h $hostName -P $port -u $admin -N -B
  $execExit = $LASTEXITCODE
}
finally {
  [Console]::InputEncoding = $prevInputEncoding; $OutputEncoding = $prevOutputEncoding
  Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue
  $env:MYSQL_PWD = $null
  if ($abstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($abstr) }
  $adminSecure = $null; $abstr = [IntPtr]::Zero
}

# Immediate cleanup (best-effort; .NET strings immutable)
$sql = $null; $modeAndGate = $null; $stmtCreate = $null; $stmtGrant = $null; $escaped = $null; $migPw = $null; $secure = $null
Remove-Variable sql,modeAndGate,stmtCreate,stmtGrant,escaped,migPw,secure,adminSecure,stdoutText,stderrText,stdoutLines,stderrLines,p,psi,raw -ErrorAction SilentlyContinue

if ($execExit -eq 0) {
  Write-Host 'EXECUTION_EXIT=0. Single-session mode normalization+verification gate passed before CREATE USER/GRANT. No FLUSH PRIVILEGES. No .env.migration created.' -ForegroundColor Green
  Write-Host 'NEXT (only if separately approved/executed): run read-only verification for Steps 4-6 before any further action.' -ForegroundColor Cyan
} else {
  Write-Host "STOP: EXECUTION_EXIT=$execExit. Batch stopped on first error (mode gate failure, CREATE USER failure/race, or other error). Partial state possible (or none). Do NOT retry blindly or broaden scope. Run read-only verification (Steps 4-6) before any further action." -ForegroundColor Red
}
```

**Execution-phase output handling:** Phase 3 does not redirect stdout/stderr; any client output appears on the console. Correctness/safety relies on (a) the fail-closed SQL gate and batch stop-on-first-error, and (b) immediate `$LASTEXITCODE` capture with **any non-zero exit treated as STOP** (no success claim, no retry). Unexpected console output does not by itself imply success.

## 6. Privilege-scope verification design (read-only, post-execution evidence)

Verification must compare the **complete actual privilege set** with the **approved set** and reject missing, unexpected, or mis-scoped privileges (not only presence of expected ones). Use redacted read-only evidence (SELECT/SHOW only).

| Check                                                                             | Expected (PASS — complete match)                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity                                                                          | `ecommerce_migrator@localhost` exists with reported auth plugin                                                                                                                                                                                          |
| `SHOW GRANTS` (migrator, redacted)                                                | `USAGE ON *.*` + **exactly one** schema grant: the approved privilege list on `` `ecommerce_dev`.* `` only; no `GRANT OPTION`, no other schema/database (incl. `ecommerce_migrate_test`, `ecommerce_restore_check`), no global privileges beyond `USAGE` |
| `information_schema.USER_PRIVILEGES` (migrator)                                   | **Exact set:** `{USAGE}` with `IS_GRANTABLE='NO'` only (no additional global privilege types)                                                                                                                                                            |
| `information_schema.SCHEMA_PRIVILEGES` (migrator, `TABLE_SCHEMA='ecommerce_dev'`) | **Exact privilege-type set (no missing, no extra):** `{SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES, CREATE TEMPORARY TABLES, LOCK TABLES}` with `IS_GRANTABLE='NO'` for all                                                   |
| `information_schema.SCHEMA_PRIVILEGES` (migrator, other schemas)                  | **Empty set** for any `TABLE_SCHEMA <> 'ecommerce_dev'` (no scratch/restore/unrelated grants)                                                                                                                                                            |
| `ecommerce_app@localhost`                                                         | **Unchanged:** exact DML set `{SELECT, INSERT, UPDATE, DELETE}` on `` `ecommerce_dev`.* `` only, `IS_GRANTABLE='NO'`; global only `USAGE`; no DDL, no other schema, no `GRANT OPTION`                                                                    |
| `.env` / `.env.migration`                                                         | `.env.migration` not created prematurely by this step; runtime `.env` untouched; no migration credential in runtime config                                                                                                                               |

**Rejection conditions:** any missing expected privilege; any unexpected additional privilege (including but not limited to global beyond `USAGE`, `GRANT OPTION`, `FILE`, `PROCESS`, `SUPER`, `RELOAD`, `SHUTDOWN`, replication, `CREATE USER`, `CREATE DATABASE`-equivalent/global, `TRIGGER`, `EVENT`, `EXECUTE`/routines); any other-schema or scratch-schema grant; or any change to `ecommerce_app`. Rejection requires STOP and separate reviewed/approved corrective action (no automatic correction).

### 6.1 Exact read-only verification (v1.2.1 — SELECT only, user-run after Case A)

Runs only `SELECT` statements (no `GRANT`, `REVOKE`, `ALTER`, `DROP`, no writes). Each identity's complete
privilege picture — global, schema, table, column, routine, role and proxy grants — is compared with the
exact approved set; the comparison is order-independent (`Compare-Object`). **Not live-validated.** If the
query errors, STOP and report (do not edit the query to make it pass).

```powershell
$mysql    = 'C:\Program Files\MySQL\MySQL Server 8.4\bin\mysql.exe'
$admin    = 'root'
function Get-G3PrivilegePicture([string]$user) {
    if ($user -notin @('ecommerce_migrator', 'ecommerce_app')) { throw 'Unexpected identity.' }
    $grantee = "'''$user''@''localhost'''"
    $sql = @"
SELECT CONCAT('U|', PRIVILEGE_TYPE, '|', IS_GRANTABLE) FROM information_schema.USER_PRIVILEGES WHERE GRANTEE = $grantee;
SELECT CONCAT('S|', TABLE_SCHEMA, '|', PRIVILEGE_TYPE, '|', IS_GRANTABLE) FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE = $grantee;
SELECT CONCAT('T|', COUNT(*)) FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE = $grantee;
SELECT CONCAT('C|', COUNT(*)) FROM information_schema.COLUMN_PRIVILEGES WHERE GRANTEE = $grantee;
SELECT CONCAT('R|', COUNT(*)) FROM mysql.procs_priv WHERE User = '$user' AND Host = 'localhost';
SELECT CONCAT('ROLE|', COUNT(*)) FROM mysql.role_edges WHERE TO_USER = '$user' AND TO_HOST = 'localhost';
SELECT CONCAT('PROXY|', COUNT(*)) FROM mysql.proxies_priv WHERE User = '$user' AND Host = 'localhost';
"@
    $out = & $mysql --protocol=TCP -h 127.0.0.1 -P 3306 -u $admin -p -N -B -e $sql
    if ($LASTEXITCODE -ne 0) { throw "STOP: verification query failed for $user (exit $LASTEXITCODE)." }
    return @($out | Where-Object { $_ -ne '' })
}

$expectedMigrator = @(
  'U|USAGE|NO',
  'S|ecommerce_dev|ALTER|NO', 'S|ecommerce_dev|CREATE|NO', 'S|ecommerce_dev|CREATE TEMPORARY TABLES|NO',
  'S|ecommerce_dev|DELETE|NO', 'S|ecommerce_dev|DROP|NO', 'S|ecommerce_dev|INDEX|NO',
  'S|ecommerce_dev|INSERT|NO', 'S|ecommerce_dev|LOCK TABLES|NO', 'S|ecommerce_dev|REFERENCES|NO',
  'S|ecommerce_dev|SELECT|NO', 'S|ecommerce_dev|UPDATE|NO',
  'T|0', 'C|0', 'R|0', 'ROLE|0', 'PROXY|0'
)
$expectedApp = @(
  'U|USAGE|NO',
  'S|ecommerce_dev|DELETE|NO', 'S|ecommerce_dev|INSERT|NO', 'S|ecommerce_dev|SELECT|NO', 'S|ecommerce_dev|UPDATE|NO',
  'T|0', 'C|0', 'R|0', 'ROLE|0', 'PROXY|0'
)

foreach ($pair in @(@('ecommerce_migrator', $expectedMigrator), @('ecommerce_app', $expectedApp))) {
    $actual = Get-G3PrivilegePicture $pair[0]
    $diff = Compare-Object -ReferenceObject $pair[1] -DifferenceObject $actual
    if ($diff) {
        "REJECT: $($pair[0]) privilege set differs from the approved set:"
        $diff | ForEach-Object { "  $($_.SideIndicator) $($_.InputObject)" }   # <= missing  => unexpected
        throw 'STOP: G3 privilege verification failed. No corrective action without separate approval.'
    }
    "PASS: $($pair[0]) privilege set exactly matches the approved set."
}
```

The output contains privilege names only — no authentication string — so it can be pasted into the
evidence checklist (G3-05/G3-06/G3-07) as is. `SHOW GRANTS` may still be captured for G3-05, with the
`IDENTIFIED WITH … AS …` clause removed.

## 7. Partial-failure and recovery (no automatic cleanup or retry)

| Case                                                    | What may have changed                                                | Must not assume                                     | Required read-only evidence                                                                                   | New approval required?                    | Prohibited until reviewed                                                                            |
| ------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **A. Precondition fails**                               | None (no privileged statement executed)                              | That state matches historical evidence              | Fresh read-only precondition/evidence showing actual state                                                    | No privileged op approved/performed       | Any `CREATE USER`/`GRANT`/`ALTER`/`REVOKE`/retry                                                     |
| **B. SQL-mode gate fails**                              | None to accounts/grants (batch stopped before `CREATE USER`)         | That mode/environment is safe                       | Execution exit/output (redacted), fresh read-only account/grant state                                         | Yes, for any corrected re-attempt         | Blind retry; changing scope; privilege broadening                                                    |
| **C. CREATE USER fails (account already exists/race)**  | None (statement failed; `GRANT` not reached)                         | That account is safe/expected or has correct grants | Read-only: identity existence, auth plugin, exact grants, schema/global privileges, `ecommerce_app` unchanged | Yes, for any corrective privileged action | Automatic `ALTER USER`/`DROP USER`/`GRANT`; auto-modification of unexpected account                  |
| **D. CREATE USER succeeds, GRANT fails**                | `ecommerce_migrator@localhost` may exist with missing/partial grants | That grants are correct or absent                   | Read-only: full identity + `SHOW GRANTS` + schema/global privileges; confirm no unintended scope              | Yes, for any corrective action            | Blind retry; widening scope/schemas/privileges; touching `ecommerce_app` or `ecommerce_migrate_test` |
| **E. Client exits unexpectedly**                        | Unknown (possibly none, possibly partial)                            | Success or failure                                  | Fresh read-only verification of all relevant objects/grants                                                   | Yes, before any further privileged action | Any retry or corrective change without evidence                                                      |
| **F. Connection drops after CREATE USER, before GRANT** | Account may exist without intended grants (same as D)                | Completion                                          | Read-only: identity/grants/schema/global scope                                                                | Yes                                       | Blind retry; automatic cleanup; broadening                                                           |
| **G. Ambiguous result**                                 | Unknown                                                              | Any outcome                                         | Full fresh read-only evidence set; do not infer from exit code alone                                          | Yes                                       | Any privileged action until independently reviewed                                                   |

**Principles:** no automatic cleanup, no automatic retry, no automatic `DROP USER`, no automatic grant correction. Any corrective privileged action requires a separate explicit user decision and, where applicable, a separately reviewed procedure.

## 8. Security limitations (must be understood; not live-proven)

- **No live-execution proof:** offline/static/dummy tests do **not** prove live MySQL execution safety, server parsing/PREPARE behavior under all configurations, client TTY/encoding behavior on the target host, race timing, or partial-commit outcomes.
- **Fail-closed gate:** relies on MySQL `PREPARE` rejecting malformed SQL (syntax error) and on `mysql` default stop-on-first-error (no `--force`). If client behavior/options differ, safety is reduced.
- **Normalization:** exact delimited-token removal is deterministic for well-formed mode strings; a malformed duplicate leaving `NO_BACKSLASH_ESCAPES` should be caught by the post-SET gate (fail-closed). Universal validity of every exotic mode value is not formally provable; `SET SESSION sql_mode` failure is fail-closed.
- **Password handling:** empty, control and non-ASCII characters rejected (v1.2: printable ASCII only, so the bytes are identical in every client/connection charset). `'` and `\` escaped for the verified (no-backslash-escapes-removed) session. The Phase 3 stdin encoding is pinned to UTF-8 without BOM via `[Console]::InputEncoding` + `$OutputEncoding` (v1.2, restored afterwards); the offline test (2026-11-19) showed that without pinning, PS 5.1 hosts send ASCII (lossy) and/or prefix a UTF-8 BOM depending on host configuration. Whether the `mysql` 8.4 client would have tolerated a leading BOM was **not** live-tested and is no longer relied on.
- **Streams/TTY:** Phase 1 uses separate stdout/stderr capture via .NET Process with `RedirectStandardInput=false` to allow interactive `-p` prompt — this console-interaction behavior is environment-dependent and not live-validated. Phase 3 output is not captured (exit code governs). Phase 1 reads stdout to the end before stderr; with the three short result lines expected this cannot fill a pipe buffer, but an unexpectedly large stderr could block the read — if the window hangs, close it: nothing privileged has run yet (Phase 1 is read-only).
- **`MYSQL_PWD` (v1.2.1 note):** MySQL documents this variable as insecure and deprecated. If the 8.4 client on the host ignores it, the Phase 3 connection is refused (`Access denied`), the exit code is non-zero and the procedure STOPs before any statement runs — fail-closed, but it must be confirmed during the approved run, not assumed.
- **Secrets in memory/env:** BSTR zeroed and variables cleared (best-effort); .NET strings are immutable/GC-managed and not guaranteed wipeable. Execution uses short-lived `MYSQL_PWD` for the admin child process (no CLI arg, cleared in `finally`) — process environment may be observable to same-user/privileged processes during that window.
- **Host/terminal:** transcripts, logging, screen/key capture, PSReadLine command history, malware, or forced termination can expose secrets or prevent cleanup. Cleanup after forced process/machine termination cannot be guaranteed.
- **Race window:** state can change between precondition and execution; `CREATE USER` (no `IF NOT EXISTS`) fails closed on unexpected existence, but post-execution read-only verification is mandatory.

## 9. Gate status

**G3 remains NOT ACCEPTED.** This procedure does not constitute acceptance, does not authorize execution, and does not authorize G2/G7/G8. **Phase 4 remains IN PROGRESS — NOT APPROVED.**
