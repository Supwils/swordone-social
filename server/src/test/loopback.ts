import type { Server } from 'node:http';
import supertest from 'supertest';

/**
 * Make supertest's ephemeral servers bind 127.0.0.1 — the address it dials.
 *
 * Stock supertest calls `app.listen(0)`, which binds the dual-stack wildcard
 * `::`, then connects to `127.0.0.1:<port>`. macOS hands out TCP ports
 * sequentially (`net.inet.tcp.randomize_ports: 0`) and, because Node sets
 * SO_REUSEADDR, lets a wildcard bind take a port another process already holds
 * on 127.0.0.1 (an editor helper, a browser debug port, an e2e server). Once
 * the counter wraps onto such a port the kernel routes supertest's connection
 * to the more specific foreign listener, and the test sees `socket hang up`
 * (or a hang) on whichever request drew that port. Binding 127.0.0.1
 * explicitly makes the kernel skip held ports, so the connection always lands
 * on our server. Linux refuses that bind combination, so CI never showed it.
 *
 * `listen(0, host)` is asynchronous (it resolves the host first), so the real
 * port is only known at `listening`; the URL gets a placeholder port here and
 * `end()` fills it in before the request is built.
 */

interface PatchableTest {
  url: string;
  _server?: Server;
  serverAddress(app: Server, path: string): string;
  end(fn?: (err: unknown, res: unknown) => void): PatchableTest;
}

const LOOPBACK = '127.0.0.1';
const PATCHED = Symbol.for('swil.supertest.loopback');
const pendingPath = new WeakMap<PatchableTest, string>();

export function bindSupertestToLoopback(): void {
  const proto = supertest.Test.prototype as unknown as PatchableTest & {
    [PATCHED]?: true;
  };
  if (proto[PATCHED]) return;
  proto[PATCHED] = true;
  const originalEnd = proto.end;

  proto.serverAddress = function serverAddress(this: PatchableTest, app, path) {
    const addr = app.address();
    if (addr && typeof addr === 'object') return `http://${LOOPBACK}:${addr.port}${path}`;
    this._server = app.listen(0, LOOPBACK);
    pendingPath.set(this, path);
    return `http://${LOOPBACK}:0${path}`;
  };

  proto.end = function end(this: PatchableTest, fn) {
    const server = this._server;
    const path = pendingPath.get(this);
    if (!server || path === undefined) return originalEnd.call(this, fn);
    pendingPath.delete(this);

    const send = () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') this.url = `http://${LOOPBACK}:${addr.port}${path}`;
      originalEnd.call(this, fn);
    };
    if (server.listening) {
      send();
      return this;
    }
    const onError = (err: Error) => {
      server.off('listening', onListening);
      fn?.(err, undefined);
    };
    const onListening = () => {
      server.off('error', onError);
      send();
    };
    server.once('listening', onListening);
    server.once('error', onError);
    return this;
  };
}
