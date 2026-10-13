const { test, expect } = require('@playwright/test');

const rows = page => page.locator('#tableBody tr');

test.describe('Pull Requests (PR aging)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/prs.html');
    await expect(page.locator('#loadingOverlay')).not.toHaveClass(/on/);
  });

  test('summary cards and the staleness caveat render', async ({ page }) => {
    await expect(page.locator('#staleness-notice')).toBeVisible();
    const total = Number(await page.locator('#statTotal').textContent());
    expect(total).toBeGreaterThan(0);
    await expect(rows(page)).toHaveCount(total);
    await expect(page.locator('#statCycleAvg')).toHaveText(/\d+(\.\d+)?d/);
  });

  test('time-to-merge caption shows a real count (regression for "undefined PRs")', async ({ page }) => {
    await expect(page.locator('#cycleSubhead')).toHaveText(/\(\d+ PRs merged in last 30 days\)/);
  });

  test('review-state filters remove matching rows', async ({ page }) => {
    const total    = await rows(page).count();
    const awaiting = Number(await page.locator('#statAwaiting').textContent());
    expect(awaiting).toBeGreaterThan(0);
    await page.uncheck('#fAwaiting');
    await expect(rows(page)).toHaveCount(total - awaiting);
  });

  test('"Conflicts only" isolates the PR with a merge conflict', async ({ page }) => {
    await page.check('#fConflicts');
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('webhook on aging threshold');
  });

  test('cycle-time window is switchable', async ({ page }) => {
    await page.click('#settingsToggle');
    await page.selectOption('#cfgCycleDays', '90');
    await page.click('#settingsFooter button');
    await expect(page.locator('#cycleSubhead')).toHaveText(/in last 90 days/);
  });
});
