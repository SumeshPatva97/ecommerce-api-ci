/**
 * Collection row → DTO. Pure.
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
import type { CollectionRow, CollectionWithCount } from './collections.repository.js';

export interface AdminCollectionDto {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  heroImage: ImageDto | null;
  isFeatured: boolean;
  startsAt: string | null;
  endsAt: string | null;
  sortOrder: number;
  status: MasterStatus;
  seo: SeoDto;
  productCount?: number;
  productIds?: string[];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export function toAdminCollection(
  row: CollectionRow | CollectionWithCount,
  productIds?: string[],
): AdminCollectionDto {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    heroImage: toImage(row.bannerImageUrl, row.bannerImagePid),
    isFeatured: row.isFeatured,
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
    sortOrder: row.sortOrder,
    status: toStatus(row.isActive),
    seo: toSeo(row.seoTitle, row.seoDescription),
    ...('_count' in row ? { productCount: row._count.products } : {}),
    ...(productIds === undefined ? {} : { productIds }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

export interface PublicCollectionDto {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  heroImage: { url: string } | null;
  isFeatured: boolean;
  productCount: number;
}

export interface PublicCollectionDetailDto extends PublicCollectionDto {
  seo: SeoDto;
  startsAt: string | null;
  endsAt: string | null;
}

export function toPublicCollection(row: CollectionWithCount): PublicCollectionDto {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    heroImage: toPublicImage(row.bannerImageUrl),
    isFeatured: row.isFeatured,
    productCount: row._count.products,
  };
}

export function toPublicCollectionDetail(row: CollectionWithCount): PublicCollectionDetailDto {
  return {
    ...toPublicCollection(row),
    seo: toSeo(row.seoTitle ?? row.name, row.seoDescription),
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
  };
}
