const { test, expect } = require('@playwright/test');

const rows = page => page.locator('#tableBody tr');

test.describe('Work Items (WIP aging)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/index.html');
    await expect(page.locator('#loadingOverlay')).not.toHaveClass(/on/);
  });

  test('summary cards agree with the table', async ({ page }) => {
    await expect(page.locator('#topProject')).toContainText('demo data');
    const total = Number(await page.locator('#statTotal').textContent());
    expect(total).toBeGreaterThan(0);
    await expect(rows(page)).toHaveCount(total);
    await expect(page.locator('#tableTitle')).toContainText(`(${total})`);
    const bands = ['#statGreen', '#statYellow', '#statRed'];
    let sum = 0;
    for (const sel of bands) sum += Number(await page.locator(sel).textContent());
    expect(sum).toBeLessThanOrEqual(total); // orange band has no card; the rest partition the total
  });

  test('default sort is most-aged first and the stuck items are critical', async ({ page }) => {
    const first = rows(page).first();
    await expect(first).toContainText('Critical');
    const days = await rows(page).locator('td:nth-child(6)').allTextContents();
    const nums = days.map(d => parseInt(d, 10));
    for (let i = 1; i < nums.length; i++) expect(nums[i]).toBeLessThanOrEqual(nums[i - 1]);
    expect(nums[0]).toBeGreaterThan(21);
  });

  test('search narrows the table and clearing restores it', async ({ page }) => {
    const total = await rows(page).count();
    await page.fill('#searchInput', 'SSO integration');
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('SSO integration with corporate IdP');
    await page.fill('#searchInput', '');
    await expect(rows(page)).toHaveCount(total);
  });

  test('unchecking a work item type hides those rows', async ({ page }) => {
    const total = await rows(page).count();
    const bugs  = await rows(page).filter({ hasText: 'Bug' }).count();
    expect(bugs).toBeGreaterThan(0);
    await page.uncheck('#fBug');
    await expect(rows(page)).toHaveCount(total - bugs);
    await page.check('#fBug');
    await expect(rows(page)).toHaveCount(total);
  });

  test('tag filters are built from the data and filter rows', async ({ page }) => {
    const group = page.locator('#tagFilterGroup');
    await expect(group).toBeVisible();
    const blocked = group.locator('input[data-tag="blocked"]');
    await expect(blocked).toBeChecked();
    const total = await rows(page).count();
    await blocked.uncheck();
    await expect(rows(page)).not.toHaveCount(total);
    await expect(rows(page).filter({ hasText: 'SSO integration' })).toHaveCount(0);
  });

  test('aging thresholds are editable and relabel the bands', async ({ page }) => {
    await page.click('#settingsToggle');
    await page.fill('#cfgThresholds', '10,20,40');
    await page.click('#settingsFooter button');
    await expect(page.locator('#settingsMsg')).toContainText('Saved');
    // Preferences live in localStorage and are applied on load — a reload proves they persisted.
    await page.reload();
    await expect(page.locator('#loadingOverlay')).not.toHaveClass(/on/);
    await expect(page.locator('#lblGreen')).toContainText('0–10');
    await expect(page.locator('#lblRed')).toContainText('41+');
    await page.evaluate(() => localStorage.clear());
  });
});
