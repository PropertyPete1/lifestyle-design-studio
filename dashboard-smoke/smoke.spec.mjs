/**
 * Black-box smoke checks against the DEPLOYED dashboard.
 *
 * WRITTEN WITHOUT HAVING SEEN IT. DASHBOARD_URL is a repo secret, so these
 * selectors are role- and text-based rather than structural: getByRole("button"),
 * accessible names, visible text. That is the right way to write a black-box
 * smoke suite anyway — a test coupled to class names re-breaks on every restyle
 * — but it does mean the first run is partly a survey. Where a check cannot find
 * what it expected it SAYS SO and names what it did find, instead of failing
 * with a selector error that reads like a broken dashboard.
 *
 * THE BUTTON CRAWL IS DELIBERATELY NOT EXHAUSTIVE.
 *
 * "Every visible button is clickable and does something" is the right goal and
 * the wrong implementation on a production dashboard that can publish to social
 * accounts and approve videos. A blind crawler cannot know which control ends a
 * decision. So controls are split: navigation and clearly inert controls are
 * clicked; anything matching a destructive pattern is recorded as PRESENT BUT
 * NOT CLICKED, on real data. On TEST- cards the same buttons are fair game,
 * because that is the entire reason those cards exist.
 */

import { test, expect } from "@playwright/test";
import {
  postApproval, cleanup, testRequestId,
  topicPickPayload, recordingKitPayload, videoReviewPayload, heldBelowBarPayload,
} from "./webhook.mjs";

/** Controls that can end a decision, spend money, or reach a live account. */
const DESTRUCTIVE = /approve|reject|publish|delete|remove|send|upload|post now|confirm|skip|retry|regenerate|discard|archive/i;

/** Console noise that is not a defect. Third-party embeds, favicons, cookie frames. */
const IGNORABLE_CONSOLE = /favicon|third-party cookie|Download the React DevTools|\[vite\]|sourcemap/i;

const findings = [];
const note = (check, status, detail) => {
  findings.push({ check, status, detail });
  console.log(`  [${status}] ${check}${detail ? ` — ${detail}` : ""}`);
};

function watchConsole(page) {
  const errors = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (IGNORABLE_CONSOLE.test(text)) return;
    errors.push(text.slice(0, 300));
  });
  page.on("pageerror", (err) => errors.push(`UNCAUGHT: ${String(err.message).slice(0, 300)}`));
  return errors;
}

/** Does this look like a login wall rather than the app? */
async function looksLikeAuthGate(page) {
  const pw = await page.locator('input[type="password"]').count();
  if (pw > 0) return true;
  const body = (await page.textContent("body").catch(() => "")) || "";
  return /sign in|log in|login|unauthori[sz]ed|access denied/i.test(body) && body.length < 2000;
}

test.describe.configure({ mode: "serial" });

test.afterAll(async () => {
  const removed = await cleanup().catch((e) => [{ error: e.message }]);
  const stuck = removed.filter((r) => r && r.removed === false);
  if (stuck.length) {
    console.log(
      `\n  CLEANUP: ${stuck.length} TEST- card(s) could not be deleted ` +
        `(no delete endpoint responded). They are inert — the TEST- prefix keeps them ` +
        `out of every scheduled job — but they will be visible on the dashboard:`
    );
    for (const s of stuck) console.log(`    ${s.requestId}  last status ${s.lastStatus}`);
  } else if (removed.length) {
    console.log(`\n  CLEANUP: removed ${removed.length} TEST- card(s).`);
  }

  console.log(`\n  ${"═".repeat(60)}\n  SMOKE SUMMARY\n  ${"═".repeat(60)}`);
  for (const f of findings) console.log(`  ${f.status.padEnd(6)} ${f.check}${f.detail ? ` — ${f.detail}` : ""}`);
});

test("the dashboard loads at all, and says whether it wants a login", async ({ page }) => {
  const errors = watchConsole(page);
  const res = await page.goto("/", { waitUntil: "domcontentloaded" });
  expect(res, "no response from DASHBOARD_URL").toBeTruthy();
  note("root responds", res.ok() ? "PASS" : "FAIL", `HTTP ${res.status()}`);
  expect(res.status(), `root returned ${res.status()}`).toBeLessThan(400);

  await page.waitForLoadState("networkidle").catch(() => {});
  const gated = await looksLikeAuthGate(page);
  note(
    "past the passcode wall", gated ? "FAIL" : "PASS",
    gated ? "still looking at a login screen — the saved session did not stick" : "the app itself is rendering"
  );
  expect(gated, "the suite is still outside the passcode wall; everything below would test the login screen").toBe(false);
  note("root console errors", errors.length ? "FAIL" : "PASS", errors.slice(0, 3).join(" | ") || "none");
  expect(errors, `console errors on /: ${errors.join(" | ")}`).toEqual([]);
});

test("every tab loads without console errors", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });

  // Discover navigation rather than assuming it. Internal links and anything
  // with a tab role, de-duplicated by destination.
  const hrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href^="/"], [role="tab"], nav a'))
      .map((a) => ({ href: a.getAttribute("href"), label: (a.textContent || "").trim().slice(0, 40) }))
      .filter((x) => x.href && !x.href.startsWith("//") && !/^\/(api|_)/.test(x.href))
  );
  const unique = [...new Map(hrefs.map((h) => [h.href, h])).values()].slice(0, 15);

  if (unique.length === 0) {
    note("tab discovery", "INFO", "no internal nav links found — the app may be a single view or behind auth");
    return;
  }
  note("tab discovery", "PASS", `${unique.length} route(s): ${unique.map((u) => u.label || u.href).join(", ")}`);

  const broken = [];
  for (const link of unique) {
    const errors = watchConsole(page);
    const res = await page.goto(link.href, { waitUntil: "networkidle" }).catch((e) => ({ status: () => 0, err: e.message }));
    const status = typeof res?.status === "function" ? res.status() : 0;
    if (status >= 400 || status === 0) broken.push(`${link.href} -> HTTP ${status}`);
    if (errors.length) broken.push(`${link.href} -> ${errors.slice(0, 2).join(" | ")}`);
    page.removeAllListeners("console");
    page.removeAllListeners("pageerror");
  }
  note("tabs load clean", broken.length ? "FAIL" : "PASS", broken.slice(0, 5).join("  ///  ") || `${unique.length} routes clean`);
  expect(broken, `routes with errors:\n${broken.join("\n")}`).toEqual([]);
});

test("no dead controls — safe buttons respond, destructive ones are only inventoried", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });

  const buttons = page.getByRole("button");
  const count = await buttons.count();
  if (count === 0) {
    note("button inventory", "INFO", "no buttons found on the root view");
    return;
  }

  const safe = [];
  const guarded = [];
  for (let i = 0; i < Math.min(count, 40); i++) {
    const b = buttons.nth(i);
    if (!(await b.isVisible().catch(() => false))) continue;
    const name = ((await b.textContent().catch(() => "")) || (await b.getAttribute("aria-label").catch(() => "")) || "").trim();
    (DESTRUCTIVE.test(name) ? guarded : safe).push({ name: name || "(unlabelled)", index: i });
  }

  note("button inventory", "PASS", `${safe.length} safe, ${guarded.length} destructive-looking`);
  if (guarded.length) {
    note(
      "destructive controls", "INFO",
      `PRESENT BUT NOT CLICKED on real data: ${guarded.map((g) => g.name).join(", ")}`
    );
  }

  // A dead control is one that is enabled, visible, and changes nothing at all.
  const dead = [];
  for (const { name, index } of safe.slice(0, 20)) {
    const b = buttons.nth(index);
    if (!(await b.isEnabled().catch(() => false))) continue;
    // innerHTML, not textContent. "Show passcode" flips an input's type
    // attribute and changes no visible text at all, so a text-length signature
    // reported a working control as dead on the first run.
    const sig = async () =>
      `${page.url()}::${((await page.innerHTML("body").catch(() => "")) || "").length}`;
    const before = await sig();
    await b.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
    const after = await sig();
    if (before === after) dead.push(name);
    if (page.url() !== "/" && !page.url().endsWith("/")) {
      await page.goto("/", { waitUntil: "networkidle" }).catch(() => {});
    }
  }
  note(
    "dead controls", dead.length ? "FAIL" : "PASS",
    dead.length ? `no visible effect: ${dead.join(", ")}` : "every safe control changed something"
  );
  expect(dead, `controls that did nothing: ${dead.join(", ")}`).toEqual([]);
});

test("each approval card type renders from a TEST- payload", async ({ page }) => {
  const cards = [
    { label: "topic_pick (candidates)", kind: "topic_pick", make: topicPickPayload, expect: /SMOKE TEST 1/i },
    { label: "recording_kit (takes)", kind: "topic_pick", make: recordingKitPayload, expect: /smoke test take one/i },
    { label: "video_review (buttons)", kind: "video_review", make: videoReviewPayload, expect: /SMOKE TEST\] Video review/i },
    { label: "held_below_bar (strip)", kind: "topic_pick", make: heldBelowBarPayload, expect: /Held below bar|held/i },
  ];

  const posted = [];
  for (const c of cards) {
    const requestId = testRequestId(c.kind);
    const res = await postApproval({ requestId, kind: c.kind, payload: c.make(requestId) });
    posted.push({ ...c, requestId, res });
    note(`POST ${c.label}`, res.ok ? "PASS" : "FAIL", `HTTP ${res.status}${res.ok ? "" : ` — ${res.body}`}`);
  }

  // Give the dashboard a moment to persist, then look for each one.
  await page.goto("/", { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);
  await page.reload({ waitUntil: "networkidle" });

  const missing = [];
  for (const c of posted) {
    if (!c.res.ok) continue;
    const body = (await page.textContent("body").catch(() => "")) || "";
    const found = c.expect.test(body) || body.includes(c.requestId);
    note(`render ${c.label}`, found ? "PASS" : "FAIL", found ? "visible" : `not found on the root view (${c.requestId})`);
    if (!found) missing.push(c.label);
  }

  expect(
    missing,
    `card types accepted by the webhook but not rendered anywhere: ${missing.join(", ")}.\n` +
      `If these are the stage-carrying types, the dashboard is routing on 'kind' alone — ` +
      `every one of them is kind:"topic_pick" and only the flat 'stage' field tells them apart.`
  ).toEqual([]);
});

test("deliveries render, and their thumbnails are not broken images", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });

  const images = await page.evaluate(() =>
    Array.from(document.images).map((img) => ({
      src: img.currentSrc || img.src,
      broken: img.complete && img.naturalWidth === 0,
      alt: img.alt || "",
    }))
  );
  if (images.length === 0) {
    note("delivery thumbnails", "INFO", "no images on the root view — deliveries may live on another tab");
    return;
  }
  const broken = images.filter((i) => i.broken);
  note(
    "delivery thumbnails", broken.length ? "FAIL" : "PASS",
    broken.length ? `${broken.length}/${images.length} broken: ${broken.slice(0, 3).map((b) => b.src).join(", ")}` : `${images.length} loaded`
  );
  expect(broken.map((b) => b.src), `broken images: ${broken.map((b) => b.src).join(", ")}`).toEqual([]);
});

test("Copy Caption copies the caption, not the internal notes", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
  await page.goto("/", { waitUntil: "networkidle" });

  const button = page.getByRole("button", { name: /copy caption/i }).first();
  if ((await button.count()) === 0) {
    note("Copy Caption", "INFO", "no 'Copy Caption' control on the root view — likely on a delivery card elsewhere");
    return;
  }

  await button.click();
  await page.waitForTimeout(500);
  const copied = await page.evaluate(() => navigator.clipboard.readText().catch(() => "")).catch(() => "");

  if (!copied) {
    note("Copy Caption", "INFO", "clipboard unreadable in this context — needs a manual check");
    return;
  }
  // The failure this guards: internal fields leaking into what Peter pastes
  // into Instagram.
  const leaked = /worst_problem|criticUnavailable|requestId|actedAt|belowBar|stage"|driveFileId/i.exec(copied);
  note("Copy Caption", leaked ? "FAIL" : "PASS", leaked ? `internal field in clipboard: ${leaked[0]}` : `${copied.length} chars, no internal fields`);
  expect(leaked, `Copy Caption put an internal field on the clipboard: ${leaked?.[0]}`).toBeNull();
});

test("camera and recorder screens open and render", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  const link = page.getByRole("link", { name: /record|camera|teleprompter|upload clips/i }).first();
  const button = page.getByRole("button", { name: /record|camera|teleprompter|upload clips/i }).first();
  const target = (await link.count()) > 0 ? link : (await button.count()) > 0 ? button : null;

  if (!target) {
    note("camera/recorder screen", "INFO", "no recorder entry point on the root view");
    return;
  }
  const errors = watchConsole(page);
  await target.click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const rendered = ((await page.textContent("body").catch(() => "")) || "").length > 200;

  note("camera/recorder screen", rendered && !errors.length ? "PASS" : "FAIL",
    rendered ? (errors.length ? errors.slice(0, 2).join(" | ") : "opens and renders") : "opened but rendered nothing");
  note(
    "camera BEHAVIOUR", "MANUAL",
    "getUserMedia cannot be exercised headless — actual capture stays a manual check on iPhone"
  );
  expect(errors, `console errors on the recorder screen: ${errors.join(" | ")}`).toEqual([]);
});
