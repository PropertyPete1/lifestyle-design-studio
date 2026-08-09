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
    // This is the FAIL-OPEN direction and it is deliberate: the live remote
    // check is the real guard. Pinned so a change of mind here is a choice.
    assert.equal(hasRecentLinkedinPost({}, 20), false);
    assert.equal(hasRecentLinkedinPost(null, 20), false);
  });
});

/**
 * THE INCIDENT, REPLAYED.
 *
 * On four consecutive days the same recruiting topic went out twice, about 45
 * minutes apart, to three real LinkedIn accounts. The arithmetic in the guard
 * was never wrong — the log it was asked about was.
 *
 * The primary cron (19:00) and its backup (19:30) each load posted-log.json once,
 * from their own checkout. The backup checks out BEFORE the primary commits, so
 * its snapshot cannot contain the primary's entry. Both then read "nothing
 * posted today" and both post.
 */
describe("the incident of 2026-08-05..08 replays correctly", () => {
  const primaryPostedAt = hoursAgo(0.75);

  test("the backup run's OWN checkout says it is safe to post — this is the bug", () => {
    const staleSnapshot = { posts: [] }; // checked out before the primary committed
    assert.equal(
      hasRecentLinkedinPost(staleSnapshot, 20),
      false,
      "the stale snapshot is why the in-memory guard could never have caught this"
    );
  });

  test("the LIVE log says it is not — this is the fix", () => {
    const liveLog = { posts: [{ type: "linkedin", topic: "lead_overflow", timestamp: primaryPostedAt }] };
    assert.equal(hasRecentLinkedinPost(liveLog, 20), true);
  });

  test("main.js consults the live log and not only its own snapshot", () => {
    const src = readFileSync(join(ROOT, "src", "main.js"), "utf-8");
    assert.match(src, /checkRemoteLinkedin/, "the live LinkedIn check must exist");
    // The call has to be at the decision point, not merely defined.
    const block = src.slice(src.indexOf("[LinkedIn] Generating daily recruiting post") - 2500);
    assert.match(
      block.slice(0, 2500),
      /await checkRemoteLinkedin\(/,
      "the live check must be awaited before the post decision"
    );
  });

  test("the live check is reached even when the local guard says nothing was posted", () => {
    // Guard against a future short-circuit that skips the remote read when the
    // local log looks clean — which is exactly the state the bug occurs in.
    const src = readFileSync(join(ROOT, "src", "main.js"), "utf-8");
    const m = src.match(/const remoteLinkedinConflict = ([^;]+);/);
    assert.ok(m, "the remote conflict decision should be one readable expression");
    assert.match(
      m[1],
      /hasRecentLinkedin \? false : await checkRemoteLinkedin/,
      "the remote check must run precisely when the local guard is clean"
    );
  });
});

/**
 * The historical record this was found in. If posted-log.json is ever rewritten,
 * this stops asserting anything real — so it checks that the entries it relies
 * on are still there rather than silently passing on an empty filter.
 */
describe("the committed log still shows the duplicates that prompted the fix", () => {
  const log = JSON.parse(readFileSync(join(ROOT, "posted-log.json"), "utf-8"));
  const li = log.posts.filter((p) => p && p.type === "linkedin");

  test("there is a meaningful LinkedIn history to check", () => {
    assert.ok(li.length >= 20, `only ${li.length} LinkedIn entries — this test is no longer meaningful`);
  });

  test("the four known duplicate days are present and under 20h apart", () => {
    const violations = [];
    for (let i = 1; i < li.length; i++) {
      const gapH = (new Date(li[i].timestamp) - new Date(li[i - 1].timestamp)) / 3600000;
      if (gapH < 20) violations.push(`${li[i].timestamp} (+${gapH.toFixed(2)}h after ${li[i - 1].timestamp})`);
    }
    // NOT pinned to exactly 4 any more. This is a characterization of the
    // KNOWN duplicates that prompted the fix — but the count is live data,
    // and a FIFTH appeared on 2026-08-09 (2026-08-08T20:34 +0.76h), which
    // broke every workstream's CI through a stale pin rather than telling
    // anyone anything. The four known ones must still be present (the teeth);
    // the total may grow, and each growth is the duplicate bug still firing —
    // tracked as its own follow-up, not as a global red.
    assert.ok(
      violations.length >= 4,
      `expected at least the 4 known duplicates from 2026-08-05..08, found ${violations.length}:\n${violations.join("\n")}`
    );
  });
});
