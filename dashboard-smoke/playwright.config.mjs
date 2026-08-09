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
  // One worker. Several of these checks post to a shared webhook and clean up
  // after themselves; running them in parallel would have them deleting each
  // other's fixtures.
  workers: 1,
  fullyParallel: false,
  // A smoke suite that retries is a smoke suite that hides a flaky deploy.
  retries: 0,
  /**
   * ONE FAILURE MUST NEVER HIDE THE REST.
   *
   * On 2026-08-09 the approval-card test failed and the run reported "3 did not
   * run" — the three that check Deliveries, Copy Caption and the camera screens.
   * A long-form rendering bug had made the entire daily side of the dashboard
   * unreportable, and the summary still read like a complete result.
   *
   * That is the same shape as the outage this suite was run to investigate: an
   * accurate red signal that answers a different question than the one being
   * asked. Pinned to 0 (no limit) so every check always reports.
   */
  maxFailures: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "report" }]],
  use: {
    baseURL: process.env.DASHBOARD_URL,
    ignoreHTTPSErrors: false,
    actionTimeout: 10_000,
  },
  projects: [
    {
      // Runs first and hands its session to the suite. Screenshots and traces
      // are OFF here on purpose: a failure screenshot of a login form is a
      // screenshot of a filled passcode field, and these artifacts are uploaded.
      name: "setup",
      testMatch: /auth\.setup\.mjs/,
      use: { ...devices["Desktop Chrome"], screenshot: "off", trace: "off", video: "off" },
    },
    {
      name: "chromium",
      testMatch: /smoke\.spec\.mjs/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: ".auth/state.json",
        // Failures only — this runs against production and a clean run should
        // leave nothing behind worth storing.
        screenshot: "only-on-failure",
        trace: "retain-on-failure",
        video: "off",
      },
    },
  ],
});
