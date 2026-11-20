/**
 * Dashboard module (B9) — `GET /admin/dashboard/summary` (REPORTING_AND_ANALYTICS.md §6).
 */
import type { ModuleFactory } from '../types.js';
import { createDashboardRouter } from './dashboard.routes.js';
import { createDashboardService } from './dashboard.service.js';

export const createDashboardModule: ModuleFactory = (c) => ({
  name: 'dashboard',
  adminRouter: createDashboardRouter(c, createDashboardService(c)),
});
