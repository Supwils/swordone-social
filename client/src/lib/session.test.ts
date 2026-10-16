import { afterEach, describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import '@/i18n';
import { qk } from '@/api/queryKeys';
import { useDrafts } from '@/stores/draft.store';
import { useSession } from '@/stores/session.store';
import { useUI } from '@/stores/ui.store';
import { makePost, makeUser } from '@/test/fixtures';
import { applyNoSession, applySession } from './session';

afterEach(() => {
  useDrafts.setState({ drafts: {}, ownerId: null });
  useSession.setState({ user: null });
  useUI.getState().setLanguage('en');
  localStorage.removeItem('swil.ui');
  localStorage.removeItem('swil.drafts');
});

describe('applySession — drafts belong to one account', () => {
  it('drops drafts typed by a different account', () => {
    // A cookie that expired while the tab was closed never runs endSession:
    // the next account to sign in on this browser inherited the drafts.
    useDrafts.getState().claim('u-alice');
    useDrafts.getState().setDraft('post.new', "alice's half-thought");

    applySession(new QueryClient(), makeUser({ id: 'u-bob' }));

    expect(useDrafts.getState().drafts).toEqual({});
    expect(useDrafts.getState().ownerId).toBe('u-bob');
  });

  it("keeps the same account's drafts across a reload", () => {
    useDrafts.getState().claim('u-alice');
    useDrafts.getState().setDraft('post.new', 'mine');

    applySession(new QueryClient(), makeUser({ id: 'u-alice' }));

    expect(useDrafts.getState().getDraft('post.new')?.text).toBe('mine');
  });

  it('drops drafts when bootstrap finds no session at all', () => {
    useDrafts.getState().claim('u-alice');
    useDrafts.getState().setDraft('post.new', 'orphaned');

    applyNoSession();

    expect(useDrafts.getState().drafts).toEqual({});
    expect(useDrafts.getState().ownerId).toBeNull();
  });
});

describe('applySession — language', () => {
  it('marks post reads stale when it switches the UI language', () => {
    // Reads already answered in the stored language were cached under the
    // previous UI language's key.
    const qc = new QueryClient();
    const list = qk.feed.global('en', 'recommended');
    const detail = qk.posts.byId('64b7f0c2a1d3e4f5a6b7c8d9', 'en');
    qc.setQueryData(list, { pages: [], pageParams: [] });
    qc.setQueryData(detail, makePost());

    applySession(qc, makeUser({ id: 'u1', preferences: { language: 'zh' } }));

    expect(useUI.getState().language).toBe('zh');
    expect(qc.getQueryState(list)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(detail)?.isInvalidated).toBe(true);
  });

  it('leaves the cache alone when the language already matches', () => {
    const qc = new QueryClient();
    const list = qk.feed.global('en', 'recommended');
    qc.setQueryData(list, { pages: [], pageParams: [] });

    applySession(qc, makeUser({ id: 'u1', preferences: { language: 'en' } }));

    expect(qc.getQueryState(list)?.isInvalidated).toBe(false);
  });
});
