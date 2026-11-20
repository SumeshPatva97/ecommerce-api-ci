/**
 * Canonical order state machine — PROJECT_CONTEXT.md §5.1. Pure; shared by checkout, payments,
 * orders, refunds and shipping so no module invents transitions.
 *
 * Additions beyond the diagram (each PROVISIONAL, from the §12 working assumptions):
 * - PAYMENT_FAILED → CANCELLED: auto-cancel after the retry window / attempts (OQ-58).
 * Returns (DELIVERED → RETURN_REQUESTED → RETURNED) stay in the table but no v1 route uses them (OQ-11).
 */
import type { OrderStatus } from '../generated/prisma/enums.js';

export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  PENDING_PAYMENT: ['CONFIRMED', 'PAYMENT_FAILED'],
  PAYMENT_FAILED: ['PENDING_PAYMENT', 'CANCELLED'],
  CONFIRMED: ['PROCESSING', 'CANCELLATION_REQUESTED', 'CANCELLED'],
  PROCESSING: ['PACKED', 'CANCELLATION_REQUESTED', 'CANCELLED'],
  PACKED: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['OUT_FOR_DELIVERY'],
  OUT_FOR_DELIVERY: ['DELIVERED'],
  DELIVERED: ['RETURN_REQUESTED'],
  CANCELLATION_REQUESTED: ['CANCELLED', 'PROCESSING'],
  CANCELLED: [],
  RETURN_REQUESTED: ['RETURNED'],
  RETURNED: [],
};

/** Status an order starts in (COD only when enabled — OQ-06). */
export function initialOrderStatus(paymentMethod: 'ONLINE' | 'COD'): OrderStatus {
  return paymentMethod === 'COD' ? 'CONFIRMED' : 'PENDING_PAYMENT';
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

/** Customer self-service cancellation policy (OQ-12, PROVISIONAL). */
export function customerCancelMode(status: OrderStatus): 'DIRECT' | 'REQUEST' | 'NOT_ALLOWED' {
  if (status === 'CONFIRMED') return 'DIRECT';
  if (status === 'PROCESSING') return 'REQUEST';
  return 'NOT_ALLOWED';
}

/** Staff may cancel directly before SHIPPED (CONFIRMED, PROCESSING, PACKED). */
export function staffCanCancel(status: OrderStatus): boolean {
  return (
    canTransition(status, 'CANCELLED') &&
    status !== 'PAYMENT_FAILED' &&
    status !== 'CANCELLATION_REQUESTED'
  );
}

export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = ['CANCELLED', 'RETURNED'];
