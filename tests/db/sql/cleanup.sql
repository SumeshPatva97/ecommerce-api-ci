-- DEC-12 real-database tests — data cleanup for `ecommerce_test` ONLY.
--
-- NOT EXECUTED — requires explicit owner authorization (DEC-12).
--
-- Used by tests/db/harness/cleanup.ts (parsed, allow-listed statement by statement) and runnable
-- by the owner with the mysql client against ecommerce_test:
--   mysql --defaults-extra-file=<git-ignored option file> ecommerce_test -e "source tests/db/sql/cleanup.sql"
--
-- * DML only (UPDATE / DELETE). No DROP, TRUNCATE, ALTER or CREATE: the test user has DML grants
--   on ecommerce_test only, and TRUNCATE would need the DROP privilege.
-- * Child tables are deleted before their parents (order computed from the baseline migration
--   foreign keys, prisma/migrations/20261117160425_baseline/migration.sql). Self-references with
--   ON DELETE RESTRICT are cleared first. `_prisma_migrations` is never touched.
-- * The first statement aborts the script (ERROR 1242, subquery returns more than 1 row) when the
--   current database is not exactly ecommerce_test — the mysql client stops at the first error.

SET @db_guard = (SELECT 1 FROM DUAL WHERE NOT (DATABASE() <=> 'ecommerce_test') UNION ALL SELECT 1 FROM DUAL WHERE NOT (DATABASE() <=> 'ecommerce_test'));

-- Self-referencing ON DELETE RESTRICT foreign keys.
UPDATE `categories` SET `parent_id` = NULL WHERE `parent_id` IS NOT NULL;
UPDATE `invoice_records` SET `original_invoice_id` = NULL WHERE `original_invoice_id` IS NOT NULL;

-- 67 tables, children first.
DELETE FROM `variant_attribute_values`;
DELETE FROM `product_attribute_values`;
DELETE FROM `attribute_values`;
DELETE FROM `category_attributes`;
DELETE FROM `attributes`;
DELETE FROM `audit_logs`;
DELETE FROM `banners`;
DELETE FROM `collection_products`;
DELETE FROM `product_images`;
DELETE FROM `inventory`;
DELETE FROM `inventory_transactions`;
DELETE FROM `stock_reservations`;
DELETE FROM `cart_items`;
DELETE FROM `wishlist_items`;
DELETE FROM `reviews`;
DELETE FROM `shipment_items`;
DELETE FROM `refund_items`;
DELETE FROM `tax_transactions`;
DELETE FROM `order_items`;
DELETE FROM `product_variants`;
DELETE FROM `recently_viewed_products`;
DELETE FROM `coupon_applicability`;
DELETE FROM `promotion_products`;
DELETE FROM `product_tax_assignments`;
DELETE FROM `products`;
DELETE FROM `promotion_brands`;
DELETE FROM `brands`;
DELETE FROM `carts`;
DELETE FROM `promotion_categories`;
DELETE FROM `cms_blocks`;
DELETE FROM `categories`;
DELETE FROM `cms_pages`;
DELETE FROM `promotion_collections`;
DELETE FROM `collections`;
DELETE FROM `coupon_usage`;
DELETE FROM `order_status_history`;
DELETE FROM `shipment_tracking_events`;
DELETE FROM `invoice_records`;
DELETE FROM `shipments`;
DELETE FROM `payment_transactions`;
DELETE FROM `refunds`;
DELETE FROM `payments`;
DELETE FROM `orders`;
DELETE FROM `coupons`;
DELETE FROM `hsn_codes`;
DELETE FROM `idempotency_keys`;
DELETE FROM `notification_logs`;
DELETE FROM `notification_preferences`;
DELETE FROM `notifications`;
DELETE FROM `notification_templates`;
DELETE FROM `number_sequences`;
DELETE FROM `role_permissions`;
DELETE FROM `user_permission_overrides`;
DELETE FROM `permissions`;
DELETE FROM `promotions`;
DELETE FROM `refresh_tokens`;
DELETE FROM `report_exports`;
DELETE FROM `user_roles`;
DELETE FROM `roles`;
DELETE FROM `settings`;
DELETE FROM `shipping_methods`;
DELETE FROM `user_addresses`;
DELETE FROM `states`;
DELETE FROM `tax_rates`;
DELETE FROM `verification_tokens`;
DELETE FROM `wishlists`;
DELETE FROM `users`;
