import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { hasRecentLinkedinPost } from "../src/state.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

describe("the LinkedIn duplicate guard", () => {
  test("a post 45 minutes ago blocks another one", () => {
    // The exact gap seen on 2026-08-05 through 08-08: ~0.75h.
    const log = { posts: [{ type: "linkedin", topic: "lead_overflow", timestamp: hoursAgo(0.75) }] };
    assert.equal(hasRecentLinkedinPost(log, 20), true);
  });

  test("a post 21 hours ago does not", () => {
    const log = { posts: [{ type: "linkedin", timestamp: hoursAgo(21) }] };
    assert.equal(hasRecentLinkedinPost(log, 20), false);
  });

  test("a reel is not a LinkedIn post", () => {
    const log = { posts: [{ city: "san_antonio", timestamp: hoursAgo(1) }] };
    assert.equal(hasRecentLinkedinPost(log, 20), false);
  });

  test("a bare claim blocks exactly like a finished post", () => {
    // claim-before-post writes this shape to main BEFORE Metricool is called;
    // every reader of the log must treat it as "today is taken".
    const log = { posts: [{ type: "linkedin", status: "claimed", timestamp: hoursAgo(0.1), success: false }] };
    assert.equal(hasRecentLinkedinPost(log, 20), true);
  });

  test("a malformed entry does not crash the guard", () => {
    // posted-log is merged by an external script and can carry a null.
    const log = { posts: [null, "nonsense", 42, { type: "linkedin", timestamp: hoursAgo(1) }] };
    assert.equal(hasRecentLinkedinPost(log, 20), true);
  });

  test("an entry with an unparseable timestamp is not treated as recent", () => {
    const log = { posts: [{ type: "linkedin", timestamp: "not a date" }] };
    assert.equal(hasRecentLinkedinPost(log, 20), false);
  });

  test("a log with no posts array degrades to 'nothing posted'", () => {
    // Deliberate for the IN-MEMORY arithmetic: this function only reads. The
    // fail-closed direction lives where it matters — claimLinkedinSlot refuses
    // to post when the LIVE log cannot be read or written. Pinned so a change
    // of mind here is a choice.
    assert.equal(hasRecentLinkedinPost({}, 20), false);
    assert.equal(hasRecentLinkedinPost(null, 20), false);
  });
});

/**
 * THE INCIDENT, GENERATION TWO.
 *
 * Six duplicate posts in five days (2026-08-05, 06, 07, 08, and 08-09 — the
 * last one twelve minutes apart), same recruiting topic twice a day, on three
 * real LinkedIn accounts. Three lessons, each paid for separately:
 *
 * 1. The in-memory guard reads a checkout pinned to the SHA the run was
 *    CREATED at — a backup queued behind its primary still sees the world
 *    from before the primary pushed. The concurrency group serialized the
 *    jobs perfectly on 2026-08-09 (2-second gap) and the duplicate happened anyway.
 * 2. The live re-read (checkRemoteLinkedin) was still check-then-act: the
 *    posting run only pushed its entry at the END of the job — minutes after
 *    the post, behind a 7-minute verify sleep — and a cancellation or push
 *    failure in that window loses the evidence entirely.
 * 3. So the fix is to invert the order: CLAIM the slot on origin/main with a
 *    compare-and-swap write FIRST, post SECOND. Two racing runs cannot both
 *    win a CAS. The mechanics live in src/linkedin-claim.js and are unit-tested
 *    (including the exact both-read-clean interleaving) in linkedin-claim.test.mjs.
 *
 * These tests pin main.js's USE of that mechanism, so a refactor cannot
 * quietly reintroduce check-then-act.
 */
describe("main.js claims before it posts", () => {
  const src = readFileSync(join(ROOT, "src", "main.js"), "utf-8");

  test("the claim is awaited before the live post call", () => {
    const claimIdx = src.indexOf("await claimLinkedinSlot(");
    const liveIdx = src.indexOf("postToLinkedin({ dryRun: false })");
    assert.ok(claimIdx > 0, "main.js must claim the slot via claimLinkedinSlot");
    assert.ok(liveIdx > 0, "the live post call must exist");
    assert.ok(claimIdx < liveIdx, "the claim must come BEFORE the live post — that ordering is the entire fix");
  });

  test("the live post is gated on holding the claim", () => {
    assert.match(src, /if \(!claim\.claimed\)/, "the claim result must gate the post decision");
  });

  test("an infrastructure failure skips the post instead of risking a duplicate", () => {
    // claim.conflict distinguishes "someone already posted" (skip quietly)
    // from "GitHub is down" (skip LOUDLY). Both directions skip. Fail-closed.
    assert.match(src, /if \(claim\.conflict\)/, "conflict and failure must be told apart for alerting");
    assert.match(src, /fail-closed/i, "the fail-closed stance should be stated where the decision is made");
  });

  test("the fail-open live check is gone", () => {
    // checkRemoteLinkedin read the live log and PROCEEDED on any API error.
    // With a claim in place a second, weaker guard is not defense in depth —
    // it is an invitation to 'simplify' back to it. It must stay deleted.
    assert.ok(!src.includes("checkRemoteLinkedin"), "check-then-act must not come back alongside the claim");
  });

  test("a stale checkout still cannot see a sibling's post — which is why checking can never be enough", () => {
    const staleSnapshot = { posts: [] }; // pinned at run creation, before the sibling pushed
    assert.equal(hasRecentLinkedinPost(staleSnapshot, 20), false);
    const liveLog = { posts: [{ type: "linkedin", topic: "lead_overflow", timestamp: hoursAgo(0.75) }] };
    assert.equal(hasRecentLinkedinPost(liveLog, 20), true);
  });
});

/**
 * THE HISTORICAL RECORD, WITH AN ALARM ON IT.
 *
 * Everything before REGRESSION_CUTOFF is immutable history: the six duplicate
 * posts the claim fix was bought with. Everything at or after the cutoff runs
 * under claim-before-post — where a same-day duplicate is IMPOSSIBLE unless
 * the claim was bypassed or broke. So the assertion splits:
 *
 *   - before the cutoff: the known duplicates must still be on record
 *     (teeth against a history rewrite), pinned SAFELY because the past
 *     cannot grow — unlike the live count whose stale pin broke all CI
 *     on 2026-08-09;
 *   - at/after the cutoff: ZERO duplicates, forever. This is the regression
 *     alarm that catches duplicate number seven the day it happens, in every
 *     workstream's CI, with a message that says exactly what broke.
 */
describe("the committed log: known duplicates preserved, new ones forbidden", () => {
  // Midnight UTC after the last pre-fix run. The claim fix merged 2026-08-09;
  // the final old-code duplicate posted 2026-08-09T19:59:37Z.
  const REGRESSION_CUTOFF = Date.parse("2026-08-10T00:00:00Z");
  const KNOWN_DUPLICATE_DAYS = ["2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08", "2026-08-09"];

  const log = JSON.parse(readFileSync(join(ROOT, "posted-log.json"), "utf-8"));
  const li = log.posts
    .filter((p) => p && p.type === "linkedin" && !Number.isNaN(Date.parse(p.timestamp)))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  // Consecutive LinkedIn entries under 20h apart — the definition the runtime
  // guard enforces, applied to what actually got recorded.
  const violations = [];
  for (let i = 1; i < li.length; i++) {
    const gapH = (Date.parse(li[i].timestamp) - Date.parse(li[i - 1].timestamp)) / 3600000;
    if (gapH < 20) {
      violations.push({
        at: li[i].timestamp,
        after: li[i - 1].timestamp,
        gapH,
        text: `${li[i].timestamp} (+${gapH.toFixed(2)}h after ${li[i - 1].timestamp})`,
      });
    }
  }
  const preCutoff = violations.filter((v) => Date.parse(v.at) < REGRESSION_CUTOFF);
  const postCutoff = violations.filter((v) => Date.parse(v.at) >= REGRESSION_CUTOFF);

  test("there is a meaningful LinkedIn history to check", () => {
    assert.ok(li.length >= 20, `only ${li.length} LinkedIn entries — this test is no longer meaningful`);
  });

  test("the five known pre-fix duplicates are still on record", () => {
    const daysStillPresent = KNOWN_DUPLICATE_DAYS.filter((day) =>
      li.some((p) => p.timestamp.startsWith(day))
    );
    if (daysStillPresent.length === 0) {
      // The incident has aged past the 365-day retention window (Aug 2027).
      // Nothing left to characterize; the post-cutoff alarm below still runs.
      return;
    }
    // One violation per fully-retained known day. Safe to pin: the past can't
    // grow. (For about a day at the retention boundary in Aug 2027 a known
    // day can be half-trimmed and this can disagree by one — if that is
    // literally today, wait for the trim to finish or drop the aged day
    // from KNOWN_DUPLICATE_DAYS.)
    assert.equal(
      preCutoff.length,
      daysStillPresent.length,
      `the record of the 2026-08 incident changed: expected one duplicate on each of ` +
        `[${daysStillPresent.join(", ")}], found ${preCutoff.length}:\n` +
        preCutoff.map((v) => v.text).join("\n")
    );
  });

  test("NO new duplicate since claim-before-post shipped (2026-08-10)", () => {
    assert.equal(
      postCutoff.length,
      0,
      `THE DUPLICATE BUG IS FIRING AGAIN. ${postCutoff.length} same-day LinkedIn duplicate(s) ` +
        `appeared after the claim fix shipped:\n` +
        postCutoff.map((v) => v.text).join("\n") +
        `\nThe claim in src/linkedin-claim.js was bypassed or failed. Find the two workflow runs ` +
        `around each timestamp (gh run list --workflow=post.yml) and read their [LinkedInClaim] ` +
        `log lines. Do NOT relax this assertion — it is the alarm, not the bug.`
    );
  });
});
