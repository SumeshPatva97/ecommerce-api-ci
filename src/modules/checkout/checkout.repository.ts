/**
 * Checkout reads (Prisma only). The cart is read with everything the order-item snapshots need
 * (names, SKU/barcode, attributes, image, category/brand, cost/weight) — DATABASE_DESIGN §21,
 * ORDER_PAYMENT_AND_REFUND_DATABASE_DESIGN §3. Always scoped by `userId`.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import type { Queryable } from '../../core/db/transaction.js';

const imageSelect = { url: true } as const;

export const checkoutCartSelect = {
  id: true,
  userId: true,
  couponId: true,
  couponCode: true,
  items: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      variantId: true,
      quantity: true,
      unitPriceAtAdd: true,
      variant: {
        select: {
          id: true,
          sku: true,
          barcode: true,
          name: true,
          mrp: true,
          sellingPrice: true,
          costPrice: true,
          weightGrams: true,
          status: true,
          deletedAt: true,
          productId: true,
          inventory: { select: { quantityOnHand: true, quantityReserved: true } },
          images: {
            where: { mediaType: 'IMAGE' },
            select: imageSelect,
            orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
            take: 1,
          },
          variantValues: {
            select: {
              attribute: { select: { name: true, code: true } },
              attributeValue: { select: { value: true } },
            },
          },
          product: {
            select: {
              id: true,
              name: true,
              status: true,
              deletedAt: true,
              publishedAt: true,
              categoryId: true,
              brandId: true,
              category: { select: { name: true } },
              brand: { select: { name: true } },
              images: {
                where: { mediaType: 'IMAGE', variantId: null },
                select: imageSelect,
                orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
                take: 1,
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.CartSelect;

export type CheckoutCartRow = Prisma.CartGetPayload<{ select: typeof checkoutCartSelect }>;
export type CheckoutCartItem = CheckoutCartRow['items'][number];

export const shippingMethodSelect = {
  id: true,
  code: true,
  name: true,
  rateType: true,
  baseCharge: true,
  freeAboveAmount: true,
  etaMinDays: true,
  etaMaxDays: true,
  codSupported: true,
  codCharge: true,
  sortOrder: true,
} satisfies Prisma.ShippingMethodSelect;

export type ShippingMethodRow = Prisma.ShippingMethodGetPayload<{
  select: typeof shippingMethodSelect;
}>;

/** PROVISIONAL (OQ-06): COD off unless `checkout.cod_enabled = true`. */
export const COD_ENABLED_SETTING_KEY = 'checkout.cod_enabled';

/**
 * FR-AD-008: `checkout.reservation_ttl_minutes` (int 5–120, settings.values.ts). A missing or
 * invalid value falls back to the configured `RESERVATION_TTL_MINUTES` (env, default 15).
 */
export const RESERVATION_TTL_SETTING_KEY = 'checkout.reservation_ttl_minutes';
const MIN_RESERVATION_TTL_MINUTES = 5;
const MAX_RESERVATION_TTL_MINUTES = 120;

export function createCheckoutRepository() {
  return {
    findActiveCart(db: Queryable, userId: string): Promise<CheckoutCartRow | null> {
      return db.cart.findFirst({
        where: { userId, status: 'ACTIVE' },
        orderBy: { createdAt: 'asc' },
        select: checkoutCartSelect,
      });
    },

    listActiveMethods(db: Queryable): Promise<ShippingMethodRow[]> {
      return db.shippingMethod.findMany({
        where: { isActive: true, deletedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: shippingMethodSelect,
      });
    },

    findState(
      db: Queryable,
      code: string,
    ): Promise<{
      code: string;
      name: string;
      isUnionTerritory: boolean;
      hasLegislature: boolean;
    } | null> {
      return db.state.findUnique({
        where: { code },
        select: { code: true, name: true, isUnionTerritory: true, hasLegislature: true },
      });
    },

    async codEnabled(db: Queryable): Promise<boolean> {
      const row = await db.setting.findUnique({
        where: { settingKey: COD_ENABLED_SETTING_KEY },
        select: { value: true },
      });
      return row?.value === true;
    },

    async reservationTtlMinutes(db: Queryable, fallback: number): Promise<number> {
      const row = await db.setting.findUnique({
        where: { settingKey: RESERVATION_TTL_SETTING_KEY },
        select: { value: true },
      });
      const value = row?.value;
      return typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= MIN_RESERVATION_TTL_MINUTES &&
        value <= MAX_RESERVATION_TTL_MINUTES
        ? value
        : fallback;
    },

    async fixedShippingRate(db: Queryable, taxRateId: string | null): Promise<string | null> {
      if (taxRateId === null) return null;
      const rate = await db.taxRate.findUnique({
        where: { id: taxRateId },
        select: { rate: true, isActive: true },
      });
      return rate?.isActive === true ? rate.rate.toFixed(2) : null;
    },

    findCustomer(db: Queryable, userId: string) {
      return db.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          status: true,
          emailVerifiedAt: true,
        },
      });
    },

    async detachCoupon(db: Queryable, cartId: string): Promise<void> {
      await db.cart.update({
        where: { id: cartId },
        data: { couponId: null, couponCode: null },
        select: { id: true },
      });
    },
  };
}

export type CheckoutRepository = ReturnType<typeof createCheckoutRepository>;
