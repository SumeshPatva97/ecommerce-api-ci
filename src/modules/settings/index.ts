/**
 * Settings module — `GET/PATCH /admin/settings`, public `GET /settings/public`.
 */
import type { ModuleFactory } from '../types.js';
import { createSettingsAdminRouter, createSettingsPublicRouter } from './settings.routes.js';
import { createSettingsService } from './settings.service.js';

export const createSettingsModule: ModuleFactory = (c) => {
  const service = createSettingsService(c);
  return {
    name: 'settings',
    adminRouter: createSettingsAdminRouter(c, service),
    publicRouter: createSettingsPublicRouter(c, service),
  };
};
