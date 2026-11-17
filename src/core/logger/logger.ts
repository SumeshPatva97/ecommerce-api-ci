import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';

import type { AppConfig } from '../config/index.js';
import { getRequestContext } from './context.js';

/**
 * Sensitive field names — BACKEND_STRUCTURE.md §20, DEVELOPMENT_GUIDELINES.md §8.6.
 * Matching is exact and case-sensitive (pino path redaction).
 */
export const SENSITIVE_KEYS = [
  'password',
  'newPassword',
  'currentPassword',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'otp',
  'signature',
  'cardNumber',
  'cvv',
  'apiKey',
  'secret',
] as const;

/** Header paths redacted in request/response objects. */
export const HEADER_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
] as const;

/**
 * Redaction paths. Each sensitive key is redacted at exactly three depths of a logged object:
 * root (`password`), one level below (`*.password`) and two levels below (`*.*.password`).
 * An array index counts as one level (`items[0].password` is two levels below root).
 *
 * LIMITATION: pino has no recursive wildcard, so a sensitive key three or more levels below the
 * root is NOT redacted. Request/response bodies and provider payloads are never logged; these
 * paths are a second line of defence for objects that are logged explicitly — never log whole
 * deep objects that may contain secrets.
 */
export const REDACT_PATHS: readonly string[] = [
  ...HEADER_REDACT_PATHS,
  ...SENSITIVE_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]),
];

export type { Logger };

/**
 * @param destination Optional output stream (tests capture log lines through it). When omitted,
 *   logs go to stdout as before. Ignored when pretty logging is active (transport owns output).
 */
export function createLogger(
  config: Pick<AppConfig, 'appName' | 'nodeEnv' | 'log'>,
  destination?: DestinationStream,
): Logger {
  const usePretty = config.log.pretty && config.nodeEnv === 'development';
  const options: LoggerOptions = {
    name: config.appName,
    level: config.log.level,
    base: { env: config.nodeEnv },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' },
    // Every log line written while handling a request carries its requestId.
    mixin: () => {
      const context = getRequestContext();
      return context ? { requestId: context.requestId } : {};
    },
    ...(usePretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, singleLine: true } } }
      : {}),
  };
  return destination !== undefined && !usePretty ? pino(options, destination) : pino(options);
}
