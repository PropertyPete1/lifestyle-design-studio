/**
 * yt-concept-fallback.js — a filmable concept for a window whose words are not one.
 *
 * WHY THE MECHANICAL LADDER IS NOT ENOUGH, measured on card 11.
 *
 * yt-scene-keywords.js derives queries from the transcript by rules of English
 * — drop the names, keep the nouns, rank by rarity — and on card 11 that
 * produced [animal well] for a take about acre lots ("an acre, animals, a
 * well"), [northeast anybody] for "Bigger homes, more yard", [matters kids] for
 * "this matters even if your kids are grown". Rarity is a fine signal for what
 * makes a window DIFFERENT and no signal at all for what a camera can point at:
 * the rarest words in a spoken sentence are routinely its least filmable ones.
 * The rooster that played over the Timberwood Park narration is that gap, on
 * screen, for ten seconds.
 *
 * So when a vision client is available, the window's phrase is put to the same
 * small model that already grades the clips, and it answers one question: what
 * concrete, generic thing should stock footage SHOW while these words are
 * spoken? "morning commute traffic" for the five-minutes-on-a-normal-morning
 * window; "family front yard" for the kids-are-grown window. The mechanical
 * ladder remains the query source when there is no client (the dry run), and
 * the floor of that ladder is unchanged.
 *
 * THE SAFETY PROPERTY IS STILL STRUCTURAL. The model is ASKED for generic
 * concepts, but nothing downstream trusts that it listened: its output is
 * passed through the same classification the transcript goes through, and any
 * token the script capitalises as a name, any spatial word, and any token on
 * the window's own dropped-names list is removed before the query is built. A
 * misbehaving model can cost this window its concept; it cannot put a place
 * name into a search, because the place name is removed by code that does not
 * know what a model is.
 *
 * FAILS CLOSED, PER RUNG RATHER THAN PER BUILD. Any API error, timeout, or
 * unparseable answer returns null and the caller moves to the next rung — the
 * exact contract fetchStockClip has with its own failures. A build with a dead
 * model renders like a build with no model: mechanical queries, then the
 * established floor.
 */

import { FUNCTION_WORDS } from "./yt-scene-keywords.js";

/** The model that grades clips also names concepts — one dependency, not two. */
const CONCEPT_MODEL = process.env.YT_CONCEPT_MODEL || "claude-haiku-4-5-20251001";

/**
 * Direction and relation words, mirrored from the depiction-subject rules.
 *
 * Duplicated deliberately rather than exported from yt-scene-keywords: that
 * module's SPATIAL set is private to its own subject derivation, and importing
 * it would couple the two modules' internals. The list is closed-class English
 * and changes never.
 */
const SPATIAL = new Set(
  "north south east west northeast northwest southeast southwest inner outer left right nearby beyond further farther closer nearer above below upper lower".split(/\s+/)
);

function normalise(token) {
  return String(token || "").toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9-]/g, "");
}

/**
 * Strip everything from a model-proposed phrase that must never reach a search.
 *
 * `banned` carries the window's own dropped proper nouns and the script's
 * proper lexicon, both lower-cased — the words the transcript pipeline already
 * decided are names. The test for this function hands it a model answer that
 * names the neighbourhood and asserts the name does not survive.
 */
export function sanitiseConcept(phrase, { banned = new Set(), maxWords = 4 } = {}) {
  const words = String(phrase || "")
    .split(/\s+/)
    .map(normalise)
    .filter(Boolean)
    .filter((w) => !FUNCTION_WORDS.has(w))
    .filter((w) => !SPATIAL.has(w))
    .filter((w) => !banned.has(w))
    // A capitalised token in the model's own answer is gone by normalisation;
    // what this catches is digits-and-punctuation figures, which describe a
    // quantity rather than a picture.
    .filter((w) => !/^[\d$,.%-]+$/.test(w))
    .slice(0, maxWords);
  return words.join(" ").trim() || null;
}

/**
 * Ask the model for a concrete, filmable stand-in for one window.
 *
 * @returns {{ query, subject, source: "concept" } | null}
 */
export async function deriveConcept({
  phrase,
  takeText = "",
  sectionTitle = "",
  banned = new Set(),
  client,
  model = CONCEPT_MODEL,
} = {}) {
  if (!client || !String(phrase || "").trim()) return null;

  const prompt = `You are choosing generic stock B-roll for an educational real-estate video.

While these words are spoken: "${phrase}"
(from a passage about: "${String(takeText).slice(0, 300)}"; section topic: "${sectionTitle}")

Name the ONE concrete, filmable thing generic stock footage should show during those words.

Rules:
- Concrete physical subjects only — things a camera can film. No abstractions, no emotions, no wordplay.
- NEVER name a specific place, city, neighbourhood, business, or brand. The footage stands in; it must not claim to BE anywhere.
- No spatial or directional claims (north of, closest, beyond) — footage cannot prove geography.
- Prefer everyday residential imagery when the words allow it: homes, yards, streets, families, commutes, documents.
- If the words genuinely support no footage, say so.

Respond with ONLY valid JSON:
{"filmable": true, "query": "2-4 word stock search phrase", "subject": "short noun phrase a reviewer could confirm in a frame"}
or
{"filmable": false}`;

  let text;
  try {
    const response = await client.messages.create({
      model,
      max_tokens: 128,
      messages: [{ role: "user", content: prompt }],
    });
    text = response?.content?.[0]?.text?.trim();
  } catch (err) {
    console.warn(`[Concept] derivation failed for "${String(phrase).slice(0, 40)}": ${err.message} — next rung`);
    return null;
  }

  let parsed;
  try {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    if (!match) return null;
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }

  // An explicit true is the only yes, same as the vision check.
  if (parsed.filmable !== true) return null;

  const query = sanitiseConcept(parsed.query, { banned });
  // The subject may be a little longer than the query — it is a sentence for a
  // reviewer, not a search — but it passes the same name/space stripping.
  const subject = sanitiseConcept(parsed.subject, { banned, maxWords: 6 }) || query;
  if (!query) return null;

  return { query, subject, source: "concept" };
}
