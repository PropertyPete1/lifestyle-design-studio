/**
 * auth.setup.mjs — get past the passcode wall, once.
 *
 * The dashboard is a single passcode field with no username. Logging in inside
 * every test would mean typing the secret half a dozen times per run, so this
 * runs once as a setup project and hands the saved session to everything else.
 *
 * THE PASSCODE MUST NOT END UP IN AN ARTIFACT. Screenshots and traces are
 * disabled for this project specifically: a failure screenshot of a login form
 * is a screenshot of a filled password field, and these artifacts are uploaded
 * and kept for two weeks. The field is also cleared before any assertion can
 * fail, so even a trace captured by accident holds an empty input.
 */

import { test as setup, expect } from "@playwright/test";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const STORAGE = ".auth/state.json";

setup("sign in with the passcode", async ({ page }) => {
  const pass = process.env.DASHBOARD_PASS;
  if (!pass) {
    throw new Error(
      "DASHBOARD_PASS is not set. The dashboard is behind a passcode wall, so without it " +
        "the suite can only test the login screen."
    );
  }

  await page.goto("/", { waitUntil: "networkidle" });

  // Find the passcode input without assuming how it is labelled. A password
  // input is the strong signal; a lone text input on a page this small is the
  // fallback for an app that did not mark it as one.
  let field = page.locator('input[type="password"]').first();
  if ((await field.count()) === 0) {
    field = page.locator('input[type="text"], input:not([type])').first();
  }
  if ((await field.count()) === 0) {
    // Already through, or the wall is gone.
    console.log("  [auth] no passcode field found — treating the app as open");
    await page.context().storageState({ path: STORAGE });
    return;
  }

  await field.fill(pass);

  // Submit however this form wants to be submitted.
  const submit = page
    .getByRole("button", { name: /enter|submit|sign in|log ?in|continue|unlock|go/i })
    .first();
  if ((await submit.count()) > 0) {
    await submit.click().catch(() => {});
  } else {
    await field.press("Enter");
  }

  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1500);

  // Clear the field before anything can fail with it on screen.
  await field.fill("").catch(() => {});

  const stillGated =
    (await page.locator('input[type="password"]').count()) > 0 ||
    /incorrect|invalid|try again|wrong passcode/i.test((await page.textContent("body").catch(() => "")) || "");

  if (stillGated) {
    throw new Error(
      "The passcode was rejected, or the wall did not clear. Check DASHBOARD_PASS. " +
        "(The value itself is never printed or screenshotted.)"
    );
  }

  const body = (await page.textContent("body").catch(() => "")) || "";
  console.log(`  [auth] through the wall — ${body.length} chars of app rendered`);

  if (!existsSync(dirname(STORAGE))) mkdirSync(dirname(STORAGE), { recursive: true });
  await page.context().storageState({ path: STORAGE });
});
