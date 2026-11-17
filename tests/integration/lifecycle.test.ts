import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Readiness } from '../../src/core/health/readiness.js';
import {
  registerGracefulShutdown,
  startHttpServer,
  type ProcessLike,
} from '../../src/core/lifecycle/httpServer.js';
import { createLogger } from '../../src/core/logger/logger.js';

/**
 * Real HTTP server + simulated signals. OS signal delivery itself is not exercised here: on
 * Windows, SIGTERM/SIGINT cannot be sent to another process (it is terminated immediately).
 */
const logger = createLogger({
  appName: 'test',
  nodeEnv: 'test',
  log: { level: 'silent', pretty: false },
});

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

function portOf(server: Server): number {
  return (server.address() as AddressInfo).port;
}

async function start(handler: Parameters<typeof startHttpServer>[0]): Promise<Server> {
  const server = await startHttpServer(handler, 0, logger, '127.0.0.1');
  servers.push(server);
  return server;
}

function fakeProcess(): EventEmitter & ProcessLike {
  return new EventEmitter() as EventEmitter & ProcessLike;
}

describe('startHttpServer', () => {
  it('resolves once listening and serves requests', async () => {
    const server = await start((_req, res) => res.end('ok'));
    const res = await fetch(`http://127.0.0.1:${portOf(server)}/`);
    expect(await res.text()).toBe('ok');
  });

  it('rejects with the server error event when the port is in use', async () => {
    const first = await start((_req, res) => res.end());
    await expect(
      startHttpServer((_req, res) => res.end(), portOf(first), logger, '127.0.0.1'),
    ).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
  });

  it('logs server errors emitted after startup instead of crashing', async () => {
    const server = await start((_req, res) => res.end());
    const spy = vi.spyOn(logger, 'error');
    server.emit('error', new Error('late failure'));
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'HTTP server error',
    );
    spy.mockRestore();
  });
});

describe('registerGracefulShutdown', () => {
  it('on SIGTERM: marks not-ready, lets in-flight requests finish, refuses new ones, exits 0 once', async () => {
    const readiness = new Readiness();
    let releaseRequest: () => void = () => undefined;
    const server = await start((_req, res) => {
      releaseRequest = () => res.end('finished');
    });
    const proc = fakeProcess();
    const exit = vi.fn();
    registerGracefulShutdown({ server, readiness, logger, processLike: proc, exit });

    const port = portOf(server);
    const inFlight = fetch(`http://127.0.0.1:${port}/slow`);
    await vi.waitFor(() => {
      expect(server.listening).toBe(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    proc.emit('SIGTERM');
    proc.emit('SIGTERM'); // second signal is ignored
    expect(readiness.isShuttingDown()).toBe(true);
    expect((await readiness.evaluate()).ready).toBe(false);
    await expect(fetch(`http://127.0.0.1:${port}/new`)).rejects.toThrow();

    expect(exit).not.toHaveBeenCalled();
    releaseRequest();
    const res = await inFlight;
    expect(await res.text()).toBe('finished');
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('closes hanging connections after the drain timeout', async () => {
    const server = await start(() => undefined); // never responds
    const proc = fakeProcess();
    const exit = vi.fn();
    registerGracefulShutdown({
      server,
      readiness: new Readiness(),
      logger,
      processLike: proc,
      exit,
      drainTimeoutMs: 50,
    });
    const hanging = fetch(`http://127.0.0.1:${portOf(server)}/`).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 50));
    proc.emit('SIGINT');
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
    expect(await hanging).toBeInstanceOf(Error);
  });

  it('runs disconnect hooks, and exits 1 if a hook fails', async () => {
    const server = await start((_req, res) => res.end());
    const proc = fakeProcess();
    const exit = vi.fn();
    const onClose = vi.fn(() => Promise.reject(new Error('db disconnect failed')));
    registerGracefulShutdown({
      server,
      readiness: new Readiness(),
      logger,
      processLike: proc,
      exit,
      onClose,
    });
    proc.emit('SIGTERM');
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(1);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('forces exit 1 when shutdown exceeds the hard limit', async () => {
    const server = await start((_req, res) => res.end());
    const proc = fakeProcess();
    const exit = vi.fn();
    registerGracefulShutdown({
      server,
      readiness: new Readiness(),
      logger,
      processLike: proc,
      exit,
      hardExitMs: 50,
      onClose: () => new Promise<void>(() => undefined), // never settles
    });
    proc.emit('SIGTERM');
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(1);
    });
  });

  it.each([
    ['unhandledRejection', new Error('boom')],
    ['uncaughtException', new Error('boom')],
  ])('%s triggers shutdown with exit code 1', async (event, payload) => {
    const server = await start((_req, res) => res.end());
    const proc = fakeProcess();
    const exit = vi.fn();
    registerGracefulShutdown({
      server,
      readiness: new Readiness(),
      logger,
      processLike: proc,
      exit,
    });
    proc.emit(event, payload);
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(1);
    });
  });
});
