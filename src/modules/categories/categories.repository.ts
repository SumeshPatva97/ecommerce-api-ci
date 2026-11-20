/**
 * Category persistence (Prisma only, no business rules).
 */
import type {
  Attribute,
  Category,
  CategoryAttribute,
  Prisma,
} from '../../generated/prisma/client.js';
import type { Queryable } from '../../core/db/transaction.js';

export type CategoryRow = Category;
export type CategoryWithCounts = Category & { _count: { products: number; children: number } };
export type CategoryRuleRow = CategoryAttribute & { attribute: Attribute };

/** Admin counts: live (non-deleted) products and child categories. */
const ADMIN_COUNTS = {
  _count: {
    select: {
      products: { where: { deletedAt: null } },
      children: { where: { deletedAt: null } },
    },
  },
} as const;

/** Storefront counts: ACTIVE, non-deleted products (children counted for completeness). */
const PUBLIC_COUNTS = {
  _count: {
    select: {
      products: { where: { status: 'ACTIVE', deletedAt: null } },
      children: { where: { isActive: true, deletedAt: null } },
    },
  },
} as const;

const PUBLIC_VISIBLE = { isActive: true, deletedAt: null } as const;

export function createCategoriesRepository() {
  return {
    findById(db: Queryable, id: string): Promise<CategoryRow | null> {
      return db.category.findUnique({ where: { id } });
    },

    findByIdWithCounts(db: Queryable, id: string): Promise<CategoryWithCounts | null> {
      return db.category.findUnique({ where: { id }, include: ADMIN_COUNTS });
    },

    findBySlug(db: Queryable, slug: string): Promise<CategoryRow | null> {
      return db.category.findUnique({ where: { slug } });
    },

    /**
     * Same-parent name lookup, soft-deleted rows included (PROVISIONAL OQ-39). The DB guard is
     * `uq_categories_parent_name (parent_key, name_normalized)` on a generated column.
     */
    findByParentAndName(
      db: Queryable,
      parentId: string | null,
      nameNormalized: string,
    ): Promise<CategoryRow | null> {
      return db.category.findFirst({ where: { parentId, nameNormalized } });
    },

    findManyByIds(db: Queryable, ids: readonly string[]): Promise<CategoryRow[]> {
      return db.category.findMany({ where: { id: { in: [...ids] } } });
    },

    async list(
      db: Queryable,
      where: Prisma.CategoryWhereInput,
      orderBy: Prisma.CategoryOrderByWithRelationInput[],
      skip: number,
      take: number,
    ): Promise<{ rows: CategoryWithCounts[]; total: number }> {
      const [rows, total] = await Promise.all([
        db.category.findMany({ where, orderBy, skip, take, include: ADMIN_COUNTS }),
        db.category.count({ where }),
      ]);
      return { rows, total };
    },

    listAll(db: Queryable, where: Prisma.CategoryWhereInput): Promise<CategoryWithCounts[]> {
      return db.category.findMany({
        where,
        orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
        include: ADMIN_COUNTS,
      });
    },

    /** The row itself and every descendant (any state). */
    findSubtree(db: Queryable, path: string): Promise<CategoryRow[]> {
      return db.category.findMany({ where: { path: { startsWith: path } } });
    },

    findLiveChildren(db: Queryable, parentId: string | null): Promise<CategoryRow[]> {
      return db.category.findMany({ where: { parentId, deletedAt: null } });
    },

    create(db: Queryable, data: Prisma.CategoryUncheckedCreateInput): Promise<CategoryRow> {
      return db.category.create({ data });
    },

    update(
      db: Queryable,
      id: string,
      data: Prisma.CategoryUncheckedUpdateInput,
    ): Promise<CategoryRow> {
      return db.category.update({ where: { id }, data });
    },

    countLiveChildren(db: Queryable, parentId: string): Promise<number> {
      return db.category.count({ where: { parentId, deletedAt: null } });
    },

    countLiveProducts(db: Queryable, categoryId: string): Promise<number> {
      return db.product.count({ where: { categoryId, deletedAt: null } });
    },

    /** Live products in the category or any descendant. */
    countLiveProductsInSubtree(db: Queryable, path: string): Promise<number> {
      return db.product.count({
        where: { deletedAt: null, category: { path: { startsWith: path } } },
      });
    },

    // ---- category-attribute rules -------------------------------------------------------

    findRules(db: Queryable, categoryIds: readonly string[]): Promise<CategoryRuleRow[]> {
      return db.categoryAttribute.findMany({
        where: { categoryId: { in: [...categoryIds] } },
        include: { attribute: true },
      });
    },

    findAttributes(db: Queryable, ids: readonly string[]): Promise<Attribute[]> {
      if (ids.length === 0) return Promise.resolve([]);
      return db.attribute.findMany({ where: { id: { in: [...ids] }, deletedAt: null } });
    },

    async replaceRules(
      db: Queryable,
      categoryId: string,
      rules: readonly Omit<Prisma.CategoryAttributeCreateManyInput, 'categoryId'>[],
    ): Promise<void> {
      await db.categoryAttribute.deleteMany({ where: { categoryId } });
      if (rules.length === 0) return;
      await db.categoryAttribute.createMany({
        data: rules.map((rule) => ({ ...rule, categoryId })),
      });
    },

    // ---- storefront ---------------------------------------------------------------------

    listPublic(db: Queryable): Promise<CategoryWithCounts[]> {
      return db.category.findMany({
        where: PUBLIC_VISIBLE,
        orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
        include: PUBLIC_COUNTS,
      });
    },

    findPublicSubtree(db: Queryable, path: string): Promise<CategoryWithCounts[]> {
      return db.category.findMany({
        where: { ...PUBLIC_VISIBLE, path: { startsWith: path } },
        orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
        include: PUBLIC_COUNTS,
      });
    },

    /** Active SIZE_GUIDE CMS blocks scoped to any of the given categories (OQ-44 / OQ-90). */
    findSizeGuideBlocks(
      db: Queryable,
      categoryIds: readonly string[],
    ): Promise<{ blockKey: string; categoryId: string | null }[]> {
      return db.cmsBlock.findMany({
        where: { type: 'SIZE_GUIDE', isActive: true, categoryId: { in: [...categoryIds] } },
        select: { blockKey: true, categoryId: true },
      });
    },
  };
}

export type CategoriesRepository = ReturnType<typeof createCategoriesRepository>;
