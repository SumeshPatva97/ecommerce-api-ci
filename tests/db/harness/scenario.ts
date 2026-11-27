/**
 * DEC-12 — small building blocks shared by the checkout scenarios (TC-030 / 041 / 048 / 051).
 */
import type { CustomerFixture } from './fixtures.js';
import {
  fetchQuoteHash,
  signInCustomer,
  type CheckoutSelection,
  type CustomerSession,
  type PlaceOrderRequest,
} from './http.js';
import type { DbWorld } from './world.js';

/** A signed-in customer with a fresh quote for the ACTIVE cart — ready to place an order. */
export interface Buyer {
  readonly customer: CustomerFixture;
  readonly session: CustomerSession;
  /** Body of `POST /checkout/orders` (without `acceptTerms`, added by `placeOrder`). */
  readonly order: PlaceOrderRequest;
}

/**
 * Signs every customer in and fetches the quote (`POST /checkout/summary`). Runs BEFORE the race:
 * a quote reserves nothing, so all customers hold a valid `quoteHash` for the same last unit /
 * last coupon redemption.
 */
export async function prepareBuyers(
  world: DbWorld,
  customers: readonly CustomerFixture[],
  options: { readonly shippingMethodId: string; readonly paymentMethod: 'ONLINE' | 'COD' },
): Promise<Buyer[]> {
  const buyers: Buyer[] = [];
  for (const customer of customers) {
    const session = await signInCustomer(world, customer.userId);
    const selection: CheckoutSelection = {
      shippingAddressId: customer.addressId,
      shippingMethodId: options.shippingMethodId,
      paymentMethod: options.paymentMethod,
    };
    const quoteHash = await fetchQuoteHash(world, session, selection);
    buyers.push({ customer, session, order: { ...selection, quoteHash } });
  }
  return buyers;
}

/** `items[index]` or a clear error (race callbacks receive an index). */
export function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`scenario index ${String(index)} out of range`);
  return item;
}
