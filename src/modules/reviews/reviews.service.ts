/**
 * Reviews — API_DOCUMENTATION.md §3.3, §3.7, §4.13; USER_WORKFLOWS.md §22.
 * PROVISIONAL (OQ-31): pre-moderation, verified purchasers only, text + rating only (D-21).
 *
 * - Verified purchaser = an order item of this product, owned by the customer, whose order is
 *   `DELIVERED` (403 FORBIDDEN `NOT_VERIFIED_PURCHASER` otherwise). A supplied `orderItemId` must
 *   satisfy the same rule.
 * - One review per customer per product (409 DUPLICATE_RESOURCE; DB unique index is final guard).
 * - New reviews are `PENDING` (setting `reviews.moderation_mode = POST` publishes immediately).
 * - Approve / reject / delete recompute `products.avg_rating` and `products.review_count` from
 *   APPROVED, non-deleted reviews in the same transaction. Moderation is audited.
 * - Schema note: there is no column for a rejection reason; it is kept in the audit row only and
 *   `GET /me/reviews` returns `rejectionReason: null`.
 */
import { randomUUID } from 'node:crypto';

import type { AppContainer } from '../../container.js';
import { withTransaction, type Queryable, type TxClient } from '../../core/db/transaction.js';
import { AppError } from '../../core/errors/AppError.js';
import { isPrismaKnownError } from '../../core/errors/prismaErrorMapper.js';
import { buildPageMeta, toSkipTake, type PageMeta } from '../../core/http/pagination.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { ReviewStatus } from '../../generated/prisma/enums.js';
import { dec, roundMoney } from '../../lib/money.js';
import { istDayRange } from '../../lib/time.js';
import type { AuditActor } from '../audit/audit.service.js';
import type {
  AdminReviewsQueryInput,
  CreateReviewInput,
  MyReviewsQueryInput,
  PublicReviewsQueryInput,
  RejectReviewInput,
} from './reviews.schemas.js';
import { toPlainText } from './reviews.text.js';

const MODULE = 'reviews';
const ENTITY = 'Review';

export function authorName(firstName: string, lastName: string | null): string {
  const initial = lastName?.trim().charAt(0).toUpperCase();
  return initial === undefined || initial === '' ? firstName : `${firstName} ${initial}.`;
}

/** Recomputes the product's rating aggregates from APPROVED, non-deleted reviews. */
export async function recomputeProductRating(
  tx: Queryable,
  productId: string,
): Promise<{ avgRating: string; reviewCount: number }> {
  const agg = await tx.review.aggregate({
    where: { productId, status: 'APPROVED', deletedAt: null },
    _avg: { rating: true },
    _count: { _all: true },
  });
  const avg = roundMoney(dec(agg._avg.rating ?? 0));
  const reviewCount = agg._count._all;
  await tx.product.update({ where: { id: productId }, data: { avgRating: avg, reviewCount } });
  return { avgRating: avg.toFixed(2), reviewCount };
}

const ADMIN_INCLUDE = {
  product: { select: { id: true, name: true, slug: true } },
  user: { select: { id: true, firstName: true, lastName: true, email: true } },
  orderItem: { select: { variantName: true, order: { select: { orderNumber: true } } } },
} satisfies Prisma.ReviewInclude;
type AdminReviewRow = Prisma.ReviewGetPayload<{ include: typeof ADMIN_INCLUDE }>;

export interface AdminReviewDto {
  readonly id: string;
  readonly product: { readonly id: string; readonly name: string; readonly slug: string };
  readonly customer: { readonly id: string; readonly name: string; readonly email: string };
  readonly orderNumber: string;
  readonly variantName: string | null;
  readonly rating: number;
  readonly title: string | null;
  readonly body: string | null;
  readonly status: ReviewStatus;
  readonly isVerifiedPurchase: true;
  readonly moderatedAt: string | null;
  readonly moderatedById: string | null;
  readonly createdAt: string;
}

function toAdminDto(row: AdminReviewRow): AdminReviewDto {
  return {
    id: row.id,
    product: row.product,
    customer: {
      id: row.user.id,
      name: [row.user.firstName, row.user.lastName].filter(Boolean).join(' '),
      email: row.user.email,
    },
    orderNumber: row.orderItem.order.orderNumber,
    variantName: row.orderItem.variantName,
    rating: row.rating,
    title: row.title,
    body: row.body,
    status: row.status,
    isVerifiedPurchase: true,
    moderatedAt: row.moderatedAt?.toISOString() ?? null,
    moderatedById: row.moderatedById,
    createdAt: row.createdAt.toISOString(),
  };
}

function notFound(): AppError {
  return new AppError('NOT_FOUND', 'Review not found.');
}

function textError(field: string, message: string): AppError {
  return new AppError('VALIDATION_ERROR', message, { details: [{ field, message }] });
}

export function createReviewsService(container: AppContainer) {
  const { db, audit, clock } = container;

  async function moderationMode(q: Queryable): Promise<'PRE' | 'POST'> {
    const row = await q.setting.findUnique({
      where: { settingKey: 'reviews.moderation_mode' },
      select: { value: true },
    });
    return row?.value === 'POST' ? 'POST' : 'PRE';
  }

  async function loadForModeration(tx: TxClient, id: string): Promise<AdminReviewRow> {
    const row = await tx.review.findUnique({ where: { id }, include: ADMIN_INCLUDE });
    if (row?.deletedAt !== null) throw notFound();
    return row;
  }

  async function moderate(
    actor: AuditActor,
    id: string,
    to: 'APPROVED' | 'REJECTED',
    allowedFrom: readonly ReviewStatus[],
    reject?: RejectReviewInput,
  ): Promise<AdminReviewDto> {
    return withTransaction(db, async ({ tx }) => {
      const before = await loadForModeration(tx, id);
      if (!allowedFrom.includes(before.status)) {
        throw new AppError(
          'INVALID_STATE_TRANSITION',
          `A ${before.status.toLowerCase()} review cannot be ${to === 'APPROVED' ? 'approved' : 'rejected'}.`,
          {
            details: [
              { message: 'Transition not allowed.', meta: { status: before.status, allowedFrom } },
            ],
          },
        );
      }
      const now = clock();
      const after = await tx.review.update({
        where: { id },
        data: { status: to, moderatedAt: now, moderatedById: actor.userId ?? null },
        include: ADMIN_INCLUDE,
      });
      const aggregates =
        to === 'APPROVED' || before.status === 'APPROVED'
          ? await recomputeProductRating(tx, before.productId)
          : undefined;
      await audit.record(tx, actor, {
        action: 'STATUS_CHANGE',
        module: MODULE,
        entityType: ENTITY,
        entityId: id,
        before: { status: before.status },
        after: { status: to },
        reason: reject?.reason,
        eventKey: to === 'APPROVED' ? 'review.approved' : 'review.rejected',
        metadata: {
          productId: before.productId,
          ...(reject === undefined ? {} : { shareWithCustomer: reject.shareWithCustomer }),
          ...(aggregates === undefined ? {} : { aggregates }),
        },
      });
      return toAdminDto(after);
    });
  }

  return {
    async create(
      userId: string,
      productId: string,
      input: CreateReviewInput,
    ): Promise<{ id: string; status: ReviewStatus; message: string }> {
      const body = toPlainText(input.body);
      if (body.length < 10 || body.length > 2000) {
        throw textError('body', 'Review text must be 10–2000 characters (HTML is not allowed).');
      }
      const title = input.title === undefined ? undefined : toPlainText(input.title);
      if (title !== undefined && (title.length < 3 || title.length > 100)) {
        throw textError('title', 'Title must be 3–100 characters.');
      }
      return withTransaction(db, async ({ tx }) => {
        const product = await tx.product.findUnique({
          where: { id: productId },
          select: { id: true, status: true, deletedAt: true },
        });
        if (product?.deletedAt !== null || product.status !== 'ACTIVE') {
          throw new AppError('NOT_FOUND', 'Product not found.');
        }
        const existing = await tx.review.findUnique({
          where: { productId_userId: { productId, userId } },
          select: { id: true },
        });
        if (existing !== null) {
          const message = 'You have already reviewed this product.';
          throw new AppError('DUPLICATE_RESOURCE', message, {
            details: [{ field: 'productId', message, code: 'DUPLICATE' }],
          });
        }
        const purchase = await tx.orderItem.findFirst({
          where: {
            productId,
            ...(input.orderItemId === undefined ? {} : { id: input.orderItemId }),
            order: { userId, status: 'DELIVERED' },
          },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        });
        if (purchase === null) {
          const message = 'Only customers who received this product can review it.';
          throw new AppError('FORBIDDEN', message, {
            details: [{ message, code: 'NOT_VERIFIED_PURCHASER' }],
          });
        }
        const mode = await moderationMode(tx);
        const status: ReviewStatus = mode === 'POST' ? 'APPROVED' : 'PENDING';
        const id = randomUUID();
        try {
          await tx.review.create({
            data: {
              id,
              productId,
              userId,
              orderItemId: purchase.id,
              rating: input.rating,
              title: title ?? null,
              body,
              status,
              createdAt: clock(),
            },
          });
        } catch (error) {
          if (isPrismaKnownError(error) && error.code === 'P2002') {
            const message = 'You have already reviewed this product.';
            throw new AppError('DUPLICATE_RESOURCE', message, {
              details: [{ field: 'productId', message, code: 'DUPLICATE' }],
            });
          }
          throw error;
        }
        if (status === 'APPROVED') await recomputeProductRating(tx, productId);
        return {
          id,
          status,
          message:
            status === 'PENDING'
              ? 'Thanks! Your review will appear after moderation.'
              : 'Thanks! Your review is now published.',
        };
      });
    },

    async listMine(userId: string, query: MyReviewsQueryInput) {
      const where: Prisma.ReviewWhereInput = { userId, deletedAt: null };
      const { skip, take } = toSkipTake(query.page, query.limit);
      const [rows, total] = await Promise.all([
        db.review.findMany({
          where,
          include: { product: { select: { id: true, name: true, slug: true } } },
          orderBy: { createdAt: 'desc' },
          skip,
          take,
        }),
        db.review.count({ where }),
      ]);
      return {
        items: rows.map((r) => ({
          id: r.id,
          product: r.product,
          rating: r.rating,
          title: r.title,
          body: r.body,
          status: r.status,
          rejectionReason: null,
          createdAt: r.createdAt.toISOString(),
          moderatedAt: r.moderatedAt?.toISOString() ?? null,
        })),
        meta: buildPageMeta(query.page, query.limit, total),
      };
    },

    async listPublic(slug: string, query: PublicReviewsQueryInput) {
      const product = await db.product.findUnique({
        where: { slug },
        select: { id: true, status: true, deletedAt: true, avgRating: true, reviewCount: true },
      });
      if (product?.deletedAt !== null || product.status !== 'ACTIVE') {
        throw new AppError('NOT_FOUND', 'Product not found.');
      }
      const base: Prisma.ReviewWhereInput = {
        productId: product.id,
        status: 'APPROVED',
        deletedAt: null,
      };
      const where: Prisma.ReviewWhereInput = {
        ...base,
        ...(query.rating === undefined ? {} : { rating: query.rating }),
      };
      const orderBy: Prisma.ReviewOrderByWithRelationInput[] =
        query.sort === 'newest'
          ? [{ createdAt: 'desc' }]
          : [{ rating: query.sort === 'rating_desc' ? 'desc' : 'asc' }, { createdAt: 'desc' }];
      const { skip, take } = toSkipTake(query.page, query.limit);
      const [rows, total, groups] = await Promise.all([
        db.review.findMany({
          where,
          include: {
            user: { select: { firstName: true, lastName: true } },
            orderItem: { select: { variantName: true } },
          },
          orderBy,
          skip,
          take,
        }),
        db.review.count({ where }),
        db.review.groupBy({ by: ['rating'], where: base, _count: { _all: true } }),
      ]);
      const distribution: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
      for (const g of groups) distribution[String(g.rating)] = g._count._all;
      const meta: PageMeta & { summary: Record<string, unknown> } = {
        ...buildPageMeta(query.page, query.limit, total),
        summary: {
          average: roundMoney(product.avgRating).toFixed(2),
          count: product.reviewCount,
          distribution,
        },
      };
      return {
        items: rows.map((r) => ({
          id: r.id,
          rating: r.rating,
          title: r.title,
          body: r.body,
          authorName: authorName(r.user.firstName, r.user.lastName),
          isVerifiedPurchase: true,
          variantName: r.orderItem.variantName,
          createdAt: r.createdAt.toISOString(),
        })),
        meta,
      };
    },

    async listAdmin(
      query: AdminReviewsQueryInput,
    ): Promise<{ items: AdminReviewDto[]; meta: PageMeta }> {
      const where: Prisma.ReviewWhereInput = {
        deletedAt: null,
        ...(query.status === 'ALL' ? {} : { status: query.status }),
        ...(query.rating === undefined ? {} : { rating: query.rating }),
        ...(query.productId === undefined ? {} : { productId: query.productId }),
        ...(query.q === undefined
          ? {}
          : { OR: [{ title: { contains: query.q } }, { body: { contains: query.q } }] }),
      };
      if (query.from !== undefined || query.to !== undefined) {
        where.createdAt = {
          ...(query.from === undefined ? {} : { gte: istDayRange(query.from).start }),
          ...(query.to === undefined ? {} : { lt: istDayRange(query.to).end }),
        };
      }
      const { skip, take } = toSkipTake(query.page, query.limit);
      const [rows, total] = await Promise.all([
        db.review.findMany({
          where,
          include: ADMIN_INCLUDE,
          orderBy: { createdAt: 'desc' },
          skip,
          take,
        }),
        db.review.count({ where }),
      ]);
      return { items: rows.map(toAdminDto), meta: buildPageMeta(query.page, query.limit, total) };
    },

    approve(actor: AuditActor, id: string): Promise<AdminReviewDto> {
      return moderate(actor, id, 'APPROVED', ['PENDING', 'REJECTED']);
    },

    reject(actor: AuditActor, id: string, input: RejectReviewInput): Promise<AdminReviewDto> {
      return moderate(actor, id, 'REJECTED', ['PENDING', 'APPROVED'], input);
    },

    async remove(actor: AuditActor, id: string): Promise<{ id: string; deleted: true }> {
      return withTransaction(db, async ({ tx }) => {
        const before = await loadForModeration(tx, id);
        await tx.review.update({ where: { id }, data: { deletedAt: clock() } });
        const aggregates =
          before.status === 'APPROVED'
            ? await recomputeProductRating(tx, before.productId)
            : undefined;
        await audit.record(tx, actor, {
          action: 'DELETE',
          module: MODULE,
          entityType: ENTITY,
          entityId: id,
          diff: false,
          before: {
            productId: before.productId,
            userId: before.userId,
            rating: before.rating,
            title: before.title,
            body: before.body,
            status: before.status,
          },
          ...(aggregates === undefined ? {} : { metadata: { aggregates } }),
        });
        return { id, deleted: true as const };
      });
    },
  };
}

export type ReviewsService = ReturnType<typeof createReviewsService>;
