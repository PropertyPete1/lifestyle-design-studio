/**
 * Planning the timeline.
 *
 * The rules worth defending: a clip never repeats inside one video, an
 * on-camera take with no recording is reported rather than papered over, and a
 * thin B-roll library is visible instead of quietly producing a video made of
 * the same six shots.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  planTimeline,
  allocateBroll,
  orderedTakes,
  buildChapters,
  formatTimestamp,
  estimateSpeechSeconds,
  BROLL_SEGMENT_SECONDS,
  MIN_SEGMENT_SECONDS,
} from "../src/yt-timeline.js";
import { ON_CAMERA, VOICEOVER } from "../src/yt-script.js";

function words(n) {
  return Array.from({ length: n }, () => "word").join(" ");
}

const SCRIPT = {
  title: "Moving to San Antonio",
  sections: [
    {
      title: "The payment gap",
      takes: [
        { id: "s1t1", mode: ON_CAMERA, text: words(50) },
        { id: "s1t2", mode: VOICEOVER, text: words(75) },
      ],
    },
    {
      title: "Neighbourhoods",
      takes: [
        { id: "s2t1", mode: VOICEOVER, text: words(75) },
        { id: "s2t2", mode: ON_CAMERA, text: words(40) },
      ],
    },
    {
      title: "What I'd do",
      takes: [{ id: "s3t1", mode: VOICEOVER, text: words(50) }],
    },
  ],
  softCta: { mode: ON_CAMERA, text: words(30) },
  close: { mode: ON_CAMERA, text: words(45) },
};

function pool(n, durationSeconds = 20) {
  return Array.from({ length: n }, (_, i) => ({
    id: `v${i}`,
    name: `clip${i}.mp4`,
    durationSeconds,
    contentHash: `h${i}`,
  }));
}

function recordings(ids) {
  return Object.fromEntries(ids.map((id) => [id, { path: `/tmp/${id}.mov`, durationSeconds: 20 }]));
}

const ALL_ON_CAMERA = ["s1t1", "s2t2", "cta", "close"];

describe("estimateSpeechSeconds", () => {
  test("uses the same read rate as the script engine and the kit", () => {
    assert.equal(estimateSpeechSeconds(words(75)), 30);
    assert.equal(estimateSpeechSeconds(""), 0);
  });
});

describe("orderedTakes", () => {
  test("runs in viewer order with the CTA and close last", () => {
    const ids = orderedTakes(SCRIPT).map((t) => t.id);
    assert.deepEqual(ids, ["s1t1", "s1t2", "s2t1", "s2t2", "s3t1", "cta", "close"]);
  });

  test("carries the section title onto each take", () => {
    assert.equal(orderedTakes(SCRIPT)[1].section, "The payment gap");
  });

  test("tolerates a script with nothing in it", () => {
    assert.deepEqual(orderedTakes({}), []);
    assert.deepEqual(orderedTakes(null), []);
  });
});

describe("allocateBroll", () => {
  test("cuts a long narration into several shots rather than holding one", () => {
    const { segments } = allocateBroll(30, pool(10), { usedInVideo: new Set() });
    assert.ok(segments.length >= 5, `30s should be several shots, got ${segments.length}`);
    assert.ok(segments.every((s) => s.seconds <= BROLL_SEGMENT_SECONDS));
  });

  test("covers the requested duration", () => {
    const { segments, shortfall } = allocateBroll(24, pool(10), { usedInVideo: new Set() });
    const total = segments.reduce((n, s) => n + s.seconds, 0);
    assert.equal(shortfall, 0);
    assert.ok(Math.abs(total - 24) < 0.01, `covered ${total}s of 24s`);
  });

  test("NEVER repeats a clip inside one video", () => {
    const used = new Set();
    const a = allocateBroll(30, pool(20), { usedInVideo: used });
    const b = allocateBroll(30, pool(20), { usedInVideo: used });
    const ids = [...a.segments, ...b.segments].map((s) => s.driveFileId);
    assert.equal(new Set(ids).size, ids.length, "a clip appeared twice in one video");
  });

  test("prefers footage not spent on recent videos", () => {
    const usedRecently = new Set(["h0", "h1", "h2"]);
    const { segments } = allocateBroll(12, pool(10), { usedInVideo: new Set(), usedRecently });
    assert.ok(segments.every((s) => !s.reused), "should have reached for fresh footage first");
    assert.ok(!segments.some((s) => ["v0", "v1", "v2"].includes(s.driveFileId)));
  });

  test("falls back to recently-used footage rather than leaving a gap, and flags it", () => {
    const usedRecently = new Set(pool(4).map((c) => c.contentHash));
    const { segments, shortfall } = allocateBroll(12, pool(4), { usedInVideo: new Set(), usedRecently });
    assert.equal(shortfall, 0);
    assert.ok(segments.some((s) => s.reused), "reuse must be visible, not silent");
  });

  test("reports exhaustion when the library simply runs out", () => {
    const { exhausted, shortfall } = allocateBroll(120, pool(2, 5), { usedInVideo: new Set() });
    assert.equal(exhausted, true);
    assert.ok(shortfall >= 0);
  });

  test("never asks a clip for more than it has", () => {
    const { segments } = allocateBroll(30, pool(10, 3), { usedInVideo: new Set() });
    assert.ok(segments.every((s) => s.seconds <= 3.01), "a 3s clip cannot supply 6s");
  });

  test("pads the last shot rather than cutting a stub nobody reads as intentional", () => {
    const { segments, shortfall } = allocateBroll(13, pool(10), { usedInVideo: new Set() });
    assert.equal(shortfall, 0);
    const last = segments[segments.length - 1];
    assert.ok(last.seconds >= MIN_SEGMENT_SECONDS);
  });

  test("asking for nothing yields nothing", () => {
    assert.deepEqual(allocateBroll(0, pool(5), { usedInVideo: new Set() }).segments, []);
  });
});

describe("planTimeline", () => {
  test("lays every take down in order", () => {
    const plan = planTimeline(SCRIPT, recordings(ALL_ON_CAMERA), pool(30));
    assert.deepEqual(
      plan.segments.map((s) => s.takeId),
      ["s1t1", "s1t2", "s2t1", "s2t2", "s3t1", "cta", "close"]
    );
    assert.equal(plan.missingTakes.length, 0);
  });

  test("on-camera segments play Peter's own recording", () => {
    const plan = planTimeline(SCRIPT, recordings(ALL_ON_CAMERA), pool(30));
    const onCam = plan.segments.filter((s) => s.kind === "on_camera");
    assert.equal(onCam.length, 4);
    assert.ok(onCam.every((s) => s.source.endsWith(".mov")));
  });

  test("voiceover segments carry B-roll and no recording of Peter", () => {
    const plan = planTimeline(SCRIPT, recordings(ALL_ON_CAMERA), pool(30));
    const vo = plan.segments.filter((s) => s.kind === "voiceover");
    assert.equal(vo.length, 3);
    assert.ok(vo.every((s) => s.broll.length > 0));
    assert.ok(vo.every((s) => s.narrationSource === null), "narration is generated, not recorded");
  });

  test("REPORTS an on-camera take with no recording — there is no substitute for it", () => {
    const partial = recordings(["s1t1", "cta", "close"]); // s2t2 never shot
    const plan = planTimeline(SCRIPT, partial, pool(30));
    assert.equal(plan.missingTakes.length, 1);
    assert.equal(plan.missingTakes[0].takeId, "s2t2");
    assert.ok(!plan.segments.some((s) => s.takeId === "s2t2"), "must not fabricate the segment");
  });

  test("uses Peter's own narration when he recorded it", () => {
    const withVo = { ...recordings(ALL_ON_CAMERA), ...recordings(["s1t2"]) };
    const plan = planTimeline(SCRIPT, withVo, pool(30));
    const seg = plan.segments.find((s) => s.takeId === "s1t2");
    assert.equal(seg.narrationSource, "/tmp/s1t2.mov");
  });

  test("no clip appears twice across the whole video", () => {
    const plan = planTimeline(SCRIPT, recordings(ALL_ON_CAMERA), pool(40));
    const ids = plan.segments.flatMap((s) => (s.broll || []).map((b) => b.driveFileId));
    assert.equal(new Set(ids).size, ids.length);
  });

  test("flags a library too thin to carry the video", () => {
    const plan = planTimeline(SCRIPT, recordings(ALL_ON_CAMERA), pool(2, 4));
    assert.equal(plan.brollExhausted, true);
  });

  test("reports the on-camera share so the ~30% budget can be checked", () => {
    const plan = planTimeline(SCRIPT, recordings(ALL_ON_CAMERA), pool(40));
    assert.ok(plan.stats.onCameraShare > 0 && plan.stats.onCameraShare < 1);
    assert.equal(plan.stats.takeCount, 7);
  });

  test("an empty script plans nothing rather than throwing", () => {
    const plan = planTimeline({}, {}, pool(5));
    assert.deepEqual(plan.segments, []);
    assert.equal(plan.totalSeconds, 0);
  });

  test("accepts a Map of recordings as well as an object", () => {
    const map = new Map(Object.entries(recordings(ALL_ON_CAMERA)));
    assert.equal(planTimeline(SCRIPT, map, pool(30)).missingTakes.length, 0);
  });
});

describe("buildChapters", () => {
  test("one marker per section, first one forced to zero", () => {
    const plan = planTimeline(SCRIPT, recordings(ALL_ON_CAMERA), pool(40));
    const chapters = buildChapters(plan, SCRIPT);
    assert.ok(chapters.length >= 3);
    assert.equal(chapters[0].seconds, 0);
    assert.equal(chapters[0].timestamp, "0:00");
    assert.equal(chapters[0].title, "The payment gap");
  });

  test("markers advance through the video", () => {
    const chapters = buildChapters(planTimeline(SCRIPT, recordings(ALL_ON_CAMERA), pool(40)), SCRIPT);
    for (let i = 1; i < chapters.length; i++) {
      assert.ok(chapters[i].seconds > chapters[i - 1].seconds, "chapters must move forward");
    }
  });

  test("returns NOTHING under three markers — a partial list disables chapters entirely", () => {
    const thin = { sections: [{ title: "Only one", takes: [{ id: "a", mode: VOICEOVER, text: words(50) }] }] };
    assert.deepEqual(buildChapters(planTimeline(thin, {}, pool(10)), thin), []);
  });
});

describe("formatTimestamp", () => {
  test("m:ss under an hour, h:mm:ss over", () => {
    assert.equal(formatTimestamp(0), "0:00");
    assert.equal(formatTimestamp(65), "1:05");
    assert.equal(formatTimestamp(725), "12:05");
    assert.equal(formatTimestamp(3725), "1:02:05");
  });

  test("never produces a negative or fractional stamp", () => {
    assert.equal(formatTimestamp(-5), "0:00");
    assert.equal(formatTimestamp(65.9), "1:05");
  });
});
