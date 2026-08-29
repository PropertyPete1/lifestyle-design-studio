/**
 * ldt-caption.js — captions in the Lifestyle Design Technologies voice.
 *
 * Two kinds of copy come out of here:
 *   - CLIP captions: for operator-supplied screen recordings of PRIMARY doing
 *     real work (compose-card sends, voice turns, THE FLOOR). The caption's
 *     job is to say what the viewer is actually watching, honestly.
 *   - PROMO captions: for generated promo carousels ($99/mo positioning).
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
import { pickHookStyle, loadWeights } from "./analytics.js";

let client = null;
function getClient() {
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

const MODEL = "claude-haiku-4-5-20251001";

/** Hook-style instructions in the LDT voice, keyed by the shared taxonomy. */
const LDT_HOOK_INSTRUCTIONS = {
  question: `Open with a direct question a busy owner would actually ask, e.g. "What did your CRM do for you this morning?"`,
  bold_claim: `Open with a bold-but-pinned claim, e.g. "My software briefed me before my coffee did." Only claims from the pinned list.`,
  wait_tease: `Open with a watch-this tease, e.g. "Watch what happens when a lead replies." It must describe what the clip actually shows.`,
  reaction: `Open with a genuine reaction, e.g. "Still not used to my CRM talking back."`,
  vibe: `Open with a calm, matter-of-fact scene line, e.g. "7:05 AM. The briefing is already on my phone."`,
};

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
  const opener = kind === "promo"
    ? "Meet PRIMARY. Your business's brain."
    : "This is PRIMARY, working. Not a mockup, not a demo reel. Our own software running our own business.";
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

  const context = kind === "promo"
    ? `You are writing an Instagram/TikTok caption for a PROMO image carousel about PRIMARY. Today's angle: ${angle}.`
    : `You are writing an Instagram/TikTok caption for a REAL screen recording of PRIMARY working (file: "${clipName}"). ` +
      `Describe it as what it is: our own product doing real work in our own business. Do not invent what the clip shows — speak generally about what PRIMARY does, from the pinned claims.`;

  const meta = claims.metaAngle?.enabled
    ? `\nMETA ANGLE (optional, encouraged, use at most once, verbatim or near-verbatim because it is literally true): "${claims.metaAngle.line}"`
    : "";

  return `${context}

VOICE: ${claims.company} (LDT). Plain-spoken, confident, a little wry. Short sentences. No hype adjectives where a receipt would do. Honest to a fault: this brand's whole pitch is that it never invents a number.

${claimsBlock}

NEVER (each of these has burned someone before):
${banned}

${LDT_HOOK_INSTRUCTIONS[hookStyle] || LDT_HOOK_INSTRUCTIONS.vibe}
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

/**
 * Generate a gate-checked LDT caption.
 * kind: "clip" (intake screen recording) | "promo" (generated promo post).
 * Never throws for quality reasons — falls back to the pinned caption.
 */
export async function generateLdtCaption({ kind = "clip", clipName = "", angle = "", brand, claims = loadLdtClaims() }) {
  const allowed = buildAllowedFigures(claims);
  const weights = loadWeights("ldt").weights;
  const hookStyle = pickHookStyle(weights);
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
      console.log(`[LDT Caption] ✓ Attempt ${attempt} passed the claims gate (hook: ${hookStyle}, ${caption.length} chars)`);
      return { caption, hookStyle, source: attempt === 1 ? "generated" : "generated_retry" };
    }
    console.warn(`[LDT Caption] Attempt ${attempt} failed the gate: ${check.failures.join("; ")}`);
    prompt += `\n\nYOUR PREVIOUS ATTEMPT WAS REJECTED: ${describeViolations(
      checkClaimsCompliance(caption, claims, allowed).violations
    ) || check.failures.join("; ")}. Fix every violation and rewrite the full caption.`;
  }

  console.warn("[LDT Caption] Falling back to the pinned caption (both attempts failed the gate)");
  const fallback = getLdtFallbackCaption(brand, claims, kind);
  return { caption: fallback, hookStyle: "pinned", source: "fallback" };
}
