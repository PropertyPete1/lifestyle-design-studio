/**
 * yt-packaging.js — the title, description, tags and pinned comment.
 *
 * Packaging is not decoration. On a search-driven channel the title and the
 * first two lines of the description are what decide whether the video is ever
 * watched, and the chapters are what decide whether someone who lands mid-topic
 * stays. So this is gated like the script is, not assembled and shipped.
 *
 * WHAT THIS DELIBERATELY DOES NOT INVENT
 * The close is supposed to carry a text number and a links page. Neither exists
 * anywhere in this codebase, and a made-up phone number in a published
 * description is worse than a missing one — it is either dead or it belongs to
 * a stranger. So they come from config, and when they are absent the CTA lines
 * are omitted and the omission is REPORTED on the package. Peter sees exactly
 * what is missing in the review before he approves anything.
 *
 * YouTube's own limits, which are hard failures rather than style choices:
 *   title        100 characters
 *   description  5000 characters
 *   tags         500 characters total across all tags
 *   chapters     first marker must be 00:00, and there must be at least three,
 *                or YouTube silently disables chapters for the whole video
 */

import Anthropic from "@anthropic-ai/sdk";
import { stripDashes } from "./sanitize.js";
import { scanAndStripLeaks } from "./caption.js";
import { findMonthlyPaymentFigure } from "./caption-validator.js";
import { findBannedTellsIn } from "./yt-voice.js";
import { KEYWORD_PAYOFFS } from "./carousel-content.js";
import { formatTimestamp } from "./yt-timeline.js";

const MODEL = "claude-opus-5";

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

export const TITLE_MAX = 100;
export const DESCRIPTION_MAX = 5000;
export const TAGS_TOTAL_MAX = 500;
export const MIN_CHAPTERS = 3;
export const PASS_MARK = 8;

/**
 * The CTA details, from config. No defaults — see the header.
 *
 * Read at call time rather than at import so a test or a workflow can set them
 * without module-load ordering mattering.
 */
export function ctaConfig() {
  const phone = (process.env.YT_TEXT_NUMBER || "").trim();
  const links = (process.env.YT_LINKS_URL || "").trim();
  return { phone: phone || null, links: links || null };
}

/** The keyword this video's offer uses. MATH is the payment breakdown. */
export const DEFAULT_KEYWORD = "MATH";

// ─── description ────────────────────────────────────────────────────────────

/**
 * Build the description.
 *
 * Order is deliberate and not cosmetic: YouTube shows roughly the first two
 * lines before "...more", so the hook goes at the very top and everything
 * administrative goes below the chapters. A description that opens with a
 * phone number wastes the only lines most people read.
 */
export function buildDescription({ hook, promise, chapters = [], keyword = DEFAULT_KEYWORD, cta = ctaConfig() }) {
  const missing = [];
  const parts = [];

  if (hook) parts.push(String(hook).trim());
  if (promise) parts.push(String(promise).trim());

  if (chapters.length >= MIN_CHAPTERS) {
    parts.push("");
    parts.push("CHAPTERS");
    for (const c of chapters) {
      parts.push(`${c.timestamp || formatTimestamp(c.seconds)} ${c.title}`);
    }
  }

  const payoff = KEYWORD_PAYOFFS[keyword] || null;
  parts.push("");
  if (payoff) {
    parts.push(`Want ${payoff} for a specific house? Comment ${keyword} below and I'll send it over.`);
  }

  if (cta.phone) {
    parts.push(`Or text me directly: ${cta.phone}`);
  } else {
    missing.push("text number (YT_TEXT_NUMBER)");
  }

  if (cta.links) {
    parts.push(`Everything else — searches, calculators, current listings: ${cta.links}`);
  } else {
    missing.push("links page (YT_LINKS_URL)");
  }

  parts.push("");
  parts.push("I'm a licensed Realtor in Texas working San Antonio and Austin.");

  return { text: parts.join("\n").trim(), missing };
}

/**
 * The pinned comment.
 *
 * Separate from the description because it does a different job: the
 * description is read by people deciding whether to watch, the pinned comment
 * is read by people who already did and are looking for the next step.
 */
export function buildPinnedComment({ keyword = DEFAULT_KEYWORD, cta = ctaConfig() } = {}) {
  const payoff = KEYWORD_PAYOFFS[keyword] || "the breakdown";
  const lines = [`Comment ${keyword} and I'll send you ${payoff} for whatever house you're looking at — no charge, no pitch.`];
  if (cta.phone) lines.push(`Faster: text ${cta.phone}.`);
  return lines.join("\n");
}

// ─── tags ───────────────────────────────────────────────────────────────────

/**
 * Tags, built from the topic rather than from a fixed list.
 *
 * Trimmed to YouTube's 500-character total. Going over does not error — YouTube
 * silently drops the overflow, which is the kind of quiet truncation that looks
 * like it worked.
 */
export function buildTags({ query, market, intent, extra = [] }) {
  const cityTags = market === "austin"
    ? ["austin texas", "moving to austin", "austin real estate", "living in austin"]
    : ["san antonio texas", "moving to san antonio", "san antonio real estate", "living in san antonio"];

  const intentTags = {
    relocation: ["relocating to texas", "moving to texas"],
    comparison: ["austin vs san antonio", "texas city comparison"],
    cost_of_living: ["cost of living texas", "texas property taxes"],
    neighborhood: ["best neighborhoods", "where to live"],
    new_build: ["new construction homes", "new build texas"],
  }[intent] || [];

  const seen = new Set();
  const tags = [];
  let used = 0;
  for (const raw of [query, ...cityTags, ...intentTags, ...extra]) {
    const tag = String(raw || "").trim().toLowerCase();
    if (!tag || seen.has(tag)) continue;
    // +1 for the separator YouTube counts between tags.
    if (used + tag.length + 1 > TAGS_TOTAL_MAX) continue;
    seen.add(tag);
    tags.push(tag);
    used += tag.length + 1;
  }
  return tags;
}

// ─── validation ─────────────────────────────────────────────────────────────

export function validatePackaging(pkg) {
  const failures = [];
  const title = String(pkg?.title || "");
  if (!title.trim()) failures.push("missing title");
  if (title.length > TITLE_MAX) failures.push(`title is ${title.length} chars, YouTube's limit is ${TITLE_MAX}`);

  const description = String(pkg?.description || "");
  if (!description.trim()) failures.push("missing description");
  if (description.length > DESCRIPTION_MAX) {
    failures.push(`description is ${description.length} chars, YouTube's limit is ${DESCRIPTION_MAX}`);
  }

  const tagChars = (pkg?.tags || []).join(",").length;
  if (tagChars > TAGS_TOTAL_MAX) failures.push(`tags total ${tagChars} chars, YouTube's limit is ${TAGS_TOTAL_MAX}`);

  const chapters = pkg?.chapters || [];
  if (chapters.length > 0) {
    if (chapters.length < MIN_CHAPTERS) {
      failures.push(`${chapters.length} chapters — under ${MIN_CHAPTERS}, YouTube disables chapters entirely`);
    }
    if (chapters[0] && chapters[0].seconds !== 0) {
      failures.push("the first chapter must start at 0:00 or YouTube ignores the whole list");
    }
    for (let i = 1; i < chapters.length; i++) {
      if (chapters[i].seconds <= chapters[i - 1].seconds) {
        failures.push(`chapter ${i + 1} does not advance past the one before it`);
        break;
      }
    }
    // Every chapter must appear in the description or it is not a chapter.
    for (const c of chapters) {
      const stamp = c.timestamp || formatTimestamp(c.seconds);
      if (!description.includes(stamp)) {
        failures.push(`chapter "${c.title}" (${stamp}) is not in the description`);
        break;
      }
    }
  }

  return { valid: failures.length === 0, failures };
}

/** The shared safety gates, over everything a viewer will read. */
export function applyGuards(pkg) {
  const notes = [];
  const scrub = (text) => {
    if (typeof text !== "string" || !text.trim()) return text;
    const { caption, leaksFound, leakDetails } = scanAndStripLeaks(stripDashes(text), null);
    if (leaksFound > 0) notes.push(...leakDetails.map((l) => `stripped "${l.term}" (${l.type})`));
    return caption;
  };

  const scrubbed = {
    ...pkg,
    title: scrub(pkg.title),
    description: scrub(pkg.description),
    pinnedComment: scrub(pkg.pinnedComment),
  };

  const all = [scrubbed.title, scrubbed.description, scrubbed.pinnedComment, ...(pkg.tags || [])];
  return {
    packaging: scrubbed,
    leaksStripped: notes,
    paymentFigure: findMonthlyPaymentFigure(all.filter(Boolean).join("\n")),
    bannedTells: findBannedTellsIn(all),
  };
}

// ─── the critic ─────────────────────────────────────────────────────────────

const CRITIC_SYSTEM = `You are a harsh critic of YouTube packaging — the title and description that decide whether a video is ever watched. You are not here to be encouraging.

Use this scale. It is calibrated, not relative:

  10   Exceptional. Rare.
  9    Excellent. A clear cut above.
  8    Strong. Ready to publish as-is. This is the bar a competent professional hits on a good day.
  6-7  Workable but carrying a specific, nameable flaw.
  4-5  Weak.
  1-3  Broken or absent.

An 8 is a pass, not a prize.

Score two things from 1 to 10.

"searchability" — would this title actually be FOUND? It has to read like a phrase a person types into YouTube while deciding whether to move to Texas, and it has to name a place. Score 3 or below for a title that is clever but has no query behind it, or that could describe any market in the country. A title that is a real query AND opens a gap scores 8 or above.

"promise_match" — does the packaging promise exactly what the video delivers? Compare the title and description against the chapter list.

This is the axis that protects the channel. A title promising something the video does not deliver buys one click and costs the next ten, because the watch-time collapse teaches YouTube not to show it again. Score 3 or below if the title implies a comparison the chapters never make, a number the video never gives, or a specificity ("what $300k gets you") that the chapters do not actually cover. Score 8 or above only if a viewer who clicked for the title would finish feeling the promise was kept.

Return ONLY valid JSON, no preamble and no code fences:
{"searchability": 0, "promise_match": 0, "worst_problem": "one sentence", "fix": "a specific instruction, one sentence"}`;

export function criticSystem() {
  return CRITIC_SYSTEM;
}

function parseJson(raw) {
  let t = (raw || "").trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object in model output");
  return JSON.parse(t.slice(start, end + 1));
}

/**
 * Output budget for a model call.
 *
 * THINKING BLOCKS COME OUT OF THIS BUDGET. That is the whole reason this
 * constant exists and is set so far above the size of the answer.
 *
 * The long-form critic was called with max_tokens: 1500 — generous for a JSON
 * object of six short fields. The live run returned:
 *
 *   stop_reason=max_tokens blocks=[thinking] text=0 chars output_tokens=1500/1500
 *   stop_reason=max_tokens blocks=[thinking,text] text=439 chars output_tokens=1500/1500
 *
 * The model spent the entire budget reasoning and had nothing left to answer
 * with. The caller saw an empty or truncated string and reported "no JSON
 * object in model output", which reads like the model misbehaved and sent the
 * first diagnosis chasing the writer instead of the critic.
 *
 * So budgets are sized for THINKING PLUS THE ANSWER, not for the answer. This
 * is an upper bound rather than a target, so raising it costs nothing when the
 * model is brief.
 */
const MODEL_BUDGET = 8000;

export async function callModel(system, userPrompt, maxTokens = MODEL_BUDGET) {
  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: userPrompt }],
  });
  const block = (res.content || []).find((b) => b?.type === "text" && typeof b.text === "string");
  // Name the cause at the point it happens. Without this, running out of room
  // surfaces downstream as "unparseable output", which reads like the model
  // misbehaved and sends the diagnosis to the wrong place.
  if (res.stop_reason === "max_tokens") {
    console.warn(
      `[YTPackaging] response hit max_tokens (${maxTokens}) — truncated, not malformed. ` +
      `blocks=[${(res.content || []).map((b) => b?.type).join(",")}] ` +
      `text=${block ? block.text.length : 0} chars`
    );
  }
  return block ? block.text : "";
}

export async function scorePackaging(pkg, modelCall = callModel) {
  const rendered = JSON.stringify(
    {
      title: pkg.title,
      description: pkg.description,
      tags: pkg.tags,
      chapters: (pkg.chapters || []).map((c) => c.title),
    },
    null,
    2
  );
  const clamp = (n) => Math.max(1, Math.min(10, Number(n) || 1));

  for (let attempt = 0; attempt < 2; attempt++) {
    const nudge = attempt === 0 ? "" : "\n\nReturn ONLY the JSON object. No prose.";
    try {
      const s = parseJson(await modelCall(criticSystem(), `Score this packaging.\n\n${rendered}${nudge}`, MODEL_BUDGET));
      return {
        searchability: clamp(s.searchability),
        promise_match: clamp(s.promise_match),
        worst_problem: String(s.worst_problem || ""),
        fix: String(s.fix || ""),
      };
    } catch (err) {
      console.warn(`[YTPackaging] critic attempt ${attempt + 1} unparseable: ${err.message}`);
    }
  }
  console.warn("[YTPackaging] critic unavailable — packaging will be treated as unscored");
  return { searchability: 0, promise_match: 0, worst_problem: "critic unavailable", fix: "", unscored: true };
}

export function scoresPass(scores, mark = PASS_MARK) {
  return scores.searchability >= mark && scores.promise_match >= mark;
}

// ─── assembly ───────────────────────────────────────────────────────────────

const MAX_RETRIES = 2;

/**
 * Package a finished video.
 *
 * The title can be rewritten by the critic loop; the chapters cannot, because
 * they are derived from the timeline and changing them would make them lie.
 *
 * @param {object} opts
 * @param {object} opts.topic     the approved brief candidate
 * @param {object} opts.script    the written script
 * @param {Array}  opts.chapters  from buildChapters
 */
export async function buildPackaging({
  topic,
  script,
  chapters = [],
  keyword = DEFAULT_KEYWORD,
  maxRetries = MAX_RETRIES,
  modelCall = callModel,
} = {}) {
  if (!topic?.title) throw new Error("buildPackaging requires a topic with a title");

  let title = script?.title || topic.title;
  const attempts = [];
  let feedback = "";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const { text: description, missing } = buildDescription({
      hook: script?.hook,
      promise: script?.promise,
      chapters,
      keyword,
    });
    const pkg = {
      title,
      description,
      tags: buildTags({ query: topic.query, market: topic.market, intent: topic.intent }),
      chapters,
      pinnedComment: buildPinnedComment({ keyword }),
      keyword,
      missingCta: missing,
    };

    const structure = validatePackaging(pkg);
    if (!structure.valid) {
      console.warn(`[YTPackaging] attempt ${attempt + 1}: ${structure.failures.join("; ")}`);
      // Structural failures are ours, not the model's — a title over 100 chars
      // or chapters that do not advance are bugs upstream, not bad writing.
      throw new Error(`packaging is structurally invalid: ${structure.failures.join("; ")}`);
    }

    const guarded = applyGuards(pkg);
    if (guarded.paymentFigure.found) {
      throw new Error(`packaging states a monthly payment figure ("${guarded.paymentFigure.match}")`);
    }
    if (guarded.bannedTells.length > 0) {
      const list = guarded.bannedTells.map((t) => `"${t.match}"`).join(", ");
      console.warn(`[YTPackaging] attempt ${attempt + 1}: banned phrasing ${list} — retitling`);
      feedback = `\n\nThe previous title used banned phrasing: ${list}. Rewrite it from scratch.`;
      title = await retitle(topic, chapters, feedback, modelCall);
      continue;
    }

    const scores = await scorePackaging(guarded.packaging, modelCall);
    console.log(
      `[YTPackaging] attempt ${attempt + 1}: searchability=${scores.searchability} ` +
      `promise_match=${scores.promise_match}${scoresPass(scores) ? " PASS" : " below bar"}`
    );
    attempts.push({ packaging: guarded.packaging, scores, leaksStripped: guarded.leaksStripped });

    if (scoresPass(scores)) {
      return finish(attempts[attempts.length - 1], { attemptsUsed: attempt + 1, regenerated: attempt > 0 });
    }

    feedback =
      `\n\nThe previous title scored searchability=${scores.searchability}, promise_match=${scores.promise_match}. ` +
      (scores.promise_match < PASS_MARK
        ? `PROMISE MATCH IS FAILING — the title promises something these chapters do not deliver. ` +
          `A title that oversells buys one click and costs the next ten. `
        : "") +
      `Worst problem: ${scores.worst_problem}\nFix: ${scores.fix}`;
    title = await retitle(topic, chapters, feedback, modelCall);
  }

  const best = attempts.reduce((a, b) =>
    b.scores.searchability + b.scores.promise_match > a.scores.searchability + a.scores.promise_match ? b : a
  );
  console.warn(`[YTPackaging] no packaging cleared ${PASS_MARK}/10 — using best-of`);
  return finish(best, { attemptsUsed: attempts.length, regenerated: true, belowBar: true });
}

const RETITLE_SYSTEM = `You write YouTube titles for a Texas realtor's search-driven channel.

A title must read like a phrase someone types into YouTube, must name a city, must be under 70 characters, and must promise only what the chapter list actually delivers. No hype, no clickbait, no exclamation marks.

Return ONLY the title text. No quotes, no preamble, no explanation.`;

async function retitle(topic, chapters, feedback, modelCall) {
  const prompt =
    `Rewrite the title.\n\nTOPIC: ${topic.title}\nSEARCH QUERY: ${topic.query}\n` +
    `WHAT THE VIDEO ACTUALLY COVERS:\n${chapters.map((c) => `- ${c.title}`).join("\n")}\n${feedback}`;
  const raw = await modelCall(RETITLE_SYSTEM, prompt, MODEL_BUDGET);
  return String(raw || "").trim().replace(/^["']|["']$/g, "").slice(0, TITLE_MAX);
}

function finish(attempt, meta) {
  return {
    ...attempt.packaging,
    scores: attempt.scores,
    leaksStripped: attempt.leaksStripped,
    attemptsUsed: meta.attemptsUsed,
    regenerated: Boolean(meta.regenerated),
    belowBar: Boolean(meta.belowBar),
    criticUnavailable: Boolean(attempt.scores.unscored),
  };
}
