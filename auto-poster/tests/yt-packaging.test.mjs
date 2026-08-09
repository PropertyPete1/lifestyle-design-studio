/**
 * Packaging.
 *
 * Two things here are hard failures rather than style: YouTube's own limits,
 * and the chapter rules — a chapter list under three markers, or one whose
 * first marker is not 00:00, silently disables chapters for the entire video
 * and leaves the timestamps sitting in the description looking broken.
 *
 * And one thing is deliberately absent: a phone number. There isn't one in this
 * codebase, and inventing one puts a stranger's number in a published
 * description.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildDescription,
  buildPinnedComment,
  buildTags,
  validatePackaging,
  applyGuards,
  scorePackaging,
  scoresPass,
  buildPackaging,
  ctaConfig,
  TITLE_MAX,
  DESCRIPTION_MAX,
  TAGS_TOTAL_MAX,
  MIN_CHAPTERS,
} from "../src/yt-packaging.js";

const CHAPTERS = [
  { seconds: 0, timestamp: "0:00", title: "The payment gap" },
  { seconds: 120, timestamp: "2:00", title: "Neighbourhoods" },
  { seconds: 300, timestamp: "5:00", title: "What I'd do" },
];

const SCRIPT = {
  title: "Moving to San Antonio: what $300k actually gets you",
  hook: "Everyone quotes you the price. Nobody quotes you the number that decides if you can afford it.",
  promise: "By the end you'll know what a three hundred thousand dollar house here really costs monthly.",
};

const TOPIC = {
  title: "Moving to San Antonio: what $300k actually gets you",
  query: "moving to san antonio",
  market: "san_antonio",
  intent: "relocation",
};

function withCta(fn) {
  const prevPhone = process.env.YT_TEXT_NUMBER;
  const prevLinks = process.env.YT_LINKS_URL;
  process.env.YT_TEXT_NUMBER = "210-555-0142";
  process.env.YT_LINKS_URL = "https://lifestyledesignrealty.com/links";
  try {
    return fn();
  } finally {
    if (prevPhone === undefined) delete process.env.YT_TEXT_NUMBER; else process.env.YT_TEXT_NUMBER = prevPhone;
    if (prevLinks === undefined) delete process.env.YT_LINKS_URL; else process.env.YT_LINKS_URL = prevLinks;
  }
}

describe("buildDescription", () => {
  test("opens with the hook — YouTube shows two lines before 'more'", () => {
    const { text } = buildDescription({ hook: SCRIPT.hook, promise: SCRIPT.promise, chapters: CHAPTERS, cta: { phone: null, links: null } });
    assert.ok(text.startsWith("Everyone quotes you the price"), "administrative lines must not eat the visible ones");
  });

  test("lists every chapter with its timestamp", () => {
    const { text } = buildDescription({ hook: "h", chapters: CHAPTERS, cta: { phone: null, links: null } });
    for (const c of CHAPTERS) {
      assert.ok(text.includes(`${c.timestamp} ${c.title}`), `missing chapter ${c.title}`);
    }
  });

  test("omits the chapter block entirely when there are too few", () => {
    const { text } = buildDescription({ hook: "h", chapters: CHAPTERS.slice(0, 2), cta: { phone: null, links: null } });
    assert.ok(!text.includes("CHAPTERS"), "a two-marker list is worse than none");
  });

  test("carries the comment-keyword offer", () => {
    const { text } = buildDescription({ hook: "h", chapters: CHAPTERS, keyword: "MATH", cta: { phone: null, links: null } });
    assert.ok(text.includes("MATH"));
    assert.ok(text.includes("payment breakdown"));
  });

  test("REPORTS a missing phone and links page instead of inventing them", () => {
    const { text, missing } = buildDescription({ hook: "h", chapters: CHAPTERS, cta: { phone: null, links: null } });
    assert.equal(missing.length, 2);
    assert.ok(missing.some((m) => m.includes("YT_TEXT_NUMBER")));
    assert.ok(missing.some((m) => m.includes("YT_LINKS_URL")));
    // And nothing placeholder-shaped leaks into the copy.
    assert.ok(!/\[|\{|TODO|XXX|PHONE/i.test(text), "a placeholder reached the description");
  });

  test("includes them when configured", () => {
    const { text, missing } = buildDescription({
      hook: "h", chapters: CHAPTERS,
      cta: { phone: "210-555-0142", links: "https://example.com/links" },
    });
    assert.deepEqual(missing, []);
    assert.ok(text.includes("210-555-0142"));
    assert.ok(text.includes("https://example.com/links"));
  });

  test("ctaConfig reads the environment and defaults to null, never to a fake number", () => {
    const bare = ctaConfig();
    assert.ok(bare.phone === null || typeof bare.phone === "string");
    withCta(() => {
      assert.equal(ctaConfig().phone, "210-555-0142");
    });
  });
});

describe("buildPinnedComment", () => {
  test("leads with the offer, not with the phone number", () => {
    const c = buildPinnedComment({ keyword: "MATH", cta: { phone: "210-555-0142" } });
    assert.ok(c.startsWith("Comment MATH"));
  });

  test("omits the number when there isn't one", () => {
    const c = buildPinnedComment({ keyword: "MATH", cta: { phone: null } });
    assert.ok(!c.includes("text"));
  });
});

describe("buildTags", () => {
  test("leads with the actual search query", () => {
    assert.equal(buildTags({ query: "moving to san antonio", market: "san_antonio", intent: "relocation" })[0], "moving to san antonio");
  });

  test("picks city tags from the market", () => {
    const austin = buildTags({ query: "q", market: "austin", intent: "relocation" });
    assert.ok(austin.some((t) => t.includes("austin")));
    assert.ok(!austin.some((t) => t.includes("san antonio real estate")));
  });

  test("never exceeds YouTube's 500-character total — it silently drops the overflow", () => {
    const tags = buildTags({
      query: "moving to san antonio",
      market: "san_antonio",
      intent: "relocation",
      extra: Array.from({ length: 100 }, (_, i) => `filler tag number ${i} for texas buyers`),
    });
    assert.ok(tags.join(",").length <= TAGS_TOTAL_MAX);
  });

  test("dedupes", () => {
    const tags = buildTags({ query: "moving to san antonio", market: "san_antonio", intent: "relocation" });
    assert.equal(new Set(tags).size, tags.length);
  });
});

describe("validatePackaging — YouTube's limits are hard failures", () => {
  const base = () => ({
    title: SCRIPT.title,
    description: buildDescription({ hook: "h", chapters: CHAPTERS, cta: { phone: null, links: null } }).text,
    tags: ["a", "b"],
    chapters: CHAPTERS,
  });

  test("a well-formed package passes", () => {
    const r = validatePackaging(base());
    assert.equal(r.valid, true, r.failures.join("; "));
  });

  test("rejects a title over YouTube's limit", () => {
    const pkg = { ...base(), title: "x".repeat(TITLE_MAX + 1) };
    assert.ok(validatePackaging(pkg).failures.some((f) => f.includes(String(TITLE_MAX))));
  });

  test("rejects a description over the limit", () => {
    const pkg = { ...base(), description: "x".repeat(DESCRIPTION_MAX + 1) };
    assert.ok(validatePackaging(pkg).failures.some((f) => f.includes(String(DESCRIPTION_MAX))));
  });

  test("rejects a chapter list that does not start at 0:00", () => {
    const shifted = CHAPTERS.map((c, i) => (i === 0 ? { ...c, seconds: 12, timestamp: "0:12" } : c));
    const desc = buildDescription({ hook: "h", chapters: shifted, cta: { phone: null, links: null } }).text;
    const r = validatePackaging({ ...base(), chapters: shifted, description: desc });
    assert.ok(r.failures.some((f) => f.includes("0:00")));
  });

  test("rejects chapters that do not advance", () => {
    const stuck = [CHAPTERS[0], { ...CHAPTERS[1], seconds: 0, timestamp: "0:00" }, CHAPTERS[2]];
    const desc = buildDescription({ hook: "h", chapters: stuck, cta: { phone: null, links: null } }).text;
    const r = validatePackaging({ ...base(), chapters: stuck, description: desc });
    assert.ok(r.failures.some((f) => f.includes("advance")));
  });

  test("rejects a chapter that is not actually in the description", () => {
    const r = validatePackaging({ ...base(), description: "no timestamps here at all" });
    assert.ok(r.failures.some((f) => f.includes("not in the description")));
  });

  test("rejects fewer than the minimum markers", () => {
    const two = CHAPTERS.slice(0, 2);
    const desc = buildDescription({ hook: "h", chapters: two, cta: { phone: null, links: null } }).text;
    const r = validatePackaging({ ...base(), chapters: two, description: desc });
    assert.ok(r.failures.some((f) => f.includes(String(MIN_CHAPTERS))));
  });
});

describe("guards", () => {
  test("catches a payment figure in the description", () => {
    const g = applyGuards({ title: "t", description: "your payment is about $2,400 a month", tags: [] });
    assert.equal(g.paymentFigure.found, true);
  });

  test("catches banned phrasing in the title", () => {
    const g = applyGuards({ title: "This stunning San Antonio home", description: "d", tags: [] });
    assert.ok(g.bannedTells.some((t) => t.label === "stunning"));
  });

  test("scans the tags too", () => {
    const g = applyGuards({ title: "t", description: "d", tags: ["stunning homes"] });
    assert.ok(g.bannedTells.length > 0);
  });

  test("clean packaging trips nothing", () => {
    const g = applyGuards({
      title: SCRIPT.title,
      description: buildDescription({ hook: SCRIPT.hook, chapters: CHAPTERS, cta: { phone: null, links: null } }).text,
      tags: ["moving to san antonio"],
    });
    assert.equal(g.paymentFigure.found, false);
    assert.deepEqual(g.bannedTells, []);
  });
});

// ─── the critic ─────────────────────────────────────────────────────────────

function scriptedModel(responses) {
  const calls = [];
  let i = 0;
  const fn = async (system, prompt) => {
    // The D5/D6 generators (SEO opener, chapter rewrite) run before the
    // title/critic sequence these fixtures script. Answer them with an empty
    // object — both fall back cleanly — WITHOUT consuming the sequence, so
    // every existing expectation about call order still holds.
    if (/first two lines of a YouTube description/i.test(system) || /rewrite YouTube chapter titles/i.test(system)) {
      return "{}";
    }
    calls.push({ system, prompt });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return typeof r === "function" ? r() : r;
  };
  fn.calls = calls;
  return fn;
}

const good = JSON.stringify({ searchability: 9, promise_match: 9, worst_problem: "", fix: "" });
const overpromised = JSON.stringify({
  searchability: 9, promise_match: 4,
  worst_problem: "the title promises a comparison the chapters never make",
  fix: "name what the video actually covers",
});

describe("scorePackaging", () => {
  test("clamps out-of-range scores", async () => {
    const s = await scorePackaging({ title: "t" }, scriptedModel([JSON.stringify({ searchability: 99, promise_match: -3 })]));
    assert.equal(s.searchability, 10);
    assert.equal(s.promise_match, 1);
  });

  test("retries once on unparseable output", async () => {
    const model = scriptedModel(["nope", good]);
    assert.equal((await scorePackaging({ title: "t" }, model)).searchability, 9);
    assert.equal(model.calls.length, 2);
  });

  test("an unscored result can never pass", async () => {
    const s = await scorePackaging({ title: "t" }, scriptedModel(["nope", "still nope"]));
    assert.equal(s.unscored, true);
    assert.equal(scoresPass(s), false);
  });

  test("both axes must clear the bar", () => {
    assert.equal(scoresPass({ searchability: 10, promise_match: 7 }), false);
    assert.equal(scoresPass({ searchability: 8, promise_match: 8 }), true);
  });
});

describe("buildPackaging", () => {
  test("packages a video that passes first time", async () => {
    const model = scriptedModel([good]);
    const pkg = await buildPackaging({ topic: TOPIC, script: SCRIPT, chapters: CHAPTERS, modelCall: model });
    assert.equal(pkg.title, SCRIPT.title);
    assert.ok(pkg.description.includes("0:00 The payment gap"));
    assert.ok(pkg.tags.length > 0);
    assert.ok(pkg.pinnedComment.includes("MATH"));
    assert.equal(pkg.regenerated, false);
  });

  test("RETITLES when the title promises more than the chapters deliver", async () => {
    const model = scriptedModel([overpromised, "Moving to San Antonio: the tax number nobody quotes", good]);
    const pkg = await buildPackaging({ topic: TOPIC, script: SCRIPT, chapters: CHAPTERS, modelCall: model });
    assert.equal(pkg.regenerated, true);
    assert.equal(pkg.title, "Moving to San Antonio: the tax number nobody quotes");
    // The retitle prompt must show the model what the video actually covers.
    assert.ok(model.calls[1].prompt.includes("The payment gap"));
    assert.ok(model.calls[1].prompt.includes("PROMISE MATCH IS FAILING"));
  });

  test("a retitle can never exceed YouTube's title limit", async () => {
    const model = scriptedModel([overpromised, "x".repeat(500), good]);
    const pkg = await buildPackaging({ topic: TOPIC, script: SCRIPT, chapters: CHAPTERS, modelCall: model });
    assert.ok(pkg.title.length <= TITLE_MAX);
  });

  test("REFUSES to package a payment figure", async () => {
    const bad = { ...SCRIPT, hook: "Your payment lands around $2,400 a month." };
    await assert.rejects(
      () => buildPackaging({ topic: TOPIC, script: bad, chapters: CHAPTERS, modelCall: scriptedModel([good]) }),
      /payment figure/
    );
  });

  test("surfaces the missing CTA config on the package for the review", async () => {
    const pkg = await buildPackaging({ topic: TOPIC, script: SCRIPT, chapters: CHAPTERS, modelCall: scriptedModel([good]) });
    assert.ok(Array.isArray(pkg.missingCta));
  });

  test("falls back to best-of and flags it when nothing clears the bar", async () => {
    const model = scriptedModel([overpromised, "Another title for San Antonio buyers"]);
    const pkg = await buildPackaging({ topic: TOPIC, script: SCRIPT, chapters: CHAPTERS, maxRetries: 1, modelCall: model });
    assert.equal(pkg.belowBar, true);
  });

  test("refuses a topic with no title", async () => {
    await assert.rejects(() => buildPackaging({ topic: {}, script: SCRIPT, modelCall: scriptedModel([good]) }));
  });
});
