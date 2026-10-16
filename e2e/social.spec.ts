import {
  expect,
  test,
  type APIRequestContext,
  type PlaywrightWorkerArgs,
} from '@playwright/test';
import { BASE_URL } from '../playwright.config';
import { registerViaApi, uniqueName } from './helpers';

/**
 * Social flows across the real stack: DMs (UI compose → API receipt → a
 * socket-delivered reply landing in the open thread), bookmarks (feed action →
 * /bookmarks), and echo rendering (nested original). Each test registers its
 * own throwaway accounts; nothing depends on seed data.
 */

/** A second, independent API session (its own cookie jar) registered as `username`. */
async function registerApiContext(
  playwright: PlaywrightWorkerArgs['playwright'],
  username: string,
): Promise<APIRequestContext> {
  const ctx = await playwright.request.newContext({ baseURL: BASE_URL });
  await registerViaApi(ctx, username);
  return ctx;
}

test('two humans hold a DM conversation across UI, API, and the socket', async ({
  page,
  playwright,
}) => {
  const alice = uniqueName('e2ea');
  const bob = uniqueName('e2eb');
  await registerViaApi(page.request, alice); // the page browses as alice
  const bobApi = await registerApiContext(playwright, bob);

  // Alice starts the conversation from the Messages screen.
  await page.goto('/messages');
  await page.getByLabel('Search users').fill(bob);
  await page.getByRole('option').first().locator('button').click();
  await page.waitForURL('**/messages/**');

  await page.getByLabel('Your message').fill('hello bob from e2e');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('hello bob from e2e')).toBeVisible();

  // Bob sees the conversation, unread, with the message as the preview.
  // POLL, don't snapshot: the server emits the sender's socket frame before
  // the conversation row finishes persisting (see lib/messageCache.ts), so
  // alice's visible bubble does not imply bob's list row exists yet.
  type ConvoRow = { id: string; unread: boolean; lastMessage: { text: string } | null };
  let convo: ConvoRow | undefined;
  await expect
    .poll(
      async () => {
        const res = await bobApi.get('/api/v1/conversations');
        expect(res.status()).toBe(200);
        const items = (await res.json()).data.items as ConvoRow[];
        convo = items.find((c) => c.lastMessage?.text === 'hello bob from e2e');
        return convo ? 'found' : 'missing';
      },
      { timeout: 10_000 },
    )
    .toBe('found');
  expect(convo!.unread).toBe(true);

  // Bob replies over the API; alice's OPEN thread must receive it live over
  // the socket — no reload. This is the conversation-room realtime path.
  const reply = await bobApi.post(`/api/v1/conversations/${convo!.id}/messages`, {
    data: { text: 'hi alice, over the socket' },
  });
  expect(reply.status(), await reply.text()).toBe(201);

  await expect(page.getByText('hi alice, over the socket')).toBeVisible({ timeout: 15_000 });

  await bobApi.dispose();
});

test('bookmarking from the feed lands the post on /bookmarks', async ({ page }) => {
  const user = uniqueName('e2ebm');
  await registerViaApi(page.request, user);

  const marker = `bookmark me ${user}`;
  const created = await page.request.post('/api/v1/posts', { data: { text: marker } });
  expect(created.status(), await created.text()).toBe(201);

  await page.goto('/global');
  const card = page.locator('article').filter({ hasText: marker }).first();
  await card.getByRole('button', { name: 'Bookmark', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Remove bookmark' })).toBeVisible();

  await page.goto('/bookmarks');
  await expect(page.getByText(marker)).toBeVisible();
});

test('an echo renders its commentary with the original nested inside', async ({ page }) => {
  const user = uniqueName('e2eec');
  await registerViaApi(page.request, user);

  const originalText = `original thought ${user}`;
  const post = await page.request.post('/api/v1/posts', { data: { text: originalText } });
  expect(post.status(), await post.text()).toBe(201);
  const postId = (await post.json()).data.post.id as string;

  const commentary = `echoing this ${user}`;
  const echo = await page.request.post('/api/v1/posts', {
    data: { text: commentary, echoOf: postId },
  });
  expect(echo.status(), await echo.text()).toBe(201);

  await page.goto('/global');
  const echoCard = page.locator('article').filter({ hasText: commentary }).first();
  await expect(echoCard.getByText(originalText)).toBeVisible();
});
