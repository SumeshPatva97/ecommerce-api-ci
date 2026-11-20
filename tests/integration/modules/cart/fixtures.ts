/**
 * Cart / pricing fixtures for MOCKED-DB HTTP tests (tests/helpers/mockDb.ts). Rows mirror the
 * Prisma selects of the cart, pricing-loader and tax-resolution queries.
 */
import { Prisma } from '../../../../src/generated/prisma/client.js';
import type { ModuleTestApp } from '../../../helpers/container.js';

const D = (v: string | number) => new Prisma.Decimal(v);

export const IDS = {
  cart: '0b3d6a3e-9a59-4f0b-8f3c-000000000001',
  itemJhumka: '0b3d6a3e-9a59-4f0b-8f3c-0000000000a1',
  itemRing: '0b3d6a3e-9a59-4f0b-8f3c-0000000000a2',
  vJhumka: '0b3d6a3e-9a59-4f0b-8f3c-0000000000b1',
  vRing: '0b3d6a3e-9a59-4f0b-8f3c-0000000000b2',
  vOther: '0b3d6a3e-9a59-4f0b-8f3c-0000000000b3',
  pJhumka: '0b3d6a3e-9a59-4f0b-8f3c-0000000000c1',
  pRing: '0b3d6a3e-9a59-4f0b-8f3c-0000000000c2',
  catEar: '0b3d6a3e-9a59-4f0b-8f3c-0000000000d1',
  catRing: '0b3d6a3e-9a59-4f0b-8f3c-0000000000d2',
  catRoot: '0b3d6a3e-9a59-4f0b-8f3c-0000000000d3',
  promo: '0b3d6a3e-9a59-4f0b-8f3c-0000000000e1',
  coupon: '0b3d6a3e-9a59-4f0b-8f3c-0000000000f1',
  rate: '0b3d6a3e-9a59-4f0b-8f3c-0000000000f2',
} as const;

const PUBLISHED = new Date('2026-10-01T00:00:00.000Z');

interface ItemOptions {
  id: string;
  variantId: string;
  productId: string;
  productName: string;
  variantName: string;
  sku: string;
  quantity: number;
  mrp: string;
  sellingPrice: string;
  unitPriceAtAdd?: string;
  onHand?: number;
  reserved?: number;
  variantStatus?: string;
  productStatus?: string;
}

export function cartItemRow(o: ItemOptions) {
  return {
    id: o.id,
    variantId: o.variantId,
    quantity: o.quantity,
    unitPriceAtAdd: D(o.unitPriceAtAdd ?? o.sellingPrice),
    createdAt: new Date('2026-11-18T10:00:00.000Z'),
    variant: {
      id: o.variantId,
      sku: o.sku,
      name: o.variantName,
      mrp: D(o.mrp),
      sellingPrice: D(o.sellingPrice),
      status: o.variantStatus ?? 'ACTIVE',
      deletedAt: null,
      productId: o.productId,
      inventory: {
        quantityOnHand: o.onHand ?? 50,
        quantityReserved: o.reserved ?? 0,
        lowStockThreshold: null,
      },
      images: [],
      product: {
        id: o.productId,
        slug: o.productName.toLowerCase().replace(/\s+/g, '-'),
        name: o.productName,
        status: o.productStatus ?? 'ACTIVE',
        deletedAt: null,
        publishedAt: PUBLISHED,
        images: [{ cloudinaryPublicId: `products/${o.sku.toLowerCase()}`, altText: o.productName }],
      },
    },
  };
}

export const jhumka = (over: Partial<ItemOptions> = {}) =>
  cartItemRow({
    id: IDS.itemJhumka,
    variantId: IDS.vJhumka,
    productId: IDS.pJhumka,
    productName: 'Meera Kundan Jhumka',
    variantName: 'Gold / Small',
    sku: 'EAR-MEERA-GLD-S',
    quantity: 2,
    mrp: '1799.00',
    sellingPrice: '1499.00',
    ...over,
  });

export const ring = (over: Partial<ItemOptions> = {}) =>
  cartItemRow({
    id: IDS.itemRing,
    variantId: IDS.vRing,
    productId: IDS.pRing,
    productName: 'Tara Silver Ring',
    variantName: 'Size 7',
    sku: 'RNG-TARA-SLV-7',
    quantity: 1,
    mrp: '1199.00',
    sellingPrice: '999.00',
    ...over,
  });

export function promotionRow(over: Record<string, unknown> = {}) {
  return {
    id: IDS.promo,
    name: 'Festive 10% off',
    scope: 'CATEGORY',
    discountType: 'PERCENTAGE',
    discountValue: D(10),
    maxDiscountAmount: null,
    startsAt: new Date('2026-11-01T00:00:00.000Z'),
    endsAt: new Date('2026-12-01T00:00:00.000Z'),
    status: 'ACTIVE',
    deletedAt: null,
    priority: 50,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    products: [],
    categories: [{ categoryId: IDS.catEar, includeDescendants: true }],
    brands: [],
    collections: [],
    ...over,
  };
}

export function couponRow(over: Record<string, unknown> = {}) {
  return {
    id: IDS.coupon,
    code: 'WELCOME10',
    description: '10% off up to ₹300',
    status: 'ACTIVE',
    deletedAt: null,
    discountType: 'PERCENTAGE',
    discountValue: D(10),
    maxDiscountAmount: D(300),
    minOrderValue: null,
    startsAt: new Date('2026-11-01T00:00:00.000Z'),
    expiresAt: new Date('2026-12-31T18:29:59.999Z'),
    usageLimitEnabled: false,
    usageLimit: null,
    usedCount: 0,
    perCustomerLimit: null,
    isFirstOrderOnly: false,
    isCombinableWithPromotions: true,
    applicabilities: [],
    ...over,
  };
}

export interface PrimeOptions {
  userId?: string;
  items?: ReturnType<typeof cartItemRow>[];
  couponId?: string | null;
  couponCode?: string | null;
  promotions?: Record<string, unknown>[];
  coupon?: Record<string, unknown> | null;
  /** GST rate for every product (null → no assignment). */
  ratePercent?: string | null;
}

/** Configures every query a cart view runs (cart, settings, pricing loader, tax resolution). */
export function primeCart(t: ModuleTestApp, o: PrimeOptions = {}) {
  const items = o.items ?? [];
  const cart = {
    id: IDS.cart,
    userId: o.userId ?? 'u',
    couponId: o.couponId ?? null,
    couponCode: o.couponCode ?? null,
    items,
  };
  t.m.cart.findFirst.mockResolvedValue(cart);
  t.m.cart.create.mockResolvedValue({ ...cart, items: [] });
  // M1 claim (`claimActiveCart`): the resolved cart is still the customer's ACTIVE cart.
  t.m.cart.updateMany.mockResolvedValue({ count: 1 });
  t.m.setting.findUnique.mockResolvedValue(null);
  t.m.setting.findMany.mockResolvedValue([]);
  const productIds = [...new Set(items.map((i) => i.variant.product.id))];
  t.m.product.findMany.mockResolvedValue(
    productIds.map((id) => ({
      id,
      categoryId: id === IDS.pRing ? IDS.catRing : IDS.catEar,
      brandId: null,
      hsnCode: '7117',
      collections: [],
    })),
  );
  t.m.category.findMany.mockResolvedValue([
    { id: IDS.catEar, parentId: IDS.catRoot },
    { id: IDS.catRing, parentId: IDS.catRoot },
    { id: IDS.catRoot, parentId: null },
  ]);
  t.m.promotion.findMany.mockResolvedValue(o.promotions ?? []);
  t.m.coupon.findUnique.mockResolvedValue(o.coupon ?? null);
  t.m.couponUsage.count.mockResolvedValue(0);
  t.m.order.count.mockResolvedValue(0);
  const rate = o.ratePercent === undefined ? '3.00' : o.ratePercent;
  t.m.productTaxAssignment.findMany.mockResolvedValue(
    rate === null
      ? []
      : [
          {
            id: 'assign-root',
            targetType: 'CATEGORY',
            productId: null,
            categoryId: IDS.catRoot,
            taxRateId: IDS.rate,
            hsnCode: '7117',
            effectiveFrom: new Date('2026-04-01T00:00:00.000Z'),
            effectiveTo: null,
            taxRate: { id: IDS.rate, name: 'GST 3%', rate: D(rate), isActive: true },
          },
        ],
  );
  return cart;
}

/** Variant row for add/update/merge checks. */
export function variantCheck(over: Record<string, unknown> = {}) {
  return {
    id: IDS.vOther,
    sku: 'EAR-MEERA-GLD-M',
    name: 'Gold / Medium',
    status: 'ACTIVE',
    deletedAt: null,
    sellingPrice: D('1499.00'),
    product: {
      name: 'Meera Kundan Jhumka',
      status: 'ACTIVE',
      deletedAt: null,
      publishedAt: PUBLISHED,
    },
    inventory: { quantityOnHand: 10, quantityReserved: 0 },
    ...over,
  };
}
