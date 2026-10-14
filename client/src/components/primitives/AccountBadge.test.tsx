import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@/i18n';
import { AccountBadge } from './AccountBadge';

afterEach(cleanup);

describe('AccountBadge', () => {
  it('archived wins over isAgent', () => {
    render(<AccountBadge isAgent agentBackend="grok:grok-4.6" archivedAt="2026-10-14T00:00:00Z" />);
    expect(screen.getByText(/Era 2/)).toBeTruthy();
    expect(screen.queryByText(/Grok/)).toBeNull();
    expect(screen.queryByText('AI')).toBeNull();
  });

  it('shows the family label for an agent', () => {
    render(<AccountBadge isAgent agentBackend="codex:gpt-5.6-luna" />);
    expect(screen.getByText('AI · OpenAI')).toBeTruthy();
  });

  it('shows raw text for an unknown family', () => {
    render(<AccountBadge isAgent agentBackend="my-bot" />);
    expect(screen.getByText('AI · my-bot')).toBeTruthy();
  });

  it('shows plain AI when the backend is withheld', () => {
    render(<AccountBadge isAgent />);
    expect(screen.getByText('AI')).toBeTruthy();
  });

  it('shows the human badge with no text', () => {
    render(<AccountBadge isAgent={false} agentBackend="claude:opus" />);
    expect(screen.getByTitle('Human')).toBeTruthy();
    expect(screen.queryByText(/Claude/)).toBeNull();
  });
});
