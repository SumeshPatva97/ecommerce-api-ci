/**
 * Fixtures for the products/catalog/media tests (MOCKED DB — rows are plain objects shaped like
 * the Prisma `select`s used by the repositories; no MySQL involved).
 */
import { randomUUID } from 'node:crypto';

import { dec } from '../../../../src/lib/money.js';
import type { MockModels } from '../../../helpers/mockDb.js';

export const T0 = new Date('2026-11-01T10:00:00.000Z');
export const UPLOAD_FOLDER = 'ecom/dev';

/** Sensible "nothing found" defaults so services see `null`/`[]`/`0` instead of `undefined`. */
export function primeEmptyDb(m: MockModels): void {
  for (const model of [
    'product',
    'productVariant',
    'productImage',
    'category',
    'brand',
    'collection',
    'attribute',
    'attributeValue',
    'hsnCode',
    'productTaxAssignment',
    'wishlistItem',
  ] as const) {
    const delegate = m[model] as unknown as Record<
      string,
      { mockResolvedValue: (v: unknown) => void }
    >;
    delegate.findFirst?.mockResolvedValue(null);
    delegate.findUnique?.mockResolvedValue(null);
    delegate.findMany?.mockResolvedValue([]);
    delegate.count?.mockResolvedValue(0);
  }
  for (const model of [
    'productAttributeValue',
    'categoryAttribute',
    'stockReservation',
    'orderItem',
    'inventoryTransaction',
    'review',
  ] as const) {
    const delegate = m[model] as unknown as Record<
      string,
      { mockResolvedValue: (v: unknown) => void }
    >;
    delegate.findMany?.mockResolvedValue([]);
    delegate.count?.mockResolvedValue(0);
  }
  // Writes echo their data with an id, like Prisma would (select ignored).
  const echo = (prefix: string) => (args: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: `${prefix}-${randomUUID()}`, ...args.data });
  m.product.create.mockImplementation(echo('p'));
  m.productVariant.create.mockImplementation((args: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: randomUUID(), ...args.data }),
  );
  m.productImage.create.mockImplementation((args: { data: Record<string, unknown> }) =>
    Promise.resolve({
      id: randomUUID(),
      width: null,
      height: null,
      format: null,
      createdAt: T0,
      ...args.data,
    }),
  );
}

export function categoryNode(
  overrides: Partial<{
    id: string;
    parentId: string | null;
    name: string;
    slug: string;
    isActive: boolean;
    deletedAt: Date | null;
  }> = {},
) {
  return {
    id: randomUUID(),
    parentId: null,
    name: 'Rings',
    slug: 'rings',
    isActive: true,
    deletedAt: null,
    ...overrides,
  };
}

export interface AttributeFixture {
  id: string;
  code: string;
  name: string;
  isVariantAxis: boolean;
  isActive: boolean;
  deletedAt: Date | null;
  sortOrder: number;
  displayType: 'TEXT' | 'SWATCH' | 'BUTTON' | 'DROPDOWN';
}

export function attribute(overrides: Partial<AttributeFixture> = {}): AttributeFixture {
  return {
    id: randomUUID(),
    code: 'metal-finish',
    name: 'Metal Finish',
    isVariantAxis: true,
    isActive: true,
    deletedAt: null,
    sortOrder: 0,
    displayType: 'SWATCH',
    ...overrides,
  };
}

export function attributeValue(attr: AttributeFixture, value: string, sortOrder = 0) {
  return {
    id: randomUUID(),
    attributeId: attr.id,
    value,
    slug: value.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    swatchHex: null,
    sortOrder,
    isActive: true,
    deletedAt: null,
    attribute: attr,
  };
}
export type ValueFixture = ReturnType<typeof attributeValue>;

/** Makes `attribute.findMany` / `attributeValue.findMany` answer `where.id.in` lookups. */
export function serveAttributes(
  m: MockModels,
  attributes: readonly AttributeFixture[],
  values: readonly ValueFixture[],
): void {
  m.attribute.findMany.mockImplementation((args?: { where?: { id?: { in?: string[] } } }) =>
    Promise.resolve(attributes.filter((a) => args?.where?.id?.in?.includes(a.id) ?? true)),
  );
  m.attributeValue.findMany.mockImplementation((args?: { where?: { id?: { in?: string[] } } }) =>
    Promise.resolve(values.filter((v) => args?.where?.id?.in?.includes(v.id) ?? true)),
  );
}

export function productCore(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    productType: 'VARIABLE',
    name: 'Meera Kundan Jhumka',
    nameNormalized: 'meera kundan jhumka',
    slug: 'meera-kundan-jhumka',
    categoryId: randomUUID(),
    brandId: null,
    status: 'DRAFT',
    publishedAt: null,
    hsnCode: null,
    updatedAt: T0,
    ...overrides,
  };
}

export function variantAdminRow(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    productId: randomUUID(),
    sku: 'EAR-MEERA-GLD-S',
    barcode: null,
    name: 'Gold / Small',
    combinationKey: 'a|b',
    mrp: dec('1799.00'),
    sellingPrice: dec('1499.00'),
    compareAtPrice: null,
    costPrice: dec('620.00'),
    weightGrams: dec('4.25'),
    lengthMm: null,
    widthMm: null,
    heightMm: null,
    status: 'ACTIVE',
    isDefault: false,
    sortOrder: 0,
    createdAt: T0,
    updatedAt: T0,
    inventory: { quantityOnHand: 10, quantityReserved: 2, lowStockThreshold: null },
    variantValues: [],
    _count: { images: 1 },
    ...overrides,
  };
}

export function productAdminRow(overrides: Record<string, unknown> = {}) {
  const core = productCore();
  return {
    ...core,
    shortDescription: null,
    description: null,
    careInstructions: null,
    searchKeywords: null,
    isFeatured: false,
    isNewArrival: false,
    isBestSellerPinned: false,
    minSellingPrice: dec('1499'),
    maxSellingPrice: dec('1499'),
    isInStock: true,
    avgRating: dec('4.6'),
    reviewCount: 38,
    totalSold: 12,
    countryOfOrigin: 'India',
    manufacturerName: null,
    manufacturerAddress: null,
    importerName: null,
    importerAddress: null,
    seoTitle: null,
    seoDescription: null,
    createdAt: T0,
    createdById: null,
    updatedById: null,
    category: { id: core.categoryId, name: 'Jhumkas', slug: 'jhumkas' },
    brand: null,
    attributeValues: [],
    collections: [],
    variants: [variantAdminRow({ productId: core.id })],
    images: [],
    ...overrides,
  };
}

/** Public card row (catalog `cardSelect`). */
export function cardRow(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    slug: 'tara-silver-ring',
    name: 'Tara Silver Ring',
    productType: 'SIMPLE',
    isNewArrival: false,
    isBestSellerPinned: true,
    publishedAt: new Date('2026-06-01T00:00:00.000Z'),
    avgRating: dec('4.5'),
    reviewCount: 3,
    totalSold: 40,
    brand: { id: randomUUID(), name: 'Aura', slug: 'aura' },
    category: { id: randomUUID(), name: 'Rings', slug: 'rings' },
    images: [
      { cloudinaryPublicId: `${UPLOAD_FOLDER}/products/x/main`, altText: 'Front' },
      { cloudinaryPublicId: `${UPLOAD_FOLDER}/products/x/model`, altText: 'On model' },
    ],
    variants: [
      {
        id: randomUUID(),
        sku: 'RNG-TARA-SLV',
        name: 'Tara Silver Ring',
        mrp: dec('1199'),
        sellingPrice: dec('999'),
        isDefault: true,
        sortOrder: 0,
        inventory: { quantityOnHand: 3, quantityReserved: 0, lowStockThreshold: null },
        variantValues: [],
      },
    ],
    ...overrides,
  };
}
