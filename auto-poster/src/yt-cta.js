/**
 * yt-cta.js — what a call to action may promise on YouTube.
 *
 * YOUTUBE HAS NO DIRECT MESSAGES. A creator cannot message a viewer. Copy that
 * says "comment MATH and I'll DM you" or "I'll send it over" describes a
 * mechanic the platform does not have, and to the relocating buyer this channel
 * is for — who has used YouTube for years — it reads as someone who does not
 * know where they are posting. It is also a promise that cannot be kept, which
 * is worse than a weak CTA.
 *
 * The four mechanics that DO work are in VALID_MECHANICS below.
 *
 * THIS IS YOUTUBE-ONLY, AND DELIBERATELY NARROW.
 * Instagram DMs are real. The carousel pipeline's entire CTA is built on them,
 * caption-validator.js counts the word "DM" expecting exactly two, and
 * KEYWORD_PAYOFFS is shared between both pipelines. Nothing here is imported by
 * the carousel path, and the ban must never be applied to it.
 *
 * It lives in its own module rather than in yt-packaging.js because yt-script.js
 * needs it too, and importing packaging from script closes a cycle
 * (script -> packaging -> timeline -> script). ESM tolerates that; the binding
 * being undefined at module-init time is not worth the risk for one regex.
 */

export const VALID_MECHANICS = [
  "Comment [KEYWORD] and I'll reply with [the thing] — answered publicly in the thread",
  "Text me at [YT_TEXT_NUMBER]",
  "Email me at [YT_CONTACT_EMAIL]",
  "Link in the description",
];

/**
 * ALWAYS impossible: naming the mechanic itself. No channel rescues these.
 */
const HARD_PROMISE = /\b(?:i(?:'|’)?ll|i will|we(?:'|’)?ll|we will)\s+(?:dm|d\.m\.|direct[-\s]?message)\b|\bdm\s+you\b|\bi(?:'|’)?ll\s+message\s+you\b/i;

/**
 * Impossible ONLY when no delivery channel is named.
 *
 * "I'll send you the payment breakdown" is a DM promise if that is all the copy
 * says. It is a perfectly good promise if the same take also says "text me" —
 * he is describing what arrives, not inventing a mechanic.
 *
 * This distinction is not pedantry. The first version of this check was the
 * `send` pattern alone, and it flagged video 1's close, which reads: "Send me
 * the address... I'll send you your actual monthly payment in writing... My
 * number is on the screen and down in the description. Text me." That take is
 * fine, and a blunt rule would have forced a regeneration of good copy.
 */
const SOFT_PROMISE = /\b(?:i(?:'|’)?ll|i will|we(?:'|’)?ll|we will)\s+send\b(?!\s+(?:a\s+)?link)|\bsend\s+it\s+over\b/i;

/**
 * Somewhere in this block, a channel the message could actually arrive on.
 *
 * A phone number, the word text/email as a verb, or a pointer to the
 * description. "Reply" counts too — replying in the thread is delivery.
 */
const CHANNEL_NAMED = /\btext\s+(?:me|him)\b|\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b|\bemail\s+(?:me|him)\b|@[\w.-]+\.\w+|\bin\s+the\s+description\b|\blinks?\s+page\b|\bi(?:'|’)?ll\s+reply\b|\bi(?:'|’)?ll\s+answer\b/i;

/**
 * Find CTA copy promising something YouTube cannot do.
 *
 * Evaluated per BLOCK rather than per line, because the ask and the channel are
 * usually different sentences of the same take — and splitting them apart is
 * what produced the false positive described above.
 *
 * @returns {string[]} the offending blocks, trimmed for a log
 */
export function findImpossibleCta(text) {
  const found = [];
  for (const block of String(text || "").split(/\n{2,}/)) {
    if (!block.trim()) continue;

    if (HARD_PROMISE.test(block)) {
      found.push(block.trim().slice(0, 120));
      continue;
    }
    // A soft promise is only a problem when nothing says how it arrives.
    if (SOFT_PROMISE.test(block) && !CHANNEL_NAMED.test(block)) {
      found.push(block.trim().slice(0, 120));
    }
  }
  return found;
}

/** True when the copy is clean. Convenience for call sites that want a boolean. */
export function ctaIsPossible(text) {
  return findImpossibleCta(text).length === 0;
}
