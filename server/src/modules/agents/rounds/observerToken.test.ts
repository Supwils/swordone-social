import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { env } from '../../../config/env';
import { requireObserverToken } from './observerToken';

const TOKEN = 't'.repeat(40);
const original = env.LAB_OBSERVER_TOKEN;

const reqWith = (headers: Record<string, string>) =>
  ({ get: (name: string) => headers[name.toLowerCase()] }) as unknown as Request;

function run(headers: Record<string, string>) {
  const next = vi.fn();
  requireObserverToken(reqWith(headers), {} as Response, next);
  return next.mock.calls[0]?.[0] as { status?: number } | undefined;
}

beforeEach(() => {
  env.LAB_OBSERVER_TOKEN = TOKEN;
});
afterEach(() => {
  env.LAB_OBSERVER_TOKEN = original;
});

describe('requireObserverToken', () => {
  it('unset token → 404: the feature is off and the route does not exist', () => {
    env.LAB_OBSERVER_TOKEN = undefined;
    expect(run({ 'x-lab-observer-token': TOKEN })?.status).toBe(404);
  });

  it('missing, wrong, or different-length header → 401, never a throw', () => {
    expect(run({})?.status).toBe(401);
    expect(run({ 'x-lab-observer-token': 'u'.repeat(40) })?.status).toBe(401);
    expect(run({ 'x-lab-observer-token': 'short' })?.status).toBe(401);
  });

  it('the exact token → next() with no error', () => {
    expect(run({ 'x-lab-observer-token': TOKEN })).toBeUndefined();
  });
});
