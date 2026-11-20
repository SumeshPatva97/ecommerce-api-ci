/**
 * Row factories for catalog-master tests (MOCKED DB — rows are plain objects shaped like Prisma
 * models; no SQL is executed).
 */
import { randomUUID } from 'node:crypto';

import type {
  Attribute,
  AttributeValue,
  Brand,
  Category,
  Collection,
} from '../../../../src/generated/prisma/client.js';

const T = new Date('2026-11-01T00:00:00.000Z');

export const ids = (): string => randomUUID();

export function brandRow(over: Partial<Brand> = {}): Brand {
  return {
    id: ids(),
    name: 'Aura Atelier',
    nameNormalized: 'aura atelier',
    slug: 'aura-atelier',
    description: null,
    logoUrl: null,
    logoPublicId: null,
    isActive: true,
    isFeatured: false,
    sortOrder: 0,
    seoTitle: null,
    seoDescription: null,
    createdAt: T,
    updatedAt: T,
    deletedAt: null,
    ...over,
  };
}

export function collectionRow(over: Partial<Collection> = {}): Collection {
  return {
    id: ids(),
    name: 'Bridal Edit',
    nameNormalized: 'bridal edit',
    slug: 'bridal-edit',
    description: null,
    bannerImageUrl: null,
    bannerImagePid: null,
    isActive: true,
    isFeatured: false,
    startsAt: null,
    endsAt: null,
    sortOrder: 0,
    seoTitle: null,
    seoDescription: null,
    createdAt: T,
    updatedAt: T,
    deletedAt: null,
    ...over,
  };
}

export function categoryRow(over: Partial<Category> = {}): Category {
  const id = over.id ?? ids();
  return {
    id,
    parentId: null,
    name: 'Earrings',
    nameNormalized: 'earrings',
    slug: 'earrings',
    path: `/${id}/`,
    depth: 1,
    description: null,
    imageUrl: null,
    imagePublicId: null,
    bannerImageUrl: null,
    bannerImagePid: null,
    sortOrder: 0,
    isActive: true,
    showInMenu: true,
    seoTitle: null,
    seoDescription: null,
    createdAt: T,
    updatedAt: T,
    deletedAt: null,
    createdById: null,
    updatedById: null,
    deletedById: null,
    ...over,
  };
}

/** Child row whose path/depth derive from the parent. */
export function childOf(parent: Category, over: Partial<Category> = {}): Category {
  const id = over.id ?? ids();
  return categoryRow({
    parentId: parent.id,
    path: `${parent.path}${id}/`,
    depth: parent.depth + 1,
    ...over,
    id,
  });
}

export function attributeRow(over: Partial<Attribute> = {}): Attribute {
  return {
    id: ids(),
    name: 'Metal Finish',
    nameNormalized: 'metal finish',
    code: 'metal_finish',
    displayType: 'SWATCH',
    isVariantAxis: true,
    isFilterable: true,
    isVisibleOnPdp: true,
    unit: null,
    sortOrder: 0,
    isActive: true,
    createdAt: T,
    updatedAt: T,
    deletedAt: null,
    ...over,
  };
}

export function valueRow(over: Partial<AttributeValue> = {}): AttributeValue {
  return {
    id: ids(),
    attributeId: ids(),
    value: 'Rose Gold',
    valueNormalized: 'rose gold',
    slug: 'rose-gold',
    swatchHex: '#B76E79',
    swatchImageUrl: null,
    sortOrder: 0,
    isActive: true,
    createdAt: T,
    updatedAt: T,
    deletedAt: null,
    ...over,
  };
}

export function p2002(target: string[]): Error {
  return Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
    clientVersion: '7.10.1',
    meta: { target },
  });
}
