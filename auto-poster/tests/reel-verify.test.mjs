/**
 * Reel publication verification.
 *
 * Two properties matter here more than any number this code produces, because it
 * runs on the live posting path with the video already on Instagram, TikTok and
 * YouTube:
 *
 *   1. It cannot post. Verification reads a status back; a retry or a re-upload
 *      hidden in here is a double-post, which is the worst outcome this repo has.
 *   2. It cannot fail the run. An unreachable status endpoint is an absence of
 *      evidence, and a successful post must not go red because we could not
 *      look at it.
 *
 * Most of these tests are about those two. The rest are about the third thing
 * the wiring exists for: the verdicts reaching social-telemetry.js, so the
 * dashboard counts a published reel as a publication.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REEL_VERIFY_WAIT_MS,
  verifyTargets,
  rowsForTarget,
  distributionFrom,
  summariseVerification,
  verifyReelPublication,
  applyReelVerification,
  findReelEntryIndex,
} from "../src/reel-verify.js";
import { eventsFromPostedEntry, buildStats, isoZ } from "../src/social-telemetry.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TS = "2026-08-11T19:11:00.000Z";
const NOW = new Date("2026-08-11T20:00:00.000Z");

/** What createPost returns for a satellite brand that the scheduler accepted. */
const brand = (over = {}) => ({
  label: "propertypete01",
  ok: true,
  postId: 4242,
  blogId: 111,
  networks: ["INSTAGRAM", "TIKTOK", "YOUTUBE"],
  providers: ["instagram", "tiktok", "youtube"],
  ...over,
});

const provider = (network, status, over = {}) => ({ network, status, detail: null, url: null, ...over });

/** A verifyAfterSettling record, as carousel-verify.js shapes one. */
const record = (over = {}) => ({
  label: "propertypete01",
  network: "reel",
  postId: 4242,
  blogId: 111,
  verdict: "published",
  providers: [],
  checkedAt: TS,
  ...over,
});

// ─── Targets ─────────────────────────────────────────────────────────────────

describe("verifyTargets — only posts we can honestly read back", () => {
  test("keeps accepted brands that carry a real postId", () => {
    const targets = verifyTargets([brand()]);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].postId, 4242);
    assert.equal(targets[0].blogId, 111);
  });

  test("drops a brand the scheduler rejected — there is nothing published to check", () => {
    assert.deepEqual(verifyTargets([brand({ ok: false, error: "API error 400" })]), []);
  });

  test("drops postId 'unknown' rather than querying it", () => {
    // "unknown" is the literal createPost writes when a 200 carried no id.
    // Passing it to the status endpoint would read back somebody else's post, or
    // nothing, and record the answer against this reel.
    assert.deepEqual(verifyTargets([brand({ postId: "unknown" })]), []);
    assert.deepEqual(verifyTargets([brand({ postId: undefined })]), []);
  });

  test("junk in, nothing out", () => {
    assert.deepEqual(verifyTargets(undefined), []);
    assert.deepEqual(verifyTargets([null, undefined, {}]), []);
  });

  test("uses the SUBMITTED providers, not the brand's connected networks", () => {
    // The main brand's Instagram is withheld so Peter posts it natively
    // (mainBrandSkipIG), so `networks` over-reports. Expecting an Instagram
    // status for a post Instagram was never sent would manufacture a permanent
    // unknown on the dashboard.
    const targets = verifyTargets([brand({
      label: "main",
      networks: ["INSTAGRAM", "TIKTOK", "YOUTUBE"],
      providers: ["tiktok", "youtube"],
    })]);
    assert.deepEqual(targets[0].networks, ["tiktok", "youtube"]);
  });

  test("falls back to the connected networks when providers were not reported", () => {
    const targets = verifyTargets([brand({ providers: undefined })]);
    assert.deepEqual(targets[0].networks, ["instagram", "tiktok", "youtube"]);
  });
});

// ─── Rows ────────────────────────────────────────────────────────────────────

describe("rowsForTarget — one verdict per network, never a collapsed one", () => {
  const target = verifyTargets([brand()])[0];

  test("each provider's status becomes that network's verdict", () => {
    const rows = rowsForTarget(target, record({
      providers: [
        provider("instagram", "PUBLISHED", { url: "https://instagram.com/p/abc" }),
        provider("tiktok", "ERROR", { detail: "The 'image/png' type is not allowed" }),
        provider("youtube", "PENDING"),
      ],
    }));
    const by = Object.fromEntries(rows.map((r) => [r.network, r]));
    assert.equal(by.instagram.verdict, "published");
    assert.equal(by.instagram.verified, true);
    assert.equal(by.instagram.publicUrl, "https://instagram.com/p/abc");
    assert.equal(by.tiktok.verdict, "failed");
    assert.equal(by.tiktok.failureReason, "The 'image/png' type is not allowed");
    assert.equal(by.youtube.verdict, "pending");
    assert.equal(by.youtube.verified, false);
  });

  test("one failed network does not drag its siblings down", () => {
    // The collapsed per-post verdict was the old behaviour: a single TikTok
    // error made the whole post unverified, and the two networks that really did
    // publish were never counted.
    const rows = rowsForTarget(target, record({
      providers: [
        provider("instagram", "PUBLISHED"),
        provider("tiktok", "FAILED"),
        provider("youtube", "PUBLISHED"),
      ],
    }));
    assert.equal(rows.filter((r) => r.verdict === "published").length, 2);
  });

  test("AWAITING_CONFIRMATION is pending, never failed", () => {
    // Measured resolving to PUBLISHED ~60s later. Treating it as a failure would
    // alert Peter about a healthy post.
    const rows = rowsForTarget(target, record({ providers: [provider("tiktok", "AWAITING_CONFIRMATION")] }));
    assert.equal(rows.find((r) => r.network === "tiktok").verdict, "pending");
  });

  test("a submitted network Metricool never mentions is unknown, not dropped", () => {
    // A missing row reads downstream as "we never sent it there", which is a
    // different and false claim.
    const rows = rowsForTarget(target, record({ providers: [provider("instagram", "PUBLISHED")] }));
    assert.deepEqual(rows.map((r) => r.network), ["instagram", "tiktok", "youtube"]);
    assert.equal(rows.find((r) => r.network === "tiktok").verdict, "unknown");
  });

  test("a status call that erred makes every network unknown, and says why", () => {
    const rows = rowsForTarget(target, record({ providers: [], verdict: "unknown", error: "HTTP 500" }));
    assert.ok(rows.every((r) => r.verdict === "unknown"));
    assert.ok(rows.every((r) => r.error === "HTTP 500"));
    assert.ok(rows.every((r) => r.verified === false));
  });

  test("no record at all is unknown with a reason, not silence", () => {
    const rows = rowsForTarget(target, undefined);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.verdict === "unknown" && r.error));
  });

  test("ok stays true on every row — the scheduler DID accept the post", () => {
    // `ok` means accepted and that remains true; `verified` is the stronger,
    // separate claim. Conflating them is what hid the 2026-08-03 TikTok failure.
    const rows = rowsForTarget(target, record({ providers: [provider("tiktok", "FAILED")] }));
    assert.ok(rows.every((r) => r.ok === true));
  });

  test("with no submitted list, the observed providers define the rows", () => {
    const rows = rowsForTarget(
      { label: "x", blogId: 1, postId: 9, networks: [] },
      record({ postId: 9, providers: [provider("tiktok", "PUBLISHED")] })
    );
    assert.deepEqual(rows.map((r) => r.network), ["tiktok"]);
  });

  test("distributionFrom matches records to targets by postId", () => {
    const targets = verifyTargets([brand(), brand({ label: "second", postId: 77, providers: ["tiktok"] })]);
    const rows = distributionFrom(targets, [
      record({ providers: [provider("instagram", "PUBLISHED")] }),
      record({ label: "second", postId: 77, providers: [provider("tiktok", "PUBLISHED")] }),
    ]);
    assert.equal(rows.length, 4);
    assert.equal(rows.filter((r) => r.label === "second").length, 1);
    assert.equal(rows.find((r) => r.label === "second").verdict, "published");
  });
});

// ─── Summary ─────────────────────────────────────────────────────────────────

describe("summariseVerification — what main.js alerts on", () => {
  const rows = (...verdicts) => verdicts.map((verdict, i) => ({ network: `n${i}`, verdict }));

  test("all published is allVerified, with nothing outstanding", () => {
    const s = summariseVerification(rows("published", "published"), [], { checkedAt: TS });
    assert.equal(s.allVerified, true);
    assert.equal(s.anyFailed, false);
    assert.equal(s.pendingRecheck, false);
    assert.equal(s.counts.published, 2);
    assert.equal(s.checkedAt, TS);
  });

  test("one failed network sets anyFailed — the run's one remaining red path", () => {
    const s = summariseVerification(rows("published", "failed"), []);
    assert.equal(s.anyFailed, true);
    assert.equal(s.allVerified, false);
  });

  test("pending and unknown are both unresolved, and neither is a failure", () => {
    const s = summariseVerification(rows("published", "pending", "unknown"), []);
    assert.equal(s.anyFailed, false, "not confirmed is not the same as failed");
    assert.equal(s.pendingRecheck, true);
    assert.equal(s.counts.pending, 1);
    assert.equal(s.counts.unknown, 1);
  });

  test("no rows is not allVerified — an empty check proves nothing", () => {
    assert.equal(summariseVerification([], []).allVerified, false);
  });

  test("keeps the per-brand audit trail main.js reports from", () => {
    const s = summariseVerification(rows("published"), [record({ providers: [provider("tiktok", "PUBLISHED")], error: "x" })]);
    assert.equal(s.results.length, 1);
    assert.equal(s.results[0].label, "propertypete01");
    assert.equal(s.results[0].postId, 4242);
    assert.equal(s.results[0].error, "x");
  });
});

// ─── The whole pass ──────────────────────────────────────────────────────────

describe("verifyReelPublication — never throws, never posts, never blocks", () => {
  /** Drives the real verifyAfterSettling, with the network and the clock faked. */
  const run = (brands, verify, over = {}) =>
    verifyReelPublication(brands, {
      waitMs: 0,
      sleepFn: async () => {},
      warn: () => {},
      verify,
      now: () => NOW,
      ...over,
    });

  test("the settle wait is unchanged at 7 minutes — this rewiring moves no timing", () => {
    assert.equal(REEL_VERIFY_WAIT_MS, 7 * 60 * 1000);
  });

  test("a fully published reel verifies every network", async () => {
    const result = await run([brand()], async () => ({
      providers: [
        provider("instagram", "PUBLISHED"),
        provider("tiktok", "PUBLISHED"),
        provider("youtube", "PUBLISHED"),
      ],
    }));
    assert.equal(result.verification.allVerified, true);
    assert.equal(result.verification.counts.published, 3);
    assert.equal(result.distribution.length, 3);
    assert.equal(result.verification.checkedAt, isoZ(NOW).replace("Z", ".000Z"));
  });

  test("VERIFICATION FAILURE LEAVES THE RUN SUCCESSFUL — a throwing status call", async () => {
    // The reel is already on TikTok and YouTube by the time this runs. A status
    // endpoint that is down cannot un-post it, so it must not produce the one
    // verdict main.js exits non-zero on.
    const result = await run([brand()], async () => { throw new Error("network down"); });
    assert.equal(result.verification.anyFailed, false, "an unreadable status is NOT an observed failure");
    assert.equal(result.verification.pendingRecheck, true);
    assert.equal(result.verification.counts.unknown, 3);
    assert.equal(result.verification.counts.failed, 0);
    assert.ok(result.distribution.every((r) => r.verdict === "unknown"));
  });

  test("verification failure leaves the run successful — an HTTP error body", async () => {
    // verifyPostStatus swallows a non-200 and returns { providers: [], error }.
    const result = await run([brand()], async () => ({ providers: [], error: "HTTP 500" }));
    assert.equal(result.verification.anyFailed, false);
    assert.ok(result.distribution.every((r) => r.verdict === "unknown" && r.error === "HTTP 500"));
  });

  test("verification failure leaves the run successful — the settle helper itself blowing up", async () => {
    const result = await verifyReelPublication([brand()], {
      settle: async () => { throw new Error("timer exploded"); },
      now: () => NOW,
    });
    assert.equal(result.verification.anyFailed, false);
    assert.equal(result.verification.counts.unknown, 3);
    assert.equal(result.records.length, 0);
  });

  test("a malformed response is unknown rather than an exception", async () => {
    for (const bad of [null, undefined, {}, { providers: null }, { providers: [null] }]) {
      const result = await run([brand()], async () => bad);
      assert.equal(result.verification.anyFailed, false);
      assert.equal(result.verification.counts.unknown, 3);
    }
  });

  test("an observed provider failure IS reported — that is the point of checking", async () => {
    // Metricool spells the reason `detailedStatus`; verifyPostStatus passes it
    // through untouched, so the row must carry Metricool's own words.
    const result = await run([brand()], async () => ({
      providers: [
        { network: "instagram", status: "PUBLISHED" },
        { network: "tiktok", status: "ERROR", detailedStatus: "video too long" },
        { network: "youtube", status: "PUBLISHED" },
      ],
    }));
    assert.equal(result.verification.anyFailed, true);
    assert.equal(result.distribution.find((r) => r.network === "tiktok").failureReason, "video too long");
  });

  test("nothing to verify does not sleep, does not call the API, and claims nothing", async () => {
    let calls = 0;
    let slept = 0;
    const result = await verifyReelPublication([brand({ ok: false })], {
      waitMs: 99_999,
      sleepFn: async (ms) => { slept += ms; },
      verify: async () => { calls++; return { providers: [] }; },
    });
    assert.equal(calls, 0);
    assert.equal(slept, 0, "must not burn the wait when there is nothing to verify");
    assert.equal(result.verification, null, "no check ran, so there is no verdict to record");
    assert.deepEqual(result.distribution, []);
  });

  test("polls the stragglers, so a slow publish is not recorded as pending", async () => {
    let call = 0;
    const result = await run([brand({ providers: ["tiktok"] })], async () => {
      call++;
      return { providers: [provider("tiktok", call < 2 ? "PENDING" : "PUBLISHED")] };
    }, { pollIntervalMs: 0 });
    assert.ok(call >= 2, "a single early check would have recorded a healthy post as pending");
    assert.equal(result.verification.allVerified, true);
  });
});

// ─── Writing it onto the log entry ───────────────────────────────────────────

describe("applyReelVerification — adds evidence, moves nothing", () => {
  const entry = () => ({
    driveFileId: "1abc",
    fileName: "atx-tour.mp4",
    city: "austin",
    slot: "pm",
    timestamp: TS,
    platforms: ["tiktok", "youtube", "satellite_ig"],
    brands: "propertypete01",
    success: true,
  });

  const verified = {
    distribution: [{ label: "propertypete01", network: "tiktok", postId: 1, ok: true, verdict: "published" }],
    verification: { checkedAt: TS, allVerified: true, anyFailed: false, pendingRecheck: false, counts: {}, results: [] },
  };

  test("nothing the duplicate guards read is touched", () => {
    // hasRecentPost keys off city, slot, timestamp, type and success. A
    // verification pass that could move any of those could move a slot, and a
    // moved slot is a double-post.
    const before = entry();
    const after = applyReelVerification(before, verified);
    for (const key of ["driveFileId", "fileName", "city", "slot", "timestamp", "success", "brands"]) {
      assert.deepEqual(after[key], before[key], `${key} must be untouched`);
    }
    assert.deepEqual(after.platforms, before.platforms, "the intent literal is left exactly as recordPost wrote it");
  });

  test("records the rows and the summary", () => {
    const after = applyReelVerification(entry(), verified);
    assert.equal(after.distribution.length, 1);
    assert.equal(after.verification.allVerified, true);
  });

  test("pure — the caller's entry is not mutated", () => {
    const before = entry();
    applyReelVerification(before, verified);
    assert.equal(before.distribution, undefined);
    assert.equal(before.verification, undefined);
  });

  test("a pass that verified nothing writes nothing", () => {
    const before = entry();
    assert.deepEqual(applyReelVerification(before, { verification: null, distribution: [] }), before);
    assert.deepEqual(applyReelVerification(before, undefined), before);
  });

  test("junk in, junk back, no throw", () => {
    assert.equal(applyReelVerification(null, verified), null);
  });
});

describe("findReelEntryIndex — stamps this run's reel and nothing else", () => {
  const posts = [
    { city: "austin", timestamp: "2026-08-10T00:00:00Z" },
    { city: "dallas", timestamp: "2026-08-11T01:00:00Z" },
    { city: "austin", timestamp: "2026-08-11T02:00:00Z" },
    { type: "linkedin", city: "austin", timestamp: "2026-08-11T03:00:00Z" },
    { city: "austin", platform: "instagram_main_native", timestamp: "2026-08-11T04:00:00Z" },
    { type: "trial_variant", city: "austin", timestamp: "2026-08-11T05:00:00Z" },
  ];

  test("finds the most recent reel for the city", () => {
    assert.equal(findReelEntryIndex(posts, "austin"), 2);
  });

  test("never a LinkedIn post, a trial variant or a manual-confirm receipt", () => {
    // Stamping a manual-confirm receipt with reel verdicts would invent an
    // Instagram publication the satellites never made.
    const idx = findReelEntryIndex(posts, "austin");
    assert.equal(posts[idx].type, undefined);
    assert.equal(posts[idx].platform, undefined);
  });

  test("-1 when this city has no reel entry, so main.js writes nothing", () => {
    assert.equal(findReelEntryIndex(posts, "san_antonio"), -1);
    assert.equal(findReelEntryIndex([], "austin"), -1);
    assert.equal(findReelEntryIndex(undefined, "austin"), -1);
  });

  test("a null element in the log does not throw", () => {
    assert.equal(findReelEntryIndex([null, "junk", { city: "austin" }], "austin"), 2);
  });
});

// ─── The verdicts reaching the dashboard ─────────────────────────────────────

describe("verdicts flow through to telemetry events", () => {
  const reel = (rows) => applyReelVerification(
    {
      timestamp: TS, city: "austin", fileName: "atx-tour.mp4", success: true,
      platforms: ["tiktok", "youtube", "satellite_ig"], brands: "propertypete01",
      mainIgDelivery: "delivered",
    },
    {
      distribution: rows,
      verification: summariseVerification(rows, [], { checkedAt: TS }),
    }
  );

  const row = (network, verdict, over = {}) => ({
    label: "propertypete01", blogId: 1, postId: 4242, network, ok: true, verdict, ...over,
  });

  test("a published reel finally produces PUBLISHED events — the whole point of the wiring", () => {
    const events = eventsFromPostedEntry(reel([
      row("instagram", "published"), row("tiktok", "published"), row("youtube", "published"),
    ]));
    assert.equal(events.length, 3);
    assert.ok(events.every((e) => e.type === "published"));
    assert.deepEqual(events.map((e) => e.platform).sort(), ["instagram", "tiktok", "youtube_shorts"]);
    assert.ok(events.every((e) => e.title_or_slug === "atx-tour.mp4"));
  });

  test("and buildStats counts them as real publications", () => {
    const stats = buildStats(
      eventsFromPostedEntry(reel([row("tiktok", "published"), row("youtube", "published")])),
      { date: "2026-08-11", lastRunIso: isoZ(NOW) }
    );
    assert.deepEqual(stats.posts_published_today, { tiktok: 1, youtube_shorts: 1 });
    assert.equal(stats.posts_scheduled, 0, "a confirmed publication is not also a scheduled post");
  });

  test("the verdict rows REPLACE the hardcoded platforms literal, never double count", () => {
    // `platforms` is written whenever the run reaches that line. Counting it
    // alongside a verdict would report one publication twice — once as
    // scheduled, once as published.
    const events = eventsFromPostedEntry(reel([row("tiktok", "published")]));
    assert.equal(events.length, 1);
    assert.equal(events[0].platform, "tiktok");
  });

  test("pending and unknown stay SCHEDULED — accepted is all we know", () => {
    const pending = eventsFromPostedEntry(reel([row("tiktok", "pending")]));
    assert.equal(pending[0].type, "scheduled");
    const unknown = eventsFromPostedEntry(reel([row("youtube", "unknown", { error: "HTTP 500" })]));
    assert.equal(unknown[0].type, "scheduled");
    assert.deepEqual(
      buildStats(unknown, { date: "2026-08-11", lastRunIso: isoZ(NOW) }).posts_published_today,
      {},
      "an unreadable status must not zero a platform — that would claim we checked"
    );
  });

  test("a failed network is counted as failed, carrying Metricool's own reason", () => {
    const events = eventsFromPostedEntry(reel([
      row("instagram", "published"),
      row("tiktok", "failed", { failureReason: "The 'image/png' type is not allowed" }),
    ]));
    const failed = events.find((e) => e.type === "failed");
    assert.equal(failed.platform, "tiktok");
    assert.match(failed.detail, /image\/png/);
    const stats = buildStats(events, { date: "2026-08-11", lastRunIso: isoZ(NOW) });
    assert.deepEqual(stats.posts_published_today, { instagram: 1, tiktok: 0 }, "a settled failure makes 0 a counted zero");
    assert.equal(stats.failures, 1);
  });

  test("two brands publishing to the same platform stay two publications", () => {
    const events = eventsFromPostedEntry(reel([
      row("instagram", "published", { label: "propertypete01" }),
      row("instagram", "published", { label: "lifestyledesignrealtyaustintx", postId: 99 }),
    ]));
    assert.equal(events.length, 2);
    assert.match(events[0].detail, /propertypete01/);
  });

  test("an unverified reel is unchanged — it still reports scheduled, never published", () => {
    // Entries written before this wiring, and runs whose verification never got
    // to look, carry no rows. `brands` is then the only evidence there is.
    const events = eventsFromPostedEntry({
      timestamp: TS, city: "austin", fileName: "atx-tour.mp4", success: true,
      platforms: ["tiktok", "youtube", "satellite_ig"], brands: "propertypete01",
    });
    assert.equal(events.length, 3);
    assert.ok(events.every((e) => e.type === "scheduled"));
  });

  test("a failed main-IG delivery still surfaces on a verified entry", () => {
    const events = eventsFromPostedEntry(applyReelVerification(
      {
        timestamp: TS, city: "austin", fileName: "atx-tour.mp4", success: true,
        platforms: ["tiktok"], brands: "propertypete01",
        mainIgDelivery: "delivery_failed_owner_must_post",
      },
      { distribution: [row("tiktok", "published")], verification: { checkedAt: TS } }
    ));
    const failures = events.filter((e) => e.type === "failed");
    assert.equal(failures.length, 1);
    assert.equal(failures[0].platform, "instagram");
  });
});

// ─── No code path re-posts ───────────────────────────────────────────────────

describe("no code path re-posts", () => {
  const verifySrc = readFileSync(join(ROOT, "src", "reel-verify.js"), "utf-8");
  const mainSrc = readFileSync(join(ROOT, "src", "main.js"), "utf-8");

  test("reel-verify.js cannot reach anything that publishes", () => {
    for (const forbidden of ["createPost", "uploadVideoToMetricool", "uploadToBrand", "recordPost", "deliverToOwner", "saveLog", "fetch"]) {
      assert.ok(!verifySrc.includes(`${forbidden}(`), `reel-verify.js must not call ${forbidden}`);
    }
  });

  test("its only import is the carousel's verifier, which only reads a status", () => {
    const imports = [...verifySrc.matchAll(/^import .* from "(.+)";$/gm)].map((m) => m[1]);
    assert.deepEqual(imports, ["./carousel-verify.js"]);
    const carouselSrc = readFileSync(join(ROOT, "src", "carousel-verify.js"), "utf-8");
    const carouselImports = [...carouselSrc.matchAll(/^import \{(.+)\} from "(.+)";$/gm)];
    assert.deepEqual(carouselImports.map((m) => m[2]), ["./metricool.js"]);
    assert.deepEqual(carouselImports.map((m) => m[1].trim()), ["verifyPostStatus"], "a GET, and nothing else");
  });

  test("main.js still has exactly ONE call that publishes a reel", () => {
    // The whole risk of this change is a second createPost appearing on the
    // verification side of the run.
    assert.equal((mainSrc.match(/await createPost\(/g) || []).length, 1);
  });

  test("verification only ever runs on brands the post ALREADY returned", () => {
    // postedBrands is populated from createPost's own results, so the check
    // cannot run before the post — and the guard means a run that posted nothing
    // never reaches the verifier at all.
    assert.ok(
      mainSrc.includes("if (posted && !DRY_RUN && !TEST_DELIVERY_ONLY && postedBrands.length > 0)"),
      "the verification block must stay guarded on a completed post"
    );
    const guardIdx = mainSrc.indexOf("if (posted && !DRY_RUN && !TEST_DELIVERY_ONLY && postedBrands.length > 0)");
    const verifyIdx = mainSrc.indexOf("await verifyReelPublication(postedBrands)");
    assert.ok(verifyIdx > guardIdx, "verification must sit inside that guard");
  });

  test("the unconfirmed branch does not exit — an unread status cannot fail a posted run", () => {
    const start = mainSrc.indexOf("if (verification?.pendingRecheck)");
    const end = mainSrc.indexOf("} else if (verification?.allVerified)");
    assert.ok(start > 0 && end > start, "main.js must handle pendingRecheck as its own branch");
    assert.ok(
      !mainSrc.slice(start, end).includes("process.exit"),
      "pending / unknown must never fail the run"
    );
  });

  test("the one remaining exit is an OBSERVED provider failure", () => {
    const start = mainSrc.indexOf("if (verification?.anyFailed)");
    const end = mainSrc.indexOf("if (verification?.pendingRecheck)");
    assert.ok(start > 0 && end > start);
    assert.ok(mainSrc.slice(start, end).includes("process.exit(1)"));
  });
});
