/**
 * Checkout / payments fixtures for MOCKED-DB tests (tests/helpers/mockDb.ts). Rows mirror the
 * Prisma selects of checkout (cart, addresses, states, shipping methods), the pricing loader, tax
 * resolution, inventory locking and number allocation. Values reproduce the API_DOCUMENTATION.md
 * §3.9 worked example (WELCOME10 + Festive 10 % + Standard Delivery ₹99, 3 % GST, seller 27).
 */
import { Prisma } from '../../../../src/generated/prisma/client.js';
import type { MockModels } from '../../../helpers/mockDb.js';

const D = (v: string | number) => new Prisma.Decimal(v);

export const IDS = {
  user: '11111111-1111-4111-8111-111111111111',
  cart: '22222222-2222-4222-8222-222222222222',
  addrPune: '33333333-3333-4333-8333-333333333301',
  addrBlr: '33333333-3333-4333-8333-333333333302',
  method: '44444444-4444-4444-8444-444444444401',
  item1: 'ci-1',
  item2: 'ci-2',
  v1: 'v-meera-gold-s',
  v2: 'v-ring-silver-7',
  p1: 'p-meera',
  p2: 'p-tara',
  catEar: 'cat-earrings',
  catRing: 'cat-rings',
  promo: 'p-fest',
  coupon: '55555555-5555-4555-8555-555555555501',
  rate3: 'tr-gst-3',
  order: '66666666-6666-4666-8666-666666666601',
  payment: '77777777-7777-4777-8777-777777777701',
} as const;

export const NOW = new Date('2026-11-13T09:46:03.120Z');
const PUBLISHED = new Date('2026-10-01T00:00:00.000Z');

export interface LineOptions {
  readonly onHand?: number;
  readonly reserved?: number;
  readonly sellingPrice?: string;
  readonly quantity?: number;
}

function item(
  o: {
    id: string;
    variantId: string;
    productId: string;
    productName: string;
    variantName: string;
    sku: string;
    quantity: number;
    mrp: string;
    sellingPrice: string;
    categoryId: string;
    categoryName: string;
  } & LineOptions,
) {
  return {
    id: o.id,
    variantId: o.variantId,
    quantity: o.quantity,
    unitPriceAtAdd: D(o.sellingPrice),
    variant: {
      id: o.variantId,
      sku: o.sku,
      barcode: null,
      name: o.variantName,
      mrp: D(o.mrp),
      sellingPrice: D(o.sellingPrice),
      costPrice: D('600.00'),
      weightGrams: D('12.500'),
      status: 'ACTIVE',
      deletedAt: null,
      productId: o.productId,
      inventory: { quantityOnHand: o.onHand ?? 20, quantityReserved: o.reserved ?? 0 },
      images: [{ url: `https://img.example.com/${o.sku}.jpg` }],
      variantValues: [
        { attribute: { name: 'Size', code: 'size' }, attributeValue: { value: o.variantName } },
      ],
      product: {
        id: o.productId,
        name: o.productName,
        status: 'ACTIVE',
        deletedAt: null,
        publishedAt: PUBLISHED,
        categoryId: o.categoryId,
        brandId: null,
        category: { name: o.categoryName },
        brand: null,
        images: [],
      },
    },
  };
}

export const jhumka = (o: LineOptions = {}) =>
  item({
    id: IDS.item1,
    variantId: IDS.v1,
    productId: IDS.p1,
    productName: 'Meera Kundan Jhumka',
    variantName: 'Gold / Small',
    sku: 'EAR-MEERA-GLD-S',
    quantity: o.quantity ?? 2,
    mrp: '1799.00',
    sellingPrice: o.sellingPrice ?? '1499.00',
    categoryId: IDS.catEar,
    categoryName: 'Earrings',
    ...o,
  });

export const ring = (o: LineOptions = {}) =>
  item({
    id: IDS.item2,
    variantId: IDS.v2,
    productId: IDS.p2,
    productName: 'Tara Silver Ring',
    variantName: 'Size 7',
    sku: 'RNG-TARA-SLV-7',
    quantity: o.quantity ?? 1,
    mrp: '1199.00',
    sellingPrice: o.sellingPrice ?? '999.00',
    categoryId: IDS.catRing,
    categoryName: 'Rings',
    ...o,
  });

function address(id: string, stateCode: string, stateName: string, pincode: string, city: string) {
  return {
    id,
    label: 'HOME',
    fullName: 'Ananya Rao',
    phone: '+919812345678',
    line1: 'Flat 12B, Lotus Residency',
    line2: 'Baner Road',
    landmark: null,
    city,
    district: null,
    stateCode,
    postalCode: pincode,
    countryCode: 'IN',
    companyName: null,
    gstin: null,
    isDefault: id === IDS.addrPune,
    createdAt: PUBLISHED,
    updatedAt: PUBLISHED,
    state: { name: stateName },
  };
}

export const STATES: Record<string, Record<string, unknown>> = {
  '27': { code: '27', name: 'Maharashtra', isUnionTerritory: false, hasLegislature: true },
  '29': { code: '29', name: 'Karnataka', isUnionTerritory: false, hasLegislature: true },
};

export function promotionRow() {
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
    priority: 10,
    createdAt: PUBLISHED,
    products: [],
    categories: [{ categoryId: IDS.catEar, includeDescendants: true }],
    brands: [],
    collections: [],
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

export const methodRow = {
  id: IDS.method,
  code: 'STD',
  name: 'Standard Delivery',
  rateType: 'FLAT',
  baseCharge: D('99.00'),
  freeAboveAmount: D('4999.00'),
  etaMinDays: 3,
  etaMaxDays: 6,
  codSupported: true,
  codCharge: D('49.00'),
  sortOrder: 1,
};

export interface PrimeOptions {
  readonly items?: ReturnType<typeof item>[];
  readonly couponId?: string | null;
  readonly coupon?: Record<string, unknown> | null;
  readonly settings?: Record<string, unknown>;
  readonly taxSettings?: { settingKey: string; value: unknown }[];
  /** Inventory rows returned by the FOR UPDATE lock (variantId → [onHand, reserved]). */
  readonly locked?: Record<string, [number, number]>;
  readonly withTax?: boolean;
  readonly emailVerified?: boolean;
}

export const DEFAULT_TAX_SETTINGS = [
  { settingKey: 'tax.seller_state_code', value: '27' },
  { settingKey: 'tax.seller_gstin', value: '27ABCDE1234F1Z5' },
];

/** SQL text of a `$queryRaw` call (tagged template or `Prisma.sql`). */
export function sqlOf(first: unknown): string {
  if (Array.isArray(first)) return first.join('?');
  if (typeof first === 'object' && first !== null && 'sql' in first) {
    return String(first.sql);
  }
  return '';
}

/** Configures every query summary/placement runs. Returns the cart row. */
export function primeCheckout(m: MockModels, userId: string, o: PrimeOptions = {}) {
  const items = o.items ?? [jhumka(), ring()];
  const couponId = o.couponId === undefined ? IDS.coupon : o.couponId;
  const cart = {
    id: IDS.cart,
    userId,
    couponId,
    couponCode: couponId === null ? null : 'WELCOME10',
    items,
  };
  m.userAddress.findMany.mockResolvedValue([
    address(IDS.addrPune, '27', 'Maharashtra', '411045', 'Pune'),
    address(IDS.addrBlr, '29', 'Karnataka', '560001', 'Bengaluru'),
  ]);
  m.user.findUnique.mockResolvedValue({
    id: userId,
    firstName: 'Ananya',
    lastName: 'Rao',
    email: 'ananya@example.com',
    phone: '+919812345678',
    status: 'ACTIVE',
    emailVerifiedAt: o.emailVerified === false ? null : PUBLISHED,
  });
  m.cart.findFirst.mockResolvedValue(cart);
  const settings = o.settings ?? {};
  m.setting.findUnique.mockImplementation((args: { where: { settingKey: string } }) =>
    Promise.resolve(
      args.where.settingKey in settings ? { value: settings[args.where.settingKey] } : null,
    ),
  );
  m.setting.findMany.mockResolvedValue(o.taxSettings ?? DEFAULT_TAX_SETTINGS);
  m.product.findMany.mockResolvedValue([
    { id: IDS.p1, categoryId: IDS.catEar, brandId: null, hsnCode: null, collections: [] },
    { id: IDS.p2, categoryId: IDS.catRing, brandId: null, hsnCode: '7113', collections: [] },
  ]);
  m.category.findMany.mockResolvedValue([
    { id: IDS.catEar, parentId: null },
    { id: IDS.catRing, parentId: null },
  ]);
  m.promotion.findMany.mockResolvedValue([promotionRow()]);
  m.coupon.findUnique.mockResolvedValue(couponId === null ? null : (o.coupon ?? couponRow()));
  m.couponUsage.count.mockResolvedValue(0);
  m.couponUsage.findUnique.mockResolvedValue(null);
  m.order.count.mockResolvedValue(0);
  const taxRate = { id: IDS.rate3, name: 'GST 3%', rate: D('3.00'), isActive: true };
  m.productTaxAssignment.findMany.mockResolvedValue(
    o.withTax === false
      ? []
      : [
          {
            id: 'assign-ear',
            targetType: 'CATEGORY',
            productId: null,
            categoryId: IDS.catEar,
            taxRateId: IDS.rate3,
            hsnCode: '7117',
            effectiveFrom: new Date('2026-04-01T00:00:00.000Z'),
            effectiveTo: null,
            taxRate,
          },
          {
            id: 'assign-ring',
            targetType: 'PRODUCT',
            productId: IDS.p2,
            categoryId: null,
            taxRateId: IDS.rate3,
            hsnCode: '7113',
            effectiveFrom: new Date('2026-04-01T00:00:00.000Z'),
            effectiveTo: null,
            taxRate,
          },
        ],
  );
  m.state.findUnique.mockImplementation((args: { where: { code: string } }) =>
    Promise.resolve(STATES[args.where.code] ?? null),
  );
  m.shippingMethod.findMany.mockResolvedValue([methodRow]);

  // Placement transaction.
  const locked = o.locked ?? { [IDS.v1]: [20, 0], [IDS.v2]: [20, 0] };
  m.$queryRaw.mockImplementation((first: unknown) => {
    const sql = sqlOf(first);
    if (sql.includes('number_sequences')) return Promise.resolve([{ next_value: 42 }]);
    if (sql.includes('FROM inventory')) {
      return Promise.resolve(
        Object.entries(locked).map(([variantId, [onHand, reserved]]) => ({
          variantId,
          onHand,
          reserved,
          lowStockThreshold: null,
          lowStockAlertedAt: null,
        })),
      );
    }
    return Promise.resolve([]);
  });
  m.stockReservation.findMany.mockResolvedValue([]);
  m.notification.findUnique.mockResolvedValue(null);
  m.idempotencyKey.create.mockResolvedValue({ id: 'idem-row' });
  m.idempotencyKey.update.mockResolvedValue({});
  m.cart.updateMany.mockResolvedValue({ count: 1 });
  return cart;
}

export const summaryBody = (over: Record<string, unknown> = {}) => ({
  shippingAddressId: IDS.addrPune,
  shippingMethodId: IDS.method,
  paymentMethod: 'ONLINE',
  ...over,
});

/** Serviceability stub matching the §3.9 example (3–6 days, COD not offered at the pincode). */
export const serviceable = (pincode: string) =>
  Promise.resolve({
    pincode,
    serviceable: !pincode.startsWith('9'),
    city: null,
    stateCode: null,
    estimatedDelivery: { minDays: 3, maxDays: 6 },
    codAvailable: true,
  });
