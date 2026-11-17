import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIPv6 } from 'node:net';

import type { Request } from 'express';
import { pinoHttp } from 'pino-http';

import type { Logger } from '../logger/logger.js';

/** Expands a (possibly `::`-compressed) IPv6 address into its 8 hextets. */
function ipv6Hextets(ip: string): string[] {
  const [head = '', tail = ''] = ip.split('::');
  const headParts = head === '' ? [] : head.split(':');
  const tailParts = tail === '' ? [] : tail.split(':');
  const fill = Array.from({ length: 8 - headParts.length - tailParts.length }, () => '0');
  return ip.includes('::') ? [...headParts, ...fill, ...tailParts] : headParts;
}

/** Masks the host part of client IPs in access logs: IPv4 → /24, IPv6 → /48. */
export function truncateIp(ip: string | undefined): string | undefined {
  if (ip === undefined) return undefined;
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/i.exec(ip);
  if (v4) return `${v4[1] ?? ''}.${v4[2] ?? ''}.${v4[3] ?? ''}.0`;
  if (isIPv6(ip)) {
    const hextets = ipv6Hextets(ip.split('%')[0] ?? ip).map((h) =>
      h.toLowerCase().replace(/^0+(?=.)/, ''),
    );
    return `${hextets.slice(0, 3).join(':')}::`;
  }
  return undefined;
}

function pathOnly(url: string | undefined): string | undefined {
  return url?.split('?')[0];
}

/**
 * One structured line per request (BACKEND_STRUCTURE.md §20): 5xx → error, 4xx → warn except
 * 401/404 → info, otherwise info. Health probes are not access-logged. Bodies, query strings
 * and headers (Authorization, Cookie) are deliberately not logged.
 */
export function accessLog(logger: Logger) {
  return pinoHttp({
    logger,
    genReqId: (req: IncomingMessage) => (req as Request).requestId,
    autoLogging: { ignore: (req: IncomingMessage) => req.url?.startsWith('/health/') ?? false },
    customLogLevel: (_req: IncomingMessage, res: ServerResponse, err?: Error) => {
      if (err !== undefined || res.statusCode >= 500) return 'error';
      if (res.statusCode === 401 || res.statusCode === 404) return 'info';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    customSuccessMessage: () => 'request completed',
    customErrorMessage: () => 'request failed',
    customProps: (req: IncomingMessage) => ({ ip: truncateIp((req as Request).ip) }),
    serializers: {
      req: (req: { method?: string; url?: string; headers?: Record<string, unknown> }) => ({
        method: req.method,
        path: pathOnly(req.url),
        userAgent: req.headers?.['user-agent'],
      }),
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
    },
  });
}
