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
 * Strip a model-proposed SUBJECT of everything unsafe — and nothing else.
 *
 * A QUERY AND A SUBJECT ARE DIFFERENT KINDS OF STRING, and run 31906386739
 * proved what happens when one function serves both. `sanitiseConcept` removes
 * function words because a stock search wants keywords; applied to the
 * subject it turned "a sheriff vehicle on an open rural road" into "sheriff
 * vehicle open" — and the vision check, asked whether footage "plausibly
 * depicts 'sheriff vehicle open'", read the stray adjective as a literal
 * requirement and rejected three genuine police clips because "the vehicle
 * doors do not appear to be visibly open". A condition nobody meant to impose,
 * invented by the sanitiser, failing footage that was exactly right.
 *
 * So the subject keeps its function words, its order, and its readability. It
 * loses only what safety demands: any name the transcript pipeline already
 * classified as proper (so a place name still cannot reach the check — the
 * structural property is unchanged), and the direction words a clip can never
 * prove. What survives is a sentence a human could answer about a frame,
 * which is the only kind of question the check can answer honestly.
 */
export function sanitiseSubject(phrase, { banned = new Set(), maxWords = 10 } = {}) {
  const kept = String(phrase || "")
    .split(/\s+/)
    .filter(Boolean)
    .filter((raw) => {
      const n = normalise(raw);
      if (!n) return false;
      if (banned.has(n)) return false;
      if (SPATIAL.has(n)) return false;
      if (/^[\d$,.%-]+$/.test(n)) return false;
      return true;
    })
    .slice(0, maxWords)
    // Commas and stray punctuation survive the word filter and read fine; a
    // trailing one does not.
    .join(" ")
    .replace(/\s*,\s*$/, "")
    .trim();

  if (!kept) return null;
  // A subject that is nothing but function words asks the check nothing.
  const hasContent = kept.split(/\s+/).some((w) => {
    const n = normalise(w);
    return n && !FUNCTION_WORDS.has(n);
  });
  return hasContent ? kept : null;
}

/**
 * The part of the prompt that makes a second ask different from the first.
 *
 * Video 2's build died twice (runs 33586116393 and 33606652718) on one
 * 6-second window of s6t2 — "trips, the truck, the savings" — and the ladder
 * record shows why a retry could not help: the model was asked the same
 * question twice and answered "pickup truck parked in a residential driveway"
 * twice, the search returned semi-trucks and a man holding a STOP sign twice,
 * and the reviewer rejected all six twice. A retry that carries no memory of
 * the first attempt is a re-run.
 *
 * So the second ask names what was tried and what the reviewer said, and asks
 * for a DIFFERENT KIND of scene — a different object class, not a variation.
 * The reasons are the reviewer's own words, clipped; the subjects are the
 * sanitised strings this module produced or the window's own name-stripped
 * words, so nothing new can reach the model that did not already pass the
 * proper-noun rules. The model's answer goes through the same sanitiser as
 * a first answer regardless.
 */
export function rejectedBlock(rejected = []) {
  const rows = (Array.isArray(rejected) ? rejected : []).filter((r) => r && (r.subject || r.query));
  if (rows.length === 0) return "";
  const line = (r) => {
    const reasons = (Array.isArray(r.reasons) ? r.reasons : [])
      .filter((x) => typeof x === "string" && x.trim())
      .slice(0, 2)
      .map((x) => x.replace(/\s+/g, " ").trim().slice(0, 140));
    const what = r.subject && r.query && r.subject !== r.query ? `"${r.subject}" (searched "${r.query}")` : `"${r.subject || r.query}"`;
    const why = r.exhausted ? "every clip it finds is already used in this video" : reasons.length ? reasons.join(" / ") : "the search found nothing usable";
    return `- ${what}: ${why}`;
  };
  const words = rows.filter((r) => !r.viaConcept).slice(-2);
  const scenes = rows.filter((r) => r.viaConcept).slice(-3);
  const parts = [];
  if (words.length) {
    // THE RAW WORDS ARE NOT A DESCRIBED SCENE. "highway running" pulled up
    // joggers and the scene that then landed was "highway traffic driving" —
    // the same object class, described properly. So a words-only refusal is
    // information about the query, not a ban on the subject.
    parts.push(
      `The window's own words were searched as-is (not as a described scene) and the results were refused:\n${words.map(line).join("\n")}\nThat says the bare words pull up the wrong footage, not that the subject is wrong — describe the right scene properly.`
    );
  }
  if (scenes.length) {
    parts.push(
      `Scenes ALREADY PROPOSED for these exact words and refused:\n${scenes.map(line).join("\n")}\nDo not propose these again, or anything of the same kind. Name a DIFFERENT kind of everyday scene — a different object class, not a variation on the same one — that fits these words and that a generic stock library reliably has.`
    );
  }
  return `\n${parts.join("\n\n")}\n`;
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
  // What was already tried for THESE words and rejected by the frame reviewer
  // — [{ subject, query, reasons: [..] }]. See rejectedBlock for why this is
  // the difference between a retry and a re-run.
  rejected = [],
  client,
  model = CONCEPT_MODEL,
} = {}) {
  if (!client || !String(phrase || "").trim()) return null;

  const prompt = `You are choosing generic stock B-roll for an educational real-estate video.

While these words are spoken: "${phrase}"
(from a passage about: "${String(takeText).slice(0, 300)}"; section topic: "${sectionTitle}")
${rejectedBlock(rejected)}
Name the ONE concrete, filmable thing generic stock footage should show during those words.

Rules:
- Concrete physical subjects only — things a camera can film. No abstractions, no emotions, no wordplay.
- NEVER name a specific place, city, neighbourhood, business, or brand. The footage stands in; it must not claim to BE anywhere.
- No spatial or directional claims (north of, closest, beyond) — footage cannot prove geography.
- NEVER name a subject that is itself readable text — documents, forms, bills, statements, screens, signs, letters. Footage of those IS text on screen, and any clip showing readable words is rejected downstream without exception. When the spoken words are about paperwork or money arriving, name the surrounding human scene instead: hands opening envelopes at a kitchen table, a mailbox in front of a house, a person at a desk with unopened mail.
- Prefer everyday residential imagery when the words allow it: homes, yards, streets, families, commutes.
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
  // The subject is a QUESTION FOR A REVIEWER, not a search string: it keeps
  // its function words so it still reads as English. See sanitiseSubject for
  // the run that paid for the distinction. Falls back to the query only when
  // the model gave no usable subject at all — a bare noun phrase is a poor
  // question but an answerable one.
  const subject = sanitiseSubject(parsed.subject, { banned }) || query;
  if (!query) return null;

  return { query, subject, source: "concept" };
}
