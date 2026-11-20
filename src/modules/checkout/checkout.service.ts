/**
 * Checkout use-cases (B6) — API_DOCUMENTATION.md §3.9, BACKEND_STRUCTURE.md §7.
 *
 * `summary`: stateless quote (no stock / coupon reservation); remembers the quote fingerprint for
 * 1 h (in-memory store, single instance — D-38) so a later PRICE_CHANGED can show old vs new.
 *
 * `placeOrder` — ONE transaction:
 *   re-price cart (same `computeQuote`) → compare `quoteHash` (409 PRICE_CHANGED) → lock inventory
 *   rows ascending + availability (409 INSUFFICIENT_STOCK) → `orders` (`allocateNumber('ORDER')`,
 *   full customer/address/GST/pricing snapshots) → `order_items` (product/tax snapshots) →
 *   `order_status_history` → stock reservation (ONLINE, TTL OQ-17) or direct deduction (COD) →
 *   coupon usage RESERVED (coupon row locked; concurrent last redemption → 422 COUPON_INVALID) →
 *   `payments` PENDING → cart CONVERTED → ORDER_PLACED notification (outbox) → commit.
 *   AFTER commit: gateway session (`payments` module); failure → 201 with `payment: null` and
 *   warning `PAYMENT_SESSION_PENDING` (the order stays PENDING_PAYMENT; FE calls retry-payment).
 *
 * Tax snapshot (GST_AND_INVOICE_DATABASE_DESIGN §4): per-line HSN, rate, component rates/amounts,
 * taxable value on `order_items`; component totals, supply type, POS, seller/buyer GSTIN and the
 * settings in force (`pricing_context`) on `orders`. `tax_transactions` are invoice-time rows
 * (they require an `invoice_records` id) and are NOT written at placement.
 */
import { randomUUID } from 'node:crypto';

import type { AppContainer } from '../../container.js';
import { allocateNumber } from '../../core/db/sequences.js';
import { withTransaction, type TxClient } from '../../core/db/transaction.js';
import { AppError, type ErrorDetail } from '../../core/errors/AppError.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { initialOrderStatus } from '../../lib/orderStateMachine.js';
import { ZERO, toMoneyString, type Decimal } from '../../lib/money.js';
import { addMinutes } from '../../lib/time.js';
import {
  toTaxResultDto,
  type TaxComponentAmount,
  type TaxComponentCode,
} from '../../lib/tax/index.js';
import { createCouponsService, type CouponsService } from '../coupons/index.js';
import {
  createInventoryService,
  lockInventoryRows,
  type InventoryService,
} from '../inventory/index.js';
import { createAddressesService, type AddressDto } from '../me-addresses/index.js';
import { notificationServiceFor } from '../notifications/index.js';
import {
  createPaymentSessions,
  emailNotVerifiedError,
  notifyOrder,
  type NotifyContext,
  type PaymentSessionDto,
  type PaymentSessions,
} from '../payments/index.js';
import { createPricingInputLoader } from '../promotions/index.js';
import { buildShippingServices } from '../shipping/index.js';
import {
  checkoutValidation,
  computeQuote,
  fingerprintOf,
  priceChangedError,
  type CheckoutSummaryDto,
  type ComputedQuote,
  type PreparedCheckout,
  type QuoteDeps,
  type QuoteFingerprint,
  type QuoteRequest,
  type ServiceabilityDto,
} from './checkout.quote.js';
import { createCheckoutRepository } from './checkout.repository.js';
import type { PlaceOrderInput } from './checkout.schemas.js';

const QUOTE_TTL_SECONDS = 3600;

export interface CheckoutRequestMeta {
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}

export interface PlacedOrderDto {
  readonly order: {
    readonly id: string;
    readonly orderNumber: string;
    readonly status: string;
    readonly paymentMethod: 'ONLINE' | 'COD';
    readonly paymentStatus: string;
    readonly placedAt: string;
    readonly grandTotal: string;
    readonly currency: 'INR';
    readonly reservationExpiresAt: string | null;
  };
  readonly payment: PaymentSessionDto | null;
  readonly warnings?: readonly { code: string }[];
}

export interface CheckoutService {
  summary(userId: string, input: QuoteRequest): Promise<CheckoutSummaryDto>;
  placeOrder(
    userId: string,
    input: PlaceOrderInput,
    meta?: CheckoutRequestMeta,
  ): Promise<PlacedOrderDto>;
}

export interface CheckoutServiceDeps {
  readonly sessions?: PaymentSessions;
  readonly serviceability?: (pincode: string) => Promise<ServiceabilityDto>;
  readonly inventory?: InventoryService;
  readonly coupons?: CouponsService;
}

function addressSnapshot(a: AddressDto): Prisma.InputJsonValue {
  return {
    fullName: a.fullName,
    phone: a.phone,
    line1: a.line1,
    line2: a.line2,
    landmark: a.landmark,
    city: a.city,
    district: a.district,
    stateCode: a.stateCode,
    stateName: a.stateName,
    pincode: a.pincode,
    country: a.country,
    addressType: a.addressType,
    companyName: a.companyName,
    gstin: a.gstin,
  };
}

function componentOf(
  components: readonly TaxComponentAmount[],
  code: TaxComponentCode,
): { rate: Decimal; amount: Decimal } {
  const found = components.find((c) => c.component === code);
  return { rate: found?.ratePercent ?? ZERO, amount: found?.amount ?? ZERO };
}

export function createCheckoutService(
  container: AppContainer,
  deps: CheckoutServiceDeps = {},
): CheckoutService {
  const { db, clock, store, config } = container;
  const repo = createCheckoutRepository();
  const quoteDeps: QuoteDeps = { repo, loader: createPricingInputLoader() };
  const addresses = createAddressesService(container);
  const inventory =
    deps.inventory ??
    createInventoryService({
      clock,
      reservationTtlMinutes: config.integrations.reservationTtlMinutes,
    });
  const coupons = deps.coupons ?? createCouponsService(container);
  const sessions = deps.sessions ?? createPaymentSessions(container);
  const serviceability =
    deps.serviceability ??
    ((pincode: string) => buildShippingServices(container).methods.serviceability(pincode));
  const notify: NotifyContext = {
    notifications: notificationServiceFor(container),
    storefrontUrl: config.storefrontUrl,
  };

  const quoteKey = (userId: string, hash: string) => `checkout:quote:${userId}:${hash}`;

  async function prepare(userId: string, request: QuoteRequest): Promise<PreparedCheckout> {
    const own = await addresses.list(userId);
    const shippingAddress = own.find((a) => a.id === request.shippingAddressId);
    const billingAddress =
      request.billingAddressId === undefined
        ? shippingAddress
        : own.find((a) => a.id === request.billingAddressId);
    if (shippingAddress === undefined || billingAddress === undefined) {
      throw new AppError('NOT_FOUND', 'Address not found.');
    }
    const svc = await serviceability(shippingAddress.pincode);
    if (svc.serviceable === false) {
      throw checkoutValidation(
        'PINCODE_NOT_SERVICEABLE',
        'We do not deliver to this pincode yet.',
        'shippingAddressId',
      );
    }
    return { userId, request, shippingAddress, billingAddress, serviceability: svc };
  }

  /** A coupon that no longer applies is detached from the cart (API §3.9) — outside any tx. */
  async function detachOnCouponError<T>(userId: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof AppError && error.code === 'COUPON_INVALID') {
        await db.cart.updateMany({
          where: { userId, status: 'ACTIVE' },
          data: { couponId: null, couponCode: null },
        });
      }
      throw error;
    }
  }

  async function assertCustomer(userId: string) {
    const user = await repo.findCustomer(db, userId);
    if (user === null) throw new AppError('UNAUTHENTICATED', 'Please sign in to continue.');
    if (user.status === 'PENDING_VERIFICATION' || user.emailVerifiedAt === null) {
      throw emailNotVerifiedError();
    }
    if (user.status !== 'ACTIVE') {
      throw new AppError('FORBIDDEN', undefined, {
        details: [{ code: 'ACCOUNT_DISABLED', message: 'This account cannot place orders.' }],
      });
    }
    return user;
  }

  function lockAndCheckStock(
    locked: Awaited<ReturnType<typeof lockInventoryRows>>,
    quote: ComputedQuote,
  ): void {
    const details: ErrorDetail[] = [];
    for (const line of quote.lines) {
      const row = locked.get(line.item.variantId);
      const available = row === undefined ? 0 : Math.max(0, row.onHand - row.reserved);
      if (line.priced.quantity > available) {
        details.push({
          field: 'quantity',
          code: 'INSUFFICIENT_STOCK',
          message: 'Requested quantity exceeds available stock.',
          meta: {
            variantId: line.item.variantId,
            sku: line.item.variant.sku,
            requested: line.priced.quantity,
            available,
          },
        });
      }
    }
    if (details.length > 0) {
      throw new AppError('INSUFFICIENT_STOCK', 'Some items in your cart are no longer available.', {
        details,
      });
    }
  }

  async function writeOrder(
    tx: TxClient,
    args: {
      quote: ComputedQuote;
      prepared: PreparedCheckout;
      input: PlaceOrderInput;
      customer: Awaited<ReturnType<typeof assertCustomer>>;
      meta: CheckoutRequestMeta;
      now: Date;
    },
  ) {
    const { quote, prepared, input, customer, meta, now } = args;
    const method = input.paymentMethod;
    const status = initialOrderStatus(method);
    const totals = quote.tax.totals;
    if (method === 'ONLINE' && totals.grandTotal.lte(0)) {
      throw checkoutValidation('ORDER_TOTAL_ZERO', 'This order has nothing to pay online.');
    }
    const orderId = randomUUID();
    const orderNumber = await allocateNumber(tx, 'ORDER', now);
    // FR-AD-008: TTL from `checkout.reservation_ttl_minutes`, else the configured env TTL.
    const expiresAt =
      method === 'ONLINE'
        ? addMinutes(
            now,
            await repo.reservationTtlMinutes(tx, config.integrations.reservationTtlMinutes),
          )
        : null;
    const customerName = [customer.firstName, customer.lastName].filter(Boolean).join(' ');
    const customerPhone = customer.phone ?? prepared.shippingAddress.phone;
    const promotionIds = [
      ...new Set(
        quote.lines.flatMap((l) => (l.priced.promotion === null ? [] : [l.priced.promotion.id])),
      ),
    ];

    await tx.order.create({
      data: {
        id: orderId,
        orderNumber,
        userId: prepared.userId,
        status,
        paymentMethod: method,
        paymentStatus: 'PENDING',
        currency: 'INR',
        itemCount: quote.lines.length,
        totalQuantity: quote.lines.reduce((n, l) => n + l.priced.quantity, 0),
        subtotal: quote.pricing.totals.subtotal,
        itemDiscountTotal: quote.pricing.totals.itemDiscountTotal,
        couponDiscountTotal: quote.pricing.totals.couponDiscountTotal,
        shippingCharge: quote.shipping.charge,
        shippingDiscount: quote.shipping.discount,
        codCharge: quote.shipping.codCharge,
        taxableTotal: totals.taxableTotal,
        cgstTotal: totals.cgstTotal,
        sgstTotal: totals.sgstTotal,
        utgstTotal: totals.utgstTotal,
        igstTotal: totals.igstTotal,
        taxTotal: totals.taxTotal,
        roundOff: totals.roundOff,
        grandTotal: totals.grandTotal,
        pricesIncludeTax: quote.settings.pricesIncludeTax,
        couponId: quote.coupon?.couponId ?? null,
        couponCodeSnapshot: quote.coupon?.code ?? null,
        shippingMethodId: quote.method.id,
        shippingMethodNameSnapshot: quote.method.name,
        supplyType: quote.tax.supplyType,
        placeOfSupplyStateCode: quote.placeOfSupply.code,
        sellerGstinSnapshot: quote.settings.sellerGstin,
        sellerStateCodeSnapshot: quote.settings.sellerStateCode,
        buyerGstin: input.buyerGstin ?? null,
        buyerLegalName:
          input.buyerGstin === null || input.buyerGstin === undefined
            ? null
            : (prepared.billingAddress.companyName ?? prepared.billingAddress.fullName),
        customerNameSnapshot: customerName.slice(0, 160),
        customerEmailSnapshot: customer.email,
        customerPhoneSnapshot: customerPhone,
        billingAddressSnapshot: addressSnapshot(prepared.billingAddress),
        shippingAddressSnapshot: addressSnapshot(prepared.shippingAddress),
        pricingContext: {
          schemaVersion: 1,
          pricesIncludeTax: quote.settings.pricesIncludeTax,
          roundingMode: quote.settings.roundingMode,
          invoiceRoundOff: quote.settings.invoiceRoundOff,
          shippingTaxTreatment: quote.settings.shippingTaxTreatment,
          promotionStackingPolicy: 'BEST_SINGLE_PER_ITEM',
          couponPolicy: 'ONE_PER_ORDER_AFTER_PROMOTIONS',
          appliedPromotionIds: promotionIds,
          quoteHash: quote.hash,
          computedAt: now.toISOString(),
          /** Full GST engine result (lines + shipping allocations) for invoices. */
          taxResult: toTaxResultDto(quote.tax) as Prisma.InputJsonValue,
        },
        customerNote:
          input.customerNote === undefined || input.customerNote === '' ? null : input.customerNote,
        reservationExpiresAt: expiresAt,
        placedAt: now,
        confirmedAt: status === 'CONFIRMED' ? now : null,
        ipAddress: meta.ip?.slice(0, 45) ?? null,
        userAgent: meta.userAgent?.slice(0, 255) ?? null,
        createdAt: now,
      },
      select: { id: true },
    });

    await tx.orderItem.createMany({
      data: quote.lines.map((l, index) => {
        const v = l.item.variant;
        const cgst = componentOf(l.tax.components, 'CGST');
        const sgst = componentOf(l.tax.components, 'SGST');
        const utgst = componentOf(l.tax.components, 'UTGST');
        const igst = componentOf(l.tax.components, 'IGST');
        return {
          orderId,
          lineNo: index + 1,
          productId: v.productId,
          variantId: v.id,
          productName: v.product.name,
          variantName: v.name,
          sku: v.sku,
          barcode: v.barcode,
          attributesSnapshot: v.variantValues.map((av) => ({
            attribute: av.attribute.name,
            code: av.attribute.code,
            value: av.attributeValue.value,
          })),
          imageUrl: v.images[0]?.url ?? v.product.images[0]?.url ?? null,
          categoryIdSnapshot: v.product.categoryId,
          categoryNameSnapshot: v.product.category.name,
          brandIdSnapshot: v.product.brandId,
          brandNameSnapshot: v.product.brand?.name ?? null,
          hsnCode: l.rate.hsnCode,
          quantity: l.priced.quantity,
          mrp: l.priced.mrp,
          unitPrice: l.priced.unitPrice,
          promotionId: l.priced.promotion?.id ?? null,
          promotionNameSnapshot: l.priced.promotion?.name ?? null,
          promotionDiscount: l.priced.promotionDiscount,
          couponDiscount: l.priced.couponDiscount,
          taxableValue: l.tax.taxableValue,
          taxRate: l.tax.ratePercent,
          cgstRate: cgst.rate,
          cgstAmount: cgst.amount,
          sgstRate: sgst.rate,
          sgstAmount: sgst.amount,
          utgstRate: utgst.rate,
          utgstAmount: utgst.amount,
          igstRate: igst.rate,
          igstAmount: igst.amount,
          taxAmount: l.tax.taxAmount,
          lineTotal: l.tax.total,
          taxRateIdSnapshot: l.rate.taxRateId,
          costPriceSnapshot: v.costPrice,
          weightGramsSnapshot: v.weightGrams,
          createdAt: now,
        };
      }),
    });

    await tx.orderStatusHistory.create({
      data: {
        orderId,
        eventType: 'STATUS_CHANGE',
        fromStatus: null,
        toStatus: status,
        note: 'Order placed.',
        isCustomerVisible: true,
        actorType: 'CUSTOMER',
        actorUserId: prepared.userId,
        createdAt: now,
      },
    });

    const stockLines = quote.lines.map((l) => ({
      variantId: l.item.variantId,
      quantity: l.priced.quantity,
      sku: l.item.variant.sku,
    }));
    if (expiresAt !== null) await inventory.reserve(tx, stockLines, orderId, expiresAt);
    else await inventory.deductDirect(tx, stockLines, orderId);

    if (quote.coupon !== null) {
      await coupons.reserveUsage(
        tx,
        quote.coupon.couponId,
        prepared.userId,
        orderId,
        quote.pricing.totals.couponDiscountTotal,
      );
      if (status === 'CONFIRMED') await coupons.redeem(tx, orderId);
    }

    let paymentId: string | null = null;
    if (totals.grandTotal.gt(0)) {
      paymentId = randomUUID();
      await tx.payment.create({
        data: {
          id: paymentId,
          orderId,
          attemptNo: 1,
          paymentMethod: method,
          status: 'PENDING',
          amount: totals.grandTotal,
          currency: 'INR',
          expiresAt,
          createdAt: now,
        },
        select: { id: true },
      });
    }

    await tx.cart.update({
      where: { id: quote.cart.id },
      data: { status: 'CONVERTED', convertedOrderId: orderId, lastActivityAt: now },
      select: { id: true },
    });

    const orderRef = {
      id: orderId,
      orderNumber,
      userId: prepared.userId,
      grandTotal: totals.grandTotal,
      paymentMethod: method,
      customerNameSnapshot: customerName,
      customerEmailSnapshot: customer.email,
      customerPhoneSnapshot: customerPhone,
    };
    await notifyOrder(tx, notify, orderRef, 'ORDER_PLACED');
    if (status === 'CONFIRMED') await notifyOrder(tx, notify, orderRef, 'ORDER_CONFIRMED');

    return { orderId, orderNumber, status, paymentId, expiresAt, customerName, customerPhone };
  }

  return {
    async summary(userId, input) {
      const prepared = await prepare(userId, input);
      const quote = await detachOnCouponError(userId, () =>
        computeQuote(quoteDeps, db, prepared, clock()),
      );
      store.set(quoteKey(userId, quote.hash), fingerprintOf(quote), QUOTE_TTL_SECONDS);
      return quote.dto;
    },

    async placeOrder(userId, input, meta = {}) {
      const customer = await assertCustomer(userId);
      const prepared = await prepare(userId, input);
      const now = clock();
      const placed = await detachOnCouponError(userId, () =>
        withTransaction(db, async ({ tx }) => {
          const quote = await computeQuote(quoteDeps, tx, prepared, now);
          if (quote.hash !== input.quoteHash) {
            const previous = store.get(quoteKey(userId, input.quoteHash)) as
              QuoteFingerprint | undefined;
            throw priceChangedError(previous, quote);
          }
          lockAndCheckStock(
            await lockInventoryRows(
              tx,
              quote.lines.map((l) => l.item.variantId),
            ),
            quote,
          );
          const written = await writeOrder(tx, { quote, prepared, input, customer, meta, now });
          return { ...written, grandTotal: quote.tax.totals.grandTotal };
        }),
      );

      const order = {
        id: placed.orderId,
        orderNumber: placed.orderNumber,
        status: placed.status,
        paymentMethod: input.paymentMethod,
        paymentStatus: 'PENDING',
        placedAt: now.toISOString(),
        grandTotal: toMoneyString(placed.grandTotal),
        currency: 'INR' as const,
        reservationExpiresAt: placed.expiresAt?.toISOString() ?? null,
      };
      if (input.paymentMethod === 'COD' || placed.paymentId === null) {
        return { order, payment: null };
      }
      const payment = await sessions.open({
        orderId: placed.orderId,
        orderNumber: placed.orderNumber,
        paymentId: placed.paymentId,
        amount: placed.grandTotal,
        customer: { name: placed.customerName, email: customer.email, phone: placed.customerPhone },
      });
      return payment === null
        ? { order, payment: null, warnings: [{ code: 'PAYMENT_SESSION_PENDING' }] }
        : { order, payment };
    },
  };
}
