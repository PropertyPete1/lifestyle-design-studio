/**
 * The three source-respect gates, exercised on the planted cases from the
 * 2026-08-26 incident (posted-log entry for 003001B1-0C39-4A31-82EE-FD86C942D049.mp4):
 * a presenter talking on camera got a voiceover paved over her
 * (`hallucination_override_add_voiceover`), her burned-in captions got a second
 * caption layer, and the read stated a price the video never shows.
 *
 * The planted cases, per Peter's spec:
 *   - a talking-head clip        → NO voiceover, whatever any model thinks
 *   - a captioned clip           → no new caption layer
 *   - a silent b-roll clip       → voiceover still works (don't kill the feature)
 *   - a price misread            → blocked, and NAMED in the record
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  INCIDENTAL_WORD_MAX,
  speechVerdict,
  captionSampleTimestamps,
  countNovelTexts,
  detectBurnedCaptions,
  parseStatedFigures,
  sourceFigureValues,
  checkNumberHonesty,
  buildSourceFigures,
} from "../src/source-respect.js";
import { processVoiceover } from "../src/voiceover.js";
import { processBurnedCaptions } from "../src/burned-captions.js";

// ─── GATE 1: the speech verdict is a word count, not an opinion ──────────────

describe("speechVerdict", () => {
  test("PLANTED: the talking-head clip — a real transcript means no voiceover", () => {
    // The actual transcript Whisper produced on the incident clip. The Haiku
    // coherence check read it as NOT_SPEECH and approved the paving. The word
    // count says someone is talking, and the word count wins.
    const v = speechVerdict({
      hasSpeech: true,
      transcript: "This house is not $25 a month. It's only $80 a day.",
      wordCount: 12,
      confidence: 0.9,
    });
    assert.equal(v.sourceHasSpeech, true);
    assert.equal(v.reason, "source_has_speech");
    assert.match(v.say, /source has speech/);
    assert.match(v.say, /12 words/);
  });

  test("a hallucination flag cannot overrule transcribed words", () => {
    // detect-speech.py can flip hasSpeech off on repetition heuristics. Words
    // in the transcript still mean someone (or their song) is talking, and
    // nothing gets paved either way.
    const v = speechVerdict({
      hasSpeech: false,
      isHallucination: true,
      transcript: "go go go go go go go this is the one go go",
      wordCount: 12,
    });
    assert.equal(v.sourceHasSpeech, true);
  });

  test("incidental words stay incidental", () => {
    const v = speechVerdict({ hasSpeech: true, transcript: "wow look at this", wordCount: 4 });
    assert.equal(v.sourceHasSpeech, false);
    assert.equal(v.reason, "incidental_words_only");
  });

  test("PLANTED: silent b-roll — the voiceover feature survives", () => {
    const v = speechVerdict({ hasSpeech: false, silent: true, transcript: "", wordCount: 0 });
    assert.equal(v.sourceHasSpeech, false);
    assert.equal(v.reason, "no_speech");
  });

  test("a whisper error is speech (fail-safe)", () => {
    const v = speechVerdict({ error: "model exploded" });
    assert.equal(v.sourceHasSpeech, true);
    assert.equal(v.reason, "whisper_error_failsafe");
  });

  test("the threshold is exactly INCIDENTAL_WORD_MAX", () => {
    const at = speechVerdict({ transcript: "one two three four five", wordCount: INCIDENTAL_WORD_MAX });
    const over = speechVerdict({ transcript: "one two three four five six", wordCount: INCIDENTAL_WORD_MAX + 1 });
    assert.equal(at.sourceHasSpeech, false);
    assert.equal(over.sourceHasSpeech, true);
  });
});

describe("processVoiceover honors the verdict (dry run, injected detection)", () => {
  test("PLANTED: talking-head clip → skipped, loudly, with the transcript kept", async () => {
    const detect = () => ({
      hasSpeech: true,
      transcript: "This house is not $25 a month. It's only $80 a day.",
      wordCount: 12,
      silent: false,
      confidence: 0.9,
    });
    const res = await processVoiceover("/nonexistent.mp4", "san_antonio", true, null, { detect });
    assert.equal(res.skipped, true);
    assert.equal(res.reason, "source_has_speech");
    assert.match(res.note, /source has speech/);
    assert.equal(res.detection.transcript.includes("$80 a day"), true);
  });

  test("forceVoiceover does NOT override the speech gate", async () => {
    const detect = () => ({
      hasSpeech: true,
      transcript: "hi everyone welcome back to another home tour today we are in",
      wordCount: 12,
      silent: false,
    });
    const res = await processVoiceover("/nonexistent.mp4", "austin", true, null, { detect, forceVoiceover: true });
    assert.equal(res.skipped, true);
    assert.equal(res.reason, "source_has_speech_force_refused");
    assert.match(res.note, /forceVoiceover does not override/);
  });

  test("PLANTED: silent b-roll → voiceover proceeds", async () => {
    const detect = () => ({ hasSpeech: false, silent: true, transcript: "", wordCount: 0, confidence: 1 });
    const res = await processVoiceover("/nonexistent.mp4", "austin", true, null, { detect });
    assert.equal(res.skipped, false);
  });

  test("music-only clip → voiceover proceeds", async () => {
    const detect = () => ({ hasSpeech: false, hasMusic: true, silent: false, transcript: "", wordCount: 0 });
    const res = await processVoiceover("/nonexistent.mp4", "austin", true, null, { detect });
    assert.equal(res.skipped, false);
  });
});

// ─── GATE 2: no captions over captions ───────────────────────────────────────

describe("caption detection distinguishes subtitles from overlays", () => {
  test("sample timestamps cover the middle of the clip", () => {
    const ts = captionSampleTimestamps(30, 8);
    assert.equal(ts.length, 8);
    assert.ok(ts[0] >= 1);
    assert.ok(ts[7] <= 29);
  });

  test("PLANTED: a captioned clip — changing text across frames is detected", () => {
    const { textFrames, novelTexts } = countNovelTexts([
      "THIS HOUSE IS NOT",
      "TWENTY FIVE DOLLARS A MONTH",
      "ITS ONLY EIGHTY",
      "DOLLARS A DAY",
      "COMMENT TOUR FOR THE",
    ]);
    assert.ok(textFrames >= 3);
    assert.ok(novelTexts >= 3);
  });

  test("a static price overlay is ONE text however many frames show it", () => {
    const readings = [
      "STARTING AT $440,000 SAN ANTONIO",
      "STARTING AT $440,OOO SAN ANTONIO", // OCR fuzz on the same plate
      "STARTING AT $440,000 SAN ANTONIO",
      "STARTING AT 440,000 SAN ANTONI0",
    ];
    const { novelTexts } = countNovelTexts(readings);
    assert.equal(novelTexts, 1);
  });

  test("noise frames don't count as text", () => {
    const { textFrames } = countNovelTexts(["", "  ", "|", "a"]);
    assert.equal(textFrames, 0);
  });

  test("detectBurnedCaptions: subtitle track → detected", () => {
    const subtitleFrames = [
      "look at this kitchen island",
      "look at this kitchen island",
      "the quartz counters run",
      "the quartz counters run",
      "all the way down",
      "and the price on this",
      "will surprise you",
      "comment tour below",
    ];
    let i = 0;
    const res = detectBurnedCaptions("/fake.mp4", {
      run: (cmd) => (cmd === "tesseract" ? { status: 0, stdout: "tesseract 5" } : { status: 0, stdout: "24.0" }),
      extract: () => {},
      ocr: () => subtitleFrames[i++] ?? "",
      durationSec: 24,
    });
    assert.equal(res.detected, true);
    assert.match(res.say, /already has burned-in captions/);
  });

  test("detectBurnedCaptions: static overlay only → NOT detected (captions still allowed)", () => {
    let i = 0;
    const res = detectBurnedCaptions("/fake.mp4", {
      run: (cmd) => ({ status: 0, stdout: cmd === "tesseract" ? "tesseract 5" : "24.0" }),
      extract: () => {},
      ocr: () => (i++ < 8 ? "STARTING AT $440,000" : ""),
      durationSec: 24,
    });
    assert.equal(res.detected, false);
  });

  test("tesseract missing → 'cannot verify', never 'no captions'", () => {
    const res = detectBurnedCaptions("/fake.mp4", {
      run: () => ({ error: new Error("ENOENT"), status: 1 }),
    });
    assert.equal(res.detected, false);
    assert.equal(res.ocrUnavailable, true);
    assert.match(res.say, /tesseract is not installed/);
  });
});

describe("processBurnedCaptions refuses a second caption layer", () => {
  test("PLANTED: captioned clip → burn skipped with the named reason", async () => {
    const res = await processBurnedCaptions("/fake-merged.mp4", "/fake.mp3", "some script", {
      captionScan: { detected: true, ocrUnavailable: false, say: "captions skipped: source already has burned-in captions (4 distinct texts across 6 text-bearing frames)" },
    });
    assert.equal(res.captions_burned, false);
    assert.equal(res.captions_skip_reason, "source_has_burned_captions");
    assert.equal(res.videoPath, "/fake-merged.mp4");
  });

  test("unverifiable (no tesseract) → burn skipped, loudly, as its own reason", async () => {
    const res = await processBurnedCaptions("/fake-merged.mp4", "/fake.mp3", "some script", {
      captionScan: { detected: false, ocrUnavailable: true, say: "caption check could not run" },
    });
    assert.equal(res.captions_burned, false);
    assert.equal(res.captions_skip_reason, "caption_check_unavailable_tesseract_missing");
  });
});

// ─── GATE 3: number honesty ──────────────────────────────────────────────────

describe("parseStatedFigures", () => {
  test("reads spelled-out prices the way the TTS says them", () => {
    const figs = parseStatedFigures("Brand new construction starting at two thousand five hundred dollars.");
    const price = figs.find((f) => f.value === 2500);
    assert.ok(price);
    assert.equal(price.enforceable, true);
  });

  test("reads the incident's inflation: two million five hundred thousand", () => {
    const figs = parseStatedFigures("would you believe two million five hundred thousand dollars");
    assert.ok(figs.some((f) => f.value === 2_500_000 && f.enforceable));
  });

  test("reads rates: four point nine nine percent", () => {
    const figs = parseStatedFigures("with the four point nine nine percent fixed rate");
    assert.ok(figs.some((f) => f.value === 4.99 && f.enforceable));
  });

  test("reads 'and a half' forms", () => {
    const figs = parseStatedFigures("two and a half baths");
    assert.ok(figs.some((f) => f.value === 2.5 && f.enforceable));
  });

  test("reads digit forms the model leaks", () => {
    const figs = parseStatedFigures("starting at $440,000 today");
    assert.ok(figs.some((f) => f.value === 440000 && f.enforceable));
  });

  test("a pronoun 'one' is not a figure claim", () => {
    const figs = parseStatedFigures("the payment on this one surprises people");
    for (const f of figs) assert.equal(f.enforceable, false);
  });

  test("small counts WITH units are claims: four bedrooms", () => {
    const figs = parseStatedFigures("four bedrooms and a game room");
    assert.ok(figs.some((f) => f.value === 4 && f.enforceable));
  });

  test("compound: two hundred forty thousand nine hundred ninety", () => {
    const figs = parseStatedFigures("two hundred forty thousand nine hundred ninety dollars");
    assert.ok(figs.some((f) => f.value === 240990));
  });
});

describe("sourceFigureValues and figure equality", () => {
  test("PLANTED: the price misread — $2,500 in the source does not authorize 2,500,000", () => {
    const allowed = sourceFigureValues(["Move in special $2,500 San Antonio"]);
    const check = checkNumberHonesty(
      "Would you believe brand new construction for two million five hundred thousand dollars.",
      allowed
    );
    assert.equal(check.ok, false);
    // Blocked AND NAMED — the record says which figure died and what it parsed to.
    assert.equal(check.violations.length, 1);
    assert.match(check.violations[0].raw, /two million five hundred thousand/);
    assert.equal(check.violations[0].value, 2_500_000);
  });

  test("the honest read of the same source passes", () => {
    const allowed = sourceFigureValues(["Move in special $2,500 San Antonio"]);
    const check = checkNumberHonesty("This one is two thousand five hundred dollars to move in.", allowed);
    assert.equal(check.ok, true);
  });

  test("substring discipline: 340,000 in the source does not authorize 40,000", () => {
    const allowed = sourceFigureValues(["priced at $340,000 this week"]);
    assert.equal(checkNumberHonesty("only forty thousand dollars", allowed).ok, false);
    assert.equal(checkNumberHonesty("three hundred forty thousand dollars", allowed).ok, true);
  });

  test("suffixed source forms expand: $507K authorizes five hundred seven thousand", () => {
    const allowed = sourceFigureValues(["from $507K"]);
    assert.equal(checkNumberHonesty("five hundred seven thousand dollars", allowed).ok, true);
  });

  test("range source forms: 'from the $400s' authorizes four hundred thousand", () => {
    const allowed = sourceFigureValues(["homes from the $400s"]);
    assert.equal(checkNumberHonesty("starting around four hundred thousand dollars", allowed).ok, true);
  });

  test("a rate on screen authorizes the spoken rate", () => {
    const allowed = sourceFigureValues(["4.99% fixed rate special"]);
    assert.equal(checkNumberHonesty("the four point nine nine percent fixed rate", allowed).ok, true);
  });

  test("a script with no figures always passes", () => {
    const check = checkNumberHonesty(
      "Wait until you see this home. The payment on this one surprises people. Comment TOUR.",
      sourceFigureValues([])
    );
    assert.equal(check.ok, true);
  });

  test("buildSourceFigures pools transcript, overlays and OCR text", () => {
    const allowed = buildSourceFigures({
      transcript: "it is two thousand five hundred to move in",
      overlays: { price: "$440,000", beds_baths: "4 bed / 3 bath", raw_text: "4.99% APR" },
      ocrTexts: ["FROM THE $500S"],
    });
    assert.ok(allowed.has(2500));
    assert.ok(allowed.has(440000));
    assert.ok(allowed.has(4));
    assert.ok(allowed.has(3));
    assert.ok(allowed.has(4.99));
    assert.ok(allowed.has(500000));
  });
});

describe("caption chunks are held to the same figures", () => {
  const wordsFor = (text) =>
    text.split(/\s+/).map((w, i) => ({ word: w, start: i * 0.3, end: i * 0.3 + 0.25 }));

  test("PLANTED: a misheard number in the chunk text blocks the burn, loudly and named", async () => {
    // Chunk text is Whisper's transcription of the TTS. Plant the incident's
    // mishearing — the source says $2,500, the transcription says $2,500,000 —
    // exactly the failure class that must never reach pixels.
    const res = await processBurnedCaptions("/fake-merged.mp4", "/fake.mp3", "script text", {
      captionScan: { detected: false, ocrUnavailable: false },
      allowedFigures: sourceFigureValues(["$2,500 move-in special"]),
      getWords: () => wordsFor("brand new construction for $2,500,000 in San Antonio"),
    });
    assert.equal(res.captions_burned, false);
    assert.match(res.captions_skip_reason, /number_honesty/);
    assert.match(res.captions_skip_reason, /2,500,000|2500000/);
  });

  test("an honest transcription burns (proceeds past the gate to the burn step)", async () => {
    // The gate passes and the pipeline moves on to real ffmpeg work, which
    // fails on the fake file — reported as a burn error, not a gate skip.
    const res = await processBurnedCaptions("/fake-merged.mp4", "/fake.mp3", "script text", {
      captionScan: { detected: false, ocrUnavailable: false },
      allowedFigures: sourceFigureValues(["$2,500 move-in special"]),
      getWords: () => wordsFor("brand new construction for $2,500 in San Antonio"),
    });
    assert.equal(res.captions_burned, false);
    assert.equal(res.captions_skip_reason, null);
    assert.ok(res.captions_error); // died in ffmpeg, not at the gate
  });
});
