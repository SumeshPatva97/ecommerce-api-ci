/**
 * Container wiring of the courier registry (Batch 7 missing tests). MOCKED DB; no network.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createContainer } from '../../../src/container.js';
import { createLogger } from '../../../src/core/logger/logger.js';
import {
  MockShippingProviderAdapter,
  WebhookSignatureError,
  signMockShippingWebhook,
  type ShippingProviderAdapter,
} from '../../../src/integrations/shipping/shippingProvider.js';
import { createOrdersService } from '../../../src/modules/orders/orders.service.js';
import { buildShippingServices } from '../../../src/modules/shipping/index.js';
import { createMockDb } from '../../helpers/mockDb.js';
import { testConfig } from '../../helpers/testApp.js';

const NOW = new Date('2026-11-20T06:30:00.000Z');

function containerWith(
  env: Record<string, string> = {},
  shipping?: Map<string, ShippingProviderAdapter>,
) {
  const config = testConfig(env);
  const { db } = createMockDb();
  return createContainer(config, createLogger(config), db, {
    clock: () => NOW,
    ...(shipping === undefined ? {} : { providers: { shipping } }),
  });
}

describe('courier registry wiring', () => {
  it('passes SHIPPING_WEBHOOK_SECRET to the mock courier adapter', () => {
    const container = containerWith({ SHIPPING_WEBHOOK_SECRET: 'courier-test-secret' });
    const adapter = container.providers.shipping.get('mock');
    expect(adapter).toBeInstanceOf(MockShippingProviderAdapter);
    const body = Buffer.from('{"eventId":"e1"}');
    const ts = Math.floor(NOW.getTime() / 1000);
    const headers = (secret?: string) => ({
      'x-mock-timestamp': String(ts),
      'x-mock-signature': signMockShippingWebhook(body, ts, secret),
    });
    expect(() => adapter?.verifyWebhook(body, headers('courier-test-secret'), NOW)).not.toThrow();
    // The public test secret is no longer accepted once a secret is configured.
    expect(() => adapter?.verifyWebhook(body, headers(), NOW)).toThrow(WebhookSignatureError);
  });

  it('shipping and orders both use the ONE registry held by the container', () => {
    const touched: string[] = [];
    class RecordingRegistry extends Map<string, ShippingProviderAdapter> {
      override get(key: string) {
        touched.push(`get:${key}`);
        return super.get(key);
      }
      override keys() {
        touched.push('keys');
        return super.keys();
      }
    }
    const registry = new RecordingRegistry([['mock', new MockShippingProviderAdapter()]]);
    const container = containerWith({}, registry);
    expect(container.providers.shipping).toBe(registry);

    buildShippingServices(container);
    expect(touched).toContain('get:mock');
    touched.length = 0;
    createOrdersService(container);
    expect(touched).toContain('keys');
  });

  it('no source module builds a private courier registry (only the container does)', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== 'generated') walk(path);
        } else if (path.endsWith('.ts')) {
          const text = readFileSync(path, 'utf8');
          const definesIt = path.endsWith(join('shipping', 'shippingProvider.ts'));
          if (
            !definesIt &&
            !path.endsWith('container.ts') &&
            text.includes('createShippingProviderRegistry(')
          ) {
            offenders.push(path);
          }
        }
      }
    };
    walk('src');
    expect(offenders).toEqual([]);
  });
});
