/**
 * carousel-content.js — the daily carousel's writing engine.
 *
 * Produces a full slide deck (hook, mind-map, numbered points, CTA) and then
 * puts it through a second Claude pass acting as a harsh critic. Anything the
 * critic scores under 8 on hook strength, per-slide loop strength, or CTA
 * specificity is regenerated with that feedback attached. Two retries, then the
 * best-scoring draft of the three wins.
 *
 * Every draft — winning or not — goes through the same safety gates the
 * captions use: the gated-term leak scanner and findMonthlyPaymentFigure. The
 * CTA is allowed to promise a payment breakdown in the DM; no slide may ever
 * state a monthly figure.
 *
 * Model choice: the rest of the poster runs on Haiku, which is right for
 * captions on top of a video that is already carrying the post. Here the copy
 * IS the post — a carousel with a weak hook has nothing else to fall back on —
 * so the writer and the critic both run on Opus.
 */

import Anthropic from "@anthropic-ai/sdk";
import { stripDashes } from "./sanitize.js";
import { scanAndStripLeaks } from "./caption.js";
import { findMonthlyPaymentFigure } from "./caption-validator.js";

const MODEL = "claude-opus-5";

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

// ─── Pillars ────────────────────────────────────────────────────────────────

/** Sunday = 0 … Saturday = 6, matching Date#getDay(). */
export const PILLARS = {
  0: { key: "market_insight", label: "Market insight", angle: "What the Texas market is actually doing right now and what it means for a normal buyer or seller. Concrete, current, non-obvious. No doom, no hype." },
  1: { key: "real_estate_education", label: "Real estate education", angle: "Teach one specific mechanic of buying or selling that most people get wrong. Rules, costs, timelines, contingencies, inspections, appraisals, negotiation." },
  2: { key: "texas_lifestyle", label: "Texas lifestyle", angle: "Living in Texas: neighbourhoods, commutes, weather, taxes, schools, food, weekends, what surprises transplants. Specific to San Antonio, Austin, and DFW." },
  3: { key: "motivation_business", label: "Motivation and business", angle: "Building something, discipline, money habits, betting on yourself, the long game. Grounded in real estate and business, never generic hustle quotes." },
  4: { key: "real_estate_education", label: "Real estate education", angle: "Teach one specific mechanic of buying or selling that most people get wrong. Rules, costs, timelines, contingencies, inspections, appraisals, negotiation." },
  5: { key: "texas_lifestyle", label: "Texas lifestyle", angle: "Living in Texas: neighbourhoods, commutes, weather, taxes, schools, food, weekends, what surprises transplants. Specific to San Antonio, Austin, and DFW." },
  6: { key: "motivation_business", label: "Motivation and business", angle: "Building something, discipline, money habits, betting on yourself, the long game. Grounded in real estate and business, never generic hustle quotes." },
};

/** Comment keywords, rotated per post and logged so the DM automation can match. */
export const KEYWORDS = ["TOUR", "PLAN", "LIST", "MATH"];

/** Chicago-local YYYY-MM-DD. */
export function todayInChicago(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Day-of-week index for a YYYY-MM-DD string, timezone-independent. */
export function dayIndexFor(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function pillarFor(dateStr) {
  return PILLARS[dayIndexFor(dateStr)];
}

/**
 * Keyword for a date. Rotates on absolute day number rather than day-of-week,
 * so a given keyword doesn't get pinned to a single pillar forever.
 */
export function keywordFor(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dayNumber = Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
  return KEYWORDS[((dayNumber % KEYWORDS.length) + KEYWORDS.length) % KEYWORDS.length];
}

// ─── Prompting ──────────────────────────────────────────────────────────────

const WRITER_SYSTEM = `You write Instagram carousels for Peter Allen, who runs Lifestyle Design Realty in Texas.

The single metric that matters is SWIPE COMPLETION. A carousel that gets a swipe to the last slide beats a clever one that gets abandoned on slide 3. Every structural rule below exists to serve that.

SLIDE 1 — THE HOOK
- A curiosity gap, never a summary. If a reader can guess the payoff from slide 1, the carousel is dead.
- Use one of: an unfinished sentence, a contrarian claim, or a specific odd number.
- It must be impossible to know the answer without swiping.
- Max 12 words. Short is stronger.
- BANNED: "Here's why", "Let's talk about", "A thread", "Everything you need to know", "The ultimate guide", any phrasing that announces a topic instead of opening a gap.
- PAY IT OFF. If the hook names a specific number, person, or outcome, a later slide must explicitly deliver that exact thing. A hook that promises "$27,000" and never mentions it again is a bait and switch, and it is the single most common way these fail.

SLIDE 2 — THE MAP
- A mind-map overview of every point coming. 4 to 6 fragments, 2 to 5 words each.
- The job of this slide is to make stopping feel like leaving money on the table. The reader should see something later in the list they specifically want.
- Fragments, not sentences. No verbs required.

SLIDES 3 TO 8 — THE POINTS
- Each has a short bold title (2 to 6 words) and 2 to 3 plain lines of body.
- Body lines are plain spoken English. No jargon, no filler, no throat-clearing.
- CRITICAL: each of these slides ENDS with an open loop of 3 to 6 words that teases the next slide. Examples of the shape: "...but that's not the expensive part." / "...and it gets worse." / "...most people stop here."
- A loop WITHHOLDS. It must not be a headline for the next slide. "And the rate is not fixed." announces what is coming and is worthless. "That number can climb later." withholds and is what you want.
- The LAST point slide's loop must ALSO withhold. Do not announce the CTA. "I keep a list for this." and "Here is the whole timeline." are failures — they hand off to the CTA instead of pulling the reader into it. Tease the value of the payoff without naming the mechanism.
- The open loop is a separate final line, not folded into the body.

FINAL SLIDE — THE CTA
- Exactly this shape: "Comment {KEYWORD} and I'll DM you {payoff}."
- The payoff must be concrete and specific — a thing they receive, not a vibe. "the exact payment breakdown" is good. "more info" is worthless.
- Then a separate line: "Save this for later."

HARD RULES
- Do NOT use em-dashes or en-dashes. Use short sentences and periods. Dashes read as AI.
- Never state a monthly payment figure on any slide. You may PROMISE a payment breakdown in the DM on the CTA slide, but never put a number on it.
- Never name a specific neighbourhood, subdivision, community, or homebuilder.
- No hashtags. No emoji.
- Write like a person who knows this cold and is telling a friend, not like a brand.

Return ONLY valid JSON, no preamble and no code fences:
{
  "topic": "short internal label for this carousel",
  "hook": "slide 1 text",
  "map": ["fragment", "fragment", "fragment", "fragment"],
  "points": [
    {"title": "Bold Title", "body": ["line one", "line two"], "loop": "open loop text"}
  ],
  "cta": {"payoff": "the thing they receive in the DM"}
}
Produce between 4 and 6 points.`;

const CRITIC_SYSTEM = `You are a harsh critic of Instagram carousels. You are not here to be encouraging. Most carousels you see are mediocre and you score them accordingly.

Score three things from 1 to 10:

"hook" — slide 1. Does it open a real curiosity gap? Could a reader guess the payoff without swiping? If it summarises or announces a topic instead of withholding something, it scores 3 or below. Generic openers score 2.

"loops" — the per-slide open loops on the point slides. Does EVERY point slide end in a genuine 3 to 6 word tease that creates a reason to swipe? One weak or missing loop caps this at 5. Loops that just restate the slide score 3.

"cta" — the final slide. Is the payoff concrete and specific enough that someone would actually type the keyword to get it? Vague payoffs ("more info", "the details", "my guide") score 3 or below.

IMPORTANT: the comment keyword is drawn from a fixed four-word rotation the writer does not choose. Do NOT penalise the CTA for a keyword that has little to do with the topic — that is not the writer's decision. Score only the specificity and pull of the payoff itself.

Be stingy. An 8 means genuinely good. A 10 should be rare.

Return ONLY valid JSON, no preamble and no code fences:
{"hook": 0, "loops": 0, "cta": 0, "worst_problem": "the single most damaging flaw, one sentence", "fix": "a specific instruction to the writer, one sentence"}`;

/** Strip code fences and preamble, then parse. Models sometimes wrap JSON. */
function parseJson(raw) {
  let t = (raw || "").trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/,"");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object in model output");
  return JSON.parse(t.slice(start, end + 1));
}

/**
 * The default model call. Every function that talks to Claude takes this as an
 * injectable parameter so the critic gate and the retry logic can be tested
 * against scripted responses instead of the live API.
 */
export async function callModel(system, userPrompt, maxTokens = 4000) {
  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: userPrompt }],
  });
  // Pick the first *text* block rather than content[0]. The response can lead
  // with a non-text block, and indexing blindly yields undefined -> "" -> a
  // parse failure that looks like the model returned nothing.
  const textBlock = (res.content || []).find((b) => b?.type === "text" && typeof b.text === "string");
  return textBlock ? textBlock.text : "";
}

// ─── Safety gates ───────────────────────────────────────────────────────────

/** Every piece of reader-visible text in a deck, flattened. */
export function allSlideText(deck) {
  const parts = [deck.hook, ...(deck.map || [])];
  for (const p of deck.points || []) {
    parts.push(p.title, ...(p.body || []), p.loop);
  }
  return parts.filter(Boolean);
}

/**
 * Run the shared safety gates over a deck.
 *
 * findMonthlyPaymentFigure only fires on an actual figure, so the CTA's
 * "the exact payment breakdown" passes while "$1,850 a month" does not — which
 * is exactly the line the spec draws. The CTA payoff is scanned too; it just
 * has nothing to trip on unless the model invents a number.
 */
export function applyGuards(deck) {
  const notes = [];
  const scrubbed = { ...deck, map: [...(deck.map || [])], points: (deck.points || []).map(p => ({ ...p, body: [...(p.body || [])] })) };

  const scrub = (text) => {
    if (!text) return text;
    const dashed = stripDashes(text);
    const { caption, leaksFound, leakDetails } = scanAndStripLeaks(dashed, null);
    if (leaksFound > 0) {
      notes.push(...leakDetails.map(l => `stripped "${l.term}" (${l.type})`));
    }
    return caption;
  };

  scrubbed.hook = scrub(scrubbed.hook);
  scrubbed.map = scrubbed.map.map(scrub);
  for (const p of scrubbed.points) {
    p.title = scrub(p.title);
    p.body = p.body.map(scrub);
    p.loop = scrub(p.loop);
  }
  if (scrubbed.cta?.payoff) {
    scrubbed.cta = { ...scrubbed.cta, payoff: scrub(scrubbed.cta.payoff) };
  }

  // Monthly-figure check runs on slide copy AFTER scrubbing, so a leak fix
  // can't reintroduce one.
  const payment = findMonthlyPaymentFigure(allSlideText(scrubbed).join("\n"));

  return { deck: scrubbed, leaksStripped: notes, paymentFigure: payment };
}

/** Structural validity — the render step assumes these hold. */
export function validateDeck(deck) {
  const failures = [];
  if (!deck || typeof deck !== "object") return { valid: false, failures: ["not an object"] };
  if (!deck.hook || typeof deck.hook !== "string") failures.push("missing hook");
  if (!Array.isArray(deck.map) || deck.map.length < 3) failures.push("map needs at least 3 fragments");
  if (!Array.isArray(deck.points) || deck.points.length < 4 || deck.points.length > 6) {
    failures.push(`points must be 4-6 (got ${deck.points?.length ?? 0})`);
  }
  for (const [i, p] of (deck.points || []).entries()) {
    if (!p?.title) failures.push(`point ${i + 1} missing title`);
    if (!Array.isArray(p?.body) || p.body.length < 2 || p.body.length > 3) {
      failures.push(`point ${i + 1} body must be 2-3 lines`);
    }
    const loopWords = (p?.loop || "").trim().split(/\s+/).filter(Boolean).length;
    if (loopWords < 3 || loopWords > 8) failures.push(`point ${i + 1} loop is ${loopWords} words (want 3-6)`);
  }
  if (!deck.cta?.payoff) failures.push("missing cta payoff");
  return { valid: failures.length === 0, failures };
}

// ─── Generation with the critic gate ────────────────────────────────────────

const PASS_MARK = 8;
const MAX_RETRIES = 2;

export async function scoreDeck(deck, keyword, modelCall = callModel) {
  const rendered = JSON.stringify({
    hook: deck.hook,
    map: deck.map,
    points: deck.points,
    cta: `Comment ${keyword} and I'll DM you ${deck.cta?.payoff}.`,
  }, null, 2);
  const clamp = (n) => Math.max(1, Math.min(10, Number(n) || 1));

  // The critic is a quality gate, not a safety gate. If it cannot be parsed we
  // retry once and then degrade to "unscored" rather than throwing — a critic
  // outage must not take down the day's post. The hard gates (leak scanner,
  // payment figure) are enforced separately and still block.
  for (let attempt = 0; attempt < 2; attempt++) {
    const nudge = attempt === 0 ? "" : "\n\nReturn ONLY the JSON object. No prose.";
    try {
      const raw = await modelCall(CRITIC_SYSTEM, `Score this carousel.\n\n${rendered}${nudge}`, 1000);
      const s = parseJson(raw);
      return {
        hook: clamp(s.hook),
        loops: clamp(s.loops),
        cta: clamp(s.cta),
        worst_problem: String(s.worst_problem || ""),
        fix: String(s.fix || ""),
      };
    } catch (err) {
      console.warn(`[Carousel] critic attempt ${attempt + 1} unparseable: ${err.message}`);
    }
  }

  console.warn("[Carousel] critic unavailable — deck will be treated as unscored");
  return { hook: 0, loops: 0, cta: 0, worst_problem: "critic unavailable", fix: "", unscored: true };
}

export function scoresPass(scores, mark = PASS_MARK) {
  return scores.hook >= mark && scores.loops >= mark && scores.cta >= mark;
}

const scoreTotal = (s) => s.hook + s.loops + s.cta;

/**
 * Generate one carousel for a date.
 *
 * @param {object} opts
 * @param {string} opts.dateStr           Chicago-local YYYY-MM-DD
 * @param {Array}  opts.recent            prior log entries, newest first, for anti-repetition
 * @param {number} opts.maxRetries        override for tests
 * @param {Function} opts.modelCall       injectable model call, for tests
 */
export async function generateCarousel({ dateStr, recent = [], maxRetries = MAX_RETRIES, modelCall = callModel } = {}) {
  const date = dateStr || todayInChicago();
  const pillar = pillarFor(date);
  const keyword = keywordFor(date);

  // Last 14 topics and hooks become explicit "do not resemble" anti-examples.
  const antiExamples = recent.slice(0, 14)
    .map((e, i) => `${i + 1}. topic: ${e.topic} | hook: ${e.hook}`)
    .join("\n");

  const basePrompt =
    `Write today's carousel.\n\n` +
    `PILLAR: ${pillar.label}\n` +
    `ANGLE: ${pillar.angle}\n` +
    `CTA KEYWORD: ${keyword}\n\n` +
    (antiExamples
      ? `DO NOT RESEMBLE these recent posts. Pick a different topic and a structurally different hook:\n${antiExamples}\n\n`
      : "") +
    `Return the JSON object described in your instructions.`;

  const attempts = [];
  let feedback = "";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let deck;
    try {
      const raw = await modelCall(WRITER_SYSTEM, basePrompt + feedback);
      deck = parseJson(raw);
    } catch (err) {
      console.warn(`[Carousel] attempt ${attempt + 1}: unparseable output (${err.message})`);
      feedback = `\n\nYour previous output could not be parsed as JSON. Return ONLY the JSON object.`;
      continue;
    }

    const structure = validateDeck(deck);
    if (!structure.valid) {
      console.warn(`[Carousel] attempt ${attempt + 1}: structure failures: ${structure.failures.join("; ")}`);
      feedback = `\n\nYour previous attempt was structurally invalid: ${structure.failures.join("; ")}. Fix these exactly.`;
      continue;
    }

    const guarded = applyGuards(deck);
    if (guarded.paymentFigure.found) {
      // A stated monthly figure is not negotiable — regenerate rather than patch.
      console.warn(`[Carousel] attempt ${attempt + 1}: payment figure on a slide ("${guarded.paymentFigure.match}") — regenerating`);
      feedback = `\n\nYour previous attempt stated a monthly payment figure ("${guarded.paymentFigure.match}") on a slide. Never put a payment number on a slide. Promise the breakdown in the DM instead.`;
      continue;
    }

    const scores = await scoreDeck(guarded.deck, keyword, modelCall);
    console.log(`[Carousel] attempt ${attempt + 1} scores: hook=${scores.hook} loops=${scores.loops} cta=${scores.cta}${scoresPass(scores) ? " PASS" : " below bar"}`);
    attempts.push({ deck: guarded.deck, scores, leaksStripped: guarded.leaksStripped });

    if (scoresPass(scores)) {
      return finish(attempts[attempts.length - 1], { date, pillar, keyword, attemptsUsed: attempt + 1, regenerated: attempt > 0 });
    }

    feedback =
      `\n\nYour previous attempt scored hook=${scores.hook}, loops=${scores.loops}, cta=${scores.cta} out of 10. ` +
      `Everything must reach 8.\nWorst problem: ${scores.worst_problem}\nFix: ${scores.fix}\n` +
      `Rewrite completely. Do not lightly edit the previous version.`;
  }

  if (attempts.length === 0) {
    throw new Error("Carousel generation produced no usable draft");
  }

  // Best-of: nothing cleared the bar, so take the highest total.
  const best = attempts.reduce((a, b) => (scoreTotal(b.scores) > scoreTotal(a.scores) ? b : a));
  console.warn(`[Carousel] no draft cleared ${PASS_MARK}/10 — using best-of (total ${scoreTotal(best.scores)})`);
  return finish(best, { date, pillar, keyword, attemptsUsed: attempts.length, regenerated: true, belowBar: true });
}

function finish(attempt, meta) {
  return {
    date: meta.date,
    pillar: meta.pillar.key,
    pillarLabel: meta.pillar.label,
    keyword: meta.keyword,
    topic: attempt.deck.topic || meta.pillar.label,
    hook: attempt.deck.hook,
    deck: attempt.deck,
    scores: attempt.scores,
    leaksStripped: attempt.leaksStripped,
    attemptsUsed: meta.attemptsUsed,
    regenerated: Boolean(meta.regenerated),
    belowBar: Boolean(meta.belowBar),
    // Surfaced so a run that shipped without a working critic is visible in the
    // log rather than looking like a deck that simply scored zero.
    criticUnavailable: Boolean(attempt.scores.unscored),
  };
}

// ─── Captions ───────────────────────────────────────────────────────────────

/** Instagram/TikTok/Facebook caption. Ends on the keyword CTA. */
export function buildSocialCaption(result) {
  const { deck, keyword } = result;
  return [
    deck.hook,
    "",
    ...(deck.points || []).map((p) => `${p.title}: ${p.body[0]}`),
    "",
    `Comment ${keyword} and I'll DM you ${deck.cta.payoff}.`,
    "Save this for later.",
  ].join("\n");
}

/**
 * LinkedIn caption. Professional register, ends on a discussion question, and
 * deliberately carries no comment-keyword gimmick — that mechanic reads as
 * engagement bait on LinkedIn.
 */
export async function buildLinkedinCaption(result, modelCall = callModel) {
  const { deck, pillarLabel } = result;
  const summary = (deck.points || []).map((p) => `${p.title}: ${p.body.join(" ")}`).join("\n");
  const raw = await modelCall(
    `You are Peter Allen, who runs Lifestyle Design Realty in Texas. Write the LinkedIn caption that accompanies a slide document.

RULES:
- Professional and measured. This is LinkedIn, not Instagram.
- Under 120 words.
- No hashtags, no emoji, no comment-keyword gimmick, no "DM me".
- Do NOT use em-dashes or en-dashes. Short sentences and periods.
- Open with the substance, not a hook.
- End with ONE genuine discussion question that invites a professional opinion.
- Never state a monthly payment figure.

Return ONLY the caption text.`,
    `Topic: ${deck.topic}\nPillar: ${pillarLabel}\n\nThe document covers:\n${summary}`,
    600
  );

  let text = stripDashes((raw || "").trim());
  text = text.replace(/^(here'?s|here is|sure|draft)[^\n]*:\s*\n+/i, "");
  const { caption } = scanAndStripLeaks(text, null);
  return caption.trim();
}
