import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@/i18n';

vi.mock('@/features/lab/Sparkline', () => ({ Sparkline: () => null }));

import type { AgentSummaryDTO, ArmId } from '@/features/lab/types';
import { makeLabAgent } from '@/test/fixtures';
import { ArmRoster } from './ArmRoster';

function agent(username: string, arm: ArmId | null, agentBackend: string): AgentSummaryDTO {
  return makeLabAgent({
    id: `id-${username}`,
    username,
    displayName: username,
    agentBackend,
    arm,
    followerCount: 3,
    postCount: 5,
    postsLast7d: 2,
  });
}

const AGENTS = [
  agent('awen', 'grok', 'grok:grok-4.6'),
  agent('xiaolin', 'grok', 'grok:grok-4.6'),
  agent('xiaoman', 'claude-haiku', 'claude:claude-haiku-5-5'),
  agent('zhenxian', 'openai', 'codex:gpt-5.6-luna'),
];

afterEach(cleanup);

describe('ArmRoster', () => {
  it('lists every arm with its count and filters the grid to one arm', () => {
    render(<ArmRoster agents={AGENTS} loading={false} focusedUsername={null} onFocus={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'All (4)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Gemini (0)' })).toBeTruthy();
    expect(screen.getByText('@xiaoman')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Grok (2)' }));
    expect(screen.getByText('@awen')).toBeTruthy();
    expect(screen.getByText('@xiaolin')).toBeTruthy();
    expect(screen.queryByText('@xiaoman')).toBeNull();
    expect(screen.queryByText('@zhenxian')).toBeNull();
    expect(screen.getByRole('button', { name: 'Grok (2)' }).getAttribute('aria-pressed')).toBe(
      'true',
    );

    fireEvent.click(screen.getByRole('button', { name: 'All (4)' }));
    expect(screen.getByText('@zhenxian')).toBeTruthy();
  });

  it('shows the model-family badge on each card instead of the AI/human tag', () => {
    render(<ArmRoster agents={AGENTS} loading={false} focusedUsername={null} onFocus={vi.fn()} />);
    expect(screen.getAllByText('AI · Grok')).toHaveLength(2);
    expect(screen.getByText('AI · Claude Haiku')).toBeTruthy();
    expect(screen.getByText('AI · OpenAI')).toBeTruthy();
  });

  it('focuses an account when its card is clicked', () => {
    const onFocus = vi.fn();
    render(<ArmRoster agents={AGENTS} loading={false} focusedUsername={null} onFocus={onFocus} />);
    fireEvent.click(screen.getByText('@awen'));
    expect(onFocus).toHaveBeenCalledWith('awen');
  });
});
