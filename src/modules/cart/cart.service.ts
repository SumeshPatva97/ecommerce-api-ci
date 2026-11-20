/**
 * Cart use-cases — API_DOCUMENTATION.md §3.4, PROJECT_CONTEXT §15 R-03/R-04.
 *
 * - One ACTIVE cart per customer, created lazily; always scoped to the authenticated user.
 *   RD-08 option B: when the customer has no ACTIVE cart, their newest ABANDONED cart is
 *   reactivated (items kept) before a new one is created. Stale lines and coupons are then
 *   re-checked by the normal view below, like any other cart.
 * - Every response is re-priced server-side (pricing engine + loader) — client prices are never
 *   trusted. Lines are re-checked on read: unavailable lines are flagged (not removed), a quantity
 *   above what can be bought now is reduced (`QUANTITY_REDUCED`), and a coupon that no longer
 *   applies is detached with a `COUPON_REMOVED` warning (`causeCode` = reason, no `reason` key R-05).
 * - The indicative tax (`estimatedTaxIncluded`) uses the tax module's rate resolution; lines without
 *   a resolvable rate are left out of the estimate (`TAX_ESTIMATE_PARTIAL` warning). Final tax and
 *   shipping are computed by checkout.
 * - PROVISIONAL (OQ-17): no stock reservation before order placement.
 * - PROVISIONAL (OQ-14): one coupon per cart; applying a new code replaces the previous one.
 */
import { randomUUID } from 'node:crypto';

import type { AppContainer } from '../../container.js';
import { withTransaction, type Queryable } from '../../core/db/transaction.js';
import { AppError } from '../../core/errors/AppError.js';
import { isPrismaKnownError } from '../../core/errors/prismaErrorMapper.js';
import { ZERO, roundMoney, sum, type Decimal } from '../../lib/money.js';
import { priceCart, type AppliedCoupon, type PricingResult } from '../../lib/pricing/index.js';
import { couponInvalidError } from '../coupons/coupons.errors.js';
import { deliveryFromConfig } from '../media/cloudinary.js';
import {
  createPricingInputLoader,
  type CouponRef,
  type PricingInputLoader,
} from '../promotions/pricing.loader.js';
import { loadTaxSettings, resolveRates } from '../tax/index.js';
import { toCartDto, type CartDto, type TaxEstimate } from './cart.mapper.js';
import {
  createCartRepository,
  type CartItemRow,
  type CartRepository,
  type CartRow,
  type VariantCheckRow,
} from './cart.repository.js';
import {
  ABANDON_AFTER_DAYS_SETTING_KEY,
  DEFAULT_ABANDON_AFTER_DAYS,
  DEFAULT_MAX_QTY_PER_LINE,
  MAX_ABANDON_AFTER_DAYS,
  MAX_QTY_SETTING_KEY,
  availableQuantity,
  evaluateLine,
  insufficientStockError,
  isVariantSellable,
  itemLabel,
  lineLimitError,
  maxQtyError,
  mergedQuantity,
  type CartWarning,
  type LineState,
} from './cart.rules.js';
import {
  HARD_MAX_QTY,
  MAX_CART_LINES,
  type AddCartItemInput,
  type MergeCartInput,
} from './cart.schemas.js';

export interface CartService {
  get(userId: string): Promise<CartDto>;
  addItem(userId: string, input: AddCartItemInput): Promise<CartDto>;
  updateItem(userId: string, itemId: string, quantity: number): Promise<CartDto>;
  removeItem(userId: string, itemId: string): Promise<CartDto>;
  merge(userId: string, input: MergeCartInput): Promise<CartDto>;
  applyCoupon(userId: string, codeNormalized: string): Promise<CartDto>;
  removeCoupon(userId: string): Promise<CartDto>;
}

export interface CartServiceDeps {
  readonly repo?: CartRepository;
  readonly loader?: PricingInputLoader;
}

/** M1: resolve + claim attempts before answering 409 CONFLICT (retryable). */
const CART_CLAIM_ATTEMPTS = 2;

/** Prisma P2002 (unique constraint) — e.g. `uq_carts_active_owner` when a second ACTIVE cart appears. */
function isUniqueViolation(error: unknown): boolean {
  return isPrismaKnownError(error) && error.code === 'P2002';
}

/** PROVISIONAL (OQ-57): `checkout.max_qty_per_line`, default 5 (bounded 1–99). */
export async function loadMaxQtyPerLine(db: Queryable): Promise<number> {
  const row = await db.setting.findUnique({
    where: { settingKey: MAX_QTY_SETTING_KEY },
    select: { value: true },
  });
  const value = row?.value;
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= HARD_MAX_QTY
    ? value
    : DEFAULT_MAX_QTY_PER_LINE;
}

/** RD-08: `cart.abandon_after_days`, default 30 (bounded 1–365; an invalid value falls back). */
export async function loadAbandonAfterDays(db: Queryable): Promise<number> {
  const row = await db.setting.findUnique({
    where: { settingKey: ABANDON_AFTER_DAYS_SETTING_KEY },
    select: { value: true },
  });
  const value = row?.value;
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_ABANDON_AFTER_DAYS
    ? value
    : DEFAULT_ABANDON_AFTER_DAYS;
}

interface EvaluatedLine {
  readonly row: CartItemRow;
  readonly state: LineState;
}

export function createCartService(
  container: AppContainer,
  deps: CartServiceDeps = {},
): CartService {
  const { db, clock } = container;
  const repo = deps.repo ?? createCartRepository();
  const loader = deps.loader ?? createPricingInputLoader();
  const delivery = deliveryFromConfig(container.config.integrations.media);

  /*
   * Active-cart resolution (RD-08 option B, approved 2026-11-20):
   *   1. the customer's ACTIVE cart;
   *   2. otherwise their newest ABANDONED cart, reactivated with its items;
   *   3. otherwise a new empty cart.
   * "One ACTIVE cart per customer" is enforced by MySQL (`uq_carts_active_owner` on the generated
   * `active_owner_key`), never by this code.
   *
   * Lost-race recovery (lost compare-and-set, or P2002 on reactivate/create → re-read the winner)
   * is only reliable OUTSIDE a transaction: each autocommit statement sees the latest committed
   * rows. Inside a MySQL REPEATABLE READ transaction an ordinary re-read uses the transaction's
   * snapshot and may not see the winner (audit finding M1). Therefore:
   * - `loadCart` / `removeCoupon` resolve with autocommit statements (no transaction);
   * - `addItem` / `merge` use `withActiveCart`: resolve OUTSIDE the transaction, then claim the
   *   resolved cart as the transaction's first statement with an UPDATE (a current read that locks
   *   the row and checks it is still this customer's ACTIVE cart). If it is not, the transaction is
   *   rolled back and resolution runs once more; a second failure returns 409 CONFLICT (retryable),
   *   with nothing written.
   */

  /** Reactivates the newest ABANDONED cart; false when the customer has none. */
  async function reactivateNewestAbandoned(q: Queryable, userId: string): Promise<boolean> {
    const abandoned = await repo.findNewestAbandonedCartRef(q, userId);
    if (abandoned === null) return false;
    try {
      // false = a concurrent request reactivated it (or the purge removed it): re-read below.
      await repo.reactivateCart(q, abandoned.id, clock());
    } catch (error) {
      if (!isUniqueViolation(error)) throw error; // an ACTIVE cart appeared concurrently
    }
    return true;
  }

  /** Runs `create`; on a unique violation (concurrent first visit) returns the winner instead. */
  async function createOrReuse<T>(
    create: () => Promise<T>,
    reread: () => Promise<T | null>,
  ): Promise<T> {
    try {
      return await create();
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const winner = await reread();
      if (winner === null) throw error;
      return winner;
    }
  }

  async function ensureCartId(q: Queryable, userId: string): Promise<string> {
    const ref = await repo.findActiveCartRef(q, userId);
    if (ref !== null) return ref.id;
    if (await reactivateNewestAbandoned(q, userId)) {
      const active = await repo.findActiveCartRef(q, userId);
      if (active !== null) return active.id;
    }
    return createOrReuse(
      async () => (await repo.createCart(q, randomUUID(), userId, clock())).id,
      async () => (await repo.findActiveCartRef(q, userId))?.id ?? null,
    );
  }

  /**
   * M1: runs `work` in a transaction on the customer's ACTIVE cart. The cart is resolved first with
   * autocommit statements (reliable lost-race recovery), then claimed inside the transaction by
   * `claimActiveCart` — an UPDATE, i.e. a MySQL current read + row lock, so the claim sees the
   * latest committed state and the cart cannot be converted / abandoned until commit. The claim
   * also records the activity (`last_activity_at`).
   *
   * Note: a cart created or reactivated during resolution stays committed even if `work` fails
   * (the same cart a `GET /cart` would have produced).
   */
  async function withActiveCart(
    userId: string,
    now: Date,
    work: (tx: Queryable, cartId: string) => Promise<void>,
  ): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      const cartId = await ensureCartId(db, userId);
      const claimed = await withTransaction(db, async ({ tx }) => {
        // false → nothing has been written in this transaction.
        if (!(await repo.claimActiveCart(tx, cartId, userId, now))) return false;
        await work(tx, cartId);
        return true;
      });
      if (claimed) return;
      if (attempt >= CART_CLAIM_ATTEMPTS) {
        throw new AppError('CONFLICT', 'Your cart changed while saving. Please try again.');
      }
    }
  }

  async function loadCart(userId: string): Promise<CartRow> {
    const cart = await repo.findActiveCart(db, userId);
    if (cart !== null) return cart;
    if (await reactivateNewestAbandoned(db, userId)) {
      const active = await repo.findActiveCart(db, userId);
      if (active !== null) return active;
    }
    return createOrReuse(
      () => repo.createCart(db, randomUUID(), userId, clock()),
      () => repo.findActiveCart(db, userId),
    );
  }

  async function price(
    userId: string,
    lines: readonly EvaluatedLine[],
    coupon: CouponRef,
    now: Date,
  ): Promise<{ result: PricingResult; couponMissing: boolean }> {
    const input = await loader.load(db, {
      items: lines
        .filter((l) => l.state.purchasable)
        .map((l) => ({
          lineId: l.row.id,
          variantId: l.row.variantId,
          productId: l.row.variant.product.id,
          quantity: l.state.quantity,
          mrp: l.row.variant.mrp,
          sellingPrice: l.row.variant.sellingPrice,
        })),
      userId,
      coupon,
      now,
    });
    return { result: priceCart(input), couponMissing: input.couponMissing };
  }

  async function estimateTax(
    result: PricingResult,
    now: Date,
    warnings: CartWarning[],
  ): Promise<TaxEstimate> {
    const settings = await loadTaxSettings(db);
    if (result.lines.length === 0)
      return { amount: ZERO, pricesIncludeTax: settings.pricesIncludeTax };
    const rates = await resolveRates(
      db,
      result.lines.map((l) => l.productId),
      now,
    );
    const unresolved = new Set<string>();
    const amounts: Decimal[] = [];
    for (const line of result.lines) {
      const rate = rates.get(line.productId);
      if (rate?.ok !== true) {
        unresolved.add(line.productId);
        continue;
      }
      const r = rate.ratePercent.dividedBy(100);
      amounts.push(
        settings.pricesIncludeTax
          ? line.netLineValue.minus(roundMoney(line.netLineValue.dividedBy(r.plus(1))))
          : roundMoney(line.netLineValue.times(r)),
      );
    }
    if (unresolved.size > 0) {
      warnings.push({ code: 'TAX_ESTIMATE_PARTIAL', meta: { productIds: [...unresolved] } });
    }
    return { amount: sum(amounts), pricesIncludeTax: settings.pricesIncludeTax };
  }

  /** Re-evaluates, re-prices and maps the user's cart (fixing stale quantities / coupon). */
  async function view(
    userId: string,
    extraWarnings: readonly CartWarning[] = [],
  ): Promise<CartDto> {
    const now = clock();
    const maxQty = await loadMaxQtyPerLine(db);
    const cart = await loadCart(userId);
    const warnings: CartWarning[] = [...extraWarnings];
    const lines: EvaluatedLine[] = cart.items.map((row) => ({
      row,
      state: evaluateLine(row, now, maxQty),
    }));

    const reduced = lines.filter((l) => l.state.quantity !== l.row.quantity);
    if (reduced.length > 0) {
      await withTransaction(db, async ({ tx }) => {
        for (const l of reduced)
          await repo.updateItem(tx, l.row.id, { quantity: l.state.quantity });
      });
    }

    const { result, couponMissing } = await price(
      userId,
      lines,
      cart.couponId === null ? null : { id: cart.couponId },
      now,
    );
    let coupon: AppliedCoupon | null = null;
    if (cart.couponId !== null) {
      const outcome = result.coupon;
      if (outcome?.status === 'APPLIED') coupon = outcome;
      else {
        const causeCode =
          couponMissing || outcome === null ? 'COUPON_NOT_FOUND' : outcome.failure.reason;
        await repo.updateCart(db, cart.id, { couponId: null, couponCode: null });
        warnings.push({
          code: 'COUPON_REMOVED',
          meta: { couponCode: cart.couponCode, causeCode },
        });
      }
    }
    const tax = await estimateTax(result, now, warnings);
    return toCartDto(
      {
        cartId: cart.id,
        items: lines,
        priced: new Map(result.lines.map((l) => [l.lineId, l])),
        totals: result.totals,
        coupon,
        tax,
        warnings,
        maxQtyPerLine: maxQty,
      },
      delivery,
    );
  }

  function assertSellable(variant: VariantCheckRow | null, now: Date): VariantCheckRow {
    if (variant === null || !isVariantSellable(variant, now)) {
      throw new AppError('NOT_FOUND', 'This item is not available.');
    }
    return variant;
  }

  function checkQuantity(variant: VariantCheckRow, total: number, inCart: number, maxQty: number) {
    if (total > maxQty) throw maxQtyError(maxQty, inCart);
    const available = availableQuantity(variant.inventory);
    if (total > available) {
      throw insufficientStockError({
        variantId: variant.id,
        sku: variant.sku,
        label: itemLabel(variant.product.name, variant.name),
        requested: total - inCart,
        inCart,
        available,
      });
    }
  }

  return {
    get: (userId) => view(userId),

    async addItem(userId, input) {
      const now = clock();
      const maxQty = await loadMaxQtyPerLine(db);
      await withActiveCart(userId, now, async (tx, cartId) => {
        const variant = assertSellable(await repo.findVariant(tx, input.variantId), now);
        const existing = await repo.findItemByVariant(tx, cartId, variant.id);
        if (existing === null && (await repo.countItems(tx, cartId)) >= MAX_CART_LINES) {
          throw lineLimitError(MAX_CART_LINES);
        }
        const inCart = existing?.quantity ?? 0;
        checkQuantity(variant, inCart + input.quantity, inCart, maxQty);
        if (existing === null) {
          await repo.createItem(tx, {
            id: randomUUID(),
            cartId,
            variantId: variant.id,
            quantity: input.quantity,
            unitPriceAtAdd: variant.sellingPrice,
          });
        } else {
          await repo.updateItem(tx, existing.id, { quantity: inCart + input.quantity });
        }
        // last_activity_at was set by the claim (withActiveCart).
      });
      return view(userId);
    },

    async updateItem(userId, itemId, quantity) {
      const now = clock();
      const maxQty = await loadMaxQtyPerLine(db);
      await withTransaction(db, async ({ tx }) => {
        const item = await repo.findOwnedItem(tx, userId, itemId);
        if (item === null) throw new AppError('NOT_FOUND', 'Cart item not found.');
        const variant = await repo.findVariant(tx, item.variantId);
        if (variant === null || !isVariantSellable(variant, now)) {
          throw insufficientStockError({
            variantId: item.variantId,
            sku: variant?.sku ?? '',
            label: variant === null ? 'This item' : itemLabel(variant.product.name, variant.name),
            requested: quantity,
            inCart: 0,
            available: 0,
          });
        }
        checkQuantity(variant, quantity, 0, maxQty);
        await repo.updateItem(tx, item.id, { quantity });
        await repo.updateCart(tx, item.cartId, { lastActivityAt: now });
      });
      return view(userId);
    },

    async removeItem(userId, itemId) {
      await withTransaction(db, async ({ tx }) => {
        const item = await repo.findOwnedItem(tx, userId, itemId);
        if (item === null) throw new AppError('NOT_FOUND', 'Cart item not found.');
        await repo.deleteItem(tx, item.id);
        await repo.updateCart(tx, item.cartId, { lastActivityAt: clock() });
      });
      return view(userId);
    },

    async merge(userId, input) {
      const now = clock();
      const maxQty = await loadMaxQtyPerLine(db);
      const guest = new Map<string, number>();
      for (const item of input.items) {
        guest.set(item.variantId, Math.max(guest.get(item.variantId) ?? 0, item.quantity));
      }
      const warnings: CartWarning[] = [];
      await withActiveCart(userId, now, async (tx, cartId) => {
        warnings.length = 0; // a retried attempt recomputes its warnings
        const variants = new Map(
          (await repo.findVariants(tx, [...guest.keys()])).map((v) => [v.id, v]),
        );
        const existing = new Map((await repo.listItems(tx, cartId)).map((i) => [i.variantId, i]));
        let lineCount = existing.size;
        for (const [variantId, guestQty] of guest) {
          const variant = variants.get(variantId);
          if (variant === undefined || !isVariantSellable(variant, now)) {
            warnings.push({
              code: 'ITEM_SKIPPED',
              meta: { variantId, causeCode: 'VARIANT_UNAVAILABLE' },
            });
            continue;
          }
          const server = existing.get(variantId);
          const { wanted, applied } = mergedQuantity(
            server?.quantity ?? 0,
            guestQty,
            maxQty,
            availableQuantity(variant.inventory),
          );
          if (applied <= 0) {
            warnings.push({ code: 'ITEM_SKIPPED', meta: { variantId, causeCode: 'OUT_OF_STOCK' } });
            continue;
          }
          if (server === undefined && lineCount >= MAX_CART_LINES) {
            warnings.push({
              code: 'ITEM_SKIPPED',
              meta: { variantId, causeCode: 'CART_LINE_LIMIT' },
            });
            continue;
          }
          if (applied < wanted) {
            warnings.push({
              code: 'QUANTITY_REDUCED',
              meta: { variantId, requested: wanted, applied },
            });
          }
          if (server === undefined) {
            await repo.createItem(tx, {
              id: randomUUID(),
              cartId,
              variantId,
              quantity: applied,
              unitPriceAtAdd: variant.sellingPrice,
            });
            lineCount += 1;
          } else if (server.quantity !== applied) {
            await repo.updateItem(tx, server.id, { quantity: applied });
          }
        }
        // last_activity_at was set by the claim (withActiveCart).
      });
      return view(userId, warnings);
    },

    async applyCoupon(userId, codeNormalized) {
      const now = clock();
      const maxQty = await loadMaxQtyPerLine(db);
      const coupon = await loader.loadCoupon(db, { codeNormalized });
      if (coupon === null) throw couponInvalidError({ reason: 'COUPON_NOT_FOUND' });
      const cart = await loadCart(userId);
      const lines = cart.items.map((row) => ({ row, state: evaluateLine(row, now, maxQty) }));
      const { result } = await price(userId, lines, { id: coupon.id }, now);
      const outcome = result.coupon;
      if (outcome?.status !== 'APPLIED') {
        throw couponInvalidError(
          outcome === null ? { reason: 'COUPON_NOT_FOUND' } : outcome.failure,
        );
      }
      await repo.updateCart(db, cart.id, {
        couponId: coupon.id,
        couponCode: coupon.code,
        lastActivityAt: now,
      });
      return view(userId);
    },

    async removeCoupon(userId) {
      const cartId = await ensureCartId(db, userId);
      await repo.updateCart(db, cartId, { couponId: null, couponCode: null });
      return view(userId);
    },
  };
}
