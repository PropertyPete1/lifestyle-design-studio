#!/usr/bin/env node
/**
 * reconcile.mjs — is every card the pipeline is waiting on actually visible?
 *
 * THE GAP THIS CLOSES. The pipeline's whole model of Peter's answers is what
 * the dashboard commits back into yt-approvals.json — there is no read API on
 * the dashboard, no decisions endpoint, nothing to poll (the cleanup helper in
 * webhook.mjs documents the same absence for deletes). So when the dashboard
 * dropped a decision commit on 2026-08-19, NOTHING on either side could
 * notice: the dashboard believed it had answered, the pipeline believed it was
 * waiting, and both were internally consistent for a week.
 *
 * What CAN be checked from outside is one invariant with no ambiguity in it:
 *
 *   a card the pipeline believes is WAITING must be VISIBLE on the dashboard.
 *
 * If it is not, one of exactly two things is true — Peter answered it and the
 * card left the pending view but the decision never reached the repo (the
 * dropped write), or the card was never rendered for him at all (the
 * routes-on-kind failure class, already seen once). BOTH are alarms. Neither
 * has a false-positive interpretation, which is what makes this checkable
 * against a UI this repo does not control and has never seen the internals of.
 *
 * The check deliberately does NOT try the inverse ("the card is gone, so fold
 * the decision in") — the decision's content (approve? which option?) is not
 * recoverable from a card that is no longer shown. Recovery is Peter's one
 * minute with the record-decision job; this job's whole output is making sure
 * he is asked the same day instead of whenever someone wonders where video N
 * went. The 72-hour stall nudge in the pipeline is the belt to this suspender:
 * it fires on ANY stall, including the ones this check cannot see.
 *
 * Lives in dashboard-smoke because that is where Playwright is allowed to be a
 * dependency ("separate from auto-poster so Playwright is never a dependency
 * of the posting path" — package.json). The approvals-reading half lives in
 * auto-poster (waitingRecords in yt-stall-nudge.js) so `npm test` covers it
 * without a browser. Read-only against the dashboard: this script clicks
 * nothing, posts nothing, and commits nothing.
 *
 * Env: DASHBOARD_URL, DASHBOARD_PASS (the passcode wall), and the GOOGLE_*
 * trio for the alert mail. The passcode is typed, never printed, never
 * screenshotted — same rules as auth.setup.mjs, minus the artifacts entirely.
 */

import { chromium } from "@playwright/test";
import { loadApprovals } from "../auto-poster/src/yt-approvals.js";
import { waitingRecords } from "../auto-poster/src/yt-stall-nudge.js";
import { getAccessToken } from "../auto-poster/src/drive.js";
import { sendOwnerEmail, MAIL_PREFIX } from "../auto-poster/src/delivery.js";

const DASHBOARD_URL = (process.env.DASHBOARD_URL || "").replace(/\/$/, "");
const PASS = process.env.DASHBOARD_PASS || "";

/** How many internal pages to walk looking for the card. The smoke suite's
 * whole tab walk is under ten; twelve leaves room without letting a pathological
 * nav turn the job into a crawl. */
const MAX_PAGES = 12;

function fail(msg) {
  console.log(`::error::${msg}`);
  process.exitCode = 1;
}

/**
 * Get past the passcode wall. A condensed auth.setup.mjs: segmented boxes get
 * typed digit by digit, a password/text field gets filled and submitted. No
 * screenshots, no traces, and the field is cleared before any throw.
 */
async function login(page) {
  await page.goto(DASHBOARD_URL + "/", { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(1500);

  const boxes = page.locator("input[maxlength='1']");
  if ((await boxes.count()) > 1) {
    for (let i = 0; i < Math.min(await boxes.count(), PASS.length); i++) {
      await boxes.nth(i).fill(PASS[i]).catch(() => {});
    }
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1500);
    return (await page.locator("input[maxlength='1']").count()) === 0;
  }

  let field = page.locator('input[type="password"]').first();
  if ((await field.count()) === 0) field = page.locator('input[type="text"], input:not([type])').first();
  if ((await field.count()) === 0) return true; // no wall — already through

  await field.fill(PASS);
  const submit = page.getByRole("button", { name: /enter|submit|sign in|log ?in|continue|unlock|go/i }).first();
  if ((await submit.count()) > 0) await submit.click().catch(() => {});
  else await field.press("Enter");
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1500);
  await field.fill("").catch(() => {});

  // innerText, NOT textContent — textContent matches inside the app bundle
  // (the smoke suite failed a successful login exactly that way once).
  const visible = (await page.locator("body").innerText().catch(() => "")) || "";
  const gated = (await page.locator('input[type="password"]').count()) > 0 ||
    /incorrect passcode|invalid passcode|wrong passcode|try again/i.test(visible);
  return !gated;
}

/** The same-origin links on the current page, hrefs only. */
async function internalLinks(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("a[href]"))
      .map((a) => a.getAttribute("href"))
      .filter((h) => h && h.startsWith("/") && !h.startsWith("//") && !/^\/(api|_)/.test(h))
  ).catch(() => []);
}

/**
 * Walk the dashboard and return the rendered text of every page seen. The
 * card could live on any tab, so this mirrors the smoke suite's approach:
 * home first, then each internal link once.
 */
async function collectPageTexts(page) {
  const texts = [];
  const seen = new Set(["/"]);
  texts.push((await page.locator("body").innerText().catch(() => "")) || "");
  const queue = (await internalLinks(page)).filter((h) => !seen.has(h));
  for (const href of queue.slice(0, MAX_PAGES)) {
    if (seen.has(href)) continue;
    seen.add(href);
    await page.goto(DASHBOARD_URL + href, { waitUntil: "networkidle" }).catch(() => {});
    await page.waitForTimeout(500);
    texts.push((await page.locator("body").innerText().catch(() => "")) || "");
  }
  return texts;
}

async function alert(missing) {
  const workflow = `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${process.env.GITHUB_REPOSITORY || "PropertyPete1/lifestyle-design-studio"}/actions/workflows/youtube-longform.yml`;
  const lines = missing.map((r) => `  - ${r.requestId} (${r.kind}, sent ${r.requestedAt})`);
  const subject = `the dashboard is not showing ${missing.length === 1 ? "a card" : `${missing.length} cards`} the pipeline is waiting on`;
  const body = [
    `The pipeline is waiting on ${missing.length === 1 ? "this card" : "these cards"}, and a sweep of the dashboard could not find ${missing.length === 1 ? "it" : "them"} anywhere:`,
    ``,
    ...lines,
    ``,
    `A waiting card that is not visible means one of two things, and both need you:`,
    ``,
    `  - you answered it and the dashboard LOST THE WRITE-BACK (it did this on 2026-08-19 and video 2 stalled a week), or`,
    `  - the card was never rendered for you at all.`,
    ``,
    `If you answered it, record the decision directly — one minute:`,
    ``,
    `  1. Open ${workflow}`,
    `  2. "Run workflow" with job: record-decision`,
    `  3. request_id, decision (approve/reject), and for a topic card the option number you picked`,
    ``,
    `If you never saw it, dispatch the resend path for that card kind, or say so and it gets re-sent.`,
    ``,
    `— Decision Reconcile (read-only dashboard sweep)`,
  ].join("\n");

  const accessToken = await getAccessToken();
  await sendOwnerEmail(accessToken, { subject, body, prefix: MAIL_PREFIX.YT });
  console.log(`[Reconcile] alert mailed for: ${missing.map((r) => r.requestId).join(", ")}`);
}

async function main() {
  const waiting = waitingRecords(loadApprovals());
  if (waiting.length === 0) {
    console.log("[Reconcile] nothing is waiting on Peter — nothing to check");
    return;
  }
  console.log(`[Reconcile] waiting: ${waiting.map((r) => r.requestId).join(", ")}`);

  if (!DASHBOARD_URL || !PASS) {
    // Mirrors notify-run-failure's stance: a missing secret is a setup problem
    // for a human with repo access, not a daily alarm in Peter's inbox.
    console.log("::warning::DASHBOARD_URL / DASHBOARD_PASS not set — the reconcile check cannot run");
    return;
  }

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    if (!(await login(page))) {
      // Not an "answer lost" alarm — the check itself is broken, which the red
      // run reports. The 72h nudge still covers Peter regardless.
      fail("could not get past the dashboard passcode wall — the reconcile check ran blind. See auth.setup.mjs for the triage steps.");
      return;
    }

    const texts = await collectPageTexts(page);
    const corpus = texts.join("\n");
    const missing = waiting.filter((r) => !corpus.includes(r.requestId));

    for (const r of waiting) {
      const found = !missing.includes(r);
      console.log(`[Reconcile] ${r.requestId}: ${found ? "visible — genuinely waiting on Peter" : "NOT FOUND on any page"}`);
    }

    if (missing.length > 0) {
      await alert(missing);
      fail(`${missing.length} waiting card(s) not visible on the dashboard — Peter has been mailed the recovery steps`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  fail(`reconcile sweep failed: ${err?.stack || err}`);
});
