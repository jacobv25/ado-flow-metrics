const { test, expect } = require('@playwright/test');

test.describe('Forecast (throughput, outliers, Monte Carlo)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/forecast.html');
    await expect(page.locator('#loadingOverlay')).not.toHaveClass(/on/);
    await expect(page.locator('#tpTotal')).not.toHaveText(/^(—|0)?$/);
  });

  test('throughput cards are internally consistent', async ({ page }) => {
    const total = Number(await page.locator('#tpTotal').textContent());
    const mean  = Number(await page.locator('#tpMean').textContent());
    const max   = Number(await page.locator('#tpMax').textContent());
    const min   = Number(await page.locator('#tpMin').textContent());
    const n     = Number(await page.locator('#tpBuckets').textContent());
    expect(total).toBeGreaterThan(0);
    expect(min).toBeLessThanOrEqual(mean);
    expect(mean).toBeLessThanOrEqual(max);
    expect(Math.abs(mean - total / n)).toBeLessThan(0.05);
  });

  test('outlier insights flag the holiday dip low and the catch-up week high', async ({ page }) => {
    const panel = page.locator('#outlierInsightsPanel');
    await expect(panel).toBeVisible();
    await expect(page.locator('#outlierInsightsSubhead')).toContainText(/[1-9] outliers? detected via Tukey IQR/);
    const body = page.locator('#outlierInsightsBody');
    await expect(body).toContainText('LOW');
    await expect(body).toContainText('HIGH');
    await expect(body).toContainText(/capacity may have been reduced/);
  });

  test('"how long" forecast yields four monotonically later dates', async ({ page }) => {
    await page.fill('#fcItems', '30');
    await page.click('#runBtn');
    await expect(page.locator('#fcItemsLabel')).toHaveText('30');
    const cards = page.locator('#howLongCards .fc-conf-card');
    await expect(cards).toHaveCount(4);
    const texts = await cards.allTextContents();
    const dates = texts.map(t => new Date((t.match(/[A-Z][a-z]{2} \d{1,2}, \d{4}/) || [])[0]).getTime());
    for (const d of dates) expect(Number.isNaN(d)).toBe(false);
    for (let i = 1; i < dates.length; i++) expect(dates[i]).toBeGreaterThanOrEqual(dates[i - 1]);
    await expect(cards.nth(2)).toContainText('85%');
  });

  test('a deadline switches to "how many by date" mode', async ({ page }) => {
    const deadline = new Date(Date.now() + 28 * 864e5).toISOString().slice(0, 10);
    await page.fill('#fcDeadline', deadline);
    await page.click('#runBtn');
    await expect(page.locator('#howManySection')).toBeVisible();
    await expect(page.locator('#fcDeadlineLabel')).not.toHaveText('—');
    const cards = page.locator('#howManyCards > *');
    await expect(cards).not.toHaveCount(0);
    await expect(cards.first()).toContainText(/\d+/);
  });

  test('cycle-time panel reports ordered percentiles', async ({ page }) => {
    await expect(page.locator('#ctPanel')).toBeVisible();
    const pct = async sel => parseFloat((await page.locator(sel).textContent()).replace(/[^\d.]/g, ''));
    const p50 = await pct('#ctP50Label'), p85 = await pct('#ctP85Label'), p95 = await pct('#ctP95Label');
    expect(p50).toBeLessThanOrEqual(p85);
    expect(p85).toBeLessThanOrEqual(p95);
  });
});

test.describe('Explain with AI (demo stub, no key)', () => {
  test('renders a structured explanation inside the outlier card', async ({ page }) => {
    await page.goto('/forecast.html');
    await expect(page.locator('#loadingOverlay')).not.toHaveClass(/on/);
    const btn = page.locator('.oc-ai-btn').first();
    await expect(btn).toBeVisible();
    await btn.click();
    const box = page.locator('.oc-ai').first();
    await expect(box).toBeVisible();
    await expect(box.locator('.ai-headline')).not.toBeEmpty();
    await expect(box).toContainText(/Likely causes/i);
    await expect(box).toContainText(/Questions to ask/i);
    await expect(box.locator('.ai-sample')).toHaveText('Sample explanation');
    await expect(btn).toBeEnabled();
  });
});
