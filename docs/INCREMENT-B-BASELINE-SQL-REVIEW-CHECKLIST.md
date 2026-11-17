# Increment B — Baseline Migration SQL Review Checklist (Gate G6)

| Field            | Value                                                                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document ID      | P4-B-REVIEW-01                                                                                                                                           |
| Phase            | Phase 4 — Backend Development (B0-b Part 2)                                                                                                              |
| Increment        | Increment B Stage 1 — candidate baseline migration (G5 output)                                                                                           |
| Status           | **CANDIDATE SQL CORRECTED (Option A, approved D8–D14) — G6 PASS: ACCEPTED FOR G7 PREPARATION (owner acceptance 2026-11-17). NOT APPLIED. NOT EXECUTED.** |
| Date             | 2026-11-17                                                                                                                                               |
| SQL under review | `ecommerce-api/prisma/migrations/20261117160425_baseline/migration.sql`                                                                                  |
| Sources          | Approved `prisma/schema.prisma` (67 models / 50 enums); P3-06, P3-03, `05-database/DATABASE_DESIGN.md` (§23.6, §6–§13)                                   |

> **Nothing in this migration has been executed.** Apply happens only after (1) G6 approval — **granted: G6 PASS, owner acceptance 2026-11-17** (independent re-review record: [`INCREMENT-B-G6-RE-REVIEW-ACCEPTANCE.md`](./INCREMENT-B-G6-RE-REVIEW-ACCEPTANCE.md)) — (2) G2 backup/restore drill is done, (3) G3 migration user exists, (4) G7 dry-run passes on a scratch database you create.
>
> **Option A implementation record (2026-11-17, approved D8–D14):** G6 review found three blocking FAILs — F1 (9/10 STORED generated columns on FK base columns with CASCADE actions, MySQL 8.4 §15.1.20.5), F2 (5 CHECKs on FK columns carrying referential actions, §15.1.20.6), F3 (`ck_orders_money` missing `subtotal >= 0`). Implemented corrections: 114 explicit `onUpdate: Restrict` (D9); 10 approved `onDelete: Cascade → Restrict` flips (D9/D8 scope); composite FK → `ON DELETE RESTRICT` (D8); `subtotal >= 0` restored (D13); schema offline-regenerated (baseline now **1943 lines**); P3-04 amended per D10. **17 unique F1/F2 FK constraints addressed = 16 Prisma relations + 1 SQL-only composite FK.** Independent G6 re-review completed 2026-11-17 — **PASS, accepted by the owner for G7 preparation**; G7 pending. OPEN G7 item: direct `ProductImage.variantId` CASCADE FK vs composite FK RESTRICT interaction (delete-variant-with-images probe).

## 1. What is in the candidate migration

| Section                                                       | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Count     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| Prisma-generated DDL (from-empty diff of approved schema)     | 67 `CREATE TABLE` statements, 114 foreign keys (`*_fkey`, all `ON UPDATE RESTRICT`, per-policy `ON DELETE` — 29 CASCADE / 77 RESTRICT / 8 SET NULL after Option A), 135 schema indexes/uniques (81 `ix_*` + 54 `UNIQUE INDEX`, incl. 13 composite `PRIMARY KEY`s)                                                                                                                                                                                                                                                                                      | 67 tables |
| SQL-only §1 — Generated STORED columns                        | G1–G10 (`categories.parent_key`, `product_variants.default_key`, `product_images.primary_key_marker`, `user_addresses.default_owner_key`, `carts.active_owner_key`, `wishlist_items.variant_key`, `coupon_applicability.target_id`, `invoice_records.tax_invoice_order_key`, `inventory.quantity_available`, `idempotency_keys.owner_key`)                                                                                                                                                                                                             | 10        |
| SQL-only §2 — Unique indexes (generated/conditional/nullable) | `uq_categories_parent_name`, `uq_product_variants_default`, `uq_product_images_primary`, `uq_user_addresses_default`, `uq_carts_active_owner`, `uq_wishlist_items`, `uq_coupon_applicability`, `uq_invoice_tax_order`, `uq_idempotency`, `uq_payments_provider_order`, `uq_payments_provider_payment`, `uq_payment_txn_event`, `uq_shipments_awb`                                                                                                                                                                                                      | 13        |
| SQL-only §3 — CHECK constraints                               | `ck_*` from `DATABASE_DESIGN.md` §6–§13 (users, permissions, user_addresses, verification_tokens, categories, collections, products, product_variants, attribute_values, inventory, inventory_transactions, stock_reservations, cart_items, orders, order_items, order_status_history, payments, refunds, refund_items, shipping_methods, shipment_items, coupons, coupon_applicability, coupon_usage, promotions, reviews, notification_templates, tax_rates, hsn_codes, product_tax_assignments, tax_transactions, invoice_records, states, banners) | 75        |
| SQL-only §4 — Composite FK                                    | `fk_product_images_variant_product (variant_id, product_id) → product_variants (id, product_id)` ON DELETE RESTRICT ON UPDATE RESTRICT (D8, 2026-11-17; referenced supporting unique `uq_product_variants_id_product` exists in the Prisma DDL; interaction with the unchanged `ProductImage.variantId` CASCADE FK is an open risk — G7 probe required)                                                                                                                                                                                                | 1         |
| FULLTEXT/ngram indexes                                        | **Intentionally absent — deferred per OQ-B6 (approved 2026-11-17)**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 0         |

## 2. Review checklist (tick each before approving the SQL)

### A. Tables and enums

- [ ] 67 tables created; names match `DATABASE_TABLE_CATALOG.md` exactly (verified this Stage 1: all 67 match the approved catalog list).
- [ ] Enum columns: all 50 approved enums represented. MySQL DDL contains **47 distinct enum type strings** from 48 distinct value lists, because (a) `VariantStatus`/`CouponStatus` and (b) `PromotionScope`/`CouponTargetType` share identical value lists, and (c) `SystemRoleCode` is declared but is not used as any column type (system roles are seeded rows in `roles.code`) — all expected, not defects. `information_schema` verification (G9) should expect exactly 47 distinct enum `COLUMN_TYPE` values.
- [ ] Enum value lists match `PRISMA_SCHEMA_DESIGN.md` / `PROJECT_CONTEXT.md §5`.

### B. Primary and foreign keys

- [ ] 13 composite PKs (junction/definition tables, `audit_logs (id, created_at)`, `number_sequences`, `inventory.variant_id`).
- [x] 114 Prisma FKs with explicit `ON UPDATE RESTRICT` (D9, implemented 2026-11-17) and per-policy `ON DELETE` (29 CASCADE / 77 RESTRICT / 8 SET NULL after the 10 approved Cascade→Restrict flips) per `DATABASE_RELATIONSHIPS.md` (as amended per D10).
- [x] Composite FK `fk_product_images_variant_product` correct (nullable `variant_id`, **RESTRICT on delete, RESTRICT on update** — D8, 2026-11-17).

### C. Unique constraints

- [ ] All schema `@unique`/`@@unique` present in Prisma DDL (33 field-level + 21 composite = 54 total).
- [ ] 13 SQL-only unique indexes present and correctly nullable-unique (multiple NULLs allowed) for provider/AWB dedupe.

### D. Indexes

- [ ] All 81 schema `@@index` present.
- [ ] OQ-B5 differences (P3-06 §3 rows vs schema index definitions, e.g. soft-delete dimension in `products` listing index) reviewed and accepted — schema is authoritative per OQ-B5 decision (2026-11-17).

### E. CHECK constraints

- [ ] 75 `ck_*` statements reviewed against `DATABASE_DESIGN.md` §6–§13 wording.
- [ ] REGEXP-based checks (`postal_code`, `sku`, `barcode`, `code_normalized`, `swatch_hex`, `hsn_code`, `states.code`) validated on MySQL 8.4 during the G7 dry run.
- [ ] Adapted checks confirmed as correct interpretations (see §3).

### F. Generated columns

- [ ] All 10 STORED generated columns; expressions exactly as documented (root sentinel `'00000000-0000-0000-0000-000000000000'` for `categories.parent_key`).
- [ ] Confirmed no ORM/seed path ever writes them (Prisma client does not know these columns; Increment C seeds must avoid raw writes).

### G. Data-integrity risks

- [ ] MySQL DDL implicit commits acknowledged: migration is not atomic; failure mid-run leaves partial state (recover via restore from G2 backup — database is empty today).
- [ ] Generated columns + SQL-only unique indexes may surface as "drift" in any future `migrate dev` — approved workflow is `migrate deploy` only (OQ-B2); never run `migrate dev` against this database.

### H. Destructive SQL scan

- [ ] **No** `DROP`, **no** `TRUNCATE`, **no** `DELETE`/`UPDATE`/`INSERT` of data, **no** `ALTER ... MODIFY` of existing columns anywhere in the file. (Verified this Stage 1: file contains only `CREATE TABLE`, `CREATE UNIQUE INDEX`/index creation, `ADD CONSTRAINT`/`ADD COLUMN`/`ADD UNIQUE INDEX`/`ALTER TABLE ... ADD` forms.)

### I. Phase 3 documentation differences (decide/confirm at G6)

- [ ] Items a–e in migration file's "NOT IMPLEMENTED" block (no matching approved Phase 3 columns: `tax_rates.cess_rate` [D2/D11: confirmed omitted], `invoice_records` component columns [D3/D11: ledger represents sums], `notifications.max_attempts` [D4/D11: service-layer cap], `number_sequences.max_value` [D5/D11: service-layer guard], Phase 1 PROPOSED ascii charsets) — the `ck_orders_money subtotal` item was REMOVED 2026-11-17: `subtotal >= 0` restored per D13.
- [ ] Adaptations: `ck_tax_rates_components` (no `cess_rate` term), `ck_sm_threshold` (`'FREE_ABOVE'` enum value), `ck_sm_days` (`eta_min_days`/`eta_max_days` names), `ck_nt_email` (`body` instead of `body_html`). `ck_orders_money` is no longer adapted — `subtotal >= 0` restored per D13 (2026-11-17).
- [ ] `ck_coupons_window`/`ck_promotions_window` nullable semantics (NULL window bound ⇒ check passes) noted.

## 3. Adapted vs verbatim CHECK definitions (traceability)

| Check                     | Phase 1 wording                       | Candidate SQL                 | Reason                                                                                                           |
| ------------------------- | ------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `ck_orders_money`         | includes `subtotal >= 0`              | **term restored** (D13)       | `orders.subtotal` EXISTS (schema L1196); the earlier "no subtotal column" claim was false — corrected 2026-11-17 |
| `ck_tax_rates_components` | includes `cess_rate >= 0`             | term omitted                  | no `cess_rate` column in Phase 3 schema                                                                          |
| `ck_sm_threshold`         | `rate_type <> 'FREE_ABOVE_THRESHOLD'` | `<> 'FREE_ABOVE'`             | Phase 3 enum value is `FREE_ABOVE`                                                                               |
| `ck_sm_days`              | `estimated_days_min/max`              | `eta_min_days`/`eta_max_days` | Phase 3 column names                                                                                             |
| `ck_nt_email`             | `body_html IS NOT NULL`               | `body IS NOT NULL`            | Phase 3 column is `body`                                                                                         |
| all others                | verbatim                              | verbatim                      | —                                                                                                                |

## 4. Verification after apply (G7 dry run → G9 production apply)

Per plan §9: `prisma migrate status` clean; 68 tables (67 + `_prisma_migrations`); FK/index/CHECK counts via `information_schema`; invalid-data rejection probes; generated-column spot checks; full quality suite. Scratch database (user-created, OQ-B7) used for the dry run first.
