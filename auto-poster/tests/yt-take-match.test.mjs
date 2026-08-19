/**
 * Matching Peter's recordings to the script's takes.
 *
 * The tests that matter are the messy ones: he records out of order, ad-libs,
 * shoots the same line three times, forgets one, and leaves a false start in
 * the folder. Every one of those is normal, and none of them may produce a
 * silently wrong timeline.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTokens,
  lcsLength,
  similarity,
  matchTakesToClips,
  describeMatchResult,
} from "../src/yt-take-match.js";

const TAKES = [
  {
    id: "s1t1",
    mode: "ON_CAMERA",
    section: "The payment gap",
    text: "Everyone quotes you the price of the house. Nobody quotes you the number that actually decides whether you can afford it, and in this county that number is brutal.",
  },
  {
    id: "s1t2",
    mode: "VOICEOVER",
    section: "The payment gap",
    text: "The sticker price is the smallest part of what you pay every month. Taxes and insurance do most of the damage out here, and almost nobody tells you that up front.",
  },
  {
    id: "s2t1",
    mode: "VOICEOVER",
    section: "Neighbourhoods",
    text: "North of town you get newer construction and bigger lots. South of town you get more house for the money but a longer drive into the city every morning.",
  },
];

/** What Whisper typically returns: right words, wrong punctuation, a slip or two. */
function transcribed(take, { extra = "", drop = 0 } = {}) {
  const words = take.text.replace(/[.,]/g, "").split(" ");
  const kept = drop ? words.slice(0, words.length - drop) : words;
  return `${kept.join(" ").toLowerCase()}${extra ? ` ${extra}` : ""}`;
}

function clip(id, transcript, recordedAt, name = `${id}.mov`) {
  return { id, name, transcript, recordedAt };
}

describe("normalizeTokens", () => {
  test("strips punctuation and case but keeps order", () => {
    assert.deepEqual(normalizeTokens("Here's the price, right?"), ["heres", "the", "price", "right"]);
  });

  test("collapses bare numbers so Whisper's formatting cannot cause a mismatch", () => {
    // "439000" and "2400" are written a dozen different ways by Whisper; what
    // matters for matching is that a number was said, not which glyphs it used.
    assert.deepEqual(normalizeTokens("about 439000 or so"), ["about", "#num", "or", "so"]);
  });

  test("tolerates non-strings", () => {
    assert.deepEqual(normalizeTokens(null), []);
    assert.deepEqual(normalizeTokens(42), []);
  });
});

describe("lcsLength", () => {
  test("identical sequences", () => {
    assert.equal(lcsLength(["a", "b", "c"], ["a", "b", "c"]), 3);
  });

  test("order matters — that is the whole point of using LCS", () => {
    assert.equal(lcsLength(["a", "b", "c"], ["c", "b", "a"]), 1);
  });

  test("tolerates insertions", () => {
    assert.equal(lcsLength(["a", "b", "c"], ["a", "x", "b", "y", "c"]), 3);
  });

  test("empty input", () => {
    assert.equal(lcsLength([], ["a"]), 0);
  });
});

describe("similarity", () => {
  test("a clean read scores near the top", () => {
    const s = similarity(TAKES[0].text, transcribed(TAKES[0]));
    assert.ok(s.recall > 0.95, `recall was ${s.recall}`);
    assert.ok(s.f1 > 0.95, `f1 was ${s.f1}`);
  });

  test("an ad-lib keeps recall high even as precision drops", () => {
    const s = similarity(TAKES[0].text, transcribed(TAKES[0], { extra: "and honestly i see this every single week with buyers moving down from up north" }));
    assert.ok(s.recall > 0.9, `recall was ${s.recall}`);
    assert.ok(s.precision < s.recall, "precision should absorb the ad-lib, not recall");
  });

  test("two different takes do NOT look alike, despite sharing filler words", () => {
    const s = similarity(TAKES[0].text, transcribed(TAKES[2]));
    assert.ok(s.recall < 0.5, `unrelated takes scored recall ${s.recall} — separation is too weak`);
  });
});

describe("matchTakesToClips", () => {
  test("matches a complete, in-order recording session", () => {
    const clips = [
      clip("c1", transcribed(TAKES[0]), "2026-08-12T15:00:00Z"),
      clip("c2", transcribed(TAKES[1]), "2026-08-12T15:05:00Z"),
      clip("c3", transcribed(TAKES[2]), "2026-08-12T15:10:00Z"),
    ];
    const r = matchTakesToClips(TAKES, clips);
    assert.equal(r.complete, true);
    assert.equal(r.matches.length, 3);
    assert.equal(r.matches.find((m) => m.takeId === "s1t1").clipId, "c1");
    assert.equal(r.strayClips.length, 0);
  });

  test("ORDER-INDEPENDENT — he recorded them backwards", () => {
    const clips = [
      clip("c1", transcribed(TAKES[2]), "2026-08-12T15:00:00Z"),
      clip("c2", transcribed(TAKES[1]), "2026-08-12T15:05:00Z"),
      clip("c3", transcribed(TAKES[0]), "2026-08-12T15:10:00Z"),
    ];
    const r = matchTakesToClips(TAKES, clips);
    assert.equal(r.complete, true);
    assert.equal(r.matches.find((m) => m.takeId === "s2t1").clipId, "c1");
    assert.equal(r.matches.find((m) => m.takeId === "s1t1").clipId, "c3");
  });

  test("RETAKES — the last recording wins, and the earlier ones are recorded as superseded", () => {
    const clips = [
      clip("first", transcribed(TAKES[0]), "2026-08-12T15:00:00Z"),
      clip("second", transcribed(TAKES[0], { extra: "sorry let me do that again" }), "2026-08-12T15:02:00Z"),
      clip("third", transcribed(TAKES[0]), "2026-08-12T15:04:00Z"),
    ];
    const r = matchTakesToClips(TAKES, clips);
    const m = r.matches.find((x) => x.takeId === "s1t1");
    assert.equal(m.clipId, "third");
    assert.deepEqual(m.supersededClipIds.sort(), ["first", "second"]);
  });

  test("a retake wins even when an earlier take matched the written words more literally", () => {
    // The fluffed later take is the keeper — that is what retake means.
    const clips = [
      clip("perfect-but-early", transcribed(TAKES[0]), "2026-08-12T15:00:00Z"),
      clip("looser-but-late", transcribed(TAKES[0], { drop: 3, extra: "you know what i mean" }), "2026-08-12T15:30:00Z"),
    ];
    const r = matchTakesToClips(TAKES, clips);
    assert.equal(r.matches.find((x) => x.takeId === "s1t1").clipId, "looser-but-late");
  });

  test("REPORTS a missing take instead of assigning something approximate", () => {
    const clips = [
      clip("c1", transcribed(TAKES[0]), "2026-08-12T15:00:00Z"),
      clip("c3", transcribed(TAKES[2]), "2026-08-12T15:10:00Z"),
    ];
    const r = matchTakesToClips(TAKES, clips);
    assert.equal(r.complete, false);
    assert.equal(r.missingTakes.length, 1);
    assert.equal(r.missingTakes[0].takeId, "s1t2");
    // and it must not have stolen either of the real matches
    assert.equal(r.matches.length, 2);
  });

  test("REPORTS a stray clip rather than forcing it onto the nearest take", () => {
    const clips = [
      clip("c1", transcribed(TAKES[0]), "2026-08-12T15:00:00Z"),
      clip("c2", transcribed(TAKES[1]), "2026-08-12T15:02:00Z"),
      clip("c3", transcribed(TAKES[2]), "2026-08-12T15:04:00Z"),
      clip("oops", "hang on is this thing even recording right now", "2026-08-12T15:06:00Z"),
    ];
    const r = matchTakesToClips(TAKES, clips);
    assert.equal(r.complete, true);
    assert.equal(r.strayClips.length, 1);
    assert.equal(r.strayClips[0].clipId, "oops");
    assert.ok(r.strayClips[0].closest, "a stray should still report what it came closest to");
  });

  test("one clip cannot be claimed by two takes", () => {
    const clips = [clip("only", transcribed(TAKES[0]), "2026-08-12T15:00:00Z")];
    const r = matchTakesToClips(TAKES, clips);
    const claimed = r.matches.map((m) => m.clipId);
    assert.equal(claimed.length, 1);
    assert.equal(new Set(claimed).size, claimed.length);
  });

  test("flags a match that drifted, without rejecting it", () => {
    const clips = [
      clip("drifty", transcribed(TAKES[0], { drop: 10, extra: "roughly speaking anyway" }), "2026-08-12T15:00:00Z"),
    ];
    const r = matchTakesToClips(TAKES, clips);
    const m = r.matches.find((x) => x.takeId === "s1t1");
    assert.ok(m, "a drifted read should still match");
    assert.ok(r.lowConfidence.some((x) => x.takeId === "s1t1"), "and it should be flagged for review");
  });

  test("an empty folder reports every take as missing, and does not throw", () => {
    const r = matchTakesToClips(TAKES, []);
    assert.equal(r.complete, false);
    assert.equal(r.missingTakes.length, 3);
    assert.equal(r.matches.length, 0);
  });

  test("tolerates junk input", () => {
    const r = matchTakesToClips([null, { id: "x" }, ...TAKES], [null, { id: "y" }, { transcript: "" }]);
    assert.equal(r.missingTakes.length, 3);
  });

  test("clips with no timestamp still resolve deterministically", () => {
    const clips = [
      clip("a", transcribed(TAKES[0]), null),
      clip("b", transcribed(TAKES[0], { drop: 5 }), null),
    ];
    const r = matchTakesToClips(TAKES, clips);
    // No recordedAt to order by, so the better match is kept.
    assert.equal(r.matches.find((x) => x.takeId === "s1t1").clipId, "a");
  });
});

describe("describeMatchResult — Peter has to be able to act on this", () => {
  test("a complete session says so in one line", () => {
    const clips = TAKES.map((t, i) => clip(`c${i}`, transcribed(t), `2026-08-12T15:0${i}:00Z`));
    const text = describeMatchResult(matchTakesToClips(TAKES, clips));
    assert.ok(text.includes("All 3 takes matched"));
  });

  test("a missing take is named, quoted, and told where to go", () => {
    const clips = [clip("c1", transcribed(TAKES[0]), "2026-08-12T15:00:00Z")];
    const text = describeMatchResult(matchTakesToClips(TAKES, clips), { requestId: "req-1" });
    assert.ok(text.includes("STILL NEEDED"));
    assert.ok(text.includes("s1t2"));
    assert.ok(text.includes("upload them to the same folder"));
    assert.ok(text.includes("req-1"));
  });

  test("retakes and strays are surfaced, not hidden", () => {
    const clips = [
      clip("c1", transcribed(TAKES[0]), "2026-08-12T15:00:00Z"),
      clip("c1b", transcribed(TAKES[0]), "2026-08-12T15:01:00Z"),
      clip("c2", transcribed(TAKES[1]), "2026-08-12T15:02:00Z"),
      clip("c3", transcribed(TAKES[2]), "2026-08-12T15:03:00Z"),
      clip("junk", "okay so where did i park", "2026-08-12T15:04:00Z"),
    ];
    const text = describeMatchResult(matchTakesToClips(TAKES, clips));
    assert.ok(text.includes("shot more than once"));
    assert.ok(text.includes("UNUSED CLIPS"));
  });
});

describe("optional takes — the thumbnail take must never hold a build hostage", async () => {
  const { THUMBNAIL_TAKE } = await import("../src/yt-recording-kit.js");
  const withThumb = [...TAKES, THUMBNAIL_TAKE];

  test("an unrecorded optional take is ABSENT, not missing — the build stays complete", () => {
    const clips = TAKES.map((t, i) => clip(`c${i}`, transcribed(t), `2026-08-12T15:0${i}:00Z`));
    const r = matchTakesToClips(withThumb, clips);
    assert.equal(r.complete, true, "video 1's kit predates the take and must still build");
    assert.ok(!r.missingTakes.some((m) => m.takeId === "thumbnail"));
  });

  test("a recorded thumbnail take matches on its spoken slate", () => {
    const clips = [
      ...TAKES.map((t, i) => clip(`c${i}`, transcribed(t), `2026-08-12T15:0${i}:00Z`)),
      clip("thumb-clip", "thumbnail take", "2026-08-12T15:30:00Z"),
    ];
    const r = matchTakesToClips(withThumb, clips);
    assert.equal(r.complete, true);
    assert.equal(r.matches.find((m) => m.takeId === "thumbnail")?.clipId, "thumb-clip");
    assert.equal(r.strayClips.length, 0);
  });

  test("whisper hallucination on the silent stretch does not lose the slate", () => {
    // Whisper reliably invents "Thank you." over silence; the expressions are
    // silent by design, so the transcript is the slate plus invented filler.
    const clips = [clip("thumb-clip", "thumbnail take thank you thank you", "2026-08-12T15:30:00Z")];
    const r = matchTakesToClips(withThumb, clips);
    assert.equal(r.matches.find((m) => m.takeId === "thumbnail")?.clipId, "thumb-clip");
  });

  test("a long script clip can never be stolen by the two-token thumbnail take", () => {
    // Even a script that literally contains the words "thumbnail ... take" in
    // order: recall against the 2-token take is 1.0, but precision over a
    // 30-word transcript is tiny and the F1 floor rejects the claim.
    const trap = clip(
      "trap",
      "here is the thumbnail everyone sees and the take nobody records " + transcribed(TAKES[0]),
      "2026-08-12T15:00:00Z"
    );
    const r = matchTakesToClips(withThumb, [trap]);
    assert.equal(r.matches.find((m) => m.takeId === "thumbnail"), undefined, "the F1 floor must reject the theft");
    assert.equal(r.matches.find((m) => m.takeId === "s1t1")?.clipId, "trap");
  });

  test("a MANDATORY take that is missing still blocks, exactly as before", () => {
    const clips = [clip("thumb-clip", "thumbnail take", "2026-08-12T15:30:00Z")];
    const r = matchTakesToClips(withThumb, clips);
    assert.equal(r.complete, false);
    assert.equal(r.missingTakes.length, TAKES.length);
  });
});
