/**
 * Public catalog use-cases — API_DOCUMENTATION.md §2.4, §3.3, workflow §11.3.
 *
 * - Listing/facets/related/autocomplete only show visible products (`visibleWhere`).
 * - Price filters compare the variant selling price (no promotion engine yet — PROVISIONAL).
 * - `material`/`gemstone` map to attributes whose `code` is `material`/`gemstone`; the generic
 *   `attributes=` filter keys are attribute codes (the schema has no attribute slug column).
 * - Facets: disjunctive counts computed in memory over at most FACET_ROW_CAP products per filter
 *   variant (PROVISIONAL for a small catalogue; no cache yet — OQ-35 Redis deferred).
 */
import type { Prisma } from '../../generated/prisma/client.js';
import type { DbClient } from '../../core/db/transaction.js';
import { AppError } from '../../core/errors/AppError.js';
import { buildPageMeta, toSkipTake } from '../../core/http/pagination.js';
import { Decimal, dec, toMoneyString } from '../../lib/money.js';
import { normalizeCode } from '../../lib/normalize.js';
import { IMAGE_WIDTHS, deliveryUrl, type MediaDelivery } from '../media/cloudinary.js';
import { cartesian, discountPercent } from '../products/products.rules.js';
import {
  ACTIVE_VARIANT,
  loadNewArrivalDays,
  visibleWhere,
  type CatalogRepository,
  type DetailRow,
  type FacetRow,
} from './catalog.repository.js';
import {
  defaultVariantId,
  mapCard,
  mapImageDto,
  newArrivalCutoff,
  variantAvailability,
} from './catalog.mapper.js';
import type { ProductFilterInput, ProductListInput, PublicSort } from './catalog.schemas.js';

export interface CatalogDeps {
  readonly db: DbClient;
  readonly repo: CatalogRepository;
  readonly clock: () => Date;
  readonly delivery: MediaDelivery;
}

type Dimension = 'brand' | 'collection' | 'price' | 'availability' | `attr:${string}`;

interface ResolvedFilters {
  readonly input: ProductFilterInput & { ids?: string[]; variantIds?: string[] };
  readonly categoryIds: readonly string[] | null;
  readonly attrs: ReadonlyMap<string, readonly string[]>;
  /** FR-AD-008: `catalog.new_arrival_days` in force for this request. */
  readonly newArrivalDays: number;
}

/** PROVISIONAL price buckets (API §3.3 "configurable in settings (proposed)"). */
const PRICE_BUCKETS: readonly { from: string; to: string | null }[] = [
  { from: '0.00', to: '999.00' },
  { from: '1000.00', to: '1999.00' },
  { from: '2000.00', to: '4999.00' },
  { from: '5000.00', to: null },
];

function orderFor(sort: PublicSort): Prisma.ProductOrderByWithRelationInput[] {
  switch (sort) {
    case 'price_asc':
      return [{ minSellingPrice: 'asc' }, { id: 'asc' }];
    case 'price_desc':
      return [{ maxSellingPrice: 'desc' }, { id: 'asc' }];
    case 'best_selling':
      return [{ isBestSellerPinned: 'desc' }, { totalSold: 'desc' }, { id: 'asc' }];
    case 'rating_desc':
      return [{ avgRating: 'desc' }, { reviewCount: 'desc' }, { id: 'asc' }];
    case 'name_asc':
      return [{ name: 'asc' }, { id: 'asc' }];
    case 'relevance':
      // No full-text ranking yet: SKU/name matches are filtered, ordered by popularity.
      return [{ isBestSellerPinned: 'desc' }, { totalSold: 'desc' }, { id: 'asc' }];
    case 'newest':
      return [{ publishedAt: 'desc' }, { id: 'asc' }];
  }
}

function minPrice(row: FacetRow): Decimal | null {
  const prices = row.variants.map((v) => v.sellingPrice);
  return prices.length === 0 ? null : Decimal.min(...prices);
}

function rowInStock(row: FacetRow): boolean {
  return row.variants.some(
    (v) => v.inventory !== null && v.inventory.quantityOnHand - v.inventory.quantityReserved > 0,
  );
}

function rowValueIds(row: FacetRow): Set<string> {
  const ids = new Set(row.attributeValues.map((a) => a.attributeValueId));
  for (const v of row.variants) for (const link of v.variantValues) ids.add(link.attributeValueId);
  return ids;
}

export function createCatalogService(deps: CatalogDeps) {
  const { db, repo, clock, delivery } = deps;

  async function resolve(input: ResolvedFilters['input']): Promise<ResolvedFilters> {
    let categoryIds: string[] | null = null;
    if (input.category !== undefined) {
      categoryIds = await repo.categoryWithDescendants(input.category);
      if (categoryIds === null) throw new AppError('NOT_FOUND', 'Category not found.');
    }
    const attrs = new Map<string, string[]>();
    if (input.material.length > 0) attrs.set('material', input.material);
    if (input.gemstone.length > 0) attrs.set('gemstone', input.gemstone);
    for (const [code, slugs] of Object.entries(input.attributes)) {
      attrs.set(code, [...new Set([...(attrs.get(code) ?? []), ...slugs])]);
    }
    return { input, categoryIds, attrs, newArrivalDays: await loadNewArrivalDays(db) };
  }

  function buildWhere(f: ResolvedFilters, now: Date, omit?: Dimension): Prisma.ProductWhereInput {
    const { input } = f;
    const and: Prisma.ProductWhereInput[] = [visibleWhere(now)];
    if (f.categoryIds !== null) and.push({ categoryId: { in: [...f.categoryIds] } });
    if (omit !== 'brand' && input.brand.length > 0) {
      and.push({ brand: { slug: { in: input.brand }, deletedAt: null } });
    }
    if (omit !== 'collection' && input.collection.length > 0) {
      and.push({
        collections: {
          some: { collection: { slug: { in: input.collection }, isActive: true, deletedAt: null } },
        },
      });
    }
    for (const [code, slugs] of f.attrs) {
      if (omit === `attr:${code}`) continue;
      const link = { attribute: { code }, attributeValue: { slug: { in: [...slugs] } } };
      and.push({
        OR: [
          { attributeValues: { some: link } },
          { variants: { some: { ...ACTIVE_VARIANT, variantValues: { some: link } } } },
        ],
      });
    }
    if (omit !== 'price' && (input.minPrice !== undefined || input.maxPrice !== undefined)) {
      and.push({
        variants: {
          some: {
            ...ACTIVE_VARIANT,
            sellingPrice: {
              ...(input.minPrice === undefined ? {} : { gte: input.minPrice }),
              ...(input.maxPrice === undefined ? {} : { lte: input.maxPrice }),
            },
          },
        },
      });
    }
    if (omit !== 'availability' && input.availability === 'in_stock') {
      and.push({
        variants: {
          some: {
            ...ACTIVE_VARIANT,
            inventory: { is: { quantityOnHand: { gt: db.inventory.fields.quantityReserved } } },
          },
        },
      });
    }
    if (input.q !== undefined) {
      const code = normalizeCode(input.q);
      and.push({
        OR: [
          { name: { contains: input.q } },
          { searchKeywords: { contains: input.q } },
          { shortDescription: { contains: input.q } },
          { variants: { some: { ...ACTIVE_VARIANT, sku: { startsWith: code } } } },
        ],
      });
    }
    if (input.isFeatured !== undefined) and.push({ isFeatured: input.isFeatured });
    if (input.isNewArrival === true) {
      // OQ-50 / FR-AD-008: flagged, or published within `catalog.new_arrival_days` (default 30).
      and.push({
        OR: [
          { isNewArrival: true },
          { publishedAt: { gte: newArrivalCutoff(now, f.newArrivalDays) } },
        ],
      });
    }
    if (input.isNewArrival === false) and.push({ isNewArrival: false });
    if (input.ids !== undefined && input.ids.length > 0) and.push({ id: { in: input.ids } });
    if (input.variantIds !== undefined && input.variantIds.length > 0) {
      and.push({ variants: { some: { ...ACTIVE_VARIANT, id: { in: input.variantIds } } } });
    }
    return { AND: and };
  }

  function filtersEcho(f: ResolvedFilters) {
    const { input } = f;
    return {
      category: input.category ?? null,
      brand: input.brand,
      collection: input.collection,
      material: input.material,
      gemstone: input.gemstone,
      attributes: input.attributes,
      minPrice: input.minPrice === undefined ? null : toMoneyString(input.minPrice),
      maxPrice: input.maxPrice === undefined ? null : toMoneyString(input.maxPrice),
      availability: input.availability,
      ...(input.q === undefined ? {} : { q: input.q }),
      ...(input.isFeatured === undefined ? {} : { isFeatured: input.isFeatured }),
      ...(input.isNewArrival === undefined ? {} : { isNewArrival: input.isNewArrival }),
      ...(input.ids === undefined || input.ids.length === 0 ? {} : { ids: input.ids }),
      ...(input.variantIds === undefined || input.variantIds.length === 0
        ? {}
        : { variantIds: input.variantIds }),
    };
  }

  function visibleBySlug(slug: string, now: Date): Prisma.ProductWhereInput {
    return { AND: [visibleWhere(now), { slug }] };
  }

  return {
    async list(input: ProductListInput) {
      const now = clock();
      const f = await resolve(input);
      const where = buildWhere(f, now);
      const sort: PublicSort =
        input.sort === undefined
          ? input.q === undefined
            ? 'newest'
            : 'relevance'
          : input.sort === 'relevance' && input.q === undefined
            ? 'newest'
            : input.sort;
      const matchSet = input.variantIds.length > 0 ? new Set(input.variantIds) : undefined;
      let rows;
      let total;
      if (input.ids.length > 0) {
        // `ids`: data follows input order (R-13) — at most 100 rows, ordered in memory.
        const all = await repo.listCards(where, orderFor(sort), 0, 100);
        const position = new Map(input.ids.map((id, i) => [id, i]));
        const ordered = [...all.rows].sort(
          (a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0),
        );
        const { skip, take } = toSkipTake(input.page, input.limit);
        rows = ordered.slice(skip, skip + take);
        total = all.total;
      } else {
        const { skip, take } = toSkipTake(input.page, input.limit);
        ({ rows, total } = await repo.listCards(where, orderFor(sort), skip, take));
      }
      return {
        items: rows.map((r) => mapCard(r, delivery, now, matchSet, f.newArrivalDays)),
        meta: { ...buildPageMeta(input.page, input.limit, total), sort, filters: filtersEcho(f) },
      };
    },

    async facets(input: ProductFilterInput) {
      const now = clock();
      const f = await resolve(input);
      const cache = new Map<string, Promise<FacetRow[]>>();
      const rowsFor = (omit?: Dimension): Promise<FacetRow[]> => {
        const active =
          omit === undefined ||
          (omit === 'brand' && input.brand.length > 0) ||
          (omit === 'collection' && input.collection.length > 0) ||
          (omit === 'price' && (input.minPrice !== undefined || input.maxPrice !== undefined)) ||
          (omit === 'availability' && input.availability === 'in_stock') ||
          (omit.startsWith('attr:') && f.attrs.has(omit.slice(5)));
        const key = active ? (omit ?? '') : '';
        let hit = cache.get(key);
        if (hit === undefined) {
          hit = repo.facetRows(buildWhere(f, now, active ? omit : undefined));
          cache.set(key, hit);
        }
        return hit;
      };

      const base = await rowsFor();
      // Categories: counts within the current category scope (navigation facet).
      const catCounts = new Map<string, number>();
      for (const r of base) catCounts.set(r.categoryId, (catCounts.get(r.categoryId) ?? 0) + 1);
      const brandRows = await rowsFor('brand');
      const brandCounts = new Map<string, number>();
      for (const r of brandRows) {
        if (r.brandId !== null) brandCounts.set(r.brandId, (brandCounts.get(r.brandId) ?? 0) + 1);
      }
      const collectionRows = await rowsFor('collection');
      const collectionCounts = new Map<string, number>();
      for (const r of collectionRows) {
        for (const c of r.collections) {
          collectionCounts.set(c.collectionId, (collectionCounts.get(c.collectionId) ?? 0) + 1);
        }
      }
      const [categories, brands, collections, attributes] = await Promise.all([
        repo.categoriesByIds([...catCounts.keys()]),
        repo.brandsByIds([...brandCounts.keys()]),
        repo.collectionsByIds([...collectionCounts.keys()]),
        repo.filterableAttributes(),
      ]);

      const attributeFacets = [];
      for (const attribute of attributes) {
        const selected = new Set(f.attrs.get(attribute.code) ?? []);
        const rows = await rowsFor(`attr:${attribute.code}`);
        const sets = rows.map(rowValueIds);
        const values = attribute.values
          .map((v) => ({
            slug: v.slug,
            label: v.value,
            ...(v.swatchHex === null ? {} : { hex: v.swatchHex }),
            count: sets.filter((s) => s.has(v.id)).length,
            selected: selected.has(v.slug),
          }))
          .filter((v) => v.count > 0 || v.selected);
        if (values.length > 0) {
          attributeFacets.push({
            slug: attribute.code,
            name: attribute.name,
            displayType: attribute.displayType,
            values,
          });
        }
      }

      const priceRows = await rowsFor('price');
      const mins = priceRows.map(minPrice).filter((p): p is Decimal => p !== null);
      const buckets = PRICE_BUCKETS.map((b) => ({
        from: b.from,
        to: b.to,
        count: mins.filter((m) => {
          if (m.lt(dec(b.from))) return false;
          return b.to === null || m.lt(dec(b.to).plus(1));
        }).length,
      }));
      const availabilityRows = await rowsFor('availability');

      const bySlug = (
        list: readonly { id: string; name: string; slug: string }[],
        counts: ReadonlyMap<string, number>,
        selected: readonly string[] = [],
      ) =>
        list
          .map((x) => ({
            slug: x.slug,
            name: x.name,
            count: counts.get(x.id) ?? 0,
            selected: selected.includes(x.slug),
          }))
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

      return {
        data: {
          categories: bySlug(categories, catCounts).map(({ selected: _s, ...rest }) => rest),
          brands: bySlug(brands, brandCounts, input.brand),
          collections: bySlug(collections, collectionCounts, input.collection),
          attributes: attributeFacets,
          price: {
            min: mins.length > 0 ? toMoneyString(Decimal.min(...mins)) : null,
            max: mins.length > 0 ? toMoneyString(Decimal.max(...mins)) : null,
            buckets,
          },
          availability: {
            inStock: availabilityRows.filter(rowInStock).length,
            all: availabilityRows.length,
          },
        },
        meta: { filters: filtersEcho(f) },
      };
    },

    async detail(
      slug: string,
      opts: { variantSku?: string | undefined; customerId?: string | undefined },
    ) {
      const now = clock();
      const p = await repo.findDetail(visibleBySlug(slug, now));
      if (p === null) throw new AppError('NOT_FOUND', 'Product not found.');
      const [breadcrumb, distribution, wishlisted] = await Promise.all([
        repo.breadcrumb(p.categoryId),
        repo.ratingDistribution(p.id),
        opts.customerId === undefined
          ? Promise.resolve(undefined)
          : repo.isWishlisted(opts.customerId, p.id),
      ]);
      return mapDetail(p, {
        breadcrumb,
        distribution,
        wishlisted,
        variantSku: opts.variantSku,
        now,
      });
    },

    async related(slug: string, limit: number) {
      const now = clock();
      const self = await db.product.findFirst({
        where: visibleBySlug(slug, now),
        select: {
          id: true,
          categoryId: true,
          brandId: true,
          collections: { select: { collectionId: true } },
          attributeValues: {
            where: { attribute: { isFilterable: true } },
            select: { attributeValueId: true },
          },
        },
      });
      if (self === null) throw new AppError('NOT_FOUND', 'Product not found.');
      const collectionIds = self.collections.map((c) => c.collectionId);
      const valueIds = self.attributeValues.map((a) => a.attributeValueId);
      const or: Prisma.ProductWhereInput[] = [{ categoryId: self.categoryId }];
      if (self.brandId !== null) or.push({ brandId: self.brandId });
      if (collectionIds.length > 0) {
        or.push({ collections: { some: { collectionId: { in: collectionIds } } } });
      }
      if (valueIds.length > 0) {
        or.push({ attributeValues: { some: { attributeValueId: { in: valueIds } } } });
      }
      const candidates = await repo.relatedCandidates({
        AND: [
          visibleWhere(now),
          { id: { not: self.id } },
          {
            variants: {
              some: {
                ...ACTIVE_VARIANT,
                inventory: { is: { quantityOnHand: { gt: db.inventory.fields.quantityReserved } } },
              },
            },
          },
          { OR: or },
        ],
      });
      // PROPOSED ranking: collection ×3, category ×2, brand ×1, shared filterable value ×1.
      const scored = candidates.map((c) => {
        let score = 0;
        if (c.collections.some((x) => collectionIds.includes(x.collectionId))) score += 3;
        if (c.categoryId === self.categoryId) score += 2;
        if (self.brandId !== null && c.brandId === self.brandId) score += 1;
        score += c.attributeValues.filter((a) => valueIds.includes(a.attributeValueId)).length;
        return { c, score };
      });
      scored.sort((a, b) => b.score - a.score || b.c.totalSold - a.c.totalSold);
      const newArrivalDays = await loadNewArrivalDays(db);
      return scored
        .slice(0, limit)
        .map(({ c }) => mapCard(c, delivery, now, undefined, newArrivalDays));
    },

    async autocomplete(q: string) {
      const now = clock();
      const code = normalizeCode(q);
      const skuLike = /^[A-Z0-9_-]+$/.test(code);
      const productOr: Prisma.ProductWhereInput[] = [
        { name: { contains: q } },
        { searchKeywords: { contains: q } },
      ];
      if (skuLike)
        productOr.push({ variants: { some: { ...ACTIVE_VARIANT, sku: { startsWith: code } } } });
      const [products, categories, brands] = await Promise.all([
        repo.autocompleteProducts({ AND: [visibleWhere(now), { OR: productOr }] }),
        repo.autocompleteCategories(q),
        repo.autocompleteBrands(q),
      ]);
      const rank = (p: (typeof products)[number]): number => {
        if (!skuLike) return 2;
        if (p.variants.some((v) => v.sku === code)) return 0;
        if (p.variants.some((v) => v.sku.startsWith(code))) return 1;
        return 2;
      };
      const ranked = products
        .map((p, i) => ({ p, i, r: rank(p) }))
        .sort((a, b) => a.r - b.r || a.i - b.i)
        .slice(0, 6)
        .map(({ p }) => {
          const prices = p.variants.map((v) => v.sellingPrice);
          const image = p.images[0];
          return {
            slug: p.slug,
            name: p.name,
            thumbUrl:
              image === undefined
                ? null
                : deliveryUrl(delivery, image.cloudinaryPublicId, IMAGE_WIDTHS.thumb),
            price: prices.length === 0 ? null : toMoneyString(Decimal.min(...prices)),
          };
        });
      return {
        query: q,
        products: ranked,
        categories,
        brands,
        // No search-term analytics store yet → no query suggestions (documented gap).
        suggestions: [] as string[],
      };
    },
  };

  function mapDetail(
    p: DetailRow,
    ctx: {
      breadcrumb: { name: string; slug: string }[];
      distribution: Record<string, number>;
      wishlisted: boolean | undefined;
      variantSku: string | undefined;
      now: Date;
    },
  ) {
    const variable = p.productType === 'VARIABLE';
    // Axes from ACTIVE variants, attribute sort order then value sort order.
    const axes = new Map<
      string,
      {
        attributeId: string;
        slug: string;
        name: string;
        displayType: string;
        sortOrder: number;
        values: Map<
          string,
          { valueId: string; slug: string; label: string; hex?: string; sortOrder: number }
        >;
      }
    >();
    if (variable) {
      for (const v of p.variants) {
        for (const link of v.variantValues) {
          let axis = axes.get(link.attributeId);
          if (axis === undefined) {
            axis = {
              attributeId: link.attributeId,
              slug: link.attribute.code,
              name: link.attribute.name,
              displayType: link.attribute.displayType,
              sortOrder: link.attribute.sortOrder,
              values: new Map(),
            };
            axes.set(link.attributeId, axis);
          }
          if (!axis.values.has(link.attributeValueId)) {
            axis.values.set(link.attributeValueId, {
              valueId: link.attributeValueId,
              slug: link.attributeValue.slug,
              label: link.attributeValue.value,
              ...(link.attributeValue.swatchHex === null
                ? {}
                : { hex: link.attributeValue.swatchHex }),
              sortOrder: link.attributeValue.sortOrder,
            });
          }
        }
      }
    }
    const axisList = [...axes.values()].sort((a, b) => a.sortOrder - b.sortOrder);
    const attributeAxes = axisList.map((a) => ({
      attributeId: a.attributeId,
      slug: a.slug,
      name: a.name,
      displayType: a.displayType,
      values: [...a.values.values()]
        .sort((x, y) => x.sortOrder - y.sortOrder)
        .map(({ sortOrder: _s, ...rest }) => rest),
    }));

    // Image resolution (workflow §11.3): own → same swatch-axis value → shared.
    const swatchAxis = axisList.find((a) => a.displayType === 'SWATCH');
    const swatchValueOf = (variantId: string): string | undefined =>
      swatchAxis === undefined
        ? undefined
        : p.variants
            .find((v) => v.id === variantId)
            ?.variantValues.find((l) => l.attributeId === swatchAxis.attributeId)?.attributeValueId;
    const shared = p.images.filter((i) => i.variantId === null).map((i) => i.id);
    const imageIdsFor = (variantId: string): string[] => {
      const own = p.images.filter((i) => i.variantId === variantId).map((i) => i.id);
      const swatch = swatchValueOf(variantId);
      const siblings =
        own.length > 0 || swatch === undefined
          ? []
          : p.images
              .filter(
                (i) =>
                  i.variantId !== null &&
                  i.variantId !== variantId &&
                  swatchValueOf(i.variantId) === swatch,
              )
              .map((i) => i.id);
      return [...own, ...siblings, ...shared];
    };

    const variants = p.variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      name: v.name,
      options: Object.fromEntries(
        v.variantValues.map((l) => [l.attribute.code, l.attributeValue.slug]),
      ),
      mrp: toMoneyString(v.mrp),
      sellingPrice: toMoneyString(v.sellingPrice),
      effectivePrice: toMoneyString(v.sellingPrice),
      discountPercent: discountPercent(v.mrp, v.sellingPrice),
      promotion: null,
      availability: variantAvailability(v),
      isDefault: v.isDefault,
      imageIds: imageIdsFor(v.id),
    }));

    const existingCombos = new Set(
      p.variants.map((v) =>
        axisList
          .map(
            (a) =>
              v.variantValues.find((l) => l.attributeId === a.attributeId)?.attributeValue.slug ??
              '',
          )
          .join('|'),
      ),
    );
    const unavailableCombinations =
      axisList.length === 0
        ? []
        : cartesian(
            axisList.map((a) => [...a.values.values()].sort((x, y) => x.sortOrder - y.sortOrder)),
          )
            .filter((combo) => !existingCombos.has(combo.map((c) => c.slug).join('|')))
            .map((combo) =>
              Object.fromEntries(combo.map((c, i) => [axisList[i]?.slug ?? '', c.slug])),
            );

    const specs = new Map<
      string,
      { sortOrder: number; values: { value: string; sortOrder: number }[] }
    >();
    for (const av of p.attributeValues) {
      const entry = specs.get(av.attribute.name) ?? {
        sortOrder: av.attribute.sortOrder,
        values: [],
      };
      entry.values.push({ value: av.attributeValue.value, sortOrder: av.attributeValue.sortOrder });
      specs.set(av.attribute.name, entry);
    }
    const specifications = [...specs.entries()]
      .sort((a, b) => a[1].sortOrder - b[1].sortOrder)
      .map(([attribute, e]) => ({
        attribute,
        value: e.values
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((x) => x.value)
          .join(', '),
      }));

    const requested =
      ctx.variantSku === undefined
        ? undefined
        : p.variants.find((v) => v.sku === normalizeCode(ctx.variantSku ?? ''));

    return {
      id: p.id,
      slug: p.slug,
      name: p.name,
      productType: p.productType,
      shortDescription: p.shortDescription,
      description: p.description,
      careInstructions: p.careInstructions,
      brand: p.brand,
      category: p.category,
      breadcrumb: ctx.breadcrumb,
      collections: p.collections.map((c) => c.collection),
      specifications,
      attributeAxes,
      variants,
      unavailableCombinations,
      images: p.images.map((i) => mapImageDto(delivery, i)),
      selectedVariantId: requested?.id ?? defaultVariantId(p.productType, p.variants),
      rating: {
        average: p.avgRating.toFixed(2),
        count: p.reviewCount,
        distribution: ctx.distribution,
      },
      ...(ctx.wishlisted === undefined ? {} : { isWishlisted: ctx.wishlisted }),
      // PROVISIONAL (OQ-21): GST-inclusive prices by default (settings not read here).
      pricesIncludeTax: true,
      legal: {
        countryOfOrigin: p.countryOfOrigin,
        manufacturerName: p.manufacturerName,
        manufacturerAddress: p.manufacturerAddress,
        importerName: p.importerName,
        importerAddress: p.importerAddress,
      },
      seo: {
        title: p.seoTitle ?? p.name,
        description: p.seoDescription ?? p.shortDescription,
        canonicalPath: `/products/${p.slug}`,
      },
      // OQ-44/OQ-90: size guides are CMS blocks per category — resolved by the CMS module later.
      sizeGuideBlockKey: null,
    };
  }
}

export type CatalogService = ReturnType<typeof createCatalogService>;
