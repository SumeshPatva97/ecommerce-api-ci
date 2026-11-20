/**
 * Admin refund use-cases — API_DOCUMENTATION.md §4.11, ADMIN_WORKFLOWS.md §11,
 * ROLE_PERMISSION_AND_AUDIT_LOGS.md R12 / §9.
 *
 * - approve: REQUESTED → APPROVED (→ PROCESSING for gateway refunds). Maker-checker (R-16,
 *   PROVISIONAL OQ-64): the staff requester cannot approve their own refund → 403 FORBIDDEN
 *   `SELF_APPROVAL`; a Superadmin may, with a mandatory justification `note`. No auto-approve
 *   threshold. Issues a credit note when the order is invoiced (TAX_AND_GST §18.2). Audit
 *   `REFUND_APPROVE`; emits `REFUND_INITIATED`.
 * - reject: REQUESTED → REJECTED (`REFUND_REJECTED`, R-12). Audit `STATUS_CHANGE`.
 * - retry: FAILED → PROCESSING (max 5 retries, ADMIN_WORKFLOWS §11.1). Audit `UPDATE`.
 * - complete (R-13): BANK_TRANSFER (or a gateway refund closed manually) in APPROVED/PROCESSING →
 *   COMPLETED with the UTR in `payout_reference`. Audit `STATUS_CHANGE`; emits `REFUND_COMPLETED`.
 * Gateway calls happen after commit; a second transaction records the result.
 */
import type { AppContainer } from '../../container.js';
import { withTransaction, type TxClient } from '../../core/db/transaction.js';
import { AppError } from '../../core/errors/AppError.js';
import { buildPageMeta, toSkipTake, type PageMeta } from '../../core/http/pagination.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { RefundStatus } from '../../generated/prisma/enums.js';
import { dec, toMoneyString } from '../../lib/money.js';
import { istDayRange } from '../../lib/time.js';
import type { AuditActor } from '../audit/audit.service.js';
import { issueCreditNote } from '../invoices/index.js';
import { notificationServiceFor } from '../notifications/index.js';
import {
  createRefundForOrder,
  executeGatewayRefund,
  markRefundCompleted,
  prepareGatewayRefund,
  type GatewayDeps,
} from './refunds.core.js';
import { METHOD_LABELS, ORDER_CONTACT_SELECT, notifyOrderEvent } from './refunds.notify.js';
import type {
  ApproveRefundInput,
  CompleteRefundInput,
  CreateRefundInput,
  RefundListQueryInput,
} from './refunds.schemas.js';

const MODULE = 'refunds';
const ENTITY = 'Refund';
export const MAX_REFUND_RETRIES = 5;

export interface StaffContext {
  readonly actor: AuditActor;
  readonly userId: string;
  readonly isSuperadmin: boolean;
}

const LIST_SELECT = {
  id: true,
  refundNumber: true,
  orderId: true,
  status: true,
  method: true,
  amount: true,
  reasonCode: true,
  requestedByType: true,
  createdAt: true,
  completedAt: true,
  order: { select: { orderNumber: true } },
} as const;

const DETAIL_SELECT = {
  id: true,
  refundNumber: true,
  orderId: true,
  paymentId: true,
  status: true,
  method: true,
  reasonCode: true,
  reasonText: true,
  itemsAmount: true,
  shippingAmount: true,
  amount: true,
  taxableValue: true,
  taxAmount: true,
  restock: true,
  requestedByType: true,
  requestedById: true,
  approvedById: true,
  approvedAt: true,
  rejectedById: true,
  rejectedAt: true,
  rejectionReason: true,
  providerRefundId: true,
  payoutReference: true,
  processingAt: true,
  completedAt: true,
  failedAt: true,
  failureReason: true,
  retryCount: true,
  createdAt: true,
  order: { select: { orderNumber: true } },
  items: {
    select: {
      orderItemId: true,
      quantity: true,
      amount: true,
      taxableValue: true,
      taxAmount: true,
      orderItem: { select: { sku: true, productName: true, variantName: true } },
    },
  },
  invoiceRecords: {
    where: { invoiceType: 'CREDIT_NOTE' },
    select: { id: true, invoiceNumber: true, createdAt: true },
  },
} as const satisfies Prisma.RefundSelect;

type DetailRow = Prisma.RefundGetPayload<{ select: typeof DETAIL_SELECT }>;
type ListRow = Prisma.RefundGetPayload<{ select: typeof LIST_SELECT }>;

export function toRefundListItem(r: ListRow) {
  return {
    id: r.id,
    refundNumber: r.refundNumber,
    orderId: r.orderId,
    orderNumber: r.order.orderNumber,
    status: r.status,
    method: r.method,
    amount: toMoneyString(r.amount),
    reasonCode: r.reasonCode,
    requestedByType: r.requestedByType,
    createdAt: r.createdAt.toISOString(),
    completedAt: r.completedAt?.toISOString() ?? null,
  };
}

export function toRefundDetail(r: DetailRow) {
  const timeline: { status: RefundStatus; at: string }[] = [];
  const push = (status: RefundStatus, at: Date | null): void => {
    if (at !== null) timeline.push({ status, at: at.toISOString() });
  };
  push('REQUESTED', r.createdAt);
  push('APPROVED', r.approvedAt);
  push('REJECTED', r.rejectedAt);
  push('PROCESSING', r.processingAt);
  push('FAILED', r.failedAt);
  push('COMPLETED', r.completedAt);
  timeline.sort((a, b) => a.at.localeCompare(b.at));
  const creditNote = r.invoiceRecords[0];
  return {
    id: r.id,
    refundNumber: r.refundNumber,
    orderId: r.orderId,
    orderNumber: r.order.orderNumber,
    paymentId: r.paymentId,
    status: r.status,
    method: r.method,
    amount: toMoneyString(r.amount),
    itemsAmount: toMoneyString(r.itemsAmount),
    shippingRefund: toMoneyString(r.shippingAmount),
    taxableValue: toMoneyString(r.taxableValue),
    taxAmount: toMoneyString(r.taxAmount),
    restock: r.restock,
    items: r.items.map((i) => ({
      orderItemId: i.orderItemId,
      sku: i.orderItem.sku,
      productName: i.orderItem.productName,
      variantName: i.orderItem.variantName,
      quantity: i.quantity,
      amount: toMoneyString(i.amount),
      taxableValue: toMoneyString(i.taxableValue),
      taxAmount: toMoneyString(i.taxAmount),
      restock: r.restock,
    })),
    reason: { code: r.reasonCode, text: r.reasonText },
    requestedBy: { type: r.requestedByType, id: r.requestedById },
    approvedBy:
      r.approvedAt === null ? null : { id: r.approvedById, at: r.approvedAt.toISOString() },
    rejectedBy:
      r.rejectedAt === null
        ? null
        : { id: r.rejectedById, at: r.rejectedAt.toISOString(), reason: r.rejectionReason },
    providerRefundId: r.providerRefundId,
    payoutReference: r.payoutReference,
    retryCount: r.retryCount,
    failureReason: r.failureReason,
    creditNote:
      creditNote === undefined
        ? null
        : {
            id: creditNote.id,
            number: creditNote.invoiceNumber,
            issuedAt: creditNote.createdAt.toISOString(),
          },
    timeline,
    createdAt: r.createdAt.toISOString(),
  };
}

export type RefundDetailDto = ReturnType<typeof toRefundDetail>;
export type RefundListItemDto = ReturnType<typeof toRefundListItem>;

function invalidState(current: RefundStatus, allowed: readonly RefundStatus[], message: string) {
  return new AppError('INVALID_STATE_TRANSITION', message, {
    details: [{ field: 'status', message, meta: { currentStatus: current, allowedFrom: allowed } }],
  });
}

export interface RefundsService {
  list(query: RefundListQueryInput): Promise<{ items: RefundListItemDto[]; meta: PageMeta }>;
  get(refundId: string): Promise<RefundDetailDto>;
  create(staff: StaffContext, input: CreateRefundInput): Promise<RefundDetailDto>;
  approve(
    staff: StaffContext,
    refundId: string,
    input: ApproveRefundInput,
  ): Promise<RefundDetailDto>;
  reject(staff: StaffContext, refundId: string, reason: string): Promise<RefundDetailDto>;
  retry(staff: StaffContext, refundId: string, note?: string): Promise<RefundDetailDto>;
  complete(
    staff: StaffContext,
    refundId: string,
    input: CompleteRefundInput,
  ): Promise<RefundDetailDto>;
  /** Runs the post-commit gateway step for a refund already marked PROCESSING. */
  runGateway(job: Awaited<ReturnType<typeof prepareGatewayRefund>>): Promise<void>;
}

export function createRefundsService(container: AppContainer): RefundsService {
  const { db, audit, clock } = container;
  const gatewayDeps: GatewayDeps = {
    db,
    provider: container.providers.payment,
    clock,
    logger: container.logger,
    notifications: notificationServiceFor(container),
    storefrontUrl: container.config.storefrontUrl,
  };

  async function load(refundId: string): Promise<RefundDetailDto> {
    const row = await db.refund.findUnique({ where: { id: refundId }, select: DETAIL_SELECT });
    if (row === null) throw new AppError('NOT_FOUND', 'Refund not found.');
    return toRefundDetail(row);
  }

  /** Locks order row then refund row (lock order: order → refund) and returns the refund. */
  async function lockRefund(tx: TxClient, refundId: string) {
    const head = await tx.refund.findUnique({ where: { id: refundId }, select: { orderId: true } });
    if (head === null) throw new AppError('NOT_FOUND', 'Refund not found.');
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${head.orderId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM refunds WHERE id = ${refundId} FOR UPDATE`;
    const refund = await tx.refund.findUnique({
      where: { id: refundId },
      select: {
        id: true,
        refundNumber: true,
        orderId: true,
        status: true,
        method: true,
        amount: true,
        shippingAmount: true,
        retryCount: true,
        requestedByType: true,
        requestedById: true,
        items: { select: { orderItemId: true, quantity: true } },
        order: { select: ORDER_CONTACT_SELECT },
      },
    });
    if (refund === null) throw new AppError('NOT_FOUND', 'Refund not found.');
    return refund;
  }

  async function runGateway(job: Awaited<ReturnType<typeof prepareGatewayRefund>>): Promise<void> {
    if (job === null) return;
    await executeGatewayRefund(gatewayDeps, job);
  }

  return {
    runGateway,

    async list(query) {
      const where: Prisma.RefundWhereInput = {
        ...(query.status === undefined ? {} : { status: { in: query.status } }),
        ...(query.method === undefined ? {} : { method: query.method }),
        ...(query.orderId === undefined ? {} : { orderId: query.orderId }),
        ...(query.q === undefined
          ? {}
          : {
              OR: [
                { refundNumber: { contains: query.q } },
                { order: { orderNumber: { contains: query.q } } },
                { providerRefundId: { contains: query.q } },
              ],
            }),
        ...(query.from === undefined && query.to === undefined
          ? {}
          : {
              createdAt: {
                ...(query.from === undefined ? {} : { gte: istDayRange(query.from).start }),
                ...(query.to === undefined ? {} : { lt: istDayRange(query.to).end }),
              },
            }),
      };
      const [rows, total] = await Promise.all([
        db.refund.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          select: LIST_SELECT,
          ...toSkipTake(query.page, query.limit),
        }),
        db.refund.count({ where }),
      ]);
      return {
        items: rows.map(toRefundListItem),
        meta: buildPageMeta(query.page, query.limit, total),
      };
    },

    get: load,

    async create(staff, input) {
      const created = await withTransaction(db, async ({ tx }) => {
        await tx.$queryRaw`SELECT id FROM orders WHERE id = ${input.orderId} FOR UPDATE`;
        const refund = await createRefundForOrder(tx, {
          orderId: input.orderId,
          now: clock(),
          requestedBy: { type: 'STAFF', userId: staff.userId },
          method: input.method,
          reasonCode: input.reasonCode,
          reasonText: input.reason,
          items: input.items,
          shippingAmount:
            input.shippingRefund === undefined ? undefined : dec(input.shippingRefund),
          expectedAmount: input.amount === undefined ? undefined : dec(input.amount),
        });
        await audit.record(tx, staff.actor, {
          action: 'CREATE',
          module: MODULE,
          entityType: ENTITY,
          entityId: refund.id,
          after: {
            refundNumber: refund.refundNumber,
            orderId: input.orderId,
            status: refund.status,
            method: refund.method,
            amount: toMoneyString(refund.amount),
          },
          diff: false,
          reason: input.reason,
          eventKey: 'refunds.created',
          metadata: { entityLabel: refund.refundNumber },
        });
        return refund;
      });
      return load(created.id);
    },

    async approve(staff, refundId, input) {
      const job = await withTransaction(db, async ({ tx }) => {
        const refund = await lockRefund(tx, refundId);
        if (refund.status !== 'REQUESTED') {
          throw invalidState(
            refund.status,
            ['REQUESTED'],
            'Only requested refunds can be approved.',
          );
        }
        const ownRequest =
          refund.requestedByType === 'STAFF' && refund.requestedById === staff.userId;
        if (ownRequest && !staff.isSuperadmin) {
          throw new AppError('FORBIDDEN', 'You cannot approve a refund you requested.', {
            details: [
              { code: 'SELF_APPROVAL', message: 'A different user must approve this refund.' },
            ],
          });
        }
        if (ownRequest && input.note === undefined) {
          throw new AppError('VALIDATION_ERROR', 'A justification note is required.', {
            details: [
              {
                field: 'note',
                code: 'JUSTIFICATION_REQUIRED',
                message: 'Superadmin self-approval requires a justification note.',
              },
            ],
          });
        }
        const now = clock();
        await tx.refund.update({
          where: { id: refund.id },
          data: { status: 'APPROVED', approvedById: staff.userId, approvedAt: now },
        });
        const creditNote = await issueCreditNote(tx, {
          orderId: refund.orderId,
          refundId: refund.id,
          scope: {
            kind: 'PARTIAL',
            items: refund.items,
            shippingAmount: dec(refund.shippingAmount),
          },
          now,
        });
        await audit.record(tx, staff.actor, {
          action: 'REFUND_APPROVE',
          module: MODULE,
          entityType: ENTITY,
          entityId: refund.id,
          before: { status: refund.status },
          after: { status: 'APPROVED', amount: toMoneyString(refund.amount) },
          diff: false,
          reason: input.note,
          eventKey: 'refunds.approved',
          metadata: {
            entityLabel: refund.refundNumber,
            selfApproval: ownRequest,
            creditNote: creditNote?.invoiceNumber ?? null,
          },
        });
        await notifyOrderEvent(
          tx,
          gatewayDeps,
          refund.order,
          'REFUND_INITIATED',
          {
            refundNumber: refund.refundNumber,
            amount: toMoneyString(refund.amount),
            methodLabel: METHOD_LABELS[refund.method] ?? refund.method,
          },
          refund.id,
        );
        return prepareGatewayRefund(tx, refund.id, now);
      });
      await runGateway(job);
      return load(refundId);
    },

    async reject(staff, refundId, reason) {
      await withTransaction(db, async ({ tx }) => {
        const refund = await lockRefund(tx, refundId);
        if (refund.status !== 'REQUESTED') {
          throw invalidState(
            refund.status,
            ['REQUESTED'],
            'Only requested refunds can be rejected.',
          );
        }
        const now = clock();
        await tx.refund.update({
          where: { id: refund.id },
          data: {
            status: 'REJECTED',
            rejectedById: staff.userId,
            rejectedAt: now,
            rejectionReason: reason,
          },
        });
        await audit.record(tx, staff.actor, {
          action: 'STATUS_CHANGE',
          module: MODULE,
          entityType: ENTITY,
          entityId: refund.id,
          before: { status: refund.status },
          after: { status: 'REJECTED' },
          reason,
          eventKey: 'refunds.rejected',
          metadata: { entityLabel: refund.refundNumber },
        });
        await notifyOrderEvent(
          tx,
          gatewayDeps,
          refund.order,
          'REFUND_REJECTED',
          {
            refundNumber: refund.refundNumber,
            amount: toMoneyString(refund.amount),
            methodLabel: METHOD_LABELS[refund.method] ?? refund.method,
            reason,
          },
          refund.id,
        );
      });
      return load(refundId);
    },

    async retry(staff, refundId, note) {
      const job = await withTransaction(db, async ({ tx }) => {
        const refund = await lockRefund(tx, refundId);
        if (refund.status !== 'FAILED') {
          throw invalidState(refund.status, ['FAILED'], 'Only failed refunds can be retried.');
        }
        if (refund.retryCount >= MAX_REFUND_RETRIES) {
          throw new AppError('CONFLICT', 'Retry limit reached; escalate to finance.', {
            details: [
              {
                code: 'RETRY_LIMIT_REACHED',
                message: `At most ${MAX_REFUND_RETRIES} retries.`,
              },
            ],
          });
        }
        const now = clock();
        await tx.refund.update({
          where: { id: refund.id },
          data: { retryCount: { increment: 1 } },
        });
        const prepared = await prepareGatewayRefund(tx, refund.id, now);
        if (prepared === null) {
          // Bank transfer (or no gateway reference): back to PROCESSING for manual completion.
          await tx.refund.update({
            where: { id: refund.id },
            data: { status: 'PROCESSING', processingAt: now, failureReason: null },
          });
        }
        await audit.record(tx, staff.actor, {
          action: 'UPDATE',
          module: MODULE,
          entityType: ENTITY,
          entityId: refund.id,
          before: { status: refund.status, retryCount: refund.retryCount },
          after: { status: 'PROCESSING', retryCount: refund.retryCount + 1 },
          reason: note,
          eventKey: 'refunds.retried',
          metadata: { entityLabel: refund.refundNumber },
        });
        return prepared;
      });
      await runGateway(job);
      return load(refundId);
    },

    async complete(staff, refundId, input) {
      const now = clock();
      if (input.transferredAt.getTime() > now.getTime()) {
        throw new AppError('VALIDATION_ERROR', 'Transfer time cannot be in the future.', {
          details: [{ field: 'transferredAt', message: 'Must not be in the future.' }],
        });
      }
      await withTransaction(db, async ({ tx }) => {
        const refund = await lockRefund(tx, refundId);
        const allowed: RefundStatus[] =
          refund.method === 'BANK_TRANSFER' ? ['APPROVED', 'PROCESSING'] : ['PROCESSING'];
        if (!allowed.includes(refund.status)) {
          throw invalidState(
            refund.status,
            allowed,
            'This refund cannot be completed manually in its current state.',
          );
        }
        await markRefundCompleted(tx, gatewayDeps, {
          refundId: refund.id,
          now,
          payoutReference: input.utr,
        });
        await audit.record(tx, staff.actor, {
          action: 'STATUS_CHANGE',
          module: MODULE,
          entityType: ENTITY,
          entityId: refund.id,
          before: { status: refund.status },
          after: { status: 'COMPLETED' },
          reason: input.note,
          eventKey: 'refunds.completed_manually',
          metadata: {
            entityLabel: refund.refundNumber,
            transferredAt: input.transferredAt.toISOString(),
            // UTR is a payout reference, not a secret (ROLE_PERMISSION §13 provider ids allowed).
            utr: input.utr,
          },
        });
      });
      return load(refundId);
    },
  };
}
