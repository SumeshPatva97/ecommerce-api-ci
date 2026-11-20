/**
 * Shipment tracking poll job — BACKEND_STRUCTURE.md §14 (`shipment-tracking-poll`, every 30 min).
 * Delegates to the shipments service (`pollTracking`), which only polls adapters implementing the
 * optional `getTracking` (couriers without webhooks, OQ-07). With the default mock adapter (webhook
 * based) it is a no-op. No real courier is connected.
 *
 * Pass the previous run's `nextCursor` as `after` (D4 fairness); the registry does this.
 */
import type { AppContainer } from '../container.js';
import { buildShippingServices } from '../modules/shipping/index.js';
import type { TrackingPollSummary } from '../modules/shipping/shipping.shipments.js';

export function runShipmentTrackingPoll(
  container: AppContainer,
  options: {
    readonly limit?: number;
    readonly after?: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal | undefined;
  } = {},
): Promise<TrackingPollSummary> {
  return buildShippingServices(container).shipments.pollTracking(options);
}
