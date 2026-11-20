/**
 * Invoices module (B7) — tax invoices and credit notes. No routes of its own: documents are
 * downloaded through the orders module (`GET /me/orders/:orderNumber/invoice`,
 * `GET /admin/orders/:orderId/invoice`).
 *
 * Exports for other modules:
 * - `issueInvoiceForOrder(tx, orderId, now)` — shipping (order → SHIPPED), admin status route;
 * - `issueCreditNote(tx, …)` — cancellations and refund approval;
 * - `buildInvoicePdf` / `loadInvoiceDocument` / `renderInvoicePdf` — on-demand PDF rendering.
 */
import type { ModuleFactory } from '../types.js';

export const createInvoicesModule: ModuleFactory = () => ({ name: 'invoices' });

export {
  issueCreditNote,
  issueInvoiceForOrder,
  istDocumentDate,
  listOrderDocuments,
  type CreditNoteScope,
  type IssueCreditNoteInput,
  type IssuedDocument,
  type IssueOptions,
} from './invoices.service.js';
export {
  amountInWords,
  buildInvoicePdf,
  formatInr,
  istDisplayDate,
  loadInvoiceDocument,
  pdfFilename,
  renderInvoicePdf,
  type InvoiceDocumentData,
  type InvoiceLookup,
  type RenderOptions,
} from './invoices.pdf.js';
export {
  documentTotals,
  groupsFromRows,
  invoiceGroups,
  ledgerRows,
  prorateGroup,
  remainingGroups,
  type LedgerGroup,
  type LedgerOrderSnapshot,
} from './invoices.ledger.js';
