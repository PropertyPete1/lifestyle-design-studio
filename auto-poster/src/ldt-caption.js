/**
 * ldt-caption.js — captions in the Lifestyle Design Technologies voice.
 *
 * Two families of copy come out of here:
 *   - CLIP captions: for operator-supplied screen recordings of PRIMARY doing
 *     real work (compose-card sends, voice turns, THE FLOOR). The caption's
 *     job is to say what the viewer is actually watching, honestly.
 *   - SELF-MADE captions: for the generated formats ($99/mo positioning) —
 *     the 8-slide narrative carousel, the single promo card, and the silent
 *     text-motion reel (kind: "carousel" | "card" | "text_reel").
 *
 * Every caption — generated, retried, or fallback — passes through the
 * deterministic claims gate (ldt-claims-gate.js). The model is TOLD the rules,
 * but the gate is what enforces them: one retry with the violations named,
 * then the pinned fallback, which the test suite proves gate-clean. A caption
 * that cannot pass does not post.
 *
 * Voice: plain-spoken, confident, a little wry. Short. No hype adjectives
 * doing the work a receipt should do. The meta angle ("this post was
 * scheduled and captioned by the product it's about") is encouraged exactly
 * because it is true of every caption this module emits.
 */
import Anthropic from "@anthropic-ai/sdk";
import { sanitizeCaption } from "./sanitize.js";
import { loadLdtClaims, buildAllowedFigures, checkClaimsCompliance, describeViolations } from "./ldt-claims-gate.js";
import { planVariation } from "./variation.js";
import { validPosts } from "./state.js";
import { kindOfEntry, previousLdtHookStyle } from "./ldt-slot-filler.js";

let client = null;
function getClient() {
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

const MODEL = "claude-haiku-4-5-20251001";

/**
 * Hook-style instructions in the LDT voice, keyed by the CANONICAL taxonomy
 * (hook-styles.js) so the variation engine's picks and the learn step's
 * scoring speak the same names.
 */
const LDT_HOOK_INSTRUCTIONS = {
  question: `Open with a direct question a busy owner would actually ask, e.g. "What did your CRM do for you this morning?"`,
  bold_claim: `Open with a bold-but-pinned claim, e.g. "My software briefed me before my coffee did." Only claims from the pinned list.`,
  pov: `Open with a calm, matter-of-fact scene line, e.g. "7:05 AM. The briefing is already on my phone."`,
  stat: `Open with one pinned proof number doing the work, e.g. "150 nurture emails in one day. Every one logged." Pinned figures only.`,
  story_open: `Open mid-story with a genuine moment, e.g. "Still not used to my CRM talking back."`,
  pattern_interrupt: `Open with a watch-this interrupt, e.g. "Watch what happens when a lead replies." It must describe what the clip actually shows.`,
};

/**
 * The LDT lane's variation plan — hook style via the shared engine, steered
 * by learning/brief-ldt.json (written weekly by run-learning-loop.mjs) and
 * never by another brand's brief.
 *
 * The engine's previous-style scan skips typed entries by design (that rule
 * keeps linkedin/trial receipts out of the realty rotation), so the LDT view
 * hands it ONLY this brand's content entries — clips AND self-made formats,
 * with the type field dropped — brand-scoped history in, brand-scoped
 * anti-repeat out. The previous style itself comes from previousLdtHookStyle
 * (the #117 `previousStyle` seam): ONE rotation for the whole lane, so a
 * morning carousel's hook style is excluded from the evening clip's caption
 * and vice versa.
 */
export function pickLdtVariation(log, { rand, now, brief } = {}) {
  const ldtPosts = validPosts(log)
    .filter(p => p.brand === "ldt" && (p.type === "ldt_clip" || kindOfEntry(p)))
    .map(({ type: _type, ...rest }) => rest);
  return planVariation({
    log: { posts: ldtPosts },
    brand: "ldt",
    previousStyle: previousLdtHookStyle(log),
    rand, now, brief,
  });
}

/**
 * Append the brand's locked hashtag set. Same doctrine as the realty
 * lockHashtags: whatever tags the model wrote are stripped first, so the
 * committed set is the only set.
 */
export function lockLdtHashtags(caption, brand) {
  const stripped = String(caption || "")
    .replace(/#[\wÀ-ɏ]+/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const tags = String(brand?.hashtags || "").trim();
  return tags ? `${stripped}\n\n${tags}` : stripped;
}

/**
 * Deterministic validity check for an LDT caption, claims gate included.
 * Returns { valid, failures: string[] }.
 */
export function validateLdtCaption(caption, brand, claims = loadLdtClaims(), allowedFigures = null) {
  const failures = [];
  const body = String(caption || "");

  if (body.length < 120) failures.push(`too short (${body.length} chars, need >= 120)`);
  if (body.length > 1600) failures.push(`too long (${body.length} chars, max 1600)`);

  const nameRe = new RegExp(`${claims.product}|${claims.company}`, "i");
  if (!nameRe.test(body)) failures.push(`must mention ${claims.product} or ${claims.company}`);

  const keyword = brand?.cta?.keyword;
  if (keyword) {
    const count = (body.match(new RegExp(`comment\\s+${keyword}`, "gi")) || []).length;
    if (count !== 1) failures.push(`"Comment ${keyword}" must appear exactly once (found ${count})`);
  }

  if (/[#]{2,}|\*\*|__|^#\s/m.test(body)) failures.push("no markdown formatting");
  if (/—|–/.test(body)) failures.push("no em/en dashes (house style)");

  const compliance = checkClaimsCompliance(body, claims, allowedFigures);
  for (const v of compliance.violations) {
    failures.push(v.type === "number"
      ? `unpinned figure ${v.detail}`
      : `banned phrase "${v.detail}" (${v.why})`);
  }

  return { valid: failures.length === 0, failures };
}

/**
 * The pinned fallback caption — used when generation fails the gate twice.
 * Built ONLY from pinned claims; tests assert it passes validateLdtCaption.
 */
export function getLdtFallbackCaption(brand, claims = loadLdtClaims(), kind = "clip") {
  const meta = claims.metaAngle?.enabled ? `\n\n${claims.metaAngle.line}` : "";
  const opener = kind === "clip"
    ? "This is PRIMARY, working. Not a mockup, not a demo reel. Our own software running our own business."
    : "Meet PRIMARY. Your business's brain.";
  const body =
    `${opener}\n\n` +
    `A voice-operated AI command center that watches your pipeline, runs your follow-up, and briefs you every morning at 7:05. ` +
    `It answers to its name. And nothing goes out until you approve it.\n\n` +
    `Born inside a working Texas brokerage. Running live today.\n\n` +
    `Solo starts at $99/mo with $0 setup. Cancel anytime, no contracts.` +
    meta +
    `\n\nComment ${brand?.cta?.keyword || "PRIMARY"} and I'll send you the demo.`;
  return lockLdtHashtags(body, brand);
}

function buildPrompt({ kind, clipName, angle, brand, claims, hookStyle }) {
  const claimsBlock = [
    "PINNED CLAIMS — the ONLY factual claims you may make (rephrase freely, but never add a fact or number that is not here):",
    ...claims.claims.map(c => `- ${c}`),
    "PRICING (quote exactly, or omit):",
    ...claims.pricing.map(c => `- ${c}`),
  ].join("\n");

  const banned = (claims.bannedPatterns || []).map(b => `- ${b.why}`).join("\n");

  // The self-made formats share one caption doctrine; the format line only
  // tells the model what the viewer is looking at while reading.
  const SELF_MADE_FORMAT = {
    carousel: "an 8-slide narrative image carousel",
    card: "a single promo card image",
    text_reel: "a short, silent text-motion reel",
  };
  const context = kind === "clip"
    ? `You are writing an Instagram/TikTok caption for a REAL screen recording of PRIMARY working (file: "${clipName}"). ` +
      `Describe it as what it is: our own product doing real work in our own business. Do not invent what the clip shows — speak generally about what PRIMARY does, from the pinned claims.`
    : `You are writing an Instagram/TikTok caption for ${SELF_MADE_FORMAT[kind] || "a promo post"} about PRIMARY. Today's angle: ${angle}.`;

  const meta = claims.metaAngle?.enabled
    ? `\nMETA ANGLE (optional, encouraged, use at most once, verbatim or near-verbatim because it is literally true): "${claims.metaAngle.line}"`
    : "";

  return `${context}

VOICE: ${claims.company} (LDT). Plain-spoken, confident, a little wry. Short sentences. No hype adjectives where a receipt would do. Honest to a fault: this brand's whole pitch is that it never invents a number.

${claimsBlock}

NEVER (each of these has burned someone before):
${banned}

${LDT_HOOK_INSTRUCTIONS[hookStyle] || LDT_HOOK_INSTRUCTIONS.pov}
${meta}

RULES:
- 300 to 900 characters. Plain text only: no markdown, no em-dashes, no bullet symbols.
- Mention PRIMARY by name.
- End with exactly this CTA line, once: "Comment ${brand?.cta?.keyword || "PRIMARY"} and I'll send you the demo."
- Do NOT write hashtags; they are appended separately.
- Every number you state must appear in the pinned claims above, exactly.

Write ONLY the caption text.`;
}

async function generateOnce(prompt) {
  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 700,
    messages: [{ role: "user", content: prompt }],
  });
  return response.content?.[0]?.text?.trim() || "";
}

/** The learning-loop tags an LDT entry records, mirroring main.js's shape. */
function generationTag(variation, captionSource) {
  return {
    engine: variation.engine,
    hook_style: variation.hook_style,
    hook_style_source: variation.hook_style_source,
    excluded_style: variation.excluded_style,
    caption_source: captionSource,
    // The LDT lane fixes its own 300-900 char range (business captions, not
    // the realty length rotation) — recorded as such, never as a bucket.
    caption_length_bucket: null,
    caption_length_source: "brand_fixed",
    brief_generated_at: variation.brief_generated_at,
  };
}

/**
 * Generate a gate-checked LDT caption.
 * kind: "clip" (intake screen recording) | "carousel" | "card" | "text_reel"
 * (the self-made formats).
 * `log` feeds the variation engine (brand-scoped anti-repeat + brief).
 * `variation` lets a caller that already planned this post's variation (the
 * self-made walk picks ONE style per slot and renders the visuals with it)
 * hand it in, so the caption and the rendered hook line always share a style;
 * omitted, the plan is picked here.
 * Never throws for quality reasons — falls back to the pinned caption.
 * Returns { caption, hookStyle, source, generation } — `generation` is the
 * decision-tag block the caller must record on the posted-log entry so the
 * weekly learn step can score the choice.
 */
export async function generateLdtCaption({ kind = "clip", clipName = "", angle = "", brand, claims = loadLdtClaims(), log = { posts: [] }, variation: plannedVariation = null }) {
  const allowed = buildAllowedFigures(claims);
  const variation = plannedVariation || pickLdtVariation(log);
  const hookStyle = variation.hook_style;
  let prompt = buildPrompt({ kind, clipName, angle, brand, claims, hookStyle });

  for (let attempt = 1; attempt <= 2; attempt++) {
    let raw;
    try {
      raw = await generateOnce(prompt);
    } catch (err) {
      console.warn(`[LDT Caption] Generation attempt ${attempt} failed: ${err.message?.slice(0, 150)}`);
      continue;
    }
    const caption = lockLdtHashtags(sanitizeCaption(raw), brand);
    const check = validateLdtCaption(caption, brand, claims, allowed);
    if (check.valid) {
      const source = attempt === 1 ? "generated" : "generated_retry";
      console.log(`[LDT Caption] ✓ Attempt ${attempt} passed the claims gate (hook: ${hookStyle}, ${caption.length} chars)`);
      return { caption, hookStyle, source, generation: generationTag(variation, source) };
    }
    console.warn(`[LDT Caption] Attempt ${attempt} failed the gate: ${check.failures.join("; ")}`);
    prompt += `\n\nYOUR PREVIOUS ATTEMPT WAS REJECTED: ${describeViolations(
      checkClaimsCompliance(caption, claims, allowed).violations
    ) || check.failures.join("; ")}. Fix every violation and rewrite the full caption.`;
  }

  console.warn("[LDT Caption] Falling back to the pinned caption (both attempts failed the gate)");
  const fallback = getLdtFallbackCaption(brand, claims, kind);
  // The fallback's opener is the pinned copy, NOT the planned style — tagging
  // the plan's style would score a caption under a hook it doesn't exhibit.
  // hook_style:null lets the learn step classify from the published text.
  const fallbackTag = { ...generationTag(variation, "fallback"), hook_style: null, hook_style_source: "fallback_pinned" };
  return { caption: fallback, hookStyle: "pinned", source: "fallback", generation: fallbackTag };
}
