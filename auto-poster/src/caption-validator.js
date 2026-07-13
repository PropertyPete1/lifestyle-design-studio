/**
 * Caption Validation Gate — ensures no unvalidated LLM output is ever published.
 * 
 * REQUIRED markers: output must contain these (case-insensitive):
 *   - "comment TOUR" (the primary CTA)
 *   - "Lifestyle Design Realty" (brand)
 *   - At least one themed section emoji: ✨ or 💸
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

const FORBIDDEN_PATTERNS = [
  // Markdown formatting
  { pattern: /\*\*/, label: "markdown bold (**)" },
  { pattern: /^##\s/m, label: "markdown header (##)" },
  { pattern: /```/, label: "markdown code block" },
  // Assistant-speak phrases (case-insensitive)
  { pattern: /I'd love to/i, label: 'assistant-speak: "I\'d love to"' },
  { pattern: /I need/i, label: 'assistant-speak: "I need"' },
  { pattern: /Can you provide/i, label: 'assistant-speak: "Can you provide"' },
  { pattern: /I'm sorry/i, label: 'assistant-speak: "I\'m sorry"' },
  { pattern: /As an AI/i, label: 'assistant-speak: "As an AI"' },
  { pattern: /\bhere's\b/i, label: 'assistant-speak: "here\'s"' },
  { pattern: /let me know/i, label: 'assistant-speak: "let me know"' },
  { pattern: /I don't have/i, label: 'assistant-speak: "I don\'t have"' },
  { pattern: /I cannot/i, label: 'assistant-speak: "I cannot"' },
  { pattern: /I can't/i, label: 'assistant-speak: "I can\'t"' },
  { pattern: /please provide/i, label: 'assistant-speak: "please provide"' },
  { pattern: /Could you/i, label: 'assistant-speak: "Could you"' },
  { pattern: /I'd be happy to/i, label: 'assistant-speak: "I\'d be happy to"' },
  { pattern: /Unfortunately/i, label: 'assistant-speak: "Unfortunately"' },
  { pattern: /I apologize/i, label: 'assistant-speak: "I apologize"' },
];

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

  // Check FORBIDDEN markers
  for (const { pattern, label } of FORBIDDEN_PATTERNS) {
    if (pattern.test(caption)) {
      failures.push(`CONTAINS forbidden: ${label}`);
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

CRITICAL CORRECTION: Your previous output was NOT a valid Instagram caption. It contained assistant-speak, markdown formatting, or was missing required elements.

Output ONLY the caption text following the exact structure specified above. Do NOT ask questions, do NOT use markdown, do NOT explain what you need. If you lack specific details, use generic new-construction descriptions. You MUST include:
- "comment TOUR" as the primary CTA
- "Lifestyle Design Realty" on its own line
- At least one ✨ or 💸 themed section`;
