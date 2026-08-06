/**
 * yt-brief.js — Monday's brief: what should Peter make a video about this week?
 *
 * Three candidates, and Peter picks one. The point of offering three is not
 * variety for its own sake — it is that the choice is the cheapest place in the
 * whole pipeline to fix a bad idea. A wrong topic caught here costs nothing; the
 * same wrong topic caught after he has recorded eleven takes costs a Saturday.
 *
 * TITLES ARE SEARCH QUERIES, NOT HEADLINES. This format lives on people typing
 * a question into YouTube at 11pm — "moving to san antonio", "austin vs san
 * antonio", "new construction under 300k". A clever title with no query behind
 * it gets no impressions to be clever at. So candidate titles are validated
 * against the shape of a query someone would actually type, not scored on wit.
 *
 * FOOTAGE IS PROPOSED, NOT PROMISED. The brief names which Drive clips would
 * carry each candidate so Peter can tell at a glance whether a topic is
 * shootable this week. Clips used by recent videos are deprioritised — the same
 * B-roll twice in a row is the fastest way to make a channel look thin.
 */

import Anthropic from "@anthropic-ai/sdk";
import { stripDashes } from "./sanitize.js";
import { scanAndStripLeaks } from "./caption.js";
import { findMonthlyPaymentFigure } from "./caption-validator.js";
import { findBannedTellsIn } from "./yt-voice.js";
import { TOPIC_CANDIDATES } from "./yt-config.js";

const MODEL = "claude-opus-5";

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

/** The markets this channel serves. Dallas is a posting market, not a video one. */
export const MARKETS = ["san_antonio", "austin"];

/**
 * The search intents worth ranking for, and roughly what each viewer wants.
 *
 * Kept here rather than in the prompt so the brief can be checked for coverage
 * — three candidates that all chase the same intent is a worse brief than three
 * that spread across it, even if each is individually fine.
 */
export const SEARCH_INTENTS = [
  { key: "relocation", label: "relocation", example: "moving to san antonio" },
  { key: "comparison", label: "city comparison", example: "austin vs san antonio" },
  { key: "cost_of_living", label: "cost of living", example: "cost of living in san antonio" },
  { key: "neighborhood", label: "neighborhood guide", example: "best neighborhoods in north san antonio" },
  { key: "new_build", label: "new construction", example: "new construction under 300k san antonio" },
];

const BRIEF_SYSTEM = `You plan YouTube videos for Peter, a residential realtor working San Antonio and Austin, Texas.

Your job is to propose video topics that people are ALREADY SEARCHING FOR. This channel does not build an audience by being interesting; it builds one by being the answer to a question someone typed at 11pm while deciding whether to move to Texas.

THE TITLE IS THE PRODUCT. Write titles the way a search query is phrased, then make them worth clicking — in that order. A title nobody searches for cannot be saved by being clever.

Good title shapes:
  "Moving to San Antonio: what $300k actually gets you in 2026"
  "Austin vs San Antonio: the honest cost comparison"
  "New construction under $300k in San Antonio — what's the catch?"
  "The truth about property taxes in San Antonio before you move here"

Bad titles, and why:
  "You won't BELIEVE these homes!"       — no query behind it
  "My top 5 tips for buyers"             — nobody searches this
  "Let's talk about the market"          — no query, no promise
  "San Antonio Real Estate Update"       — the channel's interest, not the viewer's

THE INTENTS WORTH CHASING:
${SEARCH_INTENTS.map((i) => `  - ${i.label} — e.g. "${i.example}"`).join("\n")}

Spread the candidates across DIFFERENT intents. Three variations on relocation is a worse brief than one relocation, one comparison, one cost-of-living, because Peter can only make one this week and the three should not be near-substitutes.

For each candidate give:
  "title"     — under 70 characters, query-shaped, specific. Include a city.
  "intent"    — one of: ${SEARCH_INTENTS.map((i) => i.key).join(", ")}
  "market"    — "san_antonio" or "austin"
  "query"     — the actual phrase you believe someone types to find this
  "hook"      — the cold open, one or two sentences. The single most useful or contrarian thing in the video. No greeting.
  "outline"   — 4 to 6 chapter titles, one per line, in the order a person asks these questions
  "why"       — one sentence: why this viewer, this week, cares. Be concrete about who they are.
  "footage"   — what B-roll this needs, in plain words ("newer subdivisions, wide streets, a walkthrough of a spec home")

HARD BANS, which apply to every word you write:
- No monthly payment figures. Ever. Talk about payments; never state one.
- No builder names, no community names, no development names.
- No invented statistics, rates, inventory counts or deadlines. If you would have to make a number up, make the point without one.
- No hype vocabulary. If a phrase would appear in a listing, it does not appear here.

Return ONLY valid JSON, no preamble and no code fences:
{"candidates": [{"title": "...", "intent": "...", "market": "...", "query": "...", "hook": "...", "outline": "...", "why": "...", "footage": "..."}]}`;

export function briefSystem() {
  return BRIEF_SYSTEM;
}

function parseJson(raw) {
  let t = (raw || "").trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object in model output");
  return JSON.parse(t.slice(start, end + 1));
}

export async function callModel(system, userPrompt, maxTokens = 4000) {
  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: userPrompt }],
  });
  const textBlock = (res.content || []).find((b) => b?.type === "text" && typeof b.text === "string");
  return textBlock ? textBlock.text : "";
}

// ─── validation ─────────────────────────────────────────────────────────────

/**
 * Words that mark a title as a headline rather than a query.
 *
 * Deliberately short and specific. A long list here would start rejecting
 * legitimate titles, and the real defence is the prompt's examples — this
 * catches the handful of shapes the model reaches for when it forgets.
 */
const HEADLINE_TELLS = [
  /you won'?t believe/i,
  /\bshocking\b/i,
  /\bmust[- ]see\b/i,
  /\bepic\b/i,
  /^\s*my top \d+/i,
  /\bhere'?s why\b.*!$/i,
];

/** Every reader-visible string on a candidate. */
export function candidateText(c) {
  return [c?.title, c?.query, c?.hook, c?.outline, c?.why, c?.footage].filter(
    (s) => typeof s === "string" && s.trim()
  );
}

export function validateCandidate(c, index = 0) {
  const failures = [];
  const where = `candidate ${index + 1}`;
  const need = (field) => {
    if (typeof c?.[field] !== "string" || !c[field].trim()) failures.push(`${where}: missing ${field}`);
  };
  ["title", "intent", "market", "query", "hook", "outline", "why", "footage"].forEach(need);

  if (typeof c?.title === "string") {
    if (c.title.length > 70) failures.push(`${where}: title is ${c.title.length} chars, max 70`);
    for (const tell of HEADLINE_TELLS) {
      if (tell.test(c.title)) failures.push(`${where}: title reads as a headline, not a search query`);
    }
    // A title with no city cannot rank for a relocation query, which is the
    // entire point of the format.
    if (!/san antonio|austin|texas|sa\b|atx/i.test(c.title)) {
      failures.push(`${where}: title names no city`);
    }
  }

  if (c?.intent && !SEARCH_INTENTS.some((i) => i.key === c.intent)) {
    failures.push(`${where}: intent "${c.intent}" is not one of ${SEARCH_INTENTS.map((i) => i.key).join(", ")}`);
  }
  if (c?.market && !MARKETS.includes(c.market)) {
    failures.push(`${where}: market "${c.market}" is not one of ${MARKETS.join(", ")}`);
  }
  if (typeof c?.outline === "string" && c.outline.split("\n").filter((l) => l.trim()).length < 4) {
    failures.push(`${where}: outline has fewer than 4 chapters`);
  }
  return { valid: failures.length === 0, failures };
}

export function validateBrief(candidates, { wanted = TOPIC_CANDIDATES } = {}) {
  const failures = [];
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { valid: false, failures: ["no candidates returned"] };
  }
  if (candidates.length !== wanted) failures.push(`got ${candidates.length} candidates, wanted ${wanted}`);
  candidates.forEach((c, i) => failures.push(...validateCandidate(c, i).failures));

  // Near-substitutes waste the choice. Peter can only make one this week.
  const intents = candidates.map((c) => c?.intent).filter(Boolean);
  if (intents.length > 1 && new Set(intents).size === 1) {
    failures.push(`all ${intents.length} candidates chase the same intent (${intents[0]})`);
  }
  const titles = candidates.map((c) => String(c?.title || "").toLowerCase().trim());
  if (new Set(titles).size !== titles.length) failures.push("two candidates share a title");

  return { valid: failures.length === 0, failures };
}

/** The shared safety gates, over every candidate. */
export function applyGuards(candidates) {
  const notes = [];
  const scrub = (text) => {
    if (typeof text !== "string" || !text.trim()) return text;
    const { caption, leaksFound, leakDetails } = scanAndStripLeaks(stripDashes(text), null);
    if (leaksFound > 0) notes.push(...leakDetails.map((l) => `stripped "${l.term}" (${l.type})`));
    return caption;
  };

  const scrubbed = candidates.map((c) => ({
    ...c,
    title: scrub(c.title),
    query: scrub(c.query),
    hook: scrub(c.hook),
    outline: scrub(c.outline),
    why: scrub(c.why),
    footage: scrub(c.footage),
  }));

  const allText = scrubbed.flatMap(candidateText);
  return {
    candidates: scrubbed,
    leaksStripped: notes,
    paymentFigure: findMonthlyPaymentFigure(allText.join("\n")),
    bannedTells: findBannedTellsIn(allText),
  };
}

// ─── footage proposals ──────────────────────────────────────────────────────

/**
 * Suggest Drive clips for a candidate.
 *
 * Deliberately dumb, and honest about it: this proposes clips from the right
 * city's folder that have not been used recently, so Peter can see the topic is
 * shootable. It does NOT understand what is in the footage — matching a
 * candidate's "newer subdivisions, wide streets" to actual pixels is a
 * different problem, and the assembler is where it gets solved.
 *
 * @param {Array} videos    Drive file listings for the candidate's market
 * @param {Set}   usedIds   drive file ids already spent on recent videos
 */
export function proposeFootage(videos, usedIds = new Set(), { count = 6 } = {}) {
  const available = (videos || []).filter((v) => v?.id && !usedIds.has(v.id));
  const pool = available.length > 0 ? available : videos || [];
  return pool.slice(0, count).map((v) => ({
    driveFileId: v.id,
    fileName: v.name,
    // Surfaced so Peter can see at a glance whether the brief is reaching for
    // clips it has already spent, which is what a thin library looks like.
    reused: usedIds.has(v.id),
  }));
}

// ─── generation ─────────────────────────────────────────────────────────────

const MAX_RETRIES = 2;

/**
 * Write the week's brief.
 *
 * @param {object} opts
 * @param {Array}  opts.recentTitles  titles already made, as anti-examples
 * @param {string} opts.notes         Peter's notes on a brief he turned down
 * @param {number} opts.wanted        how many candidates
 * @param {Function} opts.modelCall   injectable, so this is testable offline
 */
export async function generateBrief({
  recentTitles = [],
  notes = null,
  wanted = TOPIC_CANDIDATES,
  maxRetries = MAX_RETRIES,
  modelCall = callModel,
} = {}) {
  const anti = recentTitles.length
    ? `\nALREADY MADE — do not propose these again, or near-variants of them:\n${recentTitles
        .slice(0, 20)
        .map((t, i) => `${i + 1}. ${t}`)
        .join("\n")}\n`
    : "";

  const basePrompt =
    `Propose ${wanted} video topics for this week.\n` +
    `Spread them across different search intents and cover both San Antonio and Austin where it makes sense.\n` +
    anti +
    (notes
      ? `\nPETER TURNED DOWN THE LAST BRIEF AND SAID THIS. It overrides anything above that conflicts with it:\n${notes}\n`
      : "") +
    `\nReturn the JSON object described in your instructions.`;

  let feedback = "";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let candidates;
    try {
      candidates = parseJson(await modelCall(briefSystem(), basePrompt + feedback)).candidates;
    } catch (err) {
      console.warn(`[YTBrief] attempt ${attempt + 1}: unparseable output (${err.message})`);
      feedback = `\n\nYour previous output could not be parsed as JSON. Return ONLY the JSON object.`;
      continue;
    }

    const structure = validateBrief(candidates, { wanted });
    if (!structure.valid) {
      console.warn(`[YTBrief] attempt ${attempt + 1}: ${structure.failures.join("; ")}`);
      feedback = `\n\nYour previous attempt had these problems: ${structure.failures.join("; ")}. Fix them exactly.`;
      continue;
    }

    const guarded = applyGuards(candidates);

    if (guarded.paymentFigure.found) {
      console.warn(`[YTBrief] attempt ${attempt + 1}: payment figure ("${guarded.paymentFigure.match}") — regenerating`);
      feedback =
        `\n\nYour previous attempt stated a monthly payment figure ("${guarded.paymentFigure.match}"). ` +
        `Never state a monthly payment number. Talk about payments without giving one.`;
      continue;
    }

    if (guarded.bannedTells.length > 0) {
      const list = guarded.bannedTells.map((t) => `"${t.match}"`).join(", ");
      console.warn(`[YTBrief] attempt ${attempt + 1}: banned phrasing: ${list} — regenerating`);
      feedback =
        `\n\nYour previous attempt used banned phrasing: ${list}. Rewrite those lines from scratch, ` +
        `do not swap in a synonym.`;
      continue;
    }

    console.log(
      `[YTBrief] ${guarded.candidates.length} candidates: ` +
      guarded.candidates.map((c) => `${c.intent}/${c.market}`).join(", ")
    );
    return {
      candidates: guarded.candidates,
      leaksStripped: guarded.leaksStripped,
      attemptsUsed: attempt + 1,
      regenerated: attempt > 0,
    };
  }

  throw new Error(`Brief generation failed after ${maxRetries + 1} attempts`);
}

// ─── rendering ──────────────────────────────────────────────────────────────

/** The brief as Peter reads it in email. */
export function renderBriefText(brief, { requestId = "" } = {}) {
  const lines = [];
  lines.push(`THIS WEEK'S BRIEF — pick one`);
  lines.push("");
  lines.push(`Reply in the dashboard with the number you want, or send notes and I'll rework them.`);
  lines.push("");

  brief.candidates.forEach((c, i) => {
    lines.push("=".repeat(60));
    lines.push(`${i + 1}. ${c.title}`);
    lines.push("=".repeat(60));
    lines.push(`   Searches for: "${c.query}"   (${c.intent}, ${c.market.replace("_", " ")})`);
    lines.push("");
    lines.push(`   WHY NOW: ${c.why}`);
    lines.push("");
    lines.push(`   OPENS WITH:`);
    lines.push(`     ${c.hook}`);
    lines.push("");
    lines.push(`   CHAPTERS:`);
    for (const line of String(c.outline).split("\n").filter((l) => l.trim())) {
      lines.push(`     - ${line.trim().replace(/^[-*\d.\s]+/, "")}`);
    }
    lines.push("");
    lines.push(`   FOOTAGE NEEDED: ${c.footage}`);
    if (c.proposedClips?.length) {
      lines.push(`   CLIPS ON HAND:`);
      for (const clip of c.proposedClips) {
        lines.push(`     - ${clip.fileName}${clip.reused ? "  (used recently)" : ""}`);
      }
    }
    lines.push("");
  });

  lines.push("=".repeat(60));
  lines.push(`Once you pick, you'll get a recording kit: the script split into short takes,`);
  lines.push(`each one 10 to 30 seconds, with a note on how to shoot it. Nothing to memorise.`);
  if (requestId) {
    lines.push("");
    lines.push(`Request: ${requestId}`);
  }
  return lines.join("\n");
}

/** The structured payload the dashboard renders as pickable cards. */
export function briefPayload(brief, { requestId }) {
  return {
    requestId,
    kind: "topic_pick",
    generatedAt: new Date().toISOString(),
    candidates: brief.candidates.map((c, i) => ({
      index: i + 1,
      title: c.title,
      intent: c.intent,
      market: c.market,
      query: c.query,
      hook: c.hook,
      outline: String(c.outline).split("\n").map((l) => l.trim().replace(/^[-*\d.\s]+/, "")).filter(Boolean),
      why: c.why,
      footage: c.footage,
      proposedClips: c.proposedClips || [],
    })),
  };
}

// ─── resolving Peter's pick ─────────────────────────────────────────────────

/**
 * Work out WHICH candidate Peter approved.
 *
 * The decision record the dashboard writes is `{ requestId, decision, notes,
 * decidedAt }` — there is no field for "and I want number two". So the
 * selection has to come out of what is there, and this is the one place in the
 * pipeline where a wrong answer silently makes the wrong video.
 *
 * Accepted, in order of confidence:
 *   1. `selection` on the record, if the dashboard grows the field later
 *   2. a leading number in notes: "2", "2 - but lead with taxes", "#2", "option 2"
 *   3. exactly one candidate whose title appears in notes
 *
 * A brief with one candidate resolves to it without needing any of that.
 *
 * Anything ambiguous returns ok:false with a reason. It does NOT fall back to
 * the first candidate — an approval that does not say what was approved is a
 * question, not an instruction, and the pipeline stalls until Peter answers it.
 */
export function resolveTopicSelection(record, candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (list.length === 0) return { ok: false, reason: "the request carried no candidates" };

  // 1. an explicit field, if the dashboard ever sends one
  const explicit = record?.selection;
  if (explicit !== undefined && explicit !== null && String(explicit).trim()) {
    const byIndex = indexFromValue(String(explicit), list.length);
    if (byIndex) return { ok: true, index: byIndex, candidate: list[byIndex - 1], via: "selection field" };
    const byTitle = list.findIndex((c) => sameTitle(c?.title, String(explicit)));
    if (byTitle >= 0) return { ok: true, index: byTitle + 1, candidate: list[byTitle], via: "selection field" };
    return { ok: false, reason: `selection "${explicit}" matches no candidate` };
  }

  // 2. a number at the front of the notes
  const notes = typeof record?.notes === "string" ? record.notes.trim() : "";
  if (notes) {
    const m = notes.match(/^\s*(?:option\s*|#)?(\d{1,2})\b/i);
    if (m) {
      const idx = indexFromValue(m[1], list.length);
      if (idx) return { ok: true, index: idx, candidate: list[idx - 1], via: "notes" };
      return { ok: false, reason: `notes ask for option ${m[1]}, but the brief had ${list.length}` };
    }

    // 3. a title quoted in the notes, if it picks out exactly one candidate
    const hits = list
      .map((c, i) => ({ i, c }))
      .filter(({ c }) => c?.title && notes.toLowerCase().includes(String(c.title).toLowerCase()));
    if (hits.length === 1) {
      return { ok: true, index: hits[0].i + 1, candidate: hits[0].c, via: "title in notes" };
    }
    if (hits.length > 1) {
      return { ok: false, reason: `the notes name ${hits.length} of the candidates — cannot tell which one` };
    }
  }

  // A brief of one has nothing to be ambiguous about.
  if (list.length === 1) return { ok: true, index: 1, candidate: list[0], via: "only candidate" };

  return {
    ok: false,
    reason: `approved, but nothing says which of the ${list.length} topics to make. ` +
      `Reply with the number (for example "2") and it will pick up on the next run.`,
  };
}

function indexFromValue(raw, count) {
  const n = Number.parseInt(String(raw).trim(), 10);
  return Number.isInteger(n) && n >= 1 && n <= count ? n : null;
}

function sameTitle(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

/**
 * Titles already proposed, so a later brief does not repeat itself.
 *
 * Reads the approvals log rather than a video log because a topic that was
 * proposed and rejected is just as spent as one that got made — Peter has
 * already seen it and said no.
 *
 * Lives here rather than beside the Monday entrypoint so the pipeline job can
 * import it without importing a module that runs a brief on load.
 */
export function priorTitles(approvals) {
  const titles = [];
  for (const r of approvals?.requests || []) {
    for (const c of r?.payload?.candidates || []) {
      if (c?.title) titles.push(c.title);
    }
  }
  return [...new Set(titles)].reverse();
}
