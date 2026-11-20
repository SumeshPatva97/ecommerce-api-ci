/**
 * Order use-cases — API_DOCUMENTATION.md §3.10 (customer) and §4.7 (admin), ADMIN_WORKFLOWS.md
 * §7–§10, PROJECT_CONTEXT §5.1.
 *
 * Every status change goes through `lib/orderStateMachine` (`canTransition`, `customerCancelMode`,
 * `staffCanCancel`). Each transition takes the order row lock FIRST (`SELECT … FOR UPDATE`), then
 * re-reads the order, and writes `order_status_history` + audit `STATUS_CHANGE` + notification in
 * the same transaction. Customer access is by `orderNumber` + owner: another customer's order is
 * 404 (no existence leak).
 *
 * PROVISIONAL (OQ-12): customer cancels DIRECTLY in CONFIRMED, REQUESTS in PROCESSING, not from
 * PACKED onward. (API_DOCUMENTATION §3.10 also lists PENDING_PAYMENT/PAYMENT_FAILED as direct, but
 * the canonical state machine — PROJECT_CONTEXT §5.1 — has no such edge; unpaid orders are
 * cancelled by the payment-expiry job.)
 * PROVISIONAL (OQ-48/OQ-67): one invoice per order, issued when the order reaches SHIPPED.
 */
import { randomUUID } from 'node:crypto';

import type { AppContainer } from '../../container.js';
import { withTransaction, type TxClient } from '../../core/db/transaction.js';
import { AppError } from '../../core/errors/AppError.js';
import { buildPageMeta, toSkipTake, type PageMeta } from '../../core/http/pagination.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { NotificationEvent, OrderStatus } from '../../generated/prisma/enums.js';
import type { ShippingProviderRegistry } from '../../integrations/shipping/shippingProvider.js';
import { dec, toMoneyString } from '../../lib/money.js';
import {
  ORDER_TRANSITIONS,
  canTransition,
  customerCancelMode,
  staffCanCancel,
} from '../../lib/orderStateMachine.js';
import { istDayRange } from '../../lib/time.js';
import type { AuditActor } from '../audit/audit.service.js';
import { createCouponsService, type CouponsService } from '../coupons/index.js';
import { createInventoryService, type InventoryService } from '../inventory/index.js';
import { buildInvoicePdf, issueInvoiceForOrder } from '../invoices/index.js';
import { notificationServiceFor } from '../notifications/index.js';
import {
  executeGatewayRefund,
  notifyOrderEvent,
  type GatewayDeps,
  type GatewayRefundJob,
} from '../refunds/index.js';
import { splitProvider } from '../shipping/shipping.shipments.js';
import {
  LOCKED_ORDER_SELECT,
  cancelOrderInTx,
  invalidTransition,
  lockOrderRow,
  type CancelDeps,
  type CancelResult,
  type LockedOrder,
} from './orders.cancel.js';
import {
  ADMIN_LIST_SELECT,
  CUSTOMER_LIST_SELECT,
  DETAIL_SELECT,
  toAdminDetail,
  toAdminListItem,
  toCustomerDetail,
  toCustomerListItem,
  type AdminOrderDetail,
  type CustomerOrderDetail,
  type ShipmentResolver,
} from './orders.mapper.js';
import type {
  AdminCancelInput,
  AdminOrdersQueryInput,
  AdminStatusInput,
  ApproveCancellationInput,
  CustomerCancelInput,
  DocumentQueryInput,
  MyOrdersQueryInput,
} from './orders.schemas.js';

const MODULE = 'orders';
const ENTITY = 'Order';

export interface OrdersServiceDeps {
  readonly inventory?: InventoryService;
  readonly coupons?: CouponsService;
  readonly shippingProviders?: ShippingProviderRegistry;
}

export type CancellationRequestResult = {
  readonly orderNumber: string;
  readonly previousStatus: OrderStatus;
  readonly status: OrderStatus;
  readonly message?: string;
} & Partial<Omit<CancelResult, 'orderNumber' | 'previousStatus' | 'status'>>;

export interface PdfDownload {
  readonly pdf: Buffer;
  readonly filename: string;
}

const STATUS_EVENTS: Partial<Record<OrderStatus, NotificationEvent>> = {
  PROCESSING: 'ORDER_PROCESSING',
  SHIPPED: 'ORDER_SHIPPED',
  OUT_FOR_DELIVERY: 'ORDER_OUT_FOR_DELIVERY',
  DELIVERED: 'ORDER_DELIVERED',
};

export function createOrdersService(container: AppContainer, deps: OrdersServiceDeps = {}) {
  const { db, audit, clock, config } = container;
  const inventory =
    deps.inventory ??
    createInventoryService({
      clock,
      reservationTtlMinutes: config.integrations.reservationTtlMinutes,
    });
  const coupons = deps.coupons ?? createCouponsService(container);
  const providers = deps.shippingProviders ?? container.providers.shipping;
  const adapterNames = new Set(providers.keys());
  const defaultProvider = config.integrations.shipping;
  const storefrontUrl = config.storefrontUrl.replace(/\/+$/, '');
  const notifications = notificationServiceFor(container);
  const cancelDeps: CancelDeps = { audit, inventory, coupons, notifications, storefrontUrl };
  const gatewayDeps: GatewayDeps = {
    db,
    provider: container.providers.payment,
    clock,
    logger: container.logger,
    notifications,
    storefrontUrl,
  };

  const resolveShipment: ShipmentResolver = (row) => {
    const { courier, bookedVia } = splitProvider(row.provider, adapterNames);
    const adapter = providers.get(bookedVia ?? defaultProvider);
    return {
      courier,
      trackingUrl: row.awbNumber === null ? null : (adapter?.trackingUrl(row.awbNumber) ?? null),
    };
  };

  async function ownedOrderId(userId: string, orderNumber: string): Promise<string> {
    const row = await db.order.findFirst({
      where: { orderNumber, userId },
      select: { id: true },
    });
    // Another customer's order is indistinguishable from a missing one (IDOR → 404).
    if (row === null) throw new AppError('NOT_FOUND', 'Order not found.');
    return row.id;
  }

  async function lockAndLoad(tx: TxClient, orderId: string): Promise<LockedOrder> {
    await lockOrderRow(tx, orderId);
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: LOCKED_ORDER_SELECT,
    });
    if (order === null) throw new AppError('NOT_FOUND', 'Order not found.');
    return order;
  }

  async function loadDetail(orderId: string) {
    const row = await db.order.findUnique({ where: { id: orderId }, select: DETAIL_SELECT });
    if (row === null) throw new AppError('NOT_FOUND', 'Order not found.');
    return row;
  }

  async function runGateway(job: GatewayRefundJob | null): Promise<string | null> {
    if (job === null) return null;
    await executeGatewayRefund(gatewayDeps, job);
    const refund = await db.refund.findUnique({
      where: { id: job.refundId },
      select: { status: true },
    });
    return refund?.status ?? null;
  }

  async function finishCancel(outcome: {
    result: CancelResult;
    gatewayJob: GatewayRefundJob | null;
  }): Promise<CancelResult> {
    const status = await runGateway(outcome.gatewayJob);
    const { result } = outcome;
    if (status === null || result.refund === null) return result;
    return { ...result, refund: { ...result.refund, status } };
  }

  async function recordTransition(
    tx: TxClient,
    actor: AuditActor,
    order: LockedOrder,
    to: OrderStatus,
    options: { note?: string | undefined; eventKey: string; customerVisible?: boolean },
  ): Promise<void> {
    await tx.orderStatusHistory.create({
      data: {
        id: randomUUID(),
        orderId: order.id,
        eventType: 'STATUS_CHANGE',
        fromStatus: order.status,
        toStatus: to,
        note: options.note?.slice(0, 1000) ?? null,
        isCustomerVisible: options.customerVisible ?? true,
        actorType: actor.type,
        actorUserId: actor.userId ?? null,
        createdAt: clock(),
      },
    });
    await audit.record(tx, actor, {
      action: 'STATUS_CHANGE',
      module: MODULE,
      entityType: ENTITY,
      entityId: order.id,
      before: { status: order.status },
      after: { status: to },
      reason: options.note,
      eventKey: options.eventKey,
      metadata: { entityLabel: order.orderNumber },
    });
  }

  async function downloadDocument(
    orderId: string,
    query: DocumentQueryInput,
    reprint: boolean,
  ): Promise<PdfDownload & { invoiceNumber: string; documentId: string }> {
    const { pdf, filename, document } = await buildInvoicePdf(
      db,
      { orderId, type: query.type, invoiceNumber: query.invoiceNumber },
      { reprint, generatedAt: clock() },
    );
    return { pdf, filename, invoiceNumber: document.invoiceNumber, documentId: document.id };
  }

  return {
    // ---------------------------------------------------------------- customer
    async listMine(
      userId: string,
      query: MyOrdersQueryInput,
    ): Promise<{ items: ReturnType<typeof toCustomerListItem>[]; meta: PageMeta }> {
      const where: Prisma.OrderWhereInput = {
        userId,
        ...(query.status === undefined ? {} : { status: { in: query.status } }),
        ...(query.from === undefined && query.to === undefined
          ? {}
          : {
              placedAt: {
                ...(query.from === undefined ? {} : { gte: istDayRange(query.from).start }),
                ...(query.to === undefined ? {} : { lt: istDayRange(query.to).end }),
              },
            }),
      };
      const [rows, total] = await Promise.all([
        db.order.findMany({
          where,
          orderBy: { placedAt: 'desc' },
          select: CUSTOMER_LIST_SELECT,
          ...toSkipTake(query.page, query.limit),
        }),
        db.order.count({ where }),
      ]);
      return {
        items: rows.map(toCustomerListItem),
        meta: buildPageMeta(query.page, query.limit, total),
      };
    },

    async getMine(userId: string, orderNumber: string): Promise<CustomerOrderDetail> {
      const orderId = await ownedOrderId(userId, orderNumber);
      return toCustomerDetail(await loadDetail(orderId), resolveShipment);
    },

    async trackingMine(userId: string, orderNumber: string) {
      const orderId = await ownedOrderId(userId, orderNumber);
      const order = await db.order.findUnique({
        where: { id: orderId },
        select: {
          orderNumber: true,
          status: true,
          shipments: {
            where: { status: { not: 'CANCELLED' } },
            orderBy: { createdAt: 'asc' },
            select: {
              shipmentNumber: true,
              status: true,
              provider: true,
              awbNumber: true,
              trackingEvents: {
                orderBy: { eventAt: 'asc' },
                select: { mappedStatus: true, location: true, message: true, eventAt: true },
              },
            },
          },
        },
      });
      if (order === null) throw new AppError('NOT_FOUND', 'Order not found.');
      return {
        orderNumber: order.orderNumber,
        orderStatus: order.status,
        shipments: order.shipments.map((s) => {
          const view = resolveShipment(s);
          return {
            shipmentNumber: s.shipmentNumber,
            status: s.status,
            courier: view.courier,
            awb: s.awbNumber,
            trackingUrl: view.trackingUrl,
            // No expected-delivery column in the approved schema.
            estimatedDelivery: null,
            events: s.trackingEvents.map((e) => ({
              status: e.mappedStatus,
              location: e.location,
              at: e.eventAt.toISOString(),
              description: e.message,
            })),
          };
        }),
      };
    },

    async invoiceMine(
      userId: string,
      orderNumber: string,
      query: DocumentQueryInput,
    ): Promise<PdfDownload> {
      const orderId = await ownedOrderId(userId, orderNumber);
      const { pdf, filename } = await downloadDocument(orderId, query, false);
      return { pdf, filename };
    },

    async cancelMine(
      actor: AuditActor,
      userId: string,
      orderNumber: string,
      input: CustomerCancelInput,
    ): Promise<CancellationRequestResult> {
      const orderId = await ownedOrderId(userId, orderNumber);
      const outcome = await withTransaction(db, async ({ tx }) => {
        const order = await lockAndLoad(tx, orderId);
        // Duplicate submission → current state (idempotent).
        if (order.status === 'CANCELLED' || order.status === 'CANCELLATION_REQUESTED') {
          return {
            kind: 'state' as const,
            result: {
              orderNumber: order.orderNumber,
              previousStatus: order.status,
              status: order.status,
            } satisfies CancellationRequestResult,
          };
        }
        const mode = customerCancelMode(order.status);
        if (mode === 'NOT_ALLOWED') {
          throw invalidTransition(
            order.status,
            ['CONFIRMED', 'PROCESSING'],
            order.status === 'PACKED' || order.status === 'SHIPPED'
              ? 'This order has already been packed and can no longer be cancelled online. Please contact support.'
              : 'This order cannot be cancelled online. Please contact support.',
          );
        }
        const reasonText = [input.reasonCode, input.comment].filter(Boolean).join(': ');
        if (mode === 'REQUEST') {
          if (!canTransition(order.status, 'CANCELLATION_REQUESTED')) {
            throw invalidTransition(
              order.status,
              ['PROCESSING'],
              'Cancellation cannot be requested.',
            );
          }
          const now = clock();
          await tx.order.update({
            where: { id: order.id },
            data: {
              status: 'CANCELLATION_REQUESTED',
              cancellationRequestedAt: now,
              cancellationReason: reasonText.slice(0, 500),
            },
          });
          await recordTransition(tx, actor, order, 'CANCELLATION_REQUESTED', {
            note: reasonText,
            eventKey: 'orders.cancellation_requested',
          });
          await notifyOrderEvent(tx, cancelDeps, order, 'CANCELLATION_REQUESTED', {
            reason: input.comment ?? input.reasonCode,
          });
          return {
            kind: 'state' as const,
            result: {
              orderNumber: order.orderNumber,
              previousStatus: order.status,
              status: 'CANCELLATION_REQUESTED' as const,
              message: "Your cancellation request has been sent. We'll update you shortly.",
            } satisfies CancellationRequestResult,
          };
        }
        // R-16: self-cancel of a CONFIRMED order → auto-APPROVED full refund when prepaid.
        const cancelled = await cancelOrderInTx(tx, cancelDeps, {
          order,
          actor,
          now: clock(),
          reasonCode: input.reasonCode,
          comment: input.comment,
          restock: true,
          refund: { initiate: true, autoApprove: true },
          notifyCustomer: true,
          eventKey: 'orders.cancelled_by_customer',
        });
        return { kind: 'cancelled' as const, cancelled };
      });
      return outcome.kind === 'state' ? outcome.result : finishCancel(outcome.cancelled);
    },

    // ---------------------------------------------------------------- admin
    async listAdmin(query: AdminOrdersQueryInput) {
      const and: Prisma.OrderWhereInput[] = [];
      if (query.status !== undefined) and.push({ status: { in: query.status } });
      if (query.paymentStatus !== undefined) and.push({ paymentStatus: query.paymentStatus });
      if (query.paymentMethod !== undefined) and.push({ paymentMethod: query.paymentMethod });
      if (query.from !== undefined) and.push({ placedAt: { gte: istDayRange(query.from).start } });
      if (query.to !== undefined) and.push({ placedAt: { lt: istDayRange(query.to).end } });
      if (query.minTotal !== undefined) and.push({ grandTotal: { gte: dec(query.minTotal) } });
      if (query.maxTotal !== undefined) and.push({ grandTotal: { lte: dec(query.maxTotal) } });
      if (query.q !== undefined) {
        and.push({
          OR: [
            { orderNumber: { contains: query.q } },
            { customerEmailSnapshot: { contains: query.q } },
            { customerPhoneSnapshot: { contains: query.q } },
            { shipments: { some: { awbNumber: query.q } } },
            // FR-ORD-006: SKU via the order-item snapshot (`order_items.sku`).
            { items: { some: { sku: { contains: query.q } } } },
          ],
        });
      }
      const where: Prisma.OrderWhereInput = and.length === 0 ? {} : { AND: and };
      const orderBy: Prisma.OrderOrderByWithRelationInput =
        query.sort === 'placedAt'
          ? { placedAt: 'asc' }
          : query.sort === '-grandTotal'
            ? { grandTotal: 'desc' }
            : { placedAt: 'desc' };
      const [rows, total] = await Promise.all([
        db.order.findMany({
          where,
          orderBy,
          select: ADMIN_LIST_SELECT,
          ...toSkipTake(query.page, query.limit),
        }),
        db.order.count({ where }),
      ]);
      return {
        items: rows.map(toAdminListItem),
        meta: buildPageMeta(query.page, query.limit, total),
      };
    },

    async getAdmin(orderId: string): Promise<AdminOrderDetail> {
      return toAdminDetail(await loadDetail(orderId), resolveShipment);
    },

    async changeStatus(actor: AuditActor, orderId: string, input: AdminStatusInput) {
      await withTransaction(db, async ({ tx }) => {
        const order = await lockAndLoad(tx, orderId);
        const target = input.status;
        if (!canTransition(order.status, target)) {
          throw new AppError(
            'INVALID_STATE_TRANSITION',
            `The order cannot move from ${order.status} to ${target}.`,
            {
              details: [
                {
                  field: 'status',
                  message: 'Not a canonical transition.',
                  meta: { currentStatus: order.status, allowed: ORDER_TRANSITIONS[order.status] },
                },
              ],
            },
          );
        }
        const now = clock();
        let shipment: {
          id: string;
          shipmentNumber: string;
          awbNumber: string | null;
          provider: string | null;
        } | null = null;
        if (target === 'SHIPPED' || target === 'OUT_FOR_DELIVERY') {
          shipment = await tx.shipment.findFirst({
            where: {
              orderId: order.id,
              status: { not: 'CANCELLED' },
              ...(input.shipmentId === undefined ? {} : { id: input.shipmentId }),
            },
            orderBy: { createdAt: 'asc' },
            select: { id: true, shipmentNumber: true, awbNumber: true, provider: true },
          });
          if (target === 'SHIPPED' && (shipment?.awbNumber ?? null) === null) {
            throw new AppError('VALIDATION_ERROR', 'Shipping requires a shipment with an AWB.', {
              details: [
                {
                  field: 'shipmentId',
                  code: 'AWB_REQUIRED',
                  message: 'Create a shipment with an AWB before marking the order shipped.',
                },
              ],
            });
          }
        }
        const fresh = await tx.order.findUnique({
          where: { id: order.id },
          select: { shippedAt: true, confirmedAt: true },
        });
        await tx.order.update({
          where: { id: order.id },
          data: {
            status: target,
            ...(target === 'SHIPPED' && fresh?.shippedAt == null ? { shippedAt: now } : {}),
            ...(target === 'DELIVERED' ? { deliveredAt: now } : {}),
          },
        });
        await recordTransition(tx, actor, order, target, {
          note: input.note,
          eventKey: 'order.status_changed',
        });
        if (target === 'SHIPPED') {
          // PROVISIONAL (OQ-48/OQ-67): one invoice per order, on SHIPPED.
          await issueInvoiceForOrder(tx, order.id, now, {
            storefrontUrl,
            audit: { service: audit, actor },
          });
        }
        const event = STATUS_EVENTS[target];
        if (event !== undefined) {
          const view = shipment === null ? null : resolveShipment(shipment);
          await notifyOrderEvent(
            tx,
            cancelDeps,
            order,
            event,
            {
              ...(target === 'DELIVERED' ? { deliveredAt: now.toISOString() } : {}),
              ...(shipment === null
                ? {}
                : {
                    shipmentNumber: shipment.shipmentNumber,
                    awb: shipment.awbNumber,
                    courier: view?.courier ?? null,
                    trackingUrl: view?.trackingUrl ?? null,
                  }),
              ...(target === 'OUT_FOR_DELIVERY' && order.paymentMethod === 'COD'
                ? { codAmount: toMoneyString(order.grandTotal) }
                : {}),
            },
            shipment?.id,
          );
        }
      });
      return toAdminDetail(await loadDetail(orderId), resolveShipment);
    },

    async cancelAdmin(actor: AuditActor, orderId: string, input: AdminCancelInput) {
      const outcome = await withTransaction(db, async ({ tx }) => {
        const order = await lockAndLoad(tx, orderId);
        if (!staffCanCancel(order.status)) {
          throw invalidTransition(
            order.status,
            ['CONFIRMED', 'PROCESSING', 'PACKED'],
            order.status === 'CANCELLATION_REQUESTED'
              ? 'Approve or reject the pending cancellation request instead.'
              : 'This order can no longer be cancelled.',
          );
        }
        return cancelOrderInTx(tx, cancelDeps, {
          order,
          actor,
          now: clock(),
          reasonCode: input.reasonCode,
          comment: input.comment,
          restock: input.restock,
          refund: {
            initiate: input.refund.initiate,
            autoApprove: false,
            method: input.refund.method,
          },
          notifyCustomer: input.notifyCustomer,
          eventKey: 'orders.cancelled_by_staff',
        });
      });
      return finishCancel(outcome);
    },

    async approveCancellation(actor: AuditActor, orderId: string, input: ApproveCancellationInput) {
      const outcome = await withTransaction(db, async ({ tx }) => {
        const order = await lockAndLoad(tx, orderId);
        if (order.status !== 'CANCELLATION_REQUESTED') {
          throw invalidTransition(
            order.status,
            ['CANCELLATION_REQUESTED'],
            'There is no pending cancellation request for this order.',
          );
        }
        return cancelOrderInTx(tx, cancelDeps, {
          order,
          actor,
          now: clock(),
          reasonCode: 'CUSTOMER_REQUEST',
          comment: input.comment,
          restock: true,
          refund: { initiate: input.refund.initiate, autoApprove: false },
          notifyCustomer: true,
          eventKey: 'orders.cancellation_approved',
        });
      });
      return finishCancel(outcome);
    },

    async rejectCancellation(actor: AuditActor, orderId: string, reason: string) {
      await withTransaction(db, async ({ tx }) => {
        const order = await lockAndLoad(tx, orderId);
        if (
          order.status !== 'CANCELLATION_REQUESTED' ||
          !canTransition(order.status, 'PROCESSING')
        ) {
          throw invalidTransition(
            order.status,
            ['CANCELLATION_REQUESTED'],
            'There is no pending cancellation request for this order.',
          );
        }
        await tx.order.update({ where: { id: order.id }, data: { status: 'PROCESSING' } });
        await recordTransition(tx, actor, order, 'PROCESSING', {
          note: reason,
          eventKey: 'orders.cancellation_rejected',
        });
        await notifyOrderEvent(tx, cancelDeps, order, 'CANCELLATION_REJECTED', { reason });
      });
      return toAdminDetail(await loadDetail(orderId), resolveShipment);
    },

    async addNote(actor: AuditActor, orderId: string, note: string) {
      return withTransaction(db, async ({ tx }) => {
        const order = await lockAndLoad(tx, orderId);
        const id = randomUUID();
        const now = clock();
        await tx.orderStatusHistory.create({
          data: {
            id,
            orderId: order.id,
            eventType: 'NOTE',
            fromStatus: order.status,
            toStatus: order.status,
            note,
            isCustomerVisible: false,
            actorType: actor.type,
            actorUserId: actor.userId ?? null,
            createdAt: now,
          },
        });
        await audit.record(tx, actor, {
          action: 'UPDATE',
          module: MODULE,
          entityType: ENTITY,
          entityId: order.id,
          after: { note },
          diff: false,
          eventKey: 'orders.note_added',
          metadata: { entityLabel: order.orderNumber, visibility: 'INTERNAL' },
        });
        return {
          id,
          note,
          visibility: 'INTERNAL' as const,
          actor: { type: actor.type, userId: actor.userId ?? null },
          at: now.toISOString(),
        };
      });
    },

    async invoiceAdmin(actor: AuditActor, orderId: string, query: DocumentQueryInput) {
      const order = await db.order.findUnique({
        where: { id: orderId },
        select: { id: true, orderNumber: true },
      });
      if (order === null) throw new AppError('NOT_FOUND', 'Order not found.');
      const doc = await downloadDocument(order.id, query, true);
      await audit.recordSafe(db, actor, {
        action: 'PRINT',
        module: MODULE,
        entityType: query.type === 'TAX_INVOICE' ? 'Invoice' : 'CreditNote',
        entityId: doc.documentId,
        eventKey: 'orders.invoice_printed',
        diff: false,
        metadata: {
          entityLabel: doc.invoiceNumber,
          orderNumber: order.orderNumber,
          renderedOnDemand: true,
        },
      });
      return { pdf: doc.pdf, filename: doc.filename };
    },
  };
}

export type OrdersService = ReturnType<typeof createOrdersService>;
