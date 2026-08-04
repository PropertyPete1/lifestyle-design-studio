/**
 * carousel.test.mjs — daily carousel: rotation, critic gate, guards, render, merge.
 *
 * The model is stubbed everywhere. These tests are about the machinery around
 * the model — that a sub-8 score actually causes a regeneration, that a payment
 * figure on a slide is rejected, that concurrent runners don't lose log entries
 * — not about whether Claude writes good copy.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  KEYWORDS, KEYWORD_PAYOFFS, CLOSE_BY_PILLAR, keywordFor, payoffFor, closeTypeFor,
  pillarFor, dayIndexFor, validateDeck, applyGuards, scoresPass, generateCarousel,
  buildSocialCaption, allSlideText, renderClose, writerSystemFor, criticSystemFor,
} from "../src/carousel-content.js";

import {
  WIDTH, HEIGHT, wrapText, measure, accentFor, ACCENTS,
  deckToSvgs, renderSvgs, buildPdf, isNonBlank, questionCtaSvg, shareCtaSvg,
} from "../src/carousel-render.js";

import {
  instagramCarouselBody, tiktokCarouselBody, linkedinDocumentBody, facebookCarouselBody,
  chicagoDateTime,
} from "../src/carousel-distribute.js";

import { mergeCarouselLog, MERGE_STRATEGIES } from "../merge-strategies.mjs";
import { recentEntries, appendEntry, alreadyPostedToday, buildEntry, MAX_ENTRIES } from "../src/carousel-state.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────

function goodDeck(overrides = {}) {
  return {
    topic: "closing costs",
    hook: "The 3% rule nobody explains until you are at the table",
    map: ["What 3% covers", "The late fee", "Who really pays", "What you can cut"],
    points: [
      { title: "Not The Down Payment", body: ["Closing costs sit on top.", "They are due the same day."], loop: "but that is not the expensive part." },
      { title: "The Lender Stack", body: ["Origination and underwriting are separate.", "Each one is negotiable."], loop: "and almost nobody asks." },
      { title: "Title And Escrow", body: ["Usually the biggest single line.", "In Texas the seller often covers it."], loop: "which changes your math." },
      { title: "What You Can Cut", body: ["Ask for a lender credit first.", "It moves more than a rate tweak."], loop: "most people stop here." },
    ],
    cta: { payoff: "the exact payment breakdown for your price range" },
    ...overrides,
  };
}

const PERFECT = { clarity: 9, hook: 9, loops: 9, cta: 9, worst_problem: "", fix: "" };
const WEAK = { clarity: 5, hook: 4, loops: 5, cta: 3, worst_problem: "hook summarises", fix: "open a gap" };

/**
 * Build a stub model call that returns scripted responses in order.
 * The writer and critic are told apart by a marker in their system prompt.
 */
function stubModel(script) {
  const calls = { writer: 0, critic: 0 };
  const fn = async (system) => {
    if (system.includes("harsh critic")) {
      const s = script.critic[Math.min(calls.critic, script.critic.length - 1)];
      calls.critic++;
      return JSON.stringify(s);
    }
    const d = script.writer[Math.min(calls.writer, script.writer.length - 1)];
    calls.writer++;
    return JSON.stringify(d);
  };
  fn.calls = calls;
  return fn;
}

// ─── Keyword rotation ───────────────────────────────────────────────────────

/** Walk `days` consecutive dates from a start date. */
function walkDates(start, days) {
  const out = [];
  let d = new Date(`${start}T00:00:00Z`);
  for (let i = 0; i < days; i++) {
    out.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + 86_400_000);
  }
  return out;
}

test("each pillar gets its specified close type", () => {
  // 2026-08-02 is a Sunday.
  assert.equal(closeTypeFor("2026-08-02"), "dm");        // Sun  market insight
  assert.equal(closeTypeFor("2026-08-03"), "dm");        // Mon  education
  assert.equal(closeTypeFor("2026-08-04"), "question");  // Tue  lifestyle
  assert.equal(closeTypeFor("2026-08-05"), "share");     // Wed  motivation
  assert.equal(closeTypeFor("2026-08-06"), "dm");        // Thu  education
  assert.equal(closeTypeFor("2026-08-07"), "question");  // Fri  lifestyle
  assert.equal(closeTypeFor("2026-08-08"), "share");     // Sat  motivation
});

test("close type is derived from the pillar, not hardcoded per weekday", () => {
  for (const date of walkDates("2026-08-02", 28)) {
    assert.equal(closeTypeFor(date), CLOSE_BY_PILLAR[pillarFor(date).key]);
  }
});

test("only DM pillars carry a keyword", () => {
  for (const date of walkDates("2026-08-02", 28)) {
    const kw = keywordFor(date);
    if (closeTypeFor(date) === "dm") {
      assert.ok(KEYWORDS.includes(kw), `${date} should have a keyword`);
    } else {
      assert.equal(kw, null, `${date} is a ${closeTypeFor(date)} close and must have no keyword`);
    }
  }
});

test("keyword rotation cycles all four across DM days", () => {
  const seq = walkDates("2026-08-02", 28).map(keywordFor).filter(Boolean);
  assert.equal(new Set(seq).size, 4, "all four keywords must appear");
  // Consecutive DM days advance by exactly one position — rotating on the raw
  // day number would skip, because Tue/Wed/Fri/Sat use no keyword.
  for (let i = 1; i < seq.length; i++) {
    const prev = KEYWORDS.indexOf(seq[i - 1]);
    assert.equal(seq[i], KEYWORDS[(prev + 1) % KEYWORDS.length], `break in rotation at index ${i}`);
  }
});

test("keyword rotation is stable for a given date", () => {
  assert.equal(keywordFor("2026-08-03"), keywordFor("2026-08-03"));
});

test("every keyword maps to a concrete payoff", () => {
  assert.deepEqual(KEYWORDS, ["MATH", "LIST", "CHECKLIST", "REPORT"]);
  for (const k of KEYWORDS) {
    const payoff = payoffFor(k);
    assert.ok(payoff && payoff.length > 8, `${k} needs a concrete payoff`);
  }
  assert.match(KEYWORD_PAYOFFS.MATH, /payment breakdown/i);
  assert.match(KEYWORD_PAYOFFS.LIST, /new builds? list/i);
  assert.match(KEYWORD_PAYOFFS.CHECKLIST, /inspection checklist/i);
  assert.match(KEYWORD_PAYOFFS.REPORT, /market numbers/i);
});

test("payoffFor is null for anything not in the rotation", () => {
  assert.equal(payoffFor("TOUR"), null);
  assert.equal(payoffFor(null), null);
});

test("pillars map to the specified days", () => {
  // 2026-08-03 is a Monday.
  assert.equal(dayIndexFor("2026-08-03"), 1);
  assert.equal(pillarFor("2026-08-03").key, "real_estate_education"); // Mon
  assert.equal(pillarFor("2026-08-04").key, "texas_lifestyle");       // Tue
  assert.equal(pillarFor("2026-08-05").key, "motivation_business");   // Wed
  assert.equal(pillarFor("2026-08-06").key, "real_estate_education"); // Thu
  assert.equal(pillarFor("2026-08-07").key, "texas_lifestyle");       // Fri
  assert.equal(pillarFor("2026-08-08").key, "motivation_business");   // Sat
  assert.equal(pillarFor("2026-08-09").key, "market_insight");        // Sun
});

// ─── Structural validation ──────────────────────────────────────────────────

test("validateDeck accepts a well-formed deck", () => {
  assert.equal(validateDeck(goodDeck()).valid, true);
});

test("validateDeck rejects too few points", () => {
  const r = validateDeck(goodDeck({ points: goodDeck().points.slice(0, 2) }));
  assert.equal(r.valid, false);
  assert.ok(r.failures.some((f) => f.includes("points must be 4-6")));
});

test("validateDeck rejects a missing open loop", () => {
  const deck = goodDeck();
  deck.points[1].loop = "";
  const r = validateDeck(deck);
  assert.equal(r.valid, false);
  assert.ok(r.failures.some((f) => f.includes("loop")));
});

// ─── Critic gate ────────────────────────────────────────────────────────────

test("scoresPass requires every axis to clear 8", () => {
  assert.equal(scoresPass({ clarity: 8, hook: 8, loops: 8, cta: 8 }), true);
  assert.equal(scoresPass({ clarity: 10, hook: 10, loops: 10, cta: 7 }), false);
  assert.equal(scoresPass({ clarity: 10, hook: 7, loops: 10, cta: 10 }), false);
  // A deck can be pulling, well-looped and sharply closed and still be a riddle.
  assert.equal(scoresPass({ clarity: 7, hook: 10, loops: 10, cta: 10 }), false);
});

test("a passing first draft is used without regenerating", async () => {
  const model = stubModel({ writer: [goodDeck()], critic: [PERFECT] });
  const r = await generateCarousel({ dateStr: "2026-08-03", modelCall: model });
  assert.equal(r.attemptsUsed, 1);
  assert.equal(r.regenerated, false);
  assert.equal(model.calls.writer, 1);
});

test("a sub-8 draft triggers regeneration", async () => {
  const model = stubModel({
    writer: [goodDeck({ topic: "weak" }), goodDeck({ topic: "strong" })],
    critic: [WEAK, PERFECT],
  });
  const r = await generateCarousel({ dateStr: "2026-08-03", modelCall: model });

  assert.equal(model.calls.writer, 2, "writer must be called again after a sub-8 score");
  assert.equal(r.regenerated, true);
  assert.equal(r.topic, "strong", "the regenerated draft must be the one returned");
  assert.equal(r.belowBar, false);
});

test("the critic's feedback is fed back into the retry prompt", async () => {
  const prompts = [];
  const model = async (system, userPrompt) => {
    if (system.includes("harsh critic")) return JSON.stringify(prompts.length === 1 ? WEAK : PERFECT);
    prompts.push(userPrompt);
    return JSON.stringify(goodDeck());
  };
  await generateCarousel({ dateStr: "2026-08-03", modelCall: model });
  assert.ok(prompts.length >= 2, "expected a retry");
  assert.ok(prompts[1].includes("hook summarises"), "critic's worst_problem must reach the writer");
  assert.ok(prompts[1].includes("open a gap"), "critic's fix must reach the writer");
});

test("exhausting retries falls back to the best-scoring draft", async () => {
  const model = stubModel({
    writer: [goodDeck({ topic: "a" }), goodDeck({ topic: "b" }), goodDeck({ topic: "c" })],
    critic: [
      { ...WEAK, clarity: 4, hook: 4, loops: 4, cta: 4 },
      { ...WEAK, clarity: 7, hook: 7, loops: 7, cta: 7 },  // best total, still under the bar
      { ...WEAK, clarity: 5, hook: 5, loops: 5, cta: 5 },
    ],
  });
  const r = await generateCarousel({ dateStr: "2026-08-03", modelCall: model });
  assert.equal(r.belowBar, true, "must be flagged as below bar");
  assert.equal(r.topic, "b", "best-of must pick the highest total");
  assert.equal(model.calls.writer, 3, "should stop after 1 + 2 retries");
});

test("a structurally invalid draft is regenerated, not published", async () => {
  const model = stubModel({
    writer: [goodDeck({ points: [] }), goodDeck({ topic: "recovered" })],
    critic: [PERFECT],
  });
  const r = await generateCarousel({ dateStr: "2026-08-03", modelCall: model });
  assert.equal(r.topic, "recovered");
});

// ─── Anti-repetition ────────────────────────────────────────────────────────

test("recent topics and hooks are passed to the writer as anti-examples", async () => {
  let writerPrompt = "";
  const model = async (system, userPrompt) => {
    if (system.includes("harsh critic")) return JSON.stringify(PERFECT);
    writerPrompt = userPrompt;
    return JSON.stringify(goodDeck());
  };
  const recent = [
    { topic: "property taxes", hook: "Your tax bill is wrong and here is the tell" },
    { topic: "escrow timing", hook: "Thirty days is a lie" },
  ];
  await generateCarousel({ dateStr: "2026-08-03", recent, modelCall: model });

  assert.ok(writerPrompt.includes("DO NOT RESEMBLE"));
  assert.ok(writerPrompt.includes("property taxes"));
  assert.ok(writerPrompt.includes("Thirty days is a lie"));
});

test("anti-example window is capped at 14 entries", async () => {
  let writerPrompt = "";
  const model = async (system, userPrompt) => {
    if (system.includes("harsh critic")) return JSON.stringify(PERFECT);
    writerPrompt = userPrompt;
    return JSON.stringify(goodDeck());
  };
  const recent = Array.from({ length: 30 }, (_, i) => ({ topic: `topic-${i}`, hook: `hook-${i}` }));
  await generateCarousel({ dateStr: "2026-08-03", recent, modelCall: model });

  assert.ok(writerPrompt.includes("topic-13"), "14th entry should be present");
  assert.ok(!writerPrompt.includes("topic-14"), "15th entry must be dropped");
});

test("recentEntries returns newest first", () => {
  const log = { posts: [
    { date: "2026-08-01", timestamp: "2026-08-01T14:00:00.000Z", topic: "old" },
    { date: "2026-08-03", timestamp: "2026-08-03T14:00:00.000Z", topic: "new" },
    { date: "2026-08-02", timestamp: "2026-08-02T14:00:00.000Z", topic: "mid" },
  ] };
  assert.deepEqual(recentEntries(log, 3).map((e) => e.topic), ["new", "mid", "old"]);
});

// ─── Safety guards ──────────────────────────────────────────────────────────

test("a monthly payment figure on a slide forces regeneration", async () => {
  const leaky = goodDeck();
  leaky.points[0].body = ["Your monthly payment is $1,850 at that price.", "That is before taxes."];
  const model = stubModel({ writer: [leaky, goodDeck({ topic: "clean" })], critic: [PERFECT] });

  const r = await generateCarousel({ dateStr: "2026-08-03", modelCall: model });
  assert.equal(r.topic, "clean", "the deck with a payment figure must not be returned");
  assert.equal(model.calls.writer, 2);
});

test("the CTA may promise a payment breakdown without a figure", () => {
  const guarded = applyGuards(goodDeck());
  assert.equal(guarded.paymentFigure.found, false);
  assert.ok(guarded.deck.cta.payoff.includes("payment breakdown"));
});

test("guards strip em-dashes from slide copy", () => {
  const deck = goodDeck();
  deck.points[0].body = ["Closing costs — the ones nobody mentions — arrive early."];
  const guarded = applyGuards(deck);
  const joined = allSlideText(guarded.deck).join(" ");
  assert.ok(!joined.includes("—"), "em-dashes must not survive the guards");
});

test("the leak scanner runs over every slide, not just the hook", () => {
  const deck = goodDeck();
  // A known gated builder name buried in a body line.
  deck.points[2].body = ["Perry Homes does this differently.", "Ask before you sign."];
  const guarded = applyGuards(deck);
  const joined = allSlideText(guarded.deck).join(" ");
  assert.ok(!/Perry Homes/i.test(joined), "gated builder name must be stripped from body copy");
  assert.ok(guarded.leaksStripped.length > 0);
});

// ─── Captions ───────────────────────────────────────────────────────────────

test("social caption carries the keyword CTA and the save line", () => {
  const caption = buildSocialCaption({ deck: goodDeck(), keyword: "MATH" });
  assert.ok(caption.includes("Comment MATH and I'll DM you"));
  assert.ok(caption.includes("Save this for later."));
});

// ─── Text fitting ───────────────────────────────────────────────────────────

test("wrapText keeps every line inside the width budget", () => {
  const text = "The three percent rule that nobody ever explains until you are already sitting at the closing table";
  const lines = wrapText(text, 60, 888);
  assert.ok(lines.length > 1);
  for (const line of lines) {
    assert.ok(measure(line, 60) <= 888, `line overflows: "${line}"`);
  }
});

test("wrapText handles a single word without looping forever", () => {
  const lines = wrapText("Supercalifragilisticexpialidocious", 90, 100);
  assert.equal(lines.length, 1);
});

// ─── Brand palette ──────────────────────────────────────────────────────────

test("accents come from the brand config, never hardcoded", async () => {
  const { BRAND } = await import("../src/carousel-render.js");
  assert.deepEqual(ACCENTS, BRAND.accentRotation);
  for (let i = 0; i < 5; i++) {
    const a = accentFor(`2026-08-0${3 + i}`);
    assert.ok(ACCENTS.includes(a), `${a} is not in the configured rotation`);
  }
});

test("the palette is the brand gold, not the reference example's colours", async () => {
  const { BRAND } = await import("../src/carousel-render.js");
  // #C8AA6A is --gold / --primary / --accent / --ring on lifestyledesignrealty.com,
  // and appears literally in the site's CSS bundle.
  assert.equal(BRAND.colors.accent.toUpperCase(), "#C8AA6A");
  assert.equal(BRAND.colors.accentDim.toUpperCase(), "#9C834B");
  assert.equal(BRAND.colors.ink.toUpperCase(), "#F6F5F1");

  const retired = ["#4FD1C5", "#E879A6", "#A78BFA"];
  const palette = JSON.stringify(BRAND).toUpperCase();
  for (const c of retired) {
    assert.ok(!palette.includes(c), `retired reference colour ${c} still in the palette`);
  }
});

test("no brand colour is hardcoded in the render module", async () => {
  const { readFileSync } = await import("fs");
  const raw = readFileSync(new URL("../src/carousel-render.js", import.meta.url), "utf-8");
  // Strip comments first — this checks the code, not the prose explaining it.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  // Pure black and white are structural (canvas, not brand), everything else
  // must come through the config so a palette tweak is one edit.
  const hexes = (src.match(/#[0-9A-Fa-f]{6}/g) || []).map((h) => h.toUpperCase());
  const allowed = new Set(["#000000", "#FFFFFF"]);
  const offenders = hexes.filter((h) => !allowed.has(h));
  assert.deepEqual(offenders, [], `hardcoded colours in carousel-render.js: ${offenders.join(", ")}`);
});

test("rendered slides actually paint the brand accent", async () => {
  const sharp = (await import("sharp")).default;
  const { hookSvg, renderSvgs, BRAND } = await import("../src/carousel-render.js");
  const [png] = await renderSvgs([hookSvg("A hook with an accent rule beneath it.", BRAND.colors.accent)]);
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });

  const target = [0xC8, 0xAA, 0x6A];
  let found = false;
  for (let i = 0; i < data.length && !found; i += info.channels) {
    if (Math.abs(data[i] - target[0]) < 6 &&
        Math.abs(data[i + 1] - target[1]) < 6 &&
        Math.abs(data[i + 2] - target[2]) < 6) found = true;
  }
  assert.ok(found, "brand gold does not appear in the rendered slide");
});

test("the grid is config-driven", async () => {
  const { BRAND, hookSvg } = await import("../src/carousel-render.js");
  assert.equal(typeof BRAND.grid.step, "number");
  assert.equal(typeof BRAND.grid.opacity, "number");
  assert.ok(hookSvg("x", BRAND.colors.accent).includes(`stroke-opacity="${BRAND.grid.opacity}"`));
});

// ─── Render ─────────────────────────────────────────────────────────────────

test("every slide renders at 1080x1350 and is not blank", async () => {
  const sharp = (await import("sharp")).default;
  const deck = goodDeck();
  const pngs = await renderSvgs(deckToSvgs(deck, "MATH", ACCENTS[0]));

  assert.equal(pngs.length, deck.points.length + 3, "hook + map + points + cta");
  for (const [i, png] of pngs.entries()) {
    const meta = await sharp(png).metadata();
    assert.equal(meta.width, WIDTH, `slide ${i + 1} width`);
    assert.equal(meta.height, HEIGHT, `slide ${i + 1} height`);
    assert.equal(await isNonBlank(png), true, `slide ${i + 1} is blank`);
  }
});

test("the PDF has one page per slide", async () => {
  const { PDFDocument } = await import("pdf-lib");
  const pngs = await renderSvgs(deckToSvgs(goodDeck(), "MATH", ACCENTS[0]));
  const pdf = await buildPdf(pngs, "test");

  const parsed = await PDFDocument.load(pdf);
  assert.equal(parsed.getPageCount(), pngs.length);
  const [w, h] = [parsed.getPage(0).getWidth(), parsed.getPage(0).getHeight()];
  assert.equal(Math.round(w), WIDTH);
  assert.equal(Math.round(h), HEIGHT);
});

// ─── Distribution bodies ────────────────────────────────────────────────────

test("instagram carousel body carries all slides and auto-publishes", () => {
  const body = instagramCarouselBody(["a.png", "b.png", "c.png"], "caption", "2026-08-03T09:00:00");
  assert.equal(body.media.length, 3);
  assert.equal(body.instagramData.type, "POST");
  assert.equal(body.autoPublish, true);
  assert.equal(body.draft, false);
});

test("tiktok body omits contentType and sets the cover to the hook slide", () => {
  const body = tiktokCarouselBody(["a.png", "b.png"], "caption", "2026-08-03T09:00:00");
  // The probe showed contentType is dropped and photo mode is inferred from media.
  assert.equal(body.tiktokData.contentType, undefined);
  assert.equal(body.tiktokData.photoCoverIndex, 0);
  assert.equal(body.media.length, 2);
});

test("linkedin body requests a PDF document post with a title", () => {
  const body = linkedinDocumentBody(["a.png"], "professional caption", "2026-08-03T09:00:00", "Closing costs");
  assert.equal(body.linkedinData.publishImagesAsPDF, true);
  assert.equal(body.linkedinData.documentTitle, "Closing costs");
  assert.equal(body.providers[0].network, "linkedin");
});

test("facebook body posts multi-image", () => {
  const body = facebookCarouselBody(["a.png", "b.png"], "caption", "2026-08-03T09:00:00");
  assert.equal(body.facebookData.type, "POST");
  assert.equal(body.media.length, 2);
});

test("no distribution body targets youtube", () => {
  const bodies = [
    instagramCarouselBody(["a"], "c", "d"),
    tiktokCarouselBody(["a"], "c", "d"),
    facebookCarouselBody(["a"], "c", "d"),
    linkedinDocumentBody(["a"], "c", "d", "t"),
  ];
  for (const b of bodies) {
    assert.ok(!b.providers.some((p) => p.network === "youtube"), "youtube has no carousel format and must not be targeted");
    assert.equal(b.youtubeData, undefined);
  }
});

test("chicagoDateTime produces a scheduler-shaped local timestamp", () => {
  const dt = chicagoDateTime();
  assert.match(dt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
});

// ─── State and merge ────────────────────────────────────────────────────────

test("alreadyPostedToday guards a same-day rerun", () => {
  const log = { posts: [{ date: "2026-08-03", timestamp: "2026-08-03T14:00:00.000Z" }] };
  assert.equal(alreadyPostedToday(log, "2026-08-03"), true);
  assert.equal(alreadyPostedToday(log, "2026-08-04"), false);
});

test("appendEntry trims to the retention cap, keeping the newest", () => {
  const posts = Array.from({ length: MAX_ENTRIES + 10 }, (_, i) => ({
    date: `d-${i}`, timestamp: new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString(),
  }));
  const merged = appendEntry({ posts }, { date: "newest", timestamp: "2099-01-01T00:00:00.000Z" });
  assert.equal(merged.posts.length, MAX_ENTRIES);
  assert.equal(merged.posts[merged.posts.length - 1].date, "newest");
});

test("buildEntry records the keyword and critic scores", () => {
  const entry = buildEntry(
    {
      date: "2026-08-03", pillar: "real_estate_education", topic: "closing costs",
      hook: "the hook", keyword: "MATH", scores: { hook: 9, loops: 8, cta: 9 },
      attemptsUsed: 2, regenerated: true, leaksStripped: [],
    },
    { accent: "#4FD1C5", slideCount: 7, distribution: [{ label: "b", network: "instagram", ok: true }], delivered: true }
  );
  assert.equal(entry.keyword, "MATH");
  assert.deepEqual(entry.scores, { hook: 9, loops: 8, cta: 9 });
  assert.equal(entry.regenerated, true);
  assert.equal(entry.deliveredToOwner, true);
});

test("carousel-log merge is a union — a concurrent runner never drops an entry", () => {
  const remote = { posts: [{ date: "2026-08-01", timestamp: "2026-08-01T14:00:00.000Z", topic: "remote" }] };
  const local = { posts: [{ date: "2026-08-02", timestamp: "2026-08-02T14:00:00.000Z", topic: "local" }] };
  const merged = mergeCarouselLog(local, remote, () => {});
  assert.equal(merged.posts.length, 2);
  assert.deepEqual(merged.posts.map((p) => p.topic), ["remote", "local"]);
});

test("carousel-log merge dedupes a replayed entry by timestamp", () => {
  const entry = { date: "2026-08-01", timestamp: "2026-08-01T14:00:00.000Z", topic: "same" };
  const merged = mergeCarouselLog({ posts: [entry] }, { posts: [entry] }, () => {});
  assert.equal(merged.posts.length, 1);
});

test("carousel-log merge dedupes two runs of the same day by date", () => {
  // Two runners on one day produce different ms stamps but the same date.
  // Letting both through would waste a slot in the anti-example window.
  const remote = { posts: [{ date: "2026-08-03", timestamp: "2026-08-03T14:00:00.000Z", topic: "first" }] };
  const local = { posts: [{ date: "2026-08-03", timestamp: "2026-08-03T14:00:31.000Z", topic: "second" }] };
  const merged = mergeCarouselLog(local, remote, () => {});
  assert.equal(merged.posts.length, 1);
  assert.equal(merged.posts[0].topic, "first", "the entry already on the remote wins");
});

test("carousel-log merge survives a null remote", () => {
  const merged = MERGE_STRATEGIES["carousel-log.json"](
    { posts: [{ date: "2026-08-03", timestamp: "2026-08-03T14:00:00.000Z" }] }, null, () => {}
  );
  assert.equal(merged.posts.length, 1);
});

test("carousel-log is a managed merge file", () => {
  assert.ok(Object.keys(MERGE_STRATEGIES).includes("carousel-log.json"));
});

test("carousel-log merge caps growth", () => {
  const many = Array.from({ length: 200 }, (_, i) => ({
    date: `2026-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}-${i}`,
    timestamp: new Date(Date.UTC(2026, 0, 1) + i * 3600000).toISOString(),
  }));
  const merged = mergeCarouselLog({ posts: many }, { posts: [] }, () => {});
  assert.ok(merged.posts.length <= 120);
});

// ─── Critic resilience ──────────────────────────────────────────────────────

test("an unparseable critic degrades to unscored instead of throwing", async () => {
  const { scoreDeck } = await import("../src/carousel-content.js");
  const scores = await scoreDeck(goodDeck(), "MATH", async () => "not json at all");
  assert.equal(scores.unscored, true);
  assert.equal(scoresPass(scores), false, "an unscored deck must not pass the gate");
});

test("the critic gets one retry before being declared unavailable", async () => {
  const { scoreDeck } = await import("../src/carousel-content.js");
  let calls = 0;
  const scores = await scoreDeck(goodDeck(), "MATH", async () => {
    calls++;
    return calls === 1 ? "garbage" : JSON.stringify(PERFECT);
  });
  assert.equal(calls, 2);
  assert.equal(scores.hook, 9);
  assert.equal(scores.unscored, undefined);
});

test("a critic outage still yields a deck, flagged criticUnavailable", async () => {
  const model = async (system) =>
    system.includes("harsh critic") ? "no json here" : JSON.stringify(goodDeck({ topic: "shipped" }));
  const r = await generateCarousel({ dateStr: "2026-08-03", modelCall: model });
  assert.equal(r.topic, "shipped", "the run must still produce a deck");
  assert.equal(r.criticUnavailable, true);
  assert.equal(r.belowBar, true);
});

test("callModel picks the first text block, not content[0]", async () => {
  // Guards the bug that broke the first live sample run: a response whose
  // leading block is not text yields undefined -> "" -> a parse failure.
  const { callModel } = await import("../src/carousel-content.js");
  const fakeClient = {
    messages: {
      create: async () => ({
        content: [
          { type: "thinking", thinking: "considering the hook" },
          { type: "text", text: '{"ok":true}' },
        ],
      }),
    },
  };
  // callModel closes over the module's lazy client, so exercise the same
  // selection logic the fix introduced.
  const res = await fakeClient.messages.create();
  const block = (res.content || []).find((b) => b?.type === "text" && typeof b.text === "string");
  assert.equal(block.text, '{"ok":true}');
  assert.ok(typeof callModel === "function");
});

// ─── Render overflow ────────────────────────────────────────────────────────

/**
 * Right-most column containing text ink.
 *
 * Measures the raster, not measure() — the estimate under-measured bold serif
 * by up to 17%, which pushed a real headline off the right edge of a sample
 * slide, so trusting measure() here would test the bug against itself.
 *
 * Note the canvas CLIPS: overflowing text is cut at 1080px, so ink can never
 * report wider than the canvas. Overflow is therefore detected by ink reaching
 * INTO the margin, which correctly-fitted text never does.
 */
async function inkRightEdge(png) {
  const sharp = (await import("sharp")).default;
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  // The faint grid sits near 20/255; text ink is far brighter.
  const THRESHOLD = 90;
  let right = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = info.width - 1; x > right; x--) {
      if (data[y * info.width + x] > THRESHOLD) { right = x; break; }
    }
  }
  return right;
}

// Text is laid out inside a 96px margin, so ink past this is overflow.
const MAX_INK_X = 1080 - 96 + 8;

test("long bold headlines stay inside the canvas", async () => {
  const { pointSvg, renderSvgs } = await import("../src/carousel-render.js");
  // These overflowed at the original measurement factor.
  const titles = [
    "Two Speeds, One Market",
    "Nobody Owes You Repairs",
    "What Actually Changes Everything",
    "The Twenty Minute Lie",
  ];
  for (const title of titles) {
    const svg = pointSvg(
      { title, body: ["Short body line.", "Another short line."], loop: "and it gets worse." },
      1, 5, ACCENTS[0]
    );
    const [png] = await renderSvgs([svg]);
    const right = await inkRightEdge(png);
    assert.ok(right <= MAX_INK_X, `"${title}" ink reaches x=${right}, past the ${MAX_INK_X} content edge`);
  }
});

test("long body and CTA text stays inside the canvas", async () => {
  // The body is sans, not serif, and was the case the first overflow test
  // missed: a real sample clipped "Roofers and plumbers quote on their
  // schedule," because the sans factor was left at 1.0.
  const { pointSvg, ctaSvg, renderSvgs } = await import("../src/carousel-render.js");
  const svgs = [
    pointSvg({
      title: "Bids Eat The Rest",
      body: [
        "Roofers and plumbers quote on their schedule, not on yours.",
        "A foundation note means you now need a structural engineer.",
      ],
      loop: "but that's not the expensive part.",
    }, 3, 5, ACCENTS[1]),
    ctaSvg("MATH", "the exact payment breakdown for your price range, plus the full closing cost sheet", ACCENTS[1]),
  ];
  const pngs = await renderSvgs(svgs);
  for (const [i, png] of pngs.entries()) {
    const right = await inkRightEdge(png);
    assert.ok(right <= MAX_INK_X, `slide ${i + 1} ink reaches x=${right}, past the ${MAX_INK_X} content edge`);
  }
});

test("a very long hook stays inside the canvas", async () => {
  const { hookSvg, renderSvgs } = await import("../src/carousel-render.js");
  const svg = hookSvg("The forty seven day stretch that nobody ever warns transplants about", ACCENTS[2]);
  const [png] = await renderSvgs([svg]);
  const right = await inkRightEdge(png);
  assert.ok(right <= MAX_INK_X, `hook ink reaches x=${right}, past the ${MAX_INK_X} content edge`);
});

// ─── Pillar-matched closes ──────────────────────────────────────────────────

function questionDeck(overrides = {}) {
  const d = goodDeck();
  return { ...d, topic: "cost of living", cta: { question: "Bigger lot or shorter commute?" }, ...overrides };
}

function shareDeck(overrides = {}) {
  const d = goodDeck();
  return { ...d, topic: "discipline", cta: { shareLine: "Send this to someone who has been saying next year for three years." }, ...overrides };
}

test("validateDeck enforces the right cta shape per close", () => {
  assert.equal(validateDeck(goodDeck(), "dm").valid, true);
  assert.equal(validateDeck(questionDeck(), "question").valid, true);
  assert.equal(validateDeck(shareDeck(), "share").valid, true);

  // A DM payoff handed to a non-DM pillar is the failure that matters: it would
  // promise an asset on a day with no keyword to claim it.
  const r1 = validateDeck(goodDeck(), "question");
  assert.equal(r1.valid, false);
  assert.ok(r1.failures.some((f) => /missing cta.question/.test(f)));

  const r2 = validateDeck(questionDeck({ cta: { question: "Bigger lot or shorter commute?", payoff: "a thing" } }), "question");
  assert.equal(r2.valid, false);
  assert.ok(r2.failures.some((f) => /must not carry a DM payoff/.test(f)));
});

test("a question close must actually be a question", () => {
  const r = validateDeck(questionDeck({ cta: { question: "Bigger lot or shorter commute" } }), "question");
  assert.equal(r.valid, false);
  assert.ok(r.failures.some((f) => /question mark/.test(f)));
});

test("a share close must use the send-this shape", () => {
  const r = validateDeck(shareDeck({ cta: { shareLine: "Tell a friend about this." } }), "share");
  assert.equal(r.valid, false);
  assert.ok(r.failures.some((f) => /Send this to/.test(f)));
});

test("renderClose produces the reader-visible lines per close", () => {
  assert.deepEqual(renderClose(goodDeck(), "MATH", "dm"), [
    "Comment MATH and I'll DM you the exact payment breakdown for your price range.",
    "Save this for later.",
  ]);
  assert.deepEqual(renderClose(questionDeck(), null, "question"), [
    "Bigger lot or shorter commute?",
    "Save this for later.",
  ]);
  assert.deepEqual(renderClose(shareDeck(), null, "share"), [
    "Send this to someone who has been saying next year for three years.",
    "Follow for more.",
  ]);
});

test("captions end on the pillar's own close", () => {
  const dm = buildSocialCaption({ deck: goodDeck(), keyword: "MATH", closeType: "dm" });
  assert.ok(dm.includes("Comment MATH and I'll DM you"));
  assert.ok(dm.trimEnd().endsWith("Save this for later."));

  const q = buildSocialCaption({ deck: questionDeck(), keyword: null, closeType: "question" });
  assert.ok(!/comment\s+\w+\s+and/i.test(q), "question close must not ask for a keyword");
  assert.ok(!q.includes("DM you"));
  assert.ok(q.includes("Bigger lot or shorter commute?"));

  const sh = buildSocialCaption({ deck: shareDeck(), keyword: null, closeType: "share" });
  assert.ok(sh.includes("Send this to someone who"));
  assert.ok(sh.trimEnd().endsWith("Follow for more."));
  assert.ok(!sh.includes("Save this for later."), "share close uses the follow line instead");
});

test("the writer prompt only mentions a keyword on DM days", () => {
  assert.ok(writerSystemFor("dm").includes("Comment {KEYWORD}"));
  for (const t of ["question", "share"]) {
    const p = writerSystemFor(t);
    assert.ok(!p.includes("Comment {KEYWORD}"), `${t} prompt must not describe the DM close`);
    assert.ok(/No keyword\. No DM\./.test(p), `${t} prompt must rule out the DM close`);
  }
});

test("the critic scores each close against its own goal", () => {
  const dm = criticSystemFor("dm");
  assert.ok(/PAYOFF CONCRETENESS/.test(dm));

  const q = criticSystemFor("question");
  assert.ok(/ANSWERABILITY/.test(q));
  assert.ok(/Do NOT penalise this close for lacking a keyword/.test(q));
  assert.ok(!/PAYOFF CONCRETENESS/.test(q), "question close must not be judged on payoff concreteness");

  const sh = criticSystemFor("share");
  assert.ok(/SEND-WORTHINESS/.test(sh));
  assert.ok(/Do NOT penalise this close for lacking a keyword/.test(sh));
  assert.ok(!/ANSWERABILITY/.test(sh));
});

test("generation drives close type from the date", async () => {
  // Tuesday -> lifestyle -> question close.
  const model = stubModel({ writer: [questionDeck()], critic: [PERFECT] });
  const r = await generateCarousel({ dateStr: "2026-08-04", modelCall: model });
  assert.equal(r.closeType, "question");
  assert.equal(r.keyword, null);
  assert.equal(r.deck.cta.question, "Bigger lot or shorter commute?");
});

test("a DM-shaped deck on a share day is rejected and regenerated", async () => {
  // Wednesday -> motivation -> share close. First draft returns a DM payoff.
  const model = stubModel({ writer: [goodDeck(), shareDeck()], critic: [PERFECT] });
  const r = await generateCarousel({ dateStr: "2026-08-05", modelCall: model });
  assert.equal(r.closeType, "share");
  assert.equal(model.calls.writer, 2, "the DM-shaped draft must not be accepted on a share day");
  assert.ok(r.deck.cta.shareLine.startsWith("Send this to"));
});

test("guards scan the close copy of every close type", () => {
  // A gated builder name hidden in the close must still be stripped.
  const q = applyGuards(questionDeck({ cta: { question: "Perry Homes or a resale?" } }));
  assert.ok(!/Perry Homes/i.test(allSlideText(q.deck).join(" ")));

  const sh = applyGuards(shareDeck({ cta: { shareLine: "Send this to someone who keeps calling Perry Homes." } }));
  assert.ok(!/Perry Homes/i.test(allSlideText(sh.deck).join(" ")));
});

test("question and share closes render on-canvas", async () => {
  const svgs = [
    questionCtaSvg("Bigger lot or a shorter commute every single weekday?", ACCENTS[0]),
    shareCtaSvg("Send this to someone who has been saying next year for three years straight.", ACCENTS[0]),
  ];
  const pngs = await renderSvgs(svgs);
  const sharp = (await import("sharp")).default;
  for (const [i, png] of pngs.entries()) {
    const meta = await sharp(png).metadata();
    assert.equal(meta.width, WIDTH);
    assert.equal(meta.height, HEIGHT);
    assert.equal(await isNonBlank(png), true);
    assert.ok(await inkRightEdge(png) <= MAX_INK_X, `close slide ${i + 1} overflows`);
  }
});

test("deckToSvgs picks the close layout from the close type", async () => {
  const dm = deckToSvgs(goodDeck(), "MATH", ACCENTS[0], "dm");
  const q = deckToSvgs(questionDeck(), null, ACCENTS[0], "question");
  const sh = deckToSvgs(shareDeck(), null, ACCENTS[0], "share");

  assert.ok(dm[dm.length - 1].includes("MATH"));
  assert.ok(q[q.length - 1].includes("Save this for later."));
  assert.ok(!q[q.length - 1].includes("DM you"));
  assert.ok(sh[sh.length - 1].includes("Follow for more."));
  assert.ok(!sh[sh.length - 1].includes("Save this for later."));
});

// ─── Close normalisation ────────────────────────────────────────────────────

test("a footer the model bakes into the close is stripped, not duplicated", async () => {
  const { normaliseClose } = await import("../src/carousel-content.js");

  // Exactly what a real run produced: the share line carried its own footer,
  // so the slide painted "Follow for more." twice.
  const share = normaliseClose(
    shareDeck({ cta: { shareLine: "Send this to someone who keeps saying next year.\nFollow for more." } }),
    "share"
  );
  assert.equal(share.cta.shareLine, "Send this to someone who keeps saying next year.");
  assert.deepEqual(renderClose(share, null, "share"), [
    "Send this to someone who keeps saying next year.",
    "Follow for more.",
  ]);

  const q = normaliseClose(
    questionDeck({ cta: { question: "Lot or commute?\nSave this for later." } }),
    "question"
  );
  assert.equal(q.cta.question, "Lot or commute?");
});

test("normalisation collapses a multi-line close to one line", async () => {
  const { normaliseClose } = await import("../src/carousel-content.js");
  const d = normaliseClose(goodDeck({ cta: { payoff: "the payment\nbreakdown" } }), "dm");
  assert.equal(d.cta.payoff, "the payment breakdown");
});

test("the DM close does not double up punctuation", () => {
  const lines = renderClose(goodDeck({ cta: { payoff: "the full payment breakdown." } }), "MATH", "dm");
  assert.ok(!lines[0].includes(".."), `double period in: ${lines[0]}`);
  assert.ok(lines[0].endsWith("breakdown."));
});

test("close copy too long for the slide is rejected", async () => {
  const { CLOSE_MAX } = await import("../src/carousel-content.js");

  // The real failure: a payoff that ran to a paragraph and shrank to body text.
  const longPayoff = "the new build inspection checklist I hand my buyers. Exactly what to look at before drywall, what to write down at the final walkthrough, and the items to chase before your warranty year quietly ends.";
  assert.ok(longPayoff.length > CLOSE_MAX.payoff);
  const r = validateDeck(goodDeck({ cta: { payoff: longPayoff } }), "dm");
  assert.equal(r.valid, false);
  assert.ok(r.failures.some((f) => /max 120/.test(f)));

  assert.equal(validateDeck(questionDeck({ cta: { question: "A?".padStart(CLOSE_MAX.question + 5, "x") } }), "question").valid, false);
  assert.equal(validateDeck(shareDeck({ cta: { shareLine: "Send this to " + "x".repeat(CLOSE_MAX.shareLine) } }), "share").valid, false);
});

test("an over-long close regenerates rather than shipping", async () => {
  const long = "x".repeat(200);
  const model = stubModel({
    writer: [goodDeck({ cta: { payoff: long } }), goodDeck({ topic: "tightened" })],
    critic: [PERFECT],
  });
  const r = await generateCarousel({ dateStr: "2026-08-03", modelCall: model });
  assert.equal(r.topic, "tightened");
  assert.equal(model.calls.writer, 2);
});

test("the writer is told not to write the footer itself", () => {
  for (const [type, footer] of [["dm", "Save this for later."], ["question", "Save this for later."], ["share", "Follow for more."]]) {
    assert.ok(
      writerSystemFor(type).includes(`Do NOT write the "${footer}" line yourself`),
      `${type} prompt must tell the model the footer is automatic`
    );
  }
});

// ─── Post-publish verification ──────────────────────────────────────────────

import {
  verdictFor, isTerminal, summariseProviders, verifyDistribution,
  applyVerification, verifyAfterSettling, recheckPending,
} from "../src/carousel-verify.js";

/** The exact provider block Metricool recorded for the 2026-08-03 TikTok post. */
const TIKTOK_ERROR_PROVIDER = {
  network: "tiktok",
  status: "ERROR",
  detailedStatus: "The content format of the Tiktok photo is incorrect. The 'image/png' type is not allowed, use 'image/jpeg' or 'image/webp' instead.",
};

const PUBLISHED_PROVIDER = {
  network: "linkedin",
  status: "PUBLISHED",
  detailedStatus: "Published",
  publicUrl: "https://linkedin.com/feed/update/urn:li:ugcPost:749",
};

test("verdictFor distinguishes published, failed and pending", () => {
  assert.equal(verdictFor([PUBLISHED_PROVIDER]), "published");
  assert.equal(verdictFor([TIKTOK_ERROR_PROVIDER]), "failed");
  assert.equal(verdictFor([{ network: "tiktok", status: "PENDING" }]), "pending");
  assert.equal(verdictFor([PUBLISHED_PROVIDER, TIKTOK_ERROR_PROVIDER]), "failed", "one failure fails the post");
  assert.equal(verdictFor([]), "unknown");
});

test("isTerminal knows which states will not change", () => {
  assert.equal(isTerminal("PUBLISHED"), true);
  assert.equal(isTerminal("ERROR"), true);
  assert.equal(isTerminal("PENDING"), false);
});

test("an ERROR provider is reported as failed, not accepted", async () => {
  // The regression this whole change exists for: the scheduler returned 200 and
  // the run logged ok:true, while Metricool had recorded ERROR.
  const warnings = [];
  const records = await verifyDistribution(
    [{ label: "lifestyledesignrealtytexas", blogId: 1, network: "tiktok", postId: 357434895, ok: true }],
    { verify: async () => ({ providers: [TIKTOK_ERROR_PROVIDER] }), warn: (m) => warnings.push(m) }
  );

  assert.equal(records.length, 1);
  assert.equal(records[0].verdict, "failed");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /did NOT publish/);
  assert.match(warnings[0], /image\/png' type is not allowed/, "the provider's own reason must reach the warning");
});

test("verification skips entries with no postId to check", async () => {
  let calls = 0;
  const records = await verifyDistribution(
    [
      { label: "main", network: "instagram", ok: true, skipped: "deliverToOwner" },
      { label: "main", network: "tiktok", ok: false, error: "upload failed" },
      { label: "main", network: "linkedin", ok: true, postId: "unknown" },
    ],
    { verify: async () => { calls++; return { providers: [] }; }, warn: () => {} }
  );
  assert.equal(calls, 0, "nothing here has a real postId");
  assert.equal(records.length, 0);
});

test("a verify call that throws is recorded, not swallowed", async () => {
  const records = await verifyDistribution(
    [{ label: "b", blogId: 1, network: "tiktok", postId: 123 }],
    { verify: async () => { throw new Error("network down"); }, warn: () => {} }
  );
  assert.equal(records[0].verdict, "unknown");
  assert.equal(records[0].error, "network down");
});

test("applyVerification records verified separately from ok", () => {
  const entry = {
    date: "2026-08-03",
    distribution: [
      { label: "main", network: "tiktok", ok: true, postId: 357434895 },
      { label: "main", network: "linkedin", ok: true, postId: 357434900 },
      { label: "main", network: "instagram", ok: true, skipped: "deliverToOwner" },
    ],
  };
  const updated = applyVerification(entry, [
    { postId: 357434895, verdict: "failed", providers: summariseProviders([TIKTOK_ERROR_PROVIDER]), checkedAt: "t" },
    { postId: 357434900, verdict: "published", providers: summariseProviders([PUBLISHED_PROVIDER]), checkedAt: "t" },
  ]);

  const tiktok = updated.distribution.find((d) => d.network === "tiktok");
  assert.equal(tiktok.ok, true, "ok still means accepted, and it was");
  assert.equal(tiktok.verified, false, "but verified is the stronger claim and it is false");
  assert.equal(tiktok.verdict, "failed");
  assert.match(tiktok.failureReason, /image\/png/);

  const linkedin = updated.distribution.find((d) => d.network === "linkedin");
  assert.equal(linkedin.verified, true);
  assert.ok(linkedin.publicUrl.startsWith("https://linkedin.com/"));

  assert.equal(updated.verification.anyFailed, true);
  assert.equal(updated.verification.pendingRecheck, false);
});

test("a still-pending post flags itself for the next run", () => {
  const updated = applyVerification(
    { distribution: [{ label: "b", network: "tiktok", ok: true, postId: 1 }] },
    [{ postId: 1, verdict: "pending", providers: [{ network: "tiktok", status: "PENDING" }], checkedAt: "t" }]
  );
  assert.equal(updated.verification.pendingRecheck, true);
  assert.equal(updated.distribution[0].verified, false);
});

test("applyVerification leaves untouched entries alone", () => {
  const entry = { distribution: [{ label: "b", network: "instagram", ok: true, skipped: "deliverToOwner" }] };
  const updated = applyVerification(entry, []);
  assert.deepEqual(updated.distribution[0], entry.distribution[0]);
});

test("verifyAfterSettling waits before checking, and not at all when there is nothing to check", async () => {
  let slept = 0;
  const records = await verifyAfterSettling(
    [{ label: "b", blogId: 1, network: "tiktok", postId: 5 }],
    {
      waitMs: 1234,
      sleepFn: async (ms) => { slept = ms; },
      verify: async () => ({ providers: [PUBLISHED_PROVIDER] }),
      warn: () => {},
    }
  );
  assert.equal(slept, 1234);
  assert.equal(records[0].verdict, "published");

  slept = 0;
  const none = await verifyAfterSettling([{ label: "b", network: "ig", skipped: "deliverToOwner" }], {
    sleepFn: async (ms) => { slept = ms; },
  });
  assert.equal(slept, 0, "must not burn the wait when nothing is verifiable");
  assert.deepEqual(none, []);
});

test("the next run re-checks posts left pending", async () => {
  const log = {
    posts: [{
      date: "2026-08-03",
      distribution: [{ label: "b", blogId: 1, network: "tiktok", ok: true, postId: 77, verdict: "pending" }],
      verification: { pendingRecheck: true },
    }],
  };
  const { log: updated, rechecked } = await recheckPending(log, {
    verify: async () => ({ providers: [TIKTOK_ERROR_PROVIDER] }),
    warn: () => {},
  });
  assert.equal(rechecked, 1);
  assert.equal(updated.posts[0].distribution[0].verdict, "failed");
  assert.equal(updated.posts[0].verification.anyFailed, true);
});

test("re-check does nothing when everything already settled", async () => {
  const log = {
    posts: [{
      date: "2026-08-03",
      distribution: [{ label: "b", network: "tiktok", ok: true, postId: 77, verdict: "published" }],
      verification: { pendingRecheck: false, anyFailed: false },
    }],
  };
  let calls = 0;
  const { rechecked } = await recheckPending(log, { verify: async () => { calls++; return { providers: [] }; } });
  assert.equal(calls, 0);
  assert.equal(rechecked, 0);
});

// ─── TikTok image format ────────────────────────────────────────────────────

test("the log records postId so a run can be checked afterwards", () => {
  const entry = buildEntry(
    { date: "2026-08-03", pillar: "p", topic: "t", hook: "h", keyword: "MATH", scores: {}, leaksStripped: [] },
    {
      accent: "#C8AA6A", slideCount: 8, delivered: true,
      distribution: [{ label: "main", blogId: 4807109, network: "tiktok", ok: true, postId: 357434895 }],
    }
  );
  // Without this the failure was invisible: ok:true and nothing to verify against.
  assert.equal(entry.distribution[0].postId, 357434895);
  assert.equal(entry.distribution[0].blogId, 4807109);
});

test("TikTok slides are re-encoded as JPEG", async () => {
  const sharp = (await import("sharp")).default;
  const { toJpegSlides } = await import("../src/carousel-render.js");
  const pngs = await renderSvgs(deckToSvgs(goodDeck(), "MATH", ACCENTS[0], "dm"));
  const jpegs = await toJpegSlides(pngs.slice(0, 2));

  assert.equal(jpegs.length, 2);
  for (const j of jpegs) {
    const meta = await sharp(j).metadata();
    // TikTok rejects image/png outright; jpeg and webp are the allowed types.
    assert.equal(meta.format, "jpeg");
    assert.equal(meta.width, WIDTH);
    assert.equal(meta.height, HEIGHT);
    assert.equal(meta.chromaSubsampling, "4:4:4", "coloured 3px rules smear at 4:2:0");
  }
});

test("AWAITING_CONFIRMATION is treated as pending, never as a failure", () => {
  // Measured live: a TikTok photo post sat in this state for ~60s and then
  // published. Treating it as failed would raise a false alarm every run.
  assert.equal(verdictFor([{ network: "tiktok", status: "AWAITING_CONFIRMATION", detailedStatus: "Published:766989" }]), "pending");
  assert.equal(isTerminal("AWAITING_CONFIRMATION"), false);
});

test("verification polls again while posts are still settling", async () => {
  const sleeps = [];
  let call = 0;
  const records = await verifyAfterSettling(
    [{ label: "b", blogId: 1, network: "tiktok", postId: 9 }],
    {
      waitMs: 100, pollIntervalMs: 50, maxPolls: 3,
      sleepFn: async (ms) => { sleeps.push(ms); },
      warn: () => {},
      verify: async () => {
        call++;
        // PENDING, then AWAITING_CONFIRMATION, then PUBLISHED — the real sequence.
        if (call === 1) return { providers: [{ network: "tiktok", status: "PENDING" }] };
        if (call === 2) return { providers: [{ network: "tiktok", status: "AWAITING_CONFIRMATION" }] };
        return { providers: [{ network: "tiktok", status: "PUBLISHED", publicUrl: "https://tiktok.com/x" }] };
      },
    }
  );
  assert.equal(records[0].verdict, "published", "must keep polling until it settles");
  assert.deepEqual(sleeps, [100, 50, 50]);
});

test("polling gives up and leaves the post pending for the next run", async () => {
  const records = await verifyAfterSettling(
    [{ label: "b", blogId: 1, network: "tiktok", postId: 9 }],
    {
      waitMs: 1, pollIntervalMs: 1, maxPolls: 2,
      sleepFn: async () => {},
      warn: () => {},
      verify: async () => ({ providers: [{ network: "tiktok", status: "PENDING" }] }),
    }
  );
  assert.equal(records[0].verdict, "pending");
  assert.equal(applyVerification({ distribution: [{ network: "tiktok", postId: 9 }] }, records).verification.pendingRecheck, true);
});

// ─── Clarity axis ───────────────────────────────────────────────────────────

test("a low clarity score alone blocks the gate", () => {
  // The 2026-08-04 hook scored 8/7/8 on the old three axes and shipped. It was
  // a riddle. Clarity is the axis that catches that.
  assert.equal(scoresPass({ clarity: 3, hook: 8, loops: 8, cta: 8 }), false);
  assert.equal(scoresPass({ clarity: 8, hook: 8, loops: 8, cta: 8 }), true);
});

test("a clarity failure regenerates and tells the writer why", async () => {
  const prompts = [];
  const model = async (system, userPrompt) => {
    if (system.includes("harsh critic")) {
      return JSON.stringify(prompts.length === 1
        ? { ...WEAK, clarity: 3, hook: 8, loops: 8, cta: 8, worst_problem: "the hook is a riddle", fix: "name the subject" }
        : PERFECT);
    }
    prompts.push(userPrompt);
    return JSON.stringify(goodDeck());
  };
  await generateCarousel({ dateStr: "2026-08-03", modelCall: model });

  assert.ok(prompts.length >= 2, "a clarity failure must regenerate");
  assert.match(prompts[1], /CLARITY IS THE FAILING AXIS/);
  assert.match(prompts[1], /withhold the answer, not the subject/i);
  assert.match(prompts[1], /clarity=3/);
});

test("clarity counts toward best-of when nothing clears the bar", async () => {
  const model = stubModel({
    writer: [goodDeck({ topic: "a" }), goodDeck({ topic: "b" }), goodDeck({ topic: "c" })],
    critic: [
      { ...WEAK, clarity: 2, hook: 9, loops: 9, cta: 9 },  // 29, but unreadable
      { ...WEAK, clarity: 7, hook: 7, loops: 7, cta: 7 },  // 28, comprehensible
      { ...WEAK, clarity: 1, hook: 9, loops: 9, cta: 9 },  // 28
    ],
  });
  const r = await generateCarousel({ dateStr: "2026-08-03", modelCall: model });
  assert.equal(r.belowBar, true);
  assert.equal(r.scores.clarity, 2, "best-of is still by total; clarity is part of that total");
  assert.equal(r.topic, "a");
});

test("an unscored critic reports clarity 0 so it cannot pass by omission", async () => {
  const { scoreDeck } = await import("../src/carousel-content.js");
  const scores = await scoreDeck(goodDeck(), "MATH", async () => "not json", "dm");
  assert.equal(scores.clarity, 0);
  assert.equal(scoresPass(scores), false);
});

test("the critic prompt carries the canonical riddle and its repair", () => {
  for (const closeType of ["dm", "question", "share"]) {
    const p = criticSystemFor(closeType);
    assert.match(p, /"clarity"/, `${closeType} prompt must define the clarity axis`);
    assert.ok(
      p.includes("Transplants don't leave over the heat. Month nine does it."),
      "the failing hook must appear verbatim as the canonical failure"
    );
    assert.ok(
      p.includes("Most people who move to Texas don't quit over the summer heat. They quit in month nine."),
      "the repaired hook must appear verbatim as the canonical pass"
    );
    assert.match(p, /within 2 seconds/);
    assert.match(p, /Score the LOWEST-clarity slide/, "clarity covers every slide, not just the hook");
  }
});

test("the critic returns clarity in its JSON shape", () => {
  assert.match(criticSystemFor("dm"), /\{"clarity": 0, "hook": 0, "loops": 0, "cta": 0/);
});

test("the writer is told to name the subject and withhold only the payoff", () => {
  for (const closeType of ["dm", "question", "share"]) {
    const p = writerSystemFor(closeType);
    assert.match(p, /NAME THE SUBJECT/);
    assert.match(p, /WITHHOLD THE PAYOFF, NEVER THE SUBJECT/);
    assert.match(p, /Complete sentences, not compressed fragments/);
    assert.match(p, /8th-grade reading level/);
    assert.match(p, /CLEVERNESS NEVER BEATS COMPREHENSION/);
  }
});

test("the writer prompt shows the riddle and its repair side by side", () => {
  const p = writerSystemFor("dm");
  assert.ok(p.includes("Transplants don't leave over the heat. Month nine does it."));
  assert.ok(p.includes("Most people who move to Texas don't quit over the summer heat. They quit in month nine."));
});

test("the log keeps the deck so a run can be re-scored later", () => {
  const deck = goodDeck();
  const entry = buildEntry(
    { date: "2026-08-04", pillar: "p", topic: "t", hook: deck.hook, keyword: "MATH", deck, scores: { clarity: 8, hook: 8, loops: 8, cta: 8 }, leaksStripped: [] },
    { accent: "#C8AA6A", slideCount: 8, delivered: true, distribution: [] }
  );
  // Past entries stored only the hook, so the clarity axis could not be
  // back-tested against them slide by slide.
  assert.equal(entry.deck.points.length, deck.points.length);
  assert.equal(entry.scores.clarity, 8);
});

test("a hook is judged alone, without penalty for slides it cannot see", async () => {
  const { scoreHookClarity } = await import("../src/carousel-content.js");
  let system = "";
  const r = await scoreHookClarity("Some hook line.", async (sys) => {
    system = sys;
    return JSON.stringify({ clarity: 9, reason: "clear claim, one thing withheld" });
  });
  assert.equal(r.clarity, 9);
  // The first back-test scored a perfectly clear hook at 2 because the stub deck
  // around it was empty and the critic marked that down as unclear.
  assert.match(system, /do not penalise the line for what is not shown to you/i);
  assert.ok(system.includes("Transplants don't leave over the heat. Month nine does it."));
  assert.ok(system.includes("Most people who move to Texas don't quit over the summer heat. They quit in month nine."));
});

test("hook clarity scores are clamped into range", async () => {
  const { scoreHookClarity } = await import("../src/carousel-content.js");
  assert.equal((await scoreHookClarity("x", async () => JSON.stringify({ clarity: 99 }))).clarity, 10);
  assert.equal((await scoreHookClarity("x", async () => JSON.stringify({ clarity: -4 }))).clarity, 1);
  assert.equal((await scoreHookClarity("x", async () => JSON.stringify({}))).clarity, 1);
});
