import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import type { PoolConfig } from 'mariadb';

import type { AppConfig } from '../config/index.js';
import type { Logger } from '../logger/logger.js';
import { PrismaClient } from '../../generated/prisma/client.js';

export type DatabaseClient = PrismaClient;

export interface Database {
  readonly client: DatabaseClient;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  ping(): Promise<void>;
}

function toPoolConfig(databaseUrl: string): PoolConfig {
  const url = new URL(databaseUrl);
  const database = url.pathname.replace(/^\//, '').split('?')[0];
  if (!database) {
    throw new Error('DATABASE_URL must include a database name.');
  }
  const port = url.port ? Number(url.port) : 3306;

  const config: PoolConfig = {
    host: url.hostname,
    port,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    connectionLimit: 10,
  };

  // MySQL 8.4 defaults to caching_sha2_password. For local non-TLS connections the MariaDB
  // driver may require server public key retrieval to complete authentication.
  // Kept local-dev safe by scoping to loopback hosts only.
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1') {
    (config as PoolConfig & { allowPublicKeyRetrieval?: boolean }).allowPublicKeyRetrieval = true;
  }

  return config;
}

/**
 * Creates a Prisma 7 client using the MariaDB/MySQL driver adapter.
 * No connection is established until `connect()` (or an implicit first query) runs.
 * The adapter is constructed from parsed connection config (not a raw URL string) to ensure
 * correct mariadb driver handling of mysql:// URLs and local MySQL 8 auth requirements.
 */
export function createDatabase(config: AppConfig, logger: Logger): Database {
  const adapter = new PrismaMariaDb(toPoolConfig(config.databaseUrl));
  const client = new PrismaClient({
    adapter,
    log: config.nodeEnv === 'development' ? [{ emit: 'event', level: 'error' }] : [],
  });

  let connected = false;

  return {
    client,
    async connect(): Promise<void> {
      if (connected) return;
      await client.$connect();
      connected = true;
      logger.info('database connected');
    },
    async disconnect(): Promise<void> {
      if (!connected) {
        // Still safe to disconnect in case adapter holds resources.
        await client.$disconnect().catch(() => undefined);
        return;
      }
      await client.$disconnect();
      connected = false;
      logger.info('database disconnected');
    },
    async ping(): Promise<void> {
      await client.$queryRawUnsafe('SELECT 1');
    },
  };
}
