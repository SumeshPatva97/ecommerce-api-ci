import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadConfig, type AppConfig } from './env.js';

export { ConfigError, loadConfig, type AppConfig } from './env.js';

/**
 * Reads `.env` (local development only — real deployments inject variables through the
 * hosting secret manager) and validates `process.env`. Throws `ConfigError` on any problem
 * so the process fails fast before serving traffic.
 */
export function loadConfigFromProcess(envFile = resolve(process.cwd(), '.env')): AppConfig {
  if (existsSync(envFile)) {
    // Native Node loader: does not override variables already present in the environment.
    process.loadEnvFile(envFile);
  }
  return loadConfig(process.env);
}
