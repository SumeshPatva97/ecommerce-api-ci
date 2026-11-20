/**
 * Promotion DTOs — API_DOCUMENTATION.md §4.9. Money as 2-dp strings, dates ISO UTC; `status` is
 * the effective status for `now` (`storedStatus` = persisted value).
 */
import { toMoneyString, toMoneyStringOrNull } from '../../lib/money.js';
import type { PromotionRow } from './promotions.repository.js';
import { effectiveStatus } from './promotions.rules.js';

export function targetIds(row: PromotionRow): string[] {
  switch (row.scope) {
    case 'PRODUCT':
      return row.products.map((t) => t.productId);
    case 'CATEGORY':
      return row.categories.map((t) => t.categoryId);
    case 'BRAND':
      return row.brands.map((t) => t.brandId);
    case 'COLLECTION':
      return row.collections.map((t) => t.collectionId);
  }
}

export function toPromotionDto(row: PromotionRow, now: Date) {
  return {
    id: row.id,
    name: row.name,
    label: row.name,
    scope: row.scope,
    targetIds: targetIds(row),
    includeDescendants:
      row.scope === 'CATEGORY' ? row.categories.every((c) => c.includeDescendants) : null,
    discountType: row.discountType,
    discountValue: toMoneyString(row.discountValue),
    maxDiscountAmount: toMoneyStringOrNull(row.maxDiscountAmount),
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
    status: effectiveStatus(row, now),
    storedStatus: row.status,
    priority: row.priority,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export type PromotionDto = ReturnType<typeof toPromotionDto>;

export function promotionAuditSnapshot(row: PromotionRow): Record<string, unknown> {
  const { products: _p, categories: _c, brands: _b, collections: _col, ...rest } = row;
  return { ...rest, targetIds: targetIds(row) };
}
