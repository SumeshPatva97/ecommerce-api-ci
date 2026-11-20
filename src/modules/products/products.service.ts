/**
 * Admin product use-cases — API_DOCUMENTATION.md §4.3, workflow §3–§5, §12.
 *
 * PROVISIONAL (OQ-04): product name unique per category (`uq_products_category_name`).
 * PROVISIONAL (OQ-39): names/slugs/SKUs of soft-deleted products stay reserved.
 * PROVISIONAL (workflow §3.3): missing required category attributes are warnings on DRAFT saves
 * and block publishing (422) — API §4.3's create-time 422 is applied only when status=ACTIVE.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { withTransaction, type Queryable } from '../../core/db/transaction.js';
import { AppError, type ErrorDetail } from '../../core/errors/AppError.js';
import { buildPageMeta, toSkipTake, type PageMeta } from '../../core/http/pagination.js';
import { normalizeCode, normalizeText } from '../../lib/normalize.js';
import { slugify, uniqueSlug } from '../../lib/slug.js';
import { BARCODE_PATTERN, SKU_PATTERN } from '../../lib/normalize.js';
import type { AuditActor } from '../audit/audit.service.js';
import { mapAdminListItem, mapAdminProduct } from './products.mapper.js';
import type { CategoryNode, ProductAdminRow } from './products.repository.js';
import {
  canTransition,
  allowedTransitions,
  combinationKey,
  DEFAULT_COMBINATION_KEY,
  evaluatePublishGate,
  sanitizeHtml,
} from './products.rules.js';
import type {
  AdminProductListInput,
  CheckDuplicateInput,
  CreateProductInput,
  ProductStatusInput,
  UpdateProductInput,
} from './products.schemas.js';
import {
  assertNotStale,
  axisAttributeDetails,
  categoryUsable,
  codeConflictDetails,
  conflict,
  draftDto,
  insertVariant,
  invalid,
  missingRequired,
  MODULE,
  notFound,
  requestDuplicateDetails,
  usableValue,
  valuesForAxes,
  variantLabel,
  type ProductsDeps,
  type VariantDraft,
} from './products.support.js';

export interface Warning {
  readonly code: string;
  readonly message: string;
  readonly meta?: Record<string, unknown>;
}

interface ViewOptions {
  readonly canSeeCost: boolean;
}

type CommonInput = Partial<
  Pick<
    UpdateProductInput,
    | 'brandId'
    | 'collectionIds'
    | 'hsnCode'
    | 'attributeValueIds'
    | 'shortDescription'
    | 'description'
    | 'careInstructions'
    | 'searchKeywords'
    | 'isFeatured'
    | 'isNewArrival'
    | 'isBestSellerPinned'
    | 'seo'
    | 'legal'
  >
>;

interface ProductScalarData {
  brandId?: string | null;
  hsnCode?: string | null;
  shortDescription?: string | null;
  description?: string | null;
  careInstructions?: string | null;
  searchKeywords?: string | null;
  isFeatured?: boolean;
  isNewArrival?: boolean;
  isBestSellerPinned?: boolean;
  seoTitle?: string | null;
  seoDescription?: string | null;
  countryOfOrigin?: string | null;
  manufacturerName?: string | null;
  manufacturerAddress?: string | null;
  importerName?: string | null;
  importerAddress?: string | null;
}

/** Scalar column data shared by create/update (only keys present in the input). */
function scalarData(input: CommonInput): ProductScalarData {
  const data: ProductScalarData = {};
  if (input.brandId !== undefined) data.brandId = input.brandId;
  if (input.hsnCode !== undefined) data.hsnCode = input.hsnCode;
  if (input.shortDescription !== undefined) data.shortDescription = input.shortDescription;
  if (input.description !== undefined) {
    data.description = input.description === null ? null : sanitizeHtml(input.description);
  }
  if (input.careInstructions !== undefined) data.careInstructions = input.careInstructions;
  if (input.searchKeywords !== undefined) data.searchKeywords = input.searchKeywords;
  if (input.isFeatured !== undefined) data.isFeatured = input.isFeatured;
  if (input.isNewArrival !== undefined) data.isNewArrival = input.isNewArrival;
  if (input.isBestSellerPinned !== undefined) data.isBestSellerPinned = input.isBestSellerPinned;
  if (input.seo?.title !== undefined) data.seoTitle = input.seo.title;
  if (input.seo?.description !== undefined) data.seoDescription = input.seo.description;
  const legal = input.legal;
  if (legal !== undefined) {
    if (legal.countryOfOrigin !== undefined) data.countryOfOrigin = legal.countryOfOrigin;
    if (legal.manufacturerName !== undefined) data.manufacturerName = legal.manufacturerName;
    if (legal.manufacturerAddress !== undefined) {
      data.manufacturerAddress = legal.manufacturerAddress;
    }
    if (legal.importerName !== undefined) data.importerName = legal.importerName;
    if (legal.importerAddress !== undefined) data.importerAddress = legal.importerAddress;
  }
  return data;
}

function auditSnapshot(p: ProductAdminRow): Record<string, unknown> {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    categoryId: p.categoryId,
    brandId: p.brandId,
    status: p.status,
    hsnCode: p.hsnCode,
    shortDescription: p.shortDescription,
    description: p.description,
    careInstructions: p.careInstructions,
    searchKeywords: p.searchKeywords,
    isFeatured: p.isFeatured,
    isNewArrival: p.isNewArrival,
    isBestSellerPinned: p.isBestSellerPinned,
    seoTitle: p.seoTitle,
    seoDescription: p.seoDescription,
    countryOfOrigin: p.countryOfOrigin,
    manufacturerName: p.manufacturerName,
    manufacturerAddress: p.manufacturerAddress,
    importerName: p.importerName,
    importerAddress: p.importerAddress,
    attributeValueIds: p.attributeValues.map((a) => a.attributeValueId).sort(),
    collectionIds: p.collections.map((c) => c.collection.id).sort(),
  };
}

export function createProductsService(deps: ProductsDeps) {
  const { db, repo, audit, clock } = deps;

  async function loadCategory(q: Queryable, categoryId: string): Promise<CategoryNode[]> {
    const chain = await repo.categoryChain(q, categoryId);
    if (!categoryUsable(chain)) {
      throw invalid([
        {
          field: 'categoryId',
          code: 'CATEGORY_INVALID',
          message: 'Category not found or inactive.',
        },
      ]);
    }
    return chain;
  }

  /** Validates brand/collections/HSN/product-level attribute values. */
  async function validateReferences(q: Queryable, input: CommonInput): Promise<void> {
    const details: ErrorDetail[] = [];
    if (input.brandId !== undefined && input.brandId !== null) {
      if ((await repo.brand(q, input.brandId)) === null) {
        details.push({ field: 'brandId', code: 'BRAND_NOT_FOUND', message: 'Brand not found.' });
      }
    }
    if (input.collectionIds !== undefined && input.collectionIds.length > 0) {
      const found = new Set((await repo.collections(q, input.collectionIds)).map((c) => c.id));
      input.collectionIds.forEach((id, i) => {
        if (!found.has(id)) {
          details.push({
            field: `collectionIds[${String(i)}]`,
            code: 'COLLECTION_NOT_FOUND',
            message: 'Collection not found.',
          });
        }
      });
    }
    if (input.hsnCode !== undefined && input.hsnCode !== null) {
      if ((await repo.hsn(q, input.hsnCode)) === null) {
        details.push({
          field: 'hsnCode',
          code: 'HSN_NOT_FOUND',
          message: 'HSN code is not in the tax master.',
        });
      }
    }
    if (input.attributeValueIds !== undefined && input.attributeValueIds.length > 0) {
      const values = await repo.attributeValues(q, input.attributeValueIds);
      input.attributeValueIds.forEach((id, i) => {
        if (!usableValue(values.find((v) => v.id === id))) {
          details.push({
            field: `attributeValueIds[${String(i)}]`,
            code: 'ATTRIBUTE_VALUE_NOT_FOUND',
            message: 'Unknown or inactive attribute value.',
          });
        }
      });
    }
    if (details.length > 0) throw invalid(details);
  }

  async function attributeIdsOfValues(q: Queryable, ids: readonly string[]): Promise<Set<string>> {
    const values = await repo.attributeValues(q, ids);
    return new Set(values.map((v) => v.attributeId));
  }

  async function nameConflict(
    q: Queryable,
    categoryId: string,
    name: string,
    excludeId?: string,
  ): Promise<ErrorDetail | null> {
    const hit = await repo.findNameConflict(q, categoryId, normalizeText(name), excludeId);
    if (hit === null) return null;
    return {
      field: 'name',
      code: 'DUPLICATE_RESOURCE',
      // PROVISIONAL (OQ-04): uniqueness scope is the category.
      message: `A product named "${hit.name}" already exists in ${hit.category.name}.`,
      meta: { existingId: hit.id, scope: 'CATEGORY', deleted: hit.deletedAt !== null },
    };
  }

  async function taxFor(
    q: Queryable,
    product: { id: string; hsnCode: string | null },
    chain: readonly CategoryNode[],
  ) {
    return repo.resolveTax(
      q,
      product,
      [...chain].reverse().map((c) => c.id),
      clock(),
    );
  }

  const service = {
    async list(input: AdminProductListInput): Promise<{
      items: ReturnType<typeof mapAdminListItem>[];
      meta: PageMeta & { sort: string };
    }> {
      const and: Prisma.ProductWhereInput[] = [{ deletedAt: null }];
      if (input.status !== undefined) and.push({ status: input.status });
      if (input.productType !== undefined) and.push({ productType: input.productType });
      if (input.categoryId !== undefined) and.push({ categoryId: input.categoryId });
      if (input.brandId !== undefined) and.push({ brandId: input.brandId });
      if (input.collectionId !== undefined) {
        and.push({ collections: { some: { collectionId: input.collectionId } } });
      }
      if (input.stock === 'in_stock') and.push({ isInStock: true });
      if (input.stock === 'out_of_stock') and.push({ isInStock: false });
      if (input.stock === 'low_stock') {
        // Approximation: on-hand at or below the variant's own threshold (reserved ignored;
        // the generated `quantity_available` column is SQL-only).
        and.push({
          variants: {
            some: {
              deletedAt: null,
              status: 'ACTIVE',
              inventory: {
                is: { quantityOnHand: { gt: 0, lte: db.inventory.fields.lowStockThreshold } },
              },
            },
          },
        });
      }
      if (input.q !== undefined) {
        const code = normalizeCode(input.q);
        and.push({
          OR: [
            { name: { contains: input.q } },
            { variants: { some: { sku: { startsWith: code } } } },
            { variants: { some: { barcode: code } } },
          ],
        });
      }
      const orderBy: Prisma.ProductOrderByWithRelationInput[] = (() => {
        switch (input.sort) {
          case 'createdAt':
            return [{ createdAt: 'asc' }];
          case 'name':
            return [{ name: 'asc' }];
          case '-updatedAt':
            return [{ updatedAt: 'desc' }];
          case 'price':
            return [{ minSellingPrice: 'asc' }];
          case '-price':
            return [{ minSellingPrice: 'desc' }];
          case '-createdAt':
            return [{ createdAt: 'desc' }];
        }
      })();
      orderBy.push({ id: 'asc' });
      const { skip, take } = toSkipTake(input.page, input.limit);
      const { rows, total } = await repo.list(db, { AND: and }, orderBy, skip, take);
      return {
        items: rows.map((r) => mapAdminListItem(r, deps.delivery)),
        meta: { ...buildPageMeta(input.page, input.limit, total), sort: input.sort },
      };
    },

    async get(productId: string, view: ViewOptions) {
      const product = await repo.findAdmin(db, productId);
      if (product === null) throw notFound('Product');
      const chain = await repo.categoryChain(db, product.categoryId);
      const tax = await taxFor(db, product, chain);
      return mapAdminProduct(product, {
        canSeeCost: view.canSeeCost,
        delivery: deps.delivery,
        tax,
      });
    },

    async create(actor: AuditActor, input: CreateProductInput) {
      const chain = await loadCategory(db, input.categoryId);
      await validateReferences(db, input);
      const warnings: Warning[] = [];

      // ---- variant drafts
      const drafts: VariantDraft[] = [];
      const draftDetails: ErrorDetail[] = [];
      const variantInputs =
        input.productType === 'SIMPLE' ? [input.variant] : (input.variants ?? []);
      if (input.productType === 'SIMPLE') {
        const v = input.variant;
        drafts.push(
          toDraft('variant', v, {
            name: input.name,
            label: input.name,
            combinationKey: DEFAULT_COMBINATION_KEY,
            isDefault: true,
            values: [],
            sortOrder: v.sortOrder ?? 0,
          }),
        );
      } else if (input.variantAxes !== undefined) {
        const axisIds = input.variantAxes;
        const attributes = await repo.attributes(db, axisIds);
        draftDetails.push(
          ...axisAttributeDetails(axisIds, attributes, (i) => `variantAxes[${String(i)}]`),
        );
        const allValueIds = [
          ...new Set((input.variants ?? []).flatMap((v) => v.attributeValueIds)),
        ];
        const valueById = new Map(
          (await repo.attributeValues(db, allValueIds)).map((v) => [v.id, v]),
        );
        const seenKeys = new Map<string, number>();
        (input.variants ?? []).forEach((v, i) => {
          const field = `variants[${String(i)}]`;
          const values = valuesForAxes(
            v.attributeValueIds,
            axisIds,
            valueById,
            `${field}.attributeValueIds`,
            draftDetails,
          );
          if (values === null) return;
          const key = combinationKey(values.map((x) => x.id));
          const first = seenKeys.get(key);
          if (first !== undefined) {
            draftDetails.push({
              field: `${field}.attributeValueIds`,
              code: 'DUPLICATE_COMBINATION',
              message: `Combination "${variantLabel(values)}" is repeated (also variants[${String(first)}]).`,
            });
            return;
          }
          seenKeys.set(key, i);
          const label = variantLabel(values);
          drafts.push(
            toDraft(field, v, {
              name: label,
              label,
              combinationKey: key,
              isDefault: false,
              values: values.map((x) => ({ attributeId: x.attributeId, attributeValueId: x.id })),
              sortOrder: v.sortOrder ?? i,
            }),
          );
        });
      }
      draftDetails.push(...requestDuplicateDetails(drafts));
      if (draftDetails.length > 0) throw invalid(draftDetails);
      if (variantInputs.some((v) => v.initialStock !== undefined && v.initialStock > 0)) {
        warnings.push({
          code: 'INITIAL_STOCK_NOT_APPLIED',
          message:
            'Opening stock is recorded through POST /admin/inventory/movements (STOCK_IN), not on product create.',
        });
      }
      if (input.productType === 'VARIABLE' && drafts.length === 0) {
        warnings.push({
          code: 'NO_VARIANTS',
          message: 'Generate or add variants before publishing.',
        });
      }

      // ---- duplicate pre-checks (friendly 409; DB unique indexes remain the final guard)
      const conflicts: ErrorDetail[] = [];
      const nameHit = await nameConflict(db, input.categoryId, input.name);
      if (nameHit !== null) conflicts.push(nameHit);
      let slug: string;
      if (input.slug !== undefined) {
        const hit = await repo.findSlugConflict(db, input.slug);
        if (hit !== null) {
          conflicts.push({
            field: 'slug',
            code: 'DUPLICATE_RESOURCE',
            message: `Slug "${input.slug}" is already used.`,
            meta: { existingId: hit.id, deleted: hit.deletedAt !== null },
          });
        }
        slug = input.slug;
      } else {
        slug = await uniqueSlug(
          input.name,
          async (candidate) => (await repo.findSlugConflict(db, candidate)) !== null,
        );
      }
      conflicts.push(...(await codeConflictDetails(repo, db, drafts)));
      if (conflicts.length > 0) {
        throw new AppError('DUPLICATE_RESOURCE', 'Some values are already in use.', {
          details: conflicts,
        });
      }

      // ---- required attributes & publish gate
      const productAttrIds = await attributeIdsOfValues(db, input.attributeValueIds ?? []);
      const variantSets =
        input.productType === 'VARIABLE'
          ? drafts.map((d) => new Set(d.values.map((v) => v.attributeId)))
          : [];
      const missing = await missingRequired(repo, db, chain, productAttrIds, variantSets);
      for (const m of missing) {
        warnings.push({
          code: 'REQUIRED_ATTRIBUTE_MISSING',
          message: `Required attribute "${m.name}" has no value; publishing is blocked until it is filled.`,
          meta: { attributeId: m.id },
        });
      }
      warnings.push({ code: 'NO_IMAGES', message: 'Add at least one image before publishing.' });
      if (input.status === 'ACTIVE') {
        const tax = await taxFor(db, { id: '', hsnCode: input.hsnCode ?? null }, chain);
        const unmet = evaluatePublishGate({
          categoryActive: categoryUsable(chain),
          variants: drafts,
          imageCount: 0,
          missingRequiredAttributes: missing,
          taxResolvable: tax !== null,
        });
        throw publishError(unmet);
      }

      const now = clock();
      const created = await withTransaction(db, async ({ tx }) => {
        const product = await tx.product.create({
          data: {
            ...scalarData(input),
            productType: input.productType,
            name: input.name,
            nameNormalized: normalizeText(input.name),
            slug,
            categoryId: input.categoryId,
            status: input.status,
            createdById: actor.userId ?? null,
            updatedById: actor.userId ?? null,
          },
          select: { id: true },
        });
        if ((input.attributeValueIds ?? []).length > 0) {
          const values = await repo.attributeValues(tx, input.attributeValueIds ?? []);
          await tx.productAttributeValue.createMany({
            data: values.map((v) => ({
              productId: product.id,
              attributeId: v.attributeId,
              attributeValueId: v.id,
            })),
          });
        }
        if ((input.collectionIds ?? []).length > 0) {
          await tx.collectionProduct.createMany({
            data: (input.collectionIds ?? []).map((collectionId) => ({
              collectionId,
              productId: product.id,
              addedById: actor.userId ?? null,
              addedAt: now,
            })),
          });
        }
        const variants: ReturnType<typeof draftDto>[] = [];
        for (const draft of drafts) {
          const v = await insertVariant(tx, audit, actor, product.id, draft);
          variants.push(draftDto(v.id, draft));
        }
        await repo.refreshListingFields(tx, product.id);
        await audit.record(tx, actor, {
          action: 'CREATE',
          module: MODULE,
          entityType: 'Product',
          entityId: product.id,
          after: {
            id: product.id,
            productType: input.productType,
            name: input.name,
            slug,
            categoryId: input.categoryId,
            brandId: input.brandId ?? null,
            status: input.status,
            hsnCode: input.hsnCode ?? null,
            attributeValueIds: [...(input.attributeValueIds ?? [])].sort(),
            collectionIds: [...(input.collectionIds ?? [])].sort(),
            variantCount: drafts.length,
          },
          metadata: { entityLabel: input.name },
        });
        return { id: product.id, variants };
      });

      return {
        id: created.id,
        productType: input.productType,
        name: input.name,
        slug,
        status: input.status,
        variants: created.variants,
        warnings,
      };
    },

    async update(
      actor: AuditActor,
      productId: string,
      input: UpdateProductInput,
      view: ViewOptions,
    ) {
      const before = await repo.findAdmin(db, productId);
      if (before === null) throw notFound('Product');
      assertNotStale(before.updatedAt, input.expectedUpdatedAt);

      const categoryId = input.categoryId ?? before.categoryId;
      const name = input.name ?? before.name;
      const chain =
        input.categoryId !== undefined && input.categoryId !== before.categoryId
          ? await loadCategory(db, input.categoryId)
          : await repo.categoryChain(db, categoryId);
      await validateReferences(db, input);

      const conflicts: ErrorDetail[] = [];
      if (normalizeText(name) !== before.nameNormalized || categoryId !== before.categoryId) {
        const hit = await nameConflict(db, categoryId, name, productId);
        if (hit !== null) conflicts.push(hit);
      }
      if (input.slug !== undefined && input.slug !== before.slug) {
        // Old slug is NOT kept as a redirect: no redirect storage in the approved schema.
        const hit = await repo.findSlugConflict(db, input.slug, productId);
        if (hit !== null) {
          conflicts.push({
            field: 'slug',
            code: 'DUPLICATE_RESOURCE',
            message: `Slug "${input.slug}" is already used.`,
            meta: { existingId: hit.id, deleted: hit.deletedAt !== null },
          });
        }
      }
      if (conflicts.length > 0) {
        throw new AppError('DUPLICATE_RESOURCE', 'Some values are already in use.', {
          details: conflicts,
        });
      }

      // An ACTIVE product must keep satisfying the category's required attributes (workflow §3.3).
      if (
        before.status === 'ACTIVE' &&
        (input.categoryId !== undefined || input.attributeValueIds !== undefined)
      ) {
        const productAttrIds =
          input.attributeValueIds === undefined
            ? new Set(before.attributeValues.map((a) => a.attributeId))
            : await attributeIdsOfValues(db, input.attributeValueIds);
        const variantSets =
          before.productType === 'VARIABLE'
            ? before.variants.map((v) => new Set(v.variantValues.map((x) => x.attributeId)))
            : [];
        const missing = await missingRequired(repo, db, chain, productAttrIds, variantSets);
        if (missing.length > 0) {
          throw invalid(
            missing.map((m) => ({
              field: 'attributeValueIds',
              code: 'REQUIRED_ATTRIBUTE_MISSING',
              message: `Required attribute "${m.name}" has no value.`,
              meta: { attributeId: m.id },
            })),
          );
        }
      }

      await withTransaction(db, async ({ tx }) => {
        const data: Prisma.ProductUncheckedUpdateInput = {
          ...scalarData(input),
          updatedById: actor.userId ?? null,
        };
        if (input.name !== undefined) {
          data.name = input.name;
          data.nameNormalized = normalizeText(input.name);
        }
        if (input.slug !== undefined) data.slug = input.slug;
        if (input.categoryId !== undefined) data.categoryId = input.categoryId;
        await tx.product.update({ where: { id: productId }, data, select: { id: true } });
        if (input.attributeValueIds !== undefined) {
          await tx.productAttributeValue.deleteMany({ where: { productId } });
          if (input.attributeValueIds.length > 0) {
            const values = await repo.attributeValues(tx, input.attributeValueIds);
            await tx.productAttributeValue.createMany({
              data: values.map((v) => ({
                productId,
                attributeId: v.attributeId,
                attributeValueId: v.id,
              })),
            });
          }
        }
        if (input.collectionIds !== undefined) {
          await tx.collectionProduct.deleteMany({ where: { productId } });
          if (input.collectionIds.length > 0) {
            await tx.collectionProduct.createMany({
              data: input.collectionIds.map((collectionId) => ({
                collectionId,
                productId,
                addedById: actor.userId ?? null,
                addedAt: clock(),
              })),
            });
          }
        }
        const after = {
          ...auditSnapshot(before),
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.slug === undefined ? {} : { slug: input.slug }),
          ...(input.categoryId === undefined ? {} : { categoryId: input.categoryId }),
          ...scalarData(input),
          ...(input.attributeValueIds === undefined
            ? {}
            : { attributeValueIds: [...input.attributeValueIds].sort() }),
          ...(input.collectionIds === undefined
            ? {}
            : { collectionIds: [...input.collectionIds].sort() }),
        };
        await audit.record(tx, actor, {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'Product',
          entityId: productId,
          before: auditSnapshot(before),
          after,
          metadata: { entityLabel: before.name },
        });
      });
      // Storefront cache invalidation hook: no shared cache exists yet (OQ-35 Redis deferred).
      return service.get(productId, view);
    },

    async remove(actor: AuditActor, productId: string) {
      const product = await repo.findCore(db, productId);
      if (product === null) throw notFound('Product');
      const reservations = await repo.activeReservationCount(db, { variant: { productId } });
      if (reservations > 0) {
        throw conflict(
          'ACTIVE_RESERVATIONS',
          'This product has variants with active stock reservations (unpaid orders).',
          { activeReservations: reservations },
        );
      }
      const now = clock();
      await withTransaction(db, async ({ tx }) => {
        await tx.product.update({
          where: { id: productId },
          data: { deletedAt: now, deletedById: actor.userId ?? null, status: 'ARCHIVED' },
          select: { id: true },
        });
        // SKUs/barcodes of soft-deleted variants stay reserved forever (never reusable).
        await tx.productVariant.updateMany({
          where: { productId, deletedAt: null },
          data: { deletedAt: now, deletedById: actor.userId ?? null },
        });
        await audit.record(tx, actor, {
          action: 'DELETE',
          module: MODULE,
          entityType: 'Product',
          entityId: productId,
          before: { id: productId, name: product.name, slug: product.slug, status: product.status },
          after: null,
          metadata: { entityLabel: product.name, softDelete: true },
        });
      });
      return { id: productId, deleted: true };
    },

    async changeStatus(actor: AuditActor, productId: string, input: ProductStatusInput) {
      const product = await repo.findCore(db, productId);
      if (product === null) throw notFound('Product');
      const from = product.status;
      const to = input.status;
      if (from === to) {
        return {
          id: productId,
          status: from,
          publishedAt: product.publishedAt?.toISOString() ?? null,
        };
      }
      if (!canTransition(from, to)) {
        throw new AppError(
          'INVALID_STATE_TRANSITION',
          `Cannot change status from ${from} to ${to}.`,
          {
            details: [
              {
                field: 'status',
                code: 'INVALID_STATE_TRANSITION',
                message: `Allowed from ${from}: ${allowedTransitions(from).join(', ')}.`,
                meta: { from, to, allowed: allowedTransitions(from) },
              },
            ],
          },
        );
      }
      if (to === 'ACTIVE') await assertPublishable(product);

      const now = clock();
      const publishedAt =
        to === 'ACTIVE' && product.publishedAt === null ? now : product.publishedAt;
      await withTransaction(db, async ({ tx }) => {
        await tx.product.update({
          where: { id: productId },
          data: { status: to, publishedAt, updatedById: actor.userId ?? null },
          select: { id: true },
        });
        await audit.record(tx, actor, {
          action: 'STATUS_CHANGE',
          module: MODULE,
          entityType: 'Product',
          entityId: productId,
          before: { status: from },
          after: { status: to },
          reason: input.reason,
          metadata: { entityLabel: product.name },
        });
      });
      return { id: productId, status: to, publishedAt: publishedAt?.toISOString() ?? null };
    },

    async checkDuplicate(input: CheckDuplicateInput) {
      switch (input.field) {
        case 'name': {
          const normalized = normalizeText(input.value);
          const hit = await repo.findNameConflict(
            db,
            input.categoryId ?? '',
            normalized,
            input.excludeId,
          );
          return {
            field: input.field,
            value: input.value,
            normalized,
            valid: true,
            available: hit === null,
            conflict:
              hit === null
                ? null
                : {
                    entity: 'product',
                    id: hit.id,
                    productName: hit.name,
                    deleted: hit.deletedAt !== null,
                  },
          };
        }
        case 'slug': {
          const normalized = slugify(input.value);
          const hit = await repo.findSlugConflict(db, normalized, input.excludeId);
          return {
            field: input.field,
            value: input.value,
            normalized,
            valid: normalized.length > 0,
            available: hit === null,
            conflict:
              hit === null
                ? null
                : {
                    entity: 'product',
                    id: hit.id,
                    productName: hit.name,
                    deleted: hit.deletedAt !== null,
                  },
          };
        }
        case 'sku':
        case 'barcode': {
          const normalized = normalizeCode(input.value);
          const valid = (input.field === 'sku' ? SKU_PATTERN : BARCODE_PATTERN).test(normalized);
          const hits = valid
            ? await repo.findCodeConflicts(db, input.field, [normalized], input.excludeId)
            : [];
          const hit = hits[0];
          return {
            field: input.field,
            value: input.value,
            normalized,
            valid,
            available: valid && hit === undefined,
            conflict:
              hit === undefined
                ? null
                : {
                    entity: 'product_variant',
                    id: hit.id,
                    productId: hit.productId,
                    productName: hit.product.name,
                    deleted: hit.deletedAt !== null,
                  },
          };
        }
      }
    },
  };
  return service;

  async function assertPublishable(product: {
    id: string;
    productType: string;
    categoryId: string;
    hsnCode: string | null;
  }) {
    const [chain, variants, imageCount, productValues] = await Promise.all([
      repo.categoryChain(db, product.categoryId),
      repo.variantsWithValues(db, product.id),
      repo.imageCount(db, product.id),
      repo.productAttributeIds(db, product.id),
    ]);
    const variantSets =
      product.productType === 'VARIABLE'
        ? variants.map((v) => new Set(v.variantValues.map((x) => x.attributeId)))
        : [];
    const missing = await missingRequired(
      repo,
      db,
      chain,
      new Set(productValues.map((v) => v.attributeId)),
      variantSets,
    );
    const tax = await taxFor(db, product, chain);
    const unmet = evaluatePublishGate({
      categoryActive: categoryUsable(chain),
      variants,
      imageCount,
      missingRequiredAttributes: missing,
      taxResolvable: tax !== null,
    });
    if (unmet.length > 0) throw publishError(unmet);
  }
}

function publishError(unmet: ReturnType<typeof evaluatePublishGate>): AppError {
  return new AppError('VALIDATION_ERROR', 'Publish requirements are not met.', {
    details: unmet.map((u) => ({
      field: u.field,
      code: 'PUBLISH_REQUIREMENTS_NOT_MET',
      message: u.message,
      meta: { requirement: u.requirement, ...u.meta },
    })),
  });
}

function toDraft(
  field: string,
  v: {
    sku: string;
    barcode?: string | null | undefined;
    mrp: string;
    sellingPrice: string;
    compareAtPrice?: string | null | undefined;
    costPrice?: string | null | undefined;
    weightGrams?: string | null | undefined;
    lengthMm?: number | null | undefined;
    widthMm?: number | null | undefined;
    heightMm?: number | null | undefined;
    status: 'ACTIVE' | 'INACTIVE';
    lowStockThreshold?: number | undefined;
  },
  extra: Pick<
    VariantDraft,
    'name' | 'label' | 'combinationKey' | 'isDefault' | 'values' | 'sortOrder'
  >,
): VariantDraft {
  return {
    field,
    sku: v.sku,
    barcode: v.barcode ?? null,
    mrp: v.mrp,
    sellingPrice: v.sellingPrice,
    compareAtPrice: v.compareAtPrice ?? null,
    costPrice: v.costPrice ?? null,
    weightGrams: v.weightGrams ?? null,
    lengthMm: v.lengthMm ?? null,
    widthMm: v.widthMm ?? null,
    heightMm: v.heightMm ?? null,
    status: v.status,
    lowStockThreshold: v.lowStockThreshold ?? null,
    ...extra,
  };
}

export { toDraft };
export type ProductsService = ReturnType<typeof createProductsService>;
