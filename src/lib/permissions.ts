/**
 * Permission catalogue and role templates — ROLE_PERMISSION_AND_AUDIT_LOGS.md §3 (88 keys) and §5,
 * PROJECT_CONTEXT.md §7.3. `export`/`approve` actions included per decision OQ-29 (2026-11-19).
 *
 * Single source of truth for route guards, `GET /admin/permissions` and the seed. Permission rows
 * are created by seed/migration only — never by an API (rule R10).
 */
export type PermissionAction = 'view' | 'create' | 'update' | 'delete' | 'export' | 'approve';

export interface PermissionDefinition {
  readonly key: string;
  readonly module: string;
  readonly action: PermissionAction;
  readonly description: string;
  readonly isCritical: boolean;
  readonly isReserved: boolean;
  readonly sortOrder: number;
}

type Row = readonly [key: string, description: string, critical?: boolean, reserved?: boolean];

const ROWS: readonly Row[] = [
  ['dashboard.view', 'View dashboard'],
  ['reports.view', 'View reports (plus the domain permission per report family)'],
  ['reports.export', 'Export/print reports'],
  ['products.view', 'View products, variants, images, SKUs'],
  ['products.create', 'Create products, variants, upload images'],
  ['products.update', 'Edit products/variants/images, status, prices & cost'],
  ['products.delete', 'Soft-delete products/variants/images (bulk delete is critical)'],
  ['categories.view', 'View categories & category-attribute rules'],
  ['categories.create', 'Create categories'],
  ['categories.update', 'Edit categories, reorder, required-attribute rules'],
  ['categories.delete', 'Soft-delete categories (only if empty)'],
  ['brands.view', 'View brands'],
  ['brands.create', 'Create brands'],
  ['brands.update', 'Edit brands'],
  ['brands.delete', 'Soft-delete brands'],
  ['collections.view', 'View collections'],
  ['collections.create', 'Create collections'],
  ['collections.update', 'Edit collections & membership'],
  ['collections.delete', 'Soft-delete collections'],
  ['attributes.view', 'View attributes & values'],
  ['attributes.create', 'Create attributes & values'],
  ['attributes.update', 'Edit attributes & values'],
  ['attributes.delete', 'Delete unused attributes/values'],
  ['inventory.view', 'View stock, history, low-stock list, SKU lookup'],
  ['inventory.create', 'Record stock movements (in/out/adjust, single & bulk)'],
  ['inventory.update', 'Edit low-stock thresholds'],
  ['barcodes.view', 'Preview barcodes'],
  ['barcodes.create', 'Generate/print barcode labels'],
  ['orders.view', 'View orders, invoices, status history'],
  ['orders.create', 'Reserved — staff-created orders', false, true],
  ['orders.update', 'Change order status, add notes, cancel before SHIPPED'],
  ['orders.delete', 'Reserved — orders are never deleted', false, true],
  ['orders.approve', 'Approve/reject customer cancellation requests'],
  ['customers.view', 'View customer accounts and addresses'],
  ['customers.create', 'Reserved — staff-created customer accounts', false, true],
  ['customers.update', 'Change customer status'],
  ['customers.delete', 'Process account deletion/anonymisation', true],
  ['customers.export', 'Export customer data', true],
  ['coupons.view', 'View coupons & usage'],
  ['coupons.create', 'Create coupons'],
  ['coupons.update', 'Edit/activate/deactivate coupons'],
  ['coupons.delete', 'Delete unused coupons'],
  ['promotions.view', 'View promotions'],
  ['promotions.create', 'Create promotions'],
  ['promotions.update', 'Edit, pause, resume promotions'],
  ['promotions.delete', 'Delete never-active promotions'],
  ['tax.view', 'View tax masters and GST settings'],
  ['tax.create', 'Create tax rates, HSN codes, assignments', true],
  ['tax.update', 'Edit tax masters and GST settings', true],
  ['tax.delete', 'Delete unreferenced tax masters', true],
  ['payments.view', 'View payments & transactions'],
  ['payments.update', 'Reconciliation actions', true],
  ['refunds.view', 'View refunds'],
  ['refunds.create', 'Create refund requests'],
  ['refunds.update', 'Edit refunds before approval; retry; record manual completion'],
  ['refunds.delete', 'Reserved — refunds are never deleted', false, true],
  ['refunds.approve', 'Approve/reject refunds', true],
  ['shipping.view', 'View shipping methods, shipments, tracking'],
  ['shipping.create', 'Create shipping methods & shipments'],
  ['shipping.update', 'Edit methods, update shipments, add tracking events'],
  ['shipping.delete', 'Delete unused shipping methods'],
  ['reviews.view', 'View reviews'],
  ['reviews.create', 'Reserved — staff replies', false, true],
  ['reviews.update', 'Edit moderation notes'],
  ['reviews.delete', 'Delete reviews'],
  ['reviews.approve', 'Approve/reject reviews'],
  ['banners.view', 'View banners'],
  ['banners.create', 'Create banners'],
  ['banners.update', 'Edit/schedule banners'],
  ['banners.delete', 'Delete banners'],
  ['cms.view', 'View CMS pages & blocks'],
  ['cms.create', 'Create pages & blocks'],
  ['cms.update', 'Edit/publish pages & blocks'],
  ['cms.delete', 'Delete pages & blocks'],
  ['notifications.view', 'View templates & notification logs'],
  ['notifications.update', 'Edit templates, resend notifications'],
  ['admin_users.view', 'View staff accounts'],
  ['admin_users.create', 'Invite staff', true],
  ['admin_users.update', 'Edit staff, roles, overrides, status, sessions, MFA reset', true],
  ['admin_users.delete', 'Disable/delete staff accounts', true],
  ['roles.view', 'View roles & permission mappings'],
  ['roles.create', 'Create roles', true],
  ['roles.update', 'Edit roles & role-permission mapping', true],
  ['roles.delete', 'Delete custom roles', true],
  ['audit_logs.view', 'View audit logs'],
  ['audit_logs.export', 'Export audit logs', true],
  ['settings.view', 'View system settings'],
  ['settings.update', 'Change system settings', true],
];

export const PERMISSIONS: readonly PermissionDefinition[] = ROWS.map(
  ([key, description, critical = false, reserved = false], index) => {
    const [module = '', action = ''] = key.split('.');
    return Object.freeze({
      key,
      module,
      action: action as PermissionAction,
      description,
      isCritical: critical,
      isReserved: reserved,
      sortOrder: index + 1,
    });
  },
);

export const PERMISSION_KEYS: ReadonlySet<string> = new Set(PERMISSIONS.map((p) => p.key));

export type PermissionKey = string;

export function isPermissionKey(value: string): boolean {
  return PERMISSION_KEYS.has(value);
}

export function isCriticalPermission(key: string): boolean {
  return PERMISSIONS.some((p) => p.key === key && p.isCritical);
}

/** System role codes. `SUPERADMIN` has no rows (bypass via `is_superadmin`). */
export const SYSTEM_ROLES = ['SUPERADMIN', 'ADMIN'] as const;
export const TEMPLATE_ROLES = ['MANAGER', 'EMPLOYEE', 'STAFF'] as const;

const ACTION_LETTERS: Readonly<Record<string, PermissionAction>> = {
  V: 'view',
  C: 'create',
  U: 'update',
  D: 'delete',
  E: 'export',
  A: 'approve',
};

/** §5 template grid (non-reserved keys only; ADMIN receives every key including reserved). */
const TEMPLATE_GRID: Readonly<
  Record<string, readonly [manager: string, employee: string, staff: string]>
> = {
  dashboard: ['V', 'V', 'V'],
  reports: ['VE', '', ''],
  products: ['VCU', 'VCU', 'V'],
  categories: ['VCU', 'V', 'V'],
  brands: ['VCU', 'V', 'V'],
  collections: ['VCU', 'V', ''],
  attributes: ['VCU', 'V', 'V'],
  inventory: ['VCU', 'VC', 'VC'],
  barcodes: ['VC', 'VC', 'VC'],
  orders: ['VUA', 'VU', 'VU'],
  customers: ['VU', 'V', ''],
  coupons: ['VCUD', 'V', ''],
  promotions: ['VCUD', 'V', ''],
  tax: ['V', '', ''],
  payments: ['V', '', ''],
  refunds: ['VCU', 'V', ''],
  shipping: ['VCU', 'VU', 'VU'],
  reviews: ['VUDA', 'VA', ''],
  banners: ['VCUD', 'V', ''],
  cms: ['VCU', 'V', ''],
  notifications: ['VU', '', ''],
  admin_users: ['V', '', ''],
  roles: ['V', '', ''],
  audit_logs: ['V', '', ''],
  settings: ['V', '', ''],
};

export function templatePermissions(role: (typeof TEMPLATE_ROLES)[number]): string[] {
  const column = TEMPLATE_ROLES.indexOf(role);
  const keys: string[] = [];
  for (const [module, cells] of Object.entries(TEMPLATE_GRID)) {
    for (const letter of cells[column] ?? '') {
      const action = ACTION_LETTERS[letter];
      const key = `${module}.${action ?? ''}`;
      if (action !== undefined && PERMISSION_KEYS.has(key)) keys.push(key);
    }
  }
  return keys;
}
