/**
 * yt-thumbnail-hook.js — the three or four words on the thumbnail.
 *
 * NOT THE TITLE, AND NOT A CUT-DOWN OF IT. thumbnailText() in yt-thumbnail.js
 * derives its words by dropping filler from the title, which is the right
 * fallback and the wrong default: it produces "BEST NORTH SAN ANTONIO
 * NEIGHBORHOODS" next to a title that already says exactly that. The viewer
 * reads the same sentence twice and learns nothing from the second one.
 *
 * A thumbnail and a title are two halves of one pitch. The title carries the
 * search query, because that is what ranks. The thumbnail carries the reason to
 * stop, and it earns its space only by saying something the title does not:
 *
 *     title      Best North San Antonio Neighborhoods for Veterans, Compared
 *     thumbnail  YOUR EXEMPTION MISSES THIS
 *
 * TWO GATES, AND THE ORDER MATTERS.
 *
 * Redundancy is checked FIRST and mechanically, because "does this restate the
 * title" is a question about word overlap, not a matter of taste. The critic
 * gets three chances to notice; a set intersection notices every time and costs
 * nothing. This repo has already learned that lesson twice — once on connective
 * take openers, once on undefined local nouns — and both times the fix was to
 * stop asking a model to police something a regex could.
 *
 * What is left after that IS a matter of taste, and that is what the critic
 * scores: whether the line opens a loop, and whether it survives being 120
 * pixels wide in a sidebar. Legibility is scored rather than measured because
 * the failure is not "too many pixels" — fitSize already guarantees the type
 * fits — it is words that need a second look. A long word, an unfamiliar noun,
 * or a construction that has to be parsed all read fine at full size and turn
 * to mush at thumbnail scale.
 */

import Anthropic from "@anthropic-ai/sdk";
import { stripDashes } from "./sanitize.js";

const MODEL = "claude-opus-5";

/** Sized for thinking plus the answer, like every other budget here. */
const MODEL_BUDGET = 4000;

/** Three or four words. Five is the hard ceiling the renderer fits to. */
export const MIN_WORDS = 2;
export const MAX_WORDS = 5;

/** Everything must clear this, on both axes. */
export const PASS_MARK = 8;

const MAX_RETRIES = 2;

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

export async function callModel(system, userPrompt, maxTokens = MODEL_BUDGET) {
  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: userPrompt }],
  });
  const block = (res.content || []).find((b) => b?.type === "text" && typeof b.text === "string");
  return block ? block.text : "";
}

function parseJson(raw) {
  let t = String(raw || "").trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object in model output");
  return JSON.parse(t.slice(start, end + 1));
}

/**
 * Words that carry no meaning and so cannot make a line redundant.
 *
 * "for" appearing in both the title and the thumbnail says nothing about
 * whether they overlap; "neighborhoods" says everything.
 */
const STOPWORDS = new Set([
  "the", "a", "an", "of", "in", "on", "to", "for", "and", "or", "but", "is", "are",
  "was", "were", "be", "been", "it", "its", "this", "that", "these", "those", "your",
  "you", "my", "our", "their", "his", "her", "with", "from", "at", "by", "as", "if",
  "what", "which", "who", "how", "why", "when", "where", "not", "no", "yes", "do",
  "does", "did", "can", "will", "just", "than", "then", "so", "up", "out", "about",
]);

/** Content words, lowercased and stripped of punctuation. */
export function contentWords(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w));
}

/**
 * How much of the thumbnail is already in the title.
 *
 * Measured against the THUMBNAIL's own words rather than the union: a four-word
 * line where three words appear in the title is 75% redundant, and it does not
 * matter that the title has fifty other words. Returns 0 for an empty line,
 * which the word-count gate rejects separately.
 */
export function redundancyAgainst(hook, title) {
  const hookWords = contentWords(hook);
  if (hookWords.length === 0) return 0;
  const titleWords = new Set(contentWords(title));
  const shared = hookWords.filter((w) => titleWords.has(w));
  return shared.length / hookWords.length;
}

/**
 * Above this, the line is restating the title rather than complementing it.
 *
 * Half is deliberately permissive. A thumbnail is allowed to share the subject
 * — "EXEMPTION" may well appear in both — and forbidding all overlap would push
 * the writer into being oblique, which is worse than being redundant. What this
 * catches is the cut-down-title case, where nearly every word is borrowed.
 */
export const MAX_REDUNDANCY = 0.5;

export function validateHook(hook, title) {
  const failures = [];
  const text = String(hook ?? "").trim();
  if (!text) {
    failures.push("empty");
    return { valid: false, failures };
  }
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < MIN_WORDS) failures.push(`${words.length} word(s), need at least ${MIN_WORDS}`);
  if (words.length > MAX_WORDS) failures.push(`${words.length} words, max ${MAX_WORDS}`);

  // A word too long to read at thumbnail scale. Measured in characters rather
  // than pixels because fitSize already handles pixels — this is about the eye,
  // not the canvas.
  const longest = words.reduce((a, b) => (b.length > a.length ? b : a), "");
  if (longest.length > 12) failures.push(`"${longest}" is ${longest.length} chars — too long to read small`);

  const redundancy = redundancyAgainst(text, title);
  if (redundancy > MAX_REDUNDANCY) {
    const shared = contentWords(text).filter((w) => new Set(contentWords(title)).has(w));
    failures.push(
      `${Math.round(redundancy * 100)}% of it is already in the title (${shared.join(", ")}) — ` +
        `it has to say something the title does not`
    );
  }
  return { valid: failures.length === 0, failures, redundancy };
}

const WRITER_SYSTEM = `You write the text that goes on a YouTube thumbnail.

THE THUMBNAIL AND THE TITLE ARE TWO HALVES OF ONE PITCH. The title carries the search query — that is what ranks, and it is already written. Your job is the other half: the reason someone stops scrolling. You earn your space only by saying something the title does not.

  title      Best North San Antonio Neighborhoods for Veterans, Compared
  thumbnail  YOUR EXEMPTION MISSES THIS

Notice what that does. The title says WHAT the video is. The thumbnail says what it will COST you not to watch it. Never restate the title in fewer words.

THE RULES, all of them load-bearing:
- THREE OR FOUR WORDS. Five is the absolute ceiling. Two is fine if it lands.
- It is seen at about 120 pixels wide, next to eleven competitors. Short, common words only. Nothing over 12 characters. No word a person has to look at twice.
- Open a loop. A gap the viewer cannot close on their own — something is wrong, something is missing, something costs more than they think. Not a summary, not a label, not a category.
- Speak to the viewer. "YOUR", "YOU", "NOBODY TOLD YOU" beat a neutral description.
- No punctuation except a question mark if the line genuinely is a question. No quotes, no ellipses, no exclamation marks, no em dashes — they vanish at this size.
- No numbers unless the number IS the hook.
- Plain words. If it sounds like a headline in a newspaper you are writing it wrong; it should sound like the thing a friend says right before they tell you the catch.

WRITE THREE CANDIDATES, genuinely different from each other — not three drafts of one idea. Different angle each: one about a mistake, one about money, one about a surprise or a warning. They compete; the scorer picks.

Return ONLY valid JSON, no preamble and no code fences:
{"candidates": ["THREE OR FOUR WORDS", "A DIFFERENT ANGLE", "A THIRD ANGLE"]}`;

const CRITIC_SYSTEM = `You judge the text on a YouTube thumbnail. You are harsh, and you never inflate a score to be kind.

You score three axes out of 10. All three must reach 8.

"curiosity" — does this open a loop the viewer cannot close on their own?
  10  a specific cost or mistake the viewer now needs resolved. "YOUR EXEMPTION MISSES THIS"
   8  a clear gap, slightly general
   5  a category or a label. It describes the video instead of creating a need. "NEIGHBORHOOD GUIDE"
   2  restates the title in fewer words
   1  means nothing on its own

"legibility" — does it survive being 120 pixels wide, at a glance, beside eleven other thumbnails?
  10  three short common words, understood without a second look
   8  four words, all easy
   5  one long or unusual word that has to be decoded
   2  needs to be read twice, or leans on punctuation that disappears at that size
   1  unreadable small

"emotional_trigger" — is there a consequence in it? What gets CLICKED is not what is interesting but what is threatening or surprising: a mistake being made, money being lost, a warning, a thing everyone else got wrong.
  10  the viewer feels implicated — a mistake THEY might be making, money THEY are losing. "YOUR EXEMPTION MISSES THIS"
   8  a clear cost or warning, slightly impersonal
   5  interesting but consequence-free. It informs; nothing is at stake
   2  merely describes the topic, however cleanly — a label cannot trigger anything
   1  neutral to the point of wallpaper

A line can be non-redundant, legible, and still emotionally inert. That line does not get clicked, and this axis is where it fails.

Score the WORST case, not the average. A line that is brilliant and unreadable is unreadable.

Return ONLY valid JSON, no preamble and no code fences:
{"curiosity": 0, "legibility": 0, "emotional_trigger": 0, "worst_problem": "one sentence", "fix": "a specific instruction, one sentence"}`;

export const writerSystem = () => WRITER_SYSTEM;
export const criticSystem = () => CRITIC_SYSTEM;

/** The axes a thumbnail line must clear. */
export const HOOK_AXES = ["curiosity", "legibility", "emotional_trigger"];

/**
 * The emotional-trigger axis, stated once.
 *
 * The composite scorer (yt-thumbnail-face.js) judges finished face+text
 * thumbnails on THE SAME axis this critic judges the text line on — exporting
 * the definition is what keeps "emotional trigger" meaning one thing across
 * both judges instead of drifting into two private rubrics.
 */
export const EMOTIONAL_TRIGGER_DEFINITION =
  `"emotional_trigger" — is there a consequence in it? What gets CLICKED is not what is interesting but what is threatening or surprising: a mistake being made, money being lost, a warning, a thing everyone else got wrong.
  10  the viewer feels implicated — a mistake THEY might be making, money THEY are losing
   8  a clear cost or warning, slightly impersonal
   5  interesting but consequence-free. It informs; nothing is at stake
   2  merely describes the topic, however cleanly — a label cannot trigger anything
   1  neutral to the point of wallpaper`;

export function scoresPass(scores, mark = PASS_MARK) {
  return Boolean(scores) && HOOK_AXES.every((a) => (scores[a] ?? 0) >= mark);
}

export async function scoreHook(hook, { title, modelCall = callModel } = {}) {
  const clamp = (n) => Math.max(1, Math.min(10, Number(n) || 1));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await modelCall(
        CRITIC_SYSTEM,
        `TITLE (already written): ${title}\nTHUMBNAIL TEXT: ${hook}\n\nScore it.` +
          (attempt === 0 ? "" : "\n\nReturn ONLY the JSON object. No prose.")
      );
      const s = parseJson(raw);
      return {
        curiosity: clamp(s.curiosity),
        legibility: clamp(s.legibility),
        emotional_trigger: clamp(s.emotional_trigger),
        worst_problem: String(s.worst_problem || ""),
        fix: String(s.fix || ""),
      };
    } catch (err) {
      console.warn(`[ThumbHook] critic attempt ${attempt + 1} unparseable: ${err.message}`);
    }
  }
  // Degrade to unscored rather than throwing. The caller falls back to deriving
  // the text from the title, which is worse but always works.
  return { curiosity: 0, legibility: 0, emotional_trigger: 0, worst_problem: "critic unavailable", fix: "", unscored: true };
}

/**
 * Write the thumbnail line, gate it, and hand back the best of what survived.
 *
 * Returns { hook, scores, belowBar, criticUnavailable, attemptsUsed } — never
 * throws for a content reason. A thumbnail that is merely mediocre must not
 * stop a finished video from being delivered, so the caller decides what to do
 * with belowBar rather than having the decision made for it here.
 */
export async function generateThumbnailHook({
  title,
  script = null,
  maxRetries = MAX_RETRIES,
  modelCall = callModel,
} = {}) {
  if (!title) throw new Error("generateThumbnailHook requires a title");

  const context = [
    `TITLE (already written, do not restate it): ${title}`,
    script?.hook ? `THE VIDEO OPENS WITH: ${script.hook}` : null,
    script?.promise ? `WHAT IT PROMISES: ${script.promise}` : null,
    // The sections say what is actually IN the video, which is where a real
    // hook comes from — a promise the video does not keep is a worse thumbnail
    // than a dull one.
    script?.sections?.length
      ? `CHAPTERS:\n${script.sections.map((s) => `  - ${s.title}`).join("\n")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  const attempts = [];
  let feedback = "";

  // Ranking: weakest axis first, then the sum. A line with 10/10/6 loses to
  // 8/8/8 — the weak axis is what the viewer actually experiences.
  const minAxis = (sc) => Math.min(...HOOK_AXES.map((a) => sc[a] ?? 0));
  const sumAxes = (sc) => HOOK_AXES.reduce((n, a) => n + (sc[a] ?? 0), 0);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let candidates;
    try {
      const raw = await modelCall(WRITER_SYSTEM, `${context}\n\nWrite the thumbnail text.${feedback}`);
      const parsed = parseJson(raw);
      // The prompt asks for three candidates; a model that answers with the old
      // single-hook shape still gets its one line considered rather than a
      // parse failure.
      const list = Array.isArray(parsed.candidates) ? parsed.candidates : [parsed.hook];
      candidates = [...new Set(list.map((c) => stripDashes(String(c || "")).trim().toUpperCase()).filter(Boolean))];
    } catch (err) {
      console.warn(`[ThumbHook] attempt ${attempt + 1}: unparseable output (${err.message})`);
      feedback = `\n\nYour previous output could not be parsed as JSON: ${err.message}. Return ONLY the JSON object.`;
      continue;
    }

    // Mechanical gates first, per candidate. Cheap, deterministic, and they
    // catch the failure the critic is worst at noticing.
    const survivors = [];
    for (const hook of candidates) {
      const structure = validateHook(hook, title);
      if (!structure.valid) {
        console.warn(`[ThumbHook] attempt ${attempt + 1}: "${hook}" — ${structure.failures.join("; ")}`);
        continue;
      }
      survivors.push({ hook, redundancy: structure.redundancy });
    }
    if (survivors.length === 0) {
      feedback =
        `\n\nEvery candidate was rejected structurally (word count, long words, or restating the title). ` +
        `Write three NEW lines. Do not restate the title.`;
      continue;
    }

    // Score every survivor — the whole point of candidates is that the scorer
    // picks, not that the first acceptable line wins.
    const scored = [];
    for (const s of survivors) {
      const scores = await scoreHook(s.hook, { title, modelCall });
      console.log(
        `[ThumbHook] attempt ${attempt + 1}: "${s.hook}" — ` +
          `curiosity=${scores.curiosity} legibility=${scores.legibility} emotion=${scores.emotional_trigger}` +
          `${scoresPass(scores) ? " PASS" : " below bar"}`
      );
      const entry = { hook: s.hook, scores, redundancy: s.redundancy };
      scored.push(entry);
      attempts.push(entry);
    }

    const passing = scored.filter((x) => scoresPass(x.scores));
    if (passing.length > 0) {
      const best = passing.reduce((a, b) =>
        minAxis(b.scores) > minAxis(a.scores) || (minAxis(b.scores) === minAxis(a.scores) && sumAxes(b.scores) > sumAxes(a.scores)) ? b : a
      );
      return {
        hook: best.hook,
        scores: best.scores,
        redundancy: best.redundancy,
        candidatesConsidered: attempts.length,
        belowBar: false,
        criticUnavailable: Boolean(best.scores.unscored),
        attemptsUsed: attempt + 1,
      };
    }

    const nearest = scored.reduce((a, b) => (sumAxes(b.scores) > sumAxes(a.scores) ? b : a));
    feedback =
      `\n\nYour best candidate "${nearest.hook}" scored curiosity=${nearest.scores.curiosity}, ` +
      `legibility=${nearest.scores.legibility}, emotional_trigger=${nearest.scores.emotional_trigger} out of 10. All must reach ${PASS_MARK}.\n` +
      (nearest.scores.worst_problem ? `Worst problem: ${nearest.scores.worst_problem}\n` : "") +
      (nearest.scores.fix ? `Fix: ${nearest.scores.fix}\n` : "") +
      `Write three different lines. Do not lightly edit the previous ones.`;
  }

  if (attempts.length === 0) {
    return {
      hook: null,
      scores: null,
      belowBar: true,
      criticUnavailable: false,
      attemptsUsed: maxRetries + 1,
      reason: "no attempt produced a usable line",
    };
  }

  const best = attempts.reduce((a, b) => {
    const [ma, mb] = [minAxis(a.scores), minAxis(b.scores)];
    return mb > ma || (mb === ma && sumAxes(b.scores) > sumAxes(a.scores)) ? b : a;
  });
  console.warn(`[ThumbHook] nothing cleared ${PASS_MARK}/10 — using best-of: "${best.hook}"`);
  return {
    hook: best.hook,
    scores: best.scores,
    redundancy: best.redundancy,
    candidatesConsidered: attempts.length,
    belowBar: true,
    criticUnavailable: Boolean(best.scores.unscored),
    attemptsUsed: attempts.length,
  };
}
