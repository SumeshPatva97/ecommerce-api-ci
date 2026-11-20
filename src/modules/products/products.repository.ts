/**
 * Prisma access for admin products/variants/images. Explicit `select`s only (BACKEND_STRUCTURE §6
 * rule 7). Every function takes a `Queryable` so services can pass the transaction client.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import type { Queryable } from '../../core/db/transaction.js';

// ----------------------------------------------------------------------------- selects
export const attributeRefSelect = {
  id: true,
  code: true,
  name: true,
  isVariantAxis: true,
  isActive: true,
  deletedAt: true,
  sortOrder: true,
  displayType: true,
} satisfies Prisma.AttributeSelect;

export const attributeValueRefSelect = {
  id: true,
  attributeId: true,
  value: true,
  slug: true,
  swatchHex: true,
  sortOrder: true,
  isActive: true,
  deletedAt: true,
  attribute: { select: attributeRefSelect },
} satisfies Prisma.AttributeValueSelect;
export type AttributeValueRef = Prisma.AttributeValueGetPayload<{
  select: typeof attributeValueRefSelect;
}>;
export type AttributeRef = Prisma.AttributeGetPayload<{ select: typeof attributeRefSelect }>;

export const variantAdminSelect = {
  id: true,
  productId: true,
  sku: true,
  barcode: true,
  name: true,
  combinationKey: true,
  mrp: true,
  sellingPrice: true,
  compareAtPrice: true,
  costPrice: true,
  weightGrams: true,
  lengthMm: true,
  widthMm: true,
  heightMm: true,
  status: true,
  isDefault: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
  inventory: {
    select: { quantityOnHand: true, quantityReserved: true, lowStockThreshold: true },
  },
  variantValues: {
    select: {
      attributeId: true,
      attributeValueId: true,
      attribute: { select: { code: true, name: true, sortOrder: true } },
      attributeValue: { select: { value: true, slug: true, sortOrder: true } },
    },
  },
  _count: { select: { images: true } },
} satisfies Prisma.ProductVariantSelect;
export type VariantAdminRow = Prisma.ProductVariantGetPayload<{
  select: typeof variantAdminSelect;
}>;

export const imageSelect = {
  id: true,
  productId: true,
  variantId: true,
  cloudinaryPublicId: true,
  url: true,
  altText: true,
  width: true,
  height: true,
  format: true,
  sortOrder: true,
  isPrimary: true,
  mediaType: true,
  createdAt: true,
} satisfies Prisma.ProductImageSelect;
export type ImageRow = Prisma.ProductImageGetPayload<{ select: typeof imageSelect }>;

export const productCoreSelect = {
  id: true,
  productType: true,
  name: true,
  nameNormalized: true,
  slug: true,
  categoryId: true,
  brandId: true,
  status: true,
  publishedAt: true,
  hsnCode: true,
  updatedAt: true,
} satisfies Prisma.ProductSelect;
export type ProductCore = Prisma.ProductGetPayload<{ select: typeof productCoreSelect }>;

export const productAdminSelect = {
  ...productCoreSelect,
  shortDescription: true,
  description: true,
  careInstructions: true,
  searchKeywords: true,
  isFeatured: true,
  isNewArrival: true,
  isBestSellerPinned: true,
  minSellingPrice: true,
  maxSellingPrice: true,
  isInStock: true,
  avgRating: true,
  reviewCount: true,
  totalSold: true,
  countryOfOrigin: true,
  manufacturerName: true,
  manufacturerAddress: true,
  importerName: true,
  importerAddress: true,
  seoTitle: true,
  seoDescription: true,
  createdAt: true,
  createdById: true,
  updatedById: true,
  category: { select: { id: true, name: true, slug: true } },
  brand: { select: { id: true, name: true, slug: true } },
  attributeValues: {
    select: {
      attributeId: true,
      attributeValueId: true,
      attribute: { select: { code: true, name: true, sortOrder: true } },
      attributeValue: { select: { value: true, slug: true, sortOrder: true } },
    },
  },
  collections: {
    select: { collection: { select: { id: true, name: true, slug: true } } },
    orderBy: { sortOrder: 'asc' },
  },
  variants: {
    where: { deletedAt: null },
    select: variantAdminSelect,
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  },
  images: { select: imageSelect, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
} satisfies Prisma.ProductSelect;
export type ProductAdminRow = Prisma.ProductGetPayload<{ select: typeof productAdminSelect }>;

export const productListSelect = {
  id: true,
  name: true,
  slug: true,
  productType: true,
  status: true,
  updatedAt: true,
  updatedById: true,
  minSellingPrice: true,
  maxSellingPrice: true,
  category: { select: { id: true, name: true, slug: true } },
  brand: { select: { id: true, name: true, slug: true } },
  variants: {
    where: { deletedAt: null },
    select: {
      sellingPrice: true,
      inventory: { select: { quantityOnHand: true, quantityReserved: true } },
    },
  },
  images: {
    select: { cloudinaryPublicId: true },
    orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
    take: 1,
  },
} satisfies Prisma.ProductSelect;
export type ProductListRow = Prisma.ProductGetPayload<{ select: typeof productListSelect }>;

export interface CategoryNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly slug: string;
  readonly isActive: boolean;
  readonly deletedAt: Date | null;
}

// ----------------------------------------------------------------------------- queries
export function createProductsRepository() {
  return {
    findCore(db: Queryable, id: string): Promise<ProductCore | null> {
      return db.product.findFirst({ where: { id, deletedAt: null }, select: productCoreSelect });
    },

    findAdmin(db: Queryable, id: string): Promise<ProductAdminRow | null> {
      return db.product.findFirst({ where: { id, deletedAt: null }, select: productAdminSelect });
    },

    async list(
      db: Queryable,
      where: Prisma.ProductWhereInput,
      orderBy: Prisma.ProductOrderByWithRelationInput[],
      skip: number,
      take: number,
    ): Promise<{ rows: ProductListRow[]; total: number }> {
      const [rows, total] = await Promise.all([
        db.product.findMany({ where, orderBy, skip, take, select: productListSelect }),
        db.product.count({ where }),
      ]);
      return { rows, total };
    },

    /** Name conflicts include soft-deleted rows (OQ-39: names stay reserved). */
    findNameConflict(
      db: Queryable,
      categoryId: string,
      nameNormalized: string,
      excludeId?: string,
    ) {
      return db.product.findFirst({
        where: {
          categoryId,
          nameNormalized,
          ...(excludeId === undefined ? {} : { id: { not: excludeId } }),
        },
        select: { id: true, name: true, deletedAt: true, category: { select: { name: true } } },
      });
    },

    findSlugConflict(db: Queryable, slug: string, excludeId?: string) {
      return db.product.findFirst({
        where: { slug, ...(excludeId === undefined ? {} : { id: { not: excludeId } }) },
        select: { id: true, name: true, deletedAt: true },
      });
    },

    /** SKU/barcode conflicts include soft-deleted variants (never reusable). */
    findCodeConflicts(
      db: Queryable,
      field: 'sku' | 'barcode',
      values: readonly string[],
      excludeVariantId?: string,
    ) {
      if (values.length === 0) return Promise.resolve([]);
      return db.productVariant.findMany({
        where: {
          [field]: { in: [...values] },
          ...(excludeVariantId === undefined ? {} : { id: { not: excludeVariantId } }),
        },
        select: {
          id: true,
          sku: true,
          barcode: true,
          deletedAt: true,
          productId: true,
          product: { select: { name: true } },
        },
      });
    },

    /** Category plus ancestors, root first (max depth 3). Empty when the category is unknown. */
    async categoryChain(db: Queryable, categoryId: string): Promise<CategoryNode[]> {
      const chain: CategoryNode[] = [];
      let nextId: string | null = categoryId;
      for (let depth = 0; nextId !== null && depth < 5; depth += 1) {
        const node: CategoryNode | null = await db.category.findUnique({
          where: { id: nextId },
          select: {
            id: true,
            parentId: true,
            name: true,
            slug: true,
            isActive: true,
            deletedAt: true,
          },
        });
        if (node === null) break;
        chain.unshift(node);
        nextId = node.parentId;
      }
      return chain;
    },

    categoryRules(db: Queryable, categoryIds: readonly string[]) {
      return db.categoryAttribute.findMany({
        where: { categoryId: { in: [...categoryIds] } },
        select: {
          categoryId: true,
          attributeId: true,
          isRequired: true,
          isVariantAxisDefault: true,
          inheritToChildren: true,
          sortOrder: true,
          attribute: { select: { name: true } },
        },
      });
    },

    attributeValues(db: Queryable, ids: readonly string[]): Promise<AttributeValueRef[]> {
      if (ids.length === 0) return Promise.resolve([]);
      return db.attributeValue.findMany({
        where: { id: { in: [...ids] } },
        select: attributeValueRefSelect,
      });
    },

    attributes(db: Queryable, ids: readonly string[]): Promise<AttributeRef[]> {
      if (ids.length === 0) return Promise.resolve([]);
      return db.attribute.findMany({ where: { id: { in: [...ids] } }, select: attributeRefSelect });
    },

    brand(db: Queryable, id: string) {
      return db.brand.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
    },

    collections(db: Queryable, ids: readonly string[]) {
      if (ids.length === 0) return Promise.resolve([]);
      return db.collection.findMany({
        where: { id: { in: [...ids] }, deletedAt: null },
        select: { id: true },
      });
    },

    hsn(db: Queryable, hsnCode: string) {
      return db.hsnCode.findUnique({ where: { hsnCode }, select: { hsnCode: true } });
    },

    /** Read-only tax resolution (tax module owns writes): PRODUCT assignment/HSN, then CATEGORY. */
    async resolveTax(
      db: Queryable,
      product: { id: string; hsnCode: string | null },
      categoryIdsLeafFirst: readonly string[],
      now: Date,
    ): Promise<{
      hsnCode: string | null;
      source: 'PRODUCT' | 'CATEGORY';
      ratePercent: string;
    } | null> {
      const active = {
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
        taxRate: { isActive: true },
      } satisfies Prisma.ProductTaxAssignmentWhereInput;
      const select = {
        categoryId: true,
        hsnCode: true,
        taxRate: { select: { rate: true } },
      } satisfies Prisma.ProductTaxAssignmentSelect;
      const own = await db.productTaxAssignment.findFirst({
        where: { productId: product.id, targetType: 'PRODUCT', ...active },
        orderBy: { effectiveFrom: 'desc' },
        select,
      });
      if (own !== null) {
        return {
          hsnCode: own.hsnCode ?? product.hsnCode,
          source: 'PRODUCT',
          ratePercent: own.taxRate.rate.toFixed(2),
        };
      }
      if (product.hsnCode !== null) {
        const hsn = await db.hsnCode.findUnique({
          where: { hsnCode: product.hsnCode },
          select: { defaultTaxRate: { select: { rate: true, isActive: true } } },
        });
        if (hsn?.defaultTaxRate?.isActive === true) {
          return {
            hsnCode: product.hsnCode,
            source: 'PRODUCT',
            ratePercent: hsn.defaultTaxRate.rate.toFixed(2),
          };
        }
      }
      if (categoryIdsLeafFirst.length === 0) return null;
      const byCategory = await db.productTaxAssignment.findMany({
        where: { categoryId: { in: [...categoryIdsLeafFirst] }, targetType: 'CATEGORY', ...active },
        orderBy: { effectiveFrom: 'desc' },
        select,
      });
      for (const categoryId of categoryIdsLeafFirst) {
        const hit = byCategory.find((row) => row.categoryId === categoryId);
        if (hit !== undefined) {
          return {
            hsnCode: product.hsnCode ?? hit.hsnCode,
            source: 'CATEGORY',
            ratePercent: hit.taxRate.rate.toFixed(2),
          };
        }
      }
      return null;
    },

    variantsWithValues(db: Queryable, productId: string, includeDeleted = false) {
      return db.productVariant.findMany({
        where: { productId, ...(includeDeleted ? {} : { deletedAt: null }) },
        select: {
          id: true,
          sku: true,
          status: true,
          mrp: true,
          sellingPrice: true,
          combinationKey: true,
          deletedAt: true,
          variantValues: { select: { attributeId: true, attributeValueId: true } },
        },
      });
    },

    listVariants(db: Queryable, productId: string): Promise<VariantAdminRow[]> {
      return db.productVariant.findMany({
        where: { productId, deletedAt: null },
        select: variantAdminSelect,
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      });
    },

    findVariant(db: Queryable, variantId: string) {
      return db.productVariant.findFirst({
        where: { id: variantId, deletedAt: null, product: { deletedAt: null } },
        select: {
          ...variantAdminSelect,
          product: { select: { id: true, productType: true, status: true, name: true } },
        },
      });
    },

    productAttributeIds(db: Queryable, productId: string) {
      return db.productAttributeValue.findMany({
        where: { productId },
        select: { attributeId: true, attributeValueId: true },
      });
    },

    imageCount(db: Queryable, productId: string): Promise<number> {
      return db.productImage.count({ where: { productId } });
    },

    images(db: Queryable, productId: string): Promise<ImageRow[]> {
      return db.productImage.findMany({
        where: { productId },
        select: imageSelect,
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      });
    },

    activeReservationCount(db: Queryable, where: Prisma.StockReservationWhereInput) {
      return db.stockReservation.count({ where: { ...where, status: 'ACTIVE' } });
    },

    async variantHistory(db: Queryable, variantId: string) {
      const [orderItems, inventoryTxns, reservations] = await Promise.all([
        db.orderItem.count({ where: { variantId } }),
        db.inventoryTransaction.count({ where: { variantId } }),
        db.stockReservation.count({ where: { variantId } }),
      ]);
      return { orderItems, inventoryTxns, reservations };
    },

    /**
     * Recomputes denormalized listing columns from ACTIVE, non-deleted variants (P3-10 §9):
     * min/max selling price, max discount %, in-stock flag. Inventory movements (other module)
     * should call the same recompute after stock changes.
     */
    async refreshListingFields(db: Queryable, productId: string): Promise<void> {
      const variants = await db.productVariant.findMany({
        where: { productId, deletedAt: null, status: 'ACTIVE' },
        select: {
          mrp: true,
          sellingPrice: true,
          inventory: { select: { quantityOnHand: true, quantityReserved: true } },
        },
      });
      let min: Prisma.Decimal | null = null;
      let max: Prisma.Decimal | null = null;
      let maxDiscount: Prisma.Decimal | null = null;
      let inStock = false;
      for (const v of variants) {
        if (min === null || v.sellingPrice.lt(min)) min = v.sellingPrice;
        if (max === null || v.sellingPrice.gt(max)) max = v.sellingPrice;
        if (v.mrp.gt(0)) {
          const pct = v.mrp.minus(v.sellingPrice).div(v.mrp).times(100).toDecimalPlaces(2);
          if (maxDiscount === null || pct.gt(maxDiscount)) maxDiscount = pct;
        }
        const inv = v.inventory;
        if (inv !== null && inv.quantityOnHand - inv.quantityReserved > 0) inStock = true;
      }
      await db.product.update({
        where: { id: productId },
        data: {
          minSellingPrice: min,
          maxSellingPrice: max,
          maxDiscountPercent: maxDiscount ?? 0,
          isInStock: inStock,
        },
      });
    },
  };
}

export type ProductsRepository = ReturnType<typeof createProductsRepository>;
