/**
 * Brand row → DTO. Pure.
 */
import {
  toImage,
  toPublicImage,
  toSeo,
  toStatus,
  type ImageDto,
  type SeoDto,
} from '../catalog-common/catalog.mapper.js';
import type { MasterStatus } from '../catalog-common/catalog.schemas.js';
import type { BrandRow, BrandWithCount } from './brands.repository.js';

export interface AdminBrandDto {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  logo: ImageDto | null;
  isFeatured: boolean;
  sortOrder: number;
  status: MasterStatus;
  seo: SeoDto;
  productCount?: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export function toAdminBrand(row: BrandRow | BrandWithCount): AdminBrandDto {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    logo: toImage(row.logoUrl, row.logoPublicId),
    isFeatured: row.isFeatured,
    sortOrder: row.sortOrder,
    status: toStatus(row.isActive),
    seo: toSeo(row.seoTitle, row.seoDescription),
    ...('_count' in row ? { productCount: row._count.products } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

export interface PublicBrandDto {
  id: string;
  name: string;
  slug: string;
  logo: { url: string } | null;
  productCount: number;
}

export function toPublicBrand(row: BrandWithCount): PublicBrandDto {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    logo: toPublicImage(row.logoUrl),
    productCount: row._count.products,
  };
}
