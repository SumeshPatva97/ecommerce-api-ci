/**
 * Reports module (B9) — admin reports, exports and export status. Read-only aggregate queries
 * (REPORTING_AND_ANALYTICS.md §2 G7). Async export worker: `src/jobs/reportExport.ts`.
 */
import type { ModuleFactory } from '../types.js';
import { createReportsRouter } from './reports.routes.js';
import { createReportsService } from './reports.service.js';

export const createReportsModule: ModuleFactory = (c) => ({
  name: 'reports',
  adminRouter: createReportsRouter(c, createReportsService(c)),
});
