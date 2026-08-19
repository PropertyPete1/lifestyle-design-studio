/**
 * The publish flow.
 *
 * Almost every test here defends one sentence: NOTHING can make a video public.
 * Not on approval, not on retry, not by passing an argument, not by a future
 * edit to the body builder. The spec says publishing stays manual — this is the
 * suite that stops "manual" quietly becoming "mostly manual".
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildPostBody,
  assertPrivate,
  reviewChecklist,
  renderReviewText,
  UPLOAD_PRIVACY,
  CATEGORY,
} from "../src/yt-publish.js";
import {
  loadLog,
  recordRender,
  recordUpload,
  recordReview,
  recordShorts,
  videoIdFor,
  findVideo,
  findByRequest,
  isUploaded,
  isApproved,
  recentBrollHashes,
  pastTitles,
  PRIVACY,
} from "../src/yt-log.js";
import { mergeYouTubeLog } from "../merge-strategies.mjs";

const quiet = () => {};

const PACKAGING = {
  title: "Moving to San Antonio: what $300k actually gets you",
  description: "the description\n\n0:00 Intro\n2:00 Taxes\n5:00 Close",
  tags: ["moving to san antonio", "san antonio texas"],
  chapters: [{ seconds: 0, timestamp: "0:00", title: "Intro" }],
  pinnedComment: "Comment MATH and I'll send the breakdown.",
  missingCta: [],
};

// ─── the invariant ──────────────────────────────────────────────────────────

describe("nothing can make a video public", () => {
  test("the built body is always private", () => {
    const body = buildPostBody({ mediaUrl: "https://x/y.mp4", packaging: PACKAGING, publishAt: "2026-08-20T10:00:00" });
    assert.equal(body.youtubeData.privacy, "private");
  });

  test("passing privacy:'public' THROWS rather than being honoured", () => {
    assert.throws(
      () => buildPostBody({ mediaUrl: "https://x/y.mp4", packaging: PACKAGING, publishAt: "2026-08-20T10:00:00", privacy: "public" }),
      /only uploads private/
    );
  });

  test("passing 'unlisted' throws too — one value, no negotiation", () => {
    assert.throws(
      () => buildPostBody({ mediaUrl: "u", packaging: PACKAGING, publishAt: "p", privacy: "unlisted" }),
      /only uploads private/
    );
  });

  test("the privacy constant is frozen", () => {
    assert.throws(() => { "use strict"; UPLOAD_PRIVACY.value = "public"; });
    assert.equal(UPLOAD_PRIVACY.value, "private");
  });

  test("assertPrivate catches a body that drifted public", () => {
    const body = buildPostBody({ mediaUrl: "u", packaging: PACKAGING, publishAt: "p" });
    assert.equal(assertPrivate(body), true);
    body.youtubeData.privacy = "public";
    assert.throws(() => assertPrivate(body), /BLOCKED/);
  });

  test("assertPrivate also catches a long-form video reframed as a Short", () => {
    const body = buildPostBody({ mediaUrl: "u", packaging: PACKAGING, publishAt: "p" });
    body.youtubeData.type = "short";
    assert.throws(() => assertPrivate(body), /expected "video"/);
  });

  test("the log refuses to record a non-private upload", () => {
    const log = recordRender({ videos: [] }, { videoId: "v1", title: "t" });
    assert.throws(() => recordUpload(log, "v1", { privacy: "public" }), /only uploads private/);
  });
});

describe("buildPostBody", () => {
  const body = buildPostBody({ mediaUrl: "https://x/y.mp4", packaging: PACKAGING, publishAt: "2026-08-20T10:00:00" });

  test("uses the long-form type, not the Reels 'short'", () => {
    assert.equal(body.youtubeData.type, "video");
  });

  test("puts the description in the POST TEXT, where YouTube reads it from", () => {
    // youtubeData.description is accepted and silently dropped (Phase 0).
    assert.equal(body.text, PACKAGING.description);
    assert.equal(body.youtubeData.description, undefined);
  });

  test("carries title, tags, category and madeForKids", () => {
    assert.equal(body.youtubeData.title, PACKAGING.title);
    assert.deepEqual(body.youtubeData.tags, PACKAGING.tags);
    assert.equal(body.youtubeData.category, CATEGORY);
    assert.equal(body.youtubeData.madeForKids, false);
  });

  test("targets YouTube only", () => {
    assert.deepEqual(body.providers, [{ network: "youtube" }]);
  });
});

// ─── the checklist ──────────────────────────────────────────────────────────

describe("reviewChecklist", () => {
  test("ALWAYS demands the AI disclosure when the clone narrates", () => {
    const items = reviewChecklist({ packaging: PACKAGING, narrationMode: "elevenlabs" });
    assert.ok(items.some((i) => /synthetic content/i.test(i)), "the disclosure must be on every video");
    assert.ok(items.some((i) => /voice clone/i.test(i)), "and it must say WHY, or it looks optional");
  });

  test("drops the disclosure only when Peter narrates everything himself", () => {
    const items = reviewChecklist({ packaging: PACKAGING, narrationMode: "peter" });
    assert.ok(!items.some((i) => /synthetic content/i.test(i)));
  });

  test("asks for the thumbnail, which the API cannot set", () => {
    assert.ok(reviewChecklist({ packaging: PACKAGING }).some((i) => /thumbnail/i.test(i)));
  });

  test("surfaces missing CTA config as a thing to fix by hand", () => {
    const items = reviewChecklist({ packaging: { ...PACKAGING, missingCta: ["text number (YT_TEXT_NUMBER)"] } });
    assert.ok(items.some((i) => i.includes("YT_TEXT_NUMBER")));
  });

  test("opens by making it explicit that APPROVE IS PUBLISH — the Studio flip is gone", () => {
    // The list used to END with "flip it to Public yourself"; Peter approved
    // video 1, followed that line to Studio, and overruled the design
    // (2026-08-19). The card now leads with what approval actually does.
    const items = reviewChecklist({ packaging: PACKAGING });
    assert.match(items[0], /APPROVE = PUBLISH/);
    assert.match(items[0], /goes PUBLIC automatically/i);
    for (const item of items) {
      assert.doesNotMatch(item, /flip it to Public yourself/i, "the Studio instruction may not survive anywhere in the list");
    }
  });
});

describe("renderReviewText", () => {
  const text = renderReviewText({
    packaging: PACKAGING,
    youtubeUrl: "https://youtu.be/abc",
    driveLink: "https://drive/x",
    checklist: reviewChecklist({ packaging: PACKAGING }),
    stats: { runtimeMinutes: 12.4, resolution: "1080p" },
  });

  test("leads with where to watch it", () => {
    assert.ok(text.includes("https://youtu.be/abc"));
  });

  test("says plainly that approving does not publish", () => {
    assert.ok(/Approving does NOT publish/i.test(text), "a review that reads like a publish button breaks the design");
  });

  test("includes the pinned comment to copy", () => {
    assert.ok(text.includes(PACKAGING.pinnedComment));
  });
});

// ─── the log ────────────────────────────────────────────────────────────────

describe("yt-log", () => {
  test("videoId is derived from the requestId, so a retry finds the same entry", () => {
    assert.equal(videoIdFor("video_review-2026-08-14-abcd1234"), videoIdFor("video_review-2026-08-14-abcd1234"));
    assert.notEqual(videoIdFor("a-1"), videoIdFor("a-2"));
  });

  test("a rendered video starts NOT approved", () => {
    const log = recordRender({ videos: [] }, { videoId: "v1", requestId: "r1", title: "t" });
    assert.equal(isApproved(findVideo(log, "v1")), false);
    assert.equal(isUploaded(findVideo(log, "v1")), false);
  });

  test("recordRender does not duplicate on a retry", () => {
    let log = recordRender({ videos: [] }, { videoId: "v1", title: "t" });
    log = recordRender(log, { videoId: "v1", title: "t" });
    assert.equal(log.videos.length, 1);
  });

  test("recordUpload stamps once and REFUSES to re-stamp", () => {
    let log = recordRender({ videos: [] }, { videoId: "v1", title: "t" });
    log = recordUpload(log, "v1", { youtubeUrl: "https://youtu.be/a", metricoolPostId: "1" });
    const first = findVideo(log, "v1").uploadedAt;
    log = recordUpload(log, "v1", { youtubeUrl: "https://youtu.be/b", metricoolPostId: "2" });
    assert.equal(findVideo(log, "v1").uploadedAt, first);
    assert.equal(findVideo(log, "v1").youtubeUrl, "https://youtu.be/a", "a second upload must not overwrite the first");
  });

  test("an uploaded video is recorded as private", () => {
    let log = recordRender({ videos: [] }, { videoId: "v1", title: "t" });
    log = recordUpload(log, "v1", { youtubeUrl: "u", metricoolPostId: "1" });
    assert.equal(findVideo(log, "v1").privacy, PRIVACY);
  });

  test("recordReview sets approved only from an explicit true", () => {
    let log = recordRender({ videos: [] }, { videoId: "v1", title: "t" });
    log = recordReview(log, "v1", { approved: false, notes: "hook is soft" });
    assert.equal(isApproved(findVideo(log, "v1")), false);
    assert.equal(findVideo(log, "v1").reviewNotes, "hook is soft");
  });

  test("a truthy-but-not-true value does NOT approve", () => {
    let log = recordRender({ videos: [] }, { videoId: "v1", title: "t" });
    log = recordReview(log, "v1", { approved: "yes" });
    assert.equal(isApproved(findVideo(log, "v1")), false);
  });

  test("a review is not overwritten by a later one", () => {
    let log = recordRender({ videos: [] }, { videoId: "v1", title: "t" });
    log = recordReview(log, "v1", { approved: true });
    log = recordReview(log, "v1", { approved: false });
    assert.equal(isApproved(findVideo(log, "v1")), true);
  });

  test("shorts are cut once", () => {
    let log = recordRender({ videos: [] }, { videoId: "v1", title: "t" });
    log = recordShorts(log, "v1", [{ id: "s1" }]);
    const at = findVideo(log, "v1").shortsCutAt;
    log = recordShorts(log, "v1", [{ id: "s2" }]);
    assert.equal(findVideo(log, "v1").shortsCutAt, at);
    assert.equal(findVideo(log, "v1").shorts[0].id, "s1");
  });

  test("findByRequest links a video back to its approval request", () => {
    const log = recordRender({ videos: [] }, { videoId: "v1", requestId: "req-9", title: "t" });
    assert.equal(findByRequest(log, "req-9").videoId, "v1");
  });

  test("recentBrollHashes collects what recent videos spent", () => {
    const log = {
      videos: [
        { videoId: "v1", createdAt: "2026-08-01T00:00:00Z", brollHashes: ["a", "b"] },
        { videoId: "v2", createdAt: "2026-08-08T00:00:00Z", brollHashes: ["c"] },
      ],
    };
    const hashes = recentBrollHashes(log, 4);
    assert.ok(hashes.has("a") && hashes.has("b") && hashes.has("c"));
  });

  test("recentBrollHashes only looks back so far — a finite library cannot avoid everything", () => {
    const log = {
      videos: Array.from({ length: 10 }, (_, i) => ({
        videoId: `v${i}`,
        createdAt: `2026-0${(i % 9) + 1}-01T00:00:00Z`,
        brollHashes: [`h${i}`],
      })),
    };
    assert.ok(recentBrollHashes(log, 2).size <= 2);
  });

  test("pastTitles returns newest first", () => {
    const log = {
      videos: [
        { videoId: "v1", createdAt: "2026-08-01T00:00:00Z", title: "older" },
        { videoId: "v2", createdAt: "2026-08-08T00:00:00Z", title: "newer" },
      ],
    };
    assert.deepEqual(pastTitles(log), ["newer", "older"]);
  });

  test("an unreadable log reads as empty, and empty approves nothing", () => {
    const log = loadLog("/definitely/not/here-8fa3.json");
    assert.deepEqual(log, { videos: [] });
    assert.equal(isApproved(findVideo(log, "anything")), false);
  });
});

// ─── the merge ──────────────────────────────────────────────────────────────

describe("mergeYouTubeLog — two writers again", () => {
  const RENDERED = {
    videoId: "v1",
    requestId: "r1",
    title: "Moving to San Antonio",
    createdAt: "2026-08-14T18:00:00.000Z",
    brollHashes: ["h1", "h2"],
    approved: false,
  };

  test("the poster's upload and the dashboard's review both survive", () => {
    const local = { videos: [{ ...RENDERED, uploadedAt: "2026-08-14T19:00:00.000Z", privacy: "private", youtubeUrl: "https://youtu.be/a" }] };
    const remote = { videos: [{ videoId: "v1", reviewedAt: "2026-08-15T09:00:00.000Z", approved: true }] };
    const m = mergeYouTubeLog(local, remote, quiet).videos[0];
    assert.equal(m.uploadedAt, "2026-08-14T19:00:00.000Z");
    assert.equal(m.youtubeUrl, "https://youtu.be/a");
    assert.equal(m.approved, true);
    assert.equal(m.title, "Moving to San Antonio");
  });

  test("THE RACE THAT MATTERS: an uploadedAt is never erased", () => {
    // If it were, the next scheduled run would see an un-uploaded video and
    // push another 320MB copy to YouTube.
    const uploaded = { videos: [{ ...RENDERED, uploadedAt: "2026-08-14T19:00:00.000Z" }] };
    const stale = { videos: [{ ...RENDERED }] };
    assert.equal(mergeYouTubeLog(uploaded, stale, quiet).videos[0].uploadedAt, "2026-08-14T19:00:00.000Z");
    assert.equal(mergeYouTubeLog(stale, uploaded, quiet).videos[0].uploadedAt, "2026-08-14T19:00:00.000Z");
  });

  test("an approval is never downgraded by a stale copy", () => {
    const approved = { videos: [{ ...RENDERED, approved: true, reviewedAt: "2026-08-15T09:00:00.000Z" }] };
    const stale = { videos: [{ ...RENDERED, approved: false }] };
    assert.equal(mergeYouTubeLog(stale, approved, quiet).videos[0].approved, true);
    assert.equal(mergeYouTubeLog(approved, stale, quiet).videos[0].approved, true);
  });

  test("but an approval is never INVENTED either — two unapproved copies stay unapproved", () => {
    const a = { videos: [{ ...RENDERED, approved: false }] };
    const b = { videos: [{ ...RENDERED }] };
    assert.equal(mergeYouTubeLog(a, b, quiet).videos[0].approved, false);
  });

  test("distinct videos are all kept", () => {
    const local = { videos: [{ ...RENDERED, videoId: "a" }] };
    const remote = { videos: [{ ...RENDERED, videoId: "b" }] };
    assert.equal(mergeYouTubeLog(local, remote, quiet).videos.length, 2);
  });

  test("drops garbage instead of throwing", () => {
    const local = { videos: [null, "no", {}, { videoId: "" }, { ...RENDERED }] };
    assert.equal(mergeYouTubeLog(local, { videos: [] }, quiet).videos.length, 1);
  });

  test("does not mutate either side", () => {
    const local = { videos: [{ ...RENDERED }] };
    const remote = { videos: [{ videoId: "v1", approved: true, reviewedAt: "2026-08-15T09:00:00.000Z" }] };
    mergeYouTubeLog(local, remote, quiet);
    assert.equal(local.videos[0].approved, false);
    assert.equal(remote.videos[0].title, undefined);
  });

  test("tolerates an empty remote (first ever run)", () => {
    assert.equal(mergeYouTubeLog({ videos: [{ ...RENDERED }] }, { videos: [] }, quiet).videos.length, 1);
  });
});
