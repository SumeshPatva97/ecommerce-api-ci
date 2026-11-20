/**
 * Audit-logs module (governance) — viewer and export. The audit *writer* is the shared
 * `audit.service.ts` in this directory (used by every module through the container).
 */
import type { ModuleFactory } from '../types.js';
import { createAuditLogsRouter } from './audit.routes.js';
import { createAuditLogsService } from './audit-logs.service.js';

export const createAuditLogsModule: ModuleFactory = (c) => ({
  name: 'audit-logs',
  adminRouter: createAuditLogsRouter(c, createAuditLogsService(c)),
});
