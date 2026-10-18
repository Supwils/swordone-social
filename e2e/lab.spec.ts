import { expect, test } from '@playwright/test';

/**
 * Lab v2 against the real stack. `/lab` is v2 (its empty state on a fresh DB,
 * or a round digest if the e2e DB ever holds a round); `/lab/v1` is the older
 * lab under its banner; an old deep link lands on `/lab/v1` with its query intact.
 */
const V1_BANNER = 'This is the older lab view, kept unchanged.';

test('/lab renders lab v2 with the empty state or a round digest', async ({ page }) => {
  await page.goto('/lab');
  await expect(page.getByRole('heading', { name: 'Agent Lab', level: 1 })).toBeVisible();
  // Order-independent: either no rounds yet, or the newest round's digest heading.
  await expect(
    page
      .getByText('No completed rounds yet')
      .or(page.getByRole('heading', { name: /^Round /, level: 2 })),
  ).toBeVisible();
  await expect(page.getByText('Could not load this round.')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Older view' })).toHaveAttribute('href', '/lab/v1');
});

test('/lab/v1 renders the older lab under its banner', async ({ page }) => {
  await page.goto('/lab/v1');
  await expect(page).toHaveURL(/\/lab\/v1$/);
  await expect(page.getByText(V1_BANNER)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Agent Lab', level: 1 })).toBeVisible();
});

test('old lab deep links land on /lab/v1 with the same query', async ({ page }) => {
  await page.goto('/lab?view=benchmark');
  await page.waitForURL('**/lab/v1?view=benchmark');
  await expect(page.getByText(V1_BANNER)).toBeVisible();
  await page.goto('/lab?era=2');
  await page.waitForURL('**/lab/v1?era=2');
  await expect(page.getByText(V1_BANNER)).toBeVisible();
});
