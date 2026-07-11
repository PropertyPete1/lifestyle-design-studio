/**
 * Shared text sanitizer — strips AI-sounding patterns from generated captions.
 * 
 * Used by both caption.js (Instagram) and linkedin.js to ensure no em-dashes
 * or other AI tells make it into published content.
 */

/**
 * Strip em/en dashes and clean up resulting punctuation.
 * Belt-and-suspenders: even if the prompt says "no dashes", models sometimes ignore it.
 */
export function stripDashes(text) {
  let t = text;
  // Replace em/en dashes with periods (handles "word — word" and "word—word")
  t = t.replace(/\s*[—–]\s*/g, ". ");
  // Clean up double punctuation artifacts: ". ." → "." and ", ." → "."
  t = t.replace(/\.\s*\.\s*/g, ". ");
  t = t.replace(/,\s*\.\s*/g, ". ");
  // Clean up period after emoji (e.g. "💸. builder" → "💸 builder")
  t = t.replace(/([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}])\.\s*/gu, "$1 ");
  return t;
}

/**
 * Full sanitizer for Instagram captions.
 * Strips dashes, normalizes whitespace, preserves hashtags and emojis.
 */
export function sanitizeCaption(text) {
  if (!text) return text;
  let t = stripDashes(text);
  // Normalize excessive blank lines
  t = t.replace(/\n{3,}/g, "\n\n").trim();
  return t;
}
