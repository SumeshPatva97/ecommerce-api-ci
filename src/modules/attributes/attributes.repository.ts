/**
 * Attribute & attribute-value persistence (Prisma only, no business rules).
 */
import type { Attribute, AttributeValue, Prisma } from '../../generated/prisma/client.js';
import type { Queryable } from '../../core/db/transaction.js';

export type AttributeRow = Attribute;
export type AttributeWithCount = Attribute & { _count: { values: number } };
export type AttributeValueRow = AttributeValue;

const LIVE_VALUES = { _count: { select: { values: { where: { deletedAt: null } } } } } as const;

export interface AttributeUsage {
  readonly variants: number;
  readonly products: number;
  readonly categoryRules: number;
}

export function createAttributesRepository() {
  return {
    findById(db: Queryable, id: string): Promise<AttributeRow | null> {
      return db.attribute.findUnique({ where: { id } });
    },

    findByIdWithCount(db: Queryable, id: string): Promise<AttributeWithCount | null> {
      return db.attribute.findUnique({ where: { id }, include: LIVE_VALUES });
    },

    /** Includes soft-deleted rows (PROVISIONAL OQ-39: names stay reserved). */
    findByNameNormalized(db: Queryable, nameNormalized: string): Promise<AttributeRow | null> {
      return db.attribute.findUnique({ where: { nameNormalized } });
    },

    findByCode(db: Queryable, code: string): Promise<AttributeRow | null> {
      return db.attribute.findUnique({ where: { code } });
    },

    async list(
      db: Queryable,
      where: Prisma.AttributeWhereInput,
      orderBy: Prisma.AttributeOrderByWithRelationInput[],
      skip: number,
      take: number,
    ): Promise<{ rows: AttributeWithCount[]; total: number }> {
      const [rows, total] = await Promise.all([
        db.attribute.findMany({ where, orderBy, skip, take, include: LIVE_VALUES }),
        db.attribute.count({ where }),
      ]);
      return { rows, total };
    },

    create(db: Queryable, data: Prisma.AttributeUncheckedCreateInput): Promise<AttributeRow> {
      return db.attribute.create({ data });
    },

    update(
      db: Queryable,
      id: string,
      data: Prisma.AttributeUncheckedUpdateInput,
    ): Promise<AttributeRow> {
      return db.attribute.update({ where: { id }, data });
    },

    async attributeUsage(db: Queryable, attributeId: string): Promise<AttributeUsage> {
      const [variants, products, categoryRules] = await Promise.all([
        db.variantAttributeValue.count({ where: { attributeId } }),
        db.productAttributeValue.count({ where: { attributeId } }),
        db.categoryAttribute.count({ where: { attributeId } }),
      ]);
      return { variants, products, categoryRules };
    },

    countAxisDefaultRules(db: Queryable, attributeId: string): Promise<number> {
      return db.categoryAttribute.count({ where: { attributeId, isVariantAxisDefault: true } });
    },

    // ---- values ---------------------------------------------------------------------------

    findValueById(db: Queryable, id: string): Promise<AttributeValueRow | null> {
      return db.attributeValue.findUnique({ where: { id } });
    },

    findValueByNormalized(
      db: Queryable,
      attributeId: string,
      valueNormalized: string,
    ): Promise<AttributeValueRow | null> {
      return db.attributeValue.findUnique({
        where: { attributeId_valueNormalized: { attributeId, valueNormalized } },
      });
    },

    findValueBySlug(
      db: Queryable,
      attributeId: string,
      slug: string,
    ): Promise<AttributeValueRow | null> {
      return db.attributeValue.findUnique({ where: { attributeId_slug: { attributeId, slug } } });
    },

    async listValues(
      db: Queryable,
      where: Prisma.AttributeValueWhereInput,
      orderBy: Prisma.AttributeValueOrderByWithRelationInput[],
      skip: number,
      take: number,
    ): Promise<{ rows: AttributeValueRow[]; total: number }> {
      const [rows, total] = await Promise.all([
        db.attributeValue.findMany({ where, orderBy, skip, take }),
        db.attributeValue.count({ where }),
      ]);
      return { rows, total };
    },

    createValue(
      db: Queryable,
      data: Prisma.AttributeValueUncheckedCreateInput,
    ): Promise<AttributeValueRow> {
      return db.attributeValue.create({ data });
    },

    updateValue(
      db: Queryable,
      id: string,
      data: Prisma.AttributeValueUncheckedUpdateInput,
    ): Promise<AttributeValueRow> {
      return db.attributeValue.update({ where: { id }, data });
    },

    async valueUsage(db: Queryable, attributeValueId: string): Promise<AttributeUsage> {
      const [variants, products] = await Promise.all([
        db.variantAttributeValue.count({ where: { attributeValueId } }),
        db.productAttributeValue.count({ where: { attributeValueId } }),
      ]);
      return { variants, products, categoryRules: 0 };
    },
  };
}

export type AttributesRepository = ReturnType<typeof createAttributesRepository>;
