// Playwright end-to-end suite. Boots the app in DEMO_MODE so the tests are
// hermetic: no Azure DevOps account, no network, deterministic data.
const { defineConfig, devices } = require('@playwright/test');

const PORT = 3399;

module.exports = defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `DEMO_MODE=true PORT=${PORT} node server.js`,
    url: `http://localhost:${PORT}/api/config`,
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});
