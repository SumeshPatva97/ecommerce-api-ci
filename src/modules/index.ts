/**
 * Registered feature modules (mount order is irrelevant: paths do not overlap).
 * Added per increment (IMPLEMENTATION_ROADMAP.md §6.1).
 */
import { createAdminAuthModule } from './admin-auth/index.js';
import { createAttributesModule } from './attributes/index.js';
import { createAuditLogsModule } from './audit/index.js';
import { createCustomersModule } from './customers/index.js';
import { createDashboardModule } from './dashboard/index.js';
import { createReportsModule } from './reports/index.js';
import { createSettingsModule } from './settings/index.js';
import { createStaffModule } from './staff/index.js';
import { createAuthModule } from './auth/index.js';
import { createCatalogModule } from './catalog/index.js';
import { createMediaModule } from './media/index.js';
import { createProductsModule } from './products/index.js';
import { createMeProfileModule } from './me/index.js';
import { createBrandsModule } from './brands/index.js';
import { createCategoriesModule } from './categories/index.js';
import { createCollectionsModule } from './collections/index.js';
import { createBarcodesModule } from './barcodes/index.js';
import { createInventoryModule } from './inventory/index.js';
import { createTaxModule } from './tax/index.js';
import { createCartModule } from './cart/index.js';
import { createCouponsModule } from './coupons/index.js';
import { createMeAddressesModule } from './me-addresses/index.js';
import { createPromotionsModule } from './promotions/index.js';
import { createWishlistModule } from './wishlist/index.js';
import { createCmsModule } from './cms/index.js';
import { createNotificationsModule } from './notifications/index.js';
import { createReviewsModule } from './reviews/index.js';
import { createShippingModule } from './shipping/index.js';
import { createInvoicesModule } from './invoices/index.js';
import { createOrdersModule } from './orders/index.js';
import { createRefundsModule } from './refunds/index.js';
import { createCheckoutModule } from './checkout/index.js';
import { createPaymentsModule } from './payments/index.js';
import type { ModuleFactory } from './types.js';

export const MODULE_FACTORIES: readonly ModuleFactory[] = [
  // B1 — authentication & profile
  createAuthModule,
  createAdminAuthModule,
  createMeProfileModule,
  // B1 — staff & RBAC, governance
  createStaffModule,
  createCustomersModule,
  createSettingsModule,
  createAuditLogsModule,
  // B2 — catalog masters
  createCategoriesModule,
  createBrandsModule,
  createCollectionsModule,
  createAttributesModule,
  // B3 — products, media, public catalog
  createProductsModule,
  createMediaModule,
  createCatalogModule,
  // B2/B4 — tax, inventory, barcodes
  createTaxModule,
  createInventoryModule,
  createBarcodesModule,
  // B9 — reports & dashboard
  createReportsModule,
  createDashboardModule,
  // B5 — cart, wishlist, addresses, coupons, promotions
  createCartModule,
  createWishlistModule,
  createMeAddressesModule,
  createCouponsModule,
  createPromotionsModule,
  // B7/B8 — shipping, notifications, reviews, CMS
  createShippingModule,
  createNotificationsModule,
  createReviewsModule,
  createCmsModule,
  // B6/B7 — orders, refunds, invoices
  createOrdersModule,
  createRefundsModule,
  createInvoicesModule,
  // B6 — checkout & payments
  createCheckoutModule,
  createPaymentsModule,
];
