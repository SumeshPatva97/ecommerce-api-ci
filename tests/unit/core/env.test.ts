import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../../../src/core/config/index.js';
import { BASE_TEST_ENV } from '../../helpers/testApp.js';

function load(overrides: Record<string, string | undefined> = {}) {
  return loadConfig({ ...BASE_TEST_ENV, ...overrides });
}

function problemsOf(overrides: Record<string, string | undefined>): readonly string[] {
  try {
    load(overrides);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error('expected ConfigError');
}

describe('loadConfig', () => {
  it('builds a frozen config with documented defaults', () => {
    const config = load({ LOG_LEVEL: undefined });
    expect(config).toMatchObject({
      nodeEnv: 'test',
      appName: '[BRAND_NAME] API',
      port: 4000,
      appTimezone: 'Asia/Kolkata',
      log: { level: 'info', pretty: false },
      trustProxy: 0,
      requestBodyLimit: '100kb',
      rateLimit: { enabled: true, defaultPerMinute: 300 },
      databaseUrl: BASE_TEST_ENV.DATABASE_URL,
    });
    expect(config.cors.origins).toEqual(['http://localhost:5173', 'http://localhost:5174']);
    expect(config.cors.adminOrigin).toBe('http://localhost:5174');
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.cors.origins)).toBe(true);
  });

  it('parses numbers and booleans from strings and strips trailing slashes', () => {
    const config = load({
      PORT: '8080',
      TRUST_PROXY: '1',
      RATE_LIMIT_ENABLED: 'false',
      LOG_PRETTY: 'true',
      API_BASE_URL: 'http://localhost:4000/',
      REQUEST_BODY_LIMIT: '1MB',
    });
    expect(config.port).toBe(8080);
    expect(config.trustProxy).toBe(1);
    expect(config.rateLimit.enabled).toBe(false);
    expect(config.log.pretty).toBe(true);
    expect(config.apiBaseUrl).toBe('http://localhost:4000');
    expect(config.requestBodyLimit).toBe('1mb');
  });

  it('reports every missing required variable by name', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    const problems = problemsOf({
      NODE_ENV: undefined,
      API_BASE_URL: undefined,
      CORS_ORIGINS: undefined,
    }).join('\n');
    expect(problems).toContain('NODE_ENV');
    expect(problems).toContain('API_BASE_URL');
    expect(problems).toContain('CORS_ORIGINS');
  });

  it('enforces UTC process time and the Asia/Kolkata business timezone', () => {
    expect(problemsOf({ TZ: 'Asia/Kolkata' }).join()).toContain('TZ must be UTC');
    expect(problemsOf({ APP_TIMEZONE: 'UTC' }).join()).toContain('APP_TIMEZONE');
  });

  it.each([
    ['wildcard', '*'],
    ['path', 'http://localhost:5173/app'],
    ['trailing slash', 'http://localhost:5173/'],
    ['non-http scheme', 'ftp://example.com'],
  ])('rejects a CORS origin with a %s', (_label, value) => {
    expect(problemsOf({ CORS_ORIGINS: value }).join()).toContain('CORS_ORIGINS');
  });

  it('rejects invalid enums, ports and body limits', () => {
    const problems = problemsOf({
      NODE_ENV: 'prod',
      PORT: '70000',
      LOG_LEVEL: 'verbose',
      REQUEST_BODY_LIMIT: 'lots',
    }).join('\n');
    expect(problems).toContain('NODE_ENV');
    expect(problems).toContain('PORT');
    expect(problems).toContain('LOG_LEVEL');
    expect(problems).toContain('REQUEST_BODY_LIMIT');
  });

  it('requires https, rate limiting and plain logs in production and staging', () => {
    for (const nodeEnv of ['production', 'staging']) {
      const problems = problemsOf({
        NODE_ENV: nodeEnv,
        RATE_LIMIT_ENABLED: 'false',
        LOG_PRETTY: 'true',
      }).join('\n');
      expect(problems).toContain('API_BASE_URL: Must use https');
      expect(problems).toContain('STOREFRONT_URL: Must use https');
      expect(problems).toContain('ADMIN_URL: Must use https');
      expect(problems).toContain('CORS_ORIGINS');
      expect(problems).toContain('RATE_LIMIT_ENABLED');
      expect(problems).toContain('LOG_PRETTY');
    }
  });

  it('accepts a valid production configuration', () => {
    const config = load({
      NODE_ENV: 'production',
      API_BASE_URL: 'https://api.example.com',
      STOREFRONT_URL: 'https://www.example.com',
      ADMIN_URL: 'https://admin.example.com',
      CORS_ORIGINS: 'https://www.example.com,https://admin.example.com',
    });
    expect(config.cors.adminOrigin).toBe('https://admin.example.com');
  });

  it('requires both frontend origins in CORS_ORIGINS and distinct from each other', () => {
    expect(problemsOf({ CORS_ORIGINS: 'http://localhost:5173' }).join()).toContain(
      'CORS_ORIGINS: Must include the origin of ADMIN_URL.',
    );
    expect(problemsOf({ CORS_ORIGINS: 'http://localhost:5174' }).join()).toContain(
      'CORS_ORIGINS: Must include the origin of STOREFRONT_URL.',
    );
    expect(problemsOf({ ADMIN_URL: 'http://localhost:5173/admin' }).join()).toContain(
      'ADMIN_URL and STOREFRONT_URL must have different origins.',
    );
  });

  describe('invalid frontend URLs (review D2)', () => {
    function thrownBy(overrides: Record<string, string>): unknown {
      try {
        load(overrides);
      } catch (error) {
        return error;
      }
      return undefined;
    }

    it.each([
      ['STOREFRONT_URL', 'not a url'],
      ['STOREFRONT_URL', 'ftp://shop.example'],
      ['ADMIN_URL', 'nope'],
      ['ADMIN_URL', '//admin-without-scheme'],
    ])('invalid %s (%s) → ConfigError naming the variable, value not exposed', (key, value) => {
      const error = thrownBy({ [key]: value });
      expect(error).toBeInstanceOf(ConfigError);
      const text = (error as ConfigError).problems.join('\n');
      expect(text).toContain(`${key}: Must be an absolute http(s) URL.`);
      expect(text).not.toContain(value);
      expect(text).not.toContain('Invalid URL'); // the old TypeError message
    });

    it('both URLs invalid → one ConfigError listing both variables', () => {
      const error = thrownBy({ STOREFRONT_URL: 'bad-store', ADMIN_URL: 'bad-admin' });
      expect(error).toBeInstanceOf(ConfigError);
      const text = (error as ConfigError).problems.join('\n');
      expect(text).toContain('STOREFRONT_URL: Must be an absolute http(s) URL.');
      expect(text).toContain('ADMIN_URL: Must be an absolute http(s) URL.');
      expect(text).not.toMatch(/bad-store|bad-admin/);
    });

    it('invalid URL together with other invalid fields still reports every field', () => {
      const error = thrownBy({ ADMIN_URL: 'nope', PORT: 'abc', TZ: 'Asia/Kolkata' });
      expect(error).toBeInstanceOf(ConfigError);
      const text = (error as ConfigError).problems.join('\n');
      expect(text).toContain('ADMIN_URL');
      expect(text).toContain('PORT');
      expect(text).toContain('TZ');
    });

    it('valid URLs still enforce distinct origins and CORS allow-listing', () => {
      const same = thrownBy({ ADMIN_URL: 'http://localhost:5173/admin' });
      expect(same).toBeInstanceOf(ConfigError);
      expect((same as ConfigError).problems.join()).toContain(
        'ADMIN_URL and STOREFRONT_URL must have different origins.',
      );
      const notListed = thrownBy({ ADMIN_URL: 'http://localhost:5999' });
      expect(notListed).toBeInstanceOf(ConfigError);
      expect((notListed as ConfigError).problems.join()).toContain(
        'CORS_ORIGINS: Must include the origin of ADMIN_URL.',
      );
    });
  });

  it('never echoes variable values in error messages', () => {
    const secretLooking = 'super-secret-value-123';
    const problems = problemsOf({ API_BASE_URL: secretLooking, PORT: secretLooking }).join('\n');
    expect(problems).not.toContain(secretLooking);
  });
});
