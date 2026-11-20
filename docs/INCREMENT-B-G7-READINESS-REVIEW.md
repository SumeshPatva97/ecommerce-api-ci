# Increment B — G7 Readiness Review (READ-ONLY)

| Field       | Value                                                                                   |
| ----------- | --------------------------------------------------------------------------------------- |
| Document ID | P4-B-G7-01                                                                              |
| Phase       | Phase 4 — Backend Development (Increment B, Gate G7)                                    |
| Status      | **NOT READY — G7 NOT STARTED**                                                          |
| Date        | 2026-11-18                                                                              |
| Mode        | Read-only. No MySQL connection, no migration command, no database/user/grant operation. |
| Verdict     | **NOT READY**                                                                           |

> G7 requires separate explicit authorization even after every item below is satisfied. This review
> does not authorize or start the dry run.
>
> **G7 target: `ecommerce_migrate_test` only.** G7 must never connect to `ecommerce_dev`. The
> `ecommerce_dev.*` grant created at G3 is for G8; it gives no privileges on the scratch database
> (see `docs/INCREMENT-B-G3-MIGRATION-CONNECTION.md` §1.1 and §4.3).

---

## 1. Entry criteria

| #   | Criterion                                                                              | Status             | Evidence                                                                                    |
| --- | -------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------- |
| 1   | G2 backup/restore drill executed and **accepted**                                      | **FAIL**           | G2 NOT STARTED (`docs/INCREMENT-B-G2-BACKUP-RESTORE-DRILL.md`; plan §0)                     |
| 2   | G3 migration user created, `ecommerce_dev.*` grant verified, `.env.migration` in place | **FAIL**           | G3 NOT STARTED (user-managed; `docs/INCREMENT-B-G3-MIGRATION-CONNECTION.md`)                |
| 3   | Scratch database `ecommerce_migrate_test` created **manually by the user**             | **FAIL**           | Agent must never create a database; no confirmation received                                |
| 4   | Scratch database confirmed **empty**                                                   | **FAIL**           | Cannot be verified without a connection; user must confirm                                  |
| 5   | **Scratch-database grant verified** for `ecommerce_migrator`                           | **FAIL**           | Recommended temporary grant on `ecommerce_migrate_test.*` (G3 doc §4.3); not applied        |
| 6   | Migration target configuration verified                                                | **PASS (offline)** | `prisma.migration.config.ts` + guard; `prisma validate --config` PASS; mismatch FAIL-CLOSED |
| 7   | Migration SQL verified (exactly one baseline, expected content)                        | **PASS (offline)** | Single folder `20261117160425_baseline`; 1943 lines; counts below                           |
| 8   | Baseline SQL SHA-256 **independently confirmed** by the user                           | **UNCONFIRMED**    | Reference hash below; the user must recompute it on the reviewed file                       |
| 9   | G2 and G3 evidence reviewed against the checklist                                      | **FAIL**           | `docs/INCREMENT-B-G2-G3-EVIDENCE-CHECKLIST.md` (P4-B-EVID-01) — no submission yet           |
| 10  | Separate explicit G7 authorization                                                     | **FAIL**           | Not granted                                                                                 |

All ten must be satisfied before G7 can begin. Items 1–5 and 9–10 are user actions; items 6–7 are
already verified offline; item 8 needs the user's own hash.

Redaction requirement: evidence submitted for items 1, 2 and 9 must follow
`docs/INCREMENT-B-G2-G3-EVIDENCE-CHECKLIST.md` — no passwords, hashes, URLs or file contents.

---

## 2. Offline evidence that is ready

Verified in this session without any database connection:

| Check                  | Result                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prisma schema          | 67 models / 50 enums / 114 explicit `onUpdate: Restrict`                                                                                                                              |
| Baseline migration     | `prisma/migrations/20261117160425_baseline/migration.sql` — **1943 lines**                                                                                                            |
| DDL objects            | 67 `CREATE TABLE`; 75 CHECK constraints                                                                                                                                               |
| Foreign keys           | 115 FK constraints = 114 Prisma FKs + 1 SQL-only composite FK; `ON UPDATE RESTRICT` ×115; `ON DELETE` 29 CASCADE / 78 RESTRICT / 8 SET NULL (the composite accounts for one RESTRICT) |
| Migration lock         | `prisma/migrations/migration_lock.toml` → `provider = "mysql"`                                                                                                                        |
| Migration folders      | exactly one baseline: `20261117160425_baseline`                                                                                                                                       |
| Baseline SHA-256       | `154D2C8E4614609C4D8BF4879F7B1991B6DA0CCA704DAE5DEB09D53F2AB7A6BB`                                                                                                                    |
| Migration config guard | 16 unit tests; full suite 10 files / 193 tests pass                                                                                                                                   |
| Typecheck / lint       | PASS                                                                                                                                                                                  |
| Status claims          | G6 **PASS — ACCEPTED**; no document claims G7 is complete                                                                                                                             |

Any change to `schema.prisma` or `migration.sql` invalidates the hash above and the G6 acceptance for
that exact content.

---

## 3. Blockers (must be resolved by the user, in order)

1. **G2** — run and record the drill in `docs/INCREMENT-B-G2-BACKUP-RESTORE-DRILL.md`; submit the G2
   rows of `docs/INCREMENT-B-G2-G3-EVIDENCE-CHECKLIST.md`; obtain acceptance.
2. **G3** — create `ecommerce_migrator@localhost`, grant the approved list **on `ecommerce_dev.*`**
   (for G8), verify both identities with `SHOW GRANTS`, create `.env.migration` (UTF-8 no BOM) with
   `MIGRATION_EXPECTED_DATABASE=ecommerce_migrate_test`; submit the G3 rows of the same checklist.
   The G3 grant does **not** cover the scratch database.
3. **Scratch database** — create `ecommerce_migrate_test` (empty, `utf8mb4`/`utf8mb4_0900_ai_ci`) in a
   privileged session. Confirm its name and emptiness. The agent must never create or drop it.
4. **Scratch grant** — apply the **temporary, database-scoped** grant on `ecommerce_migrate_test.*` for
   `ecommerce_migrator` (recommendation and rationale in
   `docs/INCREMENT-B-G3-MIGRATION-CONNECTION.md` §4.3), then run `SHOW GRANTS` and record the redacted
   result. No `*.*`, no global privilege, no change to `ecommerce_app` or to the `ecommerce_dev` grant.
   A `MIGRATION_EXPECTED_DATABASE` value alone does not prove this grant exists.
5. **Hash confirmation** — independently recompute and confirm that the reviewed migration file still
   hashes to `154D2C8E4614609C4D8BF4879F7B1991B6DA0CCA704DAE5DEB09D53F2AB7A6BB`.
6. **Authorization** — give separate explicit approval for G7.

The scratch grant is temporary. After the G7 evidence is accepted, revoke it with the `REVOKE`
statement in the G3 document §4.3 and record the new `SHOW GRANTS` output. Revocation is required
before G8 unless the owner records a different explicit decision.

Additional open G7 probes (already documented, not blockers to start but required evidence):

- `ProductImage.variantId` direct `ON DELETE CASCADE` vs composite FK `RESTRICT` interaction on variant
  delete (risk R-16).
- REGEXP CHECK case sensitivity under `utf8mb4_0900_ai_ci` (D12).
- Generated STORED columns behave as specified; invalid data is rejected.
- `prisma migrate status` reports the baseline as applied after deploy.

---

## 4. G7 pre-flight (user-run only — NOT executed here)

Once **all ten** entry criteria are satisfied:

```powershell
cd C:\Users\sumes\OneDrive\Desktop\ecommerce-workspace\ecommerce-api

# 0. Target name check (prints only the expected-database line, never the URL)
(Get-Content .env.migration | Where-Object { $_ -match '^MIGRATION_EXPECTED_DATABASE=' })
# must print exactly: MIGRATION_EXPECTED_DATABASE=ecommerce_migrate_test

# 1. Target guard: refuses any URL/name mismatch (it does not prove privileges)
npx prisma validate --config prisma.migration.config.ts

# 2. Hash must equal 154D2C8E4614609C4D8BF4879F7B1991B6DA0CCA704DAE5DEB09D53F2AB7A6BB
Get-FileHash prisma\migrations\20261117160425_baseline\migration.sql -Algorithm SHA256

# 3. Status against the scratch database (connects to MIGRATION_EXPECTED_DATABASE only)
npm run db:migrate:status

# 4. Deploy only after 0–3 are clean and G7 is explicitly authorized
npm run db:migrate:deploy
```

Mandatory constraints during G7:

- the configured `MIGRATION_EXPECTED_DATABASE` and the URL database path must both be
  `ecommerce_migrate_test`;
- never connect to `ecommerce_dev`;
- never create/drop databases;
- abort on any target-name mismatch, unexpected pending migration, or hash mismatch;
- record actual command output (redacted) and probe outcomes;
- do not change the approved schema based on probe results without separate approval.

The offline guard validates the **name** only. It cannot detect a missing grant. If `migrate status`
reports `Access denied` for `ecommerce_migrate_test`, stop and verify the scratch grant — do **not**
repoint the target at `ecommerce_dev`.

---

## 5. G8 separation (after G7 — separate authorization)

G8 is a different gate with a different target. Do not conflate it with G7.

|                 | G7                                                 | G8                                             |
| --------------- | -------------------------------------------------- | ---------------------------------------------- |
| Target database | `ecommerce_migrate_test`                           | `ecommerce_dev`                                |
| Privilege used  | temporary `ecommerce_migrate_test.*` grant         | permanent `ecommerce_dev.*` grant from G3      |
| Scratch grant   | required                                           | must already be **revoked**                    |
| Prerequisite    | G2/G3 accepted, scratch DB empty, G7 authorization | G7 accepted, fresh G2 backup, G8 authorization |

Sequence after G7 evidence is accepted:

1. revoke the scratch grant and re-run `SHOW GRANTS` (G3 doc §4.3);
2. switch `.env.migration` to `ecommerce_dev` (URL path **and** `MIGRATION_EXPECTED_DATABASE`) —
   G3 doc §4.8;
3. offline `prisma validate --config prisma.migration.config.ts` must PASS;
4. take a fresh backup (the G2 procedure);
5. obtain separate G8 authorization, then run status/deploy.

A G8 run must never use the scratch target, and a G7 run must never use `ecommerce_dev`. The guard
stops URL/name mismatches, but phase selection is the operator's responsibility.

---

## 6. Verdict

**NOT READY.** Gate-level blockers remain: G2 and G3 are not started (their evidence checklist is
empty), the scratch database is not confirmed, its scratch-scoped grant is not applied or verified,
the baseline hash is awaiting the user's independent confirmation, and G7 authorization has not been
given. The G3 `ecommerce_dev.*` grant grants nothing on `ecommerce_migrate_test`, and the migration
config's target name is a guard, not a privilege. Migration configuration and SQL content are verified
offline only. No part of G7 has been started.
