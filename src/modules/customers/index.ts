/**
 * Admin customers module — API_DOCUMENTATION.md §4.8.
 *
 * Customer-data export (`customers.export`) is delivered through the reports module in v1
 * (`POST /admin/reports/:reportKey/export`, §4.8 note) — no separate route here.
 */
import type { ModuleFactory } from '../types.js';
import { createCustomersRouter } from './customers.routes.js';
import { createCustomersService } from './customers.service.js';

export const createCustomersModule: ModuleFactory = (c) => ({
  name: 'customers',
  adminRouter: createCustomersRouter(c, createCustomersService(c)),
});
