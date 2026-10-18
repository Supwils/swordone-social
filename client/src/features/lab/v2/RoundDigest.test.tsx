import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/i18n';
import { RoundDigest } from './RoundDigest';
import { MANUAL_ID, makeDigest, SWEEP_ID } from './testFixtures';

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('en');
});

const renderDigest = (digest = makeDigest()) =>
  render(
    <MemoryRouter>
      <RoundDigest digest={digest} />
    </MemoryRouter>,
  );

describe('RoundDigest', () => {
  it('titles the round and shows one outcome chip per arm, warnings only when non-zero', () => {
    renderDigest();
    expect(screen.getByRole('heading', { name: `Round 1 · ${SWEEP_ID}` })).toBeTruthy();
    const haiku = screen.getByTestId('outcome-claude-haiku');
    expect(within(haiku).getByText('4 cycles')).toBeTruthy();
    expect(within(haiku).getByText('5/6 actions landed')).toBeTruthy();
    expect(within(haiku).getByText('2 dreamed')).toBeTruthy();
    expect(within(haiku).queryByText(/failed/)).toBeNull();
    const grok = screen.getByTestId('outcome-grok');
    expect(within(grok).getByText('1 failed')).toBeTruthy();
    expect(within(grok).getByText('1 missing')).toBeTruthy();
    expect(
      within(screen.getByTestId('outcome-claude-opus')).getByText('1 model mismatch'),
    ).toBeTruthy();
  });

  it('links highlights to the post and the author', () => {
    renderDigest();
    const most = screen.getByTestId('most-in');
    expect(within(most).getByRole('link', { name: '@xiaoman' }).getAttribute('href')).toBe(
      '/u/xiaoman',
    );
    expect(
      within(most)
        .getByRole('link', { name: '夜班结束，多肉又长了一片叶子。' })
        .getAttribute('href'),
    ).toBe('/p/p1');
    expect(within(screen.getByTestId('least-in')).getByText('@awen')).toBeTruthy();
    // `fmtNum` (features/lab/format.ts) prints 3 decimals.
    expect(within(screen.getByTestId('most-alike')).getByText('0.610')).toBeTruthy();
  });

  it('shows conversations, interactions, dreams and new words', () => {
    renderDigest();
    const conv = screen.getByTestId('conversations');
    expect(within(conv).getByText('@awen · @xiaoman · @zhenxian')).toBeTruthy();
    expect(within(conv).getByText('across arms')).toBeTruthy();
    expect(screen.getByText('9 interactions · 7 across arms · 2 within an arm')).toBeTruthy();
    expect(
      within(screen.getByTestId('dreams')).getByText('moved 0.050 from the previous version'),
    ).toBeTruthy();
    expect(within(screen.getByTestId('new-words')).getByText('多肉植')).toBeTruthy();
    expect(screen.getByText('from @xiaoman, picked up by @ajie, @awen')).toBeTruthy();
  });

  it('a dream without a filed diff shows the drift line only', () => {
    renderDigest();
    const dreams = screen.getByTestId('dreams');
    expect(within(dreams).getByText('moved 0.050 from the previous version')).toBeTruthy();
    expect(within(dreams).queryByRole('list', { name: /最近/ })).toBeNull();
    expect(dreams.querySelector('del')).toBeNull();
  });

  it('a dream with a filed diff marks added items, strikes removed ones, keeps the rest plain', () => {
    const base = makeDigest();
    renderDigest(
      makeDigest({
        changes: {
          ...base.changes,
          dreams: [
            {
              ...base.changes.dreams[0],
              recent: { before: ['旧的一条', '留下的'], after: ['新的一条', '留下的'] },
            },
          ],
        },
      }),
    );
    const dreams = screen.getByTestId('dreams');
    // the drift line stays
    expect(within(dreams).getByText('moved 0.050 from the previous version')).toBeTruthy();
    const diff = within(dreams).getByRole('list', { name: '最近 of @xiaoman after this dream' });
    const items = within(diff).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual(['+ 新的一条', '留下的', '旧的一条']);
    expect(within(diff).getByText('旧的一条').tagName).toBe('DEL');
    expect(within(diff).getByText('+ 新的一条').querySelector('del')).toBeNull();
    expect(within(diff).getByText('留下的').querySelector('del')).toBeNull();
    expect(diff.querySelectorAll('del')).toHaveLength(1);
  });

  it('labels the 最近 diff in zh and renders list items as literal text', async () => {
    await i18n.changeLanguage('zh');
    const base = makeDigest();
    const markup = '<b>粗</b>';
    const { container } = renderDigest(
      makeDigest({
        changes: {
          ...base.changes,
          dreams: [{ ...base.changes.dreams[0], recent: { before: [], after: [markup] } }],
        },
      }),
    );
    const diff = screen.getByRole('list', { name: '@xiaoman 这次梦后的最近' });
    expect(within(diff).getByText(`+ ${markup}`)).toBeTruthy();
    expect(container.querySelector('b')).toBeNull();
  });

  it('an empty round says so in every list instead of rendering blanks', () => {
    renderDigest(
      makeDigest({
        posts: [],
        highlights: { mostInCharacter: [], leastInCharacter: [], mostAlike: [], conversations: [] },
        changes: { dreams: [], newWords: [] },
      }),
    );
    expect(screen.getAllByText('Nothing this round')).toHaveLength(6);
  });

  it('renders a markup excerpt as literal text and creates no element from it', () => {
    const markup = '<img src=x onerror=alert(1)>';
    const base = makeDigest();
    const { container } = renderDigest(
      makeDigest({
        posts: base.posts.map((p) => (p.postId === 'p1' ? { ...p, excerpt: markup } : p)),
      }),
    );
    expect(within(screen.getByTestId('most-in')).getByRole('link', { name: markup })).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
  });

  it('encodes the username and post id in profile and post links', () => {
    const base = makeDigest();
    renderDigest(
      makeDigest({
        highlights: {
          ...base.highlights,
          mostInCharacter: [{ postId: 'a/b?c', username: 'x y#z' }],
        },
      }),
    );
    const most = screen.getByTestId('most-in');
    expect(within(most).getByRole('link', { name: '@x y#z' }).getAttribute('href')).toBe(
      '/u/x%20y%23z',
    );
    expect(within(most).getByRole('link', { name: 'a/b?c' }).getAttribute('href')).toBe(
      '/p/a%2Fb%3Fc',
    );
  });

  it('uses singular English forms for a count of one', () => {
    const base = makeDigest();
    renderDigest(
      makeDigest({
        outcomes: {
          ...base.outcomes,
          'claude-haiku': {
            ...base.outcomes['claude-haiku'],
            cards: 1,
            landed: 1,
            attempted: 1,
            guardDrops: 1,
          },
        },
        interactions: { ...base.interactions, total: 1, crossArm: 1, withinArm: 0 },
        highlights: {
          ...base.highlights,
          conversations: [{ ...base.highlights.conversations[0], comments: 1 }],
        },
      }),
    );
    const haiku = screen.getByTestId('outcome-claude-haiku');
    expect(within(haiku).getByText('1 cycle')).toBeTruthy();
    expect(within(haiku).getByText('1/1 action landed')).toBeTruthy();
    expect(within(haiku).getByText('1 duplicate drop')).toBeTruthy();
    expect(screen.getByText('1 interaction · 1 across arms · 0 within an arm')).toBeTruthy();
    expect(within(screen.getByTestId('conversations')).getByText('1 comment')).toBeTruthy();
  });

  it('titles a zh round by its sweep ordinal, and a manual one by its id alone', async () => {
    await i18n.changeLanguage('zh');
    const { rerender } = renderDigest();
    expect(screen.getByRole('heading', { name: `第 1 轮 · ${SWEEP_ID}` })).toBeTruthy();
    const base = makeDigest();
    rerender(
      <MemoryRouter>
        <RoundDigest
          digest={makeDigest({
            round: { ...base.round, roundId: MANUAL_ID, kind: 'manual', ordinal: null },
          })}
        />
      </MemoryRouter>,
    );
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading.textContent).toBe(`轮次 ${MANUAL_ID}`);
    expect(heading.textContent).not.toMatch(/第/);
  });

  it('titles an unnumbered round by its id alone in English', () => {
    const base = makeDigest();
    renderDigest(
      makeDigest({ round: { ...base.round, roundId: MANUAL_ID, kind: 'manual', ordinal: null } }),
    );
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(`Round ${MANUAL_ID}`);
  });
});
