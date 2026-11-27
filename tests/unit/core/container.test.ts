/**
 * Container wiring of the courier registry (Batch 7 missing tests). MOCKED DB; no network.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MOCK_PAYMENT_IN_PRODUCTION, createContainer } from '../../../src/container.js';
import { ConfigError } from '../../../src/core/config/index.js';
import { createLogger } from '../../../src/core/logger/logger.js';
import {
  MOCK_PAYMENT_KEY_SECRET,
  MOCK_PAYMENT_WEBHOOK_TEST_SECRET,
  MockPaymentProviderAdapter,
  type PaymentProviderAdapter,
} from '../../../src/integrations/payments/paymentProvider.js';
import {
  MockShippingProviderAdapter,
  WebhookSignatureError,
  signMockShippingWebhook,
  type ShippingProviderAdapter,
} from '../../../src/integrations/shipping/shippingProvider.js';
import { createOrdersService } from '../../../src/modules/orders/orders.service.js';
import { buildShippingServices } from '../../../src/modules/shipping/index.js';
import { createMockDb } from '../../helpers/mockDb.js';
import { BASE_TEST_ENV, PRODUCTION_SECRETS, testConfig } from '../../helpers/testApp.js';

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

/**
 * Security control PW-08 / finding A9-F02: the mock payment gateway authenticates the customer's
 * payment callback with a public test constant, so no production process may hold it.
 */
describe('mock payment provider is refused in production (PW-08)', () => {
  /** Values `loadConfig` requires outside development / test (throw-away test material). */
  const STRICT_ENV: Readonly<Record<string, string>> = {
    ...PRODUCTION_SECRETS,
    API_BASE_URL: 'https://api.example.com',
    STOREFRONT_URL: 'https://www.example.com',
    ADMIN_URL: 'https://admin.example.com',
    CORS_ORIGINS: 'https://www.example.com,https://admin.example.com',
  };
  const WEBHOOK_SECRET = 'configured-webhook-secret-value';

  function build(env: Record<string, string>, payment?: PaymentProviderAdapter) {
    const config = testConfig(env);
    const { db } = createMockDb();
    return createContainer(config, createLogger(config), db, {
      clock: () => NOW,
      ...(payment === undefined ? {} : { providers: { payment } }),
    });
  }

  function refusal(env: Record<string, string>, payment?: PaymentProviderAdapter): ConfigError {
    try {
      build(env, payment);
    } catch (error) {
      if (error instanceof ConfigError) return error;
      throw error;
    }
    throw new Error('expected createContainer to refuse');
  }

  const production = { ...STRICT_ENV, NODE_ENV: 'production' };

  it('production without a provider override: the container is not built; the error names PAYMENT_PROVIDER only', () => {
    const error = refusal(production);
    expect(error.problems).toEqual([MOCK_PAYMENT_IN_PRODUCTION]);
    expect(error.problems).toEqual([
      'PAYMENT_PROVIDER: the mock payment provider cannot run in production.',
    ]);
    // An explicitly injected mock is refused as well: the provider is checked, not the variable.
    expect(refusal(production, new MockPaymentProviderAdapter()).problems).toEqual([
      MOCK_PAYMENT_IN_PRODUCTION,
    ]);
  });

  it.each([
    ['development', { NODE_ENV: 'development' }],
    ['test', { NODE_ENV: 'test' }],
    ['staging', { ...STRICT_ENV, NODE_ENV: 'staging' }],
  ])('%s still gets the mock payment provider', (nodeEnv, env) => {
    const container = build(env);
    expect(container.config.nodeEnv).toBe(nodeEnv);
    expect(container.providers.payment).toBeInstanceOf(MockPaymentProviderAdapter);
    expect(container.providers.payment.name).toBe('mock');
  });

  it('production with an injected non-mock provider is accepted (the rule tests the provider)', () => {
    const notUsed = () => Promise.reject(new Error('not used in this test'));
    const gateway: PaymentProviderAdapter = {
      name: 'stub-gateway',
      initiate: notUsed,
      verify: notUsed,
      refund: notUsed,
    };
    const container = build(production, gateway);
    expect(container.config.nodeEnv).toBe('production');
    expect(container.providers.payment).toBe(gateway);
  });

  it('the refusal message contains no secret, URL or configured value', () => {
    const { message } = refusal({ ...production, PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET });
    const forbidden = [
      MOCK_PAYMENT_KEY_SECRET,
      MOCK_PAYMENT_WEBHOOK_TEST_SECRET,
      WEBHOOK_SECRET,
      ...Object.values(PRODUCTION_SECRETS),
      ...Object.values(STRICT_ENV),
      BASE_TEST_ENV.DATABASE_URL ?? '',
    ].filter((value) => value !== '');
    for (const value of forbidden) expect(message).not.toContain(value);
    expect(message).not.toMatch(/https?:\/\/|mysql:\/\//);
    expect(message).toContain('PAYMENT_PROVIDER');
  });
});
