/**
 * Notifications module (B8) — outbox enqueue service, dispatcher, customer preferences, admin
 * templates / logs / resend. NOTIFICATION_WORKFLOWS.md; API_DOCUMENTATION.md §3.2, §4.16.
 *
 * Other modules call `createNotificationService(container).enqueue(tx, …)` inside their own
 * transaction; delivery runs from `src/jobs/notificationDispatcher.ts`.
 */
import type { AppContainer } from '../../container.js';
import type { ModuleFactory } from '../types.js';
import { createNotificationsAdminService } from './notifications.admin.js';
import { createNotificationDispatcher } from './notifications.dispatcher.js';
import { createPreferencesService } from './notifications.preferences.js';
import {
  createNotificationsAdminRouter,
  createNotificationsPublicRouter,
} from './notifications.routes.js';
import { createNotificationService, type NotificationService } from './notifications.service.js';

/** Notification service bound to the container clock. */
export function notificationServiceFor(container: AppContainer): NotificationService {
  return createNotificationService({ clock: container.clock });
}

/** Dispatcher wired to the container's providers (fake email / mock WhatsApp, OQ-08). */
export function notificationDispatcherFor(
  container: AppContainer,
  options: { readonly random?: () => number; readonly timeoutMs?: number } = {},
) {
  return createNotificationDispatcher({
    db: container.db,
    logger: container.logger,
    clock: container.clock,
    email: container.providers.email,
    whatsapp: container.providers.whatsapp,
    notifications: notificationServiceFor(container),
    ...options,
  });
}

export const createNotificationsModule: ModuleFactory = (container) => {
  const notifications = notificationServiceFor(container);
  return {
    name: 'notifications',
    publicRouter: createNotificationsPublicRouter(container, createPreferencesService(container)),
    adminRouter: createNotificationsAdminRouter(
      container,
      createNotificationsAdminService(container, notifications),
    ),
  };
};

export {
  createNotificationService,
  buildDedupeKey,
  type EnqueueNotificationInput,
  type EnqueuedNotification,
  type NotificationService,
} from './notifications.service.js';
export {
  createNotificationDispatcher,
  NotificationSendError,
  type DispatchSummary,
  type NotificationDispatcher,
} from './notifications.dispatcher.js';
export { createPreferencesService, type PreferencesService } from './notifications.preferences.js';
export {
  createNotificationsAdminService,
  type NotificationsAdminService,
} from './notifications.admin.js';
export { EVENT_SPECS } from './notifications.catalog.js';
