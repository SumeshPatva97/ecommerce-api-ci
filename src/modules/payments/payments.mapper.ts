/**
 * Admin payment DTOs — API_DOCUMENTATION.md §4.11. Provider payloads are never returned (only
 * type / status / amount / reference per transaction); no card or UPI details exist anywhere
 * (SECURITY_GUIDELINES.md §10).
 */
import type { Decimal } from '../../lib/money.js';
import { toMoneyString, toMoneyStringOrNull } from '../../lib/money.js';

interface PaymentListRow {
  id: string;
  attemptNo: number;
  paymentMethod: string;
  status: string;
  amount: Decimal;
  amountRefunded: Decimal;
  provider: string | null;
  providerPaymentId: string | null;
  capturedAt: Date | null;
  createdAt: Date;
  order: { id: string; orderNumber: string };
}

export function toAdminPaymentItem(row: PaymentListRow) {
  return {
    id: row.id,
    orderId: row.order.id,
    orderNumber: row.order.orderNumber,
    attemptNo: row.attemptNo,
    method: row.paymentMethod,
    status: row.status,
    amount: toMoneyString(row.amount),
    refundedAmount: toMoneyString(row.amountRefunded),
    provider: row.provider,
    providerPaymentId: row.providerPaymentId,
    capturedAt: row.capturedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export type AdminPaymentItemDto = ReturnType<typeof toAdminPaymentItem>;

interface PaymentDetailRow {
  id: string;
  attemptNo: number;
  paymentMethod: string;
  status: string;
  amount: Decimal;
  amountRefunded: Decimal;
  currency: string;
  provider: string | null;
  providerOrderId: string | null;
  providerPaymentId: string | null;
  instrumentType: string | null;
  failureCode: string | null;
  failureReason: string | null;
  capturedAt: Date | null;
  failedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  order: { id: string; orderNumber: string; status: string; grandTotal: Decimal };
  transactions: {
    id: string;
    type: string;
    providerStatus: string | null;
    amount: Decimal | null;
    providerReference: string | null;
    providerEventId: string | null;
    signatureVerified: boolean;
    errorCode: string | null;
    createdAt: Date;
  }[];
}

export function toAdminPaymentDetail(row: PaymentDetailRow) {
  return {
    id: row.id,
    orderId: row.order.id,
    orderNumber: row.order.orderNumber,
    orderStatus: row.order.status,
    orderGrandTotal: toMoneyString(row.order.grandTotal),
    attemptNo: row.attemptNo,
    method: row.paymentMethod,
    status: row.status,
    amount: toMoneyString(row.amount),
    refundedAmount: toMoneyString(row.amountRefunded),
    currency: row.currency,
    provider: row.provider,
    providerOrderId: row.providerOrderId,
    providerPaymentId: row.providerPaymentId,
    instrumentType: row.instrumentType,
    failureCode: row.failureCode,
    failureReason: row.failureReason,
    capturedAt: row.capturedAt?.toISOString() ?? null,
    failedAt: row.failedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    transactions: row.transactions.map((t) => ({
      id: t.id,
      type: t.type,
      status: t.providerStatus,
      amount: toMoneyStringOrNull(t.amount),
      providerRef: t.providerReference,
      providerEventId: t.providerEventId,
      signatureVerified: t.signatureVerified,
      errorCode: t.errorCode,
      createdAt: t.createdAt.toISOString(),
    })),
  };
}

export type AdminPaymentDetailDto = ReturnType<typeof toAdminPaymentDetail>;
