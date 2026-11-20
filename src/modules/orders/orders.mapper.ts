/**
 * Order DTOs — API_DOCUMENTATION.md §2.10 (totals), §3.10 (customer), §4.7 (admin). Money as
 * 2-dp strings, dates ISO UTC. Customer DTOs never expose internal notes, actor ids or payment
 * provider references; admin DTOs never expose provider payloads (masked by omission).
 */
import type { Prisma } from '../../generated/prisma/client.js';
import type { OrderStatus } from '../../generated/prisma/enums.js';
import { toMoneyString } from '../../lib/money.js';
import { ORDER_TRANSITIONS, customerCancelMode } from '../../lib/orderStateMachine.js';

export const CUSTOMER_LIST_SELECT = {
  orderNumber: true,
  status: true,
  paymentStatus: true,
  placedAt: true,
  grandTotal: true,
  itemCount: true,
  items: { select: { imageUrl: true }, orderBy: { lineNo: 'asc' }, take: 4 },
} as const satisfies Prisma.OrderSelect;

export const ADMIN_LIST_SELECT = {
  id: true,
  orderNumber: true,
  userId: true,
  status: true,
  paymentStatus: true,
  paymentMethod: true,
  grandTotal: true,
  itemCount: true,
  placedAt: true,
  customerNameSnapshot: true,
  customerEmailSnapshot: true,
  shippingAddressSnapshot: true,
} as const satisfies Prisma.OrderSelect;

export const DETAIL_SELECT = {
  id: true,
  orderNumber: true,
  userId: true,
  status: true,
  paymentMethod: true,
  paymentStatus: true,
  currency: true,
  itemCount: true,
  totalQuantity: true,
  subtotal: true,
  itemDiscountTotal: true,
  couponDiscountTotal: true,
  shippingCharge: true,
  shippingDiscount: true,
  codCharge: true,
  taxableTotal: true,
  cgstTotal: true,
  sgstTotal: true,
  utgstTotal: true,
  igstTotal: true,
  taxTotal: true,
  roundOff: true,
  grandTotal: true,
  refundedTotal: true,
  pricesIncludeTax: true,
  couponCodeSnapshot: true,
  shippingMethodNameSnapshot: true,
  supplyType: true,
  placeOfSupplyStateCode: true,
  buyerGstin: true,
  buyerLegalName: true,
  customerNameSnapshot: true,
  customerEmailSnapshot: true,
  customerPhoneSnapshot: true,
  billingAddressSnapshot: true,
  shippingAddressSnapshot: true,
  customerNote: true,
  placedAt: true,
  confirmedAt: true,
  shippedAt: true,
  deliveredAt: true,
  cancellationRequestedAt: true,
  cancelledAt: true,
  cancellationReason: true,
  items: {
    orderBy: { lineNo: 'asc' },
    select: {
      id: true,
      lineNo: true,
      productId: true,
      variantId: true,
      productName: true,
      variantName: true,
      sku: true,
      attributesSnapshot: true,
      imageUrl: true,
      hsnCode: true,
      quantity: true,
      mrp: true,
      unitPrice: true,
      promotionDiscount: true,
      couponDiscount: true,
      taxableValue: true,
      taxRate: true,
      cgstRate: true,
      cgstAmount: true,
      sgstRate: true,
      sgstAmount: true,
      utgstRate: true,
      utgstAmount: true,
      igstRate: true,
      igstAmount: true,
      taxAmount: true,
      lineTotal: true,
      quantityShipped: true,
      quantityCancelled: true,
      quantityRefunded: true,
    },
  },
  statusHistory: {
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      eventType: true,
      fromStatus: true,
      toStatus: true,
      note: true,
      isCustomerVisible: true,
      actorType: true,
      actorUserId: true,
      createdAt: true,
    },
  },
  payments: {
    orderBy: { attemptNo: 'asc' },
    select: {
      id: true,
      attemptNo: true,
      paymentMethod: true,
      status: true,
      provider: true,
      providerPaymentId: true,
      amount: true,
      amountRefunded: true,
      capturedAt: true,
      failedAt: true,
      createdAt: true,
      transactions: {
        orderBy: { createdAt: 'asc' },
        select: {
          type: true,
          providerStatus: true,
          amount: true,
          providerReference: true,
          createdAt: true,
        },
      },
    },
  },
  shipments: {
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      shipmentNumber: true,
      status: true,
      provider: true,
      awbNumber: true,
      shippedAt: true,
      deliveredAt: true,
    },
  },
  refunds: {
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      refundNumber: true,
      status: true,
      amount: true,
      method: true,
      createdAt: true,
    },
  },
  invoiceRecords: {
    orderBy: { createdAt: 'asc' },
    select: { id: true, invoiceNumber: true, invoiceType: true, createdAt: true },
  },
} as const satisfies Prisma.OrderSelect;

export type DetailRow = Prisma.OrderGetPayload<{ select: typeof DETAIL_SELECT }>;
type CustomerListRow = Prisma.OrderGetPayload<{ select: typeof CUSTOMER_LIST_SELECT }>;
type AdminListRow = Prisma.OrderGetPayload<{ select: typeof ADMIN_LIST_SELECT }>;

export interface ShipmentView {
  readonly courier: string | null;
  readonly trackingUrl: string | null;
}
export type ShipmentResolver = (row: {
  provider: string | null;
  awbNumber: string | null;
}) => ShipmentView;

function iso(d: Date | null): string | null {
  return d === null ? null : d.toISOString();
}

export function customerActions(status: OrderStatus) {
  const mode = customerCancelMode(status);
  return { canCancel: mode === 'DIRECT', canRequestCancellation: mode === 'REQUEST' };
}

export function toCustomerListItem(r: CustomerListRow) {
  return {
    orderNumber: r.orderNumber,
    status: r.status,
    paymentStatus: r.paymentStatus,
    placedAt: r.placedAt.toISOString(),
    grandTotal: toMoneyString(r.grandTotal),
    itemCount: r.itemCount,
    thumbnails: r.items.map((i) => i.imageUrl).filter((u): u is string => u !== null),
    actions: customerActions(r.status),
  };
}

function addressField(snapshot: unknown, key: 'city' | 'stateCode'): string | null {
  if (typeof snapshot !== 'object' || snapshot === null || !(key in snapshot)) return null;
  const value: unknown = (snapshot as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

export function toAdminListItem(r: AdminListRow) {
  return {
    id: r.id,
    orderNumber: r.orderNumber,
    customer: { id: r.userId, name: r.customerNameSnapshot, email: r.customerEmailSnapshot },
    status: r.status,
    paymentStatus: r.paymentStatus,
    paymentMethod: r.paymentMethod,
    grandTotal: toMoneyString(r.grandTotal),
    itemCount: r.itemCount,
    placedAt: r.placedAt.toISOString(),
    shippingCity: addressField(r.shippingAddressSnapshot, 'city'),
    shippingStateCode: addressField(r.shippingAddressSnapshot, 'stateCode'),
  };
}

function totals(r: DetailRow) {
  return {
    subtotal: toMoneyString(r.subtotal),
    itemDiscountTotal: toMoneyString(r.itemDiscountTotal),
    couponDiscountTotal: toMoneyString(r.couponDiscountTotal),
    shippingCharge: toMoneyString(r.shippingCharge),
    shippingDiscount: toMoneyString(r.shippingDiscount),
    codCharge: toMoneyString(r.codCharge),
    taxableTotal: toMoneyString(r.taxableTotal),
    cgstTotal: toMoneyString(r.cgstTotal),
    sgstTotal: toMoneyString(r.sgstTotal),
    utgstTotal: toMoneyString(r.utgstTotal),
    igstTotal: toMoneyString(r.igstTotal),
    taxTotal: toMoneyString(r.taxTotal),
    roundOff: toMoneyString(r.roundOff),
    grandTotal: toMoneyString(r.grandTotal),
    refundedTotal: toMoneyString(r.refundedTotal),
    pricesIncludeTax: r.pricesIncludeTax,
  };
}

function lineDto(i: DetailRow['items'][number]) {
  return {
    id: i.id,
    lineNo: i.lineNo,
    productId: i.productId,
    variantId: i.variantId,
    productName: i.productName,
    variantName: i.variantName,
    sku: i.sku,
    attributes: i.attributesSnapshot,
    imageUrl: i.imageUrl,
    hsnCode: i.hsnCode,
    quantity: i.quantity,
    mrp: toMoneyString(i.mrp),
    unitPrice: toMoneyString(i.unitPrice),
    promotionDiscount: toMoneyString(i.promotionDiscount),
    couponDiscount: toMoneyString(i.couponDiscount),
    taxableValue: toMoneyString(i.taxableValue),
    tax: {
      ratePercent: i.taxRate.toFixed(2),
      cgst: { rate: i.cgstRate.toFixed(2), amount: toMoneyString(i.cgstAmount) },
      sgst: { rate: i.sgstRate.toFixed(2), amount: toMoneyString(i.sgstAmount) },
      utgst: { rate: i.utgstRate.toFixed(2), amount: toMoneyString(i.utgstAmount) },
      igst: { rate: i.igstRate.toFixed(2), amount: toMoneyString(i.igstAmount) },
      taxAmount: toMoneyString(i.taxAmount),
    },
    lineTotal: toMoneyString(i.lineTotal),
    quantityShipped: i.quantityShipped,
    quantityCancelled: i.quantityCancelled,
    quantityRefunded: i.quantityRefunded,
  };
}

function invoices(r: DetailRow) {
  return r.invoiceRecords.map((d) => ({
    id: d.id,
    invoiceNumber: d.invoiceNumber,
    type: d.invoiceType,
    issuedAt: d.createdAt.toISOString(),
  }));
}

export function toCustomerDetail(r: DetailRow, resolve: ShipmentResolver) {
  const actions = customerActions(r.status);
  return {
    orderNumber: r.orderNumber,
    status: r.status,
    paymentMethod: r.paymentMethod,
    paymentStatus: r.paymentStatus,
    currency: r.currency,
    placedAt: r.placedAt.toISOString(),
    confirmedAt: iso(r.confirmedAt),
    shippedAt: iso(r.shippedAt),
    deliveredAt: iso(r.deliveredAt),
    cancelledAt: iso(r.cancelledAt),
    couponCode: r.couponCodeSnapshot,
    shippingMethod: r.shippingMethodNameSnapshot,
    customerNote: r.customerNote,
    billingAddress: r.billingAddressSnapshot,
    shippingAddress: r.shippingAddressSnapshot,
    items: r.items.map(lineDto),
    totals: totals(r),
    statusHistory: r.statusHistory
      .filter((h) => h.isCustomerVisible && h.eventType === 'STATUS_CHANGE' && h.toStatus !== null)
      .map((h) => ({ status: h.toStatus, at: h.createdAt.toISOString(), note: h.note })),
    payments: r.payments.map((p) => ({
      method: p.paymentMethod,
      status: p.status,
      amount: toMoneyString(p.amount),
      paidAt: iso(p.capturedAt),
    })),
    shipments: r.shipments.map((s) => {
      const view = resolve(s);
      return {
        shipmentNumber: s.shipmentNumber,
        status: s.status,
        courier: view.courier,
        awb: s.awbNumber,
        trackingUrl: view.trackingUrl,
      };
    }),
    invoices: invoices(r).map(({ invoiceNumber, type, issuedAt }) => ({
      invoiceNumber,
      type,
      issuedAt,
    })),
    refunds: r.refunds.map((f) => ({
      refundNumber: f.refundNumber,
      status: f.status,
      amount: toMoneyString(f.amount),
      method: f.method,
    })),
    actions: {
      ...actions,
      canRetryPayment: r.status === 'PENDING_PAYMENT' || r.status === 'PAYMENT_FAILED',
      reviewableProductIds:
        r.status === 'DELIVERED' ? [...new Set(r.items.map((i) => i.productId))] : [],
    },
  };
}

export function toAdminDetail(r: DetailRow, resolve: ShipmentResolver) {
  return {
    id: r.id,
    orderNumber: r.orderNumber,
    customer: {
      id: r.userId,
      name: r.customerNameSnapshot,
      email: r.customerEmailSnapshot,
      phone: r.customerPhoneSnapshot,
    },
    status: r.status,
    paymentMethod: r.paymentMethod,
    paymentStatus: r.paymentStatus,
    currency: r.currency,
    supplyType: r.supplyType,
    placeOfSupplyStateCode: r.placeOfSupplyStateCode,
    buyerGstin: r.buyerGstin,
    buyerLegalName: r.buyerLegalName,
    couponCode: r.couponCodeSnapshot,
    shippingMethod: r.shippingMethodNameSnapshot,
    customerNote: r.customerNote,
    billingAddress: r.billingAddressSnapshot,
    shippingAddress: r.shippingAddressSnapshot,
    placedAt: r.placedAt.toISOString(),
    confirmedAt: iso(r.confirmedAt),
    shippedAt: iso(r.shippedAt),
    deliveredAt: iso(r.deliveredAt),
    cancellationRequestedAt: iso(r.cancellationRequestedAt),
    cancelledAt: iso(r.cancelledAt),
    cancellationReason: r.cancellationReason,
    items: r.items.map(lineDto),
    totals: totals(r),
    statusHistory: r.statusHistory
      .filter((h) => h.eventType === 'STATUS_CHANGE')
      .map((h) => ({
        id: h.id,
        fromStatus: h.fromStatus,
        toStatus: h.toStatus,
        note: h.note,
        isCustomerVisible: h.isCustomerVisible,
        actor: { type: h.actorType, userId: h.actorUserId },
        at: h.createdAt.toISOString(),
      })),
    notes: r.statusHistory
      .filter((h) => h.eventType === 'NOTE')
      .map((h) => ({
        id: h.id,
        note: h.note,
        visibility: h.isCustomerVisible ? 'CUSTOMER' : 'INTERNAL',
        actor: { type: h.actorType, userId: h.actorUserId },
        at: h.createdAt.toISOString(),
      })),
    payments: r.payments.map((p) => ({
      id: p.id,
      attemptNo: p.attemptNo,
      method: p.paymentMethod,
      status: p.status,
      provider: p.provider,
      providerPaymentId: p.providerPaymentId,
      amount: toMoneyString(p.amount),
      amountRefunded: toMoneyString(p.amountRefunded),
      capturedAt: iso(p.capturedAt),
      failedAt: iso(p.failedAt),
      createdAt: p.createdAt.toISOString(),
      // Provider payloads are never returned (masked by omission).
      transactions: p.transactions.map((t) => ({
        type: t.type,
        status: t.providerStatus,
        amount: t.amount === null ? null : toMoneyString(t.amount),
        providerRef: t.providerReference,
        createdAt: t.createdAt.toISOString(),
      })),
    })),
    shipments: r.shipments.map((s) => {
      const view = resolve(s);
      return {
        id: s.id,
        shipmentNumber: s.shipmentNumber,
        status: s.status,
        courier: view.courier,
        awb: s.awbNumber,
        trackingUrl: view.trackingUrl,
        shippedAt: iso(s.shippedAt),
        deliveredAt: iso(s.deliveredAt),
      };
    }),
    invoices: invoices(r),
    refunds: r.refunds.map((f) => ({
      id: f.id,
      refundNumber: f.refundNumber,
      status: f.status,
      amount: toMoneyString(f.amount),
      method: f.method,
      createdAt: f.createdAt.toISOString(),
    })),
    auditTrail: { entityType: 'Order', entityId: r.id },
    allowedTransitions: [...ORDER_TRANSITIONS[r.status]],
  };
}

export type CustomerOrderDetail = ReturnType<typeof toCustomerDetail>;
export type AdminOrderDetail = ReturnType<typeof toAdminDetail>;
