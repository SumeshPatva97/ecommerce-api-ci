# Increment B — G6 Read-Only Technical Review Report (Candidate Baseline Migration SQL)

| Field               | Value                                                                                                                                                                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document ID         | P4-B-REVIEW-02                                                                                                                                                                                                                                                  |
| Phase               | Phase 4 — Backend Development (B0-b Part 2)                                                                                                                                                                                                                     |
| Increment           | Increment B — Database migrations + Phase 3 SQL-only constraints                                                                                                                                                                                                |
| Gate                | **G6 — Candidate baseline SQL review (READ-ONLY)**                                                                                                                                                                                                              |
| Status              | **REVIEW COMPLETE — PENDING USER APPROVAL. This review does NOT grant approval and does NOT recommend approving the candidate as-is (corrections required — see §13–§16).**                                                                                     |
| Date                | 2026-11-17                                                                                                                                                                                                                                                      |
| Review method       | Static, offline analysis only. **No database connection, no SQL execution, no file modification.** Findings verified against the approved Prisma schema, approved Phase 3 documents, Phase 1 `DATABASE_DESIGN.md`, and the official MySQL 8.4 Reference Manual. |
| Object under review | `ecommerce-api/prisma/migrations/20261117160425_baseline/migration.sql` (97,391 bytes; **1,936 physical lines**, of which 1,682 are non-empty — earlier Stage-1 references to "1,682 lines" used a blank-line-excluding counter and are corrected here)         |

> **UPDATE (2026-11-17, after this review):** the D8–D14 corrections were implemented offline, an independent read-only G6 re-review of the corrected candidate was completed — **PASS** — and the project owner explicitly ACCEPTED G6 for G7 preparation (see Addendum 1 below, Addendum 2 below, and [`INCREMENT-B-G6-RE-REVIEW-ACCEPTANCE.md`](./INCREMENT-B-G6-RE-REVIEW-ACCEPTANCE.md)). The original review text below — including the "PENDING USER APPROVAL" status in this header — is preserved unchanged as the historical record of the pre-correction review.

> **Important headline for the reader:** the review found three issues that must be resolved before this SQL can be approved or applied:
>
> 1. **F1 (FAIL):** 9 of the 10 SQL-only generated `STORED` columns are based on FK columns whose foreign keys use `CASCADE`/`ON UPDATE CASCADE` actions — a combination MySQL 8.4 explicitly prohibits (documented; predicted hard DDL failure at G7).
> 2. **F2 (FAIL):** 5 of the 75 CHECK constraints reference FK columns that carry referential actions (`ON UPDATE CASCADE` on every affected FK) — also explicitly prohibited by MySQL 8.0.16+/8.4 (documented; predicted hard DDL failure at G7).
> 3. **F3 (FAIL):** the `subtotal >= 0` term was dropped from `ck_orders_money` on the claim that "Phase 3 schema has no `subtotal` column" — **that claim is false**: `orders.subtotal` exists in the approved schema (schema L1196) and in this very migration (L661). The term must be restored.
>
> None of these can be fixed inside this review (read-only mandate). §14–§15 set out the correction options requiring your decision.

---

## 1. Review scope and files inspected

Files inspected in full or in relevant part:

| File                                                                                                                      | Used for                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ecommerce-api/prisma/migrations/20261117160425_baseline/migration.sql`                                                   | Object under review (read in full: L1–L1936)                                                                                                                                                               |
| `ecommerce-api/prisma/schema.prisma`                                                                                      | Authoritative baseline (67 models / 50 enums)                                                                                                                                                              |
| `ecommerce-api/docs/INCREMENT-B-BASELINE-SQL-REVIEW-CHECKLIST.md`                                                         | Stage-1 claims independently re-verified (several found inaccurate — §13)                                                                                                                                  |
| `ecommerce-api/docs/INCREMENT-B-IMPLEMENTATION-PLAN.md`                                                                   | Gate definitions G1–G10, §0 decision record, §7 grants, §9 verification plan                                                                                                                               |
| `ecommerce-api/docs/INCREMENT-B-RISK-ASSESSMENT.md`                                                                       | Risks R-1…R-15                                                                                                                                                                                             |
| `project-documentation/05-database/DATABASE_DESIGN.md` (Phase 1)                                                          | Authoritative exact CHECK definitions (§6–§13 + coupon block L1493–1500 + permissions L426), generated-column expressions (§23.6 / §3.9, L195–208), per-table unique keys, FK/CHECK limitation note (L191) |
| `project-documentation/12-phase3-database-design/DATABASE_MIGRATION_STRATEGY.md` (P3-16)                                  | Approved Option-B migration workflow                                                                                                                                                                       |
| `project-documentation/12-phase3-database-design/DATABASE_CONSTRAINTS_AND_INDEXES.md` (P3-06)                             | SQL-only constraint requirements, composite FK (§2.1)                                                                                                                                                      |
| `project-documentation/12-phase3-database-design/DATABASE_TABLE_CATALOG.md` (P3-03)                                       | Approved 67-table catalog                                                                                                                                                                                  |
| `project-documentation/12-phase3-database-design/DATABASE_RELATIONSHIPS.md`                                               | FK action convention (**L11: "ON UPDATE is `RESTRICT` for all enforced FKs unless noted"** — relevant to §15 D1)                                                                                           |
| `project-documentation/12-phase3-database-design/PRISMA_SCHEMA_DESIGN.md`                                                 | Phase-3 schema drafts (includes `maxAttempts` L655 and `subtotal` L1259 — both present in approved schema)                                                                                                 |
| `project-documentation/12-phase3-database-design/GST_AND_INVOICE_DATABASE_DESIGN.md`                                      | cess / invoice-component context for NOT-IMPLEMENTED items                                                                                                                                                 |
| `project-documentation/12-phase3-database-design/DATABASE_OPEN_QUESTIONS.md` (P3-19)                                      | OQ-26 numbering, OQ-41 order numbers                                                                                                                                                                       |
| MySQL 8.4 Reference Manual §15.1.20.6 (CHECK Constraints) and §15.1.20.5 (FOREIGN KEY Constraints, "Referential Actions") | Compatibility rulings (§11)                                                                                                                                                                                |

What this review did **not** do: no DB connection, no SQL execution, no `prisma migrate deploy/dev/db push/reset`, no schema/SQL/doc/code/`.env` modification, no Git operations. Exactly one new file was created (this report).

---

## 2. Verification of 67 tables and 50 enums — PASS (with one documentation note)

### Tables

- **67 `CREATE TABLE` statements** confirmed by count; the extracted table-name list matches `DATABASE_TABLE_CATALOG.md` exactly (all 67 names: `attribute_values, attributes, audit_logs, banners, brands, cart_items, carts, categories, category_attributes, cms_blocks, cms_pages, collection_products, collections, coupon_applicability, coupon_usage, coupons, hsn_codes, idempotency_keys, inventory, inventory_transactions, invoice_records, notification_logs, notification_preferences, notification_templates, notifications, number_sequences, order_items, order_status_history, orders, payment_transactions, payments, permissions, product_attribute_values, product_images, product_tax_assignments, product_variants, products, promotion_brands, promotion_categories, promotion_collections, promotion_products, promotions, recently_viewed_products, refresh_tokens, refund_items, refunds, report_exports, reviews, role_permissions, roles, settings, shipment_items, shipment_tracking_events, shipments, shipping_methods, states, stock_reservations, tax_rates, tax_transactions, user_addresses, user_permission_overrides, user_roles, users, variant_attribute_values, verification_tokens, wishlist_items, wishlists`). **PASS.**
- After apply, `prisma migrate deploy` additionally creates `_prisma_migrations` → G7/G9 should expect **68** tables.

### Enums

- Schema declares **50 enums**; DDL contains **47 distinct MySQL `ENUM(...)` type strings** across **66 enum columns**. Programmatic comparison of every distinct DDL enum string against the 50 schema enum value lists found **zero missing and zero extra** value lists.
- Reconciles as follows (all expected, not defects):
  - `VariantStatus` / `CouponStatus` share identical value lists → 1 string for 2 enums.
  - `PromotionScope` / `CouponTargetType` share identical value lists → 1 string for 2 enums.
  - `SystemRoleCode` is declared but not used as any column type (system roles are seeded rows in `roles.code`) → 0 strings.
  - 50 − 2 (merged) − 1 (unused) = 47 distinct strings. **PASS.**

---

## 3. Schema completeness findings — PASS (counts cross-checked programmatically)

| Metric                                               | Approved schema | Candidate DDL                                                                                                                     | Verdict                                      |
| ---------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Models / CREATE TABLE                                | 67              | 67                                                                                                                                | PASS                                         |
| Field-level `@unique`                                | 33              | 33                                                                                                                                | PASS                                         |
| Composite `@@unique`                                 | 21              | 21                                                                                                                                | PASS                                         |
| `@@index`                                            | 81              | 81 (`ix_*`)                                                                                                                       | PASS                                         |
| Composite `@@id`                                     | 13              | 13                                                                                                                                | PASS                                         |
| Single-column PKs                                    | 54              | 54                                                                                                                                | PASS                                         |
| `Json` columns                                       | 15              | 15                                                                                                                                | PASS                                         |
| `Decimal(12,2)`                                      | 60              | 60                                                                                                                                | PASS                                         |
| `Decimal(5,2)`                                       | 12              | 12                                                                                                                                | PASS                                         |
| `Decimal(3,2)`                                       | 1               | 1                                                                                                                                 | PASS                                         |
| `Decimal(10,3)`                                      | 2               | 2                                                                                                                                 | PASS                                         |
| `DateTime(3)` (`DATETIME(3)`)                        | 168             | 168                                                                                                                               | PASS                                         |
| `@db.Date` (`DATE`)                                  | 2               | 2                                                                                                                                 | PASS                                         |
| `Boolean` (`BOOLEAN`)                                | —               | 48                                                                                                                                | consistent                                   |
| Unannotated `String` → Prisma default `VARCHAR(191)` | 3               | 3 (`shipment_tracking_events.dedupe_key` L1216, `notification_logs.provider_message_id` L1221, `idempotency_keys.idem_key` L1376) | PASS (noted; schema-authoritative per OQ-B5) |
| TEXT family                                          | —               | 10 (3 `MEDIUMTEXT`, 7 `TEXT`-class)                                                                                               | consistent                                   |
| Auto-increment columns                               | 0               | 0 (UUID `CHAR(36)` PKs; sequence logic via `number_sequences`)                                                                    | PASS                                         |

**Primary keys.** 13 composite PKs confirmed at L84 (`user_roles (user_id, role_id)`), L95 (`role_permissions`), L249 (`category_attributes`), L309 (`collection_products`), L481 (`variant_attribute_values`), L493 (`product_attribute_values`), L838 (`shipment_items`), L1051/L1060/L1068/L1076 (`promotion_products/categories/brands/collections`), L1203 (`number_sequences (sequence_key, period_key)`), L1295 (`audit_logs (id, created_at)`); plus 54 single-column UUID PKs. The checklist's claim of "12 composite PKs" is **wrong — actual 13** (see §13).

**Nullability and defaults.** Spot-verified across all money/date/enum columns (e.g., `orders` block L651–L1938 region: `subtotal DECIMAL(12,2) NOT NULL` no default; discount/tax columns `NOT NULL DEFAULT 0`; `carts.coupon_id` nullable for `SET NULL` FK). Every `ON DELETE SET NULL` FK column (8 FKs: `user_roles.assigned_by_id` L1417, `refresh_tokens.replaced_by_id` L1441, `carts.coupon_id` L1528, `carts.converted_order_id` L1531, `notifications.recipient_user_id` L1729, `notifications.resend_of_id` L1735, `banners.category_id` L1741, `cms_blocks.category_id` L1744) is nullable — `SET NULL` requirement satisfied. **PASS.**

---

## 4. Foreign key and index findings

### 4.1 Prisma FKs — count and action distribution (PASS on count; discrepancy in checklist)

- **114 FKs** named `<table>_<column>_fkey` (Prisma default naming), matching the 114 schema relations.
- `ON DELETE` distribution: **RESTRICT 67, CASCADE 40, SET NULL 8** (= 115 with the SQL-only composite FK, which is `ON DELETE CASCADE`).
- **`ON UPDATE CASCADE` on all 114** (100%); `ON UPDATE` non-CASCADE count = 0. This is Prisma's default when the schema does not specify `onUpdate`.
- **Checklist §B inaccuracy:** the checklist states "114 Prisma FKs with `ON UPDATE RESTRICT` … per `DATABASE_RELATIONSHIPS.md`". The actual DDL is `ON UPDATE CASCADE` on all 114. Phase 3 `DATABASE_RELATIONSHIPS.md` L11 indeed documents "`ON UPDATE` is `RESTRICT` for all enforced FKs unless noted" — so the **DDL contradicts the Phase 3 documentation convention**, and the checklist misdescribed the DDL. Consequences: this is no longer merely cosmetic — combined with the generated columns and CHECKs it produces the FAIL findings below (§5, §7).

### 4.2 SQL-only composite FK — PASS (see §8)

### 4.3 Indexes and uniques — PASS (counts corrected)

- DDL contains **135** secondary index/unique lines: **81 `INDEX ix_*`** (= schema `@@index` 81, exact match) + **54 `UNIQUE INDEX`** (= 33 field-level `@unique` + 21 composite `@@unique`, exact match). The checklist §1 claim of "84 Prisma indexes/uniques" is a counting artifact (81 `ix_*` + 1 unique-name mention + 2 FK-line mentions of `product_images_variant_id_fkey` = 84) and is corrected to **135**.
- Index-byte-size audit (InnoDB 3072-byte limit, `utf8mb4` × 4 bytes/char, `DYNAMIC` row format default in 8.4):
  - `uq_idempotency (owner_key, scope, idem_key)`: 144 + 320 + 764 = **1,228 B** ≤ 3072 — **PASS** (largest in the schema).
  - `uq_shipments_awb (provider, awb_number)`: (30+100)×4 = **520 B** — PASS.
  - `uq_categories_parent_name (parent_key, name_normalized)`: (36+100)×4 = **544 B** — PASS.
  - `uq_coupon_applicability (coupon_id, rule_type, target_type, target_id)`: 144+144+~2+~2 = **~292 B** — PASS.
  - `uq_wishlist_items (wishlist_id, product_id, variant_key)`: 432 B — PASS.
  - `uq_products_category_name (category_id, name_normalized)`: 544 B — PASS.
- **Naming convention note (WARNING, cosmetic):** schema-level uniques/FKs use Prisma names (`product_variants_sku_key`, `orders_user_id_fkey`), while Phase 1 §1 conventions specify `uq_*`/`fk_*`. Inherent to Prisma DDL generation; the SQL-only objects do use `uq_*`/`ck_*`/`fk_*` names. Per OQ-B5 the schema is authoritative; no action needed, but G9 verification scripts must expect Prisma naming.

---

## 5. Generated-column review — expressions PASS; MySQL 8.4 placement **FAIL (F1)**

### 5.1 Expression verification (G1–G10) — PASS (10/10 verbatim)

Each candidate statement (L1768–L1777) was compared against `DATABASE_DESIGN.md` §23.6 / §3.9 (L199–L208). **All 10 expressions are verbatim**, including the root sentinel `'00000000-0000-0000-0000-000000000000'` for `categories.parent_key`, `COALESCE(variant_id, '')` for `wishlist_items.variant_key`, `COALESCE(user_id, 'ANONYMOUS')` for `idempotency_keys.owner_key`, and `COALESCE(product_id, category_id, brand_id, collection_id)` for `coupon_applicability.target_id`. All expressions use deterministic built-ins only (`IF`, `COALESCE`, arithmetic) — permitted in generated-column and CHECK expressions.

### 5.2 MySQL 8.4 restriction on base columns — **FAIL (F1)**

MySQL 8.4 Reference Manual §15.1.20.5 ("Referential Actions") states verbatim:

> "A foreign key constraint on the base column of a stored generated column cannot use `CASCADE`, `SET NULL`, or `SET DEFAULT` as `ON UPDATE` or `ON DELETE` referential actions."

Programmatic extraction of every FK's child columns and actions, intersected with each generated column's base columns, gives:

| Line  | Generated column                                                                | FK on base column(s)                       | FK actions                                | Verdict  |
| ----- | ------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------- | -------- |
| L1768 | `categories.parent_key` (base `parent_id`)                                      | `categories_parent_id_fkey` (L1450)        | ON DELETE RESTRICT, **ON UPDATE CASCADE** | **FAIL** |
| L1769 | `product_variants.default_key` (base `product_id`)                              | `product_variants_product_id_fkey` (L1480) | **ON DELETE CASCADE, ON UPDATE CASCADE**  | **FAIL** |
| L1770 | `product_images.primary_key_marker` (base `product_id`)                         | `product_images_product_id_fkey` (L1474)   | **CASCADE/CASCADE**                       | **FAIL** |
| L1771 | `user_addresses.default_owner_key` (base `user_id`)                             | `user_addresses_user_id_fkey` (L1432)      | **CASCADE/CASCADE**                       | **FAIL** |
| L1772 | `carts.active_owner_key` (base `user_id`)                                       | `carts_user_id_fkey` (L1525)               | **CASCADE/CASCADE**                       | **FAIL** |
| L1773 | `wishlist_items.variant_key` (base `variant_id`)                                | `wishlist_items_variant_id_fkey` (L1549)   | **CASCADE/CASCADE**                       | **FAIL** |
| L1774 | `coupon_applicability.target_id` (bases: 4 columns)                             | 4 FKs (L1636–L1645)                        | **CASCADE/CASCADE ×4**                    | **FAIL** |
| L1775 | `invoice_records.tax_invoice_order_key` (base `order_id`)                       | `invoice_records_order_id_fkey` (L1711)    | ON DELETE RESTRICT, **ON UPDATE CASCADE** | **FAIL** |
| L1776 | `inventory.quantity_available` (bases: `quantity_on_hand`, `quantity_reserved`) | none                                       | —                                         | PASS     |
| L1777 | `idempotency_keys.owner_key` (base `user_id`)                                   | `idempotency_keys_user_id_fkey` (L1747)    | **CASCADE/CASCADE**                       | **FAIL** |

**9 of 10 statements violate the documented MySQL 8.4 rule** (every case via `ON UPDATE CASCADE`, which Prisma emits on all FKs; 6 cases additionally via `ON DELETE CASCADE`). Because the Prisma DDL creates these FKs before the SQL-only section adds the generated columns, the `ALTER TABLE … ADD COLUMN … GENERATED ALWAYS AS … STORED` statements are predicted to fail with a hard error at G7 (classification below assumes the documented rule; empirical confirmation will occur at the G7 dry run, which exists precisely for this).

This restriction is **not mentioned** in `INCREMENT-B-BASELINE-SQL-REVIEW-CHECKLIST.md` §F, and Phase 1 §3.9 (L193) does not address it (Phase 1 §3.8 L191 only notes the CHECK/FK limitation). Classification: **FAIL** — must be resolved before apply (options in §14/§15).

---

## 6. Unique-index review — PASS (13/13 definitions verified; names and expressions match documentation)

All 13 SQL-only unique indexes (L1783–L1796) verified against Phase 1 per-table "Unique:" definitions and §23.6:

| Index (line)                                                                   | Documented source                                     | Match    |
| ------------------------------------------------------------------------------ | ----------------------------------------------------- | -------- |
| `uq_categories_parent_name (parent_key, name_normalized)` L1783                | DATABASE_DESIGN.md L616                               | verbatim |
| `uq_product_variants_default (default_key)` L1784                              | L2857 (Phase-1 Prisma block `@@unique([defaultKey])`) | verbatim |
| `uq_product_images_primary (primary_key_marker)` L1785                         | L774                                                  | verbatim |
| `uq_user_addresses_default (default_owner_key)` L1786                          | L504                                                  | verbatim |
| `uq_carts_active_owner (active_owner_key)` L1787                               | L1002                                                 | verbatim |
| `uq_wishlist_items (wishlist_id, product_id, variant_key)` L1788               | L1053                                                 | verbatim |
| `uq_coupon_applicability (coupon_id, rule_type, target_type, target_id)` L1789 | L1520                                                 | verbatim |
| `uq_invoice_tax_order (tax_invoice_order_key)` L1790                           | L1930                                                 | verbatim |
| `uq_idempotency (owner_key, scope, idem_key)` L1791                            | L2067                                                 | verbatim |
| `uq_payments_provider_order (provider, provider_order_id)` L1793               | L1258                                                 | verbatim |
| `uq_payments_provider_payment (provider, provider_payment_id)` L1794           | L1258                                                 | verbatim |
| `uq_payment_txn_event (provider, provider_event_id)` L1795                     | L1287                                                 | verbatim |
| `uq_shipments_awb (provider, awb_number)` L1796                                | L1415 ("NULLs allowed")                               | verbatim |

Semantics: MySQL UNIQUE indexes ignore NULLs, so the 4 nullable-unique provider/AWB indexes permit multiple NULL rows as designed, and the 9 generated-column indexes emulate conditional uniqueness. **No duplicates of these exist in the Prisma DDL** (verified: e.g., `uq_payments_provider_order` appears only once in the file) — no duplicate-name or duplicate-index conflict. **PASS** (subject to F1, since 9 of these indexes are on generated columns).

---

## 7. CHECK-constraint review — expressions PASS (71 verbatim + 4 adaptations documented); MySQL 8.4 placement **FAIL (F2)**; one factual error **FAIL (F3)**

### 7.1 Accounting

Phase 1 `DATABASE_DESIGN.md` documents **78** CHECK definitions: 70 in "- **Checks:**" lines (§6–§13), 1 permissions ("**Check:**", L426), 7 coupons (bullet block L1493–L1500). The candidate contains **75** `ck_*` statements. Reconciliation:

- 71 verbatim matches (including `ck_permissions_code CHECK (code = CONCAT(module, '.', action))` — `CONCAT` is a deterministic built-in, permitted).
- 4 documented adaptations (see §9): `ck_orders_money` (term dropped — **see F3**), `ck_tax_rates_components` (`cess_rate` term), `ck_sm_threshold` (`'FREE_ABOVE'`), `ck_sm_days` (`eta_min_days`/`eta_max_days`), plus `ck_nt_email` (`body`) — i.e., 5 adaptations affect 5 of the 75.
- 3 fully omitted (documented NOT-IMPLEMENTED): `ck_notifications_attempts` (L1687), `ck_ns_values` (L2116), `ck_invoice_tax_sum` (L1933) — see §10.
- 78 − 3 omitted = 75 = candidate count. **Accounting reconciles exactly.**

### 7.2 Column-existence verification — PASS

Every CHECK expression was checked for column existence in the DDL: all referenced columns exist, including `verification_tokens.max_attempts` (present in schema L610 and DDL), `shipping_methods.eta_min_days`/`eta_max_days` (INTEGER NULL), `notification_templates.body` (TEXT), `coupons.usage_limit_enabled` (BOOLEAN), `states.is_union_territory`/`has_legislature`. No CHECK references a nonexistent column.

### 7.3 MySQL 8.4 restriction on CHECK vs FK referential actions — **FAIL (F2)**

MySQL 8.0/8.4 Reference Manual §15.1.20.6 states verbatim:

> "Foreign key referential actions (`ON UPDATE`, `ON DELETE`) are prohibited on columns used in `CHECK` constraints. Likewise, `CHECK` constraints are prohibited on columns used in foreign key referential actions."

Real-world behavior (MySQL 8, StackOverflow #61361962): adding such a CHECK raises _"Column 'x' cannot be used in a check constraint …: needed in a foreign key constraint … referential action."_ Phase 1 §3.8 (L191) itself acknowledges this limitation — but Stage 1 did not apply it to the FK columns referenced by these CHECKs.

Programmatic intersection of every CHECK's referenced columns with each table's FK child columns (114 Prisma FKs + 1 composite FK) yields **5 affected statements** — every one via `ON UPDATE CASCADE` (present on all 114 FKs):

| Line  | CHECK                    | FK column(s) used                                        | FK action(s)                                 |
| ----- | ------------------------ | -------------------------------------------------------- | -------------------------------------------- |
| L1813 | `ck_categories_not_self` | `categories.parent_id`                                   | ON DELETE RESTRICT, **ON UPDATE CASCADE**    |
| L1879 | `ck_ca_one_target`       | `product_id`, `category_id`, `brand_id`, `collection_id` | **CASCADE/CASCADE ×4**                       |
| L1880 | `ck_ca_target_matches`   | same 4                                                   | **CASCADE/CASCADE ×4**                       |
| L1901 | `ck_pta_target`          | `product_id`, `category_id`                              | ON DELETE RESTRICT, **ON UPDATE CASCADE** ×2 |
| L1908 | `ck_invoice_cn`          | `original_invoice_id`, `refund_id`                       | ON DELETE RESTRICT, **ON UPDATE CASCADE** ×2 |

The remaining 70 CHECKs reference no FK child columns (verified programmatically) and are unaffected. Classification: **FAIL** — must be resolved before apply (options in §14/§15).

### 7.4 `ck_orders_money` missing `subtotal` term — **FAIL (F3)**

- Phase 1 (L1150): `ck_orders_money CHECK (subtotal >= 0 AND item_discount_total >= 0 AND …)`.
- Candidate (L1842) omits `subtotal >= 0`, justified by comments L1841 and L1926 ("no `subtotal` column in Phase 3 schema") and by checklist §I.
- **The claim is false.** `orders.subtotal DECIMAL(12,2) NOT NULL` exists in the approved `schema.prisma` (**L1196**, model `Order`) and in the candidate DDL itself (**L661**, inside the `orders` CREATE TABLE). `PRISMA_SCHEMA_DESIGN.md` L1259 likewise includes it.
- Consequence: the term is implementable and must be restored (a one-line SQL-only correction; no schema change needed). Classification: **FAIL (MUST BE CORRECTED)**.

### 7.5 REGEXP case-sensitivity under `utf8mb4_0900_ai_ci` — WARNING / NOT VERIFIED

The 7 REGEXP-based CHECKs (`ck_user_addresses_pin` L1807, `ck_pv_sku` L1825, `ck_pv_barcode` L1826, `ck_attribute_values_hex` L1828, `ck_coupons_code` L1877, `ck_hsn_format` L1899, `ck_states_code` L1911) run under the database collation `utf8mb4_0900_ai_ci` (accent- and **case-insensitive**). ICU-based MySQL 8 regex matching follows the collation for case sensitivity, so patterns like `'^[A-Z0-9_-]{1,32}$'` are expected to also **accept lowercase** letters (the digit/underscore/length parts are unaffected; `ck_attribute_values_hex` is self-neutralizing since it lists both cases). The service layer (Zod + normalization into `*_normalized` columns) remains the primary guard, so risk is low, but the DB backstop is weaker than the Phase 1 wording suggests. **Verify at G7 with lowercase-rejection probes** (e.g., try `sku = 'abc'`); if strictness is required, the expressions would need an explicit binary collation (`REGEXP BINARY` / `COLLATE utf8mb4_0900_as_cs`), which is a candidate-SQL correction decision for you.

---

## 8. Composite foreign-key review — PASS

- Candidate L1921: `ALTER TABLE product_images ADD CONSTRAINT fk_product_images_variant_product FOREIGN KEY (variant_id, product_id) REFERENCES product_variants (id, product_id) ON DELETE CASCADE ON UPDATE RESTRICT;`
- **Referenced supporting index verified present in the Prisma DDL: L424 `UNIQUE INDEX uq_product_variants_id_product (id, product_id)`** — same column order as the FK reference; MySQL requirement (index on referenced key with matching leftmost order) satisfied.
- Child column `variant_id` is nullable → rows with `NULL` variant bypass the FK (MySQL semantics), matching the design (product-level images).
- Matches P3-06 §2.1 exactly.
- Note: `product_id` is simultaneously (a) a base column of generated `primary_key_marker` and (b) part of this FK with `ON DELETE CASCADE` — covered by finding **F1** above.

---

## 9. Five documented adaptations — individual decisions

| #   | Adaptation                                         | Phase 1 wording                               | Candidate                 | Approved schema                                                                                                       | Classification & reasoning                                                                                                                                                                                                                                                                                               |
| --- | -------------------------------------------------- | --------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `ck_orders_money` without `subtotal >= 0`          | includes the term (L1150)                     | L1842 omits it            | **`Order.subtotal` EXISTS (schema L1196; DDL L661)**                                                                  | **MUST BE CORRECTED (FAIL F3).** The stated justification ("no subtotal column") is factually wrong. Restore the term exactly as Phase 1 words it. No schema change required.                                                                                                                                            |
| 2   | `ck_tax_rates_components` without `cess_rate >= 0` | includes the term (L1805)                     | L1897 omits it            | `TaxRate` has no `cessRate`; `PRISMA_SCHEMA_DESIGN.md` and `GST_AND_INVOICE_DATABASE_DESIGN.md` contain no cess field | **REQUIRES USER DECISION (lean: acceptable).** Phase 1 L1799 marks `cess_rate` "Reserved; not applied in v1"; the approved Phase 3 schema deliberately excludes it. Omission is consistent with OQ-B5 (schema authoritative), but dropping a GST-relevant legal-reserve term should be explicitly confirmed by you (D2). |
| 3   | `ck_sm_threshold` using `'FREE_ABOVE'`             | `rate_type <> 'FREE_ABOVE_THRESHOLD'` (L1385) | L1865 uses `'FREE_ABOVE'` | Approved Phase 3 enum `ShippingRateType = {FLAT, FREE_ABOVE, WEIGHT_BASED, ZONE_BASED}`; DDL matches                  | **ACCEPTABLE ADAPTATION.** The Phase 1 value does not exist in the approved Phase 3 enum; the check's _meaning_ (FREE_ABOVE rows must set `free_above_amount`) is preserved against the approved enum.                                                                                                                   |
| 4   | `ck_sm_days` using `eta_min_days`/`eta_max_days`   | `estimated_days_min/max` (L1385)              | L1867                     | Approved columns `eta_min_days`/`eta_max_days` (INTEGER NULL, DDL-verified)                                           | **ACCEPTABLE ADAPTATION.** Pure column-rename to approved names; logic (max ≥ min, NULL-tolerant) preserved.                                                                                                                                                                                                             |
| 5   | `ck_nt_email` using `body`                         | `body_html IS NOT NULL` (L1739)               | L1891                     | Approved `NotificationTemplate.body` (TEXT; no `body_html` column)                                                    | **ACCEPTABLE ADAPTATION.** Approved schema has only `body`; meaning (EMAIL templates must define subject and body) preserved.                                                                                                                                                                                            |

---

## 10. Six NOT-IMPLEMENTED items — individual decisions

All six are explicitly declared in the migration file (L1923–L1936) — nothing was silently dropped.

| #   | Item                                                                                         | Approved-schema status                                                                                                                                                                                                                      | Recommendation                                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | `orders.subtotal` term in `ck_orders_money`                                                  | **Column EXISTS** (schema L1196)                                                                                                                                                                                                            | **Not a valid omission — see F3. Restore the term.**                                                                                                                             |
| b   | `tax_rates.cess_rate`                                                                        | Absent from approved schema (Phase 1 L1799 "Reserved; not applied in v1")                                                                                                                                                                   | **Remain omitted**, subject to your explicit confirmation (D2). If you want the reserved column for future GST cess support, that is a schema change requiring its own approval. |
| c   | `invoice_records` component columns (`ck_invoice_tax_sum`: tax_total = cgst+sgst+utgst+igst) | Approved schema has only `taxable_total`, `tax_total`, `grand_total` (DDL-verified); per-component detail is carried by the `tax_transactions` ledger (one row per document line × GST component, `GST_AND_INVOICE_DATABASE_DESIGN.md` L37) | **Remain omitted — consistent with approved Phase 3 architecture** (component sums live in `tax_transactions`; `tax_total` authoritative on the invoice). Confirm at D3.         |
| d   | `notifications.max_attempts` (`ck_notifications_attempts`)                                   | Approved schema has `attempt_count`, `next_attempt_at`; no `max_attempts` (DDL-verified). Phase 3 notification design contains no retry-cap column                                                                                          | **Remain omitted**, with the retry cap enforced as a service-layer constant (Phase 1 default was 5). Confirm at D4; if a DB-enforced cap is wanted, that is a schema change.     |
| e   | `number_sequences.max_value` (`ck_ns_values`)                                                | Approved schema: `sequence_key, period_key, prefix, next_value, padding, is_gap_free` only; Phase 3 ER diagram likewise omits `max_value`; OQ-26 covers formats, not overflow                                                               | **Remain omitted**; overflow guard (90 % alert / 100 % fail, Phase 1 L2117) enforced in service. Confirm at D5.                                                                  |
| f   | Phase 1 PROPOSED `CHARACTER SET ascii` on normalized/hash columns                            | Not carried into approved Phase 3 schema (OQ-B5: schema authoritative)                                                                                                                                                                      | **Remain omitted — already-approved decision (OQ-B5).** Note only: no action.                                                                                                    |

---

## 11. MySQL 8.4 compatibility findings

| Area                                                   | Finding                                                                                                                                                                                                                                                                      | Classification                       |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Generated STORED columns — expressions                 | Deterministic built-ins only (`IF`, `COALESCE`, `+`, `-`); permitted by §15.1.20.5                                                                                                                                                                                           | PASS                                 |
| Generated STORED columns — placement vs FK actions     | **9/10 violate the documented rule** ("FK on base column of a stored generated column cannot use CASCADE/SET NULL/SET DEFAULT as ON UPDATE or ON DELETE") — §5.2                                                                                                             | **FAIL (F1)**                        |
| CHECK constraints — expressions                        | All 75 use permitted constructs (no subqueries, no stored functions, no variables, no `NOW()`; `CONCAT`/`REGEXP`/boolean arithmetic are deterministic built-ins)                                                                                                             | PASS                                 |
| CHECK constraints — placement vs FK actions            | **5/75 violate the documented rule** (§15.1.20.6) — §7.3                                                                                                                                                                                                                     | **FAIL (F2)**                        |
| REGEXP under `utf8mb4_0900_ai_ci`                      | Likely case-insensitive matching — §7.5                                                                                                                                                                                                                                      | WARNING / NOT VERIFIED (G7 probe)    |
| Nullable unique indexes                                | MySQL allows multiple NULLs — correct mechanism for provider/AWB dedupe and conditional uniqueness                                                                                                                                                                           | PASS                                 |
| Composite FK                                           | Referenced unique index `uq_product_variants_id_product (id, product_id)` present (L424); column order matches; `restrict_fk_on_non_standard_key` not implicated (references a true UNIQUE key)                                                                              | PASS                                 |
| Index length                                           | Largest = 1,228 B (`uq_idempotency`) ≤ 3,072 B InnoDB limit (§4.3 audit of all composite/SQL-only uniques)                                                                                                                                                                   | PASS                                 |
| FK compatibility — data types                          | FK columns and referenced columns share types (UUID `CHAR(36)`, `states.code CHAR(2)`, `hsn_codes.hsn_code VARCHAR(8)`) — Prisma-generated, consistent                                                                                                                       | PASS                                 |
| FK on generated column / generated column as FK target | None of the SQL-only unique indexes are used as FK targets; no FK targets any generated column                                                                                                                                                                               | PASS                                 |
| Constraint naming                                      | No duplicate constraint names (114 `*_fkey` unique per column; 75 `ck_*`; 13 `uq_*` SQL-only; 1 `fk_*` composite)                                                                                                                                                            | PASS                                 |
| Character sets/collations                              | Single `utf8mb4` / `utf8mb4_0900_ai_ci` (server default); REGEXP nuance flagged (§7.5); em-dash comment bytes verified intact after the `type`-append (L1754, L1760, L1792, L1841, L1864, L1866, L1890, L1896, L1925 render correctly — the appended section is byte-intact) | PASS (with W)                        |
| Execution order                                        | Tables → indexes/PKs → FKs → SQL-only section (generated columns reference existing columns; unique indexes on generated columns follow their creation; composite FK's referenced index exists since table creation)                                                         | PASS                                 |
| FULLTEXT/ngram                                         | **0 statements**; the single "FULLTEXT" occurrence is the OQ-B6 deferral comment (L1760)                                                                                                                                                                                     | PASS (deferred per OQ-B6)            |
| `migration_lock.toml`                                  | Present; `provider = "mysql"`                                                                                                                                                                                                                                                | PASS                                 |
| Empirical behavior of F1/F2                            | Documented rules predict hard failures; not yet empirically confirmed (no DB connection permitted in this review)                                                                                                                                                            | NOT VERIFIED → confirm at G7 dry run |

---

## 12. Potential destructive SQL or data-loss risks — PASS (no destructive statements)

- Statement-level scan of all 1,936 lines: **0** statements beginning with `DROP`, `TRUNCATE`, `DELETE`, `UPDATE`, `INSERT`, or `RENAME`; **0** `ALTER … MODIFY/CHANGE`. Earlier keyword matches were enum _value names_ (`'DELETE'`, `'UPDATE'` in ENUM lists) and FK DDL lines — not destructive statements.
- The file creates objects only (`CREATE TABLE`, index/unique creation, `ADD CONSTRAINT`, `ADD COLUMN`, `ADD UNIQUE INDEX`). No data mutation exists; the target database is empty today.
- Residual structural risk (known, R-1/R-7): MySQL DDL statements cause implicit commits — the migration is **not atomic**; a mid-run failure leaves partial state. Mitigations remain: G2 backup/restore drill, G7 scratch dry run, empty-database recovery. No new destructive risk introduced.

---

## 13. Exact list of discrepancies

**In the candidate SQL (must be corrected before approval):**

1. **D-01 (FAIL F1):** 9 generated-column ALTERs conflict with MySQL 8.4 FK/base-column rule — L1768, L1769, L1770, L1771, L1772, L1773, L1774, L1775, L1777 (details §5.2).
2. **D-02 (FAIL F2):** 5 CHECK ALTERs conflict with MySQL CHECK/FK referential-action rule — L1813, L1879, L1880, L1901, L1908 (details §7.3).
3. **D-03 (FAIL F3):** `ck_orders_money` (L1842) omits `subtotal >= 0` although `orders.subtotal` exists (schema L1196; DDL L661); justification comments L1841/L1926 are factually wrong.

**In the Stage-1 checklist / report documentation (documentation corrections):**

4. **D-04:** Checklist §B says "114 Prisma FKs with `ON UPDATE RESTRICT`" — actual DDL: `ON UPDATE CASCADE` ×114 (and Phase 3 `DATABASE_RELATIONSHIPS.md` L11 documents `ON UPDATE … RESTRICT`, so the DDL itself deviates from the approved convention).
5. **D-05:** Checklist §C says "54 field-level, 21 composite" uniques — actual: **33 field-level + 21 composite = 54 total**.
6. **D-06:** Checklist §B says "12 composite PKs" — actual **13**.
7. **D-07:** Checklist §1 says "84 Prisma indexes/uniques" — actual **135** (81 `ix_*` + 54 unique; the "84" was a counting artifact of the Stage-1 scan pattern).
8. **D-08:** Stage-1 report/checklist state the file has "1,682 lines" — actual **1,936 physical lines** (1,682 non-empty; the counter used excludes blank lines).
9. **D-09:** Checklist §I and migration comments claim the Phase 3 schema has no `subtotal` column — false (see D-03).

**Inherent / accepted (no action):**

10. **D-10:** Prisma FK/index naming (`*_fkey`, `*_key`) differs from Phase 1 §1 conventions (`fk_*`, `uq_*`) — inherent to Prisma DDL; SQL-only objects do follow the conventions (OQ-B5 schema authoritative).
11. **D-11:** DDL-vs-P3-doc index-shape differences already reviewed and accepted under OQ-B5 (e.g., soft-delete dimension choices); unchanged by this review.
12. **D-12:** ON UPDATE action on the SQL-only composite FK is `RESTRICT` (L1921) while all Prisma FKs use `CASCADE` — the composite FK matches P3-06 §2.1 exactly; no defect (relevant context for §15 D1).

---

## 14. Recommended corrections (no changes made in this review — read-only mandate)

1. **Resolve F1 + F2 (single decision, D1).** The conflict is between (a) the approved generated columns / 5 CHECKs and (b) `CASCADE` FK actions. Resolution options:
   - **Option A (recommended):** change the affected FKs' referential actions to `RESTRICT` (both `ON UPDATE` and `ON DELETE` where a generated column's base column is involved; for the 5 CHECK-conflict FKs, at minimum the action clauses must go) **in the approved Prisma schema**, then regenerate the candidate SQL (G5 re-run) and re-review. This simultaneously:
     - satisfies both MySQL rules (RESTRICT/NO ACTION are not prohibited referential actions),
     - **aligns the DDL with Phase 3 `DATABASE_RELATIONSHIPS.md` L11 ("ON UPDATE is RESTRICT for all enforced FKs")**, closing discrepancy D-04/D-10 context,
     - and is behaviorally negligible because PKs are immutable UUIDs (never updated) and the schema is predominantly soft-delete (`deletedAt`) — but hard-DELETE cascade behavior on the affected relations would change (parents could no longer be deleted while children reference them; children would need explicit deletion first).
     - Affected FKs for F1: `categories.parent_id`, `product_variants.product_id`, `product_images.product_id`, `user_addresses.user_id`, `carts.user_id`, `wishlist_items.variant_id`, `coupon_applicability.{product,category,brand,collection}_id`, `invoice_records.order_id`, `idempotency_keys.user_id`. Affected for F2: `categories.parent_id`, `coupon_applicability.{product,category,brand,collection}_id`, `product_tax_assignments.{product,category}_id`, `invoice_records.{original_invoice_id,refund_id}`.
   - **Option B:** remove the 9 affected generated columns (+ their 9 unique indexes) and the 5 CHECKs — loses DB-enforced conditional uniqueness and DB-guarded invariants, contradicting Phase 1 principle P1/P7 ("DB is the final guard", race-safe uniqueness). Not recommended.
   - **Option C:** triggers — explicitly suggested by the MySQL community for this exact limitation, but triggers are not part of the approved design and add operational complexity. Not recommended without your explicit design change.
   - **Option D (secondary, to explore only if you reject A):** switch the 9 generated columns to **VIRTUAL** (the documented restriction names _stored_ generated columns; secondary indexes on virtual columns are supported in MySQL 8). This is a deviation from the approved "STORED" wording (Phase 1 §3.9/§23.6) and must be empirically confirmed at G7 before reliance.
   - **In every case:** the G7 dry run on a user-created scratch database must empirically confirm the final SQL applies cleanly.
2. **Correct F3 (D-03):** restore `subtotal >= 0` as the first term of `ck_orders_money` in the SQL-only section (single-line edit; no schema change), and fix comments L1841/L1926.
3. **Fix documentation (D-04…D-09)** in the checklist after the user decision (not part of this read-only review).
4. **Optionally strengthen REGEXP CHECKs** (W §7.5) with explicit case-sensitive collation if you want the DB backstop to reject lowercase — decision D6 in §15.

---

## 15. Questions that require your decision

| #      | Question                                                                                                                                                                                     | Recommendation        |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| **D1** | How to resolve F1/F2: Option A (schema FK actions → RESTRICT, regenerate SQL, re-review — aligns with Phase 3 doc), B (drop generated columns/CHECKs), C (triggers), or D (VIRTUAL columns)? | **Option A**          |
| **D2** | Confirm `tax_rates.cess_rate` remains omitted (not applied in v1), or approve adding the reserved column (schema change)?                                                                    | Remain omitted        |
| **D3** | Confirm `invoice_records` component sums stay in the `tax_transactions` ledger (omission of `ck_invoice_tax_sum` accepted)?                                                                  | Confirm omission      |
| **D4** | Confirm notification retry cap enforced as a service-layer constant (no `max_attempts` column)?                                                                                              | Confirm               |
| **D5** | Confirm `number_sequences` overflow guard enforced in service (no `max_value` column)?                                                                                                       | Confirm               |
| **D6** | Should REGEXP-based CHECKs be made explicitly case-sensitive (collation clause), accepting that they will otherwise likely accept lowercase under `utf8mb4_0900_ai_ci`?                      | Decide after G7 probe |
| **D7** | Confirm restoring `subtotal >= 0` in `ck_orders_money` (F3 correction)?                                                                                                                      | Yes — restore         |

---

## 16. Final G6 recommendation

**REVIEW COMPLETE — PENDING USER APPROVAL.**

- The Prisma-generated DDL portion (67 tables, 114 FKs, 135 index/unique lines, types, nullability, defaults, composite PKs) is faithful to the approved schema — **PASS**.
- The SQL-only section's 10 generated-column expressions, 13 unique-index definitions, and 71 of 75 CHECK expressions match the approved documentation verbatim; the 4 adaptations are traceable and (except #1) reasonable; the 3 omissions are properly declared — **PASS on content**.
- However, **the candidate must not be approved or applied in its current form**: findings **F1 (9 generated columns)** and **F2 (5 CHECKs)** violate documented MySQL 8.4 restrictions and are predicted to fail hard at G7, and **F3** is a factually-justified-incorrectly omission. A user decision (D1) plus the F3 correction are required, followed by regeneration of the candidate SQL and a re-review, before the G7 dry run.
- Per your instruction, this review does **not** grant G6 approval on your behalf.

### Status

- **G4: PASS** (previously completed — app-level `prisma.config.ts` verified).
- **G5: PASS — candidate SQL generated, not executed** (offline `migrate diff --from-empty`; no database connection was made then or now).
- **G6: REVIEW COMPLETE — PENDING USER APPROVAL** (approval to be decided by you after reviewing this report; corrections per §14 required first).
- **G7: NOT STARTED** (requires user-created scratch database per OQ-B7, plus G2, G3, and approved corrected SQL).
- **G2: NOT STARTED** (no independently documented backup/restore drill evidence exists).
- **G3: NOT STARTED** (no independently documented evidence that `ecommerce_migrator@localhost` exists).
- **Phase 4: IN PROGRESS — NOT APPROVED.**

— End of report. This review made no changes to any file other than creating this report, connected to no database, and executed no SQL.

---

## Addendum — Option A implementation record (2026-11-17, approved D8–D14)

After the owner approved the D8–D14 decision package (derived from this report's F1/F2/F3 findings and the pre-implementation Option A impact analysis), the following corrections were implemented **offline** (no database connection, no migration executed):

- **F1/F2 (17 unique FK constraints = 16 Prisma relations + 1 SQL-only composite FK):** all 114 Prisma FK relations now carry explicit `onUpdate: Restrict` (D9); the 10 approved `onDelete: Cascade → Restrict` flips applied (D9/D8 scope: `ProductVariant.product`, `ProductImage.product`, `UserAddress.user`, `Cart.user`, `WishlistItem.variant`, `CouponApplicability.product/category/brand/collection`, `IdempotencyKey.user`); the composite FK `fk_product_images_variant_product` is now `ON DELETE RESTRICT ON UPDATE RESTRICT` (D8). Post-correction DDL FK distribution: `ON UPDATE RESTRICT` ×114; `ON DELETE` = 29 CASCADE / 77 RESTRICT / 8 SET NULL.
- **F3:** `ck_orders_money` now includes `subtotal >= 0` (D13); the false "no subtotal column" claims were corrected in the migration comments and in `INCREMENT-B-BASELINE-SQL-REVIEW-CHECKLIST.md`.
- **Baseline regenerated offline** via `prisma migrate diff --from-empty --to-schema` (no DB connection); the corrected SQL-only section was re-appended; file is now 1943 lines.
- **P3-04 `DATABASE_RELATIONSHIPS.md` amended** per D10 (8 CASCADE rows → RESTRICT; §1 policy table + rationale updated).
- **D2–D5 omissions confirmed** per D11 (recorded in the migration's NOT-IMPLEMENTED items a–e and the checklist); **D12 (REGEXP case sensitivity) deferred to G7** — no collation changes.
- **Open risk (D8):** interaction between the composite FK (now RESTRICT) and the unchanged `ProductImage.variantId` CASCADE FK during variant delete — MySQL evaluation order undocumented; empirical G7 probe required (delete-variant-with-images). Possible follow-up to RESTRICT on `ProductImage.variant` is a separate future decision.
- **Validation:** `prisma format/validate/generate`, prettier `format:check`, eslint, `tsc` typecheck + build, vitest 9 files / 177 tests — all pass.

**Status after implementation: G6 RE-REVIEW REQUIRED (re-approval decision is yours); G7 PENDING; no migration executed; Increment B NOT complete; Phase 4 IN PROGRESS — NOT APPROVED.**

---

## Addendum 2 — Independent G6 re-review and owner acceptance (2026-11-17)

An independent, read-only re-review of the corrected Option A baseline was performed against the actual files (schema, migration SQL, migration lock, checklist, this report, plan, risk assessment, P3-04). All checks passed: 67 models / 50 enums / 47 distinct enum strings; 114 FK constraints, all `ON UPDATE RESTRICT`, `ON DELETE` 29 CASCADE / 77 RESTRICT / 8 SET NULL; 10/10 approved flips verified with schema and SQL line references; F1 satisfied for all 10 STORED generated columns; F2 satisfied for all 5 named CHECKs plus a full sweep of all 75 (0 violations); F3 restored with all money terms intact; all 13 SQL-only unique indexes, 10 generated columns, 75 CHECKs and the composite FK (RESTRICT/RESTRICT, referencing `uq_product_variants_id_product (id, product_id)` at DDL L424) present; no destructive SQL; no secrets; no FULLTEXT; ALTER census 213 with 0 unaccounted. Full findings and evidence are preserved in [`INCREMENT-B-G6-RE-REVIEW-ACCEPTANCE.md`](./INCREMENT-B-G6-RE-REVIEW-ACCEPTANCE.md).

**The project owner explicitly ACCEPTED the re-review recommendation on 2026-11-17:**

> **G6: PASS — CORRECTED CANDIDATE APPROVED FOR G7 PREPARATION.**

- The independent re-review findings and evidence remain preserved (see the re-review acceptance record above; the original §16 review findings are retained unchanged above).
- The cosmetic line-count discrepancy (1944 → **1943**) has been corrected in this report and in `INCREMENT-B-IMPLEMENTATION-PLAN.md`.
- **OPEN G7 VERIFICATION ITEM (unchanged):** the interaction between the unchanged direct `ProductImage.variantId` CASCADE FK (schema L863) and the composite FK `fk_product_images_variant_product` (now RESTRICT) during variant delete must be resolved empirically at G7 (delete-variant-with-images probe). No decision has been made on it.
- **G7 is NOT complete and NOT approved** — it remains pending on: the user-created scratch database (OQ-B7), the G2 backup/restore drill, and the G3 migration user.
- Increment B is IN PROGRESS (not complete). Phase 4 is IN PROGRESS — NOT APPROVED. Nothing has been applied or executed against `ecommerce_dev`.
