/**
 * Structural facts of the data model — STATIC, OFFLINE evidence only.
 *
 * Source of truth: the text of `prisma/schema.prisma`, parsed here by a small strict parser (it
 * throws on any line it does not understand instead of guessing). The generated Prisma client is
 * deliberately NOT used: `src/generated/prisma` is build output that is not committed.
 *
 * What this file proves: what the Prisma schema DECLARES (models, `@@map` names, column types,
 * keys, relations). What it does NOT prove: anything about a running MySQL — no database is
 * connected, no migration SQL is read, and SQL-only objects (CHECKs, generated columns,
 * partitions) and runtime behaviour (UTC storage, service-layer rules) are out of reach here.
 *
 * Requirements: PROJECT_REQUIREMENTS.md FR-PV-019, FR-INV-027, FR-CPN-010, FR-DB-001, FR-DB-005.
 */
import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const SCHEMA_URL = new URL('../../prisma/schema.prisma', import.meta.url);
/** Sibling documentation folder; absent in a checkout of this repository alone. */
const CONTEXT_DOC_URL = new URL(
  '../../../project-documentation/01-requirements/PROJECT_CONTEXT.md',
  import.meta.url,
);

// ── Minimal schema parser ────────────────────────────────────────────────────────────────────

interface SchemaField {
  readonly name: string;
  /** Scalar, enum or model name, without the `?` / `[]` modifier. */
  readonly type: string;
  readonly isList: boolean;
  readonly isOptional: boolean;
  /** Everything after the type on the field line (attributes), comments removed. */
  readonly attributes: string;
}

interface SchemaModel {
  readonly name: string;
  readonly fields: readonly SchemaField[];
  /** `@@…` lines of the model block. */
  readonly blockAttributes: readonly string[];
}

/** Removes a trailing `// comment` (a `//` inside a double-quoted string is kept). */
function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"' && line[i - 1] !== '\\') inString = !inString;
    if (!inString && char === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

function parseModels(schemaText: string): SchemaModel[] {
  const models: SchemaModel[] = [];
  let block: { kind: string; name: string; lines: string[] } | undefined;

  for (const rawLine of schemaText.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (line === '') continue;

    if (block === undefined) {
      const open = /^(model|enum|generator|datasource)\s+(\w+)\s*\{$/.exec(line);
      if (open?.[1] === undefined || open[2] === undefined) {
        throw new Error(`schema.prisma: unexpected top-level line "${line}"`);
      }
      block = { kind: open[1], name: open[2], lines: [] };
      continue;
    }
    if (line !== '}') {
      block.lines.push(line);
      continue;
    }

    if (block.kind === 'model') {
      const modelName = block.name;
      const fields: SchemaField[] = [];
      const blockAttributes: string[] = [];
      for (const bodyLine of block.lines) {
        if (bodyLine.startsWith('@@')) {
          blockAttributes.push(bodyLine);
          continue;
        }
        const field = /^(\w+)\s+(\w+)(\[\]|\?)?(?:\s+(@.*))?$/.exec(bodyLine);
        if (field?.[1] === undefined || field[2] === undefined) {
          throw new Error(`schema.prisma: cannot parse field of ${modelName}: "${bodyLine}"`);
        }
        fields.push({
          name: field[1],
          type: field[2],
          isList: field[3] === '[]',
          isOptional: field[3] === '?',
          attributes: field[4] ?? '',
        });
      }
      models.push({ name: modelName, fields, blockAttributes });
    }
    block = undefined;
  }
  if (block !== undefined) throw new Error(`schema.prisma: block "${block.name}" is never closed`);
  return models;
}

const schemaText = readFileSync(SCHEMA_URL, 'utf8');
const models = parseModels(schemaText);
const modelNames = new Set(models.map((model) => model.name));

function modelOf(name: string): SchemaModel {
  const model = models.find((candidate) => candidate.name === name);
  if (model === undefined) throw new Error(`model ${name} not found in schema.prisma`);
  return model;
}

function fieldOf(modelName: string, fieldName: string): SchemaField {
  const field = modelOf(modelName).fields.find((candidate) => candidate.name === fieldName);
  if (field === undefined) throw new Error(`field ${modelName}.${fieldName} not found`);
  return field;
}

/** `@@map("…")` table name. */
function tableOf(model: SchemaModel): string | undefined {
  for (const attribute of model.blockAttributes) {
    const match = /^@@map\("([^"]+)"\)$/.exec(attribute);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

/** Database column name: `@map("…")` or the field name. */
function columnOf(field: SchemaField): string {
  return /@map\("([^"]+)"\)/.exec(field.attributes)?.[1] ?? field.name;
}

/** Native type without spaces, e.g. `Decimal(12,2)`, `DateTime(3)`, `Char(36)`, `Date`. */
function nativeTypeOf(field: SchemaField): string | undefined {
  const match = /@db\.(\w+)(?:\(([^)]*)\))?/.exec(field.attributes);
  if (match?.[1] === undefined) return undefined;
  return match[2] === undefined ? match[1] : `${match[1]}(${match[2].replace(/\s+/g, '')})`;
}

const hasFieldAttribute = (field: SchemaField, attribute: 'id' | 'unique'): boolean =>
  new RegExp(`(^|\\s)@${attribute}(\\s|$)`).test(field.attributes);

/** A field whose type is another model (relation field, no column of its own). */
const isRelation = (field: SchemaField): boolean => modelNames.has(field.type);

/** Primary-key field names: `@@id([a, b])` or the single `@id` field. */
function primaryKeyOf(model: SchemaModel): string[] {
  for (const attribute of model.blockAttributes) {
    const match = /^@@id\(\[([^\]]+)\]/.exec(attribute);
    if (match?.[1] !== undefined) return match[1].split(',').map((name) => name.trim());
  }
  return model.fields.filter((field) => hasFieldAttribute(field, 'id')).map((field) => field.name);
}

/** Scalar field names of the `fields: [...]` list of a relation field. */
function relationScalarsOf(field: SchemaField): string[] {
  const match = /@relation\([^)]*fields:\s*\[([^\]]+)\]/.exec(field.attributes);
  return match?.[1] === undefined ? [] : match[1].split(',').map((name) => name.trim());
}

const qualified = (model: SchemaModel, field: SchemaField): string => `${model.name}.${field.name}`;

/** Every `Model.field → value` for fields that pass `select`. */
function collect(
  select: (field: SchemaField, model: SchemaModel) => boolean,
  valueOf: (field: SchemaField) => string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const model of models) {
    for (const field of model.fields) {
      if (select(field, model)) result[qualified(model, field)] = valueOf(field);
    }
  }
  return result;
}

// ── FR-DB-001 — canonical table list (PROJECT_CONTEXT.md §6, read 2026-11-24) ────────────────

/** `★` rows of §6: tables explicitly named by the client (`@@map` name → Prisma model). */
const CLIENT_NAMED_TABLES: Readonly<Record<string, string>> = {
  users: 'User',
  roles: 'Role',
  permissions: 'Permission',
  user_roles: 'UserRole',
  role_permissions: 'RolePermission',
  user_addresses: 'UserAddress',
  refresh_tokens: 'RefreshToken',
  categories: 'Category',
  brands: 'Brand',
  products: 'Product',
  product_images: 'ProductImage',
  product_variants: 'ProductVariant',
  attributes: 'Attribute',
  attribute_values: 'AttributeValue',
  variant_attribute_values: 'VariantAttributeValue',
  inventory: 'Inventory',
  inventory_transactions: 'InventoryTransaction',
  carts: 'Cart',
  cart_items: 'CartItem',
  wishlists: 'Wishlist',
  wishlist_items: 'WishlistItem',
  recently_viewed_products: 'RecentlyViewedProduct',
  orders: 'Order',
  order_items: 'OrderItem',
  payments: 'Payment',
  payment_transactions: 'PaymentTransaction',
  refunds: 'Refund',
  shipping_methods: 'ShippingMethod',
  shipments: 'Shipment',
  coupons: 'Coupon',
  coupon_usage: 'CouponUsage',
  promotions: 'Promotion',
  promotion_products: 'PromotionProduct',
  promotion_categories: 'PromotionCategory',
  reviews: 'Review',
  notifications: 'Notification',
  notification_logs: 'NotificationLog',
  audit_logs: 'AuditLog',
  tax_rates: 'TaxRate',
  product_tax_assignments: 'ProductTaxAssignment',
  tax_transactions: 'TaxTransaction',
  invoice_records: 'InvoiceRecord',
};

/** `+` rows of §6: proposed supporting tables (incl. `promotion_collections`, added by R-11). */
const SUPPORTING_TABLES: Readonly<Record<string, string>> = {
  user_permission_overrides: 'UserPermissionOverride',
  verification_tokens: 'VerificationToken',
  notification_preferences: 'NotificationPreference',
  category_attributes: 'CategoryAttribute',
  collections: 'Collection',
  collection_products: 'CollectionProduct',
  product_attribute_values: 'ProductAttributeValue',
  stock_reservations: 'StockReservation',
  order_status_history: 'OrderStatusHistory',
  refund_items: 'RefundItem',
  shipment_items: 'ShipmentItem',
  shipment_tracking_events: 'ShipmentTrackingEvent',
  coupon_applicability: 'CouponApplicability',
  promotion_brands: 'PromotionBrand',
  notification_templates: 'NotificationTemplate',
  hsn_codes: 'HsnCode',
  states: 'State',
  banners: 'Banner',
  cms_pages: 'CmsPage',
  cms_blocks: 'CmsBlock',
  settings: 'Setting',
  idempotency_keys: 'IdempotencyKey',
  report_exports: 'ReportExport',
  number_sequences: 'NumberSequence',
  promotion_collections: 'PromotionCollection',
};

describe('FR-DB-001 — model inventory of prisma/schema.prisma (static)', () => {
  it('FR-DB-001: the schema declares exactly 67 models, each mapped to one distinct table', () => {
    // Independent of the parser: count the `model X {` lines of the raw text.
    expect(schemaText.match(/^model\s+\w+\s*\{/gm)).toHaveLength(67);
    expect(models).toHaveLength(67);
    expect(modelNames.size).toBe(67);

    const tables = models.map(tableOf);
    expect(tables.filter((table) => table === undefined)).toEqual([]);
    expect(new Set(tables).size).toBe(67);
  });

  it('FR-DB-001: the canonical list is 42 client-named + 25 supporting tables = 67', () => {
    const clientNamed = Object.keys(CLIENT_NAMED_TABLES);
    const supporting = Object.keys(SUPPORTING_TABLES);
    expect(clientNamed).toHaveLength(42);
    expect(supporting).toHaveLength(25);
    expect(new Set([...clientNamed, ...supporting]).size).toBe(67);
    expect(SUPPORTING_TABLES.promotion_collections).toBe('PromotionCollection');
  });

  it('FR-DB-001: every canonical table exists as its Prisma model via @@map, and nothing else does', () => {
    const declared = Object.fromEntries(models.map((model) => [tableOf(model), model.name]));
    expect(declared).toEqual({ ...CLIENT_NAMED_TABLES, ...SUPPORTING_TABLES });
  });

  it.skipIf(!existsSync(CONTEXT_DOC_URL))(
    'FR-DB-001: the canonical list above still equals PROJECT_CONTEXT.md §6 (skipped without the documentation folder)',
    () => {
      const lines = readFileSync(CONTEXT_DOC_URL, 'utf8').split(/\r?\n/);
      const start = lines.findIndex((line) => line.startsWith('## 6. Canonical Table List'));
      expect(start).toBeGreaterThanOrEqual(0);
      const length = lines.slice(start + 1).findIndex((line) => line.startsWith('#'));
      const section = lines.slice(start + 1, length === -1 ? undefined : start + 1 + length);

      const numbers: number[] = [];
      const clientNamed: Record<string, string> = {};
      const supporting: Record<string, string> = {};
      for (const line of section) {
        const row = /^\|\s*(\d+)\s*\|\s*`([a-z_]+)`\s*([★+])\s*\|\s*(\w+)\s*\|/.exec(line);
        if (row?.[1] === undefined || row[2] === undefined || row[4] === undefined) continue;
        numbers.push(Number(row[1]));
        (row[3] === '★' ? clientNamed : supporting)[row[2]] = row[4];
      }

      expect(numbers).toEqual(Array.from({ length: 67 }, (_unused, index) => index + 1));
      expect(clientNamed).toEqual(CLIENT_NAMED_TABLES);
      expect(supporting).toEqual(SUPPORTING_TABLES);
    },
  );
});

// ── FR-DB-005 — "Money as DECIMAL(12,2), never float; timestamps DATETIME(3) UTC; UUID CHAR(36) PKs"

/**
 * Decimal columns that are NOT money, with the precision DATABASE_DESIGN.md §3.4 gives their
 * kind: tax rate / percentage `DECIMAL(5,2)`, weight in grams `DECIMAL(10,3)`, rating average
 * `DECIMAL(3,2)`. Every other Decimal column is treated as money.
 */
const NON_MONEY_DECIMALS: Readonly<Record<string, string>> = {
  'Product.maxDiscountPercent': 'Decimal(5,2)',
  'Product.avgRating': 'Decimal(3,2)',
  'ProductVariant.weightGrams': 'Decimal(10,3)',
  'OrderItem.taxRate': 'Decimal(5,2)',
  'OrderItem.cgstRate': 'Decimal(5,2)',
  'OrderItem.sgstRate': 'Decimal(5,2)',
  'OrderItem.utgstRate': 'Decimal(5,2)',
  'OrderItem.igstRate': 'Decimal(5,2)',
  'OrderItem.weightGramsSnapshot': 'Decimal(10,3)',
  'TaxRate.rate': 'Decimal(5,2)',
  'TaxRate.cgstRate': 'Decimal(5,2)',
  'TaxRate.sgstRate': 'Decimal(5,2)',
  'TaxRate.utgstRate': 'Decimal(5,2)',
  'TaxRate.igstRate': 'Decimal(5,2)',
  'TaxTransaction.rate': 'Decimal(5,2)',
};

/**
 * DateTime fields that are calendar dates, not timestamps: DATABASE_DESIGN.md §3.4 "Business
 * date — `DATE` — IST date (e.g. `invoice_date`, `tax_date`)" and principle P6.
 */
const BUSINESS_DATE_COLUMNS: Readonly<Record<string, string>> = {
  'TaxTransaction.taxDate': 'Date',
  'InvoiceRecord.invoiceDate': 'Date',
};

/**
 * Models whose primary key is not the standard `id String @id @default(uuid()) @db.Char(36)`,
 * as `[key field, native type]` pairs. Each one is a documented case of PROJECT_CONTEXT.md §3.2
 * / DATABASE_DESIGN.md §3.3, not a waiver:
 *  - junction tables: composite PK of two UUID CHAR(36) foreign keys;
 *  - `inventory`: PK = `variant_id` (1:1 with the variant, still a UUID CHAR(36));
 *  - `audit_logs`: PK `(id, created_at)` — the UUID plus the partition column (DATABASE_DESIGN
 *    §audit_logs: "partitioning requires the partition column in every unique key");
 *  - `states`, `settings`, `number_sequences`: natural-key reference/system tables — the only
 *    primary keys that are not UUIDs.
 */
const NON_STANDARD_PRIMARY_KEYS: Readonly<Record<string, readonly (readonly [string, string])[]>> =
  {
    UserRole: [
      ['userId', 'Char(36)'],
      ['roleId', 'Char(36)'],
    ],
    RolePermission: [
      ['roleId', 'Char(36)'],
      ['permissionId', 'Char(36)'],
    ],
    CategoryAttribute: [
      ['categoryId', 'Char(36)'],
      ['attributeId', 'Char(36)'],
    ],
    CollectionProduct: [
      ['collectionId', 'Char(36)'],
      ['productId', 'Char(36)'],
    ],
    VariantAttributeValue: [
      ['variantId', 'Char(36)'],
      ['attributeId', 'Char(36)'],
    ],
    ProductAttributeValue: [
      ['productId', 'Char(36)'],
      ['attributeValueId', 'Char(36)'],
    ],
    ShipmentItem: [
      ['shipmentId', 'Char(36)'],
      ['orderItemId', 'Char(36)'],
    ],
    PromotionProduct: [
      ['promotionId', 'Char(36)'],
      ['productId', 'Char(36)'],
    ],
    PromotionCategory: [
      ['promotionId', 'Char(36)'],
      ['categoryId', 'Char(36)'],
    ],
    PromotionBrand: [
      ['promotionId', 'Char(36)'],
      ['brandId', 'Char(36)'],
    ],
    PromotionCollection: [
      ['promotionId', 'Char(36)'],
      ['collectionId', 'Char(36)'],
    ],
    Inventory: [['variantId', 'Char(36)']],
    AuditLog: [
      ['id', 'Char(36)'],
      ['createdAt', 'DateTime(3)'],
    ],
    State: [['code', 'Char(2)']],
    Setting: [['settingKey', 'VarChar(100)']],
    NumberSequence: [
      ['sequenceKey', 'VarChar(50)'],
      ['periodKey', 'VarChar(20)'],
    ],
  };

/** Column-name words that mean "an amount of money" in this schema (`*_total` = last word). */
function isMoneyNamed(column: string): boolean {
  const words = column.split('_');
  return (
    words.some((word) => ['price', 'amount', 'charge', 'mrp', 'subtotal', 'cost'].includes(word)) ||
    words.at(-1) === 'total'
  );
}

describe('FR-DB-005 — schema conventions across all models (static)', () => {
  it('FR-DB-005: no column is a float — neither the Float scalar nor a float/double native type', () => {
    const floats = collect(
      (field) => field.type === 'Float' || /^(Float|Double|Real)\b/.test(nativeTypeOf(field) ?? ''),
      (field) => `${field.type} ${nativeTypeOf(field) ?? ''}`.trim(),
    );
    expect(floats).toEqual({});
  });

  it('FR-DB-005: every Decimal column is DECIMAL(12,2) money, except the listed rate/weight/rating columns', () => {
    const decimals = collect(
      (field) => field.type === 'Decimal',
      (field) => nativeTypeOf(field) ?? 'no @db type',
    );
    const notTwelveTwo = Object.fromEntries(
      Object.entries(decimals).filter(([, nativeType]) => nativeType !== 'Decimal(12,2)'),
    );
    // Exact match: a new non-(12,2) Decimal column, or a stale entry in the list, both fail.
    expect(notTwelveTwo).toEqual(NON_MONEY_DECIMALS);

    const money = Object.keys(decimals).filter((name) => !(name in NON_MONEY_DECIMALS));
    expect(money).toEqual(
      expect.arrayContaining([
        'ProductVariant.mrp',
        'ProductVariant.sellingPrice',
        'OrderItem.unitPrice',
        'Order.grandTotal',
        'Payment.amount',
        'Refund.amount',
      ]),
    );
  });

  it('FR-DB-005: every money-named column (price/amount/charge/mrp/subtotal/cost/*_total) is Decimal @db.Decimal(12,2)', () => {
    const moneyNamed = collect(
      (field) => !isRelation(field) && isMoneyNamed(columnOf(field)),
      (field) => `${field.type} ${nativeTypeOf(field) ?? 'no @db type'}`,
    );
    expect(Object.keys(moneyNamed).length).toBeGreaterThan(0);
    const notMoneyTyped = Object.fromEntries(
      Object.entries(moneyNamed).filter(([, type]) => type !== 'Decimal Decimal(12,2)'),
    );
    expect(notMoneyTyped).toEqual({});
  });

  it('FR-DB-005: every DateTime column is DATETIME(3), except the two business DATE columns', () => {
    // Static check of the declared precision only; that the stored instants are UTC is a
    // runtime property (TZ=UTC is enforced by src/core/config/env.ts) and is not proven here.
    const dateTimes = collect(
      (field) => field.type === 'DateTime',
      (field) => nativeTypeOf(field) ?? 'no @db type',
    );
    expect(Object.keys(dateTimes).length).toBeGreaterThan(0);
    const notMillisecond = Object.fromEntries(
      Object.entries(dateTimes).filter(([, nativeType]) => nativeType !== 'DateTime(3)'),
    );
    expect(notMillisecond).toEqual(BUSINESS_DATE_COLUMNS);
  });

  it('FR-DB-005: primary keys are `id` UUID CHAR(36), except the listed junction / natural-key / partitioned tables', () => {
    const standard: string[] = [];
    const nonStandard: Record<string, [string, string][]> = {};
    for (const model of models) {
      const key = primaryKeyOf(model);
      expect(key.length, `${model.name} has no primary key`).toBeGreaterThan(0);
      const id = key.length === 1 && key[0] === 'id' ? fieldOf(model.name, 'id') : undefined;
      if (
        id?.type === 'String' &&
        !id.isOptional &&
        nativeTypeOf(id) === 'Char(36)' &&
        id.attributes.includes('@default(uuid())')
      ) {
        standard.push(model.name);
      } else {
        nonStandard[model.name] = key.map((name): [string, string] => {
          const field = fieldOf(model.name, name);
          return [name, nativeTypeOf(field) ?? field.type];
        });
      }
    }

    // Exact match: any new model with a different key shape, or a stale entry, fails.
    expect(nonStandard).toEqual(NON_STANDARD_PRIMARY_KEYS);
    expect(standard).toHaveLength(models.length - Object.keys(NON_STANDARD_PRIMARY_KEYS).length);
    expect(standard).toEqual(
      expect.arrayContaining(['User', 'Product', 'ProductVariant', 'Order', 'OrderItem', 'Coupon']),
    );
  });

  it('FR-DB-005: every UUID key part of a non-standard primary key is a foreign key to a UUID `id` (or the audit id)', () => {
    for (const [modelName, key] of Object.entries(NON_STANDARD_PRIMARY_KEYS)) {
      const model = modelOf(modelName);
      const foreignKeyScalars = model.fields.flatMap((field) =>
        isRelation(field) && /references:\s*\[id\]/.test(field.attributes)
          ? relationScalarsOf(field)
          : [],
      );
      for (const [fieldName, nativeType] of key) {
        if (nativeType !== 'Char(36)') continue;
        if (modelName === 'AuditLog' && fieldName === 'id') continue; // own UUID, app-generated
        expect(foreignKeyScalars, `${modelName}.${fieldName}`).toContain(fieldName);
      }
    }
  });
});

// ── FR-PV-019 — "Fixed price per variant." ───────────────────────────────────────────────────

describe('FR-PV-019 — fixed price per variant (static)', () => {
  it('FR-PV-019: the price columns live on product_variants as required DECIMAL(12,2) scalars', () => {
    expect(tableOf(modelOf('ProductVariant'))).toBe('product_variants');
    for (const [fieldName, column] of [
      ['mrp', 'mrp'],
      ['sellingPrice', 'selling_price'],
    ] as const) {
      const field = fieldOf('ProductVariant', fieldName);
      expect(columnOf(field)).toBe(column);
      expect(field.type).toBe('Decimal');
      expect(field.isOptional).toBe(false);
      expect(field.isList).toBe(false);
      expect(nativeTypeOf(field)).toBe('Decimal(12,2)');
    }
  });

  it('FR-PV-019: products carries no price of its own — only the nullable min/max listing range', () => {
    // min/max_selling_price are denormalized from the variants (DATABASE_DESIGN.md §products).
    const product = modelOf('Product');
    const moneyColumns = product.fields.filter(
      (field) => field.type === 'Decimal' && nativeTypeOf(field) === 'Decimal(12,2)',
    );
    expect(moneyColumns.map((field) => field.name).sort()).toEqual([
      'maxSellingPrice',
      'minSellingPrice',
    ]);
    expect(moneyColumns.every((field) => field.isOptional)).toBe(true);
    const names = product.fields.map((field) => field.name);
    expect(names).not.toContain('mrp');
    expect(names).not.toContain('sellingPrice');
    expect(names).not.toContain('price');
  });

  it('FR-PV-019: there is no separate price-list or metal-rate model (dynamic metal pricing not implemented)', () => {
    const suspects = models
      .flatMap((model) => [model.name, tableOf(model) ?? ''])
      .filter((name) => /price|metal/i.test(name));
    expect(suspects).toEqual([]);
  });
});

// ── FR-INV-027 — "Single stock location." ────────────────────────────────────────────────────

describe('FR-INV-027 — single stock location (static)', () => {
  it('FR-INV-027: inventory has exactly one row per variant — its primary key is variant_id alone', () => {
    const inventory = modelOf('Inventory');
    expect(tableOf(inventory)).toBe('inventory');
    expect(primaryKeyOf(inventory)).toEqual(['variantId']);
    expect(columnOf(fieldOf('Inventory', 'variantId'))).toBe('variant_id');

    const toVariant = fieldOf('Inventory', 'variant');
    expect(toVariant.type).toBe('ProductVariant');
    expect(relationScalarsOf(toVariant)).toEqual(['variantId']);

    // The back-relation is one-to-one, not a list of per-location rows.
    const fromVariant = fieldOf('ProductVariant', 'inventory');
    expect(fromVariant.type).toBe('Inventory');
    expect(fromVariant.isList).toBe(false);
  });

  it('FR-INV-027: there is no location / warehouse model or table', () => {
    const suspects = models
      .flatMap((model) => [model.name, tableOf(model) ?? ''])
      .filter((name) => /warehouse|location/i.test(name));
    expect(suspects).toEqual([]);
  });

  it('FR-INV-027: no stock table has a location / warehouse column', () => {
    const stockModels = ['Inventory', 'InventoryTransaction', 'StockReservation'];
    const suspects = collect(
      (field, model) =>
        stockModels.includes(model.name) &&
        /warehouse|location/i.test(`${field.name} ${columnOf(field)} ${field.type}`),
      (field) => field.type,
    );
    expect(suspects).toEqual({});
  });
});

// ── FR-CPN-010 — "One coupon per order." ─────────────────────────────────────────────────────

describe('FR-CPN-010 — one coupon per cart / order (static)', () => {
  it.each([
    ['Order', 'orders'],
    ['Cart', 'carts'],
  ])(
    'FR-CPN-010: %s (%s) references at most one coupon through a single nullable coupon_id',
    (modelName, table) => {
      const model = modelOf(modelName);
      expect(tableOf(model)).toBe(table);

      const couponRelations = model.fields.filter((field) => field.type === 'Coupon');
      expect(couponRelations).toHaveLength(1);
      const relation = couponRelations[0];
      expect(relation?.isList).toBe(false);
      expect(relation === undefined ? [] : relationScalarsOf(relation)).toEqual(['couponId']);

      const couponId = fieldOf(modelName, 'couponId');
      expect(columnOf(couponId)).toBe('coupon_id');
      expect(couponId.type).toBe('String');
      expect(couponId.isOptional).toBe(true);
      expect(couponId.isList).toBe(false);
      expect(nativeTypeOf(couponId)).toBe('Char(36)');
    },
  );

  it('FR-CPN-010: coupon_usage holds at most one row per order (order_id is unique, back-relation is singular)', () => {
    const orderId = fieldOf('CouponUsage', 'orderId');
    expect(columnOf(orderId)).toBe('order_id');
    expect(hasFieldAttribute(orderId, 'unique')).toBe(true);

    const fromOrder = fieldOf('Order', 'couponUsage');
    expect(fromOrder.type).toBe('CouponUsage');
    expect(fromOrder.isList).toBe(false);
  });

  it('FR-CPN-010: no join table links coupons to orders or carts', () => {
    // Order and Cart hold the single coupon_id themselves; CouponUsage is unique per order (above).
    const joinModels = models
      .filter((model) => !['Order', 'Cart', 'CouponUsage'].includes(model.name))
      .filter((model) => {
        const related = new Set(model.fields.filter(isRelation).map((field) => field.type));
        return related.has('Coupon') && (related.has('Order') || related.has('Cart'));
      })
      .map((model) => model.name);
    expect(joinModels).toEqual([]);
  });
});
