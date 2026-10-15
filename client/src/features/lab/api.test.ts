/**
 * Tests for the two lab reads added on 2026-08-20.
 *
 * WHY THE URL IS WORTH A TEST. Both endpoints default `range` to `30d`
 * server-side, so a request that dropped the caller's range would return a
 * plausible answer for the wrong window — and for the collapse watch the window
 * is not cosmetic: measured on `liushang`'s real posts the same collapse reads
 * -0.792 chars/day over its own 14 days, -0.046 over 30 (invisible), and +0.761
 * over 7 (the sign flips). A silently-30d request is a wrong answer that looks
 * right. The panel suites mock this module out, so nothing else covers it.
 *
 * The path is pinned for the same reason: the countdown route is
 * `/:username/drift-countdown`, not `/:username/countdown`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/client', () => ({ http: { get: vi.fn() } }));

import { http } from '@/api/client';
import {
  getAccountRounds,
  getAgentOverview,
  getAlerts,
  getArmsReport,
  getCollapseWatch,
  getDriftCountdown,
  getHomogenization,
  getInteractionGraph,
  getPopulationPulse,
  getRuntimeHealth,
  listLabAgents,
} from './api';

afterEach(() => {
  vi.clearAllMocks();
});

describe('lab reads carry the caller’s range', () => {
  it('asks the countdown endpoint for the range it was given', async () => {
    vi.mocked(http.get).mockResolvedValue({ data: { data: { username: 'liushang' } } });
    await getDriftCountdown('liushang', '90d');
    expect(vi.mocked(http.get).mock.calls[0][0]).toBe('/agents/liushang/drift-countdown?range=90d');
  });

  it('asks the collapse endpoint for the range it was given', async () => {
    vi.mocked(http.get).mockResolvedValue({ data: { data: { username: 'liushang' } } });
    await getCollapseWatch('liushang', '7d');
    expect(vi.mocked(http.get).mock.calls[0][0]).toBe('/agents/liushang/collapse?range=7d');
  });

  it('unwraps the envelope rather than returning it', async () => {
    const payload = { username: 'liushang', verdict: 'shrinking' };
    vi.mocked(http.get).mockResolvedValue({ data: { data: payload } });
    await expect(getCollapseWatch('liushang', '30d')).resolves.toBe(payload);
  });

  it('asks the runtime endpoint for the range it was given', async () => {
    vi.mocked(http.get).mockResolvedValue({ data: { data: { rounds: 17 } } });
    await getRuntimeHealth(3, '7d');
    expect(vi.mocked(http.get).mock.calls[0][0]).toBe('/agents/runtime?range=7d&era=3');
  });
});

/**
 * Era scoping (S2 §6). The server defaults a missing `era` to 3, so a read that
 * dropped the caller's era would serve the live roster to the sealed Era 2 view
 * and nothing would look wrong. Every era-aware read therefore ALWAYS sends the
 * era it was given — both values pinned, so neither is the silent default.
 */
describe('lab population reads carry the caller’s era', () => {
  const path = () => vi.mocked(http.get).mock.calls[0][0];

  it.each([2, 3] as const)('roster sends era=%s', async (era) => {
    vi.mocked(http.get).mockResolvedValue({ data: { data: { items: [] } } });
    await listLabAgents(era, 100);
    expect(path()).toBe(`/agents?limit=100&era=${era}`);
  });

  it.each([2, 3] as const)('overview sends era=%s', async (era) => {
    vi.mocked(http.get).mockResolvedValue({ data: { data: {} } });
    await getAgentOverview(era);
    expect(path()).toBe(`/agents/overview?era=${era}`);
  });

  it.each([2, 3] as const)('graph sends era=%s with the range', async (era) => {
    vi.mocked(http.get).mockResolvedValue({ data: { data: {} } });
    await getInteractionGraph(era, '90d');
    expect(path()).toBe(`/agents/graph?range=90d&era=${era}`);
  });

  it.each([2, 3] as const)('homogenization sends era=%s with the range', async (era) => {
    vi.mocked(http.get).mockResolvedValue({ data: { data: {} } });
    await getHomogenization(era, '7d');
    expect(path()).toBe(`/agents/homogenization?range=7d&era=${era}`);
  });

  it.each([2, 3] as const)('pulse sends era=%s with the range', async (era) => {
    vi.mocked(http.get).mockResolvedValue({ data: { data: {} } });
    await getPopulationPulse(era, '90d');
    expect(path()).toBe(`/agents/pulse?range=90d&era=${era}`);
  });

  it.each([2, 3] as const)('alerts sends era=%s with the range', async (era) => {
    vi.mocked(http.get).mockResolvedValue({ data: { data: {} } });
    await getAlerts(era, '7d');
    expect(path()).toBe(`/agents/alerts?range=7d&era=${era}`);
  });

  it('runtime sends era=2 for the sealed view', async () => {
    vi.mocked(http.get).mockResolvedValue({ data: { data: {} } });
    await getRuntimeHealth(2, '90d');
    expect(path()).toBe('/agents/runtime?range=90d&era=2');
  });

  it('roster unwraps the items list', async () => {
    const items = [{ username: 'xiaoman' }];
    vi.mocked(http.get).mockResolvedValue({ data: { data: { items } } });
    await expect(listLabAgents(3)).resolves.toBe(items);
    expect(path()).toBe('/agents?limit=50&era=3');
  });
});

describe('Era 3 arms reads', () => {
  it('fetches the arms report with no era (it is Era 3 by definition)', async () => {
    const payload = { completedRounds: 4, targetRounds: 12 };
    vi.mocked(http.get).mockResolvedValue({ data: { data: payload } });
    await expect(getArmsReport()).resolves.toBe(payload);
    expect(vi.mocked(http.get).mock.calls[0][0]).toBe('/agents/arms');
  });

  it('fetches one account’s rounds, username encoded', async () => {
    const payload = { username: 'xiaoman', arm: 'claude-haiku', rounds: [] };
    vi.mocked(http.get).mockResolvedValue({ data: { data: payload } });
    await expect(getAccountRounds('xiaoman')).resolves.toBe(payload);
    expect(vi.mocked(http.get).mock.calls[0][0]).toBe('/agents/xiaoman/rounds');

    await getAccountRounds('a b');
    expect(vi.mocked(http.get).mock.calls[1][0]).toBe('/agents/a%20b/rounds');
  });
});
