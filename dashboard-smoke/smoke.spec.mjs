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
import { readFileSync } from "node:fs";
import {
  postApproval, cleanup, testRequestId,
  topicPickPayload, recordingKitPayload, videoReviewPayload, heldBelowBarPayload,
} from "./webhook.mjs";

/** Controls that can end a decision, spend money, or reach a live account. */
const DESTRUCTIVE = /approve|reject|publish|delete|remove|send|upload|post now|confirm|skip|retry|regenerate|discard|archive/i;

/** Console noise that is not a defect. Third-party embeds, favicons, cookie frames. */
const IGNORABLE_CONSOLE = /favicon|third-party cookie|Download the React DevTools|\[vite\]|sourcemap/i;


/**
 * The app's routes, discovered rather than assumed.
 *
 * The first authenticated run found seven: Deliveries, Trial, Approvals,
 * LinkedIn, Performance, Rotation, Video. Hardcoding those would break the
 * moment a tab is renamed, which is exactly the coupling a black-box suite is
 * supposed to avoid.
 */
async function routes(page) {
  const found = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href^="/"], [role="tab"], nav a'))
      .map((a) => ({ href: a.getAttribute("href"), label: (a.textContent || "").trim().slice(0, 40) }))
      .filter((x) => x.href && !x.href.startsWith("//") && !/^\/(api|_)/.test(x.href))
  );
  return [...new Map(found.map((h) => [h.href, h])).values()];
}

/** Go to the tab whose label matches, and wait for it to actually paint. */
async function gotoTab(page, pattern) {
  const all = await routes(page);
  const hit = all.find((r) => pattern.test(r.label) || pattern.test(r.href));
  if (!hit) return null;
  await page.goto(hit.href, { waitUntil: "networkidle" });
  await page
    .waitForFunction(() => (document.body.innerText || "").trim().length > 100, null, { timeout: 10_000 })
    .catch(() => {});
  return hit;
}

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
  // innerText, not textContent — textContent includes <script> bodies, and
  // matching login words inside a JS bundle is how the setup project failed a
  // login that had already succeeded.
  const visible = (await page.locator("body").innerText().catch(() => "")) || "";
  return /enter studio passcode|sign in|log ?in/i.test(visible) && visible.length < 2000;
}

/**
 * NOT SERIAL — and that is the point.
 *
 * This file used to declare `mode: "serial"`, whose one real effect here was to
 * SKIP EVERY REMAINING TEST after the first failure. On 2026-08-09 the
 * approval-card check failed and the run reported "3 did not run": Deliveries,
 * Copy Caption, and the camera screens. A long-form rendering bug made the
 * entire daily half of the dashboard unreportable, while the summary still read
 * like a complete result — an accurate red signal answering a different
 * question than the one being asked.
 *
 * Serial mode was buying nothing else. `workers: 1` and `fullyParallel: false`
 * in playwright.config.mjs already guarantee these run one at a time, in order,
 * in a single worker, so the TEST- fixtures still cannot interleave and
 * afterAll still cleans them up exactly once.
 *
 * If a future check genuinely depends on a previous one, wrap that pair in its
 * own `test.describe.serial` — do not restore it file-wide and take the whole
 * suite's reporting down with it.
 */

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
  const unique = (await routes(page)).slice(0, 15);

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

  // Give the dashboard a moment to persist before looking.
  await page.goto("/", { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);

  // SEARCH EVERY TAB, AND SAY WHICH ONE IT WAS ON.
  //
  // The previous run asserted against the root view alone and reported four
  // failures, which proved only that cards do not live on the root — the
  // Approvals tab is a separate route. A card on the wrong tab is a different
  // problem from a card that does not exist, and reporting them the same way
  // would have sent a false alarm to Manus.
  const all = await routes(page);
  const searchOrder = [
    ...all.filter((r) => /approval/i.test(r.label)),
    ...all.filter((r) => !/approval/i.test(r.label)),
    { href: "/", label: "root" },
  ];

  const pageText = new Map();
  for (const r of searchOrder) {
    await page.goto(r.href, { waitUntil: "networkidle" }).catch(() => {});
    await page
      .waitForFunction(() => (document.body.innerText || "").trim().length > 100, null, { timeout: 8000 })
      .catch(() => {});
    pageText.set(r.label || r.href, (await page.locator("body").innerText().catch(() => "")) || "");
  }
  note("tabs searched", "INFO", [...pageText.keys()].join(", "));

  const missing = [];
  for (const c of posted) {
    if (!c.res.ok) continue;
    let where = null;
    for (const [label, text] of pageText) {
      if (c.expect.test(text) || text.includes(c.requestId)) {
        where = label;
        break;
      }
    }
    note(`render ${c.label}`, where ? "PASS" : "FAIL", where ? `visible on "${where}"` : `not on ANY tab (${c.requestId})`);
    if (!where) missing.push(c.label);
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
  const tab = await gotoTab(page, /deliver/i);
  note("deliveries tab", tab ? "PASS" : "INFO", tab ? `on "${tab.label}"` : "no Deliveries tab found — checking root");

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

/**
 * DATA PARITY — which kind of empty is this?
 *
 * "An empty tab over dead data and an empty tab over a rendering bug look
 * identical to Peter, and I want to know which each one is."
 *
 * Every other check here is black-box on purpose. These two are not: they read
 * the committed logs the pipelines write and ask whether the deployed dashboard
 * is showing them. That is the only way to tell the two failures apart, and
 * both happen here — the Trial pipeline produced nothing between 2026-07-26 and
 * 2026-08-09, so an empty Trial tab was CORRECT for a fortnight while a
 * rendering bug would have looked exactly the same.
 *
 * A tab is only failed when the log has records and the tab demonstrably shows
 * none of them. No records means an empty tab is the right answer, and the
 * check says so rather than passing silently.
 */
const REPO_LOGS = new URL("../auto-poster/", import.meta.url);

function readLog(name) {
  try {
    return JSON.parse(readFileSync(new URL(name, REPO_LOGS), "utf-8"));
  } catch (err) {
    return { __unreadable: err.message };
  }
}

/** Visible text of a tab, plus whether it is showing an explicit empty state. */
async function tabText(page, pattern) {
  const tab = await gotoTab(page, pattern);
  const text = (await page.locator("body").innerText().catch(() => "")) || "";
  return { tab, text };
}

test("the Trial tab shows what trial-variants.json actually contains", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  const log = readLog("trial-variants.json");
  if (log.__unreadable) {
    note("trial parity", "INFO", `could not read trial-variants.json: ${log.__unreadable}`);
    return;
  }
  const variants = log.variants || [];
  const { tab, text } = await tabText(page, /trial/i);
  note("trial tab", tab ? "PASS" : "INFO", tab ? `on "${tab.label}"` : "no Trial tab found");

  if (variants.length === 0) {
    note("trial parity", "INFO", "trial-variants.json is empty — an empty tab is CORRECT, not a bug");
    return;
  }

  // Look for any stable marker of the newest variant. Dates get reformatted and
  // captions get truncated, so several markers are tried and any one counts.
  const newest = variants[variants.length - 1];
  const markers = [newest.sourceFileName, newest.hookAngle, newest.city, newest.date].filter(Boolean);
  const seen = markers.filter((m) => text.includes(m));

  note(
    "trial parity",
    seen.length ? "PASS" : "FAIL",
    seen.length
      ? `${variants.length} record(s) in the log; the newest is rendered (matched: ${seen.join(", ")})`
      : `${variants.length} record(s) in the log (newest ${newest.date} ${newest.hookAngle}) and NONE are on the tab — ` +
        `this is a RENDERING problem, not dead data`
  );

  expect(
    seen.length,
    `trial-variants.json holds ${variants.length} record(s) but the Trial tab shows none of ` +
      `[${markers.join(", ")}]. Dead data and a broken tab look the same to a human; this says it is the tab.`
  ).toBeGreaterThan(0);
});

test("the Deliveries tab shows what posted-log.json actually contains", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  const log = readLog("posted-log.json");
  if (log.__unreadable) {
    note("deliveries parity", "INFO", `could not read posted-log.json: ${log.__unreadable}`);
    return;
  }
  const delivered = (log.posts || []).filter((p) => p && p.deliveryDriveLink);
  const { tab, text } = await tabText(page, /deliver/i);

  if (delivered.length === 0) {
    note("deliveries parity", "INFO", "no delivered entries in posted-log — an empty tab is CORRECT");
    return;
  }

  const newest = delivered[delivered.length - 1];
  const markers = [newest.fileName, newest.city, (newest.timestamp || "").slice(0, 10)].filter(Boolean);
  const seen = markers.filter((m) => text.includes(m));

  note(
    "deliveries parity",
    seen.length ? "PASS" : "FAIL",
    seen.length
      ? `${delivered.length} delivered in the log; the newest is rendered (matched: ${seen.join(", ")})`
      : `${delivered.length} delivered in the log (newest ${newest.city} ${(newest.timestamp || "").slice(0, 10)}) ` +
        `and none are on the tab — RENDERING problem, not dead data`
  );

  expect(
    seen.length,
    `posted-log.json holds ${delivered.length} delivered item(s) but the Deliveries tab shows none of ` +
      `[${markers.join(", ")}].`
  ).toBeGreaterThan(0);
});

test("Copy Caption copies the caption, not the internal notes", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
  await page.goto("/", { waitUntil: "networkidle" });

  // Copy Caption belongs to a delivery card, so look on the Deliveries tab
  // before concluding it is absent.
  let button = page.getByRole("button", { name: /copy caption/i }).first();
  if ((await button.count()) === 0) {
    await gotoTab(page, /deliver/i);
    button = page.getByRole("button", { name: /copy caption/i }).first();
  }
  if ((await button.count()) === 0) {
    note("Copy Caption", "INFO", "no 'Copy Caption' control on root or Deliveries");
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
  // The recorder is likelier to hang off Video or Approvals than the root.
  const entry = /record|camera|teleprompter|upload clips/i;
  if ((await page.getByRole("link", { name: entry }).count()) === 0) {
    await gotoTab(page, /video|approval/i);
  }
  const link = page.getByRole("link", { name: entry }).first();
  const button = page.getByRole("button", { name: entry }).first();
  const target = (await link.count()) > 0 ? link : (await button.count()) > 0 ? button : null;

  if (!target) {
    note("camera/recorder screen", "INFO", "no recorder entry point on the root view");
    return;
  }
  const errors = watchConsole(page);
  await target.click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const rendered = ((await page.locator("body").innerText().catch(() => "")) || "").length > 200;

  note("camera/recorder screen", rendered && !errors.length ? "PASS" : "FAIL",
    rendered ? (errors.length ? errors.slice(0, 2).join(" | ") : "opens and renders") : "opened but rendered nothing");
  note(
    "camera BEHAVIOUR", "MANUAL",
    "getUserMedia cannot be exercised headless — actual capture stays a manual check on iPhone"
  );
  expect(errors, `console errors on the recorder screen: ${errors.join(" | ")}`).toEqual([]);
});
