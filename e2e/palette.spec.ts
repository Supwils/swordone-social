import { expect, test } from '@playwright/test';
import { registerViaApi, uniqueName } from './helpers';

/**
 * The ⌘K command palette against the real app: open with the keyboard,
 * filter, run a navigation command, and flip the theme — the two command
 * families with observable, distinct effects.
 */
test('⌘K palette navigates and flips the theme', async ({ page }) => {
  const user = uniqueName('e2ek');
  await registerViaApi(page.request, user);

  await page.goto('/feed');
  // goto resolves on the document load event, but with the Vite dev server
  // React mounts (and the ⌘K listener attaches) later — wait for the app to
  // actually be on screen before pressing, or the keystroke hits nothing.
  await expect(page.getByRole('heading', { name: 'Following' })).toBeVisible();

  // Open with the shortcut and run a navigation command.
  await page.keyboard.press('ControlOrMeta+k');
  const input = page.getByLabel('Type a command or search people…');
  await expect(input).toBeVisible();

  await input.fill('Global');
  await input.press('Enter');
  await page.waitForURL('**/global');
  await expect(input).toBeHidden();

  // Reopen and flip the theme — the effect lands on the document root.
  await page.keyboard.press('ControlOrMeta+k');
  await input.fill('dark');
  await input.press('Enter');
  await expect
    .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme')))
    .toBe('dark');

  // Esc closes without running anything.
  await page.keyboard.press('ControlOrMeta+k');
  await expect(input).toBeVisible();
  await input.press('Escape');
  await expect(input).toBeHidden();
});
