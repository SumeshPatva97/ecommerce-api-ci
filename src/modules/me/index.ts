/**
 * Customer self-service module (`/api/v1/me*`).
 *
 * `createMeProfileModule` = profile, change-password and sessions (increment B1). Addresses,
 * notification preferences and recently viewed are added by their increments in separate files;
 * `createMeModule` is the module factory registered for `/me` and currently mounts the B1 part.
 */
import { createCredentialService } from '../auth/credentials.js';
import { createPasswordService } from '../auth/password.service.js';
import { createSessionService } from '../auth/session.service.js';
import type { ModuleFactory } from '../types.js';
import { createMeProfileRouter } from './me.profile.routes.js';
import { createMeProfileService } from './me.profile.service.js';

export const createMeProfileModule: ModuleFactory = (container) => {
  const credentials = createCredentialService(container, 'storefront');
  const router = createMeProfileRouter(container, {
    profile: createMeProfileService(container),
    passwords: createPasswordService(container, 'storefront', credentials),
    sessions: createSessionService(container),
  });
  return { name: 'me-profile', publicRouter: router };
};

export const createMeModule: ModuleFactory = createMeProfileModule;
