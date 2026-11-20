/**
 * DEC-12 — test data for `ecommerce_test` (INSERT / UPSERT only, after `cleanDatabase`).
 *
 * Reference data reuses the project seeds (`prisma/seed/*.seed.ts`: GST states, default settings,
 * notification templates). Business fixtures are the minimum a REAL checkout needs: a published
 * product with one ACTIVE variant + inventory, a 3 % GST rate / HSN 7113 product assignment, one
 * active FLAT shipping method, and per customer an ACTIVE + email-verified user, one Karnataka
 * address (intra-state supply, seller state 29) and an ACTIVE cart holding the variant.
 * All identifiers are generated per run; no personal data (example.test addresses).
 */
import { randomUUID } from 'node:crypto';

import type { Prisma, PrismaClient } from '../../../src/generated/prisma/client.js';
import { seedNotificationTemplates } from '../../../prisma/seed/notification-templates.seed.js';
import { seedSettings } from '../../../prisma/seed/settings.seed.js';
import { seedStates } from '../../../prisma/seed/states.seed.js';

export const SELLER_STATE_CODE = '29';
export const UNIT_PRICE = '1000.00';
const DAY_MS = 24 * 3600 * 1000;

export interface ReferenceOptions {
  /** `checkout.cod_enabled` (default false, as seeded). */
  readonly codEnabled?: boolean;
}

async function upsertSetting(
  db: PrismaClient,
  settingKey: string,
  value: Prisma.InputJsonValue,
  valueType: 'STRING' | 'BOOLEAN' | 'NUMBER',
): Promise<void> {
  await db.setting.upsert({
    where: { settingKey },
    create: {
      settingKey,
      groupKey: settingKey.split('.')[0] ?? settingKey,
      value,
      valueType,
      isPublic: false,
      description: 'DEC-12 test fixture',
    },
    update: { value },
  });
}

export async function seedReference(db: PrismaClient, options: ReferenceOptions = {}): Promise<void> {
  await db.$transaction((tx) => seedStates(tx), { timeout: 60_000 });
  await db.$transaction((tx) => seedSettings(tx), { timeout: 60_000 });
  await db.$transaction((tx) => seedNotificationTemplates(tx), { timeout: 60_000 });
  // Tax settings are deliberately not seeded (D-57); checkout fails closed without a seller state.
  await upsertSetting(db, 'tax.seller_state_code', SELLER_STATE_CODE, 'STRING');
  await upsertSetting(db, 'checkout.cod_enabled', options.codEnabled === true, 'BOOLEAN');
}

export interface CatalogFixture {
  readonly productId: string;
  readonly variantId: string;
  readonly sku: string;
  readonly shippingMethodId: string;
}

export async function seedCatalog(
  db: PrismaClient,
  options: { readonly onHand: number; readonly codSupported?: boolean },
): Promise<CatalogFixture> {
  const tag = randomUUID().slice(0, 8);
  const now = Date.now();
  const taxRateId = randomUUID();
  const categoryId = randomUUID();
  const productId = randomUUID();
  const variantId = randomUUID();
  const shippingMethodId = randomUUID();
  const sku = `DBT-${tag.toUpperCase()}`;

  await db.taxRate.create({
    data: {
      id: taxRateId,
      name: `GST 3% ${tag}`,
      nameNormalized: `gst 3% ${tag}`,
      rate: '3.00',
      cgstRate: '1.50',
      sgstRate: '1.50',
      utgstRate: '1.50',
      igstRate: '3.00',
    },
  });
  await db.hsnCode.create({
    data: { hsnCode: '7113', description: 'Articles of jewellery', defaultTaxRateId: taxRateId },
  });
  await db.category.create({
    data: {
      id: categoryId,
      name: `DB Test ${tag}`,
      nameNormalized: `db test ${tag}`,
      slug: `db-test-${tag}`,
      path: categoryId,
      depth: 1,
    },
  });
  await db.product.create({
    data: {
      id: productId,
      productType: 'SIMPLE',
      name: `DB Test Ring ${tag}`,
      nameNormalized: `db test ring ${tag}`,
      slug: `db-test-ring-${tag}`,
      categoryId,
      status: 'ACTIVE',
      publishedAt: new Date(now - DAY_MS),
      hsnCode: '7113',
      isInStock: options.onHand > 0,
    },
  });
  await db.productVariant.create({
    data: {
      id: variantId,
      productId,
      sku,
      name: 'Default',
      combinationKey: 'default',
      mrp: UNIT_PRICE,
      sellingPrice: UNIT_PRICE,
      status: 'ACTIVE',
      isDefault: true,
    },
  });
  await db.inventory.create({ data: { variantId, quantityOnHand: options.onHand } });
  await db.productTaxAssignment.create({
    data: {
      targetType: 'PRODUCT',
      productId,
      taxRateId,
      hsnCode: '7113',
      effectiveFrom: new Date(now - 30 * DAY_MS),
    },
  });
  await db.shippingMethod.create({
    data: {
      id: shippingMethodId,
      code: `DBT_STD_${tag.toUpperCase()}`,
      name: `Standard ${tag}`,
      nameNormalized: `standard ${tag}`,
      rateType: 'FLAT',
      baseCharge: '0.00',
      codSupported: options.codSupported === true,
      codCharge: '0.00',
      etaMinDays: 2,
      etaMaxDays: 5,
      isActive: true,
    },
  });
  return { productId, variantId, sku, shippingMethodId };
}

export interface CouponFixture {
  readonly id: string;
  readonly code: string;
}

/** FIXED ₹100 coupon, `usage_limit` enabled, `used_count = 0`, no per-customer limit. */
export async function seedCoupon(
  db: PrismaClient,
  options: { readonly usageLimit: number },
): Promise<CouponFixture> {
  const id = randomUUID();
  const code = `DBT${randomUUID().slice(0, 8).toUpperCase()}`;
  await db.coupon.create({
    data: {
      id,
      code,
      codeNormalized: code,
      discountType: 'FIXED_AMOUNT',
      discountValue: '100.00',
      usageLimitEnabled: true,
      usageLimit: options.usageLimit,
      usedCount: 0,
      status: 'ACTIVE',
    },
  });
  return { id, code };
}

export interface CustomerFixture {
  readonly index: number;
  readonly userId: string;
  readonly email: string;
  readonly addressId: string;
  readonly cartId: string;
}

/** `count` ACTIVE, email-verified customers, each with one address and an ACTIVE cart (qty 1). */
export async function seedCustomers(
  db: PrismaClient,
  count: number,
  options: {
    readonly variantId: string;
    readonly quantity?: number;
    readonly coupon?: CouponFixture;
  },
): Promise<CustomerFixture[]> {
  const run = randomUUID().slice(0, 8);
  const verifiedAt = new Date(Date.now() - DAY_MS);
  const customers: CustomerFixture[] = Array.from({ length: count }, (_unused, index) => ({
    index,
    userId: randomUUID(),
    email: `dbtest-${run}-${String(index)}@example.test`,
    addressId: randomUUID(),
    cartId: randomUUID(),
  }));
  await db.user.createMany({
    data: customers.map((c) => ({
      id: c.userId,
      accountType: 'CUSTOMER' as const,
      email: c.email,
      emailNormalized: c.email,
      firstName: 'Dbtest',
      lastName: `Customer${String(c.index)}`,
      status: 'ACTIVE' as const,
      emailVerifiedAt: verifiedAt,
      lastLoginAt: verifiedAt,
    })),
  });
  await db.userAddress.createMany({
    data: customers.map((c) => ({
      id: c.addressId,
      userId: c.userId,
      fullName: `Dbtest Customer${String(c.index)}`,
      phone: '+919800000000',
      line1: '1 Test Street',
      city: 'Bengaluru',
      stateCode: SELLER_STATE_CODE,
      postalCode: '560001',
      isDefault: true,
    })),
  });
  await db.cart.createMany({
    data: customers.map((c) => ({
      id: c.cartId,
      userId: c.userId,
      status: 'ACTIVE' as const,
      couponId: options.coupon?.id ?? null,
      couponCode: options.coupon?.code ?? null,
    })),
  });
  await db.cartItem.createMany({
    data: customers.map((c) => ({
      cartId: c.cartId,
      variantId: options.variantId,
      quantity: options.quantity ?? 1,
      unitPriceAtAdd: UNIT_PRICE,
    })),
  });
  return customers;
}
