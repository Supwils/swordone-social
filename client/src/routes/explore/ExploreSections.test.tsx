import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import '@/i18n';
import {
  makeAgentSummaryItem,
  makeFeaturedTopic,
  makePost,
  makeTag,
  makeUserLite,
} from '@/test/fixtures';
import { ExploreHero } from './ExploreHero';
import { ExploreAgents } from './ExploreAgents';
import { ExploreTopics } from './ExploreTopics';
import { ExploreTrendingTags } from './ExploreTrendingTags';

function withRouter(node: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={['/explore']}>
      <Routes>
        <Route path="/explore" element={node} />
        <Route path="/p/:id" element={<div>POST-DEST</div>} />
        <Route path="/tag/:slug" element={<div>TAG-DEST</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  // ExploreHero's relative time reads the wall clock — pin it.
  vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-01-01T12:00:00.000Z').getTime());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ExploreHero', () => {
  const post = makePost({
    id: 'p-1',
    text: '## Heading\n**bold** and *soft* thoughts',
    createdAt: '2026-01-01T10:00:00.000Z', // 2h before the pinned clock
    author: makeUserLite({
      id: 'u-a',
      username: 'zenith',
      usernameDisplay: 'zenith',
      displayName: 'Zenith',
      isAgent: true,
    }),
  });

  it('renders nothing without a featured post', () => {
    const { container } = withRouter(<ExploreHero post={null} />);
    expect(container.textContent).toBe('');
  });

  it('strips markdown for the excerpt and shows the pinned relative time', () => {
    withRouter(<ExploreHero post={post} />);

    expect(screen.getByText('Heading bold and soft thoughts')).toBeTruthy();
    expect(screen.getByText('2h')).toBeTruthy();
    expect(screen.getByText('Zenith')).toBeTruthy();
  });

  it('formats time with the shared formatter, so a fresh post is not "0m"', () => {
    // The hero had its own floor-based formatter; every other timestamp in the
    // app goes through formatRelative, which says "just now" under 45s.
    withRouter(<ExploreHero post={{ ...post, createdAt: '2026-01-01T11:59:50.000Z' }} />);

    const time = screen.getByText('just now');
    expect(time.tagName).toBe('TIME');
    expect(time.getAttribute('datetime')).toBe('2026-01-01T11:59:50.000Z');
  });

  it('navigates to the permalink from the read-more button', () => {
    withRouter(<ExploreHero post={post} />);

    fireEvent.click(screen.getByRole('button', { name: 'Read the full post →' }));
    expect(screen.getByText('POST-DEST')).toBeTruthy();
  });
});

describe('ExploreAgents', () => {
  const agent = makeAgentSummaryItem({
    id: 'a-1',
    username: 'gewu',
    usernameDisplay: 'gewu',
    displayName: '格物',
    headline: 'measures everything',
    agentBackend: 'codex',
    latestPostExcerpt: '### note\nquiet observation',
  });

  it('renders nothing for an empty roster', () => {
    const { container } = withRouter(<ExploreAgents agents={[]} />);
    expect(container.textContent).toBe('');
  });

  it('renders card identity, backend badge, and stripped excerpt', () => {
    withRouter(<ExploreAgents agents={[agent]} />);

    expect(screen.getByText('格物')).toBeTruthy();
    expect(screen.getByText('@gewu')).toBeTruthy();
    expect(screen.getByText('AI · OpenAI')).toBeTruthy();
    expect(screen.getByText('measures everything')).toBeTruthy();
    expect(screen.getByText('note quiet observation…')).toBeTruthy();
  });
});

describe('ExploreTopics', () => {
  // No coverImage: the server omits the key when a tag has none (never null).
  const topic = makeFeaturedTopic({
    slug: 'ai-gov',
    display: 'ai-gov',
    description: 'measurement and power',
    postCount: 1234,
  });

  it('renders nothing without topics', () => {
    const { container } = withRouter(<ExploreTopics topics={[]} />);
    expect(container.textContent).toBe('');
  });

  it('shows the card and navigates to the tag feed on click', () => {
    withRouter(<ExploreTopics topics={[topic]} />);

    expect(screen.getByText('#ai-gov')).toBeTruthy();
    expect(screen.getByText('measurement and power')).toBeTruthy();
    expect(screen.getByText('1,234 posts')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'ai-gov' }));
    expect(screen.getByText('TAG-DEST')).toBeTruthy();
  });
});

describe('ExploreTrendingTags', () => {
  const tags = [
    makeTag({ slug: 'big', display: 'big', postCount: 100 }),
    makeTag({ slug: 'small', display: 'small', postCount: 25 }),
  ];

  it('renders nothing without tags', () => {
    const { container } = withRouter(<ExploreTrendingTags tags={[]} />);
    expect(container.textContent).toBe('');
  });

  it('weights font size and opacity by relative post count', () => {
    withRouter(<ExploreTrendingTags tags={tags} />);

    const big = screen.getByRole('button', { name: '#big' });
    const small = screen.getByRole('button', { name: '#small' });
    // ratio 1 -> 0.78 + 0.46 = 1.24rem, opacity 1; ratio 0.25 -> 0.895rem.
    expect(big.style.fontSize).toBe('1.24rem');
    expect(big.style.opacity).toBe('1');
    expect(small.style.fontSize).toBe('0.895rem');
  });

  it('navigates to the tag feed in-app instead of reloading the document', () => {
    // Was `window.location.href = ...` — the only full reload in the SPA.
    withRouter(<ExploreTrendingTags tags={tags} />);

    fireEvent.click(screen.getByRole('button', { name: '#big' }));
    expect(screen.getByText('TAG-DEST')).toBeTruthy();
  });
});
