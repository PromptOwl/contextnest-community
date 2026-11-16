/**
 * Open the nest header's ⋯ menu ("More actions") and wait for `item` in it.
 *
 * Right after a page load or a view switch the header re-renders, and a click
 * that lands mid-render can leave the menu closed. So the click is repeated
 * while the menu is not open, a few times, before giving up. "Open" is Radix's
 * data-state="open": a menu still animating closed (after Escape or a pick)
 * is visible but is not the one to click into.
 *
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} [item] what must show in the open menu (default: the menu)
 */
export async function openMoreActions(page, item) {
  const trigger = page.locator('button[title="More actions"]').first();
  const menu = page.locator('[role="menu"][data-state="open"]');
  const target = item ?? menu;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!(await menu.isVisible())) await trigger.click();
    try {
      await menu.waitFor({ state: 'visible', timeout: 3_000 });
      await target.waitFor({ state: 'visible', timeout: 3_000 });
      return;
    } catch {
      // Not open yet: try again.
    }
  }
  await target.waitFor({ state: 'visible' });
}
