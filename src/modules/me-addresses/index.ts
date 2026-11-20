/**
 * Customer self-service — address book (`/me/addresses*`, API_DOCUMENTATION.md §3.2) and recently
 * viewed products (`/me/recently-viewed*`, §3.6). Addresses are exported for checkout (owned
 * address lookup happens through `AddressesService.list` or the repository's `findAddress`).
 */
import type { ModuleFactory } from '../types.js';
import { createAddressesService } from './addresses.service.js';
import { createMeAddressesRepository } from './me-addresses.repository.js';
import { createMeAddressesRouter } from './me-addresses.routes.js';
import { createRecentlyViewedService } from './recently-viewed.service.js';

export const createMeAddressesModule: ModuleFactory = (container) => {
  const repo = createMeAddressesRepository();
  return {
    name: 'me-addresses',
    publicRouter: createMeAddressesRouter(
      container,
      createAddressesService(container, repo),
      createRecentlyViewedService(container, repo),
    ),
  };
};

export { createAddressesService, type AddressesService } from './addresses.service.js';
export {
  createRecentlyViewedService,
  type RecentlyViewedService,
} from './recently-viewed.service.js';
export type { AddressDto } from './addresses.mapper.js';
