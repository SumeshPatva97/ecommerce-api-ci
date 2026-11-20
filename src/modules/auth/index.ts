/**
 * Customer authentication module (increment B1) — `/api/v1/auth/*`.
 */
import type { ModuleFactory } from '../types.js';
import { createAuthRouter } from './auth.routes.js';
import { createAuthService } from './auth.service.js';

export const createAuthModule: ModuleFactory = (container) => {
  const service = createAuthService(container);
  return { name: 'auth', publicRouter: createAuthRouter(container, service) };
};

export { createAuthService } from './auth.service.js';
export { createSessionService } from './session.service.js';
export { createCredentialService } from './credentials.js';
export { createPasswordService } from './password.service.js';
