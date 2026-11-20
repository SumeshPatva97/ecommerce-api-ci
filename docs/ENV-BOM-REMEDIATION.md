# Environment File Encoding — UTF-8 BOM Remediation

| Field       | Value                                                                         |
| ----------- | ----------------------------------------------------------------------------- |
| Document ID | P4-ENV-01                                                                     |
| Phase       | Phase 4 — Backend Development (environment/tooling)                           |
| Status      | **REFERENCE — user-executed; current `.env` has no BOM (2026-11-18 recheck)** |
| Date        | 2026-11-18                                                                    |
| Scope       | `.env` and `.env.migration` in `ecommerce-api`                                |

> The agent must not read, print, copy or modify `.env` / `.env.migration` contents. The commands
> below are for the user to run manually. They change encoding only; they do not display values.

---

## 1. Symptom

A UTF-8 BOM is the three-byte sequence `EF BB BF` at the start of a file. Node's
`process.loadEnvFile()` does not strip it, so the first variable name becomes
`\uFEFFDATABASE_URL` instead of `DATABASE_URL`. The visible effect is:

```text
PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_URL
```

even though the line looks correct in an editor. The same applies to `MIGRATION_DATABASE_URL` in
`.env.migration`, and to any tool that loads these files directly with Node.

## 2. Safe detection (no contents printed)

```powershell
$path  = (Resolve-Path -Path '.env').Path
$bytes = [System.IO.File]::ReadAllBytes($path)

$hasBom = ($bytes.Length -ge 3) -and ($bytes[0] -eq 0xEF) -and ($bytes[1] -eq 0xBB) -and ($bytes[2] -eq 0xBF)
"BOM present: $hasBom"
"size (bytes): $($bytes.Length)"
```

This prints only the boolean and the size. Repeat with `.env.migration` when that file exists.

Optional — variable **names** only (no values):

```powershell
Get-Content -Path '.env' |
  Where-Object { $_ -match '^\s*[A-Za-z_][A-Za-z0-9_]*\s*=' } |
  ForEach-Object { ($_ -split '=', 2)[0].Trim() }
```

A leading `?DATABASE_URL` (or another unexpected character) indicates a BOM.

## 3. Re-save without BOM (contents preserved)

PowerShell 5.1's `Set-Content -Encoding UTF8` writes a BOM, so do **not** use it. Use the .NET UTF-8
encoder with `emitBOM = $false`.

```powershell
$path = (Resolve-Path -Path '.env').Path

# 1. Keep a temporary backup (git-ignored via .env.*) until verification passes.
Copy-Item -Path $path -Destination ($path + '.bak-bom') -Force

# 2. ReadAllText detects and removes a BOM; line endings and values are preserved.
$text       = [System.IO.File]::ReadAllText($path)
$utf8NoBom  = New-Object System.Text.UTF8Encoding($false)

# 3. Rewrite the same file as UTF-8 without BOM.
[System.IO.File]::WriteAllText($path, $text, $utf8NoBom)
```

What this does and does not change:

- **Changes:** only the byte encoding (BOM removed; re-encoded as UTF-8 without BOM).
- **Preserves:** every variable name, value, comment, blank line and line ending.
- If the file was UTF-16, `ReadAllText` converts it to UTF-8 text; the textual content is unchanged.
- It does **not** print, log or transmit the contents.

Apply the same three lines to `.env.migration` after creating it (`Resolve-Path -Path '.env.migration'`).

## 4. Verification

```powershell
# a. No BOM (expect: BOM present: False)
$bytes  = [System.IO.File]::ReadAllBytes((Resolve-Path -Path '.env').Path)
$hasBom = ($bytes.Length -ge 3) -and ($bytes[0] -eq 0xEF) -and ($bytes[1] -eq 0xBB) -and ($bytes[2] -eq 0xBF)
"BOM present: $hasBom"

# b. Prisma can load the file (offline; no database connection)
npx prisma validate

# c. Migration config (only when .env.migration exists; still offline)
npx prisma validate --config prisma.migration.config.ts
```

`prisma validate` prints the schema path and a validity message. It does not print the URL.

After all three pass, delete the temporary backup:

```powershell
Remove-Item -Path (Join-Path (Get-Location) '.env.bak-bom') -Force
```

Do not leave backups of secret-bearing files on disk longer than necessary.

## 5. Rollback

If anything looks wrong, restore the backup before deleting it:

```powershell
Copy-Item -Path (Join-Path (Get-Location) '.env.bak-bom') -Destination (Join-Path (Get-Location) '.env') -Force
```

Then investigate rather than editing values by hand.

## 6. Current state (2026-11-18 recheck)

A byte-level check of `ecommerce-api/.env` during this review found **no BOM** (the first three bytes
are not `EF BB BF`). No change is required at this time. The procedure remains for future files and
for `.env.migration`, which does not exist yet.

## 7. Safety notes

- Never paste `.env` or `.env.migration` contents into chat, tickets, logs or reports.
- Never put a password on a command line; use interactive prompts.
- Do not edit values while fixing encoding. Re-save first, then change values deliberately if needed.
- This procedure does not connect to MySQL and does not touch any database.
