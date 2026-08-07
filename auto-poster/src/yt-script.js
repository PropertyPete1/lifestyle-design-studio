/**
 * yt-script.js — the 10-15 minute script, which IS the product.
 *
 * A carousel can survive a mediocre middle because the reader is already
 * swiping. A twelve-minute video cannot: every section boundary is a place
 * where a viewer decides to leave, and there are a dozen of them. So the critic
 * scores three axes here rather than the carousel's four, and the extra one is
 * retention — measured at the boundaries, which is where it is actually lost.
 *
 * Structure the writer produces:
 *
 *   hook       first 15 seconds, cold open. No intro, no name, no channel.
 *   promise    what the viewer gets by staying, said once and concretely.
 *   sections[] chaptered delivery, each with takes and a boundary pull.
 *   softCta    mid-video, low friction.
 *   close      phone number + the payment-breakdown offer.
 *
 * Each section carries TAKES: 10-30 second units labelled ON_CAMERA or
 * VOICEOVER. The take is the atom of this whole system — it is what Peter reads
 * off his phone, what the ingest matches his recordings against, and what the
 * assembler lays on the timeline. Anything longer than 30 seconds has to be
 * memorised, and anything that has to be memorised gets ad-libbed into
 * something that no longer matches the script.
 *
 * Guards are the existing ones, reused verbatim: the leak scanner and
 * findMonthlyPaymentFigure. A stated monthly payment figure is the one thing
 * that forces a regeneration outright — the whole CTA is built on offering that
 * number in a DM, and a script that gives it away has nothing left to trade.
 */

import Anthropic from "@anthropic-ai/sdk";
import { stripDashes } from "./sanitize.js";
import { scanAndStripLeaks } from "./caption.js";
import { findMonthlyPaymentFigure } from "./caption-validator.js";
import { findBannedTellsIn, buildVoiceBlock, buildBannedBlock } from "./yt-voice.js";
import { TAKE_SECONDS_MIN, TAKE_SECONDS_MAX, ON_CAMERA_SHARE, TARGET_MINUTES_MIN, TARGET_MINUTES_MAX } from "./yt-config.js";

const MODEL = "claude-opus-5";

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

export const ON_CAMERA = "ON_CAMERA";
export const VOICEOVER = "VOICEOVER";

export const PASS_MARK = 8;
const MAX_RETRIES = 2;

// ─── model plumbing (mirrors carousel-content.js so both behave the same) ────

function parseJson(raw) {
  let t = (raw || "").trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object in model output");
  return JSON.parse(t.slice(start, end + 1));
}

/**
 * A 10-15 minute script is a lot of JSON — the first live run produced 38 takes.
 * 8000 was not obviously enough, and running out mid-array produces exactly the
 * "unparseable output" symptom that sent the first diagnosis in the wrong
 * direction.
 */
/**
 * Output budget for a model call.
 *
 * THINKING BLOCKS COME OUT OF THIS BUDGET. That is the whole reason this
 * constant exists and is set so far above the size of the answer.
 *
 * The long-form critic was called with max_tokens: 1500 — generous for a JSON
 * object of six short fields. The live run returned:
 *
 *   stop_reason=max_tokens blocks=[thinking] text=0 chars output_tokens=1500/1500
 *   stop_reason=max_tokens blocks=[thinking,text] text=439 chars output_tokens=1500/1500
 *
 * The model spent the entire budget reasoning and had nothing left to answer
 * with. The caller saw an empty or truncated string and reported "no JSON
 * object in model output", which reads like the model misbehaved and sent the
 * first diagnosis chasing the writer instead of the critic.
 *
 * So budgets are sized for THINKING PLUS THE ANSWER, not for the answer. This
 * is an upper bound rather than a target, so raising it costs nothing when the
 * model is brief.
 */
const MODEL_BUDGET = 8000;

const WRITER_MAX_TOKENS = 20000;

/**
 * The model call, with the diagnosis attached.
 *
 * The first live run failed three times with "unparseable output" and "no JSON
 * object in model output". Those messages describe the SYMPTOM and hide the
 * cause: they read like the model misbehaved, when the real candidates are a
 * truncated response (stop_reason: max_tokens), a response with no text block
 * at all, or genuinely malformed JSON. Those need different fixes, and the log
 * could not tell them apart.
 *
 * So the stop reason and the shape of the response travel with the text, and
 * the parse failure reports them.
 */
export async function callModel(system, userPrompt, maxTokens = WRITER_MAX_TOKENS) {
  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: userPrompt }],
  });
  const textBlock = (res.content || []).find((b) => b?.type === "text" && typeof b.text === "string");
  const text = textBlock ? textBlock.text : "";
  lastCallDiagnostics = {
    stopReason: res.stop_reason || "unknown",
    blockTypes: (res.content || []).map((b) => b?.type).join(","),
    textLength: text.length,
    outputTokens: res.usage?.output_tokens ?? null,
    maxTokens,
  };
  if (res.stop_reason === "max_tokens") {
    console.warn(`[YTScript] response hit max_tokens (${maxTokens}) — it is truncated, not malformed`);
  }
  return text;
}

/** Populated by callModel, read by the parse-failure logging. */
let lastCallDiagnostics = null;

export function describeLastCall() {
  if (!lastCallDiagnostics) return "no model call recorded";
  const d = lastCallDiagnostics;
  return `stop_reason=${d.stopReason} blocks=[${d.blockTypes}] text=${d.textLength} chars ` +
    `output_tokens=${d.outputTokens}/${d.maxTokens}`;
}

// ─── the writer ─────────────────────────────────────────────────────────────

const WRITER_SYSTEM = `You write YouTube scripts for Peter, a residential realtor in San Antonio and Austin, Texas. He reads them aloud on camera and in voiceover. He is not a presenter — he is a guy who knows this market talking to someone who is thinking about moving here.

WRITE FOR THE MOUTH, NOT THE PAGE. This is the rule everything else serves.
- Contractions always. "you're", "here's", "that's", "it'd".
- Short sentences. Fragments are fine. One idea per sentence.
- No sentence a person would not say out loud to a friend in a car. If you would only ever WRITE it, cut it.
- Read every line back in your head before you keep it. If it needs a breath in the middle to survive, it is too long.
- Say numbers the way people say them: "four thirty-nine" not "$439,000.00", "about three and a half percent" not "3.5%".

WHO YOU ARE WRITING FOR: someone typing "moving to san antonio", "austin vs san antonio", "new construction under 300k", "cost of living san antonio" into YouTube at 11pm. They are anxious, they are comparing, and they have been sold to all day. They can smell a pitch.

STRUCTURE, and every part of it earns its place:

"hook" — the first 15 seconds. Cold open on the single most useful or most contrarian thing you have. No greeting, no name, no "welcome back to the channel", no throat-clearing. Start on the claim. The viewer decided to click on a title; the hook has to prove instantly that they were right to.

"promise" — one or two sentences. What they will know by the end that they do not know now. Concrete and bounded. "By the end you'll know what a 300k house here actually costs you every month" beats "we'll cover everything you need to know".

"sections" — 4 to 7 of them, in the order a person actually asks these questions. Each has:
    "title"      — a chapter name, plain and searchable
    "takes"      — the spoken content, split into units of ${TAKE_SECONDS_MIN} to ${TAKE_SECONDS_MAX} seconds
    "boundaryPull" — one sentence at the END of the section giving a concrete reason to stay for the next one. Not "up next we'll talk about schools" — that is a table of contents. Something with a stake in it: "But the number that actually moves your payment isn't the price. It's the one nobody quotes you."

"softCta" — mid-video, placed after the section where you have most earned it. Low friction. One line, no hard sell.

"close" — the strong one. Phone number, and the offer of a personalised payment breakdown. Ask for the comment or the text, once, plainly.

TAKES — this is the part people get wrong:
Each take is ${TAKE_SECONDS_MIN}-${TAKE_SECONDS_MAX} seconds of speech, which is roughly 25 to 80 words. Peter reads it off his phone one take at a time, so it must stand alone: no take may begin with a word that only makes sense if the previous take just played ("So...", "And that's why...", "Which brings me to..."). Each take has:
    "id"        — "s2t3" style: section number, take number
    "mode"      — "${ON_CAMERA}" or "${VOICEOVER}"
    "text"      — what he says, verbatim
    "direction" — one short instruction for filming or delivery. Be practical and specific: "walking shot if you can", "energy up, this is the hook", "say this one slower", "look right at the lens for this line". Not "speak clearly".

MODE RULES:
- ON_CAMERA is for the hook, the section transitions, the soft CTA and the close. It is roughly ${Math.round(ON_CAMERA_SHARE * 100)}% of the runtime — that is the budget, keep to it.
- VOICEOVER is everything else, and it plays over B-roll of homes and neighbourhoods. Write VOICEOVER takes so they make sense without seeing Peter, and so they do not describe anything he does not have footage of.

HARD BANS:
- Never state a monthly payment figure. Not "$2,400 a month", not "about twenty-four hundred a month", not any number attached to a monthly payment. The entire close is built on offering that number personally. Talk about payments constantly; never give the figure.
- No builder names, no community names, no development names.
- No invented incentives, deadlines, rates, or inventory claims.
- No statistics you cannot source. If you would have to make up a number, make the point without one.

Return ONLY valid JSON, no preamble and no code fences:
{"title": "search-query-shaped title, under 70 chars", "hook": "...", "promise": "...", "sections": [{"title": "...", "takes": [{"id": "s1t1", "mode": "${ON_CAMERA}", "text": "...", "direction": "..."}], "boundaryPull": "..."}], "softCta": {"mode": "${ON_CAMERA}", "text": "...", "direction": "..."}, "close": {"mode": "${ON_CAMERA}", "text": "...", "direction": "..."}}`;

export function writerSystem({ voiceBlock = "", bannedBlock = buildBannedBlock() } = {}) {
  return WRITER_SYSTEM + bannedBlock + voiceBlock;
}

// ─── the critic ─────────────────────────────────────────────────────────────

const CRITIC_SYSTEM = `You are a harsh critic of YouTube scripts. You are not here to be encouraging, and you never inflate a score to be kind.

Use this scale. It is calibrated, not relative — score against these anchors, not against how good you imagine a script could theoretically be:

  10   Exceptional. You would study it. Rare.
  9    Excellent. A clear cut above.
  8    Strong. Genuinely good and ready to record as-is. This is the bar a competent professional hits on a good day. It is NOT reserved for the exceptional.
  6-7  Workable but carrying a specific, nameable flaw.
  4-5  Weak. The mechanic is present but not doing its job.
  1-3  Broken or absent.

An 8 is a pass, not a prize. If you cannot name a concrete flaw, do not score below 8.

Score three things from 1 to 10.

"clarity" — comprehension, scored across the WHOLE script. Would a distracted viewer understand what is being CLAIMED, first time, without rewinding?

A good line is a CLEAR, COMPLETE CLAIM with at most one piece withheld. The listener knows exactly what is being asserted and what question they want answered. A bad line is ambiguous about what is even being claimed — the listener has to solve the sentence before they can care about it. On the page a reader can go back a line. A listener cannot. Compression that costs comprehension caps this axis at 4, however elegant it reads.

Score the LOWEST-clarity take in the script, not the average.

"retention" — the axis this format lives or dies on. AT EACH SECTION BOUNDARY, does a relocating buyer have a CONCRETE reason to keep watching?

Go boundary by boundary. At the end of each section, ask: what specifically does this viewer still want, and has the script just told them they are about to get it?

A boundaryPull that names what is coming is a TABLE OF CONTENTS, not a reason. Score those 3 or below:
  "Next up, let's talk about property taxes."
  "Now that we've covered neighbourhoods, let's look at schools."
Nothing is at stake. The viewer already knew the video had more sections.

A boundaryPull that opens a specific gap the viewer now has a personal stake in scores 8 or above:
  "That's the price. But the number that decides whether you can actually afford it is the one no listing shows you, and in this county it's brutal."
The viewer has a live question, about their own money, that they cannot answer without staying.

ONE weak boundary caps this axis at 5. A twelve-minute video has a dozen exits and it only takes one to lose them. Also penalise: a hook that does not land inside 15 seconds, a promise so vague the viewer cannot tell whether it has been kept, and any section that delivers its payoff in the first sentence and then keeps talking.

"authenticity" — does this sound like a real person talking, or like an AI wrote it?

Read every line as if hearing it out loud. The test for any sentence: WOULD A REAL PERSON SAY THIS TO A FRIEND IN A CAR? If it would only ever be written, it fails.

Score 3 or below for any of these, and name the offender:
  - three adjectives in a row ("spacious, modern, and inviting")
  - a paragraph that restates what the previous paragraph just said
  - summary sentences that add nothing: "So as you can see, there's a lot to consider."
  - symmetrical constructions no one speaks in: "It's not just about X, it's about Y."
  - listing-copy vocabulary: nestled, boasts, stunning, charming, oasis, hidden gem
  - hedge stacks: "generally speaking, it can often be the case that..."
  - sentences that need a breath in the middle to get through
  - any take that opens with connective tissue from a take before it ("So...", "And that's why...") — each take is recorded standalone and must stand alone

Score 8 or above only if you could believe a realtor said all of it into his phone without a script in front of him. Contractions, short sentences, and the occasional fragment are GOOD here — do not mark them down as informal. Formality is the failure mode on this axis, not the standard.

Apply the anchors literally. Do not drift the bar upward across the three axes: each is scored on its own against the same scale.

Return ONLY valid JSON, no preamble and no code fences:
{"clarity": 0, "retention": 0, "authenticity": 0, "worst_problem": "the single most damaging flaw, one sentence", "worst_boundary": "quote the weakest boundaryPull, or empty string", "fix": "a specific instruction to the writer, one sentence"}`;

export function criticSystem() {
  return CRITIC_SYSTEM;
}

// ─── flattening and guards ──────────────────────────────────────────────────

/** Every spoken line in a script, flattened — what the guards and critic see. */
export function allScriptText(script) {
  const parts = [script?.title, script?.hook, script?.promise];
  for (const s of script?.sections || []) {
    parts.push(s.title, s.boundaryPull);
    for (const t of s.takes || []) parts.push(t.text, t.direction);
  }
  parts.push(script?.softCta?.text, script?.softCta?.direction);
  parts.push(script?.close?.text, script?.close?.direction);
  return parts.filter((p) => typeof p === "string" && p.trim());
}

/** Just the spoken takes, in order. Used by the recording kit and the assembler. */
export function allTakes(script) {
  const takes = [];
  (script?.sections || []).forEach((s, si) => {
    (s.takes || []).forEach((t, ti) => {
      takes.push({ ...t, id: t.id || `s${si + 1}t${ti + 1}`, section: s.title, sectionIndex: si });
    });
  });
  if (script?.softCta?.text) takes.push({ ...script.softCta, id: script.softCta.id || "cta", section: "Soft CTA", sectionIndex: 998 });
  if (script?.close?.text) takes.push({ ...script.close, id: script.close.id || "close", section: "Close", sectionIndex: 999 });
  return takes;
}

/**
 * Structural validation. Cheap, deterministic, and runs before the critic so a
 * malformed draft costs one model call instead of two.
 */
export function validateScript(script) {
  const failures = [];
  if (!script || typeof script !== "object") return { valid: false, failures: ["not an object"] };
  if (!nonEmpty(script.title)) failures.push("missing title");
  if (nonEmpty(script.title) && script.title.length > 70) failures.push(`title is ${script.title.length} chars, max 70`);
  if (!nonEmpty(script.hook)) failures.push("missing hook");
  if (!nonEmpty(script.promise)) failures.push("missing promise");

  const sections = script.sections || [];
  if (sections.length < 4) failures.push(`only ${sections.length} sections, need at least 4`);
  if (sections.length > 7) failures.push(`${sections.length} sections, max 7`);

  sections.forEach((s, i) => {
    if (!nonEmpty(s.title)) failures.push(`section ${i + 1}: missing title`);
    if (!nonEmpty(s.boundaryPull)) failures.push(`section ${i + 1}: missing boundaryPull`);
    const takes = s.takes || [];
    if (takes.length === 0) failures.push(`section ${i + 1}: no takes`);
    takes.forEach((t, ti) => {
      const where = `section ${i + 1} take ${ti + 1}`;
      if (!nonEmpty(t.text)) failures.push(`${where}: empty text`);
      if (t.mode !== ON_CAMERA && t.mode !== VOICEOVER) failures.push(`${where}: mode is "${t.mode}", must be ${ON_CAMERA} or ${VOICEOVER}`);
      if (!nonEmpty(t.direction)) failures.push(`${where}: missing direction`);
      const words = String(t.text || "").split(/\s+/).filter(Boolean).length;
      // ~2.5 words/sec read aloud. A take outside the window is one Peter has to
      // memorise, or one so short it wastes a recording slot.
      if (words > 0 && words < 15) failures.push(`${where}: ${words} words is too short to be a take`);
      if (words > 100) failures.push(`${where}: ${words} words is over ${TAKE_SECONDS_MAX}s, split it`);
    });
  });

  if (!nonEmpty(script.close?.text)) failures.push("missing close");
  return { valid: failures.length === 0, failures };
}

function nonEmpty(s) {
  return typeof s === "string" && s.trim().length > 0;
}

/**
 * The shared safety gates, applied to every spoken line.
 *
 * Same two guards the captions and carousels use, unchanged. Leaks are stripped
 * in place; a payment figure is reported for the caller to regenerate on,
 * because there is no safe way to patch one out of a sentence built around it.
 */
export function applyGuards(script) {
  const notes = [];
  const scrub = (text) => {
    if (!nonEmpty(text)) return text;
    const { caption, leaksFound, leakDetails } = scanAndStripLeaks(stripDashes(text), null);
    if (leaksFound > 0) notes.push(...leakDetails.map((l) => `stripped "${l.term}" (${l.type})`));
    return caption;
  };

  const scrubbed = {
    ...script,
    hook: scrub(script.hook),
    promise: scrub(script.promise),
    sections: (script.sections || []).map((s) => ({
      ...s,
      boundaryPull: scrub(s.boundaryPull),
      takes: (s.takes || []).map((t) => ({ ...t, text: scrub(t.text) })),
    })),
    softCta: script.softCta ? { ...script.softCta, text: scrub(script.softCta.text) } : script.softCta,
    close: script.close ? { ...script.close, text: scrub(script.close.text) } : script.close,
  };

  const spoken = allScriptText(scrubbed);
  const payment = findMonthlyPaymentFigure(spoken.join("\n"));
  const bannedTells = findBannedTellsIn(spoken);

  return {
    script: scrubbed,
    leaksStripped: notes,
    paymentFigure: payment,
    bannedTells,
  };
}

// ─── scoring ────────────────────────────────────────────────────────────────

export async function scoreScript(script, modelCall = callModel) {
  const rendered = JSON.stringify(
    {
      title: script.title,
      hook: script.hook,
      promise: script.promise,
      sections: (script.sections || []).map((s) => ({
        title: s.title,
        takes: (s.takes || []).map((t) => `[${t.mode}] ${t.text}`),
        boundaryPull: s.boundaryPull,
      })),
      softCta: script.softCta?.text,
      close: script.close?.text,
    },
    null,
    2
  );
  const clamp = (n) => Math.max(1, Math.min(10, Number(n) || 1));

  // Same discipline as the carousel critic: a critic outage degrades to
  // "unscored" rather than throwing. The hard gates below block regardless.
  for (let attempt = 0; attempt < 2; attempt++) {
    const nudge = attempt === 0 ? "" : "\n\nReturn ONLY the JSON object. No prose.";
    try {
      const raw = await modelCall(criticSystem(), `Score this script.\n\n${rendered}${nudge}`, MODEL_BUDGET);
      const s = parseJson(raw);
      return {
        clarity: clamp(s.clarity),
        retention: clamp(s.retention),
        authenticity: clamp(s.authenticity),
        worst_problem: String(s.worst_problem || ""),
        worst_boundary: String(s.worst_boundary || ""),
        fix: String(s.fix || ""),
      };
    } catch (err) {
      console.warn(`[YTScript] critic attempt ${attempt + 1} unparseable: ${err.message}`);
      console.warn(`[YTScript]   ${describeLastCall()}`);
    }
  }

  console.warn("[YTScript] critic unavailable — script will be treated as unscored");
  return {
    clarity: 0, retention: 0, authenticity: 0,
    worst_problem: "critic unavailable", worst_boundary: "", fix: "", unscored: true,
  };
}

export function scoresPass(scores, mark = PASS_MARK) {
  return scores.clarity >= mark && scores.retention >= mark && scores.authenticity >= mark;
}

const scoreTotal = (s) => s.clarity + s.retention + s.authenticity;

// ─── generation ─────────────────────────────────────────────────────────────

/**
 * Write one script, regenerating until all three axes clear the bar.
 *
 * @param {object} opts
 * @param {object} opts.topic        { title, hook, outline } from the approved brief
 * @param {string} opts.notes        Peter's revision notes, applied as guidance
 * @param {string[]} opts.voiceSamples transcripts of Peter's own narration
 * @param {Function} opts.modelCall  injectable, so the gate is testable offline
 */
export async function generateScript({
  topic,
  notes = null,
  voiceSamples = [],
  maxRetries = MAX_RETRIES,
  modelCall = callModel,
} = {}) {
  if (!topic || !nonEmpty(topic.title)) throw new Error("generateScript requires a topic with a title");

  const system = writerSystem({ voiceBlock: buildVoiceBlock(voiceSamples) });

  const basePrompt =
    `Write the script.\n\n` +
    `WORKING TITLE: ${topic.title}\n` +
    (topic.hook ? `THE ANGLE: ${topic.hook}\n` : "") +
    (topic.outline ? `OUTLINE TO FOLLOW:\n${topic.outline}\n` : "") +
    `TARGET RUNTIME: ${TARGET_MINUTES_MIN} to ${TARGET_MINUTES_MAX} minutes of speech.\n` +
    (notes
      ? `\nPETER REVIEWED THE LAST VERSION AND ASKED FOR THIS. It overrides anything above that conflicts with it:\n${notes}\n`
      : "") +
    `\nReturn the JSON object described in your instructions.`;

  const attempts = [];
  let feedback = "";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let script;
    try {
      script = parseJson(await modelCall(system, basePrompt + feedback));
    } catch (err) {
      console.warn(`[YTScript] attempt ${attempt + 1}: unparseable output (${err.message})`);
      console.warn(`[YTScript]   ${describeLastCall()}`);
      feedback =
        `\n\nYour previous output could not be parsed as JSON: ${err.message}. ` +
        `Return ONLY the JSON object. Escape every quote and newline inside string values.`;
      continue;
    }

    const structure = validateScript(script);
    if (!structure.valid) {
      console.warn(`[YTScript] attempt ${attempt + 1}: structure failures: ${structure.failures.join("; ")}`);
      feedback = `\n\nYour previous attempt was structurally invalid: ${structure.failures.join("; ")}. Fix these exactly.`;
      continue;
    }

    const guarded = applyGuards(script);

    if (guarded.paymentFigure.found) {
      console.warn(`[YTScript] attempt ${attempt + 1}: payment figure ("${guarded.paymentFigure.match}") — regenerating`);
      feedback =
        `\n\nYour previous attempt stated a monthly payment figure ("${guarded.paymentFigure.match}"). ` +
        `Never say a monthly payment number out loud. The close offers that number personally — giving it away leaves nothing to trade.`;
      continue;
    }

    // Banned tells are a deterministic gate, not a critic opinion. A model
    // asked whether it sounds like a model will miss its own idioms.
    if (guarded.bannedTells.length > 0) {
      const list = guarded.bannedTells.map((t) => `"${t.match}"`).join(", ");
      console.warn(`[YTScript] attempt ${attempt + 1}: banned AI tells: ${list} — regenerating`);
      feedback =
        `\n\nYour previous attempt used banned phrasing: ${list}. ` +
        `These mark copy as machine-written. Rewrite the lines containing them from scratch — do not swap in a synonym.`;
      continue;
    }

    const scores = await scoreScript(guarded.script, modelCall);
    console.log(
      `[YTScript] attempt ${attempt + 1} scores: clarity=${scores.clarity} retention=${scores.retention} ` +
      `authenticity=${scores.authenticity}${scoresPass(scores) ? " PASS" : " below bar"}`
    );
    attempts.push({ script: guarded.script, scores, leaksStripped: guarded.leaksStripped });

    if (scoresPass(scores)) {
      return finish(attempts[attempts.length - 1], { attemptsUsed: attempt + 1, regenerated: attempt > 0 });
    }

    feedback =
      `\n\nYour previous attempt scored clarity=${scores.clarity}, retention=${scores.retention}, ` +
      `authenticity=${scores.authenticity} out of 10. Everything must reach ${PASS_MARK}.\n` +
      (scores.retention < PASS_MARK
        ? `RETENTION IS FAILING. Section boundaries are where this video loses people. ` +
          `Every boundaryPull must open a specific gap the viewer has a personal stake in — not announce what is coming next. ` +
          (scores.worst_boundary ? `The weakest one was: "${scores.worst_boundary}".\n` : "\n")
        : "") +
      (scores.authenticity < PASS_MARK
        ? `AUTHENTICITY IS FAILING. Read every line aloud. If a real person would not say it to a friend in a car, rewrite it. ` +
          `Shorter sentences, contractions, fragments where they help.\n`
        : "") +
      (scores.clarity < PASS_MARK
        ? `CLARITY IS FAILING. A listener cannot rewind. Make each claim complete and withhold the answer, not the subject.\n`
        : "") +
      `Worst problem: ${scores.worst_problem}\nFix: ${scores.fix}\n` +
      `Rewrite completely. Do not lightly edit the previous version.`;
  }

  if (attempts.length === 0) throw new Error("Script generation produced no usable draft");

  const best = attempts.reduce((a, b) => (scoreTotal(b.scores) > scoreTotal(a.scores) ? b : a));
  console.warn(`[YTScript] no draft cleared ${PASS_MARK}/10 — using best-of (total ${scoreTotal(best.scores)})`);
  return finish(best, { attemptsUsed: attempts.length, regenerated: true, belowBar: true });
}

function finish(attempt, meta) {
  const takes = allTakes(attempt.script);
  const onCamera = takes.filter((t) => t.mode === ON_CAMERA);
  const words = takes.reduce((n, t) => n + String(t.text || "").split(/\s+/).filter(Boolean).length, 0);
  return {
    title: attempt.script.title,
    script: attempt.script,
    scores: attempt.scores,
    leaksStripped: attempt.leaksStripped,
    takeCount: takes.length,
    onCameraCount: onCamera.length,
    // ~2.5 words per second read aloud — the same rate the take-length bounds use.
    estimatedMinutes: Math.round((words / 2.5 / 60) * 10) / 10,
    attemptsUsed: meta.attemptsUsed,
    regenerated: Boolean(meta.regenerated),
    belowBar: Boolean(meta.belowBar),
    criticUnavailable: Boolean(attempt.scores.unscored),
  };
}
