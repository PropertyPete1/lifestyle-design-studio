/**
 * The concept rung's second ask knows what the first ask got refused.
 *
 * The incident under test: video 2's build died twice (runs 33586116393 and
 * 33606652718) on one 6-second window of s6t2 — "trips, the truck, the
 * savings". The window words searched "truck savings" (semi-trucks, refused),
 * the concept rung proposed "pickup truck parked in a residential driveway"
 * (commercial trucks and a man holding a STOP sign, refused), the bridge had
 * no slack, and the retry pass asked the identical question and got the
 * identical answer. These tests pin the three changes: the concept prompt
 * names the refusals and asks for a different kind of scene; a window earns a
 * second concept ask after a refusal (and only after one); and the retry's
 * mechanical rung does not re-spend the reviewer on a query already refused.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { buildVisuals } from "../src/yt-visual-build.js";
import { deriveConcept, rejectedBlock } from "../src/yt-concept-fallback.js";
import { ffmpeg as runFfmpeg } from "../src/yt-assemble.js";
import { BEAT_BRIDGE_MAX_SECONDS } from "../src/yt-config.js";

const have = (bin) => {
  const res = spawnSync(bin, ["-version"], { encoding: "utf-8" });
  return !res.error && res.status === 0;
};
const HAVE_FFMPEG = have("ffmpeg");

/** A concept client that answers in sequence and remembers every prompt. */
function sequencedClient(answers) {
  const prompts = [];
  const client = {
    prompts,
    messages: {
      create: async ({ messages }) => {
        const text = String(messages?.[0]?.content || "");
        prompts.push(text);
        const a = answers[Math.min(prompts.length - 1, answers.length - 1)];
        return { content: [{ type: "text", text: JSON.stringify(a) }] };
      },
    },
  };
  return client;
}

function fakeFetcher(decide) {
  const calls = [];
  const fn = async (opts) => {
    calls.push({ keywords: opts.keywords, subject: opts.subject, seconds: opts.seconds });
    return decide(opts, calls.length);
  };
  fn.calls = calls;
  return fn;
}

const refused = (keyword, reason) => ({ clip: null, attempts: [{ keyword, videoId: "v1", stage: "vision", reason }] });
const vo = (id, text, seconds) => ({ kind: "voiceover", takeId: id, section: "Sweep section", text, seconds, visualIntent: "FOOTAGE" });
const noWords = async () => null;

describe("rejectedBlock — the second ask is not the first ask again", () => {
  test("nothing refused, nothing added — the first-ask prompt is unchanged", () => {
    assert.equal(rejectedBlock([]), "");
    assert.equal(rejectedBlock(undefined), "");
  });

  test("names each refused subject, its query, the reviewer's reason, and asks for a different KIND of scene", () => {
    const block = rejectedBlock([
      { subject: "truck savings", query: "truck savings", reasons: ["Criterion 3 failure: parked semi-trucks at a fleet depot"] },
      { subject: "pickup truck parked in a residential driveway", query: "family truck pickup vehicle", reasons: ["Criterion 5 violation: a person holding a STOP sign", "Criterion 3 failure: an industrial lot"] },
    ]);
    assert.match(block, /ALREADY TRIED/);
    assert.match(block, /"truck savings"/);
    assert.match(block, /"pickup truck parked in a residential driveway" \(searched "family truck pickup vehicle"\)/);
    assert.match(block, /STOP sign/);
    assert.match(block, /DIFFERENT kind of scene/);
    assert.match(block, /house exterior|family in a kitchen/);
  });

  test("clips the reviewer's prose and keeps at most the last four refusals — a prompt, not a transcript", () => {
    const long = "x".repeat(500);
    const block = rejectedBlock(Array.from({ length: 6 }, (_, i) => ({ subject: `s${i}`, query: `q${i}`, reasons: [long, long, long] })));
    assert.ok(!block.includes("s0") && !block.includes("s1"), "the oldest refusals fall off");
    assert.ok(block.includes("s5"));
    assert.ok(block.length < 2200, `block is ${block.length} chars`);
  });

  test("deriveConcept carries the refusals into the prompt, and a first ask carries none", async () => {
    const client = sequencedClient([{ filmable: true, query: "family kitchen breakfast", subject: "a family at a kitchen table" }]);
    await deriveConcept({ phrase: "trips, the truck, the savings", client, rejected: [{ subject: "truck savings", query: "truck savings", reasons: ["semi-trucks"] }] });
    assert.match(client.prompts[0], /ALREADY TRIED[\s\S]*"truck savings"/);
    const fresh = sequencedClient([{ filmable: true, query: "family kitchen breakfast", subject: "a family at a kitchen table" }]);
    await deriveConcept({ phrase: "trips, the truck, the savings", client: fresh });
    assert.doesNotMatch(fresh.prompts[0], /ALREADY TRIED/);
  });
});

describe("the concept rung asks twice, and the second ask knows the first", () => {
  test("THE s6t2 SHAPE: window words refused, first concept refused, second concept (told both) lands", async (t) => {
    if (!HAVE_FFMPEG) return t.skip("ffmpeg not installed");
    const dir = mkdtempSync(join(tmpdir(), "concept-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    process.env.PEXELS_API_KEY = "sweep-test-key";
    t.after(() => { delete process.env.PEXELS_API_KEY; });

    const clip = join(dir, "c.mp4");
    runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=16", "-pix_fmt", "yuv420p", clip]);

    const client = sequencedClient([
      { filmable: true, query: "family truck pickup vehicle", subject: "a pickup truck parked in a residential driveway" },
      { filmable: true, query: "suburban house exterior", subject: "the front of a suburban house" },
    ]);
    const fetcher = fakeFetcher((opts, n) => {
      if (n === 1) return refused(opts.keywords[0], "Criterion 3 failure: parked semi-trucks at a fleet depot");
      if (n === 2) return refused(opts.keywords[0], "Criterion 5 violation: a person holding a STOP sign");
      return { clip: { path: clip, seconds: opts.seconds, gradedSeconds: 16, contentHash: "hOK", credit: { line: "x" }, query: opts.keywords[0] }, attempts: [] };
    });

    const plan = { segments: [vo("s6t2", "So his wife's paycheck became the trips, the truck, the savings. Same income as the next guy on base.", 8)] };
    const { report, plan: built } = await buildVisuals(plan, {
      workDir: dir, ffmpeg: runFfmpeg, getWordTimestamps: noWords, visionClient: client, stockFetcher: fetcher,
    });

    assert.equal(fetcher.calls.length, 3, "window words, concept one, concept two");
    assert.deepEqual(fetcher.calls[1].keywords, ["family truck pickup vehicle"]);
    assert.deepEqual(fetcher.calls[2].keywords, ["suburban house exterior"]);
    assert.equal(client.prompts.length, 2);
    // The FIRST ask already knows the window words were refused — that is
    // the mechanical rung's refusal, and it is why the model is being asked.
    assert.match(client.prompts[0], /ALREADY TRIED[\s\S]*semi-trucks/, "the first ask carries the mechanical refusal");
    assert.doesNotMatch(client.prompts[0], /pickup truck/, "nothing about a concept not yet proposed");
    assert.match(client.prompts[1], /ALREADY TRIED/, "the second ask names the refusals");
    assert.match(client.prompts[1], /pickup truck parked in a residential driveway/, "the refused concept's SUBJECT is named, not just its query");
    assert.match(client.prompts[1], /STOP sign/, "the reviewer's reason travels");
    assert.match(client.prompts[1], /semi-trucks/, "the mechanical rung's refusal travels too");

    const w = report.stockWindows.find((x) => x.takeId === "s6t2");
    assert.equal(w.matched, true);
    assert.equal(w.source, "concept");
    assert.deepEqual(w.keywords, ["suburban house exterior"]);
    assert.equal(report.conceptCalls.asked, 2);
    assert.equal(report.conceptCalls.matched, 1);
    const beats = built.segments[0].broll.filter((b) => b.kind === "beat");
    for (const b of beats) assert.ok(b.seconds <= BEAT_BRIDGE_MAX_SECONDS + 0.05, `a ${b.seconds}s beat survived`);
  });

  test("no second ask when nothing was refused: 'not filmable' still ends the rung after ONE call", async (t) => {
    if (!HAVE_FFMPEG) return t.skip("ffmpeg not installed");
    const dir = mkdtempSync(join(tmpdir(), "concept-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    process.env.PEXELS_API_KEY = "sweep-test-key";
    t.after(() => { delete process.env.PEXELS_API_KEY; });

    // The window's own words die at SEARCH (nothing for the reviewer to
    // refuse) and the concept says not filmable. One ask, then the take
    // fails the full-window gate exactly as before — this test is about the
    // ask count, not the outcome.
    const client = sequencedClient([{ filmable: false }]);
    const fetcher = fakeFetcher((opts) => ({ clip: null, attempts: [{ keyword: opts.keywords[0], stage: "search", reason: "no results" }] }));
    const plan = { segments: [vo("t1", "The kitchen has a big island and the yard has oak trees over the patio out back there.", 8)] };
    await assert.rejects(
      () => buildVisuals(plan, { workDir: dir, ffmpeg: runFfmpeg, getWordTimestamps: noWords, visionClient: client, stockFetcher: fetcher }),
      /full-window beats survived/
    );
    // One ask per pass: the first pass, then the retry the surviving beat
    // earns — never a second ask within a pass when no concept was searched.
    assert.equal(client.prompts.length, 2, "one ask on the first pass, one on the retry — not two per pass");
    assert.equal(fetcher.calls.length, 1, "only the window's own words were searched, and the retry did not search them again");
  });

  test("a model that repeats its refused answer is not re-searched", async (t) => {
    if (!HAVE_FFMPEG) return t.skip("ffmpeg not installed");
    const dir = mkdtempSync(join(tmpdir(), "concept-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    process.env.PEXELS_API_KEY = "sweep-test-key";
    t.after(() => { delete process.env.PEXELS_API_KEY; });

    // Words refused, concept refused, and the second ask proposes the SAME
    // concept again: it is recorded, not searched, and the gate still fires.
    const client = sequencedClient([{ filmable: true, query: "family truck pickup vehicle", subject: "a pickup truck in a driveway" }]);
    const fetcher = fakeFetcher((opts) => refused(opts.keywords[0], "Criterion 3 failure: commercial trucks"));
    const plan = { segments: [vo("t1", "The kitchen has a big island and the yard has oak trees over the patio out back there.", 8)] };
    await assert.rejects(
      () => buildVisuals(plan, { workDir: dir, ffmpeg: runFfmpeg, getWordTimestamps: noWords, visionClient: client, stockFetcher: fetcher }),
      (err) => /full-window beats survived/.test(err.message) && /proposed "family truck pickup vehicle" again/.test(err.message)
    );
    // Two asks on the first pass (the second answers the refusal), one on the
    // retry; the repeated concept is never searched on either pass.
    assert.equal(client.prompts.length, 3, "two asks on the first pass, one on the retry");
    assert.equal(fetcher.calls.length, 2, "words, concept — and NOT the repeated concept, on either pass");
    assert.match(client.prompts[1], /pickup truck in a driveway/, "the second ask was told what was refused");
  });
});

describe("the retry pass does not re-ask a question it has the answer to", () => {
  test("a refused query is never searched twice in one take; the retry goes to a fresh concept", async (t) => {
    if (!HAVE_FFMPEG) return t.skip("ffmpeg not installed");
    const dir = mkdtempSync(join(tmpdir(), "concept-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    process.env.PEXELS_API_KEY = "sweep-test-key";
    t.after(() => { delete process.env.PEXELS_API_KEY; });
    const clipA = join(dir, "a.mp4");
    const clipB = join(dir, "b.mp4");
    runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=16", "-pix_fmt", "yuv420p", clipA]);
    runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=16", "-pix_fmt", "yuv420p", clipB]);

    // A 24-second take: window 0 (0-8) lands clip A with 16s graded, which
    // the bridge spends on 8-16; window 1 (16-24) is refused on its own words
    // AND on both concepts. The 8s beat survives bridging (A has no slack
    // left) and the retry re-covers the SAME span with the SAME words — the
    // s6t2 shape. The retry must not search those words again; its fresh
    // concept ask, told everything, lands clip B.
    const client = sequencedClient([
      { filmable: true, query: "family truck pickup vehicle", subject: "a pickup truck in a driveway" },
      { filmable: true, query: "farm tractor field", subject: "a tractor in a field" },
      { filmable: true, query: "suburban house exterior", subject: "the front of a suburban house" },
    ]);
    const fetcher = fakeFetcher((opts, n) => {
      if (n === 1) return { clip: { path: clipA, seconds: opts.seconds, gradedSeconds: 16, contentHash: "hA", credit: { line: "a" }, query: opts.keywords[0] }, attempts: [] };
      if (opts.keywords[0] === "suburban house exterior") {
        return { clip: { path: clipB, seconds: opts.seconds, gradedSeconds: 16, contentHash: "hB", credit: { line: "b" }, query: opts.keywords[0] }, attempts: [] };
      }
      return refused(opts.keywords[0], `Criterion 3 failure: refused ${opts.keywords[0]}`);
    });

    const text = "The kitchen has a big island and the yard has oak trees over the patio out back there. " +
      "Then the garage fits two cars and the driveway holds a boat beside the fence by the street.";
    const plan = { segments: [vo("t1", text, 24)] };
    const { report, plan: built } = await buildVisuals(plan, {
      workDir: dir, ffmpeg: runFfmpeg, getWordTimestamps: noWords, visionClient: client, stockFetcher: fetcher,
    });

    const firstPass = report.stockWindows.filter((w) => w.takeId === "t1" && !w.retry);
    assert.equal(firstPass.length, 2, `fixture must lay out two first-pass windows: ${JSON.stringify(report.stockWindows)}`);
    const retryRow = report.stockWindows.find((w) => w.retry);
    assert.ok(retryRow, "a retry window exists");
    assert.deepEqual(retryRow.startAt, firstPass[1].startAt, "the retry re-covers the failed window's span");

    // THE INVARIANT: no query that was refused is ever searched again in this take.
    const seen = new Map();
    for (const c of fetcher.calls) {
      const key = c.keywords.join(" ").toLowerCase();
      assert.ok(!seen.has(key), `"${key}" was searched twice: ${JSON.stringify(fetcher.calls.map((x) => x.keywords))}`);
      seen.set(key, true);
    }
    assert.equal(fetcher.calls.length, 5, "window 0, window 1's words, concept one, concept two, the retry's fresh concept");
    assert.deepEqual(report.leftoverRetries, { asked: 1, matched: 1 });
    assert.equal(retryRow.matched, true);
    assert.equal(retryRow.source, "concept");
    assert.deepEqual(retryRow.keywords, ["suburban house exterior"]);
    assert.equal(client.prompts.length, 3);
    assert.match(client.prompts[2], /ALREADY TRIED[\s\S]*pickup truck in a driveway[\s\S]*tractor in a field/, "the retry's ask carries BOTH earlier refusals");
    const retryAttempts = report.stockAttempts.filter((r) => r.phase >= 900).flatMap((r) => r.attempts);
    assert.ok(retryAttempts.some((a) => a.stage === "keywords" && /already searched/.test(a.reason)), `the skip is on the record: ${JSON.stringify(retryAttempts)}`);
    for (const b of built.segments[0].broll.filter((x) => x.kind === "beat")) {
      assert.ok(b.seconds <= BEAT_BRIDGE_MAX_SECONDS + 0.05, `a ${b.seconds}s beat survived`);
    }
  });
});
