/**
 * The script engine.
 *
 * The script IS the product here — a twelve-minute video has nothing else to
 * fall back on — so these tests are mostly about the gates that stop a bad one
 * shipping: the payment-figure ban, the banned AI tells, and the three-axis
 * bar. The model call is injected throughout, so none of this touches the API.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  validateScript,
  applyGuards,
  allTakes,
  allScriptText,
  scoresPass,
  scoreScript,
  generateScript,
  ON_CAMERA,
  VOICEOVER,
  PASS_MARK,
  describeLastCall,
  sampleAround,
} from "../src/yt-script.js";
import {
  findBannedTells,
  findBannedTellsIn,
  isUsableSample,
  getVoiceSamples,
  samplesFromTakes,
  buildVoiceBlock,
  MIN_SAMPLE_WORDS,
} from "../src/yt-voice.js";

/** A take whose text is exactly `words` words long, so length rules are exercised precisely. */
function takeText(words, seed = "here is the honest version of what that costs you every single month in this county") {
  const pool = seed.split(" ");
  const out = [];
  while (out.length < words) out.push(pool[out.length % pool.length]);
  return out.join(" ");
}

function take(id, mode = VOICEOVER, words = 40) {
  return { id, mode, text: takeText(words), direction: "walking shot if you can" };
}

function section(n, overrides = {}) {
  return {
    title: `Section ${n}`,
    takes: [take(`s${n}t1`), take(`s${n}t2`)],
    boundaryPull: "But the number that decides whether you can afford it is the one no listing shows you.",
    ...overrides,
  };
}

function validScript(overrides = {}) {
  return {
    title: "Moving to San Antonio: what it actually costs",
    hook: "Everyone quotes you the price. Nobody quotes you the number that decides if you can afford it.",
    promise: "By the end you'll know what a three hundred thousand dollar house here really costs you monthly.",
    sections: [section(1), section(2), section(3), section(4)],
    softCta: { mode: ON_CAMERA, text: takeText(30), direction: "energy up" },
    close: { mode: ON_CAMERA, text: takeText(40), direction: "look at the lens" },
    ...overrides,
  };
}

// ─── structure ──────────────────────────────────────────────────────────────

describe("validateScript", () => {
  test("a well-formed script passes", () => {
    const r = validateScript(validScript());
    assert.equal(r.valid, true, r.failures.join("; "));
  });

  test("rejects fewer than four sections", () => {
    const r = validateScript(validScript({ sections: [section(1), section(2)] }));
    assert.equal(r.valid, false);
    assert.ok(r.failures.some((f) => f.includes("sections")));
  });

  test("rejects more than seven sections", () => {
    const sections = Array.from({ length: 8 }, (_, i) => section(i + 1));
    assert.equal(validateScript(validScript({ sections })).valid, false);
  });

  test("rejects a title over 70 chars — YouTube truncates it", () => {
    const r = validateScript(validScript({ title: "x".repeat(71) }));
    assert.ok(r.failures.some((f) => f.includes("max 70")));
  });

  test("rejects a take with an unknown mode", () => {
    const s = validScript();
    s.sections[0].takes[0].mode = "NARRATION";
    const r = validateScript(s);
    assert.ok(r.failures.some((f) => f.includes("NARRATION")));
  });

  test("rejects a take too long to read off a phone", () => {
    const s = validScript();
    s.sections[1].takes[0].text = takeText(140);
    const r = validateScript(s);
    assert.ok(r.failures.some((f) => f.includes("split it")));
  });

  test("rejects a take too short to be worth a recording slot", () => {
    const s = validScript();
    s.sections[1].takes[0].text = "Too short.";
    const r = validateScript(s);
    assert.ok(r.failures.some((f) => f.includes("too short")));
  });

  test("requires a boundaryPull on every section — that is the retention mechanism", () => {
    const s = validScript();
    delete s.sections[2].boundaryPull;
    const r = validateScript(s);
    assert.ok(r.failures.some((f) => f.includes("boundaryPull")));
  });

  test("requires per-take direction — the kit is useless without it", () => {
    const s = validScript();
    delete s.sections[0].takes[1].direction;
    assert.ok(validateScript(s).failures.some((f) => f.includes("direction")));
  });

  test("does not throw on garbage", () => {
    assert.equal(validateScript(null).valid, false);
    assert.equal(validateScript("nope").valid, false);
  });
});

describe("allTakes", () => {
  test("returns every take in running order, with the CTA and close last", () => {
    const takes = allTakes(validScript());
    assert.equal(takes.length, 4 * 2 + 2);
    assert.equal(takes[takes.length - 1].id, "close");
    assert.equal(takes[takes.length - 2].id, "cta");
  });

  test("fills in missing ids rather than producing unmatchable takes", () => {
    const s = validScript();
    delete s.sections[0].takes[0].id;
    assert.equal(allTakes(s)[0].id, "s1t1");
  });
});

// ─── guards ─────────────────────────────────────────────────────────────────

describe("applyGuards", () => {
  test("finds a spoken monthly payment figure", () => {
    const s = validScript();
    s.sections[0].takes[0].text = `${takeText(20)} your payment would be $2,400 a month on that one`;
    assert.equal(applyGuards(s).paymentFigure.found, true);
  });

  test("a script that only PROMISES the breakdown is fine", () => {
    const s = validScript();
    s.close.text = "Text me and I'll send you the exact payment breakdown for the house you're looking at.";
    assert.equal(applyGuards(s).paymentFigure.found, false);
  });

  test("catches banned AI tells anywhere in the script", () => {
    const s = validScript();
    s.sections[2].takes[1].text = `This stunning neighbourhood is nestled right by the greenbelt ${takeText(20)}`;
    const tells = applyGuards(s).bannedTells.map((t) => t.label);
    assert.ok(tells.includes("stunning"));
    assert.ok(tells.includes("nestled"));
  });

  test("clean copy trips nothing", () => {
    const g = applyGuards(validScript());
    assert.equal(g.paymentFigure.found, false);
    assert.deepEqual(g.bannedTells, []);
  });

  test("does not mutate the input script", () => {
    const s = validScript();
    const before = JSON.stringify(s);
    applyGuards(s);
    assert.equal(JSON.stringify(s), before);
  });

  test("allScriptText reaches into every take", () => {
    const texts = allScriptText(validScript());
    assert.ok(texts.length >= 4 * 2);
    assert.ok(texts.some((t) => t.includes("Nobody quotes you")));
  });
});

// ─── banned tells ───────────────────────────────────────────────────────────

describe("findBannedTells", () => {
  test("catches the listing-copy vocabulary", () => {
    for (const bad of ["nestled", "boasts", "stunning", "charming", "a hidden gem", "look no further"]) {
      assert.ok(findBannedTells(`The place ${bad} here.`).length > 0, `missed "${bad}"`);
    }
  });

  test("catches the LLM constructions", () => {
    assert.ok(findBannedTells("Whether you're buying or renting, it matters.").length > 0);
    assert.ok(findBannedTells("In today's market, prices move.").length > 0);
    assert.ok(findBannedTells("Let's dive in.").length > 0);
    assert.ok(findBannedTells("It's important to note that taxes vary.").length > 0);
  });

  test("does NOT fire on ordinary speech", () => {
    const fine = [
      "Here's what that actually costs you every month.",
      "I'd rather show you the math than talk around it.",
      "That's the price. The payment is a different story.",
      "Most people move here for the space and stay for the taxes. Kidding. Sort of.",
    ];
    for (const line of fine) {
      assert.deepEqual(findBannedTells(line), [], `false positive on: ${line}`);
    }
  });

  test("dedupes across a whole script", () => {
    const hits = findBannedTellsIn(["stunning one", "stunning two", "nestled three"]);
    assert.equal(hits.length, 2);
  });

  test("tolerates non-strings", () => {
    assert.deepEqual(findBannedTells(null), []);
    assert.deepEqual(findBannedTellsIn([null, 42, undefined]), []);
  });
});

// ─── voice reference ────────────────────────────────────────────────────────

describe("voice reference — better none than noise", () => {
  test("a ten-word fragment is not a writing sample", () => {
    assert.equal(isUsableSample("Quick payment math prices 590,000, during a half percent down"), false);
  });

  test("a real narration passes", () => {
    const real =
      "So people ask me all the time what it actually costs to live out here versus Austin, " +
      "and the honest answer is that the sticker price is the smallest part of it.";
    assert.equal(isUsableSample(real), true);
  });

  test("a number-dense recitation is rejected even when long enough", () => {
    const numbers = Array.from({ length: 30 }, (_, i) => (i % 2 ? `$${i}00,000` : "and")).join(" ");
    assert.equal(isUsableSample(numbers), false);
  });

  test("the real posted-log corpus yields nothing usable, and that is handled", () => {
    // Every voiceover_transcript on record was truncated to ten words by
    // main.js, so the corpus is empty until the new full-length entries and the
    // recording ingest fill it. The writer must get NO voice block rather than
    // a block of fragments.
    const log = {
      posts: [
        { success: true, voiceover: false, voiceover_transcript: "Quick payment math prices 590,000, during a half percent down" },
        { success: true, voiceover: false, voiceover_transcript: "So thanks for watching." },
      ],
    };
    assert.deepEqual(getVoiceSamples(log), []);
    assert.equal(buildVoiceBlock(getVoiceSamples(log)), "");
  });

  test("picks up full-length narration once it exists, newest first", () => {
    // No digits in the filler: a word like "word1" is correctly rejected by the
    // digit-density filter, which is there to keep the payment-math narrations
    // out of the corpus.
    const long = (w) => Array.from({ length: MIN_SAMPLE_WORDS + 5 }, () => w).join(" ");
    const log = {
      posts: [
        { success: true, voiceover: false, voiceover_transcript: long("older") },
        { success: true, voiceover: false, voiceover_transcript: long("newer") },
      ],
    };
    const samples = getVoiceSamples(log, { limit: 2 });
    assert.equal(samples.length, 2);
    assert.ok(samples[0].startsWith("newer"), "newest sample should come first");
  });

  test("ignores the machine's OWN past narration", () => {
    const long = Array.from({ length: MIN_SAMPLE_WORDS + 5 }, () => "machine").join(" ");
    const log = { posts: [{ success: true, voiceover: true, voiceover_transcript: long }] };
    assert.deepEqual(getVoiceSamples(log), []);
  });

  test("recorded takes are a usable corpus too", () => {
    const long = Array.from({ length: MIN_SAMPLE_WORDS + 5 }, () => "spoken").join(" ");
    assert.equal(samplesFromTakes([{ transcript: long }, { transcript: "too short" }]).length, 1);
  });

  test("the voice block never quotes a sample it was not given", () => {
    assert.equal(buildVoiceBlock([]), "");
    assert.ok(buildVoiceBlock(["hello there friend"]).includes("hello there friend"));
  });
});

// ─── the bar ────────────────────────────────────────────────────────────────

describe("scoresPass — all three axes, no averaging", () => {
  test("passes only when every axis clears the bar", () => {
    assert.equal(scoresPass({ clarity: 8, retention: 8, authenticity: 8 }), true);
  });

  test("a brilliant script that loses people still fails", () => {
    assert.equal(scoresPass({ clarity: 10, retention: 7, authenticity: 10 }), false);
  });

  test("a gripping script that sounds like a robot still fails", () => {
    assert.equal(scoresPass({ clarity: 10, retention: 10, authenticity: 7 }), false);
  });
});

// ─── generation loop ────────────────────────────────────────────────────────

const TOPIC = { title: "Moving to San Antonio: what it actually costs", hook: "the payment gap", outline: "1. price 2. taxes" };

/** A scripted model: each call shifts to the next queued response. */
function scriptedModel(responses) {
  const calls = [];
  let i = 0;
  const fn = async (system, prompt) => {
    calls.push({ system, prompt });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return typeof r === "function" ? r() : r;
  };
  fn.calls = calls;
  return fn;
}

const goodScores = JSON.stringify({ clarity: 9, retention: 9, authenticity: 9, worst_problem: "", worst_boundary: "", fix: "" });
const badScores = JSON.stringify({ clarity: 9, retention: 5, authenticity: 9, worst_problem: "boundaries announce", worst_boundary: "Next up, taxes.", fix: "raise the stakes" });

describe("generateScript", () => {
  test("returns a passing script and reports its shape", async () => {
    const model = scriptedModel([JSON.stringify(validScript()), goodScores]);
    const result = await generateScript({ topic: TOPIC, modelCall: model });
    assert.equal(result.attemptsUsed, 1);
    assert.equal(result.regenerated, false);
    assert.equal(result.belowBar, false);
    assert.equal(result.takeCount, 10);
    assert.ok(result.estimatedMinutes > 0);
  });

  test("REGENERATES on a spoken payment figure rather than patching it", async () => {
    const bad = validScript();
    bad.sections[0].takes[0].text = `${takeText(20)} so your payment lands around $2,400 a month`;
    const model = scriptedModel([JSON.stringify(bad), JSON.stringify(validScript()), goodScores]);
    const result = await generateScript({ topic: TOPIC, modelCall: model });
    assert.equal(result.regenerated, true);
    const retryPrompt = model.calls[1].prompt;
    assert.ok(retryPrompt.includes("monthly payment figure"), "the retry must tell the writer what it did wrong");
  });

  test("REGENERATES on a banned AI tell, and says not to swap in a synonym", async () => {
    const bad = validScript();
    bad.sections[1].takes[0].text = `This stunning place ${takeText(20)}`;
    const model = scriptedModel([JSON.stringify(bad), JSON.stringify(validScript()), goodScores]);
    const result = await generateScript({ topic: TOPIC, modelCall: model });
    assert.equal(result.regenerated, true);
    assert.ok(model.calls[1].prompt.includes("do not swap in a synonym"));
  });

  test("regenerates on a failing retention score and quotes the weak boundary back", async () => {
    const model = scriptedModel([
      JSON.stringify(validScript()), badScores,
      JSON.stringify(validScript()), goodScores,
    ]);
    const result = await generateScript({ topic: TOPIC, modelCall: model });
    assert.equal(result.regenerated, true);
    assert.equal(result.attemptsUsed, 2);
    const retryPrompt = model.calls[2].prompt;
    assert.ok(retryPrompt.includes("RETENTION IS FAILING"));
    assert.ok(retryPrompt.includes("Next up, taxes."), "the weakest boundary should be quoted back");
  });

  test("regenerates on a structurally invalid draft without calling the critic", async () => {
    const model = scriptedModel([
      JSON.stringify({ title: "x", hook: "y" }),
      JSON.stringify(validScript()), goodScores,
    ]);
    const result = await generateScript({ topic: TOPIC, modelCall: model });
    // Three model calls: writer (malformed), writer (good), critic (once).
    // The malformed draft is never scored, so the critic is only paid for once.
    assert.equal(model.calls.length, 3);
    assert.equal(result.belowBar, false);
    assert.ok(model.calls[1].prompt.includes("structurally invalid"));
  });

  test("falls back to best-of when nothing clears the bar, and flags it", async () => {
    const model = scriptedModel([JSON.stringify(validScript()), badScores]);
    const result = await generateScript({ topic: TOPIC, maxRetries: 1, modelCall: model });
    assert.equal(result.belowBar, true);
    assert.equal(result.regenerated, true);
  });

  test("a critic outage degrades to unscored instead of taking the run down", async () => {
    const model = scriptedModel([JSON.stringify(validScript()), "the critic is having a day"]);
    const result = await generateScript({ topic: TOPIC, maxRetries: 0, modelCall: model });
    assert.equal(result.criticUnavailable, true);
    assert.equal(result.belowBar, true);
  });

  test("Peter's revision notes are passed to the writer and marked as overriding", async () => {
    const model = scriptedModel([JSON.stringify(validScript()), goodScores]);
    await generateScript({ topic: TOPIC, notes: "lead with the tax rate, not the price", modelCall: model });
    const prompt = model.calls[0].prompt;
    assert.ok(prompt.includes("lead with the tax rate"));
    assert.ok(prompt.includes("overrides anything above"));
  });

  test("voice samples reach the writer's system prompt", async () => {
    const sample = Array.from({ length: MIN_SAMPLE_WORDS + 5 }, () => "spoken").join(" ");
    const model = scriptedModel([JSON.stringify(validScript()), goodScores]);
    await generateScript({ topic: TOPIC, voiceSamples: [sample], modelCall: model });
    assert.ok(model.calls[0].system.includes("HOW PETER ACTUALLY TALKS"));
    assert.ok(model.calls[0].system.includes(sample));
  });

  test("with no usable samples the writer gets no voice block at all", async () => {
    const model = scriptedModel([JSON.stringify(validScript()), goodScores]);
    await generateScript({ topic: TOPIC, voiceSamples: [], modelCall: model });
    assert.ok(!model.calls[0].system.includes("HOW PETER ACTUALLY TALKS"));
  });

  test("the banned list is always in the writer's instructions", async () => {
    const model = scriptedModel([JSON.stringify(validScript()), goodScores]);
    await generateScript({ topic: TOPIC, modelCall: model });
    assert.ok(model.calls[0].system.includes("nestled"));
    assert.ok(model.calls[0].system.includes("three adjectives in a row"));
  });

  test("refuses a topic with no title rather than inventing one", async () => {
    await assert.rejects(() => generateScript({ topic: {}, modelCall: scriptedModel(["{}"]) }));
  });
});

describe("scoreScript", () => {
  test("clamps out-of-range scores from the model", async () => {
    const model = scriptedModel([JSON.stringify({ clarity: 99, retention: -4, authenticity: "8" })]);
    const s = await scoreScript(validScript(), model);
    assert.equal(s.clarity, 10);
    assert.equal(s.retention, 1);
    assert.equal(s.authenticity, 8);
  });

  test("retries once on unparseable output before giving up", async () => {
    const model = scriptedModel(["not json", goodScores]);
    const s = await scoreScript(validScript(), model);
    assert.equal(s.retention, 9);
    assert.equal(model.calls.length, 2);
  });

  test("an unscored result can never pass the bar", async () => {
    const model = scriptedModel(["nope", "still nope"]);
    const s = await scoreScript(validScript(), model);
    assert.equal(s.unscored, true);
    assert.equal(scoresPass(s), false);
  });
});

describe("an unscored script must not reach a recording kit", () => {
  // The first live run delivered a kit for a script the critic never scored —
  // three unparseable model responses in a row degraded to best-of with a total
  // of 0, and the kit went out anyway. The carousel's "ship the best we have"
  // degradation is right for a daily post; here the next thing that happens is
  // Peter spending a recording session on it.
  test("criticUnavailable and belowBar are both surfaced on the result", async () => {
    const model = scriptedModel([JSON.stringify(validScript()), "the critic is down"]);
    const result = await generateScript({ topic: TOPIC, maxRetries: 0, modelCall: model });
    assert.equal(result.criticUnavailable, true);
    assert.equal(result.belowBar, true, "an unscored script must also read as below the bar");
  });

  test("a below-bar-but-scored script is distinguishable from an unscored one", async () => {
    const model = scriptedModel([JSON.stringify(validScript()), badScores]);
    const result = await generateScript({ topic: TOPIC, maxRetries: 0, modelCall: model });
    assert.equal(result.belowBar, true);
    assert.equal(result.criticUnavailable, false, "this one WAS judged, it just failed");
    assert.ok(result.scores.retention > 0);
  });

  test("a passing script is neither", async () => {
    const model = scriptedModel([JSON.stringify(validScript()), goodScores]);
    const result = await generateScript({ topic: TOPIC, modelCall: model });
    assert.equal(result.belowBar, false);
    assert.equal(result.criticUnavailable, false);
  });
});

describe("model-call diagnostics", () => {
  test("describeLastCall reports something before any call is made", () => {
    assert.equal(typeof describeLastCall(), "string");
  });
});

describe("sampleAround — a position is not a diagnosis", () => {
  test("brackets the failure point so the bad character is visible", () => {
    // The real shape: a double quote inside prose ends the string early.
    const raw = '{"takes":[{"text":"people call it "the north side" here"}]}';
    const pos = raw.indexOf('"the north side"') + 4;
    const out = sampleAround(raw, `Expected ',' or ']' after array element in JSON at position ${pos}`, 30);
    assert.match(out, />>>HERE<<</);
    assert.ok(out.includes("north side"), "the offending text must be in the sample");
  });

  test("falls back to the head of the output when the message has no position", () => {
    const out = sampleAround("abcdefghij", "no JSON object in model output", 3);
    assert.equal(out, "abcdef");
  });

  test("returns null rather than throwing on empty input", () => {
    assert.equal(sampleAround("", "position 5"), null);
    assert.equal(sampleAround(null, "position 5"), null);
  });

  test("clamps at both ends near the boundaries", () => {
    assert.doesNotThrow(() => sampleAround("short", "position 2", 999));
  });
});

describe("generateScript — a total failure carries its evidence", () => {
  const topic = { title: "T", hook: "h", outline: "a\nb\nc\nd" };

  test("attaches every attempt's failure to the thrown error", async () => {
    // Nothing parseable, ever. Three attempts, then it gives up.
    const model = async () => "this is not json at all";
    const err = await generateScript({ topic, modelCall: model }).then(
      () => null,
      (e) => e
    );
    assert.ok(err, "must throw when no draft survives");
    assert.match(err.message, /no usable draft/);
    assert.equal(err.attemptFailures.length, 3, "one record per attempt");
    assert.ok(err.attemptFailures.every((f) => f.kind === "unparseable"));
  });

  test("records structure failures verbatim, with the section count", async () => {
    // Parses fine, but has too few sections to be valid.
    const thin = JSON.stringify({ title: "T", hook: "h", promise: "p", sections: [], softCta: {}, close: {} });
    const err = await generateScript({ topic, modelCall: async () => thin }).then(
      () => null,
      (e) => e
    );
    assert.ok(err.attemptFailures.every((f) => f.kind === "structure"));
    assert.ok(err.attemptFailures[0].failures.some((f) => /sections/.test(f)));
    assert.equal(err.attemptFailures[0].sectionCount, 0);
  });
});
