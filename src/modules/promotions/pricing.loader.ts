/**
 * Pricing input loader — reads everything the pure pricing engine (`src/lib/pricing`) needs for a
 * set of cart/order lines: catalogue context per product (category path, brand, collections),
 * currently effective promotions touching those products, the coupon snapshot and the customer's
 * coupon context. Used by the cart module and (later) checkout, inside or outside a transaction
 * (pass the transaction client as `db`).
 *
 * Promotion effectiveness (DATABASE_DESIGN §11.4): status SCHEDULED/ACTIVE, not deleted,
 * `starts_at ≤ now < ends_at` — the engine re-checks the same rule.
 */
import type { Queryable } from '../../core/db/transaction.js';
import type { Decimal } from '../../lib/money.js';
import type {
  CouponSnapshot,
  CustomerPricingContext,
  PricingInput,
  PricingLineInput,
  PromotionSnapshot,
} from '../../lib/pricing/index.js';

/** Category depth is ≤ 3 (PROJECT_CONTEXT); guard against malformed cycles. */
const MAX_CATEGORY_HOPS = 5;

/** Order statuses that do not count as a "previous order" for first-order coupons (OQ-16). */
const NOT_AN_ORDER = ['CANCELLED', 'PAYMENT_FAILED'] as const;

export interface PricingItemRef {
  readonly lineId: string;
  readonly variantId: string;
  readonly productId: string;
  readonly quantity: number;
  readonly mrp: Decimal;
  readonly sellingPrice: Decimal;
}

export interface ProductPricingContext {
  readonly categoryId: string;
  readonly categoryPath: readonly string[];
  readonly brandId: string | null;
  readonly collectionIds: readonly string[];
}

export type CouponRef =
  { readonly id: string } | { readonly codeNormalized: string } | null | undefined;

export interface LoadedPricingInput extends PricingInput {
  /** A coupon reference was given but no row exists (or it is soft-deleted). */
  readonly couponMissing: boolean;
}

export const couponSnapshotSelect = {
  id: true,
  code: true,
  description: true,
  status: true,
  deletedAt: true,
  discountType: true,
  discountValue: true,
  maxDiscountAmount: true,
  minOrderValue: true,
  startsAt: true,
  expiresAt: true,
  usageLimitEnabled: true,
  usageLimit: true,
  usedCount: true,
  perCustomerLimit: true,
  isFirstOrderOnly: true,
  isCombinableWithPromotions: true,
  applicabilities: {
    select: {
      ruleType: true,
      targetType: true,
      productId: true,
      categoryId: true,
      brandId: true,
      collectionId: true,
    },
  },
} as const;

interface CouponRow {
  id: string;
  code: string;
  description: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  deletedAt: Date | null;
  discountType: 'PERCENTAGE' | 'FIXED_AMOUNT';
  discountValue: Decimal;
  maxDiscountAmount: Decimal | null;
  minOrderValue: Decimal | null;
  startsAt: Date | null;
  expiresAt: Date | null;
  usageLimitEnabled: boolean;
  usageLimit: number | null;
  usedCount: number;
  perCustomerLimit: number | null;
  isFirstOrderOnly: boolean;
  isCombinableWithPromotions: boolean;
  applicabilities: {
    ruleType: 'INCLUDE' | 'EXCLUDE';
    targetType: 'PRODUCT' | 'CATEGORY' | 'BRAND' | 'COLLECTION';
    productId: string | null;
    categoryId: string | null;
    brandId: string | null;
    collectionId: string | null;
  }[];
}

export function toCouponSnapshot(row: CouponRow): CouponSnapshot {
  return {
    id: row.id,
    code: row.code,
    description: row.description,
    status: row.status,
    deleted: row.deletedAt !== null,
    discountType: row.discountType,
    discountValue: row.discountValue,
    maxDiscountAmount: row.maxDiscountAmount,
    minOrderValue: row.minOrderValue,
    startsAt: row.startsAt,
    expiresAt: row.expiresAt,
    usageLimitEnabled: row.usageLimitEnabled,
    usageLimit: row.usageLimit,
    usedCount: row.usedCount,
    perCustomerLimit: row.perCustomerLimit,
    isFirstOrderOnly: row.isFirstOrderOnly,
    isCombinableWithPromotions: row.isCombinableWithPromotions,
    rules: row.applicabilities.flatMap((a) => {
      const targetId = a.productId ?? a.categoryId ?? a.brandId ?? a.collectionId;
      return targetId === null
        ? []
        : [{ ruleType: a.ruleType, targetType: a.targetType, targetId }];
    }),
  };
}

const promotionSelect = {
  id: true,
  name: true,
  scope: true,
  discountType: true,
  discountValue: true,
  maxDiscountAmount: true,
  startsAt: true,
  endsAt: true,
  status: true,
  deletedAt: true,
  priority: true,
  createdAt: true,
  products: { select: { productId: true } },
  categories: { select: { categoryId: true, includeDescendants: true } },
  brands: { select: { brandId: true } },
  collections: { select: { collectionId: true } },
} as const;

interface PromotionRow {
  id: string;
  name: string;
  scope: PromotionSnapshot['scope'];
  discountType: PromotionSnapshot['discountType'];
  discountValue: Decimal;
  maxDiscountAmount: Decimal | null;
  startsAt: Date | null;
  endsAt: Date | null;
  status: PromotionSnapshot['status'];
  deletedAt: Date | null;
  priority: number;
  createdAt: Date;
  products: { productId: string }[];
  categories: { categoryId: string; includeDescendants: boolean }[];
  brands: { brandId: string }[];
  collections: { collectionId: string }[];
}

export function toPromotionSnapshot(row: PromotionRow): PromotionSnapshot {
  const targets = (() => {
    switch (row.scope) {
      case 'PRODUCT':
        return row.products.map((t) => ({ id: t.productId }));
      case 'CATEGORY':
        return row.categories.map((t) => ({
          id: t.categoryId,
          includeDescendants: t.includeDescendants,
        }));
      case 'BRAND':
        return row.brands.map((t) => ({ id: t.brandId }));
      case 'COLLECTION':
        return row.collections.map((t) => ({ id: t.collectionId }));
    }
  })();
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    discountType: row.discountType,
    discountValue: row.discountValue,
    maxDiscountAmount: row.maxDiscountAmount,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    status: row.status,
    deleted: row.deletedAt !== null,
    priority: row.priority,
    createdAt: row.createdAt,
    targets,
  };
}

export interface PricingInputLoader {
  loadProductContexts(
    db: Queryable,
    productIds: readonly string[],
  ): Promise<Map<string, ProductPricingContext>>;
  loadActivePromotions(
    db: Queryable,
    contexts: ReadonlyMap<string, ProductPricingContext>,
    now: Date,
  ): Promise<PromotionSnapshot[]>;
  loadCoupon(db: Queryable, ref: CouponRef): Promise<CouponSnapshot | null>;
  loadCustomerContext(
    db: Queryable,
    userId: string,
    couponId: string,
  ): Promise<CustomerPricingContext>;
  /** One call for the whole engine input. Lines whose product is unknown are dropped. */
  load(
    db: Queryable,
    args: {
      readonly items: readonly PricingItemRef[];
      readonly userId: string;
      readonly coupon?: CouponRef;
      readonly now: Date;
    },
  ): Promise<LoadedPricingInput>;
}

export function createPricingInputLoader(): PricingInputLoader {
  const loader: PricingInputLoader = {
    async loadProductContexts(db, productIds) {
      const ids = [...new Set(productIds)];
      const out = new Map<string, ProductPricingContext>();
      if (ids.length === 0) return out;
      const products = await db.product.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          categoryId: true,
          brandId: true,
          collections: { select: { collectionId: true } },
        },
      });
      const parentOf = new Map<string, string | null>();
      let pending = [...new Set(products.map((p) => p.categoryId))];
      for (let hop = 0; hop < MAX_CATEGORY_HOPS && pending.length > 0; hop += 1) {
        const rows = await db.category.findMany({
          where: { id: { in: pending } },
          select: { id: true, parentId: true },
        });
        for (const row of rows) parentOf.set(row.id, row.parentId);
        pending = rows
          .map((r) => r.parentId)
          .filter((id): id is string => id !== null && !parentOf.has(id));
      }
      for (const p of products) {
        const path: string[] = [];
        let current: string | null | undefined = p.categoryId;
        while (typeof current === 'string' && !path.includes(current)) {
          path.push(current);
          current = parentOf.get(current);
        }
        out.set(p.id, {
          categoryId: p.categoryId,
          categoryPath: path,
          brandId: p.brandId,
          collectionIds: p.collections.map((c) => c.collectionId),
        });
      }
      return out;
    },

    async loadActivePromotions(db, contexts, now) {
      if (contexts.size === 0) return [];
      const all = [...contexts.values()];
      const productIds = [...contexts.keys()];
      const categoryIds = [...new Set(all.flatMap((c) => c.categoryPath))];
      const brandIds = [
        ...new Set(all.map((c) => c.brandId).filter((b): b is string => b !== null)),
      ];
      const collectionIds = [...new Set(all.flatMap((c) => c.collectionIds))];
      const rows = await db.promotion.findMany({
        where: {
          deletedAt: null,
          status: { in: ['SCHEDULED', 'ACTIVE'] },
          AND: [
            { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
            { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
            {
              OR: [
                { products: { some: { productId: { in: productIds } } } },
                { categories: { some: { categoryId: { in: categoryIds } } } },
                { brands: { some: { brandId: { in: brandIds } } } },
                { collections: { some: { collectionId: { in: collectionIds } } } },
              ],
            },
          ],
        },
        select: promotionSelect,
      });
      return rows.map(toPromotionSnapshot);
    },

    async loadCoupon(db, ref) {
      if (ref === null || ref === undefined) return null;
      const row =
        'id' in ref
          ? await db.coupon.findUnique({ where: { id: ref.id }, select: couponSnapshotSelect })
          : await db.coupon.findUnique({
              where: { codeNormalized: ref.codeNormalized },
              select: couponSnapshotSelect,
            });
      if (row?.deletedAt !== null) return null;
      return toCouponSnapshot(row);
    },

    async loadCustomerContext(db, userId, couponId) {
      const [uses, orders] = await Promise.all([
        db.couponUsage.count({
          where: { couponId, userId, status: { in: ['RESERVED', 'REDEEMED'] } },
        }),
        db.order.count({ where: { userId, status: { notIn: [...NOT_AN_ORDER] } } }),
      ]);
      return { couponUsesByCustomer: uses, isFirstOrder: orders === 0 };
    },

    async load(db, args) {
      const contexts = await loader.loadProductContexts(
        db,
        args.items.map((i) => i.productId),
      );
      const lines: PricingLineInput[] = args.items.flatMap((item) => {
        const ctx = contexts.get(item.productId);
        return ctx === undefined ? [] : [{ ...item, ...ctx }];
      });
      const hasCouponRef = args.coupon !== null && args.coupon !== undefined;
      const [promotions, coupon] = await Promise.all([
        loader.loadActivePromotions(db, contexts, args.now),
        loader.loadCoupon(db, args.coupon),
      ]);
      const customer =
        coupon === null
          ? { isFirstOrder: true, couponUsesByCustomer: 0 }
          : await loader.loadCustomerContext(db, args.userId, coupon.id);
      return {
        lines,
        promotions,
        coupon,
        customer,
        now: args.now,
        couponMissing: hasCouponRef && coupon === null,
      };
    },
  };
  return loader;
}
