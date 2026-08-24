import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `io` is faked at the package boundary: every call hands back a fresh fake
 * socket, recorded in `mocks.sockets` so tests can reach the one the module
 * captured. The module under test keeps singleton state, so each test
 * re-imports it after `vi.resetModules()` — and per the §4 trap in the
 * testing standards, assertions stay structural / identity-on-plain-objects,
 * never `instanceof` against a statically imported class.
 */
const mocks = vi.hoisted(() => {
  function makeSocket() {
    return {
      connected: false,
      connect: vi.fn(),
      disconnect: vi.fn(),
      removeAllListeners: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
    };
  }
  const sockets: ReturnType<typeof makeSocket>[] = [];
  const io = vi.fn((_url: string, _opts?: Record<string, unknown>) => {
    const s = makeSocket();
    sockets.push(s);
    return s;
  });
  return { io, sockets };
});

vi.mock('socket.io-client', () => ({ io: mocks.io }));

let rt: typeof import('./realtime');

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.sockets.length = 0;
  rt = await import('./realtime');
});

describe('connectRealtime', () => {
  it('creates the singleton with autoConnect off and reconnection tuned, then connects', () => {
    const s = rt.connectRealtime();

    expect(mocks.io).toHaveBeenCalledTimes(1);
    expect(mocks.io).toHaveBeenCalledWith('/', {
      withCredentials: true,
      transports: ['websocket', 'polling'],
      autoConnect: false,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
    });
    expect(s).toBe(mocks.sockets[0]);
    expect(mocks.sockets[0].connect).toHaveBeenCalledTimes(1);
    expect(rt.getSocket()).toBe(mocks.sockets[0]);
  });

  it('returns the connected singleton without building a second socket', () => {
    const first = rt.connectRealtime();
    mocks.sockets[0].connected = true;

    const second = rt.connectRealtime();

    expect(second).toBe(first);
    expect(mocks.io).toHaveBeenCalledTimes(1);
    expect(mocks.sockets[0].connect).toHaveBeenCalledTimes(1);
  });

  it('re-connects the existing socket when it exists but is not connected', () => {
    rt.connectRealtime();

    rt.connectRealtime();

    expect(mocks.io).toHaveBeenCalledTimes(1);
    expect(mocks.sockets[0].connect).toHaveBeenCalledTimes(2);
  });
});

describe('disconnectRealtime', () => {
  it('removes listeners, disconnects and nulls the singleton', () => {
    rt.connectRealtime();
    const fake = mocks.sockets[0];

    rt.disconnectRealtime();

    expect(fake.removeAllListeners).toHaveBeenCalledTimes(1);
    expect(fake.disconnect).toHaveBeenCalledTimes(1);
    expect(rt.getSocket()).toBeNull();
  });

  it('lets a later connectRealtime build a brand-new socket', () => {
    const first = rt.connectRealtime();
    rt.disconnectRealtime();

    const second = rt.connectRealtime();

    expect(mocks.io).toHaveBeenCalledTimes(2);
    expect(second).toBe(mocks.sockets[1]);
    expect(second).not.toBe(first);
    expect(rt.getSocket()).toBe(second);
  });

  it('is a no-op when no socket exists', () => {
    expect(rt.getSocket()).toBeNull();
    expect(() => rt.disconnectRealtime()).not.toThrow();
  });
});

describe('on / onConnect', () => {
  it('on registers the listener and its unsubscribe removes exactly that listener', () => {
    rt.connectRealtime();
    const fake = mocks.sockets[0];
    const listener = vi.fn();

    const off = rt.on('message', listener);
    expect(fake.on).toHaveBeenCalledWith('message', listener);
    expect(fake.off).not.toHaveBeenCalled();

    off();
    expect(fake.off).toHaveBeenCalledTimes(1);
    expect(fake.off).toHaveBeenCalledWith('message', listener);
  });

  it('on without a socket returns a no-op unsubscribe', () => {
    const off = rt.on('message', vi.fn());

    expect(off()).toBeUndefined();
    expect(mocks.io).not.toHaveBeenCalled();
  });

  it('onConnect subscribes to the connect event with the same unsubscribe contract', () => {
    rt.connectRealtime();
    const fake = mocks.sockets[0];
    const listener = vi.fn();

    const off = rt.onConnect(listener);
    expect(fake.on).toHaveBeenCalledWith('connect', listener);

    off();
    expect(fake.off).toHaveBeenCalledWith('connect', listener);
  });

  it('onConnect without a socket returns a no-op unsubscribe', () => {
    const off = rt.onConnect(vi.fn());

    expect(off()).toBeUndefined();
    expect(mocks.io).not.toHaveBeenCalled();
  });
});

describe('emit helpers', () => {
  it('emit forwards event, payload and ack to the socket', () => {
    rt.connectRealtime();
    const ack = vi.fn();

    rt.emit('conversation:join', { conversationId: 'c-1' }, ack);

    expect(mocks.sockets[0].emit).toHaveBeenCalledWith(
      'conversation:join',
      { conversationId: 'c-1' },
      ack,
    );
  });

  it('emit defaults a missing payload to an empty object', () => {
    rt.connectRealtime();

    rt.emit('ping');

    expect(mocks.sockets[0].emit).toHaveBeenCalledWith('ping', {}, undefined);
  });

  it('emitTyping and emitTypingEnd wrap the conversation id', () => {
    rt.connectRealtime();

    rt.emitTyping('c-1');
    rt.emitTypingEnd('c-1');

    expect(mocks.sockets[0].emit).toHaveBeenNthCalledWith(1, 'typing', { conversationId: 'c-1' });
    expect(mocks.sockets[0].emit).toHaveBeenNthCalledWith(2, 'typing:end', {
      conversationId: 'c-1',
    });
  });

  it('all emit helpers are silent no-ops without a socket', () => {
    expect(() => {
      rt.emit('ping', { a: 1 });
      rt.emitTyping('c-1');
      rt.emitTypingEnd('c-1');
    }).not.toThrow();
    expect(mocks.io).not.toHaveBeenCalled();
  });
});
