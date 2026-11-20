/**
 * Shipments — API_DOCUMENTATION.md §4.12, §5 (shipping webhook); ADMIN_WORKFLOWS.md §7–§8;
 * BACKEND_STRUCTURE.md §16. PROVISIONAL (OQ-07: courier/aggregator open — mock adapter only).
 *
 * - Create: order `PACKED` (or `PROCESSING` with an explicit partial `items` list); quantities ≤
 *   unshipped (quantity − cancelled − allocated to non-cancelled shipments); number
 *   `SHP-YYMMDD-NNNNN` via `allocateNumber(tx, 'SHIPMENT', now)`; `READY_TO_SHIP` when an AWB is
 *   known, else `PENDING`. A provider booking (`createWithProvider`) happens BEFORE the transaction
 *   (no network call inside a DB transaction) and is cancelled best-effort if the transaction fails.
 * - Status changes follow `SHIPMENT_TRANSITIONS`; the first dispatch increments
 *   `order_items.quantity_shipped`, enqueues `ORDER_SHIPPED` (one per shipment) and moves the order
 *   via `advanceOrderForShipment`; `OUT_FOR_DELIVERY` enqueues `ORDER_OUT_FOR_DELIVERY`.
 * - Tracking events (manual or webhook) are deduplicated per shipment by `dedupe_hash`
 *   (= sha256 of `provider:eventId`); an event older than the latest recorded one is stored but does
 *   not change the status (out-of-order safe).
 * - Schema notes: `shipments.provider` (VARCHAR 30) stores the courier name; provider bookings are
 *   stored as `<adapter>:<courier>`. No columns exist for tracking URL, label URL, package weight or
 *   dimensions — the tracking URL is derived from the adapter, weight/dimensions go to the provider
 *   and the audit metadata only.
 */
import { createHash, randomUUID } from 'node:crypto';

import type { AppContainer } from '../../container.js';
import { allocateNumber } from '../../core/db/sequences.js';
import { withTransaction, type Queryable, type TxClient } from '../../core/db/transaction.js';
import { AppError } from '../../core/errors/AppError.js';
import { buildPageMeta, toSkipTake, type PageMeta } from '../../core/http/pagination.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { ActorType, ShipmentStatus } from '../../generated/prisma/enums.js';
import {
  WebhookPayloadError,
  WebhookSignatureError,
  type CreateProviderShipmentResult,
  type ShippingProviderRegistry,
  type ShippingWebhookEvent,
  type WebhookHeaders,
} from '../../integrations/shipping/shippingProvider.js';
import { toMoneyString } from '../../lib/money.js';
import { istDayRange } from '../../lib/time.js';
import { SYSTEM_ACTOR, type AuditActor } from '../audit/audit.service.js';
import type { NotificationService } from '../notifications/index.js';
import {
  DISPATCHED_STATUSES,
  SHIPMENT_TRANSITIONS,
  advanceOrderForShipment,
  canTransitionShipment,
} from './shipping.orders.js';
import type {
  CreateShipmentInput,
  ShipmentListQueryInput,
  TrackingEventInput,
  UpdateShipmentInput,
} from './shipping.schemas.js';

const MODULE = 'shipping';
const ENTITY = 'Shipment';

export const WEBHOOK_ACTOR_BASE: AuditActor = Object.freeze({
  type: 'WEBHOOK',
  loginType: 'WEBHOOK',
});

/** Dispatched, non-terminal statuses whose tracking is polled (§14 names SHIPPED / IN_TRANSIT). */
export const TRACKING_POLL_STATUSES: readonly ShipmentStatus[] = [
  'SHIPPED',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERY_FAILED',
  'RTO_INITIATED',
];
export const TRACKING_POLL_BATCH = 200;
/** BACKEND_STRUCTURE §15: shipping adapter calls time out after 8 s. */
export const COURIER_TIMEOUT_MS = 8_000;

export interface TrackingPollSummary {
  readonly adapters: number;
  readonly shipments: number;
  /** New tracking events recorded. */
  readonly events: number;
  readonly duplicates: number;
  readonly statusChanges: number;
  readonly errors: number;
  /** D4: per-adapter cursor for the next run (absent = start from the beginning). */
  readonly nextCursor: Readonly<Record<string, string>>;
}

/** Rejects after `ms` (the underlying call is not aborted; adapter calls are read-only). */
async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Courier API timeout.'));
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function dedupeHash(source: string, eventId: string): string {
  return createHash('sha256').update(`${source}:${eventId}`).digest('hex');
}

/** `mock:MockExpress` → `{ courier: 'MockExpress', bookedVia: 'mock' }`. */
export function splitProvider(
  value: string | null,
  adapters: ReadonlySet<string>,
): { courier: string | null; bookedVia: string | null } {
  if (value === null) return { courier: null, bookedVia: null };
  const idx = value.indexOf(':');
  if (idx > 0 && adapters.has(value.slice(0, idx))) {
    return { courier: value.slice(idx + 1), bookedVia: value.slice(0, idx) };
  }
  return { courier: value, bookedVia: null };
}

const CORE_SELECT = {
  id: true,
  shipmentNumber: true,
  orderId: true,
  status: true,
  provider: true,
  awbNumber: true,
  shippedAt: true,
  deliveredAt: true,
  items: { select: { orderItemId: true, quantity: true } },
  order: {
    select: {
      id: true,
      orderNumber: true,
      userId: true,
      grandTotal: true,
      paymentMethod: true,
      customerPhoneSnapshot: true,
      user: { select: { firstName: true, email: true, phone: true } },
    },
  },
} satisfies Prisma.ShipmentSelect;
type ShipmentCore = Prisma.ShipmentGetPayload<{ select: typeof CORE_SELECT }>;

const DETAIL_INCLUDE = {
  items: {
    include: { orderItem: { select: { productName: true, variantName: true, sku: true } } },
  },
  trackingEvents: { orderBy: { eventAt: 'asc' } },
  order: { select: { id: true, orderNumber: true, status: true } },
  shippingMethod: { select: { id: true, code: true, name: true } },
} satisfies Prisma.ShipmentInclude;
type ShipmentDetailRow = Prisma.ShipmentGetPayload<{ include: typeof DETAIL_INCLUDE }>;

const LIST_INCLUDE = {
  order: { select: { id: true, orderNumber: true } },
  _count: { select: { items: true } },
} satisfies Prisma.ShipmentInclude;
type ShipmentListRow = Prisma.ShipmentGetPayload<{ include: typeof LIST_INCLUDE }>;

const ORDER_FOR_SHIPMENT = {
  id: true,
  orderNumber: true,
  status: true,
  shippingMethodId: true,
  paymentMethod: true,
  grandTotal: true,
  shippingAddressSnapshot: true,
  items: { select: { id: true, quantity: true, quantityCancelled: true } },
  shipments: { select: { status: true, items: { select: { orderItemId: true, quantity: true } } } },
} satisfies Prisma.OrderSelect;
type OrderForShipment = Prisma.OrderGetPayload<{ select: typeof ORDER_FOR_SHIPMENT }>;

export interface PlannedItem {
  readonly orderItemId: string;
  readonly quantity: number;
}

/** Pure: shipment lines from the request (or all unshipped), validated against the order. */
export function planShipmentItems(
  order: Pick<OrderForShipment, 'items' | 'shipments'>,
  requested: readonly PlannedItem[] | undefined,
): PlannedItem[] {
  const allocated = new Map<string, number>();
  for (const s of order.shipments) {
    if (s.status === 'CANCELLED') continue;
    for (const it of s.items) {
      allocated.set(it.orderItemId, (allocated.get(it.orderItemId) ?? 0) + it.quantity);
    }
  }
  const remaining = new Map(
    order.items.map((i) => [i.id, i.quantity - i.quantityCancelled - (allocated.get(i.id) ?? 0)]),
  );
  let plan: PlannedItem[];
  if (requested === undefined) {
    plan = [...remaining.entries()]
      .filter(([, qty]) => qty > 0)
      .map(([orderItemId, quantity]) => ({ orderItemId, quantity }));
  } else {
    const seen = new Set<string>();
    requested.forEach((item, index) => {
      const field = `items[${String(index)}]`;
      const left = remaining.get(item.orderItemId);
      if (left === undefined || seen.has(item.orderItemId)) {
        const message =
          left === undefined ? 'Item does not belong to this order.' : 'Item listed twice.';
        throw new AppError('VALIDATION_ERROR', message, {
          details: [{ field: `${field}.orderItemId`, message }],
        });
      }
      seen.add(item.orderItemId);
      if (item.quantity > left) {
        const message = `Only ${String(Math.max(0, left))} unit(s) are left to ship.`;
        throw new AppError('VALIDATION_ERROR', message, {
          details: [
            {
              field: `${field}.quantity`,
              message,
              code: 'QUANTITY_EXCEEDS_UNSHIPPED',
              meta: { remaining: Math.max(0, left) },
            },
          ],
        });
      }
    });
    plan = requested.map((i) => ({ orderItemId: i.orderItemId, quantity: i.quantity }));
  }
  if (plan.length === 0) {
    throw new AppError('CONFLICT', 'Every item of this order is already in a shipment.', {
      details: [{ message: 'Nothing left to ship.', code: 'NOTHING_TO_SHIP' }],
    });
  }
  return plan;
}

function assertOrderShippable(order: OrderForShipment, partial: boolean): void {
  const allowed = partial ? ['PACKED', 'PROCESSING'] : ['PACKED'];
  if (!allowed.includes(order.status)) {
    throw new AppError(
      'INVALID_STATE_TRANSITION',
      partial
        ? 'Shipments can be created for packed or processing orders only.'
        : 'The order must be packed before a full shipment is created.',
      {
        details: [
          {
            message: 'Order status does not allow shipping.',
            meta: { status: order.status, allowed },
          },
        ],
      },
    );
  }
}

function pincodeOf(snapshot: unknown): string {
  if (typeof snapshot === 'object' && snapshot !== null && 'pincode' in snapshot) {
    const value = snapshot.pincode;
    if (typeof value === 'string') return value;
  }
  return '';
}

export interface ShipmentListItemDto {
  readonly id: string;
  readonly shipmentNumber: string;
  readonly order: { readonly id: string; readonly orderNumber: string };
  readonly status: ShipmentStatus;
  readonly courier: string | null;
  readonly awb: string | null;
  readonly trackingUrl: string | null;
  readonly itemCount: number;
  readonly shippedAt: string | null;
  readonly deliveredAt: string | null;
  readonly createdAt: string;
}

export interface ShipmentDetailDto extends Omit<ShipmentListItemDto, 'order' | 'itemCount'> {
  readonly order: { readonly id: string; readonly orderNumber: string; readonly status: string };
  readonly bookedVia: string | null;
  readonly shippingMethod: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
  } | null;
  readonly items: readonly {
    readonly orderItemId: string;
    readonly productName: string;
    readonly variantName: string | null;
    readonly sku: string;
    readonly quantity: number;
  }[];
  readonly events: readonly {
    readonly id: string;
    readonly status: ShipmentStatus;
    readonly providerStatus: string | null;
    readonly description: string | null;
    readonly location: string | null;
    readonly source: ActorType;
    readonly at: string;
  }[];
  readonly allowedTransitions: readonly ShipmentStatus[];
}

export interface ShipmentServiceDeps {
  readonly providers: ShippingProviderRegistry;
  /** Adapter used for bookings, serviceability and tracking URLs (SHIPPING_PROVIDER). */
  readonly defaultProvider: string;
  readonly notifications: NotificationService;
}

export function createShipmentsService(container: AppContainer, deps: ShipmentServiceDeps) {
  const { db, audit, clock, logger, config } = container;
  const adapterNames = new Set(deps.providers.keys());
  const provider = deps.providers.get(deps.defaultProvider);
  if (provider === undefined) throw new Error(`Unknown shipping provider ${deps.defaultProvider}.`);
  const storefrontUrl = config.storefrontUrl.replace(/\/+$/, '');
  const advanceDeps = { audit, notifications: deps.notifications, storefrontUrl };

  function trackingUrlFor(row: {
    provider: string | null;
    awbNumber: string | null;
  }): string | null {
    if (row.awbNumber === null) return null;
    const { bookedVia } = splitProvider(row.provider, adapterNames);
    const adapter = deps.providers.get(bookedVia ?? deps.defaultProvider);
    return adapter?.trackingUrl(row.awbNumber) ?? null;
  }

  function toListDto(row: ShipmentListRow): ShipmentListItemDto {
    return {
      id: row.id,
      shipmentNumber: row.shipmentNumber,
      order: { id: row.order.id, orderNumber: row.order.orderNumber },
      status: row.status,
      courier: splitProvider(row.provider, adapterNames).courier,
      awb: row.awbNumber,
      trackingUrl: trackingUrlFor(row),
      itemCount: row._count.items,
      shippedAt: row.shippedAt?.toISOString() ?? null,
      deliveredAt: row.deliveredAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  function toDetailDto(row: ShipmentDetailRow): ShipmentDetailDto {
    const { courier, bookedVia } = splitProvider(row.provider, adapterNames);
    return {
      id: row.id,
      shipmentNumber: row.shipmentNumber,
      order: { id: row.order.id, orderNumber: row.order.orderNumber, status: row.order.status },
      status: row.status,
      courier,
      bookedVia,
      awb: row.awbNumber,
      trackingUrl: trackingUrlFor(row),
      shippingMethod: row.shippingMethod,
      items: row.items.map((i) => ({
        orderItemId: i.orderItemId,
        productName: i.orderItem.productName,
        variantName: i.orderItem.variantName,
        sku: i.orderItem.sku,
        quantity: i.quantity,
      })),
      events: row.trackingEvents.map((e) => ({
        id: e.id,
        status: e.mappedStatus,
        providerStatus: e.providerStatus,
        description: e.message,
        location: e.location,
        source: e.source,
        at: e.eventAt.toISOString(),
      })),
      allowedTransitions: SHIPMENT_TRANSITIONS[row.status],
      shippedAt: row.shippedAt?.toISOString() ?? null,
      deliveredAt: row.deliveredAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async function loadDetail(q: Queryable, id: string): Promise<ShipmentDetailDto> {
    const row = await q.shipment.findUnique({ where: { id }, include: DETAIL_INCLUDE });
    if (row === null) throw new AppError('NOT_FOUND', 'Shipment not found.');
    return toDetailDto(row);
  }

  async function loadCore(q: Queryable, id: string): Promise<ShipmentCore> {
    const row = await q.shipment.findUnique({ where: { id }, select: CORE_SELECT });
    if (row === null) throw new AppError('NOT_FOUND', 'Shipment not found.');
    return row;
  }

  async function loadOrder(q: Queryable, orderId: string): Promise<OrderForShipment> {
    const order = await q.order.findUnique({ where: { id: orderId }, select: ORDER_FOR_SHIPMENT });
    if (order === null) throw new AppError('NOT_FOUND', 'Order not found.');
    return order;
  }

  async function assertAwbFree(
    tx: Queryable,
    awb: string,
    courier: string | null,
    selfId?: string,
  ): Promise<void> {
    const clash = await tx.shipment.findFirst({
      where: {
        awbNumber: awb,
        provider: courier,
        ...(selfId === undefined ? {} : { id: { not: selfId } }),
      },
      select: { id: true },
    });
    if (clash !== null) {
      const message = 'This AWB is already used by another shipment of the same courier.';
      throw new AppError('DUPLICATE_RESOURCE', message, {
        details: [{ field: 'awb', message, code: 'DUPLICATE' }],
      });
    }
  }

  async function enqueueShipmentNotification(
    tx: TxClient,
    shipment: ShipmentCore,
    event: 'ORDER_SHIPPED' | 'ORDER_OUT_FOR_DELIVERY',
    awb: string | null,
  ): Promise<void> {
    const { order } = shipment;
    await deps.notifications.enqueue(tx, {
      event,
      channels: ['EMAIL', 'WHATSAPP'],
      recipientUserId: order.userId,
      to: { email: order.user.email, phone: order.user.phone ?? order.customerPhoneSnapshot },
      entityType: 'ORDER',
      entityId: order.id,
      discriminator: shipment.id,
      variables: {
        firstName: order.user.firstName,
        orderNumber: order.orderNumber,
        orderUrl: `${storefrontUrl}/orders/${order.orderNumber}`,
        amount: toMoneyString(order.grandTotal),
        shipmentNumber: shipment.shipmentNumber,
        courier: splitProvider(shipment.provider, adapterNames).courier,
        awb,
        trackingUrl: trackingUrlFor({ provider: shipment.provider, awbNumber: awb }),
        ...(event === 'ORDER_OUT_FOR_DELIVERY' && order.paymentMethod === 'COD'
          ? { codAmount: toMoneyString(order.grandTotal) }
          : {}),
      },
    });
  }

  /** Status change with all side effects (caller validated the transition). */
  async function changeStatus(
    tx: TxClient,
    shipment: ShipmentCore,
    to: ShipmentStatus,
    ctx: { actor: AuditActor; now: Date; note?: string | undefined },
  ): Promise<void> {
    const firstDispatch = DISPATCHED_STATUSES.has(to) && shipment.shippedAt === null;
    if (firstDispatch && shipment.awbNumber === null) {
      const message = 'Add the AWB number before marking the shipment as shipped.';
      throw new AppError('VALIDATION_ERROR', message, {
        details: [{ field: 'awb', message, code: 'AWB_REQUIRED' }],
      });
    }
    await tx.shipment.update({
      where: { id: shipment.id },
      data: {
        status: to,
        ...(firstDispatch ? { shippedAt: ctx.now } : {}),
        ...(to === 'DELIVERED' ? { deliveredAt: ctx.now } : {}),
      },
    });
    if (firstDispatch) {
      for (const item of shipment.items) {
        await tx.orderItem.update({
          where: { id: item.orderItemId },
          data: { quantityShipped: { increment: item.quantity } },
        });
      }
    }
    await audit.record(tx, ctx.actor, {
      action: 'STATUS_CHANGE',
      module: MODULE,
      entityType: ENTITY,
      entityId: shipment.id,
      before: { status: shipment.status },
      after: { status: to },
      reason: ctx.note,
      metadata: { entityLabel: shipment.shipmentNumber, orderNumber: shipment.order.orderNumber },
    });
    if (firstDispatch)
      await enqueueShipmentNotification(tx, shipment, 'ORDER_SHIPPED', shipment.awbNumber);
    if (to === 'OUT_FOR_DELIVERY') {
      await enqueueShipmentNotification(tx, shipment, 'ORDER_OUT_FOR_DELIVERY', shipment.awbNumber);
    }
    await advanceOrderForShipment(tx, advanceDeps, {
      orderId: shipment.orderId,
      shipmentStatus: to,
      actor: ctx.actor,
      now: ctx.now,
      note: ctx.note,
    });
  }

  async function recordTrackingEvent(
    tx: TxClient,
    shipment: ShipmentCore,
    event: {
      mappedStatus: ShipmentStatus;
      applyStatus: boolean;
      providerStatus: string | null;
      message: string | null;
      location: string | null;
      eventAt: Date;
      hash: string;
      source: ActorType;
      payload?: Prisma.InputJsonValue;
    },
    actor: AuditActor,
  ): Promise<{ duplicate: boolean; statusChanged: boolean }> {
    const existing = await tx.shipmentTrackingEvent.findUnique({
      where: { shipmentId_dedupeHash: { shipmentId: shipment.id, dedupeHash: event.hash } },
      select: { id: true },
    });
    if (existing !== null) return { duplicate: true, statusChanged: false };
    const latest = await tx.shipmentTrackingEvent.findFirst({
      where: { shipmentId: shipment.id },
      orderBy: { eventAt: 'desc' },
      select: { eventAt: true },
    });
    const now = clock();
    await tx.shipmentTrackingEvent.create({
      data: {
        id: randomUUID(),
        shipmentId: shipment.id,
        mappedStatus: event.mappedStatus,
        providerStatus: event.providerStatus?.slice(0, 100) ?? null,
        message: event.message?.slice(0, 500) ?? null,
        location: event.location?.slice(0, 200) ?? null,
        dedupeHash: event.hash,
        source: event.source,
        eventAt: event.eventAt,
        ...(event.payload === undefined ? {} : { payload: event.payload }),
        createdAt: now,
      },
    });
    const newest = latest === null || event.eventAt.getTime() >= latest.eventAt.getTime();
    const apply =
      event.applyStatus &&
      newest &&
      event.mappedStatus !== shipment.status &&
      canTransitionShipment(shipment.status, event.mappedStatus);
    if (apply) {
      await changeStatus(tx, shipment, event.mappedStatus, {
        actor,
        now,
        note: event.message ?? undefined,
      });
    }
    return { duplicate: false, statusChanged: apply };
  }

  /**
   * Applies courier events (webhook or poll), one transaction per event. The dedupe hash is
   * `sha256(provider:eventId)` regardless of source, so an event seen by both a webhook and a poll
   * is recorded once.
   */
  async function applyProviderEvents(
    providerName: string,
    events: readonly ShippingWebhookEvent[],
    actor: AuditActor,
    source: ActorType,
  ): Promise<{ processed: number; ignored: number; duplicates: number; statusChanges: number }> {
    let processed = 0;
    let ignored = 0;
    let duplicates = 0;
    let statusChanges = 0;
    for (const event of events) {
      const outcome = await withTransaction(db, async ({ tx }) => {
        const found = await tx.shipment.findFirst({
          where: { awbNumber: event.awb.toUpperCase() },
          select: { id: true },
        });
        if (found === null) return 'ignored' as const;
        const shipment = await loadCore(tx, found.id);
        const result = await recordTrackingEvent(
          tx,
          shipment,
          {
            mappedStatus: event.mappedStatus ?? shipment.status,
            applyStatus: event.mappedStatus !== null,
            providerStatus: event.providerStatus,
            message: event.message,
            location: event.location,
            eventAt: event.occurredAt,
            hash: dedupeHash(providerName, event.eventId),
            source,
            payload: {
              provider: providerName,
              eventId: event.eventId,
              status: event.providerStatus,
              occurredAt: event.occurredAt.toISOString(),
              location: event.location,
              message: event.message,
            },
          },
          actor,
        );
        if (result.duplicate) return 'duplicate' as const;
        return result.statusChanged ? ('changed' as const) : ('processed' as const);
      });
      if (outcome === 'ignored') {
        ignored += 1;
        logger.info({ provider: providerName, eventId: event.eventId }, 'tracking for unknown AWB');
      } else if (outcome === 'duplicate') duplicates += 1;
      else {
        processed += 1;
        if (outcome === 'changed') statusChanges += 1;
      }
    }
    return { processed, ignored, duplicates, statusChanges };
  }

  return {
    async list(
      query: ShipmentListQueryInput,
    ): Promise<{ items: ShipmentListItemDto[]; meta: PageMeta }> {
      const where: Prisma.ShipmentWhereInput = {
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.orderId === undefined ? {} : { orderId: query.orderId }),
        ...(query.courier === undefined ? {} : { provider: { contains: query.courier } }),
        ...(query.q === undefined
          ? {}
          : {
              OR: [
                { awbNumber: { contains: query.q.toUpperCase() } },
                { shipmentNumber: { contains: query.q.toUpperCase() } },
                { order: { orderNumber: { contains: query.q.toUpperCase() } } },
              ],
            }),
      };
      if (query.from !== undefined || query.to !== undefined) {
        where.createdAt = {
          ...(query.from === undefined ? {} : { gte: istDayRange(query.from).start }),
          ...(query.to === undefined ? {} : { lt: istDayRange(query.to).end }),
        };
      }
      const { skip, take } = toSkipTake(query.page, query.limit);
      const [rows, total] = await Promise.all([
        db.shipment.findMany({
          where,
          include: LIST_INCLUDE,
          orderBy: { createdAt: 'desc' },
          skip,
          take,
        }),
        db.shipment.count({ where }),
      ]);
      return { items: rows.map(toListDto), meta: buildPageMeta(query.page, query.limit, total) };
    },

    async get(id: string): Promise<ShipmentDetailDto> {
      return loadDetail(db, id);
    },

    async create(actor: AuditActor, input: CreateShipmentInput): Promise<ShipmentDetailDto> {
      const now = clock();
      const partial = input.items !== undefined;
      const preview = await loadOrder(db, input.orderId);
      assertOrderShippable(preview, partial);
      planShipmentItems(preview, input.items);
      if (input.shippingMethodId !== undefined) {
        const method = await db.shippingMethod.findUnique({
          where: { id: input.shippingMethodId },
          select: { id: true, deletedAt: true },
        });
        if (method?.deletedAt !== null) {
          const message = 'Shipping method not found.';
          throw new AppError('VALIDATION_ERROR', message, {
            details: [{ field: 'shippingMethodId', message }],
          });
        }
      }

      let booking: CreateProviderShipmentResult | undefined;
      if (input.createWithProvider) {
        booking = await provider.createShipment({
          reference: preview.orderNumber,
          pincode: pincodeOf(preview.shippingAddressSnapshot),
          weightGrams: input.packageWeightGrams,
          dimensionsCm: input.dimensionsCm,
          codAmount:
            preview.paymentMethod === 'COD' ? toMoneyString(preview.grandTotal) : undefined,
        });
      }

      try {
        const id = await withTransaction(db, async ({ tx }) => {
          await tx.$queryRaw`SELECT id FROM orders WHERE id = ${input.orderId} FOR UPDATE`;
          const order = await loadOrder(tx, input.orderId);
          assertOrderShippable(order, partial);
          const plan = planShipmentItems(order, input.items);
          const courier = (
            booking === undefined ? (input.courier ?? '') : `${provider.name}:${booking.courier}`
          ).slice(0, 30);
          const awb = booking?.awb ?? input.awb ?? null;
          if (awb !== null) await assertAwbFree(tx, awb, courier);
          const shipmentId = randomUUID();
          const shipmentNumber = await allocateNumber(tx, 'SHIPMENT', now);
          const status: ShipmentStatus = awb === null ? 'PENDING' : 'READY_TO_SHIP';
          await tx.shipment.create({
            data: {
              id: shipmentId,
              shipmentNumber,
              orderId: order.id,
              shippingMethodId: input.shippingMethodId ?? order.shippingMethodId,
              status,
              provider: courier,
              awbNumber: awb,
              createdAt: now,
            },
          });
          await tx.shipmentItem.createMany({
            data: plan.map((p) => ({
              shipmentId,
              orderItemId: p.orderItemId,
              quantity: p.quantity,
            })),
          });
          await audit.record(tx, actor, {
            action: 'CREATE',
            module: MODULE,
            entityType: ENTITY,
            entityId: shipmentId,
            after: { shipmentNumber, orderId: order.id, status, provider: courier, awbNumber: awb },
            metadata: {
              entityLabel: shipmentNumber,
              orderNumber: order.orderNumber,
              items: plan,
              packageWeightGrams: input.packageWeightGrams,
              ...(input.dimensionsCm === undefined ? {} : { dimensionsCm: input.dimensionsCm }),
              bookedWithProvider: booking !== undefined,
            },
          });
          return shipmentId;
        });
        return await loadDetail(db, id);
      } catch (error) {
        if (booking !== undefined) {
          const awb = booking.awb;
          await provider.cancelShipment(awb).catch((cancelError: unknown) => {
            logger.error({ err: cancelError, awb }, 'could not cancel orphaned provider booking');
          });
        }
        throw error;
      }
    },

    async update(
      actor: AuditActor,
      id: string,
      input: UpdateShipmentInput,
    ): Promise<ShipmentDetailDto> {
      const current = await loadCore(db, id);
      const target = input.status;
      if (target !== undefined && target !== current.status) {
        if (!canTransitionShipment(current.status, target)) {
          throw new AppError(
            'INVALID_STATE_TRANSITION',
            `Cannot move a ${current.status} shipment to ${target}.`,
            {
              details: [
                {
                  message: 'Transition not allowed.',
                  meta: { allowed: SHIPMENT_TRANSITIONS[current.status] },
                },
              ],
            },
          );
        }
      }
      const preDispatch = current.status === 'PENDING' || current.status === 'READY_TO_SHIP';
      if ((input.awb !== undefined || input.courier !== undefined) && !preDispatch) {
        throw new AppError(
          'INVALID_STATE_TRANSITION',
          'Courier and AWB cannot change after dispatch.',
        );
      }
      // A18: a provider booking is cancelled with the provider first; failure blocks the cancel.
      const { bookedVia } = splitProvider(current.provider, adapterNames);
      if (target === 'CANCELLED' && bookedVia !== null && current.awbNumber !== null) {
        const adapter = deps.providers.get(bookedVia);
        if (adapter !== undefined) await adapter.cancelShipment(current.awbNumber);
      }

      await withTransaction(db, async ({ tx }) => {
        const now = clock();
        let shipment = await loadCore(tx, id);
        if (shipment.status !== current.status) {
          throw new AppError('CONFLICT', 'The shipment changed meanwhile. Please reload.');
        }
        if (input.awb !== undefined || input.courier !== undefined) {
          const courier =
            input.courier === undefined ? shipment.provider : input.courier.slice(0, 30);
          const awb = input.awb ?? shipment.awbNumber;
          if (awb !== null) await assertAwbFree(tx, awb, courier, id);
          const autoReady = shipment.status === 'PENDING' && awb !== null && target === undefined;
          await tx.shipment.update({
            where: { id },
            data: {
              provider: courier,
              awbNumber: awb,
              ...(autoReady ? { status: 'READY_TO_SHIP' } : {}),
            },
          });
          await audit.record(tx, actor, {
            action: 'UPDATE',
            module: MODULE,
            entityType: ENTITY,
            entityId: id,
            before: {
              provider: shipment.provider,
              awbNumber: shipment.awbNumber,
              status: shipment.status,
            },
            after: {
              provider: courier,
              awbNumber: awb,
              status: autoReady ? 'READY_TO_SHIP' : shipment.status,
            },
            reason: input.note,
          });
          shipment = await loadCore(tx, id);
        }
        if (target !== undefined && target !== shipment.status) {
          if (!canTransitionShipment(shipment.status, target)) {
            throw new AppError(
              'INVALID_STATE_TRANSITION',
              `Cannot move a ${shipment.status} shipment to ${target}.`,
            );
          }
          await tx.shipmentTrackingEvent.create({
            data: {
              id: randomUUID(),
              shipmentId: id,
              mappedStatus: target,
              providerStatus: null,
              message: input.note?.slice(0, 500) ?? 'Status updated by staff',
              location: null,
              dedupeHash: dedupeHash('manual', randomUUID()),
              source: 'STAFF',
              eventAt: now,
              createdAt: now,
            },
          });
          await changeStatus(tx, shipment, target, { actor, now, note: input.note });
        }
      });
      return loadDetail(db, id);
    },

    async addTrackingEvent(
      actor: AuditActor,
      id: string,
      input: TrackingEventInput,
    ): Promise<ShipmentDetailDto> {
      const occurredAt = new Date(input.occurredAt);
      if (occurredAt.getTime() > clock().getTime() + 60_000) {
        const message = 'The event time cannot be in the future.';
        throw new AppError('VALIDATION_ERROR', message, {
          details: [{ field: 'occurredAt', message }],
        });
      }
      await withTransaction(db, async ({ tx }) => {
        const shipment = await loadCore(tx, id);
        if (
          input.status !== shipment.status &&
          !canTransitionShipment(shipment.status, input.status)
        ) {
          throw new AppError(
            'INVALID_STATE_TRANSITION',
            `A ${input.status} event is not valid for a ${shipment.status} shipment.`,
            {
              details: [
                {
                  message: 'Transition not allowed.',
                  meta: { allowed: SHIPMENT_TRANSITIONS[shipment.status] },
                },
              ],
            },
          );
        }
        await recordTrackingEvent(
          tx,
          shipment,
          {
            mappedStatus: input.status,
            applyStatus: true,
            providerStatus: null,
            message: input.description,
            location: input.location ?? null,
            eventAt: occurredAt,
            hash: dedupeHash('manual', randomUUID()),
            source: 'STAFF',
          },
          actor,
        );
      });
      return loadDetail(db, id);
    },

    /**
     * Webhook entry (§5): verify signature on the raw bytes first, then parse; idempotent on the
     * provider event id; unknown AWBs / unmapped statuses are acknowledged and ignored.
     */
    async handleWebhook(
      providerKey: string,
      rawBody: unknown,
      headers: WebhookHeaders,
      meta: { ip?: string | undefined; requestId?: string | undefined },
    ): Promise<{ received: true; duplicate?: true; processed: number; ignored: number }> {
      const adapter = deps.providers.get(providerKey);
      // The mock adapter's secret is a public test value: never accept it in production.
      if (adapter === undefined || (adapter.name === 'mock' && config.nodeEnv === 'production')) {
        throw new AppError('NOT_FOUND', 'Unknown webhook provider.');
      }
      if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
        throw new AppError('UNAUTHENTICATED', 'Invalid signature.');
      }
      try {
        adapter.verifyWebhook(rawBody, headers, clock());
      } catch (error) {
        if (error instanceof WebhookSignatureError) {
          logger.warn(
            { provider: providerKey, reason: error.message, ip: meta.ip, security: true },
            'shipping webhook signature rejected',
          );
          throw new AppError('UNAUTHENTICATED', 'Invalid signature.');
        }
        throw error;
      }
      let events;
      try {
        events = adapter.parseWebhook(rawBody);
      } catch (error) {
        if (error instanceof WebhookPayloadError) {
          throw new AppError('BAD_REQUEST', 'Malformed webhook payload.');
        }
        throw error;
      }
      const actor: AuditActor = { ...WEBHOOK_ACTOR_BASE, ip: meta.ip, requestId: meta.requestId };
      const { processed, ignored, duplicates } = await applyProviderEvents(
        adapter.name,
        events,
        actor,
        'WEBHOOK',
      );
      return {
        received: true,
        ...(duplicates > 0 && processed === 0 && ignored === 0 ? { duplicate: true as const } : {}),
        processed,
        ignored,
      };
    },

    /**
     * `shipment-tracking-poll` (BACKEND_STRUCTURE §14, every 30 min): for adapters that implement
     * `getTracking` (couriers without webhooks, OQ-07), fetch tracking for dispatched, non-terminal
     * shipments booked through that adapter and apply it exactly like a webhook (source SYSTEM).
     * One shipment's courier error never stops the run; re-polling is idempotent (dedupe hash).
     *
     * D4 fairness: per adapter, rows are read in id order after a cursor (`after[adapter]`) that
     * the caller keeps between runs (`nextCursor`), so with more than `limit` shipments in flight
     * every shipment is polled in turn. A short page resets that adapter's cursor.
     */
    async pollTracking(
      options: {
        readonly limit?: number;
        readonly after?: Readonly<Record<string, string>>;
        /** Cooperative stop (Batch 9, WP-O2): checked before each shipment. */
        readonly signal?: AbortSignal | undefined;
      } = {},
    ): Promise<TrackingPollSummary> {
      const limit = options.limit ?? TRACKING_POLL_BATCH;
      const nextCursor: Record<string, string> = {};
      const summary = {
        adapters: 0,
        shipments: 0,
        events: 0,
        duplicates: 0,
        statusChanges: 0,
        errors: 0,
        nextCursor,
      };
      for (const adapter of deps.providers.values()) {
        const getTracking = adapter.getTracking;
        if (getTracking === undefined) continue;
        summary.adapters += 1;
        const after = options.after?.[adapter.name];
        const rows = await db.shipment.findMany({
          where: {
            status: { in: [...TRACKING_POLL_STATUSES] },
            awbNumber: { not: null },
            provider: { startsWith: `${adapter.name}:` },
            ...(after === undefined ? {} : { id: { gt: after } }),
          },
          select: { id: true, awbNumber: true },
          orderBy: { id: 'asc' },
          take: limit,
        });
        const last = rows.at(-1);
        if (rows.length === limit && last !== undefined) nextCursor[adapter.name] = last.id;
        for (const row of rows) {
          if (options.signal?.aborted === true) {
            logger.info({ provider: adapter.name }, 'tracking poll stopping early (shutdown)');
            return summary;
          }
          if (row.awbNumber === null) continue;
          summary.shipments += 1;
          try {
            const events = await withDeadline(getTracking(row.awbNumber), COURIER_TIMEOUT_MS);
            const own = events.filter((e) => e.awb.toUpperCase() === row.awbNumber?.toUpperCase());
            const r = await applyProviderEvents(adapter.name, own, SYSTEM_ACTOR, 'SYSTEM');
            summary.events += r.processed;
            summary.duplicates += r.duplicates;
            summary.statusChanges += r.statusChanges;
          } catch (error) {
            summary.errors += 1;
            logger.error(
              { err: error, shipmentId: row.id, provider: adapter.name },
              'tracking poll failed for one shipment (will retry next run)',
            );
          }
        }
      }
      return summary;
    },
  };
}

export type ShipmentsService = ReturnType<typeof createShipmentsService>;
