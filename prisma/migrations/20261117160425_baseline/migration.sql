-- CreateTable
CREATE TABLE `users` (
    `id` CHAR(36) NOT NULL,
    `account_type` ENUM('CUSTOMER', 'STAFF') NOT NULL,
    `email` VARCHAR(254) NOT NULL,
    `email_normalized` VARCHAR(254) NOT NULL,
    `phone` VARCHAR(16) NULL,
    `password_hash` VARCHAR(255) NULL,
    `password_changed_at` DATETIME(3) NULL,
    `first_name` VARCHAR(80) NOT NULL,
    `last_name` VARCHAR(80) NULL,
    `status` ENUM('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DISABLED') NOT NULL DEFAULT 'PENDING_VERIFICATION',
    `email_verified_at` DATETIME(3) NULL,
    `phone_verified_at` DATETIME(3) NULL,
    `is_superadmin` BOOLEAN NOT NULL DEFAULT false,
    `mfa_enabled` BOOLEAN NOT NULL DEFAULT false,
    `mfa_secret_encrypted` VARCHAR(255) NULL,
    `last_login_at` DATETIME(3) NULL,
    `last_login_ip` VARCHAR(45) NULL,
    `failed_login_count` INTEGER NOT NULL DEFAULT 0,
    `locked_until` DATETIME(3) NULL,
    `anonymized_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_by_id` CHAR(36) NULL,
    `updated_by_id` CHAR(36) NULL,
    `deleted_by_id` CHAR(36) NULL,

    UNIQUE INDEX `users_email_normalized_key`(`email_normalized`),
    UNIQUE INDEX `users_phone_key`(`phone`),
    INDEX `ix_users_type_status_created`(`account_type`, `status`, `created_at`),
    INDEX `ix_users_last_login`(`last_login_at`),
    INDEX `ix_users_superadmin`(`is_superadmin`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `roles` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(50) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `name_normalized` VARCHAR(100) NOT NULL,
    `description` VARCHAR(500) NULL,
    `is_system` BOOLEAN NOT NULL DEFAULT false,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by_id` CHAR(36) NULL,
    `updated_by_id` CHAR(36) NULL,

    UNIQUE INDEX `roles_code_key`(`code`),
    UNIQUE INDEX `roles_name_normalized_key`(`name_normalized`),
    INDEX `ix_roles_active`(`is_active`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `permissions` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(100) NOT NULL,
    `module` VARCHAR(50) NOT NULL,
    `action` VARCHAR(20) NOT NULL,
    `description` VARCHAR(255) NOT NULL,
    `is_critical` BOOLEAN NOT NULL DEFAULT false,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `is_deprecated` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `permissions_code_key`(`code`),
    UNIQUE INDEX `uq_permissions_module_action`(`module`, `action`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_roles` (
    `user_id` CHAR(36) NOT NULL,
    `role_id` CHAR(36) NOT NULL,
    `assigned_by_id` CHAR(36) NULL,
    `assigned_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_user_roles_role`(`role_id`),
    PRIMARY KEY (`user_id`, `role_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `role_permissions` (
    `role_id` CHAR(36) NOT NULL,
    `permission_id` CHAR(36) NOT NULL,
    `granted_by_id` CHAR(36) NULL,
    `granted_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_role_permissions_permission`(`permission_id`),
    PRIMARY KEY (`role_id`, `permission_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_permission_overrides` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `permission_id` CHAR(36) NOT NULL,
    `effect` ENUM('ALLOW', 'DENY') NOT NULL DEFAULT 'DENY',
    `reason` VARCHAR(500) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by_id` CHAR(36) NULL,
    `updated_by_id` CHAR(36) NULL,

    INDEX `ix_upo_permission`(`permission_id`),
    UNIQUE INDEX `uq_upo_user_permission`(`user_id`, `permission_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_addresses` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `label` VARCHAR(30) NULL,
    `full_name` VARCHAR(120) NOT NULL,
    `phone` VARCHAR(16) NOT NULL,
    `line1` VARCHAR(200) NOT NULL,
    `line2` VARCHAR(200) NULL,
    `landmark` VARCHAR(120) NULL,
    `city` VARCHAR(100) NOT NULL,
    `district` VARCHAR(100) NULL,
    `state_code` CHAR(2) NOT NULL,
    `postal_code` CHAR(6) NOT NULL,
    `country_code` CHAR(2) NOT NULL DEFAULT 'IN',
    `company_name` VARCHAR(150) NULL,
    `gstin` VARCHAR(15) NULL,
    `is_default` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `ix_user_addresses_user`(`user_id`, `is_default`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `refresh_tokens` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `family_id` CHAR(36) NOT NULL,
    `token_hash` CHAR(64) NOT NULL,
    `audience` ENUM('STOREFRONT', 'ADMIN') NOT NULL,
    `replaced_by_id` CHAR(36) NULL,
    `issued_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expires_at` DATETIME(3) NOT NULL,
    `absolute_expires_at` DATETIME(3) NOT NULL,
    `last_used_at` DATETIME(3) NULL,
    `revoked_at` DATETIME(3) NULL,
    `revoked_reason` VARCHAR(40) NULL,
    `ip_address` VARCHAR(45) NULL,
    `user_agent` VARCHAR(255) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `refresh_tokens_token_hash_key`(`token_hash`),
    INDEX `ix_refresh_tokens_user_active`(`user_id`, `revoked_at`),
    INDEX `ix_refresh_tokens_family`(`family_id`),
    INDEX `ix_refresh_tokens_expires`(`expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `verification_tokens` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `purpose` ENUM('EMAIL_VERIFICATION', 'PHONE_VERIFICATION', 'PASSWORD_RESET', 'STAFF_INVITE', 'LOGIN_OTP') NOT NULL,
    `channel` ENUM('EMAIL', 'WHATSAPP', 'SMS', 'IN_APP') NOT NULL,
    `target` VARCHAR(254) NOT NULL,
    `token_hash` CHAR(64) NOT NULL,
    `attempt_count` INTEGER NOT NULL DEFAULT 0,
    `max_attempts` INTEGER NOT NULL DEFAULT 5,
    `expires_at` DATETIME(3) NOT NULL,
    `consumed_at` DATETIME(3) NULL,
    `invalidated_at` DATETIME(3) NULL,
    `ip_address` VARCHAR(45) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `verification_tokens_token_hash_key`(`token_hash`),
    INDEX `ix_verification_tokens_user_purpose`(`user_id`, `purpose`, `created_at`),
    INDEX `ix_verification_tokens_expires`(`expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notification_preferences` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `channel` ENUM('EMAIL', 'WHATSAPP', 'SMS', 'IN_APP') NOT NULL,
    `category` ENUM('TRANSACTIONAL', 'MARKETING', 'STAFF_ALERTS') NOT NULL,
    `is_opted_in` BOOLEAN NOT NULL,
    `consent_source` VARCHAR(40) NULL,
    `consent_text_version` VARCHAR(20) NULL,
    `consented_at` DATETIME(3) NULL,
    `opted_out_at` DATETIME(3) NULL,
    `ip_address` VARCHAR(45) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_notification_prefs`(`user_id`, `channel`, `category`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `categories` (
    `id` CHAR(36) NOT NULL,
    `parent_id` CHAR(36) NULL,
    `name` VARCHAR(120) NOT NULL,
    `name_normalized` VARCHAR(120) NOT NULL,
    `slug` VARCHAR(160) NOT NULL,
    `path` VARCHAR(120) NOT NULL,
    `depth` TINYINT NOT NULL,
    `description` TEXT NULL,
    `image_url` VARCHAR(500) NULL,
    `image_public_id` VARCHAR(255) NULL,
    `banner_image_url` VARCHAR(500) NULL,
    `banner_image_public_id` VARCHAR(255) NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `show_in_menu` BOOLEAN NOT NULL DEFAULT true,
    `seo_title` VARCHAR(160) NULL,
    `seo_description` VARCHAR(320) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_by_id` CHAR(36) NULL,
    `updated_by_id` CHAR(36) NULL,
    `deleted_by_id` CHAR(36) NULL,

    UNIQUE INDEX `categories_slug_key`(`slug`),
    INDEX `ix_categories_parent_sort`(`parent_id`, `sort_order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `category_attributes` (
    `category_id` CHAR(36) NOT NULL,
    `attribute_id` CHAR(36) NOT NULL,
    `is_required` BOOLEAN NOT NULL DEFAULT false,
    `is_variant_axis_default` BOOLEAN NOT NULL DEFAULT false,
    `inherit_to_children` BOOLEAN NOT NULL DEFAULT true,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `ix_category_attributes_attr`(`attribute_id`),
    PRIMARY KEY (`category_id`, `attribute_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `brands` (
    `id` CHAR(36) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `name_normalized` VARCHAR(120) NOT NULL,
    `slug` VARCHAR(160) NOT NULL,
    `description` TEXT NULL,
    `logo_url` VARCHAR(500) NULL,
    `logo_public_id` VARCHAR(255) NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `is_featured` BOOLEAN NOT NULL DEFAULT false,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `seo_title` VARCHAR(160) NULL,
    `seo_description` VARCHAR(320) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    UNIQUE INDEX `brands_name_normalized_key`(`name_normalized`),
    UNIQUE INDEX `brands_slug_key`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `collections` (
    `id` CHAR(36) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `name_normalized` VARCHAR(120) NOT NULL,
    `slug` VARCHAR(160) NOT NULL,
    `description` TEXT NULL,
    `banner_image_url` VARCHAR(500) NULL,
    `banner_image_public_id` VARCHAR(255) NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `is_featured` BOOLEAN NOT NULL DEFAULT false,
    `starts_at` DATETIME(3) NULL,
    `ends_at` DATETIME(3) NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `seo_title` VARCHAR(160) NULL,
    `seo_description` VARCHAR(320) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    UNIQUE INDEX `collections_name_normalized_key`(`name_normalized`),
    UNIQUE INDEX `collections_slug_key`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `collection_products` (
    `collection_id` CHAR(36) NOT NULL,
    `product_id` CHAR(36) NOT NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `added_by_id` CHAR(36) NULL,
    `added_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_collection_products_product`(`product_id`),
    PRIMARY KEY (`collection_id`, `product_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `products` (
    `id` CHAR(36) NOT NULL,
    `product_type` ENUM('SIMPLE', 'VARIABLE') NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `name_normalized` VARCHAR(200) NOT NULL,
    `slug` VARCHAR(160) NOT NULL,
    `category_id` CHAR(36) NOT NULL,
    `brand_id` CHAR(36) NULL,
    `short_description` VARCHAR(500) NULL,
    `description` MEDIUMTEXT NULL,
    `care_instructions` TEXT NULL,
    `search_keywords` VARCHAR(500) NULL,
    `status` ENUM('DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED') NOT NULL DEFAULT 'DRAFT',
    `is_featured` BOOLEAN NOT NULL DEFAULT false,
    `is_new_arrival` BOOLEAN NOT NULL DEFAULT false,
    `is_best_seller_pinned` BOOLEAN NOT NULL DEFAULT false,
    `published_at` DATETIME(3) NULL,
    `hsn_code` VARCHAR(8) NULL,
    `min_selling_price` DECIMAL(12, 2) NULL,
    `max_selling_price` DECIMAL(12, 2) NULL,
    `max_discount_percent` DECIMAL(5, 2) NOT NULL DEFAULT 0,
    `is_in_stock` BOOLEAN NOT NULL DEFAULT false,
    `avg_rating` DECIMAL(3, 2) NOT NULL DEFAULT 0,
    `review_count` INTEGER NOT NULL DEFAULT 0,
    `total_sold` INTEGER NOT NULL DEFAULT 0,
    `country_of_origin` VARCHAR(80) NULL,
    `manufacturer_name` VARCHAR(150) NULL,
    `manufacturer_address` TEXT NULL,
    `importer_name` VARCHAR(150) NULL,
    `importer_address` TEXT NULL,
    `seo_title` VARCHAR(160) NULL,
    `seo_description` VARCHAR(320) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_by_id` CHAR(36) NULL,
    `updated_by_id` CHAR(36) NULL,
    `deleted_by_id` CHAR(36) NULL,

    UNIQUE INDEX `products_slug_key`(`slug`),
    INDEX `ix_products_listing_cat`(`status`, `category_id`, `published_at`),
    INDEX `ix_products_listing_price`(`status`, `min_selling_price`),
    INDEX `ix_products_listing_sold`(`status`, `total_sold`),
    INDEX `ix_products_listing_rating`(`status`, `avg_rating`),
    INDEX `ix_products_brand`(`brand_id`, `status`),
    INDEX `ix_products_featured`(`status`, `is_featured`, `published_at`),
    INDEX `ix_products_hsn`(`hsn_code`),
    UNIQUE INDEX `uq_products_category_name`(`category_id`, `name_normalized`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `product_images` (
    `id` CHAR(36) NOT NULL,
    `product_id` CHAR(36) NOT NULL,
    `variant_id` CHAR(36) NULL,
    `cloudinary_public_id` VARCHAR(255) NOT NULL,
    `url` VARCHAR(500) NOT NULL,
    `alt_text` VARCHAR(200) NULL,
    `width` INTEGER NULL,
    `height` INTEGER NULL,
    `format` VARCHAR(10) NULL,
    `bytes` INTEGER NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `is_primary` BOOLEAN NOT NULL DEFAULT false,
    `media_type` ENUM('IMAGE', 'VIDEO') NOT NULL DEFAULT 'IMAGE',
    `video_url` VARCHAR(500) NULL,
    `video_public_id` VARCHAR(255) NULL,
    `poster_public_id` VARCHAR(255) NULL,
    `duration_seconds` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by_id` CHAR(36) NULL,
    `updated_by_id` CHAR(36) NULL,

    INDEX `ix_product_images_gallery`(`product_id`, `variant_id`, `sort_order`),
    INDEX `ix_product_images_variant`(`variant_id`),
    UNIQUE INDEX `uq_product_images_public_id`(`product_id`, `cloudinary_public_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `product_variants` (
    `id` CHAR(36) NOT NULL,
    `product_id` CHAR(36) NOT NULL,
    `sku` VARCHAR(32) NOT NULL,
    `barcode` VARCHAR(64) NULL,
    `name` VARCHAR(200) NOT NULL,
    `combination_key` VARCHAR(400) NOT NULL,
    `mrp` DECIMAL(12, 2) NOT NULL,
    `selling_price` DECIMAL(12, 2) NOT NULL,
    `compare_at_price` DECIMAL(12, 2) NULL,
    `cost_price` DECIMAL(12, 2) NULL,
    `weight_grams` DECIMAL(10, 3) NULL,
    `length_mm` INTEGER NULL,
    `width_mm` INTEGER NULL,
    `height_mm` INTEGER NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `is_default` BOOLEAN NOT NULL DEFAULT false,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_by_id` CHAR(36) NULL,
    `updated_by_id` CHAR(36) NULL,
    `deleted_by_id` CHAR(36) NULL,

    UNIQUE INDEX `product_variants_sku_key`(`sku`),
    UNIQUE INDEX `product_variants_barcode_key`(`barcode`),
    INDEX `ix_product_variants_product`(`product_id`, `status`, `sort_order`),
    INDEX `ix_product_variants_price`(`status`, `selling_price`),
    UNIQUE INDEX `uq_product_variants_id_product`(`id`, `product_id`),
    UNIQUE INDEX `uq_product_variants_combination`(`product_id`, `combination_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `attributes` (
    `id` CHAR(36) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `name_normalized` VARCHAR(80) NOT NULL,
    `code` VARCHAR(50) NOT NULL,
    `display_type` ENUM('TEXT', 'SWATCH', 'BUTTON', 'DROPDOWN') NOT NULL DEFAULT 'BUTTON',
    `is_variant_axis` BOOLEAN NOT NULL DEFAULT false,
    `is_filterable` BOOLEAN NOT NULL DEFAULT false,
    `is_visible_on_pdp` BOOLEAN NOT NULL DEFAULT true,
    `unit` VARCHAR(20) NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    UNIQUE INDEX `attributes_name_normalized_key`(`name_normalized`),
    UNIQUE INDEX `attributes_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `attribute_values` (
    `id` CHAR(36) NOT NULL,
    `attribute_id` CHAR(36) NOT NULL,
    `value` VARCHAR(100) NOT NULL,
    `value_normalized` VARCHAR(100) NOT NULL,
    `slug` VARCHAR(120) NOT NULL,
    `swatch_hex` CHAR(7) NULL,
    `swatch_image_url` VARCHAR(500) NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    INDEX `ix_attribute_values_sort`(`attribute_id`, `is_active`, `sort_order`),
    UNIQUE INDEX `uq_attribute_values_attr_value`(`attribute_id`, `value_normalized`),
    UNIQUE INDEX `uq_attribute_values_attr_slug`(`attribute_id`, `slug`),
    UNIQUE INDEX `uq_attribute_values_attr_id`(`attribute_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `variant_attribute_values` (
    `variant_id` CHAR(36) NOT NULL,
    `attribute_id` CHAR(36) NOT NULL,
    `attribute_value_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_vav_value_variant`(`attribute_value_id`, `variant_id`),
    PRIMARY KEY (`variant_id`, `attribute_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `product_attribute_values` (
    `product_id` CHAR(36) NOT NULL,
    `attribute_value_id` CHAR(36) NOT NULL,
    `attribute_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_pav_value_product`(`attribute_value_id`, `product_id`),
    INDEX `ix_pav_attr_product`(`attribute_id`, `product_id`),
    PRIMARY KEY (`product_id`, `attribute_value_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inventory` (
    `variant_id` CHAR(36) NOT NULL,
    `quantity_on_hand` INTEGER NOT NULL DEFAULT 0,
    `quantity_reserved` INTEGER NOT NULL DEFAULT 0,
    `low_stock_threshold` INTEGER NULL,
    `low_stock_alerted_at` DATETIME(3) NULL,
    `last_movement_at` DATETIME(3) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `updated_at` DATETIME(3) NOT NULL,
    `updated_by_id` CHAR(36) NULL,

    PRIMARY KEY (`variant_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inventory_transactions` (
    `id` CHAR(36) NOT NULL,
    `variant_id` CHAR(36) NOT NULL,
    `type` ENUM('STOCK_IN', 'STOCK_OUT', 'ADJUSTMENT_INCREASE', 'ADJUSTMENT_DECREASE', 'ORDER_DEDUCTION', 'CANCELLATION_RESTORE', 'RETURN_RESTORE', 'RESERVATION', 'RESERVATION_RELEASE') NOT NULL,
    `on_hand_delta` INTEGER NOT NULL DEFAULT 0,
    `reserved_delta` INTEGER NOT NULL DEFAULT 0,
    `on_hand_after` INTEGER NOT NULL,
    `reserved_after` INTEGER NOT NULL,
    `reason_code` VARCHAR(40) NULL,
    `note` VARCHAR(500) NULL,
    `unit_cost` DECIMAL(12, 2) NULL,
    `order_id` CHAR(36) NULL,
    `refund_id` CHAR(36) NULL,
    `stock_reservation_id` CHAR(36) NULL,
    `batch_id` CHAR(36) NULL,
    `created_by_id` CHAR(36) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_inv_txn_variant_time`(`variant_id`, `created_at`),
    INDEX `ix_inv_txn_type_time`(`type`, `created_at`),
    INDEX `ix_inv_txn_order`(`order_id`),
    INDEX `ix_inv_txn_refund`(`refund_id`),
    INDEX `ix_inv_txn_reservation`(`stock_reservation_id`),
    INDEX `ix_inv_txn_batch`(`batch_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_reservations` (
    `id` CHAR(36) NOT NULL,
    `order_id` CHAR(36) NOT NULL,
    `variant_id` CHAR(36) NOT NULL,
    `quantity` INTEGER NOT NULL,
    `status` ENUM('ACTIVE', 'COMMITTED', 'RELEASED', 'EXPIRED') NOT NULL DEFAULT 'ACTIVE',
    `expires_at` DATETIME(3) NOT NULL,
    `committed_at` DATETIME(3) NULL,
    `released_at` DATETIME(3) NULL,
    `release_reason` VARCHAR(40) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `ix_stock_reservations_sweep`(`status`, `expires_at`),
    INDEX `ix_stock_reservations_variant`(`variant_id`, `status`),
    UNIQUE INDEX `uq_stock_reservations_order_variant`(`order_id`, `variant_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `carts` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `status` ENUM('ACTIVE', 'CONVERTED', 'ABANDONED') NOT NULL DEFAULT 'ACTIVE',
    `coupon_id` CHAR(36) NULL,
    `coupon_code` VARCHAR(32) NULL,
    `converted_order_id` CHAR(36) NULL,
    `last_activity_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `abandoned_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `ix_carts_user_status`(`user_id`, `status`),
    INDEX `ix_carts_abandon`(`status`, `last_activity_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cart_items` (
    `id` CHAR(36) NOT NULL,
    `cart_id` CHAR(36) NOT NULL,
    `variant_id` CHAR(36) NOT NULL,
    `quantity` INTEGER NOT NULL DEFAULT 1,
    `unit_price_at_add` DECIMAL(12, 2) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `ix_cart_items_variant`(`variant_id`),
    UNIQUE INDEX `uq_cart_items_cart_variant`(`cart_id`, `variant_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `wishlists` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `name` VARCHAR(80) NOT NULL DEFAULT 'My Wishlist',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `wishlists_user_id_key`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `wishlist_items` (
    `id` CHAR(36) NOT NULL,
    `wishlist_id` CHAR(36) NOT NULL,
    `product_id` CHAR(36) NOT NULL,
    `variant_id` CHAR(36) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_wishlist_items_product`(`product_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `recently_viewed_products` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `product_id` CHAR(36) NOT NULL,
    `viewed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `view_count` INTEGER NOT NULL DEFAULT 1,

    INDEX `ix_rvp_user_viewed`(`user_id`, `viewed_at`),
    UNIQUE INDEX `uq_rvp_user_product`(`user_id`, `product_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `reviews` (
    `id` CHAR(36) NOT NULL,
    `product_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `order_item_id` CHAR(36) NOT NULL,
    `rating` INTEGER NOT NULL,
    `title` VARCHAR(150) NULL,
    `body` TEXT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `moderated_by_id` CHAR(36) NULL,
    `moderated_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    INDEX `ix_reviews_product_status`(`product_id`, `status`, `created_at`),
    UNIQUE INDEX `uq_reviews_product_user`(`product_id`, `user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `orders` (
    `id` CHAR(36) NOT NULL,
    `order_number` VARCHAR(20) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `status` ENUM('PENDING_PAYMENT', 'PAYMENT_FAILED', 'CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLATION_REQUESTED', 'CANCELLED', 'RETURN_REQUESTED', 'RETURNED') NOT NULL,
    `payment_method` ENUM('ONLINE', 'COD') NOT NULL,
    `payment_status` ENUM('PENDING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELLED', 'PARTIALLY_REFUNDED', 'REFUNDED') NOT NULL,
    `currency` CHAR(3) NOT NULL DEFAULT 'INR',
    `item_count` INTEGER NOT NULL,
    `total_quantity` INTEGER NOT NULL,
    `subtotal` DECIMAL(12, 2) NOT NULL,
    `item_discount_total` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `coupon_discount_total` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `shipping_charge` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `shipping_discount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `cod_charge` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `taxable_total` DECIMAL(12, 2) NOT NULL,
    `cgst_total` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `sgst_total` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `utgst_total` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `igst_total` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `tax_total` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `round_off` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `grand_total` DECIMAL(12, 2) NOT NULL,
    `refunded_total` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `prices_include_tax` BOOLEAN NOT NULL,
    `coupon_id` CHAR(36) NULL,
    `coupon_code_snapshot` VARCHAR(32) NULL,
    `shipping_method_id` CHAR(36) NULL,
    `shipping_method_name_snapshot` VARCHAR(100) NULL,
    `supply_type` ENUM('INTRA_STATE', 'INTER_STATE') NOT NULL,
    `place_of_supply_state_code` CHAR(2) NOT NULL,
    `seller_gstin_snapshot` VARCHAR(15) NULL,
    `seller_state_code_snapshot` CHAR(2) NOT NULL,
    `buyer_gstin` VARCHAR(15) NULL,
    `buyer_legal_name` VARCHAR(150) NULL,
    `customer_name_snapshot` VARCHAR(160) NOT NULL,
    `customer_email_snapshot` VARCHAR(254) NOT NULL,
    `customer_phone_snapshot` VARCHAR(16) NULL,
    `billing_address_snapshot` JSON NOT NULL,
    `shipping_address_snapshot` JSON NOT NULL,
    `pricing_context` JSON NOT NULL,
    `customer_note` VARCHAR(500) NULL,
    `reservation_expires_at` DATETIME(3) NULL,
    `placed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `confirmed_at` DATETIME(3) NULL,
    `shipped_at` DATETIME(3) NULL,
    `delivered_at` DATETIME(3) NULL,
    `cancellation_requested_at` DATETIME(3) NULL,
    `cancelled_at` DATETIME(3) NULL,
    `cancelled_by_id` CHAR(36) NULL,
    `cancellation_reason` VARCHAR(500) NULL,
    `ip_address` VARCHAR(45) NULL,
    `user_agent` VARCHAR(255) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `orders_order_number_key`(`order_number`),
    INDEX `ix_orders_user_placed`(`user_id`, `placed_at`),
    INDEX `ix_orders_status_placed`(`status`, `placed_at`),
    INDEX `ix_orders_payment_status`(`payment_status`, `placed_at`),
    INDEX `ix_orders_confirmed`(`confirmed_at`, `status`),
    INDEX `ix_orders_pos_confirmed`(`place_of_supply_state_code`, `confirmed_at`),
    INDEX `ix_orders_reservation`(`status`, `reservation_expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `order_items` (
    `id` CHAR(36) NOT NULL,
    `order_id` CHAR(36) NOT NULL,
    `line_no` INTEGER NOT NULL,
    `product_id` CHAR(36) NOT NULL,
    `variant_id` CHAR(36) NOT NULL,
    `product_name` VARCHAR(200) NOT NULL,
    `variant_name` VARCHAR(200) NULL,
    `sku` VARCHAR(32) NOT NULL,
    `barcode` VARCHAR(64) NULL,
    `attributes_snapshot` JSON NOT NULL,
    `image_url` VARCHAR(500) NULL,
    `category_id_snapshot` CHAR(36) NOT NULL,
    `category_name_snapshot` VARCHAR(120) NOT NULL,
    `brand_id_snapshot` CHAR(36) NULL,
    `brand_name_snapshot` VARCHAR(120) NULL,
    `hsn_code` VARCHAR(8) NOT NULL,
    `quantity` INTEGER NOT NULL,
    `mrp` DECIMAL(12, 2) NOT NULL,
    `unit_price` DECIMAL(12, 2) NOT NULL,
    `promotion_id` CHAR(36) NULL,
    `promotion_name_snapshot` VARCHAR(150) NULL,
    `promotion_discount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `coupon_discount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `taxable_value` DECIMAL(12, 2) NOT NULL,
    `tax_rate` DECIMAL(5, 2) NOT NULL,
    `cgst_rate` DECIMAL(5, 2) NOT NULL DEFAULT 0,
    `cgst_amount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `sgst_rate` DECIMAL(5, 2) NOT NULL DEFAULT 0,
    `sgst_amount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `utgst_rate` DECIMAL(5, 2) NOT NULL DEFAULT 0,
    `utgst_amount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `igst_rate` DECIMAL(5, 2) NOT NULL DEFAULT 0,
    `igst_amount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `tax_amount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `line_total` DECIMAL(12, 2) NOT NULL,
    `tax_rate_id_snapshot` CHAR(36) NULL,
    `cost_price_snapshot` DECIMAL(12, 2) NULL,
    `weight_grams_snapshot` DECIMAL(10, 3) NULL,
    `quantity_shipped` INTEGER NOT NULL DEFAULT 0,
    `quantity_cancelled` INTEGER NOT NULL DEFAULT 0,
    `quantity_refunded` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `ix_order_items_variant_time`(`variant_id`, `created_at`),
    INDEX `ix_order_items_product_time`(`product_id`, `created_at`),
    UNIQUE INDEX `uq_order_items_line`(`order_id`, `line_no`),
    UNIQUE INDEX `uq_order_items_variant`(`order_id`, `variant_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `order_status_history` (
    `id` CHAR(36) NOT NULL,
    `order_id` CHAR(36) NOT NULL,
    `event_type` ENUM('STATUS_CHANGE', 'NOTE') NOT NULL DEFAULT 'STATUS_CHANGE',
    `from_status` ENUM('PENDING_PAYMENT', 'PAYMENT_FAILED', 'CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLATION_REQUESTED', 'CANCELLED', 'RETURN_REQUESTED', 'RETURNED') NULL,
    `to_status` ENUM('PENDING_PAYMENT', 'PAYMENT_FAILED', 'CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLATION_REQUESTED', 'CANCELLED', 'RETURN_REQUESTED', 'RETURNED') NULL,
    `note` VARCHAR(1000) NULL,
    `is_customer_visible` BOOLEAN NOT NULL DEFAULT true,
    `actor_type` ENUM('CUSTOMER', 'STAFF', 'SYSTEM', 'WEBHOOK') NOT NULL,
    `actor_user_id` CHAR(36) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_osh_order_time`(`order_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shipping_methods` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(50) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `name_normalized` VARCHAR(100) NOT NULL,
    `description` VARCHAR(500) NULL,
    `rate_type` ENUM('FLAT', 'FREE_ABOVE', 'WEIGHT_BASED', 'ZONE_BASED') NOT NULL,
    `base_charge` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `free_above_amount` DECIMAL(12, 2) NULL,
    `eta_min_days` INTEGER NULL,
    `eta_max_days` INTEGER NULL,
    `cod_supported` BOOLEAN NOT NULL DEFAULT false,
    `cod_charge` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    UNIQUE INDEX `shipping_methods_code_key`(`code`),
    UNIQUE INDEX `shipping_methods_name_normalized_key`(`name_normalized`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shipments` (
    `id` CHAR(36) NOT NULL,
    `shipment_number` VARCHAR(20) NOT NULL,
    `order_id` CHAR(36) NOT NULL,
    `shipping_method_id` CHAR(36) NULL,
    `status` ENUM('PENDING', 'READY_TO_SHIP', 'SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'DELIVERY_FAILED', 'RTO_INITIATED', 'RTO_DELIVERED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `provider` VARCHAR(30) NULL,
    `awb_number` VARCHAR(100) NULL,
    `shipped_at` DATETIME(3) NULL,
    `delivered_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `shipments_shipment_number_key`(`shipment_number`),
    INDEX `ix_shipments_order`(`order_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shipment_items` (
    `shipment_id` CHAR(36) NOT NULL,
    `order_item_id` CHAR(36) NOT NULL,
    `quantity` INTEGER NOT NULL,

    PRIMARY KEY (`shipment_id`, `order_item_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shipment_tracking_events` (
    `id` CHAR(36) NOT NULL,
    `shipment_id` CHAR(36) NOT NULL,
    `mapped_status` ENUM('PENDING', 'READY_TO_SHIP', 'SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'DELIVERY_FAILED', 'RTO_INITIATED', 'RTO_DELIVERED', 'CANCELLED') NOT NULL,
    `provider_status` VARCHAR(100) NULL,
    `message` VARCHAR(500) NULL,
    `location` VARCHAR(200) NULL,
    `dedupe_hash` CHAR(64) NOT NULL,
    `source` ENUM('CUSTOMER', 'STAFF', 'SYSTEM', 'WEBHOOK') NOT NULL DEFAULT 'WEBHOOK',
    `event_at` DATETIME(3) NOT NULL,
    `payload` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_tracking_shipment_time`(`shipment_id`, `event_at`),
    UNIQUE INDEX `uq_tracking_dedupe`(`shipment_id`, `dedupe_hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payments` (
    `id` CHAR(36) NOT NULL,
    `order_id` CHAR(36) NOT NULL,
    `attempt_no` INTEGER NOT NULL DEFAULT 1,
    `payment_method` ENUM('ONLINE', 'COD') NOT NULL,
    `status` ENUM('PENDING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELLED', 'PARTIALLY_REFUNDED', 'REFUNDED') NOT NULL DEFAULT 'PENDING',
    `provider` VARCHAR(30) NULL,
    `provider_order_id` VARCHAR(100) NULL,
    `provider_payment_id` VARCHAR(100) NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `amount_refunded` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `currency` CHAR(3) NOT NULL DEFAULT 'INR',
    `instrument_type` VARCHAR(30) NULL,
    `failure_code` VARCHAR(60) NULL,
    `failure_reason` VARCHAR(500) NULL,
    `authorized_at` DATETIME(3) NULL,
    `captured_at` DATETIME(3) NULL,
    `failed_at` DATETIME(3) NULL,
    `expires_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `ix_payments_status_time`(`status`, `created_at`),
    UNIQUE INDEX `uq_payments_order_attempt`(`order_id`, `attempt_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_transactions` (
    `id` CHAR(36) NOT NULL,
    `payment_id` CHAR(36) NOT NULL,
    `refund_id` CHAR(36) NULL,
    `type` ENUM('CREATE_ORDER', 'AUTHORIZE', 'CAPTURE', 'FAIL', 'REFUND', 'WEBHOOK') NOT NULL,
    `provider` VARCHAR(30) NULL,
    `provider_event_id` VARCHAR(100) NULL,
    `provider_reference` VARCHAR(100) NULL,
    `provider_status` VARCHAR(40) NULL,
    `amount` DECIMAL(12, 2) NULL,
    `signature_verified` BOOLEAN NOT NULL DEFAULT false,
    `http_status` INTEGER NULL,
    `error_code` VARCHAR(60) NULL,
    `error_message` VARCHAR(500) NULL,
    `request_payload` JSON NULL,
    `response_payload` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_payment_txn_payment_time`(`payment_id`, `created_at`),
    INDEX `ix_payment_txn_refund`(`refund_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `refunds` (
    `id` CHAR(36) NOT NULL,
    `refund_number` VARCHAR(20) NOT NULL,
    `order_id` CHAR(36) NOT NULL,
    `payment_id` CHAR(36) NULL,
    `status` ENUM('REQUESTED', 'APPROVED', 'REJECTED', 'PROCESSING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'REQUESTED',
    `method` ENUM('ORIGINAL_PAYMENT_METHOD', 'BANK_TRANSFER', 'STORE_CREDIT') NOT NULL DEFAULT 'ORIGINAL_PAYMENT_METHOD',
    `reason_code` VARCHAR(40) NOT NULL,
    `reason_text` VARCHAR(1000) NULL,
    `items_amount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `shipping_amount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `amount` DECIMAL(12, 2) NOT NULL,
    `taxable_value` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `tax_amount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `restock` BOOLEAN NOT NULL DEFAULT false,
    `requested_by_type` ENUM('CUSTOMER', 'STAFF', 'SYSTEM', 'WEBHOOK') NOT NULL,
    `requested_by_id` CHAR(36) NULL,
    `approved_by_id` CHAR(36) NULL,
    `approved_at` DATETIME(3) NULL,
    `rejected_by_id` CHAR(36) NULL,
    `rejected_at` DATETIME(3) NULL,
    `rejection_reason` VARCHAR(500) NULL,
    `provider_refund_id` VARCHAR(100) NULL,
    `payout_reference` VARCHAR(100) NULL,
    `processing_at` DATETIME(3) NULL,
    `completed_at` DATETIME(3) NULL,
    `failed_at` DATETIME(3) NULL,
    `failure_reason` VARCHAR(500) NULL,
    `retry_count` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `refunds_refund_number_key`(`refund_number`),
    INDEX `ix_refunds_order`(`order_id`),
    INDEX `ix_refunds_status_time`(`status`, `created_at`),
    INDEX `ix_refunds_completed`(`completed_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `refund_items` (
    `id` CHAR(36) NOT NULL,
    `refund_id` CHAR(36) NOT NULL,
    `order_item_id` CHAR(36) NOT NULL,
    `quantity` INTEGER NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `taxable_value` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `tax_amount` DECIMAL(12, 2) NOT NULL DEFAULT 0,

    UNIQUE INDEX `uq_refund_items_refund_line`(`refund_id`, `order_item_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `coupons` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(32) NOT NULL,
    `code_normalized` VARCHAR(32) NOT NULL,
    `description` VARCHAR(500) NULL,
    `discount_type` ENUM('PERCENTAGE', 'FIXED_AMOUNT') NOT NULL,
    `discount_value` DECIMAL(12, 2) NOT NULL,
    `max_discount_amount` DECIMAL(12, 2) NULL,
    `min_order_value` DECIMAL(12, 2) NULL,
    `starts_at` DATETIME(3) NULL,
    `expires_at` DATETIME(3) NULL,
    `usage_limit_enabled` BOOLEAN NOT NULL DEFAULT false,
    `usage_limit` INTEGER NULL,
    `per_customer_limit` INTEGER NULL,
    `used_count` INTEGER NOT NULL DEFAULT 0,
    `is_first_order_only` BOOLEAN NOT NULL DEFAULT false,
    `is_combinable_with_promotions` BOOLEAN NOT NULL DEFAULT false,
    `is_public` BOOLEAN NOT NULL DEFAULT false,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    UNIQUE INDEX `coupons_code_normalized_key`(`code_normalized`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `coupon_applicability` (
    `id` CHAR(36) NOT NULL,
    `coupon_id` CHAR(36) NOT NULL,
    `rule_type` ENUM('INCLUDE', 'EXCLUDE') NOT NULL,
    `target_type` ENUM('PRODUCT', 'CATEGORY', 'BRAND', 'COLLECTION') NOT NULL,
    `product_id` CHAR(36) NULL,
    `category_id` CHAR(36) NULL,
    `brand_id` CHAR(36) NULL,
    `collection_id` CHAR(36) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `coupon_usage` (
    `id` CHAR(36) NOT NULL,
    `coupon_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `order_id` CHAR(36) NOT NULL,
    `status` ENUM('RESERVED', 'REDEEMED', 'RELEASED') NOT NULL DEFAULT 'RESERVED',
    `discount_amount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `reserved_at` DATETIME(3) NULL,
    `redeemed_at` DATETIME(3) NULL,
    `released_at` DATETIME(3) NULL,

    UNIQUE INDEX `coupon_usage_order_id_key`(`order_id`),
    INDEX `ix_coupon_usage_coupon_user`(`coupon_id`, `user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `promotions` (
    `id` CHAR(36) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `name_normalized` VARCHAR(150) NOT NULL,
    `scope` ENUM('PRODUCT', 'CATEGORY', 'BRAND', 'COLLECTION') NOT NULL,
    `discount_type` ENUM('PERCENTAGE', 'FIXED_AMOUNT') NOT NULL,
    `discount_value` DECIMAL(12, 2) NOT NULL,
    `max_discount_amount` DECIMAL(12, 2) NULL,
    `starts_at` DATETIME(3) NULL,
    `ends_at` DATETIME(3) NULL,
    `status` ENUM('DRAFT', 'SCHEDULED', 'ACTIVE', 'PAUSED', 'EXPIRED') NOT NULL DEFAULT 'DRAFT',
    `priority` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    UNIQUE INDEX `promotions_name_normalized_key`(`name_normalized`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `promotion_products` (
    `promotion_id` CHAR(36) NOT NULL,
    `product_id` CHAR(36) NOT NULL,

    PRIMARY KEY (`promotion_id`, `product_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `promotion_categories` (
    `promotion_id` CHAR(36) NOT NULL,
    `category_id` CHAR(36) NOT NULL,
    `include_descendants` BOOLEAN NOT NULL DEFAULT true,

    PRIMARY KEY (`promotion_id`, `category_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `promotion_brands` (
    `promotion_id` CHAR(36) NOT NULL,
    `brand_id` CHAR(36) NOT NULL,

    PRIMARY KEY (`promotion_id`, `brand_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `promotion_collections` (
    `promotion_id` CHAR(36) NOT NULL,
    `collection_id` CHAR(36) NOT NULL,

    PRIMARY KEY (`promotion_id`, `collection_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tax_rates` (
    `id` CHAR(36) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `name_normalized` VARCHAR(100) NOT NULL,
    `rate` DECIMAL(5, 2) NOT NULL,
    `cgst_rate` DECIMAL(5, 2) NOT NULL DEFAULT 0,
    `sgst_rate` DECIMAL(5, 2) NOT NULL DEFAULT 0,
    `utgst_rate` DECIMAL(5, 2) NOT NULL DEFAULT 0,
    `igst_rate` DECIMAL(5, 2) NOT NULL DEFAULT 0,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `tax_rates_name_normalized_key`(`name_normalized`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `hsn_codes` (
    `id` CHAR(36) NOT NULL,
    `hsn_code` VARCHAR(8) NOT NULL,
    `description` VARCHAR(255) NULL,
    `default_tax_rate_id` CHAR(36) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `hsn_codes_hsn_code_key`(`hsn_code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `product_tax_assignments` (
    `id` CHAR(36) NOT NULL,
    `target_type` ENUM('PRODUCT', 'CATEGORY') NOT NULL,
    `product_id` CHAR(36) NULL,
    `category_id` CHAR(36) NULL,
    `tax_rate_id` CHAR(36) NOT NULL,
    `hsn_code` VARCHAR(8) NULL,
    `effective_from` DATETIME(3) NOT NULL,
    `effective_to` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `ix_pta_product`(`product_id`, `effective_from`),
    INDEX `ix_pta_category`(`category_id`, `effective_from`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tax_transactions` (
    `id` CHAR(36) NOT NULL,
    `invoice_record_id` CHAR(36) NOT NULL,
    `document_type` ENUM('TAX_INVOICE', 'CREDIT_NOTE') NOT NULL,
    `order_id` CHAR(36) NOT NULL,
    `order_item_id` CHAR(36) NULL,
    `refund_id` CHAR(36) NULL,
    `line_type` ENUM('ITEM', 'SHIPPING', 'COD_FEE') NOT NULL DEFAULT 'ITEM',
    `component` ENUM('CGST', 'SGST', 'UTGST', 'IGST') NOT NULL,
    `supply_type` ENUM('INTRA_STATE', 'INTER_STATE') NOT NULL,
    `place_of_supply_state_code` CHAR(2) NOT NULL,
    `hsn_code` VARCHAR(8) NOT NULL,
    `taxable_value` DECIMAL(12, 2) NOT NULL,
    `rate` DECIMAL(5, 2) NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `tax_date` DATE NOT NULL,
    `financial_year` VARCHAR(9) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_tax_txn_invoice`(`invoice_record_id`),
    INDEX `ix_tax_txn_order`(`order_id`),
    INDEX `ix_tax_txn_date_fy`(`tax_date`, `financial_year`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `invoice_records` (
    `id` CHAR(36) NOT NULL,
    `invoice_type` ENUM('TAX_INVOICE', 'CREDIT_NOTE') NOT NULL,
    `invoice_number` VARCHAR(30) NOT NULL,
    `financial_year` VARCHAR(9) NOT NULL,
    `sequence_no` INTEGER NOT NULL,
    `order_id` CHAR(36) NOT NULL,
    `shipment_id` CHAR(36) NULL,
    `refund_id` CHAR(36) NULL,
    `original_invoice_id` CHAR(36) NULL,
    `invoice_date` DATE NOT NULL,
    `seller_gstin` VARCHAR(15) NULL,
    `seller_state_code` CHAR(2) NOT NULL,
    `buyer_gstin` VARCHAR(15) NULL,
    `place_of_supply_state_code` CHAR(2) NOT NULL,
    `supply_type` ENUM('INTRA_STATE', 'INTER_STATE') NOT NULL,
    `taxable_total` DECIMAL(12, 2) NOT NULL,
    `tax_total` DECIMAL(12, 2) NOT NULL,
    `grand_total` DECIMAL(12, 2) NOT NULL,
    `pdf_storage_key` VARCHAR(255) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `invoice_records_invoice_number_key`(`invoice_number`),
    INDEX `ix_invoice_order`(`order_id`),
    UNIQUE INDEX `uq_invoice_fy_type_seq`(`financial_year`, `invoice_type`, `sequence_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `states` (
    `code` CHAR(2) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `is_union_territory` BOOLEAN NOT NULL DEFAULT false,
    `has_legislature` BOOLEAN NOT NULL DEFAULT false,

    UNIQUE INDEX `states_name_key`(`name`),
    PRIMARY KEY (`code`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `number_sequences` (
    `sequence_key` VARCHAR(50) NOT NULL,
    `period_key` VARCHAR(20) NOT NULL,
    `prefix` VARCHAR(20) NOT NULL,
    `next_value` INTEGER NOT NULL,
    `padding` INTEGER NOT NULL DEFAULT 6,
    `is_gap_free` BOOLEAN NOT NULL DEFAULT true,

    PRIMARY KEY (`sequence_key`, `period_key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notifications` (
    `id` CHAR(36) NOT NULL,
    `event` ENUM('USER_REGISTERED', 'VERIFICATION_REQUESTED', 'PASSWORD_RESET_REQUESTED', 'PASSWORD_CHANGED', 'ORDER_PLACED', 'ORDER_CONFIRMED', 'PAYMENT_SUCCEEDED', 'PAYMENT_FAILED', 'INVOICE_AVAILABLE', 'ORDER_PROCESSING', 'ORDER_SHIPPED', 'ORDER_OUT_FOR_DELIVERY', 'ORDER_DELIVERED', 'ORDER_CANCELLED', 'REFUND_INITIATED', 'REFUND_COMPLETED', 'LOW_STOCK_ALERT', 'STAFF_INVITED', 'CANCELLATION_REQUESTED', 'CANCELLATION_REJECTED', 'REFUND_REJECTED', 'SECURITY_ALERT') NOT NULL,
    `channel` ENUM('EMAIL', 'WHATSAPP', 'SMS', 'IN_APP') NOT NULL,
    `recipient_user_id` CHAR(36) NULL,
    `recipient_address` VARCHAR(254) NOT NULL,
    `template_id` CHAR(36) NULL,
    `entity_type` VARCHAR(50) NULL,
    `entity_id` CHAR(36) NULL,
    `dedupe_key` VARCHAR(191) NOT NULL,
    `payload` JSON NULL,
    `status` ENUM('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SKIPPED') NOT NULL DEFAULT 'QUEUED',
    `attempt_count` INTEGER NOT NULL DEFAULT 0,
    `next_attempt_at` DATETIME(3) NULL,
    `provider_message_id` VARCHAR(191) NULL,
    `resend_of_id` CHAR(36) NULL,
    `triggered_by_id` CHAR(36) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `notifications_dedupe_key_key`(`dedupe_key`),
    INDEX `ix_notifications_dispatch`(`status`, `next_attempt_at`),
    INDEX `ix_notifications_recipient`(`recipient_user_id`, `created_at`),
    INDEX `ix_notifications_entity`(`entity_type`, `entity_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notification_logs` (
    `id` CHAR(36) NOT NULL,
    `notification_id` CHAR(36) NOT NULL,
    `log_type` VARCHAR(30) NOT NULL,
    `attempt_no` INTEGER NOT NULL DEFAULT 1,
    `status` ENUM('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SKIPPED') NOT NULL,
    `provider_status` VARCHAR(100) NULL,
    `error_code` VARCHAR(60) NULL,
    `error_message` VARCHAR(500) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_notification_logs_notification`(`notification_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notification_templates` (
    `id` CHAR(36) NOT NULL,
    `event` ENUM('USER_REGISTERED', 'VERIFICATION_REQUESTED', 'PASSWORD_RESET_REQUESTED', 'PASSWORD_CHANGED', 'ORDER_PLACED', 'ORDER_CONFIRMED', 'PAYMENT_SUCCEEDED', 'PAYMENT_FAILED', 'INVOICE_AVAILABLE', 'ORDER_PROCESSING', 'ORDER_SHIPPED', 'ORDER_OUT_FOR_DELIVERY', 'ORDER_DELIVERED', 'ORDER_CANCELLED', 'REFUND_INITIATED', 'REFUND_COMPLETED', 'LOW_STOCK_ALERT', 'STAFF_INVITED', 'CANCELLATION_REQUESTED', 'CANCELLATION_REJECTED', 'REFUND_REJECTED', 'SECURITY_ALERT') NOT NULL,
    `channel` ENUM('EMAIL', 'WHATSAPP', 'SMS', 'IN_APP') NOT NULL,
    `locale` VARCHAR(10) NOT NULL DEFAULT 'en-IN',
    `name` VARCHAR(120) NOT NULL,
    `subject` VARCHAR(255) NULL,
    `body` MEDIUMTEXT NULL,
    `whatsapp_template_name` VARCHAR(100) NULL,
    `whatsapp_language` VARCHAR(20) NULL,
    `whatsapp_approval_status` VARCHAR(30) NULL,
    `variables` JSON NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_notification_template`(`event`, `channel`, `locale`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_logs` (
    `id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL,
    `actor_type` ENUM('CUSTOMER', 'STAFF', 'SYSTEM', 'WEBHOOK') NOT NULL,
    `actor_user_id` CHAR(36) NULL,
    `actor_role` VARCHAR(50) NULL,
    `login_type` VARCHAR(30) NULL,
    `action` ENUM('CREATE', 'UPDATE', 'DELETE', 'RESTORE', 'LOGIN', 'LOGOUT', 'LOGIN_FAILED', 'PERMISSION_CHANGE', 'ROLE_ASSIGN', 'ROLE_REVOKE', 'PERMISSION_DENIED', 'EXPORT', 'PRINT', 'STATUS_CHANGE', 'PASSWORD_RESET', 'TOKEN_REUSE_DETECTED', 'SETTINGS_CHANGE', 'REFUND_APPROVE', 'STOCK_ADJUST') NOT NULL,
    `module` VARCHAR(50) NOT NULL,
    `entity_type` VARCHAR(50) NOT NULL,
    `entity_id` CHAR(36) NULL,
    `outcome` ENUM('SUCCESS', 'FAILURE') NOT NULL DEFAULT 'SUCCESS',
    `old_values` JSON NULL,
    `new_values` JSON NULL,
    `ip_address` VARCHAR(45) NULL,
    `request_id` VARCHAR(100) NULL,
    `user_agent` VARCHAR(255) NULL,
    `reason` VARCHAR(500) NULL,

    INDEX `ix_audit_created`(`created_at`),
    INDEX `ix_audit_actor`(`actor_user_id`, `created_at`),
    INDEX `ix_audit_entity`(`entity_type`, `entity_id`, `created_at`),
    PRIMARY KEY (`id`, `created_at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `banners` (
    `id` CHAR(36) NOT NULL,
    `placement` ENUM('HOME_HERO', 'ANNOUNCEMENT', 'HOME_PROMO_STRIP', 'HOME_MID', 'CATEGORY_TOP', 'MEGA_MENU', 'CART') NOT NULL,
    `title` VARCHAR(150) NULL,
    `desktop_image_url` VARCHAR(500) NULL,
    `mobile_image_url` VARCHAR(500) NULL,
    `alt_text` VARCHAR(200) NULL,
    `link_url` VARCHAR(500) NULL,
    `category_id` CHAR(36) NULL,
    `starts_at` DATETIME(3) NULL,
    `ends_at` DATETIME(3) NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `ix_banners_placement`(`placement`, `is_active`, `sort_order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cms_pages` (
    `id` CHAR(36) NOT NULL,
    `slug` VARCHAR(160) NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `page_type` VARCHAR(50) NOT NULL,
    `status` ENUM('DRAFT', 'PUBLISHED') NOT NULL DEFAULT 'DRAFT',
    `content` MEDIUMTEXT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `seo_title` VARCHAR(160) NULL,
    `seo_description` VARCHAR(320) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    UNIQUE INDEX `cms_pages_slug_key`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cms_blocks` (
    `id` CHAR(36) NOT NULL,
    `block_key` VARCHAR(100) NOT NULL,
    `page` VARCHAR(50) NOT NULL,
    `type` ENUM('HERO_CAROUSEL', 'CATEGORY_TILES', 'COLLECTION_TILES', 'PRODUCT_RAIL', 'PROMO_BANNER', 'PRICE_BANDS', 'BRAND_STORY', 'TESTIMONIALS', 'UGC_GRID', 'TRUST_BADGES', 'NEWSLETTER', 'SIZE_GUIDE', 'RICH_TEXT', 'NAV_MENU') NOT NULL,
    `content` JSON NOT NULL,
    `category_id` CHAR(36) NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `cms_blocks_block_key_key`(`block_key`),
    INDEX `ix_cms_blocks_page`(`page`, `is_active`, `sort_order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `settings` (
    `setting_key` VARCHAR(100) NOT NULL,
    `group_key` VARCHAR(50) NOT NULL,
    `value` JSON NOT NULL,
    `value_type` ENUM('STRING', 'NUMBER', 'BOOLEAN', 'JSON') NOT NULL,
    `is_public` BOOLEAN NOT NULL DEFAULT false,
    `description` VARCHAR(255) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `updated_by_id` CHAR(36) NULL,
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `ix_settings_group`(`group_key`),
    PRIMARY KEY (`setting_key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `idempotency_keys` (
    `id` CHAR(36) NOT NULL,
    `scope` VARCHAR(80) NOT NULL,
    `idem_key` VARCHAR(191) NOT NULL,
    `user_id` CHAR(36) NULL,
    `request_hash` CHAR(64) NOT NULL,
    `status` ENUM('IN_PROGRESS', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'IN_PROGRESS',
    `resource_type` VARCHAR(50) NULL,
    `resource_id` CHAR(36) NULL,
    `response_ref` JSON NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `ix_idempotency_expires`(`expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `report_exports` (
    `id` CHAR(36) NOT NULL,
    `report_key` VARCHAR(80) NOT NULL,
    `format` ENUM('CSV', 'XLSX', 'PDF') NOT NULL,
    `filters` JSON NULL,
    `status` ENUM('QUEUED', 'PROCESSING', 'READY', 'FAILED', 'EXPIRED') NOT NULL DEFAULT 'QUEUED',
    `file_storage_key` VARCHAR(255) NULL,
    `file_hash` CHAR(64) NULL,
    `row_count` INTEGER NULL,
    `requested_by_id` CHAR(36) NOT NULL,
    `expires_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `ix_report_exports_requester`(`requested_by_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `user_roles` ADD CONSTRAINT `user_roles_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `user_roles` ADD CONSTRAINT `user_roles_role_id_fkey` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `user_roles` ADD CONSTRAINT `user_roles_assigned_by_id_fkey` FOREIGN KEY (`assigned_by_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `role_permissions` ADD CONSTRAINT `role_permissions_role_id_fkey` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `role_permissions` ADD CONSTRAINT `role_permissions_permission_id_fkey` FOREIGN KEY (`permission_id`) REFERENCES `permissions`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `user_permission_overrides` ADD CONSTRAINT `user_permission_overrides_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `user_permission_overrides` ADD CONSTRAINT `user_permission_overrides_permission_id_fkey` FOREIGN KEY (`permission_id`) REFERENCES `permissions`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `user_addresses` ADD CONSTRAINT `user_addresses_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `user_addresses` ADD CONSTRAINT `user_addresses_state_code_fkey` FOREIGN KEY (`state_code`) REFERENCES `states`(`code`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `refresh_tokens` ADD CONSTRAINT `refresh_tokens_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `refresh_tokens` ADD CONSTRAINT `refresh_tokens_replaced_by_id_fkey` FOREIGN KEY (`replaced_by_id`) REFERENCES `refresh_tokens`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `verification_tokens` ADD CONSTRAINT `verification_tokens_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `notification_preferences` ADD CONSTRAINT `notification_preferences_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `categories` ADD CONSTRAINT `categories_parent_id_fkey` FOREIGN KEY (`parent_id`) REFERENCES `categories`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `category_attributes` ADD CONSTRAINT `category_attributes_category_id_fkey` FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `category_attributes` ADD CONSTRAINT `category_attributes_attribute_id_fkey` FOREIGN KEY (`attribute_id`) REFERENCES `attributes`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `collection_products` ADD CONSTRAINT `collection_products_collection_id_fkey` FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `collection_products` ADD CONSTRAINT `collection_products_product_id_fkey` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `products` ADD CONSTRAINT `products_category_id_fkey` FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `products` ADD CONSTRAINT `products_brand_id_fkey` FOREIGN KEY (`brand_id`) REFERENCES `brands`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `products` ADD CONSTRAINT `products_hsn_code_fkey` FOREIGN KEY (`hsn_code`) REFERENCES `hsn_codes`(`hsn_code`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `product_images` ADD CONSTRAINT `product_images_product_id_fkey` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `product_images` ADD CONSTRAINT `product_images_variant_id_fkey` FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `product_variants` ADD CONSTRAINT `product_variants_product_id_fkey` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `attribute_values` ADD CONSTRAINT `attribute_values_attribute_id_fkey` FOREIGN KEY (`attribute_id`) REFERENCES `attributes`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `variant_attribute_values` ADD CONSTRAINT `variant_attribute_values_variant_id_fkey` FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `variant_attribute_values` ADD CONSTRAINT `variant_attribute_values_attribute_id_fkey` FOREIGN KEY (`attribute_id`) REFERENCES `attributes`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `variant_attribute_values` ADD CONSTRAINT `variant_attribute_values_attribute_value_id_fkey` FOREIGN KEY (`attribute_value_id`) REFERENCES `attribute_values`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `product_attribute_values` ADD CONSTRAINT `product_attribute_values_product_id_fkey` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `product_attribute_values` ADD CONSTRAINT `product_attribute_values_attribute_id_fkey` FOREIGN KEY (`attribute_id`) REFERENCES `attributes`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `product_attribute_values` ADD CONSTRAINT `product_attribute_values_attribute_value_id_fkey` FOREIGN KEY (`attribute_value_id`) REFERENCES `attribute_values`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `inventory` ADD CONSTRAINT `inventory_variant_id_fkey` FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `inventory_transactions` ADD CONSTRAINT `inventory_transactions_variant_id_fkey` FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `inventory_transactions` ADD CONSTRAINT `inventory_transactions_order_id_fkey` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `inventory_transactions` ADD CONSTRAINT `inventory_transactions_refund_id_fkey` FOREIGN KEY (`refund_id`) REFERENCES `refunds`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `inventory_transactions` ADD CONSTRAINT `inventory_transactions_stock_reservation_id_fkey` FOREIGN KEY (`stock_reservation_id`) REFERENCES `stock_reservations`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_reservations` ADD CONSTRAINT `stock_reservations_order_id_fkey` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_reservations` ADD CONSTRAINT `stock_reservations_variant_id_fkey` FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `carts` ADD CONSTRAINT `carts_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `carts` ADD CONSTRAINT `carts_coupon_id_fkey` FOREIGN KEY (`coupon_id`) REFERENCES `coupons`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `carts` ADD CONSTRAINT `carts_converted_order_id_fkey` FOREIGN KEY (`converted_order_id`) REFERENCES `orders`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `cart_items` ADD CONSTRAINT `cart_items_cart_id_fkey` FOREIGN KEY (`cart_id`) REFERENCES `carts`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `cart_items` ADD CONSTRAINT `cart_items_variant_id_fkey` FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `wishlists` ADD CONSTRAINT `wishlists_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `wishlist_items` ADD CONSTRAINT `wishlist_items_wishlist_id_fkey` FOREIGN KEY (`wishlist_id`) REFERENCES `wishlists`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `wishlist_items` ADD CONSTRAINT `wishlist_items_product_id_fkey` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `wishlist_items` ADD CONSTRAINT `wishlist_items_variant_id_fkey` FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `recently_viewed_products` ADD CONSTRAINT `recently_viewed_products_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `recently_viewed_products` ADD CONSTRAINT `recently_viewed_products_product_id_fkey` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `reviews` ADD CONSTRAINT `reviews_product_id_fkey` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `reviews` ADD CONSTRAINT `reviews_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `reviews` ADD CONSTRAINT `reviews_order_item_id_fkey` FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `orders` ADD CONSTRAINT `orders_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `orders` ADD CONSTRAINT `orders_coupon_id_fkey` FOREIGN KEY (`coupon_id`) REFERENCES `coupons`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `orders` ADD CONSTRAINT `orders_shipping_method_id_fkey` FOREIGN KEY (`shipping_method_id`) REFERENCES `shipping_methods`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `orders` ADD CONSTRAINT `orders_place_of_supply_state_code_fkey` FOREIGN KEY (`place_of_supply_state_code`) REFERENCES `states`(`code`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `orders` ADD CONSTRAINT `orders_seller_state_code_snapshot_fkey` FOREIGN KEY (`seller_state_code_snapshot`) REFERENCES `states`(`code`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `order_items` ADD CONSTRAINT `order_items_order_id_fkey` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `order_items` ADD CONSTRAINT `order_items_product_id_fkey` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `order_items` ADD CONSTRAINT `order_items_variant_id_fkey` FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `order_items` ADD CONSTRAINT `order_items_promotion_id_fkey` FOREIGN KEY (`promotion_id`) REFERENCES `promotions`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `order_status_history` ADD CONSTRAINT `order_status_history_order_id_fkey` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `shipments` ADD CONSTRAINT `shipments_order_id_fkey` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `shipments` ADD CONSTRAINT `shipments_shipping_method_id_fkey` FOREIGN KEY (`shipping_method_id`) REFERENCES `shipping_methods`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `shipment_items` ADD CONSTRAINT `shipment_items_shipment_id_fkey` FOREIGN KEY (`shipment_id`) REFERENCES `shipments`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `shipment_items` ADD CONSTRAINT `shipment_items_order_item_id_fkey` FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `shipment_tracking_events` ADD CONSTRAINT `shipment_tracking_events_shipment_id_fkey` FOREIGN KEY (`shipment_id`) REFERENCES `shipments`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_order_id_fkey` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `payment_transactions` ADD CONSTRAINT `payment_transactions_payment_id_fkey` FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `payment_transactions` ADD CONSTRAINT `payment_transactions_refund_id_fkey` FOREIGN KEY (`refund_id`) REFERENCES `refunds`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `refunds` ADD CONSTRAINT `refunds_order_id_fkey` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `refunds` ADD CONSTRAINT `refunds_payment_id_fkey` FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `refund_items` ADD CONSTRAINT `refund_items_refund_id_fkey` FOREIGN KEY (`refund_id`) REFERENCES `refunds`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `refund_items` ADD CONSTRAINT `refund_items_order_item_id_fkey` FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `coupon_applicability` ADD CONSTRAINT `coupon_applicability_coupon_id_fkey` FOREIGN KEY (`coupon_id`) REFERENCES `coupons`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `coupon_applicability` ADD CONSTRAINT `coupon_applicability_product_id_fkey` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `coupon_applicability` ADD CONSTRAINT `coupon_applicability_category_id_fkey` FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `coupon_applicability` ADD CONSTRAINT `coupon_applicability_brand_id_fkey` FOREIGN KEY (`brand_id`) REFERENCES `brands`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `coupon_applicability` ADD CONSTRAINT `coupon_applicability_collection_id_fkey` FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `coupon_usage` ADD CONSTRAINT `coupon_usage_coupon_id_fkey` FOREIGN KEY (`coupon_id`) REFERENCES `coupons`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `coupon_usage` ADD CONSTRAINT `coupon_usage_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `coupon_usage` ADD CONSTRAINT `coupon_usage_order_id_fkey` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `promotion_products` ADD CONSTRAINT `promotion_products_promotion_id_fkey` FOREIGN KEY (`promotion_id`) REFERENCES `promotions`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `promotion_products` ADD CONSTRAINT `promotion_products_product_id_fkey` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `promotion_categories` ADD CONSTRAINT `promotion_categories_promotion_id_fkey` FOREIGN KEY (`promotion_id`) REFERENCES `promotions`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `promotion_categories` ADD CONSTRAINT `promotion_categories_category_id_fkey` FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `promotion_brands` ADD CONSTRAINT `promotion_brands_promotion_id_fkey` FOREIGN KEY (`promotion_id`) REFERENCES `promotions`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `promotion_brands` ADD CONSTRAINT `promotion_brands_brand_id_fkey` FOREIGN KEY (`brand_id`) REFERENCES `brands`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `promotion_collections` ADD CONSTRAINT `promotion_collections_promotion_id_fkey` FOREIGN KEY (`promotion_id`) REFERENCES `promotions`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `promotion_collections` ADD CONSTRAINT `promotion_collections_collection_id_fkey` FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `hsn_codes` ADD CONSTRAINT `hsn_codes_default_tax_rate_id_fkey` FOREIGN KEY (`default_tax_rate_id`) REFERENCES `tax_rates`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `product_tax_assignments` ADD CONSTRAINT `product_tax_assignments_product_id_fkey` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `product_tax_assignments` ADD CONSTRAINT `product_tax_assignments_category_id_fkey` FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `product_tax_assignments` ADD CONSTRAINT `product_tax_assignments_tax_rate_id_fkey` FOREIGN KEY (`tax_rate_id`) REFERENCES `tax_rates`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `product_tax_assignments` ADD CONSTRAINT `product_tax_assignments_hsn_code_fkey` FOREIGN KEY (`hsn_code`) REFERENCES `hsn_codes`(`hsn_code`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `tax_transactions` ADD CONSTRAINT `tax_transactions_invoice_record_id_fkey` FOREIGN KEY (`invoice_record_id`) REFERENCES `invoice_records`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `tax_transactions` ADD CONSTRAINT `tax_transactions_order_id_fkey` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `tax_transactions` ADD CONSTRAINT `tax_transactions_order_item_id_fkey` FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `tax_transactions` ADD CONSTRAINT `tax_transactions_refund_id_fkey` FOREIGN KEY (`refund_id`) REFERENCES `refunds`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `tax_transactions` ADD CONSTRAINT `tax_transactions_place_of_supply_state_code_fkey` FOREIGN KEY (`place_of_supply_state_code`) REFERENCES `states`(`code`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `invoice_records` ADD CONSTRAINT `invoice_records_order_id_fkey` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `invoice_records` ADD CONSTRAINT `invoice_records_shipment_id_fkey` FOREIGN KEY (`shipment_id`) REFERENCES `shipments`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `invoice_records` ADD CONSTRAINT `invoice_records_refund_id_fkey` FOREIGN KEY (`refund_id`) REFERENCES `refunds`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `invoice_records` ADD CONSTRAINT `invoice_records_original_invoice_id_fkey` FOREIGN KEY (`original_invoice_id`) REFERENCES `invoice_records`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `invoice_records` ADD CONSTRAINT `invoice_records_seller_state_code_fkey` FOREIGN KEY (`seller_state_code`) REFERENCES `states`(`code`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `invoice_records` ADD CONSTRAINT `invoice_records_place_of_supply_state_code_fkey` FOREIGN KEY (`place_of_supply_state_code`) REFERENCES `states`(`code`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_recipient_user_id_fkey` FOREIGN KEY (`recipient_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_template_id_fkey` FOREIGN KEY (`template_id`) REFERENCES `notification_templates`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_resend_of_id_fkey` FOREIGN KEY (`resend_of_id`) REFERENCES `notifications`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `notification_logs` ADD CONSTRAINT `notification_logs_notification_id_fkey` FOREIGN KEY (`notification_id`) REFERENCES `notifications`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `banners` ADD CONSTRAINT `banners_category_id_fkey` FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `cms_blocks` ADD CONSTRAINT `cms_blocks_category_id_fkey` FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `idempotency_keys` ADD CONSTRAINT `idempotency_keys_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `report_exports` ADD CONSTRAINT `report_exports_requested_by_id_fkey` FOREIGN KEY (`requested_by_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ============================================================================
-- SQL-ONLY SECTION — Phase 3 approved design
-- Sources (verbatim/adapted definitions):
--   project-documentation/05-database/DATABASE_DESIGN.md   (§23.6 generated cols; §6–§13 CHECKs; per-table unique keys)
--   project-documentation/12-phase3-database-design/DATABASE_CONSTRAINTS_AND_INDEXES.md (P3-06)
--   project-documentation/12-phase3-database-design/DATABASE_TABLE_CATALOG.md (P3-03)
-- Status: CANDIDATE — REQUIRES MANUAL REVIEW (G6 re-review) BEFORE ANY APPLY. Not executed.
-- Option A corrections applied 2026-11-17 (approved D8–D14): composite FK
--   fk_product_images_variant_product ON DELETE CASCADE→RESTRICT (D8); ck_orders_money
--   `subtotal >= 0` term restored (D13); NOT-IMPLEMENTED list updated (a–e; D11 annotations).
-- FULLTEXT/ngram indexes: DEFERRED per OQ-B6 (user acceptance 2026-11-17) — intentionally absent.
-- Adaptations vs Phase 1 wording are marked "ADAPTED"; items not implementable
-- against the approved Phase 3 schema are listed at the end as NOT IMPLEMENTED.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Generated STORED columns (DATABASE_DESIGN.md §23.6; P3-06 §2)
-- ----------------------------------------------------------------------------
ALTER TABLE `categories` ADD COLUMN `parent_key` CHAR(36) GENERATED ALWAYS AS (COALESCE(`parent_id`, '00000000-0000-0000-0000-000000000000')) STORED;
ALTER TABLE `product_variants` ADD COLUMN `default_key` CHAR(36) GENERATED ALWAYS AS (IF(`is_default` = 1, `product_id`, NULL)) STORED;
ALTER TABLE `product_images` ADD COLUMN `primary_key_marker` CHAR(36) GENERATED ALWAYS AS (IF(`is_primary` = 1, `product_id`, NULL)) STORED;
ALTER TABLE `user_addresses` ADD COLUMN `default_owner_key` CHAR(36) GENERATED ALWAYS AS (IF(`is_default` = 1, `user_id`, NULL)) STORED;
ALTER TABLE `carts` ADD COLUMN `active_owner_key` CHAR(36) GENERATED ALWAYS AS (IF(`status` = 'ACTIVE', `user_id`, NULL)) STORED;
ALTER TABLE `wishlist_items` ADD COLUMN `variant_key` CHAR(36) GENERATED ALWAYS AS (COALESCE(`variant_id`, '')) STORED;
ALTER TABLE `coupon_applicability` ADD COLUMN `target_id` CHAR(36) GENERATED ALWAYS AS (COALESCE(`product_id`, `category_id`, `brand_id`, `collection_id`)) STORED;
ALTER TABLE `invoice_records` ADD COLUMN `tax_invoice_order_key` CHAR(36) GENERATED ALWAYS AS (IF(`invoice_type` = 'TAX_INVOICE', `order_id`, NULL)) STORED;
ALTER TABLE `inventory` ADD COLUMN `quantity_available` INT GENERATED ALWAYS AS (`quantity_on_hand` - `quantity_reserved`) STORED;
ALTER TABLE `idempotency_keys` ADD COLUMN `owner_key` CHAR(36) GENERATED ALWAYS AS (COALESCE(`user_id`, 'ANONYMOUS')) STORED;

-- ----------------------------------------------------------------------------
-- 2. Unique indexes on generated columns / conditional & nullable uniqueness
--    (DATABASE_DESIGN.md per-table unique keys; P3-06 §2/§5)
-- ----------------------------------------------------------------------------
ALTER TABLE `categories` ADD UNIQUE INDEX `uq_categories_parent_name` (`parent_key`, `name_normalized`);
ALTER TABLE `product_variants` ADD UNIQUE INDEX `uq_product_variants_default` (`default_key`);
ALTER TABLE `product_images` ADD UNIQUE INDEX `uq_product_images_primary` (`primary_key_marker`);
ALTER TABLE `user_addresses` ADD UNIQUE INDEX `uq_user_addresses_default` (`default_owner_key`);
ALTER TABLE `carts` ADD UNIQUE INDEX `uq_carts_active_owner` (`active_owner_key`);
ALTER TABLE `wishlist_items` ADD UNIQUE INDEX `uq_wishlist_items` (`wishlist_id`, `product_id`, `variant_key`);
ALTER TABLE `coupon_applicability` ADD UNIQUE INDEX `uq_coupon_applicability` (`coupon_id`, `rule_type`, `target_type`, `target_id`);
ALTER TABLE `invoice_records` ADD UNIQUE INDEX `uq_invoice_tax_order` (`tax_invoice_order_key`);
ALTER TABLE `idempotency_keys` ADD UNIQUE INDEX `uq_idempotency` (`owner_key`, `scope`, `idem_key`);
-- Nullable-unique (multiple NULLs allowed) — webhook/provider dedupe:
ALTER TABLE `payments` ADD UNIQUE INDEX `uq_payments_provider_order` (`provider`, `provider_order_id`);
ALTER TABLE `payments` ADD UNIQUE INDEX `uq_payments_provider_payment` (`provider`, `provider_payment_id`);
ALTER TABLE `payment_transactions` ADD UNIQUE INDEX `uq_payment_txn_event` (`provider`, `provider_event_id`);
ALTER TABLE `shipments` ADD UNIQUE INDEX `uq_shipments_awb` (`provider`, `awb_number`);

-- ----------------------------------------------------------------------------
-- 3. CHECK constraints (DATABASE_DESIGN.md §6–§13; P3-06 §4)
-- ----------------------------------------------------------------------------
-- users
ALTER TABLE `users` ADD CONSTRAINT `ck_users_failed_login` CHECK (`failed_login_count` >= 0);
ALTER TABLE `users` ADD CONSTRAINT `ck_users_superadmin_staff` CHECK (`is_superadmin` = 0 OR `account_type` = 'STAFF');
-- permissions
ALTER TABLE `permissions` ADD CONSTRAINT `ck_permissions_code` CHECK (`code` = CONCAT(`module`, '.', `action`));
-- user_addresses
ALTER TABLE `user_addresses` ADD CONSTRAINT `ck_user_addresses_pin` CHECK (`postal_code` REGEXP '^[1-9][0-9]{5}$');
ALTER TABLE `user_addresses` ADD CONSTRAINT `ck_user_addresses_country` CHECK (`country_code` = 'IN');
-- verification_tokens
ALTER TABLE `verification_tokens` ADD CONSTRAINT `ck_vt_attempts` CHECK (`attempt_count` >= 0 AND `attempt_count` <= `max_attempts`);
-- categories
ALTER TABLE `categories` ADD CONSTRAINT `ck_categories_depth` CHECK (`depth` BETWEEN 1 AND 3);
ALTER TABLE `categories` ADD CONSTRAINT `ck_categories_not_self` CHECK (`parent_id` IS NULL OR `parent_id` <> `id`);
-- collections
ALTER TABLE `collections` ADD CONSTRAINT `ck_collections_window` CHECK (`ends_at` IS NULL OR `starts_at` IS NULL OR `ends_at` > `starts_at`);
-- products
ALTER TABLE `products` ADD CONSTRAINT `ck_products_rating` CHECK (`avg_rating` BETWEEN 0 AND 5);
ALTER TABLE `products` ADD CONSTRAINT `ck_products_counts` CHECK (`review_count` >= 0 AND `total_sold` >= 0);
ALTER TABLE `products` ADD CONSTRAINT `ck_products_price_range` CHECK (`min_selling_price` IS NULL OR `max_selling_price` >= `min_selling_price`);
-- product_variants
ALTER TABLE `product_variants` ADD CONSTRAINT `ck_pv_prices` CHECK (`mrp` > 0 AND `selling_price` > 0 AND `selling_price` <= `mrp`);
ALTER TABLE `product_variants` ADD CONSTRAINT `ck_pv_compare` CHECK (`compare_at_price` IS NULL OR `compare_at_price` >= `selling_price`);
ALTER TABLE `product_variants` ADD CONSTRAINT `ck_pv_cost` CHECK (`cost_price` IS NULL OR `cost_price` >= 0);
ALTER TABLE `product_variants` ADD CONSTRAINT `ck_pv_weight` CHECK (`weight_grams` IS NULL OR `weight_grams` > 0);
ALTER TABLE `product_variants` ADD CONSTRAINT `ck_pv_sku` CHECK (`sku` REGEXP '^[A-Z0-9_-]{1,32}$');
ALTER TABLE `product_variants` ADD CONSTRAINT `ck_pv_barcode` CHECK (`barcode` IS NULL OR `barcode` REGEXP '^[A-Z0-9_-]{1,64}$');
-- attribute_values
ALTER TABLE `attribute_values` ADD CONSTRAINT `ck_attribute_values_hex` CHECK (`swatch_hex` IS NULL OR `swatch_hex` REGEXP '^#[0-9A-Fa-f]{6}$');
-- inventory
ALTER TABLE `inventory` ADD CONSTRAINT `ck_inventory_non_negative` CHECK (`quantity_on_hand` >= 0 AND `quantity_reserved` >= 0);
ALTER TABLE `inventory` ADD CONSTRAINT `ck_inventory_reserved_le_onhand` CHECK (`quantity_reserved` <= `quantity_on_hand`);
ALTER TABLE `inventory` ADD CONSTRAINT `ck_inventory_threshold` CHECK (`low_stock_threshold` IS NULL OR `low_stock_threshold` >= 0);
-- inventory_transactions (append-only ledger)
ALTER TABLE `inventory_transactions` ADD CONSTRAINT `ck_inv_txn_nonzero` CHECK (`on_hand_delta` <> 0 OR `reserved_delta` <> 0);
ALTER TABLE `inventory_transactions` ADD CONSTRAINT `ck_inv_txn_after` CHECK (`on_hand_after` >= 0 AND `reserved_after` >= 0);
-- stock_reservations
ALTER TABLE `stock_reservations` ADD CONSTRAINT `ck_stock_reservations_qty` CHECK (`quantity` > 0);
-- cart_items
ALTER TABLE `cart_items` ADD CONSTRAINT `ck_cart_items_qty` CHECK (`quantity` BETWEEN 1 AND 99);
-- orders
-- RESTORED (D13, approved 2026-11-17): Phase 1 `subtotal >= 0` term — `orders.subtotal`
-- EXISTS in the approved Phase 3 schema (PRISMA_SCHEMA_DESIGN.md L1259; G6 report claim corrected).
ALTER TABLE `orders` ADD CONSTRAINT `ck_orders_money` CHECK (`subtotal` >= 0 AND `item_discount_total` >= 0 AND `coupon_discount_total` >= 0 AND `shipping_charge` >= 0 AND `shipping_discount` >= 0 AND `shipping_discount` <= `shipping_charge` AND `tax_total` >= 0 AND `grand_total` >= 0);
ALTER TABLE `orders` ADD CONSTRAINT `ck_orders_refund` CHECK (`refunded_total` >= 0 AND `refunded_total` <= `grand_total`);
ALTER TABLE `orders` ADD CONSTRAINT `ck_orders_tax_sum` CHECK (`tax_total` = `cgst_total` + `sgst_total` + `utgst_total` + `igst_total`);
ALTER TABLE `orders` ADD CONSTRAINT `ck_orders_round` CHECK (`round_off` BETWEEN -0.99 AND 0.99);
ALTER TABLE `orders` ADD CONSTRAINT `ck_orders_supply` CHECK ((`supply_type` = 'INTRA_STATE' AND `igst_total` = 0) OR (`supply_type` = 'INTER_STATE' AND `cgst_total` = 0 AND `sgst_total` = 0 AND `utgst_total` = 0));
ALTER TABLE `orders` ADD CONSTRAINT `ck_orders_currency` CHECK (`currency` = 'INR');
-- order_items (immutable snapshots)
ALTER TABLE `order_items` ADD CONSTRAINT `ck_oi_qty` CHECK (`quantity` > 0);
ALTER TABLE `order_items` ADD CONSTRAINT `ck_oi_counters` CHECK (`quantity_shipped` >= 0 AND `quantity_cancelled` >= 0 AND `quantity_refunded` >= 0 AND `quantity_shipped` + `quantity_cancelled` <= `quantity` AND `quantity_refunded` <= `quantity`);
ALTER TABLE `order_items` ADD CONSTRAINT `ck_oi_money` CHECK (`unit_price` >= 0 AND `unit_price` <= `mrp` AND `promotion_discount` >= 0 AND `coupon_discount` >= 0 AND `taxable_value` >= 0 AND `line_total` >= 0);
ALTER TABLE `order_items` ADD CONSTRAINT `ck_oi_tax_sum` CHECK (`tax_amount` = `cgst_amount` + `sgst_amount` + `utgst_amount` + `igst_amount`);
-- order_status_history
ALTER TABLE `order_status_history` ADD CONSTRAINT `ck_osh_shape` CHECK ((`event_type` = 'STATUS_CHANGE' AND `to_status` IS NOT NULL) OR (`event_type` = 'NOTE' AND `note` IS NOT NULL));
-- payments
ALTER TABLE `payments` ADD CONSTRAINT `ck_payments_amounts` CHECK (`amount` > 0 AND `amount_refunded` >= 0 AND `amount_refunded` <= `amount`);
-- refunds
ALTER TABLE `refunds` ADD CONSTRAINT `ck_refunds_amount` CHECK (`amount` > 0 AND `amount` = `items_amount` + `shipping_amount` AND `tax_amount` >= 0 AND `taxable_value` >= 0);
ALTER TABLE `refunds` ADD CONSTRAINT `ck_refunds_retry` CHECK (`retry_count` >= 0);
-- refund_items
ALTER TABLE `refund_items` ADD CONSTRAINT `ck_refund_items` CHECK (`quantity` >= 0 AND `amount` >= 0 AND `taxable_value` >= 0);
-- shipping_methods
ALTER TABLE `shipping_methods` ADD CONSTRAINT `ck_sm_charges` CHECK (`base_charge` >= 0 AND (`free_above_amount` IS NULL OR `free_above_amount` > 0));
-- ADAPTED: Phase 1 enum value 'FREE_ABOVE_THRESHOLD' → approved Phase 3 enum value 'FREE_ABOVE'; confirm at G6.
ALTER TABLE `shipping_methods` ADD CONSTRAINT `ck_sm_threshold` CHECK (`rate_type` <> 'FREE_ABOVE' OR `free_above_amount` IS NOT NULL);
-- ADAPTED: Phase 1 estimated_days_min/max → approved Phase 3 columns eta_min_days/eta_max_days; confirm at G6.
ALTER TABLE `shipping_methods` ADD CONSTRAINT `ck_sm_days` CHECK (`eta_max_days` IS NULL OR `eta_min_days` IS NULL OR `eta_max_days` >= `eta_min_days`);
-- shipment_items
ALTER TABLE `shipment_items` ADD CONSTRAINT `ck_shipment_items_qty` CHECK (`quantity` > 0);
-- coupons
ALTER TABLE `coupons` ADD CONSTRAINT `ck_coupons_value` CHECK (`discount_value` > 0 AND (`discount_type` <> 'PERCENTAGE' OR `discount_value` <= 100));
ALTER TABLE `coupons` ADD CONSTRAINT `ck_coupons_usage_limit` CHECK ((`usage_limit_enabled` = 0 AND `usage_limit` IS NULL) OR (`usage_limit_enabled` = 1 AND `usage_limit` IS NOT NULL AND `usage_limit` >= 1));
ALTER TABLE `coupons` ADD CONSTRAINT `ck_coupons_per_customer` CHECK (`per_customer_limit` IS NULL OR `per_customer_limit` >= 1);
ALTER TABLE `coupons` ADD CONSTRAINT `ck_coupons_used` CHECK (`used_count` >= 0 AND (`usage_limit` IS NULL OR `used_count` <= `usage_limit`));
ALTER TABLE `coupons` ADD CONSTRAINT `ck_coupons_window` CHECK (`expires_at` > `starts_at`);
ALTER TABLE `coupons` ADD CONSTRAINT `ck_coupons_amounts` CHECK (`min_order_value` >= 0 AND (`max_discount_amount` IS NULL OR `max_discount_amount` > 0));
ALTER TABLE `coupons` ADD CONSTRAINT `ck_coupons_code` CHECK (`code_normalized` REGEXP '^[A-Z0-9_-]{3,32}$');
-- coupon_applicability
ALTER TABLE `coupon_applicability` ADD CONSTRAINT `ck_ca_one_target` CHECK ((`product_id` IS NOT NULL) + (`category_id` IS NOT NULL) + (`brand_id` IS NOT NULL) + (`collection_id` IS NOT NULL) = 1);
ALTER TABLE `coupon_applicability` ADD CONSTRAINT `ck_ca_target_matches` CHECK ((`target_type` = 'PRODUCT' AND `product_id` IS NOT NULL) OR (`target_type` = 'CATEGORY' AND `category_id` IS NOT NULL) OR (`target_type` = 'BRAND' AND `brand_id` IS NOT NULL) OR (`target_type` = 'COLLECTION' AND `collection_id` IS NOT NULL));
-- coupon_usage
ALTER TABLE `coupon_usage` ADD CONSTRAINT `ck_coupon_usage_amount` CHECK (`discount_amount` >= 0);
-- promotions
ALTER TABLE `promotions` ADD CONSTRAINT `ck_promotions_value` CHECK (`discount_value` > 0 AND (`discount_type` <> 'PERCENTAGE' OR `discount_value` <= 100));
ALTER TABLE `promotions` ADD CONSTRAINT `ck_promotions_window` CHECK (`ends_at` > `starts_at`);
ALTER TABLE `promotions` ADD CONSTRAINT `ck_promotions_cap` CHECK (`max_discount_amount` IS NULL OR `max_discount_amount` > 0);
-- reviews
ALTER TABLE `reviews` ADD CONSTRAINT `ck_reviews_rating` CHECK (`rating` BETWEEN 1 AND 5);
-- notification_templates
-- ADAPTED: Phase 1 `body_html` → approved Phase 3 column `body`; confirm at G6.
ALTER TABLE `notification_templates` ADD CONSTRAINT `ck_nt_email` CHECK (`channel` <> 'EMAIL' OR (`subject` IS NOT NULL AND `body` IS NOT NULL));
ALTER TABLE `notification_templates` ADD CONSTRAINT `ck_nt_whatsapp` CHECK (`channel` <> 'WHATSAPP' OR `whatsapp_template_name` IS NOT NULL);
-- tax_rates
ALTER TABLE `tax_rates` ADD CONSTRAINT `ck_tax_rates_range` CHECK (`rate` >= 0 AND `rate` <= 100);
ALTER TABLE `tax_rates` ADD CONSTRAINT `ck_tax_rates_split` CHECK (`cgst_rate` + `sgst_rate` = `rate` AND `cgst_rate` + `utgst_rate` = `rate` AND `igst_rate` = `rate`);
-- ADAPTED: Phase 1 `cess_rate >= 0` term omitted — approved Phase 3 schema has no `cess_rate` column; confirm at G6.
ALTER TABLE `tax_rates` ADD CONSTRAINT `ck_tax_rates_components` CHECK (`cgst_rate` >= 0 AND `sgst_rate` >= 0 AND `utgst_rate` >= 0 AND `igst_rate` >= 0);
-- hsn_codes
ALTER TABLE `hsn_codes` ADD CONSTRAINT `ck_hsn_format` CHECK (`hsn_code` REGEXP '^[0-9]{4}([0-9]{2}){0,2}$');
-- product_tax_assignments
ALTER TABLE `product_tax_assignments` ADD CONSTRAINT `ck_pta_target` CHECK ((`target_type` = 'PRODUCT' AND `product_id` IS NOT NULL AND `category_id` IS NULL) OR (`target_type` = 'CATEGORY' AND `category_id` IS NOT NULL AND `product_id` IS NULL));
ALTER TABLE `product_tax_assignments` ADD CONSTRAINT `ck_pta_window` CHECK (`effective_to` IS NULL OR `effective_to` > `effective_from`);
-- tax_transactions (append-only)
ALTER TABLE `tax_transactions` ADD CONSTRAINT `ck_tax_txn_sign` CHECK ((`document_type` = 'TAX_INVOICE' AND `amount` >= 0 AND `taxable_value` >= 0) OR (`document_type` = 'CREDIT_NOTE' AND `amount` <= 0 AND `taxable_value` <= 0));
ALTER TABLE `tax_transactions` ADD CONSTRAINT `ck_tax_txn_rate` CHECK (`rate` >= 0 AND `rate` <= 100);
-- invoice_records
ALTER TABLE `invoice_records` ADD CONSTRAINT `ck_invoice_seq` CHECK (`sequence_no` > 0);
ALTER TABLE `invoice_records` ADD CONSTRAINT `ck_invoice_cn` CHECK (`invoice_type` <> 'CREDIT_NOTE' OR (`original_invoice_id` IS NOT NULL AND `refund_id` IS NOT NULL));
ALTER TABLE `invoice_records` ADD CONSTRAINT `ck_invoice_amounts` CHECK (`taxable_total` >= 0 AND `grand_total` >= 0);
-- states (GST reference)
ALTER TABLE `states` ADD CONSTRAINT `ck_states_code` CHECK (`code` REGEXP '^[0-9]{2}$');
ALTER TABLE `states` ADD CONSTRAINT `ck_states_legislature` CHECK (`is_union_territory` = 1 OR `has_legislature` = 1);
-- banners
ALTER TABLE `banners` ADD CONSTRAINT `ck_banners_window` CHECK (`ends_at` IS NULL OR `starts_at` IS NULL OR `ends_at` > `starts_at`);

-- ----------------------------------------------------------------------------
-- 4. Composite foreign key — same-product variant image integrity
--    (P3-06 §2.1; referenced unique `uq_product_variants_id_product (id, product_id)`
--     is created by the Prisma DDL above)
-- ----------------------------------------------------------------------------
ALTER TABLE `product_images` ADD CONSTRAINT `fk_product_images_variant_product` FOREIGN KEY (`variant_id`, `product_id`) REFERENCES `product_variants`(`id`, `product_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ----------------------------------------------------------------------------
-- 5. NOT IMPLEMENTED (documented requirements with no matching approved Phase 3
--    column) — resolve at G6 before apply; do not silently drop:
--    a) ck_tax_rates_components `cess_rate >= 0` term — no `cess_rate` column
--       (D2/D11: remains omitted in v1; confirmed 2026-11-17).
--    b) ck_invoice_tax_sum (tax_total = cgst+sgst+utgst+igst) — invoice_records has
--       no component columns in Phase 3 schema (tax_total is authoritative;
--       D3/D11: component sums remain represented in the tax_transactions ledger).
--    c) ck_notifications_attempts (attempt_count <= max_attempts) — notifications
--       has no `max_attempts` column in Phase 3 schema (D4/D11: retry cap remains
--       a service-layer constant, default 5).
--    d) ck_ns_values (next_value <= max_value + 1) — number_sequences has no
--       `max_value` column in Phase 3 schema (D5/D11: overflow guard remains
--       service-layer enforced — 90% alert / 100% fail).
--    e) Phase 1 PROPOSED `CHARACTER SET ascii` on normalized/hash columns — not
--       carried into the approved Phase 3 schema (OQ-B5: schema authoritative).
-- ----------------------------------------------------------------------------
