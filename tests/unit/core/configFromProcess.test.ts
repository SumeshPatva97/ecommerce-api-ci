import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigError, loadConfigFromProcess } from '../../../src/core/config/index.js';
import { BASE_TEST_ENV } from '../../helpers/testApp.js';

// Each Vitest test file runs in its own forked process, so mutating process.env here is isolated.
const KEYS = [...Object.keys(BASE_TEST_ENV), 'APP_NAME'];

describe('loadConfigFromProcess', () => {
  let dir: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ecom-env-'));
    saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    for (const key of KEYS) Reflect.deleteProperty(process.env, key);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const key of KEYS) {
      const value = saved[key];
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  });

  it('loads variables from a .env file', () => {
    const file = join(dir, '.env');
    const lines = Object.entries(BASE_TEST_ENV).map(([key, value]) => `${key}=${value}`);
    writeFileSync(file, [...lines, 'APP_NAME=FromFile'].join('\n'));
    const config = loadConfigFromProcess(file);
    expect(config.appName).toBe('FromFile');
    expect(config.cors.adminOrigin).toBe('http://localhost:5174');
  });

  it('does not override variables already set in the environment', () => {
    const file = join(dir, '.env');
    const lines = Object.entries(BASE_TEST_ENV).map(([key, value]) => `${key}=${value}`);
    writeFileSync(file, [...lines, 'APP_NAME=FromFile'].join('\n'));
    process.env.APP_NAME = 'FromEnvironment';
    expect(loadConfigFromProcess(file).appName).toBe('FromEnvironment');
  });

  it('validates process.env when no .env file exists and fails fast', () => {
    expect(() => loadConfigFromProcess(join(dir, 'missing.env'))).toThrow(ConfigError);
  });
});
