/**
 * Caption Validation Gate — ensures no unvalidated LLM output is ever published.
 * 
 * REQUIRED markers: output must contain these (case-insensitive):
 *   - "comment TOUR" EXACTLY ONCE (primary CTA at the end)
 *   - "Lifestyle Design Realty" (brand)
 *   - At least one themed section emoji: ✨ or 💸
 * 
 * COMMENT DISCIPLINE:
 *   - "comment TOUR" must appear exactly 1 time (not 0, not 2+)
 *   - The word "comment" must appear at most 2 times total in the caption
 *   - "DM" must appear at most 2 times (primary CTA "I'll DM you" + secondary "DM LIST")
 * 
 * FORBIDDEN markers: reject if output contains any of these:
 *   - Markdown: "**" (bold), "##" (headers), "```"
 *   - Assistant-speak phrases (case-insensitive)
 * 
 * On failure: returns { valid: false, reason } so caller can retry or use fallback.
 */

const REQUIRED_MARKERS = [
  { pattern: /comment\s+TOUR/i, label: '"comment TOUR" CTA' },
  { pattern: /Lifestyle\s+Design\s+Realty/i, label: '"Lifestyle Design Realty" brand' },
  { pattern: /[✨💸]/, label: "themed section emoji (✨ or 💸)" },
];

// FULL-TEXT forbidden patterns — scanned against the entire caption
const FORBIDDEN_FULL_TEXT = [
  // Markdown formatting
  { pattern: /\*\*/, label: "markdown bold (**)" },
  { pattern: /^##\s/m, label: "markdown header (##)" },
  { pattern: /```/, label: "markdown code block" },
  // Hard refusal phrases — these NEVER appear in legitimate captions
  { pattern: /I'd love to/i, label: 'assistant-speak: "I\'d love to"' },
  { pattern: /I need/i, label: 'assistant-speak: "I need"' },
  { pattern: /Can you provide/i, label: 'assistant-speak: "Can you provide"' },
  { pattern: /I'm sorry/i, label: 'assistant-speak: "I\'m sorry"' },
  { pattern: /As an AI/i, label: 'assistant-speak: "As an AI"' },
  { pattern: /I don't have/i, label: 'assistant-speak: "I don\'t have"' },
  { pattern: /I cannot/i, label: 'assistant-speak: "I cannot"' },
  { pattern: /I can't/i, label: 'assistant-speak: "I can\'t"' },
  { pattern: /please provide/i, label: 'assistant-speak: "please provide"' },
  { pattern: /I'd be happy to/i, label: 'assistant-speak: "I\'d be happy to"' },
  { pattern: /Unfortunately/i, label: 'assistant-speak: "Unfortunately"' },
  { pattern: /I apologize/i, label: 'assistant-speak: "I apologize"' },
];

// FIRST-150-CHARS-ONLY forbidden patterns — these phrases appear in legit captions
// (e.g. "here's what $340K gets you", "let me know in the comments", "Could you see yourself here?")
// but refusals/clarifying questions always start at the beginning.
const FORBIDDEN_OPENING_ONLY = [
  { pattern: /\bhere's\b/i, label: 'assistant-speak opening: "here\'s"' },
  { pattern: /let me know/i, label: 'assistant-speak opening: "let me know"' },
  { pattern: /Could you/i, label: 'assistant-speak opening: "Could you"' },
];

// ─── Monthly-payment figure guard ────────────────────────────────────────────
//
// HARD BUSINESS RULE: the system must NEVER state a specific monthly payment.
// Payments may only be TEASED ("lower than most people guess"); the real number
// is what the lead receives after engaging. Stating a computed payment is both a
// lead-gen leak and an advertising-compliance problem (an unlicensed party
// quoting financing terms).
//
// Until now this rule existed ONLY as prompt text. Prompt instructions are not a
// control — a model that ignores them publishes a number with nothing in the way.
// These patterns are the deterministic backstop.
//
// Must NOT fire on legitimate copy:
//   "starting at $389,000"                        (a price, not a payment)
//   "the monthly payment is lower than you think" (a tease, no figure)
//   "I'll send the exact payment breakdown"       (the CTA)
const NUMBER_WORD = "(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)";

const PAYMENT_FIGURE_PATTERNS = [
  // "$1,850/mo", "$1850 per month", "$1,850 a month"
  { pattern: /\$\s?\d[\d,]*(?:\.\d{2})?\s*(?:\/|per\s+|a\s+|each\s+|every\s+)\s*(?:mo\b|month)/i, label: "$X per month" },
  // "1,850 dollars a month"
  { pattern: /\b\d[\d,]*(?:\.\d{2})?\s*dollars?\s*(?:\/|per\s+|a\s+|each\s+|every\s+)\s*(?:mo\b|month)/i, label: "X dollars per month" },
  // "monthly payment of $1,850" / "payment is about $1850" / "mortgage payment: $1,850"
  { pattern: /(?:monthly\s+payment|mortgage\s+payment|payment|note|PITI)\b[^.!?\n]{0,25}?\$\s?\d[\d,]*/i, label: "payment tied to a $ figure" },
  // "$1,850 monthly"
  { pattern: /\$\s?\d[\d,]*(?:\.\d{2})?\s+monthly\b/i, label: "$X monthly" },
  // spelled out: "eighteen hundred a month", "two thousand dollars per month"
  { pattern: new RegExp(`\\b${NUMBER_WORD}(?:[\\s-]+${NUMBER_WORD})?\\s+(?:hundred|thousand)\\b[^.!?\\n]{0,20}?(?:\\/|per\\s+|a\\s+|each\\s+|every\\s+)\\s*(?:mo\\b|month)`, "i"), label: "spelled-out payment per month" },
  // "payment ... eighteen hundred" (voiceover scripts spell numbers as words)
  { pattern: new RegExp(`(?:monthly\\s+payment|mortgage\\s+payment)\\b[^.!?\\n]{0,25}?\\b${NUMBER_WORD}(?:[\\s-]+${NUMBER_WORD})?\\s+(?:hundred|thousand)\\b`, "i"), label: "payment tied to a spelled-out figure" },
];

/**
 * Detect a stated monthly payment figure in generated text.
 * Applies to BOTH captions and voiceover scripts.
 * @returns {{ found: boolean, label?: string, match?: string }}
 */
export function findMonthlyPaymentFigure(text) {
  if (!text || typeof text !== "string") return { found: false };
  for (const { pattern, label } of PAYMENT_FIGURE_PATTERNS) {
    const m = text.match(pattern);
    if (m) return { found: true, label, match: m[0].trim() };
  }
  return { found: false };
}

/**
 * Validate a generated caption against required and forbidden markers.
 * @param {string} caption - The generated caption text
 * @returns {{ valid: boolean, reason?: string, failures?: string[] }}
 */
export function validateCaption(caption) {
  if (!caption || typeof caption !== "string") {
    return { valid: false, reason: "Caption is empty or not a string", failures: ["empty"] };
  }

  // Minimum length check (a real caption is at least 200 chars)
  if (caption.length < 200) {
    return { valid: false, reason: `Caption too short (${caption.length} chars, minimum 200)`, failures: ["too_short"] };
  }

  const failures = [];

  // Check REQUIRED markers
  for (const { pattern, label } of REQUIRED_MARKERS) {
    if (!pattern.test(caption)) {
      failures.push(`MISSING required: ${label}`);
    }
  }

  // COMMENT DISCIPLINE: "comment TOUR" must appear EXACTLY ONCE
  const commentTourMatches = (caption.match(/comment\s+TOUR/gi) || []).length;
  if (commentTourMatches > 1) {
    failures.push(`"comment TOUR" appears ${commentTourMatches} times (must be exactly 1)`);
  }

  // Total "comment" occurrences must be at most 2 (the CTA line + possibly "comment below" type phrasing)
  const commentMatches = (caption.match(/\bcomment\b/gi) || []).length;
  if (commentMatches > 2) {
    failures.push(`Word "comment" appears ${commentMatches} times (max 2 allowed)`);
  }

  // "DM" must appear at most 2 times (primary CTA "I'll DM you" + secondary "DM LIST")
  const dmMatches = (caption.match(/\bDM\b/gi) || []).length;
  if (dmMatches > 2) {
    failures.push(`"DM" appears ${dmMatches} times (max 2 allowed)`);
  }

  // Check FORBIDDEN markers — full text scan
  for (const { pattern, label } of FORBIDDEN_FULL_TEXT) {
    if (pattern.test(caption)) {
      failures.push(`CONTAINS forbidden: ${label}`);
    }
  }

  // HARD RULE: never state a monthly payment figure
  const payment = findMonthlyPaymentFigure(caption);
  if (payment.found) {
    failures.push(`CONTAINS forbidden monthly payment figure (${payment.label}): "${payment.match}"`);
  }

  // Check FORBIDDEN markers — first 150 chars only (phrases that are legit mid-caption)
  const opening = caption.slice(0, 150);
  for (const { pattern, label } of FORBIDDEN_OPENING_ONLY) {
    if (pattern.test(opening)) {
      failures.push(`CONTAINS forbidden in opening: ${label}`);
    }
  }

  if (failures.length > 0) {
    const reason = failures.join("; ");
    return { valid: false, reason, failures };
  }

  return { valid: true };
}

/**
 * The retry instruction appended to the prompt on validation failure.
 */
export const RETRY_INSTRUCTION = `

CRITICAL CORRECTION: Your previous output was NOT a valid Instagram caption. It contained assistant-speak, markdown formatting, too many CTAs, or was missing required elements.

Output ONLY the caption text following the exact structure specified above. Do NOT ask questions, do NOT use markdown, do NOT explain what you need. If you lack specific details, use generic new-construction descriptions.

STRICT CTA RULES:
- "comment TOUR" must appear EXACTLY ONCE — in the primary CTA at the end, nowhere else
- The word "comment" must not appear more than twice total
- "DM" appears at most twice (only in the two CTA lines)
- NO asking/requesting in the value sections (✨, 💸, 🌳, 🎓) — those sections INFORM, they don't ask

You MUST include:
- "comment TOUR" ONCE as the primary CTA at the end
- "Lifestyle Design Realty" on its own line
- At least one ✨ or 💸 themed section`;
