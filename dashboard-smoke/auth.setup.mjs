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

  // DESCRIBE THE FORM BEFORE TOUCHING IT.
  //
  // The first authenticated run failed with "passcode rejected", which is three
  // different problems wearing one message: a wrong secret, a submit that never
  // fired, or a field this code never found. Structure — never values — tells
  // them apart, and a segmented one-box-per-digit passcode would look exactly
  // like a rejected password from the outside.
  const form = await page.evaluate(() => ({
    inputs: Array.from(document.querySelectorAll("input")).map((i) => ({
      type: i.type, name: i.name || null, id: i.id || null,
      placeholder: i.placeholder || null, maxLength: i.maxLength,
      inputMode: i.inputMode || null, autocomplete: i.autocomplete || null,
    })),
    buttons: Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
      .map((b) => (b.textContent || b.value || b.getAttribute("aria-label") || "").trim().slice(0, 40)),
    forms: document.querySelectorAll("form").length,
  }));
  console.log(`  [auth] login form: ${form.inputs.length} input(s), ${form.buttons.length} button(s), ${form.forms} form element(s)`);
  for (const i of form.inputs) {
    console.log(`  [auth]   input type=${i.type} maxLength=${i.maxLength} inputMode=${i.inputMode || "-"} placeholder=${JSON.stringify(i.placeholder)}`);
  }
  if (form.buttons.length) console.log(`  [auth]   buttons: ${form.buttons.filter(Boolean).join(" | ")}`);
  console.log(`  [auth] DASHBOARD_PASS is ${pass ? `set (${pass.length} chars)` : "NOT SET"}`);

  // A segmented passcode — one box per digit — needs typing, not filling.
  const digitBoxes = form.inputs.filter((i) => i.maxLength === 1);
  if (digitBoxes.length > 1) {
    console.log(`  [auth] segmented passcode detected (${digitBoxes.length} boxes) — typing digit by digit`);
    const boxes = page.locator("input[maxlength='1']");
    for (let i = 0; i < Math.min(digitBoxes.length, pass.length); i++) {
      await boxes.nth(i).fill(pass[i]).catch(() => {});
    }
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1500);
    if ((await page.locator("input[maxlength='1']").count()) === 0) {
      console.log("  [auth] through the wall via the segmented field");
      await page.context().storageState({ path: STORAGE });
      return;
    }
  }

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
    const after = await page.evaluate(() => ({
      text: (document.body.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300),
      inputs: document.querySelectorAll("input").length,
      url: location.pathname,
    }));
    console.log(`  [auth] AFTER SUBMIT — url=${after.url} inputs=${after.inputs}`);
    console.log(`  [auth] page says: ${JSON.stringify(after.text)}`);
    throw new Error(
      "Still behind the wall after submitting. The structure above says which of the three " +
        "it is: a wrong secret, a submit that never fired, or a field shape this code did not " +
        "handle. The passcode itself is never printed or screenshotted."
    );
  }

  const body = (await page.textContent("body").catch(() => "")) || "";
  console.log(`  [auth] through the wall — ${body.length} chars of app rendered`);

  if (!existsSync(dirname(STORAGE))) mkdirSync(dirname(STORAGE), { recursive: true });
  await page.context().storageState({ path: STORAGE });
});
