import { defineConfig, devices } from "@playwright/test";

/**
 * Black-box smoke tests against the DEPLOYED dashboard.
 *
 * There is no dev server here and there never should be: the point is to test
 * what Manus actually shipped, at the URL Peter actually opens, after a deploy.
 * Anything that passes against a local build proves nothing about production.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.mjs",
  // One worker. Several of these checks post to a shared webhook and clean up
  // after themselves; running them in parallel would have them deleting each
  // other's fixtures.
  workers: 1,
  fullyParallel: false,
  // A smoke suite that retries is a smoke suite that hides a flaky deploy.
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "report" }]],
  use: {
    baseURL: process.env.DASHBOARD_URL,
    // Screenshots and traces on failure only — this runs against production and
    // a passing run should leave nothing behind worth storing.
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
    ignoreHTTPSErrors: false,
    actionTimeout: 10_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
