import { generateKeyPairSync, randomBytes } from 'node:crypto';

import type { Express, Router } from 'express';

import { createApp } from '../../src/app.js';
import { loadConfig, type AppConfig } from '../../src/core/config/index.js';
import { Readiness } from '../../src/core/health/readiness.js';
import { createLogger } from '../../src/core/logger/logger.js';

/** Minimal valid environment for tests — local URLs only, no secrets (DATABASE_URL is a placeholder; no DB connection in tests). */
export const BASE_TEST_ENV: Readonly<Record<string, string>> = {
  NODE_ENV: 'test',
  APP_TIMEZONE: 'Asia/Kolkata',
  TZ: 'UTC',
  API_BASE_URL: 'http://localhost:4000',
  STOREFRONT_URL: 'http://localhost:5173',
  ADMIN_URL: 'http://localhost:5174',
  CORS_ORIGINS: 'http://localhost:5173,http://localhost:5174',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'mysql://user:placeholder@localhost:3306/ecommerce_test',
};

/** Throw-away key material generated per test run — required by loadConfig outside development/test. */
const testKeys = generateKeyPairSync('ed25519');
export const PRODUCTION_SECRETS: Readonly<Record<string, string>> = {
  // Private key as a single-line `\n`-escaped PEM, public key base64 — both accepted forms (§9.1).
  JWT_ACCESS_PRIVATE_KEY: testKeys.privateKey
    .export({ format: 'pem', type: 'pkcs8' })
    .toString()
    .split('\n')
    .join('\\n'),
  JWT_ACCESS_PUBLIC_KEY: Buffer.from(
    testKeys.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  ).toString('base64'),
  JWT_KEY_ID: 'test-2026-11',
  REFRESH_TOKEN_PEPPER: randomBytes(32).toString('hex'),
  FIELD_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
};

export const STOREFRONT_ORIGIN = 'http://localhost:5173';
export const ADMIN_ORIGIN = 'http://localhost:5174';

export function testConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  return loadConfig({ ...BASE_TEST_ENV, ...overrides });
}

export interface TestAppOptions {
  env?: Record<string, string | undefined>;
  v1Router?: Router;
  readiness?: Readiness;
}

export function buildTestApp(options: TestAppOptions = {}): {
  app: Express;
  config: AppConfig;
  readiness: Readiness;
} {
  const config = testConfig(options.env);
  const readiness = options.readiness ?? new Readiness();
  const logger = createLogger(config);
  const app = createApp({
    config,
    logger,
    readiness,
    ...(options.v1Router ? { v1Router: options.v1Router } : {}),
  });
  return { app, config, readiness };
}
