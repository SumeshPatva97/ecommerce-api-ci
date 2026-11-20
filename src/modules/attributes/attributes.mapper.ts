/**
 * Attribute / attribute-value rows → DTOs. Pure.
 */
import type { AttributeDisplayType } from '../../generated/prisma/enums.js';
import { toStatus } from '../catalog-common/catalog.mapper.js';
import type { MasterStatus } from '../catalog-common/catalog.schemas.js';
import type {
  AttributeRow,
  AttributeValueRow,
  AttributeWithCount,
} from './attributes.repository.js';

export interface AdminAttributeDto {
  id: string;
  name: string;
  code: string;
  displayType: AttributeDisplayType;
  isVariantAxis: boolean;
  isFilterable: boolean;
  isVisibleOnPdp: boolean;
  unit: string | null;
  sortOrder: number;
  status: MasterStatus;
  valueCount?: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export function toAdminAttribute(row: AttributeRow | AttributeWithCount): AdminAttributeDto {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    displayType: row.displayType,
    isVariantAxis: row.isVariantAxis,
    isFilterable: row.isFilterable,
    isVisibleOnPdp: row.isVisibleOnPdp,
    unit: row.unit,
    sortOrder: row.sortOrder,
    status: toStatus(row.isActive),
    ...('_count' in row ? { valueCount: row._count.values } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

export interface AdminAttributeValueDto {
  id: string;
  attributeId: string;
  value: string;
  slug: string;
  hexColor: string | null;
  swatchImageUrl: string | null;
  sortOrder: number;
  status: MasterStatus;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export function toAdminAttributeValue(row: AttributeValueRow): AdminAttributeValueDto {
  return {
    id: row.id,
    attributeId: row.attributeId,
    value: row.value,
    slug: row.slug,
    hexColor: row.swatchHex,
    swatchImageUrl: row.swatchImageUrl,
    sortOrder: row.sortOrder,
    status: toStatus(row.isActive),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}
