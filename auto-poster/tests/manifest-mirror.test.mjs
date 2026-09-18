/**
 * The manifest reaching the analyser: the Drive mirror, and the flagship join.
 *
 * Every fixture here is the real shape, taken from live data on 2026-09-18:
 * a manual_confirm receipt as the dashboard writes it, a publish entry as
 * recordPost writes it, and flagship analytics rows as Metricool returns them.
 * The two shapes that matter most are the ones that are NOT obvious:
 *
 *   - a receipt's driveFileId is the DELIVERED COPY, not the source video
 *   - analytics exposes a post's caption as `slug`, which is its first line
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  MATCH_WINDOW_HOURS,
  captionKey,
  deliveryIndex,
  parseStamp,
  receiptsWithPublish,
  resolveFlagshipPosts,
  attachFlagship,
} from "../src/manifest-flagship.js";
import {
  MIRROR_FILENAME,
  DEFAULT_MANIFEST_FOLDER_ID,
  PHASH_MAX_DISTANCE,
  buildMirror,
  buildFullMirror,
  inferredMatches,
  summariseUnresolved,
  mirrorToDrive,
} from "../src/manifest-mirror.js";

// ─── real shapes ────────────────────────────────────────────────────────────

const SOURCE_ID = "1wjBAg5vWBpAv0jfFDNfpln4a7pL44qlS";
const DELIVERED_ID = "14CiWJ8AYXcKWfUiGcb9OBJpzAj-6QFsA";
const CAPTION = "POV: you just walked into brand new construction that actually feels like home.\n\nNew construction like this moves fast in San Antonio.";

/** As recordPost writes it. */
const publish = (over = {}) => ({
  driveFileId: SOURCE_ID,
  fileName: "A.mp4",
  city: "san_antonio",
  caption: CAPTION,
  timestamp: "2026-09-18T16:16:05.685Z",
  success: true,
  platforms: ["tiktok", "youtube", "satellite_ig"],
  deliveryDriveLink: `https://drive.google.com/file/d/${DELIVERED_ID}/view`,
  generation: { engine: "variation-v1" },
  ...over,
});

/** As the dashboard writes it when Peter confirms the hand-post. */
const receipt = (over = {}) => ({
  city: "san_antonio",
  timestamp: "2026-09-18T17:14:09.677Z",
  success: true,
  platform: "instagram_main_native",
  source: "manual_confirm",
  driveFileId: DELIVERED_ID,
  captionSnippet: CAPTION.slice(0, 120),
  mainIgPostedAt: "2026-09-18T17:14:09.677Z",
  note: "Main IG post confirmed via manual confirm",
  ...over,
});

/** As Metricool's analytics returns a flagship post. */
const igPost = (over = {}) => ({
  platform: "instagram",
  account: "lifestyledesignrealtytexas",
  post_id: "17934073971384470",
  published: "2026-09-18T17:15:00Z",
  slug: CAPTION.split("\n")[0],
  url: "https://www.instagram.com/reel/Ddb18gIm82n/",
  ...over,
});

const manifestRow = (over = {}) => ({
  schema_version: 1,
  posted_at: "2026-09-18T16:16:05.700Z",
  drive_file_id: SOURCE_ID,
  market: "san_antonio",
  caption: CAPTION,
  targets: [{ label: "propertypete01", blog_id: 6486247, networks: ["instagram"] }],
  reel_urls: [{ network: "instagram", label: "propertypete01", url: "https://www.instagram.com/reel/X/", verified: true }],
  ...over,
});

const resolveOne = (posts, igPosts) => resolveFlagshipPosts({ posts, igPosts });

// ─── 1. the receipt carries the DELIVERED id ────────────────────────────────

describe("a receipt names the delivered copy, never the source video", () => {
  test("THE JOIN THAT LOOKS EMPTY: matching a receipt on drive_file_id finds nothing", () => {
    // This is what a naive implementation does, and it returns zero rather than
    // something wrong — which is why it could sit there unnoticed.
    const r = receipt();
    assert.notEqual(r.driveFileId, SOURCE_ID);
    assert.equal(manifestRow().drive_file_id, SOURCE_ID);
  });

  test("the delivery link is the bridge, and it is exact string equality", () => {
    const idx = deliveryIndex([publish()]);
    assert.equal(idx.get(DELIVERED_ID)?.driveFileId, SOURCE_ID);
  });

  test("receiptsWithPublish takes the source id from the PUBLISH, not the receipt", () => {
    const [r] = receiptsWithPublish([publish(), receipt()]);
    assert.equal(r.driveFileId, SOURCE_ID);
    assert.equal(r.receipt.driveFileId, DELIVERED_ID);
  });

  test("a receipt with no matching publish is reported, not silently dropped", () => {
    const { unresolved } = resolveOne([receipt({ driveFileId: "unknown-copy" })], [igPost()]);
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0].code, "no_publish_for_receipt");
  });

  test("link shapes with a query or fragment still yield the id", () => {
    const idx = deliveryIndex([publish({ deliveryDriveLink: `https://drive.google.com/file/d/${DELIVERED_ID}/view?usp=drivesdk#x` })]);
    assert.ok(idx.has(DELIVERED_ID));
  });

  test("publishes with no delivery link do not poison the index", () => {
    assert.equal(deliveryIndex([publish({ deliveryDriveLink: null }), publish()]).size, 1);
  });
});

// ─── 2. resolving the flagship post ─────────────────────────────────────────

describe("resolving a flagship post id", () => {
  test("one post opens with this caption: resolved, method 'caption', high confidence", () => {
    const { resolved } = resolveOne([publish(), receipt()], [igPost(), igPost({ post_id: "999", slug: "something else entirely here" })]);
    const hit = resolved.get(SOURCE_ID);
    assert.equal(hit.ig_post_id, "17934073971384470");
    assert.equal(hit.method, "caption");
    assert.equal(hit.confidence, "high");
    assert.equal(hit.url, "https://www.instagram.com/reel/Ddb18gIm82n/");
  });

  test("THE TEMPLATE PROBLEM, INSIDE THE JOIN: repeated captions are broken by the clock", () => {
    // Four flagship posts open with "POV: you just walked into your first brand
    // new home…" in the real window. Only the one near the confirmation is ours.
    const old = igPost({ post_id: "old-1", published: "2026-09-01T16:00:00Z" });
    const older = igPost({ post_id: "old-2", published: "2026-08-20T16:00:00Z" });
    const { resolved } = resolveOne([publish(), receipt()], [old, older, igPost()]);
    const hit = resolved.get(SOURCE_ID);
    assert.equal(hit.ig_post_id, "17934073971384470");
    assert.equal(hit.method, "caption+time");
    assert.equal(hit.confidence, "medium", "a tie broken by the clock is weaker evidence and says so");
  });

  test("…and when the clock cannot single one out either, it refuses", () => {
    const twin = igPost({ post_id: "twin", published: "2026-09-18T17:20:00Z" });
    const { resolved, unresolved } = resolveOne([publish(), receipt()], [igPost(), twin]);
    assert.equal(resolved.size, 0);
    assert.equal(unresolved[0].code, "ambiguous");
    assert.match(unresolved[0].why, /2 flagship posts share this caption opening and 2 are within 6h/);
  });

  test("no post opens with this caption: refused with a reason, never a nearest guess", () => {
    const { resolved, unresolved } = resolveOne([publish(), receipt()], [igPost({ slug: "a completely different opening line here" })]);
    assert.equal(resolved.size, 0);
    assert.equal(unresolved[0].code, "no_caption_match");
  });

  test("ONE POST BELONGS TO ONE VIDEO: a contested post is taken from BOTH claimants", () => {
    // The real collision: two receipts resolved to post 17934073971384470.
    // Keeping the first would credit one video with another's numbers.
    const other = publish({ driveFileId: "OTHER_SOURCE", deliveryDriveLink: "https://drive.google.com/file/d/OTHER_COPY/view", timestamp: "2026-09-18T15:00:00Z" });
    const otherReceipt = receipt({ driveFileId: "OTHER_COPY", timestamp: "2026-09-18T17:16:00.000Z", mainIgPostedAt: "2026-09-18T17:16:00.000Z" });
    const { resolved, unresolved } = resolveOne([publish(), receipt(), other, otherReceipt], [igPost()]);
    assert.equal(resolved.size, 0, "neither video keeps the contested post");
    assert.deepEqual([...new Set(unresolved.map((u) => u.code))], ["contested"]);
  });

  test("a third claimant on an already-contested post is refused too, not granted it", () => {
    const mk = (n) => [
      publish({ driveFileId: `S${n}`, deliveryDriveLink: `https://drive.google.com/file/d/C${n}/view` }),
      receipt({ driveFileId: `C${n}`, mainIgPostedAt: `2026-09-18T17:1${n}:00.000Z` }),
    ];
    const posts = [...mk(1), ...mk(2), ...mk(3)];
    const { resolved } = resolveOne(posts, [igPost()]);
    assert.equal(resolved.size, 0);
  });

  test("a caption prefix shorter than the identifying minimum never matches", () => {
    const { resolved } = resolveOne([publish({ caption: "new home" }), receipt({ captionSnippet: "new home" })], [igPost({ slug: "new home" })]);
    assert.equal(resolved.size, 0, "a few words are not an identification");
  });

  test("typographic drift between the caption and the platform does not break it", () => {
    const smart = "POV: you just walked into brand new construction that actually feels like home.";
    const { resolved } = resolveOne([publish(), receipt()], [igPost({ slug: smart.replace(/'/g, "’") })]);
    assert.equal(resolved.size, 1);
  });

  test("with no flagship posts to examine, everything is unresolved — never invented", () => {
    const { resolved, unresolved } = resolveOne([publish(), receipt()], []);
    assert.equal(resolved.size, 0);
    assert.equal(unresolved.length, 1);
  });

  test("a publish with NO receipt yields no flagship id at all", () => {
    const { resolved, unresolved } = resolveOne([publish()], [igPost()]);
    assert.equal(resolved.size, 0);
    assert.equal(unresolved.length, 0, "nothing was claimed, so there is nothing to explain");
  });
});

describe("timestamps mean the same thing on every machine", () => {
  test("a bare local stamp is read as UTC, so CI and a laptop agree", () => {
    // Metricool's reels endpoint returns { dateTime, timezone } with no offset.
    assert.equal(parseStamp({ dateTime: "2026-09-14T18:27:04", timezone: "Europe/Madrid" }), Date.parse("2026-09-14T18:27:04Z"));
    assert.equal(parseStamp("2026-09-14T18:27:04"), Date.parse("2026-09-14T18:27:04Z"));
  });

  test("an explicit offset is honoured, not overridden", () => {
    assert.equal(parseStamp("2026-09-17T19:45:37Z"), Date.parse("2026-09-17T19:45:37Z"));
    assert.equal(parseStamp("2026-09-17T14:45:37-05:00"), Date.parse("2026-09-17T19:45:37Z"));
  });

  test("junk is NaN rather than 1970", () => {
    for (const v of [null, undefined, "", {}, "not a date"]) assert.ok(Number.isNaN(parseStamp(v)), String(v));
  });

  test("the window is the documented six hours", () => {
    assert.equal(MATCH_WINDOW_HOURS, 6);
  });
});

describe("captionKey is the post's first line, folded", () => {
  test("it takes the first non-empty line and lowercases it", () => {
    assert.equal(captionKey("  \n\nHello There\nsecond line"), "hello there");
  });
  test("empty in, empty out", () => {
    for (const v of [null, undefined, "", "   \n  "]) assert.equal(captionKey(v), "");
  });
});

// ─── 3. the mirror payload ──────────────────────────────────────────────────

describe("the mirror separates fact from inference", () => {
  const build = () =>
    buildFullMirror({
      manifest: { publishes: [manifestRow()] },
      posts: [publish(), receipt()],
      igPosts: [igPost()],
      videoMatches: { [SOURCE_ID]: [{ igPostId: "111", hashDistance: 0, matchMethod: "perceptual_hash" }] },
      now: new Date("2026-09-18T21:00:00Z"),
    });

  test("a resolved row carries the id, the method and the confidence together", () => {
    const m = build();
    assert.equal(m.publishes[0].flagship.ig_post_id, "17934073971384470");
    assert.equal(m.publishes[0].flagship.method, "caption");
    assert.equal(m.publishes[0].flagship.confidence, "high");
  });

  test("an unresolved row carries null AND a reason — the two must not read alike", () => {
    const m = buildMirror({ manifest: { publishes: [manifestRow()] }, posts: [], igPosts: [], now: new Date() });
    assert.equal(m.publishes[0].flagship.ig_post_id, null);
    assert.match(m.publishes[0].flagship.reason, /no flagship hand-post has been confirmed/);
  });

  test("the manifest rows are not mutated — the repo's own file is the record", () => {
    const rows = [manifestRow()];
    buildMirror({ manifest: { publishes: rows }, posts: [publish(), receipt()], igPosts: [igPost()] });
    assert.equal("flagship" in rows[0], false);
  });

  test("inference lives in its own array, never mixed into publishes[]", () => {
    const m = build();
    assert.equal(m.inferred_matches[0].ig_post_id, "111");
    assert.equal(m.inferred_matches[0].relationship, "same_footage_as_an_earlier_post");
    assert.ok(m.publishes.every((r) => !("hash_distance" in r)));
  });

  test("THE FILE EXPLAINS ITSELF — the reader is a model with no other context", () => {
    const m = build();
    assert.match(m.about, /publishes\[\] is a record of fact/);
    assert.match(m.about, /ONE inferred field/);
    assert.match(m.about, /inferred_matches\[\] is NOT fact/);
    assert.match(m.about, /Never treat a null as a match/);
    // The contest rule changes what a `contest` block and a medium confidence
    // MEAN, and the reader has no other way to learn it.
    assert.match(m.about, /A flagship post belongs to exactly one video/);
    assert.match(m.about, /the one whose hand-post confirmation is inside 6 hours of the post keeps it/);
    assert.match(m.about, /every claimant is refused instead/);
    assert.match(m.flagship_account.note, /never posts Instagram to the flagship/);
  });

  test("coverage counts are consistent with the rows", () => {
    const m = build();
    assert.equal(m.coverage.publishes, m.publishes.length);
    assert.equal(m.coverage.with_flagship_ig_post_id + m.coverage.without_flagship_ig_post_id, m.publishes.length);
    assert.equal(m.coverage.inferred_matches, m.inferred_matches.length);
    assert.equal(m.coverage.flagship_posts_examined, 1);
  });

  test("an empty manifest builds a valid, honest file rather than throwing", () => {
    const m = buildFullMirror({ manifest: { publishes: [] }, posts: [], igPosts: [], videoMatches: {} });
    assert.deepEqual(m.publishes, []);
    assert.equal(m.coverage.publishes, 0);
    assert.equal(m.coverage.earliest_publish, null);
  });

  test("the filename and folder are the ones the analyser is told to read", () => {
    assert.equal(MIRROR_FILENAME, "publish_manifest_latest.json");
    // The same folder the decision files live in ("Ready to Post"), read off
    // their parent on 2026-09-18.
    assert.equal(DEFAULT_MANIFEST_FOLDER_ID, "15qKuFpn-Kn8h7BfgvFWbTuzM3nDyDw3G");
  });

  test("ONE DEFINITION: the writer and the reader resolve to the same folder", async () => {
    // #146 and #147 were built off main in parallel and each carried its own
    // copy of this id. Two copies is two places for one fact to go stale, and
    // the failure is quiet on both sides: the reader searches a folder the
    // writer no longer writes to, finds nothing, and reports "no decision
    // file" — exactly what it reports when the task genuinely has not run.
    const { CONTENT_FOLDER_ID } = await import("../src/drive.js");
    const { DEFAULT_DECISION_FOLDER_ID } = await import("../src/drive-decision.js");
    assert.equal(DEFAULT_MANIFEST_FOLDER_ID, CONTENT_FOLDER_ID);
    assert.equal(DEFAULT_DECISION_FOLDER_ID, CONTENT_FOLDER_ID);
  });

  test("…and the id is written down exactly once in src/", () => {
    const srcDir = new URL("../src/", import.meta.url);
    const hits = readdirSync(srcDir)
      .filter((f) => f.endsWith(".js"))
      .filter((f) => readFileSync(new URL(f, srcDir), "utf-8").includes("15qKuFpn-Kn8h7BfgvFWbTuzM3nDyDw3G"));
    assert.deepEqual(hits, ["drive.js"], `the folder id is literal in more than one module: ${hits.join(", ")}`);
  });
});

describe("the perceptual-hash list keeps its distances and its bounds", () => {
  test("pairs above the false-positive threshold are dropped", () => {
    const out = inferredMatches({ A: [{ igPostId: "1", hashDistance: 0 }, { igPostId: "2", hashDistance: PHASH_MAX_DISTANCE + 1 }] });
    assert.deepEqual(out.map((x) => x.ig_post_id), ["1"]);
  });

  test("the BEST distance wins when a pair appears twice", () => {
    const out = inferredMatches({ A: [{ igPostId: "1", hashDistance: 7 }, { igPostId: "1", hashDistance: 2 }] });
    assert.equal(out.length, 1);
    assert.equal(out[0].hash_distance, 2);
  });

  test("distance is derived from confidence when the field is absent", () => {
    const out = inferredMatches({ A: [{ igPostId: "1", confidence: 1 }] });
    assert.equal(out[0].hash_distance, 0);
  });

  test("a pair with no distance at all is dropped — unlabelled inference is worse than none", () => {
    assert.deepEqual(inferredMatches({ A: [{ igPostId: "1" }] }), []);
  });

  test("closest first, so a reader taking the top N gets the best evidence", () => {
    const out = inferredMatches({ A: [{ igPostId: "1", hashDistance: 9 }], B: [{ igPostId: "2", hashDistance: 1 }] });
    assert.deepEqual(out.map((x) => x.hash_distance), [1, 9]);
  });

  test("malformed cache shapes are ignored rather than thrown on", () => {
    assert.deepEqual(inferredMatches({ A: null, B: "nope", C: [null, {}, { igPostId: "" }] }), []);
    assert.deepEqual(inferredMatches(null), []);
  });
});

describe("unresolved reasons are grouped, with their meanings", () => {
  test("counts by code, one example each, and a plain-English key", () => {
    const s = summariseUnresolved([
      { code: "ambiguous", why: "a", drive_file_id: "x" },
      { code: "ambiguous", why: "b", drive_file_id: "y" },
      { code: "contested", why: "c", drive_file_id: "z" },
    ]);
    assert.equal(s.total, 3);
    assert.deepEqual(s.by_code, { ambiguous: 2, contested: 1 });
    assert.equal(s.examples.length, 2);
    assert.match(s.meaning.ambiguous, /boilerplate caption problem/);
  });

  test("every code the resolver can emit has a meaning written for it", async () => {
    const src = readFileSync(new URL("../src/manifest-flagship.js", import.meta.url), "utf-8");
    const codes = [...src.matchAll(/code: "([a-z_]+)"/g)].map((m) => m[1]);
    assert.ok(codes.length >= 4);
    const { meaning } = summariseUnresolved([]);
    for (const c of new Set(codes)) assert.ok(meaning[c], `no meaning written for code "${c}"`);
  });
});

// ─── 4. writing it ──────────────────────────────────────────────────────────

describe("writing to Drive never costs a publish", () => {
  const args = { manifest: { publishes: [manifestRow()] }, posts: [publish(), receipt()], igPosts: [igPost()], videoMatches: {} };

  test("it upserts under the mirror filename in the content folder", async () => {
    const calls = [];
    const r = await mirrorToDrive({ ...args, upsert: async (folder, name, text) => { calls.push({ folder, name, text }); return { id: "drive-1", created: false }; } });
    assert.equal(r.ok, true);
    assert.equal(calls[0].folder, DEFAULT_MANIFEST_FOLDER_ID);
    assert.equal(calls[0].name, MIRROR_FILENAME);
    const written = JSON.parse(calls[0].text);
    assert.equal(written.publishes[0].flagship.ig_post_id, "17934073971384470");
  });

  test("A WRITE FAILURE IS REPORTED, NOT THROWN — the post has already gone out", async () => {
    const r = await mirrorToDrive({ ...args, upsert: async () => { throw new Error("403 insufficient scope"); } });
    assert.equal(r.ok, false);
    assert.match(r.reason, /403/);
  });

  test("a dry run writes nothing and still says what it would have written", async () => {
    let called = false;
    const r = await mirrorToDrive({ ...args, dryRun: true, upsert: async () => { called = true; return {}; } });
    assert.equal(called, false);
    assert.equal(r.dryRun, true);
    assert.equal(r.mirror.coverage.with_flagship_ig_post_id, 1);
  });

  test("the folder can be overridden without a deploy", async () => {
    const calls = [];
    await mirrorToDrive({ ...args, folderId: "OTHER_FOLDER", upsert: async (folder) => { calls.push(folder); return { id: "x" }; } });
    assert.equal(calls[0], "OTHER_FOLDER");
  });
});

describe("the posting run mirrors after a publish", () => {
  const main = readFileSync(new URL("../src/main.js", import.meta.url), "utf-8");

  test("main.js calls it with the live log and the flagship posts it already read", () => {
    assert.match(main, /^\s*await mirrorToDrive\(\{ posts: log\.posts, igPosts, dryRun: DRY_RUN \}\);$/m);
  });

  test("it runs AFTER the permalinks are attached, so the mirrored rows carry them", () => {
    // The CALL, not the import at the top of the file.
    assert.ok(main.indexOf("await mirrorToDrive(") > main.indexOf("recordPublishVerification(postedVideo.id"));
  });

  test("a standalone script exists for seeding and for days with no publish", () => {
    const script = readFileSync(new URL("../scripts/mirror-publish-manifest.mjs", import.meta.url), "utf-8");
    assert.match(script, /mirrorToDrive/);
    assert.match(script, /--dry-run/);
    assert.match(script, /getRecentIgPosts/);
  });
});

describe("a contest is settled by proximity when proximity says something", () => {
  // THE REAL CASE, 2026-09-16. A video was published at 19:12, its hand-post
  // was confirmed at 19:15, and the flagship post went up at 19:17 — two
  // minutes later. Two days on, a different video went out with a caption
  // opening on the same words (the template), its receipt matched the same
  // post, and under the original both-lose rule the 09-16 video lost an id
  // that was certainly its own.
  const POST_AT = "2026-09-16T19:17:00Z";
  const near = () => [
    publish({ driveFileId: "NEAR_SRC", deliveryDriveLink: "https://drive.google.com/file/d/NEAR_COPY/view", timestamp: "2026-09-16T19:12:00.000Z" }),
    receipt({ driveFileId: "NEAR_COPY", timestamp: "2026-09-16T19:15:00.000Z", mainIgPostedAt: "2026-09-16T19:15:00.000Z" }),
  ];
  const far = () => [
    publish({ driveFileId: "FAR_SRC", deliveryDriveLink: "https://drive.google.com/file/d/FAR_COPY/view", timestamp: "2026-09-18T16:16:00.000Z" }),
    receipt({ driveFileId: "FAR_COPY", timestamp: "2026-09-18T17:14:00.000Z", mainIgPostedAt: "2026-09-18T17:14:00.000Z" }),
  ];
  const onePost = [igPost({ post_id: "CONTESTED", published: POST_AT })];

  test("THE NEARER CONFIRMATION KEEPS IT — two minutes beats forty-six hours", () => {
    const { resolved } = resolveOne([...near(), ...far()], onePost);
    assert.equal(resolved.get("NEAR_SRC")?.ig_post_id, "CONTESTED");
    assert.equal(resolved.has("FAR_SRC"), false);
  });

  test("the order the receipts appear in does not decide it", () => {
    const { resolved } = resolveOne([...far(), ...near()], onePost);
    assert.equal(resolved.get("NEAR_SRC")?.ig_post_id, "CONTESTED");
    assert.equal(resolved.has("FAR_SRC"), false);
  });

  test("the winner SAYS it was contested, and names who else matched", () => {
    const hit = resolveOne([...near(), ...far()], onePost).resolved.get("NEAR_SRC");
    assert.equal(hit.contest.resolved_by, "proximity");
    assert.equal(hit.contest.hours_from_post, 0);
    assert.deepEqual(hit.contest.also_matched_by.map((o) => o.drive_file_id), ["FAR_SRC"]);
    assert.ok(hit.contest.also_matched_by[0].hours_from_post > 40);
  });

  test("a won post is MEDIUM confidence even when the caption matched uniquely", () => {
    const hit = resolveOne([...near(), ...far()], onePost).resolved.get("NEAR_SRC");
    assert.equal(hit.method, "caption");
    assert.equal(hit.confidence, "medium", "a post won from another claimant is weaker than one nobody else matched");
  });

  test("the loser's reason gives both distances, not a bare refusal", () => {
    const { unresolved } = resolveOne([...near(), ...far()], onePost);
    const loser = unresolved.find((u) => u.drive_file_id === "FAR_SRC");
    assert.equal(loser.code, "contested");
    assert.match(loser.why, /minute\(s\) from it by NEAR_SRC/);
    assert.match(loser.why, /hours from it by this one/);
    assert.match(loser.why, /the nearer confirmation keeps it/);
  });

  test("BOTH INSIDE THE WINDOW IS STILL A TIE — nobody gets it", () => {
    const alsoNear = [
      publish({ driveFileId: "NEAR2_SRC", deliveryDriveLink: "https://drive.google.com/file/d/NEAR2_COPY/view" }),
      receipt({ driveFileId: "NEAR2_COPY", timestamp: "2026-09-16T19:20:00.000Z", mainIgPostedAt: "2026-09-16T19:20:00.000Z" }),
    ];
    const { resolved, unresolved } = resolveOne([...near(), ...alsoNear], onePost);
    assert.equal(resolved.size, 0);
    assert.ok(unresolved.every((u) => u.code === "contested"));
    assert.match(unresolved[0].why, /2 are within 6h of it — all refused/);
  });

  test("NOBODY inside the window is also a tie — proximity must actually say something", () => {
    const farA = [
      publish({ driveFileId: "A_SRC", deliveryDriveLink: "https://drive.google.com/file/d/A_COPY/view" }),
      receipt({ driveFileId: "A_COPY", timestamp: "2026-09-10T00:00:00.000Z", mainIgPostedAt: "2026-09-10T00:00:00.000Z" }),
    ];
    const { resolved, unresolved } = resolveOne([...farA, ...far()], onePost);
    assert.equal(resolved.size, 0);
    assert.match(unresolved[0].why, /none is within 6h of it — all refused/);
  });

  test("an uncontested post is untouched: no contest block, confidence unchanged", () => {
    const hit = resolveOne(near(), onePost).resolved.get("NEAR_SRC");
    assert.equal(hit.confidence, "high");
    assert.equal("contest" in hit, false);
  });
});

describe("the reason under a row belongs to THAT publish", () => {
  // A Drive file may be published more than once — the 30-day no-repeat rule
  // permits it. On the live data a JULY receipt's "ambiguous" was being shown
  // against a SEPTEMBER publish of the same video.
  const SRC = "REPUBLISHED_SRC";
  const run = (rowPostedAt) =>
    attachFlagship([manifestRow({ drive_file_id: SRC, posted_at: rowPostedAt })], {
      resolved: new Map(),
      unresolved: [
        { drive_file_id: SRC, receipt_at: "2026-07-16T19:14:00.000Z", code: "ambiguous", why: "JULY REASON" },
        { drive_file_id: SRC, receipt_at: "2026-09-16T19:15:00.000Z", code: "contested", why: "SEPTEMBER REASON" },
      ],
    })[0].flagship.reason;

  test("a September publish gets the September receipt's reason", () => {
    assert.equal(run("2026-09-16T19:12:00.000Z"), "SEPTEMBER REASON");
  });

  test("…and a July publish of the same video gets July's", () => {
    assert.equal(run("2026-07-16T19:10:00.000Z"), "JULY REASON");
  });

  test("a row with no failures at all still says nothing has been confirmed", () => {
    const rows = attachFlagship([manifestRow()], { resolved: new Map(), unresolved: [] });
    assert.match(rows[0].flagship.reason, /no flagship hand-post has been confirmed/);
  });

  test("an undated reason is used when it is all there is, and loses to a dated one", () => {
    const only = attachFlagship([manifestRow({ drive_file_id: SRC })], {
      resolved: new Map(),
      unresolved: [{ drive_file_id: SRC, code: "contested", why: "UNDATED" }],
    })[0].flagship.reason;
    assert.equal(only, "UNDATED");
    const both = attachFlagship([manifestRow({ drive_file_id: SRC, posted_at: "2026-09-16T19:12:00.000Z" })], {
      resolved: new Map(),
      unresolved: [
        { drive_file_id: SRC, code: "contested", why: "UNDATED" },
        { drive_file_id: SRC, receipt_at: "2026-09-16T19:15:00.000Z", code: "contested", why: "DATED" },
      ],
    })[0].flagship.reason;
    assert.equal(both, "DATED");
  });

  test("EVERY unresolved entry carries the receipt that produced it", () => {
    // Without this the matching above silently degrades to "first one wins".
    const { unresolved } = resolveOne(
      [publish(), receipt(), publish({ driveFileId: "X", deliveryDriveLink: "https://drive.google.com/file/d/XC/view" }), receipt({ driveFileId: "XC" })],
      [igPost({ published: "2026-09-18T17:15:00Z" })]
    );
    assert.ok(unresolved.length > 0);
    for (const u of unresolved) assert.ok(u.receipt_at, `no receipt_at on a ${u.code} entry`);
  });
});
