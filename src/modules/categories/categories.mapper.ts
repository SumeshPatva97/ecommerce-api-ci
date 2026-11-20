/**
 * Category rows → DTOs. Pure.
 */
import type { AttributeDisplayType } from '../../generated/prisma/enums.js';
import {
  toImage,
  toPublicImage,
  toSeo,
  toStatus,
  type ImageDto,
  type SeoDto,
} from '../catalog-common/catalog.mapper.js';
import type { MasterStatus } from '../catalog-common/catalog.schemas.js';
import type { CategoryRow, CategoryWithCounts } from './categories.repository.js';
import type { TreeNode } from './categories.tree.js';

export interface AdminCategoryDto {
  id: string;
  parentId: string | null;
  name: string;
  slug: string;
  depth: number;
  description: string | null;
  image: ImageDto | null;
  bannerImage: ImageDto | null;
  sortOrder: number;
  status: MasterStatus;
  showInMenu: boolean;
  seo: SeoDto;
  productCount?: number;
  childCount?: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export function toAdminCategory(row: CategoryRow | CategoryWithCounts): AdminCategoryDto {
  return {
    id: row.id,
    parentId: row.parentId,
    name: row.name,
    slug: row.slug,
    depth: row.depth,
    description: row.description,
    image: toImage(row.imageUrl, row.imagePublicId),
    bannerImage: toImage(row.bannerImageUrl, row.bannerImagePid),
    sortOrder: row.sortOrder,
    status: toStatus(row.isActive),
    showInMenu: row.showInMenu,
    seo: toSeo(row.seoTitle, row.seoDescription),
    ...('_count' in row
      ? { productCount: row._count.products, childCount: row._count.children }
      : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

/** Input for the tree builder (own product count from `_count`). */
export function toTreeInput(row: CategoryWithCounts): CategoryWithCounts & {
  ownProductCount: number;
} {
  return { ...row, ownProductCount: row._count.products };
}

export type AdminCategoryTreeDto = AdminCategoryDto & {
  productCount: number;
  children: AdminCategoryTreeDto[];
};

/** Admin tree node: `productCount` is the rolled-up count (own + descendants). */
export function toAdminTree(node: TreeNode<CategoryWithCounts>): AdminCategoryTreeDto {
  return {
    ...toAdminCategory(node),
    productCount: node.productCount,
    children: node.children.map(toAdminTree),
  };
}

export interface PublicCategoryNodeDto {
  id: string;
  name: string;
  slug: string;
  image: { url: string } | null;
  showInMenu: boolean;
  productCount: number;
  children: PublicCategoryNodeDto[];
}

export function toPublicTree(node: TreeNode<CategoryWithCounts>): PublicCategoryNodeDto {
  return {
    id: node.id,
    name: node.name,
    slug: node.slug,
    image: toPublicImage(node.imageUrl),
    showInMenu: node.showInMenu,
    productCount: node.productCount,
    children: node.children.map(toPublicTree),
  };
}

export interface PublicCategoryDetailDto {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  image: { url: string } | null;
  bannerImage: { url: string } | null;
  seo: SeoDto;
  productCount: number;
  breadcrumb: { id: string; name: string; slug: string }[];
  children: {
    id: string;
    name: string;
    slug: string;
    image: { url: string } | null;
    productCount: number;
  }[];
  sizeGuideBlockKey: string | null;
}

export function toPublicCategoryDetail(
  node: TreeNode<CategoryWithCounts>,
  breadcrumb: readonly CategoryRow[],
  sizeGuideBlockKey: string | null,
): PublicCategoryDetailDto {
  return {
    id: node.id,
    name: node.name,
    slug: node.slug,
    description: node.description,
    image: toPublicImage(node.imageUrl),
    bannerImage: toPublicImage(node.bannerImageUrl),
    seo: toSeo(node.seoTitle ?? node.name, node.seoDescription),
    productCount: node.productCount,
    breadcrumb: breadcrumb.map((c) => ({ id: c.id, name: c.name, slug: c.slug })),
    children: node.children.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      image: toPublicImage(c.imageUrl),
      productCount: c.productCount,
    })),
    sizeGuideBlockKey,
  };
}

export interface CategoryAttributeRuleDto {
  attributeId: string;
  attribute: {
    id: string;
    name: string;
    code: string;
    displayType: AttributeDisplayType;
    isVariantAxis: boolean;
    status: MasterStatus;
  };
  isRequired: boolean;
  isVariantAxisDefault: boolean;
  inheritToChildren: boolean;
  sortOrder: number;
  /** `null` = defined on this category; otherwise the ancestor the rule is inherited from. */
  inheritedFrom: { id: string; name: string } | null;
}
