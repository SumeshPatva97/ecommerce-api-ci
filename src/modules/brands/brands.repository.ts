/**
 * Brand persistence (Prisma only, no business rules).
 */
import type { Brand, Prisma } from '../../generated/prisma/client.js';
import type { Queryable } from '../../core/db/transaction.js';

export type BrandRow = Brand;
export type BrandWithCount = Brand & { _count: { products: number } };

/** Products counted on brand rows: ACTIVE and not deleted. */
const ACTIVE_PRODUCTS = { where: { status: 'ACTIVE', deletedAt: null } } as const;

export function createBrandsRepository() {
  return {
    findById(db: Queryable, id: string): Promise<BrandRow | null> {
      return db.brand.findUnique({ where: { id } });
    },

    findByIdWithCount(db: Queryable, id: string): Promise<BrandWithCount | null> {
      return db.brand.findUnique({
        where: { id },
        include: { _count: { select: { products: ACTIVE_PRODUCTS } } },
      });
    },

    /** Includes soft-deleted rows: names/slugs stay reserved (PROVISIONAL OQ-39). */
    findByNameNormalized(db: Queryable, nameNormalized: string): Promise<BrandRow | null> {
      return db.brand.findUnique({ where: { nameNormalized } });
    },

    findBySlug(db: Queryable, slug: string): Promise<BrandRow | null> {
      return db.brand.findUnique({ where: { slug } });
    },

    async list(
      db: Queryable,
      where: Prisma.BrandWhereInput,
      orderBy: Prisma.BrandOrderByWithRelationInput[],
      skip: number,
      take: number,
    ): Promise<{ rows: BrandWithCount[]; total: number }> {
      const [rows, total] = await Promise.all([
        db.brand.findMany({
          where,
          orderBy,
          skip,
          take,
          include: { _count: { select: { products: ACTIVE_PRODUCTS } } },
        }),
        db.brand.count({ where }),
      ]);
      return { rows, total };
    },

    create(db: Queryable, data: Prisma.BrandUncheckedCreateInput): Promise<BrandRow> {
      return db.brand.create({ data });
    },

    update(db: Queryable, id: string, data: Prisma.BrandUncheckedUpdateInput): Promise<BrandRow> {
      return db.brand.update({ where: { id }, data });
    },

    countActiveProducts(db: Queryable, brandId: string): Promise<number> {
      return db.product.count({ where: { brandId, status: 'ACTIVE', deletedAt: null } });
    },

    listPublic(db: Queryable): Promise<BrandWithCount[]> {
      return db.brand.findMany({
        where: { isActive: true, deletedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        include: { _count: { select: { products: ACTIVE_PRODUCTS } } },
      });
    },
  };
}

export type BrandsRepository = ReturnType<typeof createBrandsRepository>;
