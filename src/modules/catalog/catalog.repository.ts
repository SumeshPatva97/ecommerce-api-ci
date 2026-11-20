/**
 * Public catalog reads. Selects never include `costPrice`, staff IDs or other internal columns
 * (BACKEND_STRUCTURE §6 rule 7). Visibility (API §3.3 / workflow §4): product ACTIVE, published,
 * not deleted, with ≥ 1 ACTIVE non-deleted variant.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import type { DbClient, Queryable } from '../../core/db/transaction.js';
import {
  DEFAULT_NEW_ARRIVAL_DAYS,
  MAX_NEW_ARRIVAL_DAYS,
  NEW_ARRIVAL_DAYS_SETTING_KEY,
} from './catalog.mapper.js';

export function visibleWhere(now: Date): Prisma.ProductWhereInput {
  return {
    status: 'ACTIVE',
    deletedAt: null,
    publishedAt: { lte: now },
    variants: { some: { status: 'ACTIVE', deletedAt: null } },
  };
}

export const ACTIVE_VARIANT = { status: 'ACTIVE', deletedAt: null } as const;

/** FR-AD-008: `catalog.new_arrival_days` (int 1–365); a missing or invalid value falls back to 30. */
export async function loadNewArrivalDays(db: Queryable): Promise<number> {
  const row = await db.setting.findUnique({
    where: { settingKey: NEW_ARRIVAL_DAYS_SETTING_KEY },
    select: { value: true },
  });
  const value = row?.value;
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_NEW_ARRIVAL_DAYS
    ? value
    : DEFAULT_NEW_ARRIVAL_DAYS;
}

const valueLinkSelect = {
  attributeId: true,
  attributeValueId: true,
  attribute: { select: { code: true, name: true, displayType: true, sortOrder: true } },
  attributeValue: { select: { slug: true, value: true, swatchHex: true, sortOrder: true } },
} satisfies Prisma.VariantAttributeValueSelect;

export const publicVariantSelect = {
  id: true,
  sku: true,
  name: true,
  mrp: true,
  sellingPrice: true,
  isDefault: true,
  sortOrder: true,
  inventory: {
    select: { quantityOnHand: true, quantityReserved: true, lowStockThreshold: true },
  },
  variantValues: { select: valueLinkSelect },
} satisfies Prisma.ProductVariantSelect;
export type PublicVariantRow = Prisma.ProductVariantGetPayload<{
  select: typeof publicVariantSelect;
}>;

export const cardSelect = {
  id: true,
  slug: true,
  name: true,
  productType: true,
  isNewArrival: true,
  isBestSellerPinned: true,
  publishedAt: true,
  avgRating: true,
  reviewCount: true,
  totalSold: true,
  brand: { select: { id: true, name: true, slug: true } },
  category: { select: { id: true, name: true, slug: true } },
  images: {
    where: { mediaType: 'IMAGE' },
    select: { cloudinaryPublicId: true, altText: true },
    orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
    take: 2,
  },
  variants: {
    where: ACTIVE_VARIANT,
    select: publicVariantSelect,
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  },
} satisfies Prisma.ProductSelect;
export type CardRow = Prisma.ProductGetPayload<{ select: typeof cardSelect }>;

export const detailSelect = {
  ...cardSelect,
  shortDescription: true,
  description: true,
  careInstructions: true,
  seoTitle: true,
  seoDescription: true,
  countryOfOrigin: true,
  manufacturerName: true,
  manufacturerAddress: true,
  importerName: true,
  importerAddress: true,
  categoryId: true,
  collections: {
    where: { collection: { isActive: true, deletedAt: null } },
    select: { collection: { select: { name: true, slug: true } } },
  },
  attributeValues: {
    where: { attribute: { isVisibleOnPdp: true, isActive: true, deletedAt: null } },
    select: {
      attribute: { select: { name: true, sortOrder: true } },
      attributeValue: { select: { value: true, sortOrder: true } },
    },
  },
  images: {
    where: { mediaType: 'IMAGE' },
    select: {
      id: true,
      variantId: true,
      cloudinaryPublicId: true,
      altText: true,
      sortOrder: true,
      isPrimary: true,
    },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  },
} satisfies Prisma.ProductSelect;
export type DetailRow = Prisma.ProductGetPayload<{ select: typeof detailSelect }>;

export const relatedCandidateSelect = {
  ...cardSelect,
  categoryId: true,
  brandId: true,
  collections: { select: { collectionId: true } },
  attributeValues: { select: { attributeValueId: true } },
} satisfies Prisma.ProductSelect;
export type RelatedCandidateRow = Prisma.ProductGetPayload<{
  select: typeof relatedCandidateSelect;
}>;

export const facetRowSelect = {
  id: true,
  categoryId: true,
  brandId: true,
  collections: { select: { collectionId: true } },
  attributeValues: { select: { attributeValueId: true } },
  variants: {
    where: ACTIVE_VARIANT,
    select: {
      sellingPrice: true,
      inventory: { select: { quantityOnHand: true, quantityReserved: true } },
      variantValues: { select: { attributeValueId: true } },
    },
  },
} satisfies Prisma.ProductSelect;
export type FacetRow = Prisma.ProductGetPayload<{ select: typeof facetRowSelect }>;

/** PROVISIONAL cap for in-memory facet counting (small single-brand catalogue). */
export const FACET_ROW_CAP = 5_000;

export function createCatalogRepository(db: DbClient) {
  return {
    /** Category + active descendants (max depth 3) by slug; null when unknown/inactive. */
    async categoryWithDescendants(slug: string): Promise<string[] | null> {
      const root = await db.category.findFirst({
        where: { slug, isActive: true, deletedAt: null },
        select: { id: true },
      });
      if (root === null) return null;
      const ids = [root.id];
      let frontier = [root.id];
      for (let depth = 0; depth < 3 && frontier.length > 0; depth += 1) {
        const children = await db.category.findMany({
          where: { parentId: { in: frontier }, isActive: true, deletedAt: null },
          select: { id: true },
        });
        frontier = children.map((c) => c.id);
        ids.push(...frontier);
      }
      return ids;
    },

    async listCards(
      where: Prisma.ProductWhereInput,
      orderBy: Prisma.ProductOrderByWithRelationInput[],
      skip: number,
      take: number,
    ): Promise<{ rows: CardRow[]; total: number }> {
      const [rows, total] = await Promise.all([
        db.product.findMany({ where, orderBy, skip, take, select: cardSelect }),
        db.product.count({ where }),
      ]);
      return { rows, total };
    },

    findDetail(where: Prisma.ProductWhereInput): Promise<DetailRow | null> {
      return db.product.findFirst({ where, select: detailSelect });
    },

    /** Category chain root-first for breadcrumbs. */
    async breadcrumb(categoryId: string): Promise<{ name: string; slug: string }[]> {
      const out: { name: string; slug: string }[] = [];
      let nextId: string | null = categoryId;
      for (let depth = 0; nextId !== null && depth < 5; depth += 1) {
        const node: { name: string; slug: string; parentId: string | null } | null =
          await db.category.findUnique({
            where: { id: nextId },
            select: { name: true, slug: true, parentId: true },
          });
        if (node === null) break;
        out.unshift({ name: node.name, slug: node.slug });
        nextId = node.parentId;
      }
      return out;
    },

    async ratingDistribution(
      productId: string,
    ): Promise<Record<'1' | '2' | '3' | '4' | '5', number>> {
      const counts = await Promise.all(
        [1, 2, 3, 4, 5].map((rating) =>
          db.review.count({ where: { productId, rating, status: 'APPROVED', deletedAt: null } }),
        ),
      );
      return {
        '1': counts[0] ?? 0,
        '2': counts[1] ?? 0,
        '3': counts[2] ?? 0,
        '4': counts[3] ?? 0,
        '5': counts[4] ?? 0,
      };
    },

    async isWishlisted(userId: string, productId: string): Promise<boolean> {
      const count = await db.wishlistItem.count({ where: { productId, wishlist: { userId } } });
      return count > 0;
    },

    relatedCandidates(where: Prisma.ProductWhereInput): Promise<RelatedCandidateRow[]> {
      return db.product.findMany({
        where,
        select: relatedCandidateSelect,
        orderBy: [{ totalSold: 'desc' }, { id: 'asc' }],
        take: 100,
      });
    },

    facetRows(where: Prisma.ProductWhereInput): Promise<FacetRow[]> {
      return db.product.findMany({ where, select: facetRowSelect, take: FACET_ROW_CAP });
    },

    filterableAttributes() {
      return db.attribute.findMany({
        where: { isFilterable: true, isActive: true, deletedAt: null },
        select: {
          id: true,
          code: true,
          name: true,
          displayType: true,
          values: {
            where: { isActive: true, deletedAt: null },
            select: { id: true, slug: true, value: true, swatchHex: true },
            orderBy: { sortOrder: 'asc' },
          },
        },
        orderBy: { sortOrder: 'asc' },
      });
    },

    categoriesByIds(ids: readonly string[]) {
      return db.category.findMany({
        where: { id: { in: [...ids] }, isActive: true, deletedAt: null },
        select: { id: true, name: true, slug: true },
      });
    },

    brandsByIds(ids: readonly string[]) {
      return db.brand.findMany({
        where: { id: { in: [...ids] }, isActive: true, deletedAt: null },
        select: { id: true, name: true, slug: true },
      });
    },

    collectionsByIds(ids: readonly string[]) {
      return db.collection.findMany({
        where: { id: { in: [...ids] }, isActive: true, deletedAt: null },
        select: { id: true, name: true, slug: true },
      });
    },

    autocompleteProducts(where: Prisma.ProductWhereInput) {
      return db.product.findMany({
        where,
        select: {
          id: true,
          slug: true,
          name: true,
          images: {
            where: { mediaType: 'IMAGE' },
            select: { cloudinaryPublicId: true },
            orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
            take: 1,
          },
          variants: { where: ACTIVE_VARIANT, select: { sku: true, sellingPrice: true } },
        },
        orderBy: [{ totalSold: 'desc' }, { id: 'asc' }],
        take: 20,
      });
    },

    autocompleteCategories(q: string) {
      return db.category.findMany({
        where: { name: { contains: q }, isActive: true, deletedAt: null },
        select: { slug: true, name: true },
        orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }],
        take: 4,
      });
    },

    autocompleteBrands(q: string) {
      return db.brand.findMany({
        where: { name: { contains: q }, isActive: true, deletedAt: null },
        select: { slug: true, name: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        take: 3,
      });
    },
  };
}

export type CatalogRepository = ReturnType<typeof createCatalogRepository>;
