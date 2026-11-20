/**
 * Category use-cases — API_DOCUMENTATION.md §4.4, §3.3; DATABASE_DESIGN.md §7.1–§7.2;
 * PROJECT_CONTEXT.md §3.5–§3.6 (name unique per parent, slug global).
 *
 * - Tree: materialized `path` + `depth` (max 3). A move recomputes path/depth for the whole
 *   subtree in the same transaction; moving under itself/a descendant → 422 `CATEGORY_CYCLE`,
 *   exceeding depth 3 → 422 `CATEGORY_DEPTH`.
 * - Soft delete only when empty: no live child categories and no live products → 409 IN_USE.
 * - PROVISIONAL (OQ-39): soft-deleted names/slugs stay reserved (restore or rename).
 * - Category-attribute rules: effective set = ancestors (root → leaf, `inheritToChildren`) merged
 *   with own rows, nearest wins (DATABASE_DESIGN.md §7.2).
 */
import { randomUUID } from 'node:crypto';

import type { AppContainer } from '../../container.js';
import { withTransaction, type Queryable } from '../../core/db/transaction.js';
import { AppError, type ErrorDetail } from '../../core/errors/AppError.js';
import { buildPageMeta, toSkipTake, type PageMeta } from '../../core/http/pagination.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { normalizeText } from '../../lib/normalize.js';
import { uniqueSlug } from '../../lib/slug.js';
import type { AuditActor } from '../audit/audit.service.js';
import { changedKeys, updateAction } from '../catalog-common/catalog.audit.js';
import {
  duplicateError,
  fieldError,
  inUseError,
  notFoundError,
} from '../catalog-common/catalog.errors.js';
import { compact, imageColumns, seoColumns, toStatus } from '../catalog-common/catalog.mapper.js';
import { parseSort, statusWhere } from '../catalog-common/catalog.schemas.js';
import {
  toAdminCategory,
  toAdminTree,
  toPublicCategoryDetail,
  toPublicTree,
  toTreeInput,
  type AdminCategoryDto,
  type AdminCategoryTreeDto,
  type CategoryAttributeRuleDto,
  type PublicCategoryDetailDto,
  type PublicCategoryNodeDto,
} from './categories.mapper.js';
import type {
  CategoriesRepository,
  CategoryRow,
  CategoryRuleRow,
} from './categories.repository.js';
import type {
  CategoryListQueryInput,
  CreateCategoryInput,
  PublicCategoryTreeQueryInput,
  ReorderCategoriesInput,
  ReplaceCategoryAttributesInput,
  UpdateCategoryInput,
} from './categories.schemas.js';
import {
  MAX_CATEGORY_DEPTH,
  buildTree,
  childPath,
  idsFromPath,
  isSelfOrDescendant,
  rebaseSubtree,
  subtreeHeight,
} from './categories.tree.js';

const MODULE = 'categories';
const ENTITY = 'Category';

export interface CategoryAttributesResult {
  categoryId: string;
  attributes: CategoryAttributeRuleDto[];
  warnings?: ErrorDetail[];
}

function depthError(): AppError {
  return fieldError(
    'parentId',
    `Categories can be nested at most ${MAX_CATEGORY_DEPTH} levels deep.`,
    'CATEGORY_DEPTH',
  );
}

function cycleError(): AppError {
  return fieldError(
    'parentId',
    'A category cannot be moved under itself or one of its descendants.',
    'CATEGORY_CYCLE',
  );
}

/** Merge rules root → leaf; ancestors contribute only rules marked `inheritToChildren`. */
export function mergeRules(
  chain: readonly CategoryRow[],
  rules: readonly CategoryRuleRow[],
): CategoryAttributeRuleDto[] {
  const self = chain[chain.length - 1];
  const effective = new Map<string, CategoryAttributeRuleDto>();
  for (const category of chain) {
    const own = category.id === self?.id;
    for (const rule of rules) {
      if (rule.categoryId !== category.id) continue;
      if (rule.attribute.deletedAt !== null) continue;
      if (!own && !rule.inheritToChildren) continue;
      effective.set(rule.attributeId, {
        attributeId: rule.attributeId,
        attribute: {
          id: rule.attribute.id,
          name: rule.attribute.name,
          code: rule.attribute.code,
          displayType: rule.attribute.displayType,
          isVariantAxis: rule.attribute.isVariantAxis,
          status: toStatus(rule.attribute.isActive),
        },
        isRequired: rule.isRequired,
        isVariantAxisDefault: rule.isVariantAxisDefault,
        inheritToChildren: rule.inheritToChildren,
        sortOrder: rule.sortOrder,
        inheritedFrom: own ? null : { id: category.id, name: category.name },
      });
    }
  }
  return [...effective.values()].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.attribute.name.localeCompare(b.attribute.name),
  );
}

export function createCategoriesService(container: AppContainer, repo: CategoriesRepository) {
  const { db, audit, clock } = container;

  async function loadLive(tx: Queryable, id: string): Promise<CategoryRow> {
    const row = await repo.findById(tx, id);
    if (row?.deletedAt !== null) throw notFoundError('Category');
    return row;
  }

  async function loadParent(tx: Queryable, parentId: string): Promise<CategoryRow> {
    const parent = await repo.findById(tx, parentId);
    if (parent?.deletedAt !== null) {
      throw fieldError('parentId', 'Parent category not found.', 'PARENT_NOT_FOUND');
    }
    return parent;
  }

  async function assertNameFree(
    tx: Queryable,
    parentId: string | null,
    name: string,
    selfId?: string,
  ): Promise<string> {
    const normalized = normalizeText(name);
    const existing = await repo.findByParentAndName(tx, parentId, normalized);
    if (existing !== null && existing.id !== selfId) {
      throw duplicateError('name', `Category "${name}" already exists at this level.`, {
        normalized,
        existingId: existing.id,
        parentId,
        ...(existing.deletedAt === null ? {} : { deleted: true }),
      });
    }
    return normalized;
  }

  async function assertSlugFree(tx: Queryable, slug: string, selfId?: string): Promise<void> {
    const existing = await repo.findBySlug(tx, slug);
    if (existing !== null && existing.id !== selfId) {
      throw duplicateError('slug', `Slug "${slug}" is already used by another category.`, {
        existingId: existing.id,
      });
    }
  }

  /** Ancestor chain root → self, in path order. */
  async function chainOf(tx: Queryable, category: CategoryRow): Promise<CategoryRow[]> {
    const ids = idsFromPath(category.path);
    const rows = await repo.findManyByIds(tx, ids.slice(0, -1));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const chain = ids
      .slice(0, -1)
      .map((id) => byId.get(id))
      .filter((r): r is CategoryRow => r !== undefined);
    return [...chain, category];
  }

  async function effectiveRules(tx: Queryable, category: CategoryRow) {
    const chain = await chainOf(tx, category);
    const rules = await repo.findRules(
      tx,
      chain.map((c) => c.id),
    );
    return mergeRules(chain, rules);
  }

  return {
    async list(query: CategoryListQueryInput): Promise<{
      items: AdminCategoryDto[] | AdminCategoryTreeDto[];
      meta: PageMeta | Record<string, unknown>;
    }> {
      const where: Prisma.CategoryWhereInput = {
        ...statusWhere(query.status),
        ...(query.q === undefined ? {} : { name: { contains: query.q } }),
        ...(query.parentId === undefined
          ? {}
          : { parentId: query.parentId === 'root' ? null : query.parentId }),
      };
      if (query.view === 'tree') {
        // Whole tree, not paginated (≤ a few hundred rows; depth ≤ 3).
        const rows = await repo.listAll(db, { ...statusWhere(query.status) });
        const tree = buildTree(rows.map(toTreeInput), { orphans: 'root' }).map(toAdminTree);
        return { items: tree, meta: { view: 'tree', totalItems: rows.length } };
      }
      const sort = parseSort(query.sort, 'sortOrder');
      const { skip, take } = toSkipTake(query.page, query.limit);
      const { rows, total } = await repo.list(
        db,
        where,
        [{ [sort.field]: sort.direction }, { name: 'asc' }],
        skip,
        take,
      );
      return {
        items: rows.map(toAdminCategory),
        meta: buildPageMeta(query.page, query.limit, total),
      };
    },

    async get(
      id: string,
    ): Promise<AdminCategoryDto & { breadcrumb: { id: string; name: string }[] }> {
      const row = await repo.findByIdWithCounts(db, id);
      if (row === null) throw notFoundError('Category');
      const chain = await chainOf(db, row);
      return {
        ...toAdminCategory(row),
        breadcrumb: chain.map((c) => ({ id: c.id, name: c.name })),
      };
    },

    async create(actor: AuditActor, input: CreateCategoryInput): Promise<AdminCategoryDto> {
      return withTransaction(db, async ({ tx }) => {
        const parentId = input.parentId ?? null;
        const parent = parentId === null ? null : await loadParent(tx, parentId);
        const depth = (parent?.depth ?? 0) + 1;
        if (depth > MAX_CATEGORY_DEPTH) throw depthError();
        const nameNormalized = await assertNameFree(tx, parentId, input.name);
        let slug: string;
        if (input.slug === undefined) {
          slug = await uniqueSlug(input.name, async (c) => (await repo.findBySlug(tx, c)) !== null);
        } else {
          await assertSlugFree(tx, input.slug);
          slug = input.slug;
        }
        const id = randomUUID();
        const image = imageColumns(input.image);
        const banner = imageColumns(input.bannerImage);
        const row = await repo.create(tx, {
          id,
          parentId,
          name: input.name,
          nameNormalized,
          slug,
          path: childPath(parent?.path ?? null, id),
          depth,
          description: input.description ?? null,
          imageUrl: image?.url ?? null,
          imagePublicId: image?.publicId ?? null,
          bannerImageUrl: banner?.url ?? null,
          bannerImagePid: banner?.publicId ?? null,
          sortOrder: input.sortOrder ?? 0,
          isActive: (input.status ?? 'ACTIVE') === 'ACTIVE',
          showInMenu: input.showInMenu ?? true,
          ...seoColumns(input.seo),
          createdById: actor.userId ?? null,
          updatedById: actor.userId ?? null,
        });
        await audit.record(tx, actor, {
          action: 'CREATE',
          module: MODULE,
          entityType: ENTITY,
          entityId: row.id,
          after: row,
        });
        return toAdminCategory(row);
      });
    },

    async update(
      actor: AuditActor,
      id: string,
      input: UpdateCategoryInput,
    ): Promise<AdminCategoryDto> {
      return withTransaction(db, async ({ tx }) => {
        const before = await loadLive(tx, id);
        const targetParentId = input.parentId === undefined ? before.parentId : input.parentId;
        const moving = targetParentId !== before.parentId;

        let move: { path: string; depth: number; parentId: string | null } | undefined;
        let rebased: { id: string; path: string; depth: number }[] = [];
        if (moving) {
          if (targetParentId === id) throw cycleError();
          const parent = targetParentId === null ? null : await loadParent(tx, targetParentId);
          if (parent !== null && isSelfOrDescendant(parent.path, id)) throw cycleError();
          const depth = (parent?.depth ?? 0) + 1;
          const subtree = await repo.findSubtree(tx, before.path);
          const height = subtreeHeight(
            before.depth,
            subtree.map((r) => r.depth),
          );
          if (depth + height > MAX_CATEGORY_DEPTH) throw depthError();
          const path = childPath(parent?.path ?? null, id);
          move = { path, depth, parentId: targetParentId };
          rebased = rebaseSubtree(subtree, before.path, path, depth - before.depth);
        }

        const name = input.name ?? before.name;
        const nameNormalized =
          input.name !== undefined || moving
            ? await assertNameFree(tx, targetParentId, name, id)
            : undefined;
        if (input.slug !== undefined && input.slug !== before.slug) {
          await assertSlugFree(tx, input.slug, id);
        }

        const image = imageColumns(input.image);
        const banner = imageColumns(input.bannerImage);
        const patch = compact({
          name: input.name,
          nameNormalized,
          slug: input.slug,
          parentId: move?.parentId,
          path: move?.path,
          depth: move?.depth,
          description: input.description,
          imageUrl: image?.url,
          imagePublicId: image?.publicId,
          bannerImageUrl: banner?.url,
          bannerImagePid: banner?.publicId,
          sortOrder: input.sortOrder,
          isActive: input.status === undefined ? undefined : input.status === 'ACTIVE',
          showInMenu: input.showInMenu,
          ...seoColumns(input.seo),
        });

        const changed = changedKeys(before, patch);
        if (changed.length === 0) return toAdminCategory(before);
        const after = await repo.update(tx, id, { ...patch, updatedById: actor.userId ?? null });
        for (const row of rebased) {
          await repo.update(tx, row.id, { path: row.path, depth: row.depth });
        }
        await audit.record(tx, actor, {
          action: updateAction(changed),
          module: MODULE,
          entityType: ENTITY,
          entityId: id,
          before,
          after,
          ...(moving
            ? { eventKey: 'categories.moved', metadata: { rebasedDescendants: rebased.length } }
            : {}),
        });
        return toAdminCategory(after);
      });
    },

    async remove(actor: AuditActor, id: string): Promise<{ id: string; deleted: true }> {
      return withTransaction(db, async ({ tx }) => {
        const before = await loadLive(tx, id);
        const children = await repo.countLiveChildren(tx, id);
        if (children > 0) {
          throw inUseError('This category has sub-categories. Move or delete them first.', {
            children,
          });
        }
        const products = await repo.countLiveProducts(tx, id);
        if (products > 0) {
          throw inUseError('This category still contains products. Move them first.', {
            products,
          });
        }
        const after = await repo.update(tx, id, {
          deletedAt: clock(),
          deletedById: actor.userId ?? null,
        });
        await audit.record(tx, actor, {
          action: 'DELETE',
          module: MODULE,
          entityType: ENTITY,
          entityId: id,
          before,
          after,
        });
        return { id, deleted: true as const };
      });
    },

    async restore(actor: AuditActor, id: string): Promise<AdminCategoryDto> {
      return withTransaction(db, async ({ tx }) => {
        const before = await repo.findById(tx, id);
        if (before === null) throw notFoundError('Category');
        if (before.deletedAt === null) {
          throw new AppError('INVALID_STATE_TRANSITION', 'This category is not deleted.');
        }
        if (before.parentId !== null) {
          const parent = await repo.findById(tx, before.parentId);
          if (parent?.deletedAt !== null) {
            throw new AppError('CONFLICT', 'Restore the parent category first.', {
              details: [
                { field: 'parentId', message: 'Parent is deleted.', code: 'PARENT_DELETED' },
              ],
            });
          }
        }
        const after = await repo.update(tx, id, {
          deletedAt: null,
          deletedById: null,
          updatedById: actor.userId ?? null,
        });
        await audit.record(tx, actor, {
          action: 'RESTORE',
          module: MODULE,
          entityType: ENTITY,
          entityId: id,
          before,
          after,
        });
        return toAdminCategory(after);
      });
    },

    async reorder(
      actor: AuditActor,
      input: ReorderCategoriesInput,
    ): Promise<{ parentId: string | null; categoryIds: string[] }> {
      return withTransaction(db, async ({ tx }) => {
        if (input.parentId !== null) await loadParent(tx, input.parentId);
        const siblings = await repo.findLiveChildren(tx, input.parentId);
        const byId = new Map(siblings.map((s) => [s.id, s]));
        const sameSet =
          siblings.length === input.categoryIds.length &&
          input.categoryIds.every((cid) => byId.has(cid));
        if (!sameSet) {
          throw fieldError(
            'categoryIds',
            'Provide every live sub-category of this parent exactly once.',
            'REORDER_MISMATCH',
          );
        }
        let changedCount = 0;
        for (const [index, cid] of input.categoryIds.entries()) {
          const before = byId.get(cid);
          if (before === undefined || before.sortOrder === index) continue;
          const after = await repo.update(tx, cid, {
            sortOrder: index,
            updatedById: actor.userId ?? null,
          });
          changedCount += 1;
          await audit.record(tx, actor, {
            action: 'UPDATE',
            module: MODULE,
            entityType: ENTITY,
            entityId: cid,
            eventKey: 'categories.reordered',
            before,
            after,
          });
        }
        if (changedCount > 0) {
          await audit.record(tx, actor, {
            action: 'UPDATE',
            module: MODULE,
            entityType: ENTITY,
            entityId: input.parentId,
            eventKey: 'categories.reordered_summary',
            diff: false,
            metadata: { parentId: input.parentId, changed: changedCount, order: input.categoryIds },
          });
        }
        return { parentId: input.parentId, categoryIds: [...input.categoryIds] };
      });
    },

    // ---- category-attribute rules -------------------------------------------------------

    async getAttributes(id: string): Promise<CategoryAttributesResult> {
      const category = await loadLive(db, id);
      return { categoryId: id, attributes: await effectiveRules(db, category) };
    },

    async replaceAttributes(
      actor: AuditActor,
      id: string,
      input: ReplaceCategoryAttributesInput,
    ): Promise<CategoryAttributesResult> {
      return withTransaction(db, async ({ tx }) => {
        const category = await loadLive(tx, id);
        const attributes = await repo.findAttributes(
          tx,
          input.attributes.map((a) => a.attributeId),
        );
        const byId = new Map(attributes.map((a) => [a.id, a]));
        const details: ErrorDetail[] = [];
        input.attributes.forEach((rule, index) => {
          const attribute = byId.get(rule.attributeId);
          if (attribute === undefined) {
            details.push({
              field: `attributes[${index}].attributeId`,
              message: 'Attribute not found.',
              code: 'ATTRIBUTE_NOT_FOUND',
            });
          } else if (rule.isVariantAxisDefault && !attribute.isVariantAxis) {
            details.push({
              field: `attributes[${index}].isVariantAxisDefault`,
              message: `${attribute.name} is not a variant axis attribute.`,
              code: 'NOT_VARIANT_AXIS',
            });
          }
        });
        if (details.length > 0) {
          throw new AppError('VALIDATION_ERROR', 'Some attribute rules are invalid.', { details });
        }

        const beforeRules = await repo.findRules(tx, [id]);
        const snapshot = (
          rules: readonly {
            attributeId: string;
            isRequired: boolean;
            isVariantAxisDefault: boolean;
            inheritToChildren: boolean;
            sortOrder: number;
          }[],
        ) =>
          rules.map((r) => ({
            attributeId: r.attributeId,
            isRequired: r.isRequired,
            isVariantAxisDefault: r.isVariantAxisDefault,
            inheritToChildren: r.inheritToChildren,
            sortOrder: r.sortOrder,
          }));
        const nextRules = input.attributes.map((rule, index) => ({
          attributeId: rule.attributeId,
          isRequired: rule.isRequired,
          isVariantAxisDefault: rule.isVariantAxisDefault,
          inheritToChildren: rule.inheritToChildren,
          sortOrder: rule.sortOrder ?? index,
        }));
        await repo.replaceRules(tx, id, nextRules);
        await audit.record(tx, actor, {
          action: 'UPDATE',
          module: MODULE,
          entityType: ENTITY,
          entityId: id,
          eventKey: 'categories.attribute_rules_replaced',
          before: { attributeRules: snapshot(beforeRules) },
          after: { attributeRules: nextRules },
        });

        // Newly required attributes do not invalidate products, but block their next
        // publish/update until filled (§4.4) → surfaced as warnings.
        const wasRequired = new Set(
          beforeRules.filter((r) => r.isRequired).map((r) => r.attributeId),
        );
        const newlyRequired = nextRules.filter(
          (r) => r.isRequired && !wasRequired.has(r.attributeId),
        );
        const warnings: ErrorDetail[] = [];
        if (newlyRequired.length > 0) {
          const affectedProducts = await repo.countLiveProductsInSubtree(tx, category.path);
          if (affectedProducts > 0) {
            for (const rule of newlyRequired) {
              warnings.push({
                field: 'attributes',
                code: 'REQUIRED_ATTRIBUTE_ADDED',
                message: `Existing products must set ${byId.get(rule.attributeId)?.name ?? 'this attribute'} before their next publish or update.`,
                meta: { attributeId: rule.attributeId, affectedProducts },
              });
            }
          }
        }
        return {
          categoryId: id,
          attributes: await effectiveRules(tx, category),
          ...(warnings.length > 0 ? { warnings } : {}),
        };
      });
    },

    // ---- storefront ---------------------------------------------------------------------

    async publicTree(query: PublicCategoryTreeQueryInput): Promise<PublicCategoryNodeDto[]> {
      const rows = await repo.listPublic(db);
      return buildTree(rows.map(toTreeInput), { orphans: 'drop', maxDepth: query.depth }).map(
        toPublicTree,
      );
    },

    async publicDetail(slug: string): Promise<PublicCategoryDetailDto> {
      const category = await repo.findBySlug(db, slug);
      if (category?.deletedAt !== null || !category.isActive) {
        throw notFoundError('Category');
      }
      const chain = await chainOf(db, category);
      const visible =
        chain.length === idsFromPath(category.path).length &&
        chain.every((c) => c.isActive && c.deletedAt === null);
      if (!visible) throw notFoundError('Category');

      const subtree = await repo.findPublicSubtree(db, category.path);
      const [node] = buildTree(
        subtree.map(toTreeInput).map((r) => (r.id === category.id ? { ...r, parentId: null } : r)),
        { orphans: 'drop', maxDepth: 2 },
      );
      if (node === undefined) throw notFoundError('Category');

      const blocks = await repo.findSizeGuideBlocks(
        db,
        chain.map((c) => c.id),
      );
      // Nearest scope wins (own category, then parent, then root).
      const sizeGuide = [...chain]
        .reverse()
        .map((c) => blocks.find((b) => b.categoryId === c.id))
        .find((b) => b !== undefined);
      return toPublicCategoryDetail(node, chain, sizeGuide?.blockKey ?? null);
    },
  };
}

export type CategoriesService = ReturnType<typeof createCategoriesService>;
