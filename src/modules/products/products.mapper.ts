/**
 * Admin DTO mapping — money as 2-dp strings, weights as 3-dp strings, Cloudinary delivery URLs
 * built here (BACKEND_STRUCTURE §17 step 7). `costPrice` only when the caller may see it
 * (workflow §10: `products.update` or `reports.view`, PROPOSED).
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { toMoneyString, toMoneyStringOrNull } from '../../lib/money.js';
import { imageUrls, type MediaDelivery } from '../media/cloudinary.js';
import type {
  ImageRow,
  ProductAdminRow,
  ProductListRow,
  VariantAdminRow,
} from './products.repository.js';

export function weightString(value: Prisma.Decimal | null): string | null {
  return value === null ? null : value.toFixed(3);
}

interface ValueLink {
  attributeId: string;
  attributeValueId: string;
  attribute: { code: string; name: string; sortOrder: number };
  attributeValue: { value: string; slug: string; sortOrder: number };
}

export function mapAttributeLinks(links: readonly ValueLink[]) {
  return [...links]
    .sort(
      (a, b) =>
        a.attribute.sortOrder - b.attribute.sortOrder ||
        a.attributeValue.sortOrder - b.attributeValue.sortOrder,
    )
    .map((l) => ({
      attributeId: l.attributeId,
      attributeCode: l.attribute.code,
      attributeName: l.attribute.name,
      valueId: l.attributeValueId,
      value: l.attributeValue.value,
      slug: l.attributeValue.slug,
    }));
}

export function inventorySnapshot(
  inv: {
    quantityOnHand: number;
    quantityReserved: number;
    lowStockThreshold?: number | null;
  } | null,
) {
  if (inv === null) return null;
  return {
    onHand: inv.quantityOnHand,
    reserved: inv.quantityReserved,
    available: inv.quantityOnHand - inv.quantityReserved,
    lowStockThreshold: inv.lowStockThreshold ?? null,
  };
}

export function mapAdminVariant(v: VariantAdminRow, canSeeCost: boolean) {
  return {
    id: v.id,
    productId: v.productId,
    sku: v.sku,
    barcode: v.barcode,
    name: v.name,
    combinationKey: v.combinationKey,
    isDefault: v.isDefault,
    status: v.status,
    sortOrder: v.sortOrder,
    mrp: toMoneyString(v.mrp),
    sellingPrice: toMoneyString(v.sellingPrice),
    compareAtPrice: toMoneyStringOrNull(v.compareAtPrice),
    ...(canSeeCost ? { costPrice: toMoneyStringOrNull(v.costPrice) } : {}),
    weightGrams: weightString(v.weightGrams),
    dimensionsMm: { length: v.lengthMm, width: v.widthMm, height: v.heightMm },
    attributes: mapAttributeLinks(v.variantValues),
    inventory: inventorySnapshot(v.inventory),
    imageCount: v._count.images,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
}
export type AdminVariantDto = ReturnType<typeof mapAdminVariant>;

export function mapImage(img: ImageRow, delivery: MediaDelivery) {
  return {
    id: img.id,
    publicId: img.cloudinaryPublicId,
    ...imageUrls(delivery, img.cloudinaryPublicId),
    altText: img.altText,
    variantId: img.variantId,
    sortOrder: img.sortOrder,
    isPrimary: img.isPrimary,
    mediaType: img.mediaType,
    width: img.width,
    height: img.height,
    format: img.format,
  };
}

export function mapAdminProduct(
  p: ProductAdminRow,
  opts: {
    canSeeCost: boolean;
    delivery: MediaDelivery;
    tax: { hsnCode: string | null; source: string; ratePercent: string } | null;
  },
) {
  return {
    id: p.id,
    productType: p.productType,
    name: p.name,
    slug: p.slug,
    status: p.status,
    category: p.category,
    brand: p.brand,
    shortDescription: p.shortDescription,
    description: p.description,
    careInstructions: p.careInstructions,
    searchKeywords: p.searchKeywords,
    hsnCode: p.hsnCode,
    isFeatured: p.isFeatured,
    isNewArrival: p.isNewArrival,
    isBestSellerPinned: p.isBestSellerPinned,
    publishedAt: p.publishedAt?.toISOString() ?? null,
    priceRange: {
      min: toMoneyStringOrNull(p.minSellingPrice),
      max: toMoneyStringOrNull(p.maxSellingPrice),
    },
    isInStock: p.isInStock,
    rating: { average: p.avgRating.toFixed(2), count: p.reviewCount },
    totalSold: p.totalSold,
    seo: { title: p.seoTitle, description: p.seoDescription },
    legal: {
      countryOfOrigin: p.countryOfOrigin,
      manufacturerName: p.manufacturerName,
      manufacturerAddress: p.manufacturerAddress,
      importerName: p.importerName,
      importerAddress: p.importerAddress,
    },
    attributeValues: mapAttributeLinks(p.attributeValues),
    collections: p.collections.map((c) => c.collection),
    variants: p.variants.map((v) => mapAdminVariant(v, opts.canSeeCost)),
    images: p.images.map((img) => mapImage(img, opts.delivery)),
    tax: opts.tax,
    audit: {
      createdById: p.createdById,
      updatedById: p.updatedById,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    },
  };
}

export function mapAdminListItem(p: ProductListRow, delivery: MediaDelivery) {
  const primary = p.images[0];
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    productType: p.productType,
    status: p.status,
    category: p.category,
    brand: p.brand,
    variantCount: p.variants.length,
    priceRange: {
      min: toMoneyStringOrNull(p.minSellingPrice),
      max: toMoneyStringOrNull(p.maxSellingPrice),
    },
    totalAvailable: p.variants.reduce(
      (sum, v) =>
        sum +
        (v.inventory === null ? 0 : v.inventory.quantityOnHand - v.inventory.quantityReserved),
      0,
    ),
    primaryImageUrl:
      primary === undefined ? null : imageUrls(delivery, primary.cloudinaryPublicId).thumbUrl,
    updatedAt: p.updatedAt.toISOString(),
    updatedBy: p.updatedById,
  };
}
