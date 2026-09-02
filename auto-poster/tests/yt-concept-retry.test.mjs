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

  test("a words-only refusal informs the query, a proposed-scene refusal bans the object class", () => {
    const words = rejectedBlock([{ subject: "the truck", query: "truck savings", reasons: ["Criterion 3 failure: parked semi-trucks at a fleet depot"] }]);
    assert.match(words, /searched as-is/);
    assert.match(words, /"the truck" \(searched "truck savings"\)/);
    assert.match(words, /semi-trucks/);
    assert.match(words, /describe the right scene properly/);
    assert.doesNotMatch(words, /DIFFERENT kind/, "raw words pulling up the wrong footage is not a ban on the subject");

    const scenes = rejectedBlock([
      { subject: "pickup truck parked in a residential driveway", query: "family truck pickup vehicle", reasons: ["Criterion 5 violation: a person holding a STOP sign", "Criterion 3 failure: an industrial lot"], viaConcept: true },
    ]);
    assert.match(scenes, /ALREADY PROPOSED/);
    assert.match(scenes, /"pickup truck parked in a residential driveway" \(searched "family truck pickup vehicle"\)/);
    assert.match(scenes, /STOP sign/);
    assert.match(scenes, /DIFFERENT kind of everyday scene/);
    assert.doesNotMatch(scenes, /a house exterior, a family in a kitchen/, "no fixed menu — every window converging on the same query exhausts its top three");
  });

  test("an exhausted query says so, a search miss says so", () => {
    assert.match(rejectedBlock([{ query: "suburban house exterior", subject: "suburban house exterior", viaConcept: true, exhausted: true }]), /already used in this video/);
    assert.match(rejectedBlock([{ query: "title neighbor", subject: "title neighbor", reasons: [] }]), /found nothing usable/);
  });

  test("clips the reviewer's prose and keeps the last two word-rows and last three scene-rows — a prompt, not a transcript", () => {
    const long = "x".repeat(500);
    const block = rejectedBlock(Array.from({ length: 6 }, (_, i) => ({ subject: `s${i}`, query: `q${i}`, reasons: [long, long, long], viaConcept: true })));
    assert.ok(!block.includes("s2") && block.includes("s3") && block.includes("s5"), "the oldest scene refusals fall off");
    assert.ok(block.length < 1600, `block is ${block.length} chars`);
  });

  test("deriveConcept carries the refusals into the prompt, and a first ask carries none", async () => {
    const client = sequencedClient([{ filmable: true, query: "family kitchen breakfast", subject: "a family at a kitchen table" }]);
    await deriveConcept({ phrase: "trips, the truck, the savings", client, rejected: [{ subject: "truck savings", query: "truck savings", reasons: ["semi-trucks"] }] });
    assert.match(client.prompts[0], /searched as-is[\s\S]*"truck savings"/);
    const fresh = sequencedClient([{ filmable: true, query: "family kitchen breakfast", subject: "a family at a kitchen table" }]);
    await deriveConcept({ phrase: "trips, the truck, the savings", client: fresh });
    assert.doesNotMatch(fresh.prompts[0], /searched as-is|ALREADY PROPOSED/);
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
    // The FIRST ask already knows the window words were refused — as a
    // words-only refusal (information about the query), never as a ban on
    // the subject; nothing is said about a concept not yet proposed.
    assert.match(client.prompts[0], /searched as-is[\s\S]*semi-trucks/, "the first ask carries the mechanical refusal");
    assert.doesNotMatch(client.prompts[0], /pickup truck|ALREADY PROPOSED|DIFFERENT kind/, "nothing about a concept not yet proposed");
    assert.match(client.prompts[1], /ALREADY PROPOSED/, "the second ask names the refused proposal");
    assert.match(client.prompts[1], /pickup truck parked in a residential driveway/, "the refused concept's SUBJECT is named, not just its query");
    assert.match(client.prompts[1], /STOP sign/, "the reviewer's reason travels");
    assert.match(client.prompts[1], /DIFFERENT kind/, "and asks for a different object class");
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
    assert.equal(fetcher.calls.length, 2, "the window's own words, on the first pass and again on the retry — nothing else");
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
    // Two asks per pass (a repeat earns the second ask, so the model gets one
    // more chance to differ); the repeated concept is never searched.
    assert.equal(client.prompts.length, 4, "two asks on the first pass, two on the retry");
    assert.equal(fetcher.calls.length, 3, "words, concept, and the retry's re-search of the words — never the repeated concept");
    assert.match(client.prompts[1], /pickup truck in a driveway/, "the second ask was told what was refused");
  });
});

describe("the retry pass does not re-ask a question it has the answer to", () => {
  test("a reviewer OUTAGE is not a refusal: the retry searches those words again, and the concept ask is not told a lie", async (t) => {
    if (!HAVE_FFMPEG) return t.skip("ffmpeg not installed");
    const dir = mkdtempSync(join(tmpdir(), "concept-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    process.env.PEXELS_API_KEY = "sweep-test-key";
    t.after(() => { delete process.env.PEXELS_API_KEY; });
    const clipA = join(dir, "a.mp4");
    const clipB = join(dir, "b.mp4");
    runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=16", "-pix_fmt", "yuv420p", clipA]);
    runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=16", "-pix_fmt", "yuv420p", clipB]);

    // Window 1's words are searched on the first pass but every reviewer call
    // THROWS (the stock fetcher records "vision check failed: ..." at stage
    // vision); the concept says not filmable. On the retry the reviewer is
    // back: the same words must be searched again and land.
    let reviewerDown = true;
    const client = sequencedClient([{ filmable: false }]);
    const fetcher = fakeFetcher((opts, n) => {
      if (n === 1) return { clip: { path: clipA, seconds: opts.seconds, gradedSeconds: 16, contentHash: "hA", credit: { line: "a" }, query: opts.keywords[0] }, attempts: [] };
      if (reviewerDown) {
        reviewerDown = false;
        return { clip: null, attempts: [{ keyword: opts.keywords[0], videoId: "v1", stage: "vision", reason: "vision check failed: Request timed out" }] };
      }
      return { clip: { path: clipB, seconds: opts.seconds, gradedSeconds: 16, contentHash: "hB", credit: { line: "b" }, query: opts.keywords[0] }, attempts: [] };
    });
    const text = "The kitchen has a big island and the yard has oak trees over the patio out back there. " +
      "Then the garage fits two cars and the driveway holds a boat beside the fence by the street.";
    const { report } = await buildVisuals({ segments: [vo("t1", text, 24)] }, {
      workDir: dir, ffmpeg: runFfmpeg, getWordTimestamps: noWords, visionClient: client, stockFetcher: fetcher,
    });
    const retryRow = report.stockWindows.find((w) => w.retry);
    assert.ok(retryRow && retryRow.matched && retryRow.source === "window", `the retry re-searched the words and landed: ${JSON.stringify(report.stockWindows)}`);
    assert.deepEqual(fetcher.calls[1].keywords, fetcher.calls[2].keywords, "the same words were searched again — an outage is not a verdict");
    assert.doesNotMatch(client.prompts[0], /ALREADY TRIED/, "the concept ask was not told the words were refused when nobody judged them");
  });

  test("the retry searches the words again (a new window length surfaces new candidates), and its concept ask carries both earlier refusals", async (t) => {
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
    // left) and the retry re-covers the SAME span — the s6t2 shape. The
    // retry searches the words again (s4t3 was rescued exactly that way on
    // run 33586116393) and its fresh concept ask, told both refusals, lands B.
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
    const { report, plan: built } = await buildVisuals({ segments: [vo("t1", text, 24)] }, {
      workDir: dir, ffmpeg: runFfmpeg, getWordTimestamps: noWords, visionClient: client, stockFetcher: fetcher,
    });

    const firstPass = report.stockWindows.filter((w) => w.takeId === "t1" && !w.retry);
    assert.equal(firstPass.length, 2, `fixture must lay out two first-pass windows: ${JSON.stringify(report.stockWindows)}`);
    const retryRow = report.stockWindows.find((w) => w.retry);
    assert.ok(retryRow, "a retry window exists");
    assert.equal(retryRow.startAt, firstPass[1].startAt, "the retry re-covers the failed window's span");
    assert.equal(fetcher.calls.length, 6, "window 0, window 1's words, concept one, concept two, the retry's re-search of the words, the retry's fresh concept");
    assert.deepEqual(fetcher.calls[4].keywords, fetcher.calls[1].keywords, "the retry searched the words again — a refused query is still worth its three reviewer calls");
    assert.deepEqual(report.leftoverRetries, { asked: 1, matched: 1 });
    assert.equal(retryRow.matched, true);
    assert.equal(retryRow.source, "concept");
    assert.deepEqual(retryRow.keywords, ["suburban house exterior"]);
    assert.equal(client.prompts.length, 3);
    assert.match(client.prompts[2], /ALREADY PROPOSED[\s\S]*pickup truck in a driveway[\s\S]*tractor in a field/, "the retry's ask carries BOTH earlier refusals");
    for (const b of built.segments[0].broll.filter((x) => x.kind === "beat")) {
      assert.ok(b.seconds <= BEAT_BRIDGE_MAX_SECONDS + 0.05, `a ${b.seconds}s beat survived`);
    }
  });

  test("refusals are scoped to the window's span: the retry over 8-32 is told window 1's refusals, not window 2's", async (t) => {
    if (!HAVE_FFMPEG) return t.skip("ffmpeg not installed");
    const dir = mkdtempSync(join(tmpdir(), "concept-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    process.env.PEXELS_API_KEY = "sweep-test-key";
    t.after(() => { delete process.env.PEXELS_API_KEY; });
    const clipA = join(dir, "a.mp4");
    const clipB = join(dir, "b.mp4");
    const clipC = join(dir, "c.mp4");
    runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=8", "-pix_fmt", "yuv420p", clipA]);
    runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=8", "-pix_fmt", "yuv420p", clipB]);
    runFfmpeg(["-y", "-f", "lavfi", "-i", "smptebars=size=320x180:rate=30:duration=24", "-pix_fmt", "yuv420p", clipC]);

    // A 40-second take, windows at 0-8 / 16-24 / 32-40. Window 0 wins with no
    // slack; window 1 is refused on its words and two concepts; window 2 is
    // refused on its words and then wins on a concept, no slack. The 24s beat
    // (8-32) becomes the retry. Its ask must carry window 1's two refused
    // scenes and NOT window 2's winning one (outside the span, and it won).
    const client = sequencedClient([
      { filmable: true, query: "pickup truck driveway", subject: "a pickup truck in a driveway" },   // window 1, ask 1
      { filmable: true, query: "farm tractor field", subject: "a tractor in a field" },              // window 1, ask 2
      { filmable: true, query: "mailbox sidewalk", subject: "a mailbox on a sidewalk" },            // window 2, ask 1 (wins)
      { filmable: true, query: "family living room", subject: "a family in a living room" },       // retry, ask 1 (wins)
    ]);
    const fetcher = fakeFetcher((opts, n) => {
      if (n === 1) return { clip: { path: clipA, seconds: opts.seconds, gradedSeconds: 8, contentHash: "hA", credit: { line: "a" }, query: opts.keywords[0] }, attempts: [] };
      if (opts.keywords[0] === "mailbox sidewalk") return { clip: { path: clipB, seconds: opts.seconds, gradedSeconds: 8, contentHash: "hB", credit: { line: "b" }, query: opts.keywords[0] }, attempts: [] };
      if (opts.keywords[0] === "family living room") return { clip: { path: clipC, seconds: opts.seconds, gradedSeconds: 24, contentHash: "hC", credit: { line: "c" }, query: opts.keywords[0] }, attempts: [] };
      return refused(opts.keywords[0], `Criterion 3 failure: refused ${opts.keywords[0]}`);
    });
    const text = "The kitchen has a big island and the yard has oak trees over the patio out back there. " +
      "Then the garage fits two cars and the driveway holds a boat beside the fence by the street. " +
      "Upstairs the bedrooms share a bathroom and the hallway ends at a small office with a window. " +
      "Down the block a park has a playground and a pond where kids feed ducks after school most days.";
    const { report } = await buildVisuals({ segments: [vo("t1", text, 40)] }, {
      workDir: dir, ffmpeg: runFfmpeg, getWordTimestamps: noWords, visionClient: client, stockFetcher: fetcher,
    });
    const retryRow = report.stockWindows.find((w) => w.retry);
    assert.ok(retryRow && retryRow.matched, `the retry landed: ${JSON.stringify(report.stockWindows)}`);
    assert.ok(retryRow.startAt < 16 && retryRow.startAt + retryRow.seconds > 24, `the retry spans window 1: ${JSON.stringify(retryRow)}`);
    const retryPrompt = client.prompts[client.prompts.length - 1];
    assert.match(retryPrompt, /pickup truck in a driveway[\s\S]*tractor in a field/, "window 1's refusals are in the retry's ask");
    // (the base prompt's own rules mention "a mailbox in front of a house" — match the proposal, not the word)
    assert.doesNotMatch(retryPrompt, /mailbox sidewalk|mailbox on a sidewalk|playground pond/, "window 2's scenes are outside the span and not listed");
  });
});
