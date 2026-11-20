/**
 * Recently viewed products — API_DOCUMENTATION.md §3.6. PROVISIONAL (OQ-33): local for guests,
 * server-side for customers, merged on login, keep the last 20 per customer.
 *
 * Only currently visible products are recorded and listed (listing-card DTOs, newest first).
 */
import { randomUUID } from 'node:crypto';

import type { AppContainer } from '../../container.js';
import { withTransaction } from '../../core/db/transaction.js';
import { AppError } from '../../core/errors/AppError.js';
import { mapCard, type ProductCardDto } from '../catalog/catalog.mapper.js';
import { deliveryFromConfig } from '../media/cloudinary.js';
import {
  createMeAddressesRepository,
  type MeAddressesRepository,
} from './me-addresses.repository.js';
import { RECENTLY_VIEWED_MAX, type MergeViewsInput } from './me-addresses.schemas.js';

export type RecentlyViewedDto = ProductCardDto & { viewedAt: string };

export interface RecentlyViewedService {
  list(userId: string, limit: number): Promise<RecentlyViewedDto[]>;
  record(userId: string, productId: string): Promise<{ recorded: true }>;
  merge(userId: string, input: MergeViewsInput): Promise<RecentlyViewedDto[]>;
}

export function createRecentlyViewedService(
  container: AppContainer,
  repo: MeAddressesRepository = createMeAddressesRepository(),
): RecentlyViewedService {
  const { db, clock } = container;
  const delivery = deliveryFromConfig(container.config.integrations.media);

  async function list(userId: string, limit: number): Promise<RecentlyViewedDto[]> {
    const now = clock();
    const rows = await repo.listRecent(db, userId, now, limit);
    return rows.map((r) => ({
      ...mapCard(r.product, delivery, now),
      viewedAt: r.viewedAt.toISOString(),
    }));
  }

  return {
    list,

    async record(userId, productId) {
      const now = clock();
      await withTransaction(db, async ({ tx }) => {
        const visible = await repo.visibleProductIds(tx, [productId], now);
        if (!visible.has(productId)) throw new AppError('NOT_FOUND', 'Product not found.');
        await repo.upsertView(tx, randomUUID(), userId, productId, now);
        await repo.trim(tx, userId, RECENTLY_VIEWED_MAX);
      });
      return { recorded: true as const };
    },

    async merge(userId, input) {
      const now = clock();
      // Union by product, newest guest view wins; future timestamps are clamped to now.
      const guest = new Map<string, Date>();
      for (const item of input.items) {
        const viewedAt = item.viewedAt.getTime() > now.getTime() ? now : item.viewedAt;
        const seen = guest.get(item.productId);
        if (seen === undefined || viewedAt.getTime() > seen.getTime()) {
          guest.set(item.productId, viewedAt);
        }
      }
      if (guest.size > 0) {
        await withTransaction(db, async ({ tx }) => {
          const visible = await repo.visibleProductIds(tx, [...guest.keys()], now);
          const ids = [...guest.keys()].filter((id) => visible.has(id));
          const existing = new Map(
            (await repo.existingViews(tx, userId, ids)).map((r) => [r.productId, r]),
          );
          for (const productId of ids) {
            const viewedAt = guest.get(productId) ?? now;
            const row = existing.get(productId);
            if (row === undefined) {
              await repo.createView(tx, {
                id: randomUUID(),
                userId,
                productId,
                viewedAt,
                viewCount: 1,
              });
            } else if (viewedAt.getTime() > row.viewedAt.getTime()) {
              await repo.setViewedAt(tx, row.id, viewedAt);
            }
          }
          await repo.trim(tx, userId, RECENTLY_VIEWED_MAX);
        });
      }
      return list(userId, RECENTLY_VIEWED_MAX);
    },
  };
}
