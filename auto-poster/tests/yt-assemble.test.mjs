/**
 * Assembly.
 *
 * A bad ffmpeg flag does not throw — it produces a video that is subtly wrong
 * and you find out twelve minutes into watching it. So the argument builders
 * are pure and tested here, rather than discovered in a render.
 *
 * The filter graphs themselves were measured on a real runner in Phase 0; these
 * tests exist to stop them drifting.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeArgs,
  muxNarrationArgs,
  concatArgs,
  duckArgs,
  burnArgs,
  buildCaptionChunks,
  buildAssFile,
  assTimestamp,
  canvasFor,
  segmentAudioArgs,
  CANVAS,
} from "../src/yt-assemble.js";

const DIM = CANVAS["1080p"];
const joined = (args) => args.join(" ");

describe("canvasFor", () => {
  test("knows both resolutions and defaults safely", () => {
    assert.deepEqual(canvasFor("1080p"), { w: 1920, h: 1080 });
    assert.deepEqual(canvasFor("4k"), { w: 3840, h: 2160 });
    assert.deepEqual(canvasFor("720p"), { w: 1920, h: 1080 }, "an unknown resolution must not produce a broken canvas");
  });
});

describe("normalizeArgs — portrait 4K onto a 16:9 canvas", () => {
  const args = normalizeArgs("/in.mp4", "/out.mp4", DIM, { seconds: 6 });

  test("scales to fit and pillarboxes rather than stretching", () => {
    const vf = args[args.indexOf("-vf") + 1];
    assert.ok(vf.includes("force_original_aspect_ratio=decrease"), "must not stretch");
    assert.ok(vf.includes("pad=1920:1080"), "must pillarbox to the canvas");
  });

  test("pins fps and SAR — mismatched SAR makes concat stretch a segment silently", () => {
    const vf = args[args.indexOf("-vf") + 1];
    assert.ok(vf.includes("fps=30"));
    assert.ok(vf.includes("setsar=1"));
  });

  test("cuts to the requested length", () => {
    assert.equal(args[args.indexOf("-t") + 1], "6");
  });

  test("drops source audio — narration is muxed separately", () => {
    assert.ok(args.includes("-an"));
  });

  test("-t comes AFTER -i so it cuts the output, not the input seek", () => {
    assert.ok(args.indexOf("-t") > args.indexOf("-i"));
  });

  test("loops a clip shorter than its slot rather than leaving a gap", () => {
    const a = normalizeArgs("/in.mp4", "/out.mp4", DIM, { seconds: 6, loop: true });
    assert.ok(a.includes("-stream_loop"));
    assert.ok(a.indexOf("-stream_loop") < a.indexOf("-i"), "-stream_loop must precede the input");
  });

  test("omits -t when no length is asked for", () => {
    assert.ok(!normalizeArgs("/in.mp4", "/out.mp4", DIM).includes("-t"));
  });

  test("renders at the 4K canvas when asked", () => {
    const vf = normalizeArgs("/in.mp4", "/out.mp4", CANVAS["4k"], {})[
      normalizeArgs("/in.mp4", "/out.mp4", CANVAS["4k"], {}).indexOf("-vf") + 1
    ];
    assert.ok(vf.includes("3840:2160"));
  });
});

describe("muxNarrationArgs", () => {
  const args = muxNarrationArgs("/v.mp4", "/a.mp3", "/out.mp4");

  test("takes video from the first input and audio from the second", () => {
    assert.ok(joined(args).includes("-map 0:v -map 1:a"));
  });

  test("copies the video rather than re-encoding it again", () => {
    assert.ok(joined(args).includes("-c:v copy"));
  });

  test("keeps -shortest so a narration overrun cannot freeze the last frame", () => {
    assert.ok(args.includes("-shortest"));
  });
});

describe("concatArgs", () => {
  test("uses the concat demuxer with a stream copy", () => {
    const s = joined(concatArgs("/list.txt", "/out.mp4"));
    assert.ok(s.includes("-f concat"));
    assert.ok(s.includes("-safe 0"));
    assert.ok(s.includes("-c copy"), "segments share a codec and canvas, so this must not re-encode");
  });
});

describe("duckArgs — the bed moves under the voice", () => {
  const args = duckArgs("/v.mp4", "/music.mp3", "/out.mp4");
  const graph = args[args.indexOf("-filter_complex") + 1];

  test("keys the compressor off the narration itself", () => {
    assert.ok(graph.includes("sidechaincompress"), "a static low volume sounds like a mistake");
    assert.ok(graph.includes("[bed][vo1]sidechaincompress"), "the bed must be the compressed input");
  });

  test("splits the narration so it is both the key and the output", () => {
    assert.ok(graph.includes("asplit=2[vo1][vo2]"));
    assert.ok(graph.includes("[vo2][ducked]amix"));
  });

  test("copies the video — ducking is an audio-only stage", () => {
    assert.ok(joined(args).includes("-c:v copy"));
  });

  test("ends on the video's length, not the music's", () => {
    assert.ok(graph.includes("duration=first"));
  });

  test("writes a streamable file", () => {
    assert.ok(joined(args).includes("-movflags +faststart"));
  });
});

describe("burnArgs", () => {
  const args = burnArgs("/v.mp4", "/c.ass", "/out.mp4");

  test("burns the ass track", () => {
    assert.equal(args[args.indexOf("-vf") + 1], "ass=/c.ass");
  });

  test("copies the audio — this stage is a video re-encode only", () => {
    assert.ok(joined(args).includes("-c:a copy"));
  });
});

describe("buildCaptionChunks", () => {
  const plan = {
    segments: [
      { kind: "on_camera", seconds: 10, text: "one two three four five six seven eight" },
      { kind: "voiceover", seconds: 20, text: "nine ten eleven twelve" },
    ],
  };

  test("chunks four words at a time", () => {
    const chunks = buildCaptionChunks(plan);
    assert.equal(chunks[0].text, "one two three four");
    assert.equal(chunks[1].text, "five six seven eight");
  });

  test("chunks run in order and never overlap", () => {
    const chunks = buildCaptionChunks(plan);
    for (let i = 1; i < chunks.length; i++) {
      assert.ok(chunks[i].start >= chunks[i - 1].end - 0.01, `chunk ${i} overlaps the one before it`);
    }
  });

  test("timings stay inside each segment's own window", () => {
    const chunks = buildCaptionChunks(plan);
    assert.equal(chunks[0].start, 0);
    const firstSegChunks = chunks.filter((c) => c.end <= 10.01);
    assert.equal(firstSegChunks.length, 2, "the 10s segment holds both of its chunks");
    assert.ok(chunks[2].start >= 9.99, "the second segment starts where the first ended");
  });

  test("captions span the whole runtime", () => {
    const chunks = buildCaptionChunks(plan);
    assert.ok(Math.abs(chunks[chunks.length - 1].end - 30) < 0.01);
  });

  test("a segment with no text contributes no captions but still advances the clock", () => {
    const chunks = buildCaptionChunks({
      segments: [
        { seconds: 5, text: "" },
        { seconds: 5, text: "after the gap" },
      ],
    });
    assert.equal(chunks[0].start, 5);
  });

  test("an empty plan yields no chunks rather than throwing", () => {
    assert.deepEqual(buildCaptionChunks({ segments: [] }), []);
    assert.deepEqual(buildCaptionChunks({}), []);
  });
});

describe("assTimestamp", () => {
  test("formats H:MM:SS.cc", () => {
    assert.equal(assTimestamp(0), "0:00:00.00");
    assert.equal(assTimestamp(65.5), "0:01:05.50");
    assert.equal(assTimestamp(3725.25), "1:02:05.25");
  });

  test("never emits 100 centiseconds, which would be an invalid stamp", () => {
    assert.ok(!assTimestamp(1.999).endsWith(".100"));
    assert.ok(/\.\d{2}$/.test(assTimestamp(1.999)));
  });

  test("clamps negatives", () => {
    assert.equal(assTimestamp(-3), "0:00:00.00");
  });
});

describe("buildAssFile", () => {
  const file = buildAssFile([{ start: 0, end: 2, text: "hello there" }], DIM);

  test("declares the canvas so captions scale with the video", () => {
    assert.ok(file.includes("PlayResX: 1920"));
    assert.ok(file.includes("PlayResY: 1080"));
  });

  test("writes one Dialogue line per chunk", () => {
    assert.equal((file.match(/^Dialogue:/gm) || []).length, 1);
    assert.ok(file.includes("hello there"));
  });

  test("STRIPS braces — a stray one swallows the rest of the caption", () => {
    const risky = buildAssFile([{ start: 0, end: 1, text: "cost {roughly} 300k" }], DIM);
    assert.ok(!risky.includes("{roughly}"));
    assert.ok(risky.includes("cost roughly 300k"));
  });

  test("newlines become ASS line breaks rather than breaking the format", () => {
    const multi = buildAssFile([{ start: 0, end: 1, text: "line one\nline two" }], DIM);
    assert.ok(multi.includes("line one\\Nline two"));
    assert.equal((multi.match(/^Dialogue:/gm) || []).length, 1);
  });

  test("font size scales with the canvas", () => {
    const hd = buildAssFile([{ start: 0, end: 1, text: "x" }], CANVAS["1080p"]);
    const uhd = buildAssFile([{ start: 0, end: 1, text: "x" }], CANVAS["4k"]);
    const size = (f) => Number(f.match(/Style: Default,Arial,(\d+)/)[1]);
    assert.ok(size(uhd) > size(hd), "4K captions must not render half-size");
  });
});

describe("segment audio must be uniform — concat lies about mismatches", () => {
  // Verified locally: concatenating a mono 44.1kHz segment with a stereo 48kHz
  // one with `-c copy` produces NO error and NO warning. It declares the first
  // segment's format for the whole file and a 4.0s timeline comes out 4.38s.
  // Peter's phone and ElevenLabs disagree by default, and the timeline
  // alternates between them, so without this the drift compounds all video.
  test("every segment pins the same sample rate and channel count", () => {
    const s = segmentAudioArgs().join(" ");
    assert.ok(s.includes("-ar 48000"), "sample rate must be pinned");
    assert.ok(s.includes("-ac 2"), "channel count must be pinned");
  });

  test("the on-camera branch and the narration branch use the SAME flags", () => {
    // If these ever diverge, concat starts reinterpreting one of them.
    const mux = muxNarrationArgs("/v.mp4", "/a.mp3", "/o.mp4").join(" ");
    for (const flag of segmentAudioArgs().join(" ").split(" -").slice(1)) {
      assert.ok(mux.includes(`-${flag}`), `narration mux is missing -${flag}`);
    }
  });

  test("the pinned rate and channels are what YouTube wants for a 16:9 upload", () => {
    assert.ok(segmentAudioArgs().includes("48000"));
    assert.ok(segmentAudioArgs().includes("2"));
  });
});
