/**
 * Default settings — DATABASE_DESIGN.md §25.5 (values PROPOSED; no secrets, no invented business
 * values: unknown store identity fields are blank and must be set by the client).
 *
 * Idempotent: upsert by `setting_key`. On re-run only metadata (group, visibility, description) is
 * refreshed — the client's `value` and the concurrency `version` are never overwritten.
 * `MONEY` (§13.11) has no enum value in the approved schema → stored as a decimal STRING.
 */
import type { Prisma } from '../../src/generated/prisma/client.js';
import type { ValueType } from '../../src/generated/prisma/enums.js';
import type { Queryable } from '../../src/core/db/transaction.js';

export interface SettingSeedRow {
  readonly settingKey: string;
  readonly groupKey: string;
  readonly value: Prisma.InputJsonValue;
  readonly valueType: ValueType;
  readonly isPublic: boolean;
  readonly description: string;
}

type Raw = readonly [
  key: string,
  value: Prisma.InputJsonValue,
  type: ValueType,
  isPublic: boolean,
  description: string,
];

const RAW: readonly Raw[] = [
  ['store.name', '[BRAND_NAME]', 'STRING', true, 'Store display name (OQ-01)'],
  ['store.legal_name', '', 'STRING', false, 'Registered legal name — must be set (OQ-20)'],
  // D-57: seller GSTIN / state code live ONLY under tax.seller_gstin / tax.seller_state_code. They
  // are deliberately not seeded: an absent row reads as "not configured" (null) and blocks invoicing,
  // whereas a seeded '' could be mistaken for a value. Set them via PATCH /admin/tax/settings.
  [
    'store.address',
    { line1: '', line2: '', city: '', stateCode: '', pincode: '', country: 'IN' },
    'JSON',
    false,
    'Registered address (invoice header)',
  ],
  ['store.support_email', '', 'STRING', true, 'Customer support email'],
  ['store.support_phone', '', 'STRING', true, 'Customer support phone (+91…)'],
  ['tax.prices_include_tax', true, 'BOOLEAN', true, 'Selling prices include GST (OQ-21)'],
  [
    'tax.rounding_mode',
    'LINE_HALF_UP_INVOICE_ROUND_RUPEE',
    'STRING',
    false,
    'Per-line half-up + ₹1 invoice round-off (OQ-23)',
  ],
  ['tax.shipping_tax_treatment', 'PROPORTIONAL', 'STRING', false, 'Shipping tax treatment (OQ-22)'],
  ['tax.invoice_trigger', 'SHIPPED', 'STRING', false, 'Invoice generated on status (OQ-48)'],
  ['checkout.reservation_ttl_minutes', 15, 'NUMBER', false, 'Stock reservation TTL (OQ-17)'],
  ['checkout.cod_enabled', false, 'BOOLEAN', true, 'Cash on delivery enabled (OQ-06)'],
  ['checkout.max_qty_per_line', 5, 'NUMBER', true, 'Max quantity per cart line (OQ-57, R-03)'],
  ['checkout.guest_checkout_enabled', false, 'BOOLEAN', true, 'Guest checkout (OQ-10)'],
  [
    'cart.abandon_after_days',
    30,
    'NUMBER',
    false,
    'Idle days before an ACTIVE cart becomes ABANDONED (RD-08, USER_WORKFLOWS §9.3)',
  ],
  [
    'customer.max_addresses_per_customer',
    20,
    'NUMBER',
    false,
    'Max saved addresses per customer (R-02)',
  ],
  [
    'shipping.free_shipping_threshold',
    '999.00',
    'STRING',
    true,
    'Free-shipping threshold in INR, illustrative (OQ-07)',
  ],
  [
    'inventory.low_stock_threshold_default',
    5,
    'NUMBER',
    false,
    'Default low-stock threshold (OQ-47)',
  ],
  ['catalog.page_size_default', 30, 'NUMBER', true, 'Product listing page size (CONFIRMED)'],
  ['catalog.new_arrival_days', 30, 'NUMBER', false, 'New-arrival window in days (OQ-50)'],
  ['catalog.best_seller_window_days', 90, 'NUMBER', false, 'Best-seller window in days (OQ-50)'],
  ['recently_viewed.max_items', 20, 'NUMBER', true, 'Recently viewed items kept (OQ-33)'],
  ['reviews.moderation_mode', 'PRE', 'STRING', false, 'Review moderation mode (OQ-31)'],
  [
    'orders.customer_cancel_until_status',
    'CONFIRMED',
    'STRING',
    false,
    'Customers may cancel up to this status (OQ-12)',
  ],
  [
    'reports.sync_export_max_rows',
    10000,
    'NUMBER',
    false,
    'Max rows for synchronous exports (OQ-45)',
  ],
  ['security.staff_reauth_window_minutes', 10, 'NUMBER', false, 'Staff re-auth window (R-15)'],
  ['audit.retention_years', 7, 'NUMBER', false, 'Audit-log retention in years (OQ-38)'],
  [
    'notifications.whatsapp_enabled',
    false,
    'BOOLEAN',
    false,
    'WhatsApp notifications (off until a BSP is chosen, OQ-08)',
  ],
];

/** Pure: the default rows the seed upserts. */
export function buildSettingRows(raw: readonly Raw[] = RAW): SettingSeedRow[] {
  return raw.map(([settingKey, value, valueType, isPublic, description]) => ({
    settingKey,
    groupKey: settingKey.split('.')[0] ?? settingKey,
    value,
    valueType,
    isPublic,
    description,
  }));
}

export async function seedSettings(db: Queryable): Promise<{ upserted: number }> {
  const rows = buildSettingRows();
  for (const row of rows) {
    await db.setting.upsert({
      where: { settingKey: row.settingKey },
      create: { ...row, version: 1 },
      update: { groupKey: row.groupKey, isPublic: row.isPublic, description: row.description },
    });
  }
  return { upserted: rows.length };
}
