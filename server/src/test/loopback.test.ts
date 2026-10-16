import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

/**
 * Pins the setup-file patch in test/loopback.ts: supertest's ephemeral server
 * binds 127.0.0.1 itself, not the dual-stack `::` it used to. On `::` the
 * connection's local address reads `::ffff:127.0.0.1`, and on macOS the port
 * could already belong to another process's 127.0.0.1 listener.
 */
function app() {
  const a = express();
  a.get('/where', (req, res) => {
    res.json({ local: req.socket.localAddress, cookie: req.headers.cookie ?? null });
  });
  a.post('/login', (_req, res) => {
    res.cookie('sid', 'abc').status(201).json({ ok: true });
  });
  return a;
}

describe('supertest loopback binding', () => {
  it('serves request(app) from a server bound to 127.0.0.1', async () => {
    const res = await request(app()).get('/where?x=1').expect(200);
    expect(res.body.local).toBe('127.0.0.1');
  });

  it('re-listens on 127.0.0.1 for every request of an agent and keeps its cookie jar', async () => {
    const agent = request.agent(app());
    await agent.post('/login').expect(201);
    const first = await agent.get('/where').expect(200);
    const second = await agent.get('/where').expect(200);
    expect(first.body).toEqual({ local: '127.0.0.1', cookie: 'sid=abc' });
    expect(second.body.local).toBe('127.0.0.1');
  });

  it('still works when end() runs after the server is already listening', async () => {
    const pending = request(app()).get('/where');
    await new Promise((r) => setTimeout(r, 20));
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body.local).toBe('127.0.0.1');
  });
});
