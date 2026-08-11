/**
 * Social telemetry writer.
 *
 * The failure this file exists to prevent is a confident wrong number. The
 * dashboard has no way to tell a counted zero from an unknown, so the writer
 * has to: present key = counted fact, absent key = we do not know. Most of
 * these tests are about that boundary rather than about arithmetic.
 *
 * The second failure it guards is subtler — the writer runs inside the commit
 * step of a live posting job, so it must never be able to throw. A dashboard
 * number is not worth aborting the push that carries posted-log.json.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  platformOf,
  todayInChicago,
  isoZ,
  eventsFromPostedEntry,
  eventsFromCarouselEntry,
  buildStats,
  mergeSocialLog,
  atomicWriteJson,
  collectEvents,
  writeSocialTelemetry,
  MAX_LOG_ENTRIES,
} from "../src/social-telemetry.js";

// 2026-08-11 20:00Z is 3pm in Chicago — mid-afternoon, well inside the day, so
// no test here accidentally depends on a UTC-vs-Central date rollover.
const NOW = new Date("2026-08-11T20:00:00.000Z");
const TODAY = "2026-08-11";
const TS = "2026-08-11T19:11:00.000Z";

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "social-telemetry-"));
  return dir;
}

describe("platformOf — the three-platform contract", () => {
  test("maps this repo's spellings onto the contract", () => {
    assert.equal(platformOf("instagram"), "instagram");
    assert.equal(platformOf("satellite_ig"), "instagram");
    assert.equal(platformOf("instagram_main_native"), "instagram");
    assert.equal(platformOf("tiktok"), "tiktok");
  });

  test("youtube means Shorts — metricool posts every video as youtubeData.type=short", () => {
    assert.equal(platformOf("youtube"), "youtube_shorts");
  });

  test("networks outside the contract are null, never folded into a neighbour", () => {
    // The temptation is to bucket facebook under instagram because Meta. That
    // would inflate Instagram's number with posts Instagram never saw.
    assert.equal(platformOf("facebook"), null);
    assert.equal(platformOf("linkedin"), null);
    assert.equal(platformOf(""), null);
    assert.equal(platformOf(undefined), null);
  });
});

describe("eventsFromPostedEntry — an UNVERIFIED reel's outcome is 'scheduled', never 'published'", () => {
  const reel = {
    timestamp: TS,
    city: "austin",
    fileName: "atx-tour.mp4",
    success: true,
    platforms: ["tiktok", "youtube", "satellite_ig"],
    brands: "lifestyledesignrealtytexas, propertypete01",
    mainIgDelivery: "delivered",
  };

  test("a successful reel yields one scheduled event per contract platform", () => {
    const events = eventsFromPostedEntry(reel);
    assert.equal(events.length, 3);
    assert.ok(events.every((e) => e.type === "scheduled"));
    assert.deepEqual(
      events.map((e) => e.platform).sort(),
      ["instagram", "tiktok", "youtube_shorts"]
    );
  });

  test("NEVER emits published for a reel that carries no verdict rows", () => {
    // The reels path verifies now (main.js → reel-verify.js), but an entry
    // written before that wiring — or by a run whose verification never got to
    // look — holds only a 200 from the scheduler. That is not evidence of a
    // publication and this writer must not launder one into the other.
    assert.ok(eventsFromPostedEntry(reel).every((e) => e.type !== "published"));
  });

  test("carries the slug so a human can identify the post", () => {
    assert.ok(eventsFromPostedEntry(reel).every((e) => e.title_or_slug === "atx-tour.mp4"));
  });

  test("an absent `brands` key means every brand failed — that is a failure, not a post", () => {
    // state.recordPost only persists `brands` when the joined string is truthy,
    // so an empty join (no brand's scheduler call returned 200) leaves the key
    // absent. Counting that as three scheduled posts is the exact invention
    // this writer is built to refuse.
    const { brands, ...noBrands } = reel;
    void brands;
    const events = eventsFromPostedEntry(noBrands);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "failed");
    assert.equal(events[0].platform, undefined, "a whole-run failure is not platform-specific");
  });

  test("brands:'unknown' produces NO event — unreadable is not the same as failed", () => {
    const events = eventsFromPostedEntry({ ...reel, brands: "unknown" });
    assert.deepEqual(events, []);
  });

  test("success:false yields a failure with no invented platform", () => {
    const events = eventsFromPostedEntry({ ...reel, success: false, note: "drive token expired" });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "failed");
    assert.equal(events[0].platform, undefined);
    assert.match(events[0].detail, /drive token expired/);
  });

  test("a failed main-IG delivery is its own Instagram failure", () => {
    // The satellites still got the reel, but the owner never received the file,
    // so main Instagram goes dark for that slot and nobody would otherwise see it.
    const events = eventsFromPostedEntry({ ...reel, mainIgDelivery: "delivery_failed_owner_must_post" });
    const failures = events.filter((e) => e.type === "failed");
    assert.equal(failures.length, 1);
    assert.equal(failures[0].platform, "instagram");
  });

  test("a manual-confirm receipt IS a real Instagram publication", () => {
    // Main IG is never auto-published (mainBrandSkipIG). The owner posts it
    // natively and confirms, and that receipt is the only published-on-Instagram
    // evidence this repo ever holds.
    const events = eventsFromPostedEntry({
      timestamp: TS,
      platform: "instagram_main_native",
      source: "manual_confirm",
      driveFileId: "1N2rR10",
      captionSnippet: "New construction starting at $359,990",
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "published");
    assert.equal(events[0].platform, "instagram");
  });

  test("LinkedIn entries are ignored — a different pipeline, not in this contract", () => {
    assert.deepEqual(eventsFromPostedEntry({ timestamp: TS, type: "linkedin", topic: "x" }), []);
  });

  test("junk in never becomes an event", () => {
    assert.deepEqual(eventsFromPostedEntry(null), []);
    assert.deepEqual(eventsFromPostedEntry({}), []);
    assert.deepEqual(eventsFromPostedEntry({ timestamp: TS, success: true, platforms: [] }), []);
  });
});

describe("eventsFromPostedEntry — a VERIFIED reel reports what actually published", () => {
  // reel-verify.js stamps the entry with one row per (brand, network), the same
  // shape carousel-verify.js writes. Those rows are an outcome, so they are read
  // as one — and they REPLACE the `platforms` literal, which is only intent.
  const verified = (distribution) => ({
    timestamp: TS,
    city: "austin",
    fileName: "atx-tour.mp4",
    success: true,
    platforms: ["tiktok", "youtube", "satellite_ig"],
    brands: "propertypete01",
    mainIgDelivery: "delivered",
    distribution,
    verification: { checkedAt: TS, allVerified: true, anyFailed: false, pendingRecheck: false },
  });
  const row = (network, verdict, over = {}) => ({
    label: "propertypete01", blogId: 1, postId: 4242, network, ok: true, verdict, ...over,
  });

  test("a published verdict is a published event, per network", () => {
    const events = eventsFromPostedEntry(verified([row("tiktok", "published"), row("youtube", "published")]));
    assert.equal(events.length, 2);
    assert.ok(events.every((e) => e.type === "published"));
    assert.deepEqual(events.map((e) => e.platform).sort(), ["tiktok", "youtube_shorts"]);
  });

  test("the rows replace `platforms` — one publication is never both scheduled and published", () => {
    const events = eventsFromPostedEntry(verified([row("tiktok", "published")]));
    assert.equal(events.length, 1, "the three-platform intent literal must not be counted too");
  });

  test("pending and unknown stay scheduled — accepted is all we know", () => {
    assert.equal(eventsFromPostedEntry(verified([row("tiktok", "pending")]))[0].type, "scheduled");
    assert.equal(eventsFromPostedEntry(verified([row("tiktok", "unknown")]))[0].type, "scheduled");
  });

  test("a failed verdict carries Metricool's own reason", () => {
    const events = eventsFromPostedEntry(verified([row("tiktok", "failed", { failureReason: "media rejected" })]));
    assert.equal(events[0].type, "failed");
    assert.equal(events[0].platform, "tiktok");
    assert.match(events[0].detail, /media rejected/);
  });

  test("a failed main-IG delivery is still its own Instagram failure", () => {
    const entry = { ...verified([row("tiktok", "published")]), mainIgDelivery: "delivery_failed_owner_must_post" };
    const failures = eventsFromPostedEntry(entry).filter((e) => e.type === "failed");
    assert.equal(failures.length, 1);
    assert.equal(failures[0].platform, "instagram");
  });

  test("success:false still wins — a run that failed never published anything", () => {
    const entry = { ...verified([row("tiktok", "published")]), success: false, note: "delivery exhausted" };
    const events = eventsFromPostedEntry(entry);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "failed");
  });

  test("an empty distribution array falls back to the scheduler evidence", () => {
    // A verification pass that found nothing to check writes no rows. The entry
    // is then exactly as unverified as it was before, and says so.
    const events = eventsFromPostedEntry({ ...verified([]), verification: null });
    assert.equal(events.length, 3);
    assert.ok(events.every((e) => e.type === "scheduled"));
  });
});

describe("eventsFromCarouselEntry — the pipeline that actually checks", () => {
  const entry = (distribution) => ({ timestamp: TS, topic: "The I-35 drive", distribution });

  test("verdict published becomes a published event", () => {
    const events = eventsFromCarouselEntry(entry([
      { network: "tiktok", ok: true, postId: 1, verdict: "published" },
    ]));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "published");
    assert.equal(events[0].platform, "tiktok");
  });

  test("verdict pending is scheduled, NOT published", () => {
    const events = eventsFromCarouselEntry(entry([
      { network: "tiktok", ok: true, postId: 1, verdict: "pending" },
    ]));
    assert.equal(events[0].type, "scheduled");
  });

  test("verdict failed is counted, with its reason", () => {
    const events = eventsFromCarouselEntry(entry([
      { network: "instagram", ok: true, postId: 2, verdict: "failed", failureReason: "media rejected" },
    ]));
    assert.equal(events[0].type, "failed");
    assert.match(events[0].detail, /media rejected/);
  });

  test("a row skipped for owner delivery produces nothing — it was never sent", () => {
    assert.deepEqual(
      eventsFromCarouselEntry(entry([{ network: "instagram", ok: true, skipped: "deliverToOwner" }])),
      []
    );
  });

  test("LinkedIn rows are dropped even when published", () => {
    assert.deepEqual(
      eventsFromCarouselEntry(entry([{ network: "linkedin", ok: true, postId: 3, verdict: "published" }])),
      []
    );
  });

  test("two brands publishing to the same platform stay two events", () => {
    // Real data, 2026-08-11: one carousel published to Instagram as
    // propertypete01 AND as lifestyledesignrealtyaustintx, same second, same
    // slug. Without the account name in `detail` the two render identically,
    // the log dedupes them to one, and it disagrees with the stats — which
    // counted both, correctly.
    const events = eventsFromCarouselEntry(entry([
      { label: "propertypete01", network: "instagram", ok: true, postId: 1, verdict: "published" },
      { label: "lifestyledesignrealtyaustintx", network: "instagram", ok: true, postId: 2, verdict: "published" },
    ]));
    assert.equal(events.length, 2);
    assert.equal(mergeSocialLog([], events).length, 2, "the merge must not collapse two real publications");
    assert.match(events[0].detail, /propertypete01/);
  });
});

describe("buildStats — present means counted, absent means unknown", () => {
  const base = { date: TODAY, lastRunIso: isoZ(NOW) };

  test("a platform with no settled observation is OMITTED, not zeroed", () => {
    // Four reels scheduled to TikTok all day and nothing verified them. Writing
    // tiktok: 0 would claim "we checked and nothing published". We did not check.
    const stats = buildStats(
      [
        { ts: TS, platform: "tiktok", type: "scheduled" },
        { ts: TS, platform: "youtube_shorts", type: "scheduled" },
      ],
      base
    );
    assert.equal(stats.posts_scheduled, 2);
    assert.deepEqual(stats.posts_published_today, {});
    assert.ok(!("tiktok" in stats.posts_published_today));
  });

  test("a settled failure DOES make a zero meaningful for that platform", () => {
    // We could see TikTok's outcome and it was a failure — so "published: 0" is
    // now a counted zero rather than a guess.
    const stats = buildStats([{ ts: TS, platform: "tiktok", type: "failed" }], base);
    assert.deepEqual(stats.posts_published_today, { tiktok: 0 });
    assert.equal(stats.failures, 1);
  });

  test("counts publications per platform", () => {
    const stats = buildStats(
      [
        { ts: TS, platform: "instagram", type: "published" },
        { ts: TS, platform: "instagram", type: "published" },
        { ts: TS, platform: "tiktok", type: "published" },
      ],
      base
    );
    assert.deepEqual(stats.posts_published_today, { instagram: 2, tiktok: 1 });
  });

  test("a platform-less failure is counted in failures but zeroes nothing", () => {
    const stats = buildStats([{ ts: TS, type: "failed" }], base);
    assert.equal(stats.failures, 1);
    assert.deepEqual(stats.posts_published_today, {}, "an unattributed failure must not zero a platform");
  });

  test("an empty day is all zeros and an empty object — the bot ran and did nothing", () => {
    const stats = buildStats([], base);
    assert.equal(stats.posts_scheduled, 0);
    assert.equal(stats.failures, 0);
    assert.deepEqual(stats.posts_published_today, {});
    assert.equal(stats.date, TODAY);
    assert.equal(stats.last_run_iso, isoZ(NOW));
  });

  test("keys appear in the contract's order, not insertion order", () => {
    const stats = buildStats(
      [
        { ts: TS, platform: "youtube_shorts", type: "published" },
        { ts: TS, platform: "instagram", type: "published" },
      ],
      base
    );
    assert.deepEqual(Object.keys(stats.posts_published_today), ["instagram", "youtube_shorts"]);
  });
});

describe("mergeSocialLog — a rerun is a no-op, never a duplicate", () => {
  const ev = (ts, platform, type = "scheduled") => ({
    ts, platform, type, title_or_slug: "a.mp4", detail: "d",
  });

  test("merging the same events twice changes nothing", () => {
    // The runner that loses the push race re-runs this whole script on top of
    // the winner's commit. An append would duplicate every event each time.
    const fresh = [ev(TS, "tiktok")];
    const once = mergeSocialLog([], fresh);
    const twice = mergeSocialLog(once, fresh);
    assert.deepEqual(twice, once);
  });

  test("keeps history the source logs have already aged out", () => {
    const old = ev("2026-01-01T00:00:00Z", "instagram", "published");
    const merged = mergeSocialLog([old], [ev(TS, "tiktok")]);
    assert.equal(merged.length, 2);
  });

  test("newest first", () => {
    const merged = mergeSocialLog(
      [ev("2026-08-01T00:00:00Z", "tiktok")],
      [ev("2026-08-11T00:00:00Z", "instagram")]
    );
    assert.equal(merged[0].platform, "instagram");
  });

  test(`trims to ${MAX_LOG_ENTRIES}`, () => {
    const many = Array.from({ length: 150 }, (_, i) =>
      ev(new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), "tiktok")
    );
    assert.equal(mergeSocialLog([], many).length, MAX_LOG_ENTRIES);
  });

  test("two events in the same second both survive", () => {
    // ts is second-precision by contract. Keying on (ts, platform, type) alone
    // would silently drop one of a simultaneous pair.
    const a = { ...ev(TS, "tiktok"), title_or_slug: "one.mp4" };
    const b = { ...ev(TS, "tiktok"), title_or_slug: "two.mp4" };
    assert.equal(mergeSocialLog([], [a, b]).length, 2);
  });

  test("drops corrupt or hand-edited entries from disk rather than propagating them", () => {
    const merged = mergeSocialLog(
      [null, "nope", { ts: "not-a-date", type: "published" }, { ts: TS, type: "invented_type" }, { ts: TS, platform: "myspace", type: "published" }],
      [ev(TS, "tiktok")]
    );
    assert.equal(merged.length, 1);
  });

  test("normalises to the contract fields only", () => {
    const merged = mergeSocialLog([], [{ ...ev(TS, "tiktok"), secret: "leak", person_id: 7 }]);
    assert.deepEqual(Object.keys(merged[0]).sort(), ["detail", "platform", "title_or_slug", "ts", "type"]);
  });
});

describe("atomicWriteJson", () => {
  test("leaves no partial file and no temp file behind", () => {
    const dir = tempDir();
    try {
      const path = join(dir, "nested", "deep", "out.json");
      atomicWriteJson(path, { a: 1 });
      assert.deepEqual(JSON.parse(readFileSync(path, "utf-8")), { a: 1 });
      const strays = existsSync(join(dir, "nested", "deep"))
        ? readFileSync(path, "utf-8")
        : "";
      assert.ok(strays.endsWith("\n"), "trailing newline so the file is diff-friendly");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("overwrites an existing file in place", () => {
    const dir = tempDir();
    try {
      const path = join(dir, "out.json");
      atomicWriteJson(path, { v: 1 });
      atomicWriteJson(path, { v: 2 });
      assert.deepEqual(JSON.parse(readFileSync(path, "utf-8")), { v: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("collectEvents — today only, and corrupt input is survivable", () => {
  function fixture(posted, carousel) {
    const dir = tempDir();
    writeFileSync(join(dir, "posted-log.json"), JSON.stringify(posted));
    writeFileSync(join(dir, "carousel-log.json"), JSON.stringify(carousel));
    return dir;
  }

  test("ignores entries from other days", () => {
    const dir = fixture(
      { posts: [
        { timestamp: TS, fileName: "today.mp4", success: true, platforms: ["tiktok"], brands: "b" },
        { timestamp: "2026-08-09T19:00:00Z", fileName: "old.mp4", success: true, platforms: ["tiktok"], brands: "b" },
      ] },
      { posts: [] }
    );
    try {
      const events = collectEvents({ autoPosterDir: dir, date: TODAY });
      assert.equal(events.length, 1);
      assert.equal(events[0].title_or_slug, "today.mp4");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("uses the Chicago day, not the UTC day", () => {
    // 2026-08-12T02:00Z is still 9pm on the 11th in Chicago. A UTC-day writer
    // would file the evening slot under tomorrow and show the owner a zero.
    const dir = fixture(
      { posts: [{ timestamp: "2026-08-12T02:00:00Z", fileName: "evening.mp4", success: true, platforms: ["tiktok"], brands: "b" }] },
      { posts: [] }
    );
    try {
      assert.equal(collectEvents({ autoPosterDir: dir, date: TODAY }).length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a corrupt log is treated as empty rather than crashing the commit step", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "posted-log.json"), "{ this is not json");
    try {
      assert.deepEqual(collectEvents({ autoPosterDir: dir, date: TODAY }), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing logs are treated as empty", () => {
    const dir = tempDir();
    try {
      assert.deepEqual(collectEvents({ autoPosterDir: dir, date: TODAY }), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("combines both pipelines", () => {
    const dir = fixture(
      { posts: [{ timestamp: TS, fileName: "reel.mp4", success: true, platforms: ["tiktok"], brands: "b" }] },
      { posts: [{ timestamp: TS, topic: "carousel", distribution: [{ network: "tiktok", ok: true, postId: 9, verdict: "published" }] }] }
    );
    try {
      const events = collectEvents({ autoPosterDir: dir, date: TODAY });
      assert.equal(events.length, 2);
      assert.deepEqual(events.map((e) => e.type).sort(), ["published", "scheduled"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("writeSocialTelemetry — the whole thing, and it never throws", () => {
  function repo({ posted = { posts: [] }, carousel = { posts: [] } } = {}) {
    const root = tempDir();
    const ap = join(root, "auto-poster");
    mkdirSync(ap, { recursive: true });
    writeFileSync(join(ap, "posted-log.json"), JSON.stringify(posted));
    writeFileSync(join(ap, "carousel-log.json"), JSON.stringify(carousel));
    return { root, ap };
  }

  test("writes both files with the contract shape", () => {
    const { root, ap } = repo({
      posted: { posts: [
        { timestamp: TS, fileName: "atx.mp4", success: true, platforms: ["tiktok", "youtube", "satellite_ig"], brands: "main", mainIgDelivery: "delivered" },
        { timestamp: TS, platform: "instagram_main_native", source: "manual_confirm", driveFileId: "abc" },
      ] },
    });
    try {
      const res = writeSocialTelemetry({ repoRoot: root, autoPosterDir: ap, now: NOW });
      assert.equal(res.ok, true);

      const stats = JSON.parse(readFileSync(join(root, "status", "social_stats.json"), "utf-8"));
      assert.deepEqual(Object.keys(stats), ["date", "posts_scheduled", "posts_published_today", "failures", "last_run_iso"]);
      assert.equal(stats.date, TODAY);
      assert.equal(stats.posts_scheduled, 3);
      assert.equal(stats.failures, 0);
      // Instagram settled (the owner confirmed a native post); tiktok and
      // youtube_shorts were only scheduled, so they are absent, not zero.
      assert.deepEqual(stats.posts_published_today, { instagram: 1 });

      const log = JSON.parse(readFileSync(join(root, "status", "social_log.json"), "utf-8"));
      assert.equal(log.length, 4);
      assert.ok(log.every((e) => typeof e.ts === "string" && typeof e.type === "string"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("running it twice is idempotent apart from last_run_iso", () => {
    const { root, ap } = repo({
      posted: { posts: [{ timestamp: TS, fileName: "a.mp4", success: true, platforms: ["tiktok"], brands: "b" }] },
    });
    try {
      const first = writeSocialTelemetry({ repoRoot: root, autoPosterDir: ap, now: NOW });
      const later = new Date(NOW.getTime() + 60_000);
      const second = writeSocialTelemetry({ repoRoot: root, autoPosterDir: ap, now: later });
      assert.deepEqual(second.log, first.log, "the log must not grow on a retry");
      assert.equal(second.stats.posts_scheduled, first.stats.posts_scheduled);
      assert.notEqual(second.stats.last_run_iso, first.stats.last_run_iso);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a run that posted nothing still moves last_run_iso", () => {
    // This is the heartbeat. Without it the owner cannot tell "nothing to post
    // today" from "the poster has been dead for a week".
    const { root, ap } = repo();
    try {
      const res = writeSocialTelemetry({ repoRoot: root, autoPosterDir: ap, now: NOW });
      assert.equal(res.ok, true);
      assert.equal(res.stats.posts_scheduled, 0);
      assert.equal(res.stats.last_run_iso, isoZ(NOW));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns ok:false instead of throwing when the destination is unwritable", () => {
    // The contract that matters most: this runs in the commit step of a live
    // posting job. If it throws, the step dies and posted-log.json never gets
    // pushed — and the next run double-posts.
    const res = writeSocialTelemetry({
      repoRoot: "/proc/nonexistent-cannot-create",
      autoPosterDir: "/nope",
      now: NOW,
    });
    assert.equal(res.ok, false);
    assert.equal(typeof res.error, "string");
  });

  test("survives being handed no arguments at all", () => {
    assert.doesNotThrow(() => writeSocialTelemetry());
  });

  test("the two files never disagree — every counted publication is in the log", () => {
    // The invariant that caught the brand-dedupe bug. The stats are counted
    // from the raw events and the log from the merged ones, so any dedupe that
    // is too aggressive shows up here as a stats number the log cannot justify.
    // Both files are on the same dashboard; one contradicting the other is
    // worse than either being absent.
    const { root, ap } = repo({
      posted: { posts: [
        { timestamp: TS, platform: "instagram_main_native", source: "manual_confirm", driveFileId: "abc" },
        { timestamp: TS, fileName: "reel.mp4", success: true, platforms: ["tiktok", "youtube"], brands: "b" },
      ] },
      carousel: { posts: [{ timestamp: TS, topic: "t", distribution: [
        { label: "brand-a", network: "instagram", ok: true, postId: 1, verdict: "published" },
        { label: "brand-b", network: "instagram", ok: true, postId: 2, verdict: "published" },
        { label: "brand-c", network: "tiktok", ok: true, postId: 3, verdict: "published" },
        { label: "brand-d", network: "instagram", ok: true, postId: 4, verdict: "failed" },
      ] }] },
    });
    try {
      const { stats, log } = writeSocialTelemetry({ repoRoot: root, autoPosterDir: ap, now: NOW });

      for (const [platform, counted] of Object.entries(stats.posts_published_today)) {
        const inLog = log.filter((e) => e.type === "published" && e.platform === platform).length;
        assert.equal(inLog, counted, `${platform}: stats says ${counted}, log holds ${inLog}`);
      }
      assert.equal(log.filter((e) => e.type === "failed").length, stats.failures);
      assert.equal(log.filter((e) => e.type === "scheduled").length, stats.posts_scheduled);

      // And the numbers themselves: 3 IG publications (2 carousel brands + the
      // owner's native confirm), 1 TikTok, 1 IG failure, 2 reel platforms scheduled.
      assert.deepEqual(stats.posts_published_today, { instagram: 3, tiktok: 1 });
      assert.equal(stats.failures, 1);
      assert.equal(stats.posts_scheduled, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("todayInChicago", () => {
  test("rolls the day at Central midnight, not UTC midnight", () => {
    assert.equal(todayInChicago(new Date("2026-08-12T04:59:00Z")), "2026-08-11");
    assert.equal(todayInChicago(new Date("2026-08-12T05:01:00Z")), "2026-08-12");
  });
});
