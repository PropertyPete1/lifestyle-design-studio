/**
 * AI Hook Optimizer — the "active" layer that turns the analyst's diagnosis
 * (skip rate is the #1 lever) into a concrete improvement applied to each post.
 *
 * What it does:
 *  - Learns the brand's WINNING hook patterns from real data: the opening line(s)
 *    of the reels with the most views and the lowest skip rate (from post_metrics).
 *  - Rewrites ONLY the opening 1-2 lines of a caption to mirror those winners
 *    (visual payoff + price/curiosity tease in the first ~2 seconds).
 *  - Leaves the rest of the (intentionally long) caption body untouched.
 *  - NEVER alters hashtags. NEVER alters the engagement CTA line
 *    (e.g. "Comment HOME", "comment SA"). If the CTA happens to be the first
 *    line, the hook is inserted ABOVE it so the CTA is never the opener, but the
 *    CTA text itself is preserved verbatim.
 *  - Fails safe: if the rewrite drops the CTA, adds/removes hashtags, or comes
 *    back empty, the ORIGINAL caption is returned unchanged.
 *
 * Because it's a single inline LLM call with deterministic guards, it runs inside
 * the publish path / Heartbeat handler on the Node-only Autoscale runtime.
 */

import { invokeLLM } from "./_core/llm";
import { splitHashtags } from "./captionRefresh";
import * as db from "./db";

const HOOK_MODEL = "claude-sonnet-4-6";

/**
 * Detect an engagement CTA line such as "Comment HOME", "comment 'SA'",
 * "COMMENT INFO below". Matches lines that start with the word "comment".
 * We intentionally scope this to the brand's preferred "Comment" CTA style.
 */
export function findCtaLine(body: string): { index: number; line: string } | null {
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    // Strip leading non-alphanumeric characters (emojis/symbols/spaces) so
    // "\ud83d\udc47 Comment HOME" still matches.
    const stripped = t.replace(/^[^A-Za-z0-9]+/, "");
    if (/^comment\b/i.test(stripped)) {
      return { index: i, line: lines[i] };
    }
  }
  return null;
}

/** Normalize a string for verbatim-preservation comparison. */
function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Extract the set of hashtags (lowercased) from a caption block. */
export function hashtagSet(text: string): Set<string> {
  const out = new Set<string>();
  // Hashtag = '#' followed by word chars. Good enough for our English captions;
  // avoids the unicode regex flag which this TS target rejects.
  const re = /#[A-Za-z0-9_]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.add(m[0].toLowerCase());
  return out;
}

export interface HookExample {
  brand: string;
  hook: string;
  views: number;
  skipRate: number | null;
}

/**
 * Learn winning hook examples from stored metrics. Prefers the same brand, then
 * falls back to global top performers so a brand-new/small account still gets
 * guidance. "Winning" = high views + low skip rate.
 */
export async function getWinningHooks(
  brandLabel?: string,
  limit = 4
): Promise<HookExample[]> {
  let rows: Awaited<ReturnType<typeof db.getLatestMetricsPerPost>> = [];
  try {
    rows = await db.getLatestMetricsPerPost();
  } catch {
    return [];
  }
  const ig = rows.filter(r => r.network === "instagram" && (r.views ?? 0) > 0);

  const score = (r: (typeof ig)[number]) => {
    const skip = r.skipRate == null ? 70 : r.skipRate; // unknown skip = neutral-ish
    // Reward views, penalize skip rate. Simple, explainable ranking.
    return (r.views ?? 0) * (1 - skip / 100);
  };

  const pool = brandLabel
    ? (() => {
        const same = ig.filter(r => r.brandLabel === brandLabel);
        return same.length >= 2 ? same : ig; // fall back to all brands if sparse
      })()
    : ig;

  return [...pool]
    .sort((a, b) => score(b) - score(a))
    .slice(0, limit)
    .map(r => ({
      brand: r.brandLabel ?? "",
      hook: (r.captionSnippet ?? "").split(/[.!?\n]/)[0].trim().slice(0, 120),
      views: r.views ?? 0,
      skipRate: r.skipRate ?? null,
    }))
    .filter(h => h.hook.length > 0);
}

export interface OptimizeResult {
  caption: string;
  changed: boolean;
  reason?: string;
}

/**
 * Rewrite ONLY the opening hook of a caption in the style of the brand's winning
 * hooks, preserving the long body, hashtags, and the Comment CTA verbatim.
 */
export async function optimizeHook(
  caption: string,
  brandLabel?: string
): Promise<OptimizeResult> {
  const original = caption ?? "";
  const { body, tags } = splitHashtags(original);
  if (!body.trim()) return { caption: original, changed: false, reason: "empty-body" };

  const cta = findCtaLine(body);
  const winners = await getWinningHooks(brandLabel);

  const winnerText = winners.length
    ? winners.map((w, i) => `${i + 1}. "${w.hook}" (${w.views} views, skip ${w.skipRate ?? "?"}%)`).join("\n")
    : "(no data yet — use a vivid visual detail + a price/value curiosity tease)";

  const ctaInstruction = cta
    ? `The caption contains an engagement CTA line: "${cta.line.trim()}". You MUST keep this line EXACTLY as-is, word for word. It must NOT be the very first line — the hook goes above it. Do not duplicate it.`
    : `There is no explicit Comment CTA line; do not invent one.`;

  const prompt =
    "You optimize the OPENING HOOK of an Instagram real-estate reel caption to lower skip rate " +
    "(people swiping away in the first 2 seconds). Higher retention => more reach => more views.\n\n" +
    "WINNING HOOKS from this account's best-performing reels (mirror their style — a concrete visual " +
    "payoff plus a price/value curiosity tease):\n" +
    winnerText +
    "\n\nSTRICT RULES:\n" +
    "- Rewrite ONLY the first 1-2 lines into a stronger scroll-stopping hook. Keep EVERYTHING after that unchanged.\n" +
    "- Keep the caption LONG. Do NOT shorten, summarize, or delete body lines.\n" +
    "- Keep every concrete fact identical: prices, square footage, bed/bath, city/market, school district.\n" +
    "- " + ctaInstruction + "\n" +
    "- Do NOT add, remove, or change any hashtags (there are none in the text you receive; do not add any).\n" +
    "- Do NOT add brand-new emojis; you may reuse existing ones.\n" +
    "- Return ONLY the full rewritten caption body (no hashtags, no commentary).\n\n" +
    "CAPTION BODY:\n" +
    body;

  let newBody = "";
  try {
    const res = await invokeLLM({
      model: HOOK_MODEL,
      messages: [{ role: "user", content: prompt }],
      maxTokens: 1400,
    });
    const raw = res.choices?.[0]?.message?.content;
    newBody = typeof raw === "string" ? raw.trim() : "";
  } catch (err) {
    console.error("[hookOptimizer] LLM failed, keeping original:", err);
    return { caption: original, changed: false, reason: "llm-error" };
  }

  // ---- Safety guards: fail safe to the original caption ----

  // 1. Non-empty.
  if (!newBody) return { caption: original, changed: false, reason: "empty-output" };

  // 2. No hashtags introduced into the body (hashtags live only in `tags`).
  if (newBody.includes("#")) {
    return { caption: original, changed: false, reason: "added-hashtags" };
  }

  // 3. The Comment CTA line must survive verbatim.
  if (cta) {
    const ctaNorm = norm(cta.line);
    const survived = newBody.split("\n").some(l => norm(l) === ctaNorm);
    if (!survived) {
      return { caption: original, changed: false, reason: "cta-dropped" };
    }
    // And it must not be the very first non-empty line.
    const firstNonEmpty = newBody.split("\n").find(l => l.trim().length > 0) ?? "";
    if (norm(firstNonEmpty) === ctaNorm) {
      return { caption: original, changed: false, reason: "cta-is-opener" };
    }
  }

  // 4. Don't let the body collapse to something much shorter (protects the
  //    user's long-caption preference). Allow some shrink but not a gutting.
  if (newBody.length < body.length * 0.6) {
    return { caption: original, changed: false, reason: "too-short" };
  }

  // Re-attach the ORIGINAL hashtag block verbatim.
  const finalCaption = tags ? `${newBody.replace(/\s+$/, "")}\n\n${tags}` : newBody;

  // Hashtags must be byte-identical to the original set.
  const before = hashtagSet(original);
  const after = hashtagSet(finalCaption);
  let hashtagsMatch = before.size === after.size;
  before.forEach(h => {
    if (!after.has(h)) hashtagsMatch = false;
  });
  if (!hashtagsMatch) {
    return { caption: original, changed: false, reason: "hashtags-changed" };
  }

  const changed = norm(finalCaption) !== norm(original);
  return { caption: finalCaption, changed };
}

/**
 * Heuristic weak-first-frame flag. We can't inspect the video pixels on the
 * Node runtime, but a caption/opening that leads with a logo/brand card or a
 * static "exterior" mention often signals a weak opening frame. This is a HINT
 * surfaced to the owner, not an automatic edit.
 */
export function likelyWeakFirstFrame(caption: string): boolean {
  const first = (caption || "").split("\n").find(l => l.trim().length > 0) ?? "";
  const f = first.toLowerCase();
  return (
    /logo|lifestyle design realty|brand|intro card|title card/.test(f) ||
    /^\s*(exterior|front of|drone shot|aerial)\b/.test(f)
  );
}
