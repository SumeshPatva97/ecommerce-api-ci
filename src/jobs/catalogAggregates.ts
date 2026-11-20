/**
 * Catalogue aggregate refresh jobs — BACKEND_STRUCTURE.md §14:
 *
 * - `best-seller-refresh` (nightly): `products.total_sold` = units sold in the last
 *   `catalog.best_seller_window_days` days (WP10-5; valid 1–730, default 90 when the setting is
 *   missing or invalid), used by sort `best_selling`. PROVISIONAL (OQ-50 working assumption "top units sold in last 90 days").
 *   Units = `quantity − quantity_cancelled` of order lines whose order was confirmed in the window
 *   and is not PENDING_PAYMENT / PAYMENT_FAILED / CANCELLED. Returns are NOT subtracted (no rule).
 *   The OQ-50 admin "pin" already exists (`products.is_best_seller_pinned`) and is applied by the
 *   catalogue sort (`catalog.service.ts`, pinned first, then `total_sold`); this job does not touch it.
 * - `rating-aggregate` (nightly safety net; the reviews module already recomputes on every
 *   moderation): `products.avg_rating` / `review_count` from APPROVED, non-deleted reviews. A product
 *   whose stored value differs is recomputed with `recomputeProductRating` inside a transaction that
 *   first locks the product row (D5, concurrency with moderation).
 *
 * Both are deterministic full recomputes that write ONLY products whose value differs, so re-running
 * is a no-op. Note: Prisma bumps `products.updated_at` on each write.
 *
 * Per-item isolation (WP10-2): a failing product write is logged with the product id and counted in
 * the summary's `errors`; the run continues with the next product (the next run retries it).
 * Summary: `{ products, updated, errors }` — products examined, products written, failed writes.
 */
import type { AppContainer } from '../container.js';
import { withTransaction, type Queryable } from '../core/db/transaction.js';
import { dec, roundMoney } from '../lib/money.js';
import { recomputeProductRating } from '../modules/reviews/index.js';

/** Default window when `catalog.best_seller_window_days` is missing or invalid. */
export const BEST_SELLER_WINDOW_DAYS = 90;
export const BEST_SELLER_WINDOW_SETTING_KEY = 'catalog.best_seller_window_days';
/** Same bounds as the settings validation rule (`settings.values.ts`: int 1–730). */
const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 730;
const NOT_SOLD = ['PENDING_PAYMENT', 'PAYMENT_FAILED', 'CANCELLED'] as const;

export interface AggregateRefreshSummary {
  readonly products: number;
  readonly updated: number;
  readonly errors: number;
}

/** WP10-5: the configured best-seller window, or 90 when the setting is missing or invalid. */
export async function loadBestSellerWindowDays(db: Queryable): Promise<number> {
  const row = await db.setting.findUnique({
    where: { settingKey: BEST_SELLER_WINDOW_SETTING_KEY },
    select: { value: true },
  });
  const value = row?.value;
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_WINDOW_DAYS &&
    value <= MAX_WINDOW_DAYS
    ? value
    : BEST_SELLER_WINDOW_DAYS;
}

export async function runBestSellerRefresh(
  container: AppContainer,
): Promise<AggregateRefreshSummary> {
  const { db, clock, logger } = container;
  const now = clock();
  const windowDays = await loadBestSellerWindowDays(db);
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60_000);
  const lines = await db.orderItem.groupBy({
    by: ['productId'],
    where: {
      order: { confirmedAt: { gte: since, lt: now }, status: { notIn: [...NOT_SOLD] } },
    },
    _sum: { quantity: true, quantityCancelled: true },
  });
  const sold = new Map(
    lines.map((l) => [
      l.productId,
      Math.max(0, (l._sum.quantity ?? 0) - (l._sum.quantityCancelled ?? 0)),
    ]),
  );
  const current = await db.product.findMany({
    where: { OR: [{ totalSold: { gt: 0 } }, { id: { in: [...sold.keys()] } }] },
    select: { id: true, totalSold: true },
  });
  let updated = 0;
  let errors = 0;
  for (const product of current) {
    const value = sold.get(product.id) ?? 0;
    if (value === product.totalSold) continue;
    try {
      await db.product.update({
        where: { id: product.id },
        data: { totalSold: value },
        select: { id: true },
      });
      updated += 1;
    } catch (error: unknown) {
      errors += 1;
      logger.error(
        { err: error, productId: product.id, job: 'best-seller-refresh' },
        'best-seller refresh failed for product',
      );
    }
  }
  return { products: current.length, updated, errors };
}

export async function runRatingAggregate(
  container: AppContainer,
): Promise<AggregateRefreshSummary> {
  const { db, logger } = container;
  const groups = await db.review.groupBy({
    by: ['productId'],
    where: { status: 'APPROVED', deletedAt: null },
    _avg: { rating: true },
    _count: { _all: true },
  });
  const target = new Map(
    groups.map((g) => [
      g.productId,
      { avg: roundMoney(dec(g._avg.rating ?? 0)), count: g._count._all },
    ]),
  );
  const current = await db.product.findMany({
    where: { OR: [{ reviewCount: { gt: 0 } }, { id: { in: [...target.keys()] } }] },
    select: { id: true, avgRating: true, reviewCount: true },
  });
  let updated = 0;
  let errors = 0;
  for (const product of current) {
    const want = target.get(product.id) ?? { avg: roundMoney(0), count: 0 };
    if (want.count === product.reviewCount && want.avg.equals(dec(product.avgRating))) continue;
    // D5: the snapshot above may be stale by now. Re-derive and write inside one transaction that
    // FIRST locks the product row: the aggregate then sees every moderation committed before the
    // lock, and a moderation still in flight waits for the lock and writes its own (newer) result
    // afterwards — the job can no longer overwrite a newer value with an older one.
    try {
      await withTransaction(db, async ({ tx }) => {
        await tx.$queryRaw`SELECT id FROM products WHERE id = ${product.id} FOR UPDATE`;
        await recomputeProductRating(tx, product.id);
      });
      updated += 1;
    } catch (error: unknown) {
      errors += 1;
      logger.error(
        { err: error, productId: product.id, job: 'rating-aggregate' },
        'rating aggregate failed for product',
      );
    }
  }
  return { products: current.length, updated, errors };
}
