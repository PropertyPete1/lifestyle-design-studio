/**
 * Shorts cutdowns.
 *
 * The test that matters most is the one asserting a Short never comes from the
 * 16:9 master. Cutting 9:16 out of a letterboxed 1080p frame means a 607-pixel
 * slice of an already-downscaled picture, blown back up — and it would look
 * fine in code review and terrible on a phone.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  pickMoments,
  cutArgs,
  shortCaption,
  MIN_SECONDS,
  MAX_SECONDS,
  SHORTS_PER_VIDEO,
  VERTICAL,
} from "../src/yt-shorts.js";

const PLAN = {
  segments: [
    { kind: "on_camera", takeId: "s1t1", section: "Hook", seconds: 20, text: "Everyone quotes you the price. Nobody quotes the number that decides it.", source: "/rec/s1t1.mov" },
    { kind: "voiceover", takeId: "s1t2", section: "Hook", seconds: 30, text: "The sticker price is the smallest part.", broll: ["/broll/a.mp4", "/broll/b.mp4"] },
    { kind: "on_camera", takeId: "s2t1", section: "Neighbourhoods", seconds: 25, text: "North of town you get newer construction.", source: "/rec/s2t1.mov" },
    { kind: "voiceover", takeId: "s2t2", section: "Neighbourhoods", seconds: 40, text: "South of town you get more house.", broll: ["/broll/c.mp4"] },
    { kind: "on_camera", takeId: "close", section: "Close", seconds: 22, text: "Text me and I'll run your numbers.", source: "/rec/close.mov" },
  ],
};

describe("pickMoments", () => {
  test("cuts the requested number", () => {
    assert.equal(pickMoments(PLAN).length, SHORTS_PER_VIDEO);
  });

  test("the hook is always the first pick — it was written to stop a scroll", () => {
    assert.equal(pickMoments(PLAN)[0].takeId, "s1t1");
  });

  test("prefers on-camera moments over B-roll — a face beats a drone shot", () => {
    const moments = pickMoments(PLAN);
    const onCamera = moments.filter((m) => m.kind === "on_camera");
    assert.ok(onCamera.length >= 2, `only ${onCamera.length} on-camera moments picked`);
  });

  test("records where each moment starts in the finished video", () => {
    const moments = pickMoments(PLAN);
    assert.equal(moments[0].startsAt, 0);
    assert.ok(moments.every((m) => typeof m.startsAt === "number"));
  });

  test("NEVER points at the 16:9 master — the source is the original clip", () => {
    for (const m of pickMoments(PLAN)) {
      assert.ok(m.source, `${m.takeId} has no source`);
      assert.ok(
        m.source.startsWith("/rec/") || m.source.startsWith("/broll/"),
        `${m.takeId} sources from "${m.source}" — a Short must come from the portrait original`
      );
    }
  });

  test("no two Shorts share a segment", () => {
    const used = pickMoments(PLAN).flatMap((m) => m.parts);
    assert.equal(new Set(used).size, used.length);
  });

  test("pads a too-short moment from the next segment rather than shipping a stub", () => {
    const shortPlan = {
      segments: [
        { kind: "on_camera", takeId: "a", section: "Hook", seconds: 6, text: "one", source: "/rec/a.mov" },
        { kind: "on_camera", takeId: "b", section: "Hook", seconds: 14, text: "two", source: "/rec/b.mov" },
        { kind: "on_camera", takeId: "c", section: "Two", seconds: 30, text: "three", source: "/rec/c.mov" },
      ],
    };
    const moments = pickMoments(shortPlan, { count: 1 });
    assert.equal(moments.length, 1);
    assert.ok(moments[0].seconds >= MIN_SECONDS);
    assert.equal(moments[0].parts.length, 2, "should have absorbed the next segment");
    assert.ok(moments[0].text.includes("one") && moments[0].text.includes("two"));
  });

  test("caps a long moment rather than cutting a five-minute 'Short'", () => {
    const longPlan = {
      segments: [{ kind: "on_camera", takeId: "a", section: "Hook", seconds: 300, text: "x", source: "/rec/a.mov" }],
    };
    assert.equal(pickMoments(longPlan, { count: 1 })[0].seconds, MAX_SECONDS);
  });

  test("drops a moment that cannot reach the minimum", () => {
    const tiny = { segments: [{ kind: "on_camera", takeId: "a", section: "H", seconds: 4, text: "x", source: "/rec/a.mov" }] };
    assert.deepEqual(pickMoments(tiny, { count: 3 }), []);
  });

  test("returns fewer than three rather than padding with junk", () => {
    const twoOnly = {
      segments: [
        { kind: "on_camera", takeId: "a", section: "H", seconds: 20, text: "x", source: "/rec/a.mov" },
        { kind: "on_camera", takeId: "b", section: "T", seconds: 20, text: "y", source: "/rec/b.mov" },
      ],
    };
    assert.equal(pickMoments(twoOnly).length, 2);
  });

  test("an empty plan yields nothing rather than throwing", () => {
    assert.deepEqual(pickMoments({ segments: [] }), []);
    assert.deepEqual(pickMoments(null), []);
  });
});

describe("cutArgs", () => {
  const args = cutArgs("/rec/s1t1.mov", "/out/short.mp4", { seconds: 22 });
  const joined = args.join(" ");

  test("targets the 1080x1920 vertical canvas", () => {
    assert.equal(VERTICAL.w, 1080);
    assert.equal(VERTICAL.h, 1920);
    assert.ok(joined.includes("1080:1920"));
  });

  test("SCALES AND PADS rather than cropping — the subject must not be sliced out", () => {
    assert.ok(joined.includes("force_original_aspect_ratio=decrease"));
    assert.ok(joined.includes("pad=1080:1920"));
    assert.ok(!joined.includes("crop="), "cropping would cut Peter out of frame on a landscape source");
  });

  test("cuts to the requested length", () => {
    assert.equal(args[args.indexOf("-t") + 1], "22");
  });

  test("pins the same audio format the long-form segments use", () => {
    assert.ok(joined.includes("-ar 48000"));
    assert.ok(joined.includes("-ac 2"));
  });

  test("seeks before the input so the cut is fast", () => {
    const seeked = cutArgs("/a.mov", "/b.mp4", { startAt: 30, seconds: 20 });
    assert.ok(seeked.indexOf("-ss") < seeked.indexOf("-i"));
  });

  test("omits the seek when starting at zero", () => {
    assert.ok(!cutArgs("/a.mov", "/b.mp4", { startAt: 0, seconds: 20 }).includes("-ss"));
  });

  test("writes a streamable file", () => {
    assert.ok(joined.includes("-movflags +faststart"));
  });
});

describe("shortCaption", () => {
  const short = { text: "Everyone quotes you the price. Nobody quotes the number that decides it.", takeId: "s1t1" };

  test("opens on the moment's own first line", () => {
    const c = shortCaption(short, { videoTitle: "Moving to San Antonio" });
    assert.ok(c.startsWith("Everyone quotes you the price."));
  });

  test("points at the long-form video rather than re-explaining it", () => {
    const c = shortCaption(short, { videoTitle: "Moving to San Antonio" });
    assert.ok(c.includes("Moving to San Antonio"));
  });

  test("carries the comment keyword", () => {
    assert.ok(shortCaption(short, { videoTitle: "t", keyword: "MATH" }).includes("MATH"));
  });

  test("falls back to the title when the moment has no text", () => {
    assert.ok(shortCaption({ text: "" }, { videoTitle: "Austin vs San Antonio" }).includes("Austin vs San Antonio"));
  });
});
