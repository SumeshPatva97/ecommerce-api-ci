# Phase 3 Schema-Change Proposal — Phase 4 Blocked Features

| Field       | Value                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Document ID | P3-SCP-01                                                                                                                                  |
| Date        | 2026-11-19                                                                                                                                 |
| Status      | **PROPOSAL — NOT APPROVED · NOT IMPLEMENTED**                                                                                              |
| Affects     | Phase 3 approved design (67 models / 50 enums), `prisma/schema.prisma`, migrations                                                         |
| Rule        | Nothing here is applied. `schema.prisma` and the baseline migration (`20261117160425_baseline`, SHA-256 `154D2C8E…A6BB`) are **unchanged** |

> Phase 3 is **APPROVED AND COMPLETE**. Each change below re-opens the approved database design and
> therefore needs **explicit owner approval** (per item) before any schema or migration edit. The DDL is
> illustrative for review only and has **not** been executed anywhere.

## 1. Recommended delivery path

| Option | Description                                                                                                                                                      | Effect on gates                                                                          | Recommendation  |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------- |
| A      | Amend the baseline before G7                                                                                                                                     | Baseline SHA changes → **G6 acceptance void**, re-review SQL, new hash in G7/G8 evidence | Not recommended |
| B      | Separate **forward migration** (e.g. `2026xxxx_phase4_blocked_features`) authored after approval, applied **after G8** through the same G7-style scratch dry run | G6 stays valid; one more controlled migration gate                                       | **Recommended** |

All proposed changes are **additive** (new tables, new nullable columns). No existing column, index,
FK or CHECK is altered, so no data backfill is required on a fresh database and rollback is a simple
`DROP` of the added objects (documented per item).

## 2. Proposed changes

### SCP-1 — MFA recovery codes (OQ-30 / D-45, AUTHENTICATION_AUTHORIZATION §13)

New model (table `user_mfa_recovery_codes`):

| Field            | Type                                             | Notes                                                                 |
| ---------------- | ------------------------------------------------ | --------------------------------------------------------------------- |
| `id`             | `CHAR(36)` PK                                    | UUID                                                                  |
| `user_id`        | `CHAR(36)` FK → `users.id` **ON DELETE CASCADE** | Staff only (service-enforced)                                         |
| `batch_id`       | `CHAR(36)`                                       | Regenerating codes invalidates the previous batch                     |
| `code_hash`      | `VARCHAR(255)`                                   | **Argon2id** PHC hash of the code; raw codes shown once, never stored |
| `used_at`        | `DATETIME(3)` NULL                               | Single use                                                            |
| `invalidated_at` | `DATETIME(3)` NULL                               | Batch superseded / MFA reset                                          |
| `created_at`     | `DATETIME(3)`                                    |                                                                       |

Indexes: `ix_umrc_user_active (user_id, used_at, invalidated_at)`. No unique on `code_hash` (salted hashes).
Security: 10 codes × 10 chars per batch; verification compares against unused, non-invalidated rows;
each use audited (`auth.mfa_recovery_used`) and alerts Superadmins; codes never logged (redaction
denylist already covers `recovery`). Unblocks: `recoveryCode` on `POST /admin/auth/mfa/verify`, a
"regenerate recovery codes" route (needs a route-catalogue entry).
Rollback: `DROP TABLE user_mfa_recovery_codes`.

### SCP-2 — Staff password history (AUTHENTICATION_AUTHORIZATION §4.2: "cannot reuse last 5")

New model (table `user_password_history`) — preferred over the proposed `users.password_history` JSON
column (simpler pruning, no JSON parsing in the hot path):

| Field           | Type                                         | Notes                               |
| --------------- | -------------------------------------------- | ----------------------------------- |
| `id`            | `CHAR(36)` PK                                |                                     |
| `user_id`       | `CHAR(36)` FK → `users.id` ON DELETE CASCADE |                                     |
| `password_hash` | `VARCHAR(255)`                               | Argon2id PHC (previous hashes only) |
| `created_at`    | `DATETIME(3)`                                |                                     |

Index `ix_uph_user_created (user_id, created_at)`. Service keeps the newest 5 rows per staff user
(prune in the same transaction as the password change). Security: same protection class as
`users.password_hash` (never selected outside the auth module, never logged).
Rollback: `DROP TABLE user_password_history`.

### SCP-3 — Review rejection reason (OQ-31, reviews moderation)

`reviews` already has `moderated_by_id`, `moderated_at`. Add:

| Column              | Type                | Notes                                                                                      |
| ------------------- | ------------------- | ------------------------------------------------------------------------------------------ |
| `moderation_reason` | `VARCHAR(500)` NULL | Required by the service when status → `REJECTED`; shown to the author in `GET /me/reviews` |

Optional CHECK (SQL-only, consistent with Phase 3 CHECK style):
`CHECK (status <> 'REJECTED' OR moderation_reason IS NOT NULL)` — recommended only if existing
rejected rows cannot exist at migration time (true on a fresh DB).
Security: free text from staff; apply the existing redaction scan for card/OTP patterns.
Rollback: `ALTER TABLE reviews DROP COLUMN moderation_reason` (+ drop CHECK).

### SCP-4 — Encrypted COD refund bank details (OQ-63, SECURITY_GUIDELINES §10)

New model (table `refund_bank_details`), one row per refund, **separate** from `refunds` so the
sensitive data can be purged without touching the financial record:

| Field                      | Type                                               | Notes                                                           |
| -------------------------- | -------------------------------------------------- | --------------------------------------------------------------- |
| `refund_id`                | `CHAR(36)` PK, FK → `refunds.id` ON DELETE CASCADE |                                                                 |
| `account_holder_encrypted` | `VARCHAR(512)`                                     | AES-256-GCM via `FieldCipher` (`FIELD_ENCRYPTION_KEY`)          |
| `account_number_encrypted` | `VARCHAR(512)`                                     | AES-256-GCM                                                     |
| `ifsc_encrypted`           | `VARCHAR(255)`                                     | AES-256-GCM (IFSC is on the never-log list)                     |
| `account_last4`            | `CHAR(4)`                                          | For display/reconciliation only                                 |
| `submitted_by_id`          | `CHAR(36)` NULL                                    | Customer (secure form) or staff                                 |
| `created_at`               | `DATETIME(3)`                                      |                                                                 |
| `purge_after`              | `DATETIME(3)`                                      | e.g. refund `completed_at` + 30 days (retention decision OQ-38) |
| `purged_at`                | `DATETIME(3)` NULL                                 | Ciphertexts set to `''`/NULL by a purge job                     |

Security: decrypt only inside the refund payout path for users with `refunds.update` + re-auth; never
returned in API responses beyond `account_last4`; never logged or audited in clear (audit records
"bank details submitted/purged" only). DB grant for the runtime user unchanged (DML).
Dependencies: retention period (OQ-38), the secure customer form route (catalogue entry needed),
key-rotation runbook for `FIELD_ENCRYPTION_KEY`.
Rollback: `DROP TABLE refund_bank_details` (after confirming no pending COD refunds need it).

### SCP-5 — Promotion description and banner label

Add to `promotions`:

| Column         | Type                 | Notes                                                                    |
| -------------- | -------------------- | ------------------------------------------------------------------------ |
| `description`  | `VARCHAR(1000)` NULL | Admin-facing description                                                 |
| `banner_label` | `VARCHAR(60)` NULL   | Customer-facing badge text (e.g. "Festive 20% off"); plain text, no HTML |

Security: `banner_label` is rendered on the storefront → plain text only (escape on render; reject `<`
`>` in the schema validator). Rollback: drop both columns.

### SCP-6 — Shipment tracking URL

Add to `shipments`:

| Column         | Type                | Notes                 |
| -------------- | ------------------- | --------------------- |
| `tracking_url` | `VARCHAR(500)` NULL | Carrier tracking page |

Optional CHECK `tracking_url IS NULL OR tracking_url LIKE 'https://%'`. Security: only provider-supplied
or staff-entered https URLs; the storefront opens it with `rel="noopener noreferrer"`; never a
`javascript:` URL (validator + CHECK). Rollback: drop the column.

## 3. Illustrative DDL (NOT executed, for review only)

```sql
CREATE TABLE `user_mfa_recovery_codes` (
  `id` CHAR(36) NOT NULL, `user_id` CHAR(36) NOT NULL, `batch_id` CHAR(36) NOT NULL,
  `code_hash` VARCHAR(255) NOT NULL, `used_at` DATETIME(3) NULL, `invalidated_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`), INDEX `ix_umrc_user_active` (`user_id`, `used_at`, `invalidated_at`),
  CONSTRAINT `user_mfa_recovery_codes_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
    ON DELETE CASCADE ON UPDATE RESTRICT
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE TABLE `user_password_history` (
  `id` CHAR(36) NOT NULL, `user_id` CHAR(36) NOT NULL, `password_hash` VARCHAR(255) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`), INDEX `ix_uph_user_created` (`user_id`, `created_at`),
  CONSTRAINT `user_password_history_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
    ON DELETE CASCADE ON UPDATE RESTRICT
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

ALTER TABLE `reviews` ADD COLUMN `moderation_reason` VARCHAR(500) NULL;

CREATE TABLE `refund_bank_details` (
  `refund_id` CHAR(36) NOT NULL, `account_holder_encrypted` VARCHAR(512) NOT NULL,
  `account_number_encrypted` VARCHAR(512) NOT NULL, `ifsc_encrypted` VARCHAR(255) NOT NULL,
  `account_last4` CHAR(4) NOT NULL, `submitted_by_id` CHAR(36) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `purge_after` DATETIME(3) NOT NULL,
  `purged_at` DATETIME(3) NULL,
  PRIMARY KEY (`refund_id`), INDEX `ix_rbd_purge` (`purged_at`, `purge_after`),
  CONSTRAINT `refund_bank_details_refund_id_fkey` FOREIGN KEY (`refund_id`) REFERENCES `refunds`(`id`)
    ON DELETE CASCADE ON UPDATE RESTRICT
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

ALTER TABLE `promotions` ADD COLUMN `description` VARCHAR(1000) NULL, ADD COLUMN `banner_label` VARCHAR(60) NULL;

ALTER TABLE `shipments` ADD COLUMN `tracking_url` VARCHAR(500) NULL;
```

## 4. Impact summary

| Item  | New objects                 | Counts after (if all approved) | Code unblocked                    | Approval needed              |
| ----- | --------------------------- | ------------------------------ | --------------------------------- | ---------------------------- |
| SCP-1 | 1 table, 1 FK, 1 index      | models 67 → 68                 | MFA recovery codes                | Owner + schema               |
| SCP-2 | 1 table, 1 FK, 1 index      | → 69                           | Staff password reuse rule         | Owner + schema               |
| SCP-3 | 1 column (+ optional CHECK) | —                              | Rejection reason shown to authors | Owner + schema               |
| SCP-4 | 1 table, 1 FK, 1 index      | → 70                           | COD refunds by bank transfer      | Owner + schema + OQ-38/OQ-63 |
| SCP-5 | 2 columns                   | —                              | Promotion description & badge     | Owner + schema               |
| SCP-6 | 1 column (+ optional CHECK) | —                              | Tracking link                     | Owner + schema               |

Enums: none added. Phase 3 documents to update on approval: `PRISMA_SCHEMA_DESIGN.md`,
`DATABASE_TABLE_CATALOG.md`, `DATABASE_CONSTRAINTS_AND_INDEXES.md`, `DATABASE_RELATIONSHIPS.md`,
`DATABASE_SECURITY_AND_DATA_PRIVACY.md` (SCP-4), `DATABASE_ER_DIAGRAM.md`.

## 5. Other schema gaps observed during Phase 4 (not requested; listed for completeness)

`coupon_usage.release_reason`; `report_exports` failure reason; `shipments` weight/dimensions;
banner subtitle/button label; `refresh_tokens.device_label` (derived at runtime today); `audit_logs`
`event_key`/`metadata` (stored inside `new_values._event` today); seller name/address snapshot on
`invoice_records` (taken from current settings at render time today); GST UQC and reverse-charge flag.
None is implemented; each would need the same approval path.
