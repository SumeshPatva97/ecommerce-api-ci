/** Inventory module (B4) — admin stock views/movements and the stock service used by checkout. */
import { notificationServiceFor } from '../notifications/index.js';
import type { ModuleFactory } from '../types.js';
import { createLowStockNotifier } from './inventory.alerts.js';
import { createInventoryAdminRouter } from './inventory.routes.js';
import { createInventoryAdminService } from './inventory.service.js';

export const createInventoryModule: ModuleFactory = (container) => {
  const service = createInventoryAdminService({
    db: container.db,
    audit: container.audit,
    clock: container.clock,
    logger: container.logger,
    notifyLowStock: createLowStockNotifier({
      db: container.db,
      permissions: container.permissions,
      notifications: notificationServiceFor(container),
      adminUrl: container.config.adminUrl,
      clock: container.clock,
      logger: container.logger,
    }),
  });
  return { name: 'inventory', adminRouter: createInventoryAdminRouter(container, service) };
};

export {
  StockWorkbench,
  createInventoryService,
  lockInventoryRows,
  loadLowStockDefault,
  refreshProductStockFlags,
  type InventoryService,
  type InventoryServiceDeps,
  type LedgerEntry,
  type LowStockCrossing,
  type ReleaseReason,
  type ReservationOutcome,
  type StockLine,
  type StockOptions,
  type StockOutcome,
} from './inventory.stock.js';
export {
  createInventoryAdminService,
  type InventoryAdminDeps,
  type InventoryAdminService,
} from './inventory.service.js';
