/**
 * LDT intake-clip voiceover (ldt-voiceover.js).
 *
 * Everything here is hermetic: ffmpeg/ffprobe/tesseract are injected fakes
 * (the source-respect.js DI shape) and the "ElevenLabs" of these tests is a
 * recording stub — the suite proves the DECISIONS (script source, timing
 * fit, skip rules, fallback doctrine), not the binaries. The six contract
 * paths from the addendum each get a section: sidecar, OCR, timing fit,
 * existing-audio skip, "-novo" flag skip, and fail-toward-the-silent-clip.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasNoVoFlag,
  stripExtension,
  sidecarNameFor,
  findSidecarFile,
  parseSrtTime,
  parseScriptText,
  parseTesseractTsv,
  ocrSampleTimestamps,
  extractCaptionCues,
  untimedFit,
  timedPlacementPlan,
  fitLineTempo,
  buildUntimedMuxArgs,
  buildTimedMuxArgs,
  classifyExistingAudio,
  applyLdtVoiceover,
  SILENT_TRACK_MEAN_DB,
} from "../src/ldt-voiceover.js";
import { TEMPO_MAX } from "../src/voiceover-style.js";

// ─── Fakes ──────────────────────────────────────────────────────────────────

/**
 * One injectable `run` covering every probe the module makes. `durations` is
 * keyed by path substring so video, TTS lines and the muxed output can each
 * report their own length.
 */
function makeRun({ durations = {}, hasAudio = false, meanDb = null, dims = "1080x1920", tesseractOk = true } = {}) {
  return (cmd, args) => {
    const a = (args || []).join(" ");
    if (cmd === "tesseract" && a.includes("--version")) {
      return tesseractOk ? { status: 0, stdout: "tesseract 5.3.0" } : { status: 1, stderr: "not found" };
    }
    if (cmd === "ffprobe" && a.includes("codec_type")) {
      return { status: 0, stdout: hasAudio ? "audio\n" : "" };
    }
    if (cmd === "ffprobe" && a.includes("format=duration")) {
      const path = args[args.length - 1];
      const key = Object.keys(durations).find(k => path.includes(k));
      return { status: 0, stdout: key ? `${durations[key]}\n` : "" };
    }
    if (cmd === "ffprobe" && a.includes("width,height")) {
      // dims may be one string for every path, or per-path substrings
      // (the landscape test needs the INPUT landscape but the RENDER vertical).
      if (typeof dims === "string") return { status: 0, stdout: `${dims}\n` };
      const path = args[args.length - 1];
      const key = Object.keys(dims).find(k => path.includes(k));
      return { status: 0, stdout: key ? `${dims[key]}\n` : "" };
    }
    if (cmd === "ffmpeg" && a.includes("volumedetect")) {
      return { status: 0, stdout: "", stderr: meanDb === null ? "" : `[Parsed_volumedetect_0] mean_volume: ${meanDb} dB\n` };
    }
    return { status: 1, stderr: `unexpected probe: ${cmd} ${a}` };
  };
}

/** Recording TTS stub — returns fake mp3 paths whose durations makeRun serves. */
function makeTts(calls = []) {
  return async (script) => {
    calls.push(script);
    return `/fake/tts-${calls.length - 1}.mp3`;
  };
}

/** Recording mux stub — writes a plausible output file so self-QC can measure it. */
function makeExec(calls = []) {
  return (args) => {
    calls.push(args);
    writeFileSync(args[args.length - 1], Buffer.alloc(20000));
  };
}

/** OCR fakes: extract remembers which timestamp produced which png. */
function makeOcrFakes(framesByIndex) {
  const pngToIndex = new Map();
  let n = 0;
  const extract = (args) => {
    pngToIndex.set(args[args.length - 1], n++);
  };
  const ocr = (png) => framesByIndex[pngToIndex.get(png)] ?? null;
  return { extract, ocr };
}

function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "ldt-vo-test-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

// ─── Filename flag ──────────────────────────────────────────────────────────

describe("the -novo filename flag", () => {
  test("matches as a hyphenated token, case-insensitively", () => {
    assert.equal(hasNoVoFlag("demo-novo.mp4"), true);
    assert.equal(hasNoVoFlag("walkthrough-NOVO.mov"), true);
    assert.equal(hasNoVoFlag("demo-novo-v2.mp4"), true);
  });

  test("never trips on words merely containing 'novo' or on bare 'novo'", () => {
    assert.equal(hasNoVoFlag("renovation-tour.mp4"), false);
    assert.equal(hasNoVoFlag("novo.mp4"), false);
    assert.equal(hasNoVoFlag("casanovo-demo.mp4"), false);
  });

  test("the extension never hides the flag", () => {
    assert.equal(stripExtension("clip-novo.mp4"), "clip-novo");
    assert.equal(hasNoVoFlag("clip-novo.webm"), true);
  });
});

// ─── Sidecar lookup ─────────────────────────────────────────────────────────

describe("sidecar lookup", () => {
  test("same basename, .txt extension", () => {
    assert.equal(sidecarNameFor("Friday demo.mp4"), "Friday demo.txt");
  });

  test("finds the sidecar in the intake listing, case-insensitively", () => {
    const files = [
      { id: "v1", name: "clip-1.mp4" },
      { id: "s1", name: "Clip-1.TXT" },
      { id: "x", name: "other.txt" },
    ];
    assert.equal(findSidecarFile(files, "clip-1.mp4")?.id, "s1");
    assert.equal(findSidecarFile(files, "clip-2.mp4"), null);
  });
});

// ─── Script parsing ─────────────────────────────────────────────────────────

describe("parseScriptText", () => {
  test("plain text: every non-empty line kept in order, untimed", () => {
    const { timed, cues } = parseScriptText("Line one\n\nLine two\nLine three\n");
    assert.equal(timed, false);
    assert.deepEqual(cues.map(c => c.text), ["Line one", "Line two", "Line three"]);
  });

  test("a bare number in a plain script is a line, never an SRT index", () => {
    // Dropping an operator's line is the same sin as inventing one.
    const { cues } = parseScriptText("The price\n2500\nper month");
    assert.deepEqual(cues.map(c => c.text), ["The price", "2500", "per month"]);
  });

  test("SRT: cues timed by their start, index lines skipped, wrapped text joined", () => {
    const srt = "1\n00:00:01,500 --> 00:00:04,000\nFirst line\nstill first\n\n2\n00:00:06,000 --> 00:00:08,000\nSecond line\n";
    const { timed, cues } = parseScriptText(srt);
    assert.equal(timed, true);
    assert.deepEqual(cues, [
      { text: "First line still first", startSec: 1.5 },
      { text: "Second line", startSec: 6 },
    ]);
  });

  test("SRT-style with dot millis and no hours parses too", () => {
    const { timed, cues } = parseScriptText("00:02.250 --> 00:04.000\nHello\n");
    assert.equal(timed, true);
    assert.equal(cues[0].startSec, 2.25);
  });

  test("hand-typed timestamps WITHOUT milliseconds still count as timing, never as script", () => {
    // The failure this pins: '0:05 --> 0:08' failing the regex dropped the
    // file to plain mode and the timestamp lines were READ ALOUD by TTS.
    const { timed, cues } = parseScriptText("0:05 --> 0:08\nGrab their attention\n\n0:10 --> 0:14\nClose with the offer\n");
    assert.equal(timed, true);
    assert.deepEqual(cues, [
      { text: "Grab their attention", startSec: 5 },
      { text: "Close with the offer", startSec: 10 },
    ]);
  });

  test("parseSrtTime handles hours, optional millis, and rejects junk", () => {
    assert.equal(parseSrtTime("01:02:03,250"), 3723.25);
    assert.equal(parseSrtTime("00:05"), 5);
    assert.equal(parseSrtTime("nonsense"), null);
  });
});

describe("parseTesseractTsv", () => {
  test("groups words into visual lines and averages confidence", () => {
    const header = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext";
    const tsv = [
      header,
      "5\t1\t1\t1\t1\t1\t0\t0\t9\t9\t90\tHello",
      "5\t1\t1\t1\t1\t2\t0\t0\t9\t9\t80\tworld",
      "5\t1\t1\t1\t2\t1\t0\t0\t9\t9\t70\tsecond",
      "4\t1\t1\t1\t2\t0\t0\t0\t9\t9\t-1\t", // non-word row ignored
    ].join("\n");
    const { lines, meanConf } = parseTesseractTsv(tsv);
    assert.deepEqual(lines, ["Hello world", "second"]);
    assert.equal(meanConf, 80);
  });
});

// ─── OCR cue extraction ─────────────────────────────────────────────────────

describe("extractCaptionCues", () => {
  const frame = (atSec, ...lines) => ({ atSec, lines, meanConf: 90 });

  test("a caption held across consecutive frames is ONE cue at its first appearance", () => {
    const { cues } = extractCaptionCues([
      frame(0.5, "Watch this closely"),
      frame(2.5, "Watch this closely"),
      frame(4.5, "Something new here"),
    ], 3);
    assert.deepEqual(cues.map(c => c.text), ["Watch this closely", "Something new here"]);
    assert.equal(cues[0].startSec, 0.5);
    assert.equal(cues[1].startSec, 4.5);
  });

  test("text on most frames is UI chrome and is dropped", () => {
    const reads = [0.5, 2.5, 4.5, 6.5, 8.5, 10.5].map(at =>
      frame(at, "PRIMARY Console v2",
        ...(at < 4 ? ["Caption alpha here"] : at < 8 ? ["Caption beta here"] : [])));
    const { cues, staticDropped } = extractCaptionCues(reads, 6);
    assert.equal(staticDropped, 1, "the persistent title bar is not a caption");
    assert.deepEqual(cues.map(c => c.text), ["Caption alpha here", "Caption beta here"]);
  });

  test("two lines first seen on the same frame merge into one spoken cue", () => {
    const { cues } = extractCaptionCues([frame(2.5, "This caption wraps", "across two lines")], 1);
    assert.deepEqual(cues.map(c => c.text), ["This caption wraps across two lines"]);
  });

  test("the longest OCR reading of a held caption wins", () => {
    const { cues } = extractCaptionCues([
      frame(0.5, "Watch closely"),
      frame(2.5, "Watch this closely now"),
    ], 2);
    assert.deepEqual(cues.map(c => c.text), ["Watch this closely now"]);
  });

  test("single-token noise never becomes a cue", () => {
    const { cues, framesWithText } = extractCaptionCues([frame(0.5, "x", "≡")], 1);
    assert.equal(cues.length, 0);
    assert.equal(framesWithText, 0);
  });

  test("a caption held for ALL of a short clip is still a caption, not chrome", () => {
    // A 6s clip samples 3 frames; a real caption rides every one of them and
    // the frame-fraction test alone would call it chrome and drop the whole
    // script. Chrome must ALSO persist CHROME_MIN_DWELL_SEC of wall time.
    const { cues, staticDropped } = extractCaptionCues([
      frame(0.5, "The whole caption of a short clip"),
      frame(2.5, "The whole caption of a short clip"),
      frame(4.5, "The whole caption of a short clip"),
    ], 3);
    assert.deepEqual(cues.map(c => c.text), ["The whole caption of a short clip"]);
    assert.equal(staticDropped, 0);
  });
});

describe("ocrSampleTimestamps", () => {
  test("samples the clip on the configured pitch, inside its bounds", () => {
    const stamps = ocrSampleTimestamps(12, 2);
    assert.ok(stamps.length >= 5);
    assert.ok(stamps[0] <= 0.5);
    assert.ok(stamps[stamps.length - 1] < 12);
  });
});

// ─── Timing fit (contract path 3) ───────────────────────────────────────────

describe("untimedFit", () => {
  test("a read that fits plays at natural speed", () => {
    assert.deepEqual(untimedFit(20, 30), { fits: true, tempo: 1 });
  });

  test("a mild overrun speeds up just enough (plus drift margin)", () => {
    const fit = untimedFit(36, 30); // needs 1.2x
    assert.equal(fit.fits, true);
    assert.ok(fit.tempo >= 1.2 && fit.tempo <= TEMPO_MAX, `tempo ${fit.tempo}`);
  });

  test("past TEMPO_MAX the read does NOT fit — never garble, never truncate", () => {
    const fit = untimedFit(45, 30); // needs 1.5x
    assert.equal(fit.fits, false);
    assert.match(fit.reason, /1\.50x/);
  });
});

describe("timedPlacementPlan", () => {
  test("each cue gets its slot up to the next cue; the last runs to the video end", () => {
    const plan = timedPlacementPlan([
      { text: "a", startSec: 1 },
      { text: "b", startSec: 7 },
    ], 20);
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.lines.map(l => l.slotSec), [6, 13]);
  });

  test("a cue at/past the video end refuses the whole plan", () => {
    const plan = timedPlacementPlan([{ text: "late", startSec: 21 }], 20);
    assert.equal(plan.ok, false);
    assert.match(plan.reason, /past the video end/);
  });
});

describe("fitLineTempo", () => {
  test("a line inside its slot stays natural", () => {
    const fit = fitLineTempo(3, { startSec: 1, slotSec: 6 }, 20);
    assert.equal(fit.tempo, 1);
    assert.equal(fit.overlapsNext, false);
    assert.equal(fit.fitsVideo, true);
  });

  test("a line overrunning its slot overlaps the next rather than being cut", () => {
    const fit = fitLineTempo(10, { startSec: 1, slotSec: 6 }, 30);
    assert.equal(fit.tempo, TEMPO_MAX);
    assert.equal(fit.overlapsNext, true);
    assert.equal(fit.fitsVideo, true);
  });

  test("a line that cannot finish before the video ends is a hard no", () => {
    const fit = fitLineTempo(10, { startSec: 25, slotSec: 5 }, 30);
    assert.equal(fit.fitsVideo, false);
  });
});

// ─── Mux arg builders ───────────────────────────────────────────────────────

describe("mux args", () => {
  test("untimed: video stream copied at 1080x1920, audio padded to the video", () => {
    const args = buildUntimedMuxArgs("in.mp4", "vo.mp3", "out.mp4", { videoSec: 30, tempo: 1, needsScale: false });
    const s = args.join(" ");
    assert.ok(s.includes("-c:v copy"), "burned captions must survive untouched");
    assert.ok(s.includes("apad=whole_dur=30"), "silence-pad to the video, never -shortest");
    assert.ok(!s.includes("atempo"), "natural read gets no tempo filter");
    assert.ok(!s.includes("-shortest"), "-shortest would truncate");
  });

  test("untimed with tempo and scaling re-encodes to 1080x1920", () => {
    const args = buildUntimedMuxArgs("in.mp4", "vo.mp3", "out.mp4", { videoSec: 30, tempo: 1.2, needsScale: true });
    const s = args.join(" ");
    assert.ok(s.includes("atempo=1.2"));
    assert.ok(s.includes("scale=1080:1920"));
    assert.ok(s.includes("libx264"));
  });

  test("timed: each line delayed to its caption time, mixed at full volume", () => {
    const args = buildTimedMuxArgs("in.mp4", [
      { audioPath: "a.mp3", startSec: 0.5, tempo: 1 },
      { audioPath: "b.mp3", startSec: 6.5, tempo: 1.25 },
    ], "out.mp4", { videoSec: 20, needsScale: false });
    const s = args.join(" ");
    assert.ok(s.includes("adelay=500:all=1"));
    assert.ok(s.includes("adelay=6500:all=1"));
    assert.ok(s.includes("atempo=1.25"));
    assert.ok(s.includes("amix=inputs=2:normalize=0"), "amix without normalize=0 halves both lines");
    assert.ok(s.includes("apad=whole_dur=20"));
  });

  test("timed single line needs no amix", () => {
    const args = buildTimedMuxArgs("in.mp4", [{ audioPath: "a.mp3", startSec: 1, tempo: 1 }], "out.mp4", { videoSec: 10, needsScale: false });
    assert.ok(!args.join(" ").includes("amix"));
  });
});

// ─── Existing-audio classification (contract path 4) ────────────────────────

describe("classifyExistingAudio", () => {
  test("no track → no_track", () => {
    assert.equal(classifyExistingAudio("v.mp4", { run: makeRun({ hasAudio: false }) }).verdict, "no_track");
  });

  test("a screen recorder's silent placeholder track counts as no audio", () => {
    const res = classifyExistingAudio("v.mp4", { run: makeRun({ hasAudio: true, meanDb: -85 }) });
    assert.equal(res.verdict, "silent_track");
  });

  test("an audible track is kept — the bar is far below the speech bar on purpose", () => {
    assert.ok(SILENT_TRACK_MEAN_DB < -35, "quiet music must still count as audible");
    const res = classifyExistingAudio("v.mp4", { run: makeRun({ hasAudio: true, meanDb: -42 }) });
    assert.equal(res.verdict, "audible");
  });

  test("an unmeasurable track is INDETERMINATE — assume audible, never pave", () => {
    const res = classifyExistingAudio("v.mp4", { run: makeRun({ hasAudio: true, meanDb: null }) });
    assert.equal(res.verdict, "indeterminate");
  });
});

// ─── The orchestrator: six contract paths end to end ────────────────────────

describe("applyLdtVoiceover — sidecar path", () => {
  test("untimed sidecar: exact text spoken once, entry says sidecar", () => withTmpDir(async (dir) => {
    const ttsCalls = [];
    const execCalls = [];
    const run = makeRun({ durations: { "clip.mp4": 30, "tts-0.mp3": 12, "ldt_vo_": 30 } });
    const res = await applyLdtVoiceover("/fake/clip.mp4", {
      clipName: "clip.mp4",
      files: [{ id: "s1", name: "clip.txt" }],
      downloadText: async () => "Line one\nLine two",
      tts: makeTts(ttsCalls),
      run,
      exec: makeExec(execCalls),
      workDir: dir,
    });
    assert.equal(res.applied, true);
    assert.notEqual(res.videoPath, "/fake/clip.mp4");
    assert.ok(existsSync(res.videoPath) && statSync(res.videoPath).size > 10240);
    assert.deepEqual(ttsCalls, ["Line one Line two"], "the sidecar is the script, exactly");
    assert.equal(res.entryFields.voiceover, true);
    assert.equal(res.entryFields.voiceover_source, "sidecar");
    assert.equal(res.entryFields.voiceover_script, "Line one Line two");
    assert.equal(res.entryFields.voiceover_timed, false);
    assert.equal(res.entryFields.voiceover_tempo, 1);
    // VO duration vs video duration logged — the addendum's QC line.
    assert.equal(res.entryFields.voiceover_audio_sec, 12);
    assert.equal(res.entryFields.voiceover_video_sec, 30);
    assert.equal(res.entryFields.voiceover_rescaled, false, "already-vertical clip keeps -c:v copy");
    assert.equal(execCalls.length, 1);
  }));

  test("a landscape clip is rescaled to 1080x1920 by the orchestrator", () => withTmpDir(async (dir) => {
    const execCalls = [];
    // Input probes landscape; the muxed render probes vertical (per-path dims).
    const run = makeRun({
      dims: { "clip.mp4": "1920x1080", "ldt_vo_": "1080x1920" },
      durations: { "clip.mp4": 30, "tts-0.mp3": 12, "ldt_vo_": 30 },
    });
    const res = await applyLdtVoiceover("/fake/clip.mp4", {
      clipName: "clip.mp4",
      files: [{ id: "s1", name: "clip.txt" }],
      downloadText: async () => "Line one",
      tts: makeTts(),
      run,
      exec: makeExec(execCalls),
      workDir: dir,
    });
    assert.equal(res.applied, true);
    const mux = execCalls[0].join(" ");
    assert.ok(mux.includes("scale=1080:1920"), "landscape input must be scaled/padded");
    assert.ok(mux.includes("libx264"), "the scale path re-encodes");
    assert.ok(!mux.includes("-c:v copy"));
    assert.equal(res.entryFields.voiceover_rescaled, true);
  }));

  test("self-QC: a render that is not 1080x1920 is refused, silent clip posts", () => withTmpDir(async (dir) => {
    // The fail-open this pins: the INPUT dims probe erroring on a landscape
    // recording picks -c:v copy — only measuring the render catches it.
    const run = makeRun({
      dims: { "ldt_vo_": "1920x1080" }, // input probe unreadable, render lands landscape
      durations: { "clip.mp4": 30, "tts-0.mp3": 12, "ldt_vo_": 30 },
    });
    const res = await applyLdtVoiceover("/fake/clip.mp4", {
      clipName: "clip.mp4",
      files: [{ id: "s1", name: "clip.txt" }],
      downloadText: async () => "Line one",
      tts: makeTts(),
      run,
      exec: makeExec(),
      workDir: dir,
    });
    assert.equal(res.applied, false);
    assert.match(res.entryFields.voiceover_reason, /^fallback:mux_output_dims_off: 1920x1080/);
  }));

  test("SRT sidecar: one TTS per cue, each delayed to its caption time", () => withTmpDir(async (dir) => {
    const ttsCalls = [];
    const execCalls = [];
    const run = makeRun({ durations: { "clip.mp4": 20, "tts-0.mp3": 3, "tts-1.mp3": 3, "ldt_vo_": 20 } });
    const res = await applyLdtVoiceover("/fake/clip.mp4", {
      clipName: "clip.mp4",
      files: [{ id: "s1", name: "clip.txt" }],
      downloadText: async () => "1\n00:00:00,500 --> 00:00:04,000\nFirst line\n\n2\n00:00:06,500 --> 00:00:09,000\nSecond line\n",
      tts: makeTts(ttsCalls),
      run,
      exec: makeExec(execCalls),
      workDir: dir,
    });
    assert.equal(res.applied, true);
    assert.deepEqual(ttsCalls, ["First line", "Second line"]);
    assert.equal(res.entryFields.voiceover_timed, true);
    const mux = execCalls[0].join(" ");
    assert.ok(mux.includes("adelay=500:all=1"), "first line at its on-screen time");
    assert.ok(mux.includes("adelay=6500:all=1"), "second line at its on-screen time");
  }));

  test("a sidecar that cannot be downloaded falls back — never silently switches to OCR", () => withTmpDir(async (dir) => {
    const ttsCalls = [];
    const res = await applyLdtVoiceover("/fake/clip.mp4", {
      clipName: "clip.mp4",
      files: [{ id: "s1", name: "clip.txt" }],
      downloadText: async () => { throw new Error("Drive download failed (500)"); },
      tts: makeTts(ttsCalls),
      run: makeRun({ durations: { "clip.mp4": 30 } }),
      exec: makeExec(),
      workDir: dir,
    });
    assert.equal(res.applied, false);
    assert.equal(res.videoPath, "/fake/clip.mp4");
    assert.match(res.entryFields.voiceover_reason, /^fallback:sidecar_download_failed/);
    assert.equal(ttsCalls.length, 0);
  }));
});

describe("applyLdtVoiceover — OCR path", () => {
  test("no sidecar: captions read off frames, chrome dropped, script + confidence logged", () => withTmpDir(async (dir) => {
    const ttsCalls = [];
    const execCalls = [];
    // 12s video → frames at 0.5, 2.5, 4.5, 6.5, 8.5, 10.5. A persistent app
    // title rides every frame; caption A holds the first two, B two later.
    const chrome = "PRIMARY Console v2";
    const frames = [
      { lines: [chrome, "Caption alpha speaks"], meanConf: 91 },
      { lines: [chrome, "Caption alpha speaks"], meanConf: 89 },
      { lines: [chrome], meanConf: 90 },
      { lines: [chrome, "Caption beta answers"], meanConf: 88 },
      { lines: [chrome, "Caption beta answers"], meanConf: 92 },
      { lines: [chrome], meanConf: 90 },
    ];
    const { extract, ocr } = makeOcrFakes(frames);
    const run = makeRun({ durations: { "clip.mp4": 12, "tts-0.mp3": 2, "tts-1.mp3": 2, "ldt_vo_": 12 } });
    const res = await applyLdtVoiceover("/fake/clip.mp4", {
      clipName: "clip.mp4",
      files: [],
      tts: makeTts(ttsCalls),
      run, extract, ocr,
      exec: makeExec(execCalls),
      workDir: dir,
    });
    assert.equal(res.applied, true);
    assert.equal(res.entryFields.voiceover_source, "ocr");
    assert.equal(res.entryFields.voiceover_script, "Caption alpha speaks Caption beta answers");
    assert.equal(res.entryFields.voiceover_timed, true, "OCR cues are timed by first appearance");
    assert.deepEqual(ttsCalls, ["Caption alpha speaks", "Caption beta answers"]);
    assert.equal(res.entryFields.voiceover_ocr_static_dropped, 1, "the app title is not script");
    assert.ok(res.entryFields.voiceover_ocr_confidence > 85, "OCR confidence is logged");
    assert.equal(res.entryFields.voiceover_ocr_frames_sampled, 6);
    const mux = execCalls[0].join(" ");
    assert.ok(mux.includes("adelay=500:all=1"), "alpha speaks at its on-screen time (0.5s)");
    assert.ok(mux.includes("adelay=6500:all=1"), "beta speaks at its on-screen time (6.5s)");
  }));

  test("tesseract missing → fallback to the silent clip, loudly, never an empty read", () => withTmpDir(async (dir) => {
    const ttsCalls = [];
    const res = await applyLdtVoiceover("/fake/clip.mp4", {
      clipName: "clip.mp4",
      files: [],
      tts: makeTts(ttsCalls),
      run: makeRun({ durations: { "clip.mp4": 12 }, tesseractOk: false }),
      exec: makeExec(),
      workDir: dir,
    });
    assert.equal(res.applied, false);
    assert.equal(res.videoPath, "/fake/clip.mp4");
    assert.match(res.entryFields.voiceover_reason, /^fallback:ocr:ocr_unavailable/);
    assert.equal(ttsCalls.length, 0);
  }));

  test("frames with no readable captions → fallback, not an invented script", () => withTmpDir(async (dir) => {
    const { extract, ocr } = makeOcrFakes([{ lines: [], meanConf: null }]);
    const res = await applyLdtVoiceover("/fake/clip.mp4", {
      clipName: "clip.mp4",
      files: [],
      tts: makeTts(),
      run: makeRun({ durations: { "clip.mp4": 12 } }),
      extract, ocr,
      exec: makeExec(),
      workDir: dir,
    });
    assert.equal(res.applied, false);
    assert.match(res.entryFields.voiceover_reason, /^fallback:ocr:no_captions_read/);
  }));
});

describe("applyLdtVoiceover — timing fit", () => {
  test("an untimed read longer than the clip speeds up within natural limits", () => withTmpDir(async (dir) => {
    const execCalls = [];
    const run = makeRun({ durations: { "clip.mp4": 30, "tts-0.mp3": 36, "ldt_vo_": 30 } });
    const res = await applyLdtVoiceover("/fake/clip.mp4", {
      clipName: "clip.mp4",
      files: [{ id: "s1", name: "clip.txt" }],
      downloadText: async () => "A long read",
      tts: makeTts(),
      run,
      exec: makeExec(execCalls),
      workDir: dir,
    });
    assert.equal(res.applied, true);
    assert.ok(res.entryFields.voiceover_tempo >= 1.2 && res.entryFields.voiceover_tempo <= TEMPO_MAX);
    assert.ok(execCalls[0].join(" ").includes("atempo="));
  }));

  test("a read that cannot fit even at TEMPO_MAX falls back — the script is never cut", () => withTmpDir(async (dir) => {
    const res = await applyLdtVoiceover("/fake/clip.mp4", {
      clipName: "clip.mp4",
      files: [{ id: "s1", name: "clip.txt" }],
      downloadText: async () => "Far too much text",
      tts: makeTts(),
      run: makeRun({ durations: { "clip.mp4": 30, "tts-0.mp3": 45 } }),
      exec: makeExec(),
      workDir: dir,
    });
    assert.equal(res.applied, false);
    assert.equal(res.videoPath, "/fake/clip.mp4");
    assert.match(res.entryFields.voiceover_reason, /^fallback:unfittable/);
    // The script it WOULD have read still lands on the entry for the human.
    assert.equal(res.entryFields.voiceover_script, "Far too much text");
  }));

  test("captions too dense to voice fall back — no stacked copies of the same voice", () => withTmpDir(async (dir) => {
    // Three cues a second apart, each 5s of audio: even at TEMPO_MAX line 1
    // would still be playing when line 3 starts. Adjacent spill is natural;
    // three of Peter at once is not.
    const res = await applyLdtVoiceover("/fake/clip.mp4", {
      clipName: "clip.mp4",
      files: [{ id: "s1", name: "clip.txt" }],
      downloadText: async () =>
        "00:00:01,000 --> 00:00:02,000\nFirst dense line\n\n00:00:02,000 --> 00:00:03,000\nSecond dense line\n\n00:00:03,000 --> 00:00:04,000\nThird dense line\n",
      tts: makeTts(),
      run: makeRun({ durations: { "clip.mp4": 30, "tts-": 5 } }),
      exec: makeExec(),
      workDir: dir,
    });
    assert.equal(res.applied, false);
    assert.match(res.entryFields.voiceover_reason, /^fallback:timing:.*two captions later/);
  }));

  test("a timed line that cannot finish before the video ends falls back", () => withTmpDir(async (dir) => {
    const res = await applyLdtVoiceover("/fake/clip.mp4", {
      clipName: "clip.mp4",
      files: [{ id: "s1", name: "clip.txt" }],
      downloadText: async () => "00:00:18,000 --> 00:00:19,500\nA line far too long for the tail\n",
      tts: makeTts(),
      run: makeRun({ durations: { "clip.mp4": 20, "tts-0.mp3": 8 } }),
      exec: makeExec(),
      workDir: dir,
    });
    assert.equal(res.applied, false);
    assert.match(res.entryFields.voiceover_reason, /^fallback:timing:/);
  }));
});

describe("applyLdtVoiceover — existing-audio skip", () => {
  test("an audible track keeps the clip untouched, TTS never called", () => withTmpDir(async (dir) => {
    const ttsCalls = [];
    const res = await applyLdtVoiceover("/fake/clip.mp4", {
      clipName: "clip.mp4",
      files: [{ id: "s1", name: "clip.txt" }],
      downloadText: async () => "should never be read",
      tts: makeTts(ttsCalls),
      run: makeRun({ hasAudio: true, meanDb: -20, durations: { "clip.mp4": 30 } }),
      exec: makeExec(),
      workDir: dir,
    });
    assert.equal(res.applied, false);
    assert.equal(res.videoPath, "/fake/clip.mp4");
    assert.equal(res.entryFields.voiceover, false);
    assert.equal(res.entryFields.voiceover_reason, "existing_audio");
    assert.equal(res.entryFields.voiceover_existing_audio_db, -20);
    assert.equal(ttsCalls.length, 0);
  }));

  test("a silent placeholder track does NOT block the voiceover", () => withTmpDir(async (dir) => {
    const res = await applyLdtVoiceover("/fake/clip.mp4", {
      clipName: "clip.mp4",
      files: [{ id: "s1", name: "clip.txt" }],
      downloadText: async () => "Speak this",
      tts: makeTts(),
      run: makeRun({ hasAudio: true, meanDb: -85, durations: { "clip.mp4": 30, "tts-0.mp3": 10, "ldt_vo_": 30 } }),
      exec: makeExec(),
      workDir: dir,
    });
    assert.equal(res.applied, true);
  }));

  test("indeterminate audio is assumed audible — skip, never pave", () => withTmpDir(async (dir) => {
    const ttsCalls = [];
    const res = await applyLdtVoiceover("/fake/clip.mp4", {
      clipName: "clip.mp4",
      files: [],
      tts: makeTts(ttsCalls),
      run: makeRun({ hasAudio: true, meanDb: null, durations: { "clip.mp4": 30 } }),
      exec: makeExec(),
      workDir: dir,
    });
    assert.equal(res.applied, false);
    assert.equal(res.entryFields.voiceover_reason, "existing_audio_indeterminate");
    assert.equal(ttsCalls.length, 0);
  }));
});

describe("applyLdtVoiceover — the -novo flag", () => {
  test("skips before any probe, TTS never called, clip untouched", () => withTmpDir(async (dir) => {
    const ttsCalls = [];
    const res = await applyLdtVoiceover("/fake/demo-novo.mp4", {
      clipName: "demo-novo.mp4",
      files: [{ id: "s1", name: "demo-novo.txt" }],
      downloadText: async () => "should never be read",
      tts: makeTts(ttsCalls),
      run: () => { throw new Error("no probe should run for a flagged clip"); },
      exec: makeExec(),
      workDir: dir,
    });
    assert.equal(res.applied, false);
    assert.equal(res.videoPath, "/fake/demo-novo.mp4");
    assert.equal(res.entryFields.voiceover_reason, "novo_flag");
    assert.equal(ttsCalls.length, 0);
  }));
});

describe("applyLdtVoiceover — fallback doctrine", () => {
  test("a TTS failure posts the silent clip rather than blocking the slot", () => withTmpDir(async (dir) => {
    const res = await applyLdtVoiceover("/fake/clip.mp4", {
      clipName: "clip.mp4",
      files: [{ id: "s1", name: "clip.txt" }],
      downloadText: async () => "Speak this",
      tts: async () => { throw new Error("ElevenLabs TTS failed (503): busy"); },
      run: makeRun({ durations: { "clip.mp4": 30 } }),
      exec: makeExec(),
      workDir: dir,
    });
    assert.equal(res.applied, false);
    assert.equal(res.videoPath, "/fake/clip.mp4");
    assert.equal(res.entryFields.voiceover, false);
    assert.match(res.entryFields.voiceover_reason, /^fallback:tts_failed/);
  }));

  test("a mux failure falls back the same way", () => withTmpDir(async (dir) => {
    const res = await applyLdtVoiceover("/fake/clip.mp4", {
      clipName: "clip.mp4",
      files: [{ id: "s1", name: "clip.txt" }],
      downloadText: async () => "Speak this",
      tts: makeTts(),
      run: makeRun({ durations: { "clip.mp4": 30, "tts-0.mp3": 10 } }),
      exec: () => { throw new Error("ffmpeg exploded"); },
      workDir: dir,
    });
    assert.equal(res.applied, false);
    assert.match(res.entryFields.voiceover_reason, /^fallback:mux_failed/);
  }));

  test("self-QC: an output that measures wrong is refused, silent clip posts", () => withTmpDir(async (dir) => {
    // The mux "succeeds" but the render measures 5s against a 30s video —
    // the pipeline must watch its own render, not trust the exit code.
    const res = await applyLdtVoiceover("/fake/clip.mp4", {
      clipName: "clip.mp4",
      files: [{ id: "s1", name: "clip.txt" }],
      downloadText: async () => "Speak this",
      tts: makeTts(),
      run: makeRun({ durations: { "clip.mp4": 30, "tts-0.mp3": 10, "ldt_vo_": 5 } }),
      exec: makeExec(),
      workDir: dir,
    });
    assert.equal(res.applied, false);
    assert.match(res.entryFields.voiceover_reason, /^fallback:mux_output_duration_off/);
  }));

  test("nothing in entryFields is ever null — recordPost drops nulls silently", () => withTmpDir(async (dir) => {
    const res = await applyLdtVoiceover("/fake/clip.mp4", {
      clipName: "clip.mp4",
      files: [],
      tts: makeTts(),
      run: makeRun({ durations: { "clip.mp4": 12 }, tesseractOk: false }),
      exec: makeExec(),
      workDir: dir,
    });
    for (const [k, v] of Object.entries(res.entryFields)) {
      assert.notEqual(v, null, `${k} must not be null`);
      assert.notEqual(v, undefined, `${k} must not be undefined`);
    }
  }));
});

describe("applyLdtVoiceover — dry run", () => {
  test("resolves and logs the script but spends nothing on TTS or mux", () => withTmpDir(async (dir) => {
    const ttsCalls = [];
    const execCalls = [];
    const res = await applyLdtVoiceover("/fake/clip.mp4", {
      clipName: "clip.mp4",
      files: [{ id: "s1", name: "clip.txt" }],
      downloadText: async () => "Would speak this",
      dryRun: true,
      tts: makeTts(ttsCalls),
      run: makeRun({ durations: { "clip.mp4": 30 } }),
      exec: makeExec(execCalls),
      workDir: dir,
    });
    assert.equal(res.applied, false);
    assert.equal(res.entryFields.voiceover_reason, "dry_run");
    assert.equal(res.entryFields.voiceover_script, "Would speak this");
    assert.equal(ttsCalls.length, 0);
    assert.equal(execCalls.length, 0);
  }));
});
