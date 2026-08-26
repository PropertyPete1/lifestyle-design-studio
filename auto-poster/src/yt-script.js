/**
 * yt-script.js — the 10-15 minute script, which IS the product.
 *
 * A carousel can survive a mediocre middle because the reader is already
 * swiping. A twelve-minute video cannot: every section boundary is a place
 * where a viewer decides to leave, and there are a dozen of them. The critic
 * scores seven axes (SCORE_AXES): the original three — clarity, retention,
 * authenticity — plus hook_punch (the first six words alone), story (a human
 * with stakes in every section), loop (planted/sustained/paid), and payoff
 * (every counted claim in the hook cashed out in the body).
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
 * that forces a regeneration outright — the whole close is built on offering
 * that number personally (by text — YouTube has no DMs, see yt-cta.js), and a
 * script that gives it away has nothing left to trade.
 */

import Anthropic from "@anthropic-ai/sdk";
import { stripDashes } from "./sanitize.js";
import { scanAndStripLeaks } from "./caption.js";
import { gatedDevelopmentNames } from "./yt-brief.js";
import { findMonthlyPaymentFigure } from "./caption-validator.js";
import { findImpossibleCta } from "./yt-cta.js";
import { findBannedTellsIn, buildVoiceBlock, buildBannedBlock } from "./yt-voice.js";
import { TAKE_SECONDS_MIN, TAKE_SECONDS_MAX, ON_CAMERA_SHARE, TARGET_MINUTES_MIN, TARGET_MINUTES_MAX, NARRATION_MODE } from "./yt-config.js";

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

/** The last raw model output, kept so a parse failure can show what broke. */
let lastRawOutput = "";

function parseJson(raw) {
  let t = (raw || "").trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1) {
    lastRawOutput = t;
    throw new Error("no JSON object in model output");
  }
  const sliced = t.slice(start, end + 1);
  lastRawOutput = sliced;
  try {
    return JSON.parse(sliced);
  } catch (err) {
    const repaired = repairUnclosedSections(sliced);
    if (repaired !== sliced) {
      try {
        const obj = JSON.parse(repaired);
        console.warn("[YTScript] repaired an unclosed sections array — the model omitted the ]");
        return obj;
      } catch {
        // The repair did not help. Report the ORIGINAL failure, not the
        // repaired one, or the diagnosis chases an artefact of our own edit.
      }
    }
    throw err;
  }
}

/**
 * Close the sections array the writer forgets to close.
 *
 * THE FAILURE, from the raw output of run 31213118691:
 *
 *   ..."boundaryPull":"...your numbers."}  ,"softCta":{"mode":"ON_CAMERA",...
 *
 * The model ends the last section object and goes straight to the next TOP-LEVEL
 * key without closing `sections` with a `]`. The parser is still inside the
 * array, sees an element end, expects `,` or `]`, and finds a string key — which
 * is why every one of these failures carried the same message and landed at
 * 15-18k characters, exactly where the sections array ends.
 *
 * It is worth stating that this was misdiagnosed twice from the error message
 * alone — first as truncation, then as an unescaped quote. Both are plausible
 * readings of "Expected ',' or ']' after array element", and both are wrong. The
 * raw sample settled it in one look.
 *
 * The repair is narrow on purpose. In well-formed output the character before
 * that comma is `]`, so this pattern cannot match valid JSON, and it only ever
 * runs after a parse has already failed.
 */
export function repairUnclosedSections(text) {
  // ONLY the softCta boundary, and ONLY the first occurrence.
  //
  // An earlier version also matched `close`, which is wrong and actively
  // harmful: in a well-formed object softCta's OWN closing brace is followed by
  // `,"close"`, so that pattern corrupts valid JSON rather than repairing it.
  // softCta is the first top-level key after `sections`, and in well-formed
  // output the character before its comma is `]` — so this cannot match
  // anything that already parses.
  return String(text ?? "").replace(/\}(\s*),(\s*)"softCta"\s*:/, '}]$1,$2"softCta":');
}

/** YouTube truncates past this, and the search phrase has to survive inside it. */
export const TITLE_MAX = 70;

/** What makes a title findable. Same test the brief validates candidates with. */
const CITY_PATTERN = /san antonio|austin|texas|sa\b|atx/i;

/**
 * Trim an over-length title instead of throwing the script away.
 *
 * A 71-character title burned two whole generation attempts — the script behind
 * it was fine, and one character sent it back to the model. That is the most
 * expensive possible response to the cheapest possible problem.
 *
 * So it is a repair, not a failure. Trim at a word boundary, never mid-word, and
 * tidy the dangling punctuation that leaves behind.
 *
 * IT REFUSES RATHER THAN MUTILATE. The title IS the product — it is the search
 * query the video ranks for — so if trimming would take the city out of it, the
 * result is unfindable and a silent trim would be worse than a regeneration.
 * In that case this hands back the original and lets validation fail honestly.
 */
export function repairTitle(title, max = TITLE_MAX) {
  const original = String(title ?? "").trim();
  if (!original || original.length <= max) return { title: original, repaired: false };

  const cut = original.slice(0, max + 1);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace < 1) {
    return { title: original, repaired: false, reason: "no word boundary inside the limit" };
  }

  const trimmed = cut.slice(0, lastSpace).replace(/[\s,:;.\-–—(]+$/, "").trim();
  if (!trimmed) {
    return { title: original, repaired: false, reason: "trimming left nothing" };
  }
  // Only guard the city if the original had one to lose.
  if (CITY_PATTERN.test(original) && !CITY_PATTERN.test(trimmed)) {
    return { title: original, repaired: false, reason: "trimming would drop the city, making it unsearchable" };
  }
  return { title: trimmed, repaired: true, from: original.length, to: trimmed.length };
}

/**
 * The text either side of where JSON.parse gave up.
 *
 * A parse error names a position and nothing else, and a position in a 16,000
 * character string is not a diagnosis. Three runs were spent inferring that the
 * cause was an unescaped double quote — the character is unmistakable once you
 * can see it, and invisible until then.
 */
export function sampleAround(raw, message, span = 400) {
  if (typeof raw !== "string" || !raw) return null;
  const m = /position (\d+)/.exec(String(message || ""));
  if (!m) return raw.slice(0, span * 2);
  const pos = Number(m[1]);
  const from = Math.max(0, pos - span);
  const to = Math.min(raw.length, pos + span);
  return `...${raw.slice(from, pos)}>>>HERE<<<${raw.slice(pos, to)}...`;
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

const buildWriterSystem = () => `You write YouTube scripts for Peter, a residential realtor in San Antonio and Austin, Texas. He reads them aloud on camera and in voiceover. He is not a presenter — he is a guy who knows this market talking to someone who is thinking about moving here.

WRITE FOR THE MOUTH, NOT THE PAGE. This is the rule everything else serves.
- Contractions always. "you're", "here's", "that's", "it'd".
- Short sentences. Fragments are fine. One idea per sentence.
- No sentence a person would not say out loud to a friend in a car. If you would only ever WRITE it, cut it.
- Read every line back in your head before you keep it. If it needs a breath in the middle to survive, it is too long.
- Say numbers the way people say them: "four thirty-nine" not "$439,000.00", "about three and a half percent" not "3.5%".

WHO YOU ARE WRITING FOR: someone typing "moving to san antonio", "austin vs san antonio", "new construction under 300k", "cost of living san antonio" into YouTube at 11pm. They are anxious, they are comparing, and they have been sold to all day. They can smell a pitch.

STRUCTURE, and every part of it earns its place:

"hook" — the first 15 seconds, and THE FIRST SIX WORDS ARE THE WHOLE FIGHT. Cold open. No greeting, no name, no "welcome back to the channel", no throat-clearing.

THE SURPRISING CLAIM COMES FIRST; THE QUALIFYING CONTEXT COMES AFTER. Never open by defining who the video is for — "If you're a veteran with a hundred percent rating..." spends twenty seconds qualifying the audience before anything surprising happens, and the people it is for already know who they are from the title.

  WEAK:   "If you're a veteran with a hundred percent rating, Texas can knock your property tax bill down to nothing..."
  STRONG: "Your hundred percent disability exemption doesn't cover this. And most veterans moving to San Antonio don't find out until the first bill shows up."

Structural rule, enforced mechanically: a hook whose first sentence opens with "if", "when", "whether", "for those who", or spends its first clause defining the audience is REJECTED and regenerated. Put the claim in the first six words; qualify it in the second sentence.

CASH OUT EVERY COUNTED CLAIM. If the hook says "two of the three areas", the body must deliver exactly two of exactly three, by name. A number, a named set, or a promise in the hook is a debt, and the critic checks that it is paid in full. Do not put a count in the hook you are not going to land in the body.

THE LONG OPEN LOOP. Inside the first 30 seconds, plant ONE specific promise that is not paid off until the back half of the video — a number you will name, a place you will identify, a mistake you will show. Reference it once mid-video ("that fee I mentioned at the start — it's coming, one more thing first") so it stays alive. Pay it EXPLICITLY, in words that call back to the plant ("that's the line I told you about at the start"). A loop that is planted and never mentioned again is a broken promise, not suspense.

"promise" — one or two sentences. What they will know by the end that they do not know now. Concrete and bounded. "By the end you'll know what a 300k house here actually costs you every month" beats "we'll cover everything you need to know".

STORY BEATS ARE MANDATORY, ONE PER SECTION MINIMUM. Facts do not retain; facts attached to a person do. Every section carries at least one concrete human moment — a client, a buyer, a family — with a DECISION they made and a CONSEQUENCE it had. "A lot of buyers regret this" is not a story; "a family I worked with picked the bigger house on the north side, and eight months in the wife was spending two hours a day on 281 and they listed it" is. Specific beats generic every time: a season, a road, a reason. Never a name, never an address, never an invented number — the person is real-shaped, the details stay general enough to be anyone.

EMOTIONAL STAKES RIDE WITH THE NUMBERS. Every section names at least one emotional cost or relief alongside the financial one — resale regret, kids changing schools mid-year, a commute that grinds someone down, buying fast because orders said so. The channels that win this niche cover what a decision FEELS like a year later, not only what it costs.

"sections" — ONE PER OUTLINE CHAPTER, in the order the outline gives them. If the outline has six chapters, write six sections. Do not add a section the outline does not have, and do not split one chapter across two. Never more than 7 in total.
Each has:
    "title"      — a chapter name, plain and searchable
    "takes"      — the spoken content, split into units of ${TAKE_SECONDS_MIN} to ${TAKE_SECONDS_MAX} seconds
    "boundaryPull" — one sentence at the END of the section giving a concrete reason to stay for the next one. Not "up next we'll talk about schools" — that is a table of contents. Something with a stake in it: "But the number that actually moves your payment isn't the price. It's the one nobody quotes you."

"openingOverlay" — 4 to 8 words, burned on screen over the first seconds while Peter is talking.
The video opens on his face and one claim. This line is the claim in text, and it is doing a different job from the words he is saying: he is talking, and this is what somebody scrolling with the sound off reads before deciding to stay.
- Do NOT restate the hook word for word. If he says "there is no state income tax here, that is the trade", the overlay is not "no state income tax" — it is something like "The trade nobody explains".
- It should complement, sharpen, or add the stake. Think of the two together as one opening.
- No period at the end. No quotes. Plain words, 4 to 8 of them.
- It is read in about one second at the top of a video by somebody who does not know you yet, so it has to earn attention on its own.

CALL TO ACTION MECHANICS — READ THIS BEFORE WRITING softCta OR close.
YOUTUBE HAS NO DIRECT MESSAGES. A creator cannot message a viewer here. Never write "comment X and I'll DM you", "I'll send it over", or anything that implies a private message arriving. It is a promise the platform makes impossible to keep, and the viewer this channel is for has used YouTube for years and will notice.

There are exactly four things that work. Use these and nothing else:
    1. "Comment [KEYWORD] and I'll reply with [the thing]" — the answer appears publicly in the comment thread
    2. "Text me at [the number on screen]" — he reads and answers these himself
    3. "Email me" — same
    4. "Link in the description" — his links page

"softCta" — mid-video, placed after the section where you have most earned it. COMMENT-BASED, because it is the low-friction ask and a comment is worth something to the video itself. One line, no hard sell. Ask for a specific thing that is easy to type — a city, a base, a budget — and say what he will reply with.

"close" — the strong one, and CONTACT-BASED. Someone who watched twelve minutes about where to buy has a real question, and a real question deserves a real channel. Lead with the text number, offer the personalised payment breakdown, and mention the comment as the second, lower-friction option. Ask once, plainly. Never promise a message you cannot send.

TAKES — this is the part people get wrong:
Each take is ${TAKE_SECONDS_MIN}-${TAKE_SECONDS_MAX} seconds of speech, which is roughly 25 to 80 words. Peter reads it off his phone one take at a time, so it must stand alone: no take may begin with a word that only makes sense if the previous take just played ("So...", "And that's why...", "Which brings me to..."). Each take has:
    "id"        — "s2t3" style: section number, take number
    "mode"      — "${ON_CAMERA}" or "${VOICEOVER}"
    "text"      — what he says, verbatim
    "direction" — one short instruction for filming or delivery. Be practical and specific: "walking shot if you can", "energy up, this is the hook", "say this one slower", "look right at the lens for this line". Not "speak clearly".
    "visualIntent" — OPTIONAL, VOICEOVER takes only. See below. Omit it entirely, or set it to null, for any take that does not need one.

VISUAL INTENT — what the viewer looks at while you talk. EVERY VOICEOVER TAKE GETS ONE.
This is a teaching video, not a highlight reel. The B-roll library is drone and walkthrough footage cut for 15-second hype clips, and under a twelve-minute explainer that footage is filler — pretty, and doing no work. So the DEFAULT is a graphic that teaches the sentence, and footage is a deliberate choice you make when the point genuinely is what a place looks and feels like.

THE RULE: ask what the viewer needs to SEE to understand this sentence. If the answer is a relationship, a number, a comparison, a sequence, a geography, or a single figure worth the screen — pick that graphic type. If the answer is honestly "what this place looks like" — pick FOOTAGE and say why.

Do not stretch for a graphic you cannot fill. A card with two vague bullets on it teaches nothing and looks like a slide from a bad deck; FOOTAGE is the better answer there and it is a real answer, not a failure.

Use exactly one of these seven types:

"FOOTAGE" — the point IS the place: what a neighborhood feels like to drive through, lot sizes, grown-in trees. Pick it when a graphic would abstract away the thing the viewer wants to see.
    WRITE IT AS A BARE STRING, not an object: "visualIntent": "FOOTAGE"
    That shorthand exists to keep your JSON simple. Use it every time you choose footage.

"MAP" — any geography: a route, a boundary, a set of locations, an area.
    "spec": {"places": ["Stone Oak", "Downtown"], "lines": ["1604", "281"], "title": "short label for the shot"}
    Give the place and road names as you say them out loud. Only name places and roads in the San Antonio or Austin metro.

"COMPARISON" — two or three things held against each other: neighborhoods, districts, options, before and after.
    "spec": {"columns": [{"name": "Older inside the loop", "points": ["1970s build", "bigger lot"]}, {"name": "Newer outside", "points": ["2000s build", "more square footage"]}], "title": "..."}

"NUMBER_BREAKDOWN" — one figure decomposed into its parts: a tax bill, a payment, closing costs, a budget.
    "spec": {"rows": [{"label": "School district", "value": "1.24%"}, {"label": "County", "value": "0.28%"}], "total": "2.1% all in", "title": "..."}
    Set "struck": true on a row that gets removed or waived, when the point is that it disappears.

"LIST" — enumerated items worth seeing rather than only hearing: documents needed, steps, criteria.
    "spec": {"items": ["Two years of W2s", "Certificate of Eligibility"], "title": "..."}

"TIMELINE" — a sequence or process over time: a closing timeline, a market cycle, a build schedule.
    "spec": {"steps": [{"label": "Offer accepted", "when": "day 0"}, {"label": "Option period ends", "when": "day 7"}], "title": "..."}

"CALLOUT" — a single number or phrase that deserves the whole screen: a rate, a deadline, a threshold.
    "spec": {"value": "41 days", "label": "median time on market", "title": "..."}

VISUAL INTENT RULES:
- EVERY VOICEOVER take gets a visualIntent. A take with none is a take nobody decided about.
- NEVER on an ON_CAMERA take. Those show Peter, and there is nothing to replace.
- Do not put a visualIntent on any take in the first 15 seconds. The video opens on Peter's face and one claim; graphics start after the hook has landed.
- Every number you put in a spec must be one you already say out loud in that take's text. Do not invent a figure for the graphic, and do not put a monthly payment figure in one — that ban covers visuals too.
- Keep labels short. Under about 30 characters each; they are read off a screen in a few seconds, not studied.
- The graphic supports the sentence, it does not repeat it. Do not paste the take's text into the spec.

MODE RULES:
- ON_CAMERA is for the hook, the section transitions, the soft CTA and the close. It is roughly ${Math.round(ON_CAMERA_SHARE * 100)}% of the runtime — that is the budget, keep to it.
- VOICEOVER is everything else, and it plays over B-roll of homes and neighbourhoods. Write VOICEOVER takes so they make sense without seeing Peter, and so they do not describe anything he does not have footage of.

DEFINE EVERY LOCAL NOUN ON FIRST USE.
Your viewer has never been here. That is the entire premise — they are deciding whether to move. So they know ZERO local nouns: not a street, not a highway, not a hospital, not a school district, not an employer, not a landmark. A name they cannot place is a name they have to solve before they can care, and clarity is scored on the LOWEST line in the script.

Every local name gets one clause of definition the first time you say it, in the same breath. Not a glossary, not a digression — a clause:
  "Floyd Curl, the street the hospitals sit on"
  "1604, the outer loop"
  "Comal ISD, the district that reaches down from New Braunfels"
  "Randolph, the Air Force base on the northeast side"
After the first mention you can use the bare name freely; they know it now.

This is the other half of naming real places. An unexplained name is not more specific than a category — it is less useful, because the viewer cannot even tell what kind of thing it is.

NAME THE PLACES THE OUTLINE NAMES.
The outline gives you real neighborhoods, suburbs, highways and school districts. Use them, by name, and attach each specific claim — the commute, the school line, the tax note, the price band — to a NAMED place. A video that promises to compare neighborhoods and then says "the established pockets inside the loop" for eleven minutes has not kept its promise. Do not substitute a category for a name the outline handed you, and do not invent places the outline did not name.

HARD BANS:
- Never state a monthly payment figure. Not "$2,400 a month", not "about twenty-four hundred a month", not any number attached to a monthly payment. The entire close is built on offering that number personally. Talk about payments constantly; never give the figure.
- No builder names. A builder is a company; a neighborhood is a place. Name places, never companies.
- These specific developments are off-limits by name, in every spelling:
${gatedDevelopmentNames().map((n) => `    - ${n}`).join("\n")}
  They are gated by the daily posting pipeline and naming them here would leak what it protects. Every other place on the map is fair game.
- No invented incentives, deadlines, rates, or inventory claims.
- No statistics you cannot source. If you would have to make up a number, make the point without one.

JSON SAFETY — read this twice. Every one of these throws the whole script away.
1. CLOSE THE SECTIONS ARRAY. After the last section's closing brace you must write "]" before "softCta". This is the single most common failure: the last section ends with } and the next character is a comma and then "softCta", with no ] between them. The shape is  ...}]  ,"softCta":  — never  ...}  ,"softCta": .
1b. CLOSE EVERY visualIntent. Each one opens two braces — {"type": ..., "spec": {...}} — and both must close before the take's own closing brace. When you choose footage, write the bare string "FOOTAGE" instead; it opens nothing. A run of three unclosed intents is what turns a finished script into an unparseable one.
2. NEVER put a double quote (") inside any text value. If you need to quote something, use single quotes: 'the north side'. Apostrophes are fine.
3. No newlines inside a value. Keep every value on one line.
Before you answer, check that every [ you opened has a matching ].

Return ONLY valid JSON, no preamble and no code fences:
{"title": "search-query-shaped title, under 70 chars", "hook": "...", "promise": "...", "openingOverlay": "4 to 8 words", "sections": [{"title": "...", "takes": [{"id": "s1t1", "mode": "${ON_CAMERA}", "text": "...", "direction": "..."}, {"id": "s1t2", "mode": "${VOICEOVER}", "text": "...", "direction": "...", "visualIntent": "FOOTAGE"}, {"id": "s1t3", "mode": "${VOICEOVER}", "text": "...", "direction": "...", "visualIntent": {"type": "CALLOUT", "spec": {"value": "...", "label": "..."}}}], "boundaryPull": "..."}], "softCta": {"mode": "${ON_CAMERA}", "text": "...", "direction": "..."}, "close": {"mode": "${ON_CAMERA}", "text": "...", "direction": "..."}}`;

export function writerSystem({ voiceBlock = "", bannedBlock = buildBannedBlock(), presenterBlock = "" } = {}) {
  // presenterBlock LAST so its overrides read as overrides. It is built by
  // presenter-script.js (guestPresenterBlock) and passed in by the caller
  // rather than imported here — presenter-script imports allTakes from this
  // module, and importing back would close an ESM cycle (see yt-cta.js for
  // why cycles are not worth the undefined-at-init risk).
  return buildWriterSystem() + bannedBlock + voiceBlock + presenterBlock;
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

Score seven things from 1 to 10.

"clarity" — comprehension, scored across the WHOLE script. Would a distracted viewer understand what is being CLAIMED, first time, without rewinding?

A good line is a CLEAR, COMPLETE CLAIM with at most one piece withheld. The listener knows exactly what is being asserted and what question they want answered. A bad line is ambiguous about what is even being claimed — the listener has to solve the sentence before they can care about it. On the page a reader can go back a line. A listener cannot. Compression that costs comprehension caps this axis at 4, however elegant it reads.

UNDEFINED LOCAL SHORTHAND IS THE MOST COMMON CLARITY FAILURE HERE, and the easiest to miss, because the writer knows the market and the viewer does not. This audience is defined as people who do not live here yet. A street, highway, hospital, school district, base, employer or landmark used without a clause explaining what it IS is an unsolvable line for them — "close to Floyd Curl" means nothing unless the script says "Floyd Curl, the street the hospitals sit on". Bare local names on first use cap this axis at 6, however natural they sound.

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

"hook_punch" — the FIRST SIX WORDS, scored on their own. Cover the rest of the script and read only them: would a stranger scrolling with the sound half-off stop? Six words that open a gap score high ("Your exemption doesn't cover this line"). Six words of setup score low ("If you're a veteran with a..."), however strong the sentence they begin. A hook that spends its first clause qualifying the audience caps this axis at 4 — the title already did that job.

"story" — is there a HUMAN in every section with something at stake? Count them section by section. A qualifying story beat has a person (a client, a buyer, a family), a decision they made, and a consequence it had — and it is SPECIFIC: a road, a season, a reason. "A lot of buyers regret this" is not a beat; it is a statistic wearing a coat. Any section with zero qualifying beats caps this axis at 5. Also score the emotional register: each section should name what a decision FEELS like — resale regret, kids mid-year, a commute that grinds — not only what it costs. All facts and no people caps this at 4 regardless of how good the facts are.

"loop" — the long open loop, scored in three parts: PLANTED (a specific promise inside the first 30 seconds that is not paid immediately), SUSTAINED (referenced at least once mid-video so it stays alive), PAID (explicitly cashed out in the back half, in words that call back to the plant). All three present and specific: 8+. Planted and paid but never sustained: max 6. Planted and never paid: max 3 — that is a broken promise, and worse than no loop. No loop at all: max 5.

"payoff" — every COUNTED OR NAMED claim in the hook and promise, checked against the body. If the hook says "two of the three areas", find the three areas and the two — by name, exactly. If it promises "the number nobody quotes", find the take that delivers that number. List each claim, then verify each is paid IN FULL. One unpaid or miscounted claim caps this axis at 4, because it is the specific lie a viewer notices and remembers.

Apply the anchors literally. Do not drift the bar upward across the axes: each is scored on its own against the same scale.

Return ONLY valid JSON, no preamble and no code fences:
{"clarity": 0, "retention": 0, "authenticity": 0, "hook_punch": 0, "story": 0, "loop": 0, "payoff": 0, "worst_problem": "the single most damaging flaw, one sentence", "worst_boundary": "quote the weakest boundaryPull, or empty string", "fix": "a specific instruction to the writer, one sentence"}`;

export function criticSystem() {
  return CRITIC_SYSTEM;
}

// ─── flattening and guards ──────────────────────────────────────────────────

/**
 * Every spoken line in a script, flattened — what the guards and critic see.
 *
 * visualIntent CONTENT IS INCLUDED, and it has to be. The guards that run over
 * this are the leak scanner and findMonthlyPaymentFigure, and both exist to
 * stop specific strings reaching the audience: a gated development name, or a
 * monthly payment figure that the entire close is built on withholding. A spec
 * is not spoken, but it IS rendered onto the screen in 84px gold — so a spec
 * excluded from this list is a hole straight through both guards, and the
 * first sign of it would be the number sitting in the finished video.
 */
export function allScriptText(script) {
  const parts = [script?.title, script?.hook, script?.promise];
  for (const s of script?.sections || []) {
    parts.push(s.title, s.boundaryPull);
    for (const t of s.takes || []) parts.push(t.text, t.direction, ...visualIntentText(t.visualIntent));
  }
  parts.push(script?.softCta?.text, script?.softCta?.direction);
  parts.push(script?.close?.text, script?.close?.direction);
  return parts.filter((p) => typeof p === "string" && p.trim());
}

/**
 * Every string anywhere inside a visualIntent, at any depth.
 *
 * Walks rather than reading known keys on purpose: the writer invents spec
 * shapes, and a guard that only looked at `rows[].label` would miss a banned
 * name the model put in `total`, `footnote`, or a key nobody anticipated.
 */
export function visualIntentText(intent, depth = 0) {
  if (depth > 6 || intent == null) return [];
  if (typeof intent === "string") return [intent];
  if (typeof intent === "number") return [String(intent)];
  if (Array.isArray(intent)) return intent.flatMap((v) => visualIntentText(v, depth + 1));
  if (typeof intent === "object") return Object.values(intent).flatMap((v) => visualIntentText(v, depth + 1));
  return [];
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
/**
 * A hook whose first sentence qualifies instead of claiming.
 *
 * "If you're a veteran with a hundred percent rating, Texas can..." spends its
 * first twenty seconds defining the audience — which the title already did —
 * before anything surprising happens. Retention is decided in the first six
 * words, so this is checked mechanically rather than left to the critic: word
 * overlap and phrase shape are things a regex answers every time and a model
 * answers most times.
 *
 * Returns the reason, or null when the hook opens on a claim.
 */
export function hookOpensQualified(hook) {
  const text = String(hook || "").trim();
  if (!text) return null;
  const firstSentence = (text.split(/(?<=[.!?])\s+/)[0] || text).trim();

  if (/^(?:if|when|whether|unless|suppose|imagine)\b/i.test(firstSentence)) {
    return `first sentence opens with a conditional ("${firstSentence.split(/\s+/).slice(0, 4).join(" ")}...") — the claim must come first`;
  }
  if (/^for\s+(?:those|anyone|people|everyone|buyers|families|veterans|folks)\b/i.test(firstSentence)) {
    return "first sentence opens by defining the audience — the claim must come first";
  }
  // "Are you a veteran who..." / "Do you have..." — a question that qualifies.
  if (/^(?:are|do|does|have|has)\s+you\b/i.test(firstSentence) && /\byou(?:'re|r| are| have)?\s+(?:a|an|the)\b/i.test(firstSentence)) {
    return "first sentence is a question qualifying the audience — the claim must come first";
  }
  return null;
}

/**
 * Greetings, channel names and self-introductions — the preamble ban.
 *
 * Checked on the hook AND the first take, because they are what actually
 * plays first. Deterministic: this is a list of phrases, not a judgement.
 */
const PREAMBLE = /^(?:hey|hi|hello|howdy|what's up|welcome(?:\s+back)?|good\s+(?:morning|afternoon|evening)|my name(?:'s|\s+is)|i'm\s+peter|thanks for (?:watching|joining|clicking)|in (?:this|today's)\s+video|today\s+(?:i|we)(?:'m|'re|'ll|\s+am|\s+are|\s+will)?\s)/i;

export function findPreamble(script) {
  const found = [];
  const hook = String(script?.hook || "").trim();
  if (PREAMBLE.test(hook)) found.push(`hook opens with preamble: "${hook.slice(0, 50)}"`);
  const firstTake = script?.sections?.[0]?.takes?.[0];
  const text = String(firstTake?.text || "").trim();
  if (text && PREAMBLE.test(text)) found.push(`first take opens with preamble: "${text.slice(0, 50)}"`);
  return found;
}

export function validateScript(script) {
  const failures = [];
  if (!script || typeof script !== "object") return { valid: false, failures: ["not an object"] };
  if (!nonEmpty(script.title)) failures.push("missing title");
  if (nonEmpty(script.title) && script.title.length > 70) failures.push(`title is ${script.title.length} chars, max 70`);
  if (!nonEmpty(script.hook)) failures.push("missing hook");
  if (!nonEmpty(script.promise)) failures.push("missing promise");

  const qualified = hookOpensQualified(script.hook);
  if (qualified) failures.push(`hook: ${qualified}`);
  failures.push(...findPreamble(script));

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
/**
 * Apply a string transform to every string in a nested structure.
 *
 * Mirrors visualIntentText's walk: the writer invents spec shapes, so scrubbing
 * a fixed set of known keys would leave a banned term sitting in whichever key
 * nobody anticipated. `type` is left alone — it is an enum this code chose, not
 * writer prose, and running it through a leak scanner could only corrupt it.
 */
function scrubDeep(value, scrub, depth = 0) {
  if (depth > 6 || value == null) return value;
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, scrub, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, k === "type" ? v : scrubDeep(v, scrub, depth + 1)])
    );
  }
  return value;
}

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
      takes: (s.takes || []).map((t) => ({
        ...t,
        text: scrub(t.text),
        // The spec is scrubbed too, and not scrubbing it was a real hole: a
        // gated development name that appeared ONLY inside a visualIntent was
        // stripped from nothing, recorded in no leak note, and rendered on
        // screen in 84px gold. Including the spec in allScriptText made it
        // VISIBLE to the guards; this is what makes it actually removed.
        ...(t.visualIntent ? { visualIntent: scrubDeep(t.visualIntent, scrub) } : {}),
      })),
    })),
    softCta: script.softCta ? { ...script.softCta, text: scrub(script.softCta.text) } : script.softCta,
    close: script.close ? { ...script.close, text: scrub(script.close.text) } : script.close,
  };

  const spoken = allScriptText(scrubbed);
  const payment = findMonthlyPaymentFigure(spoken.join("\n"));
  const bannedTells = findBannedTellsIn(spoken);

  // YouTube has no direct messages, so a take promising one is a promise he
  // physically cannot keep on camera. Reported like the payment figure rather
  // than stripped: the sentence is built around the offer, and patching the
  // words out would leave a CTA that asks for nothing.
  const impossibleCta = findImpossibleCta(spoken.join("\n"));

  return {
    script: scrubbed,
    leaksStripped: notes,
    paymentFigure: payment,
    bannedTells,
    impossibleCta,
  };
}

/**
 * Openers that only make sense if the previous take just played.
 *
 * The writer has been told since day one that every take must stand alone —
 * Peter records them one at a time off his phone, in whatever order suits him,
 * and the ingest matches them back by content. A take opening "So..." is a take
 * that was written for a paragraph.
 *
 * It was left to the critic to notice, and the critic named it as the single
 * worst problem on two separate runs, capping authenticity at 6. A rule that
 * can be checked with a regex should never be an opinion: the critic gets three
 * chances to spot it, a validator catches it every time and says exactly which
 * takes to fix.
 *
 * DELIBERATELY CONSERVATIVE. A false positive here costs a whole generation
 * attempt, which is the failure mode this repo just spent a day removing. Bare
 * "That" and "Now" are excluded because they open perfectly good standalone
 * sentences ("That school boundary catches people out"); only the plainly
 * anaphoric forms of "that" are matched.
 *
 * EVERY TAKE, NOT JUST THE ON-CAMERA ONES. This first shipped scoped to the
 * takes Peter records, on the reasoning that the rule exists so he can shoot
 * them in any order. That was wrong, and the next run proved it: the check
 * passed while the critic scored authenticity 4 and named the same fault in
 * VOICEOVER takes — "And if you are reporting to Randolph...", "Then there is
 * Comal ISD". The rule is about the writing, not about who reads it aloud. A
 * take that dangles off its predecessor is weak copy whether Peter records it
 * or ElevenLabs does.
 */
const CONNECTIVE_OPENER_PATTERNS = [
  /^(so|and|but|or|plus|also|then|anyway|besides|however|meanwhile|therefore|nor)\b/i,
  /^which\b/i,
  /^that(?:'s|’s| is| means| said| doesn'?t| does not| brings)\b/i,
];

/** The opening words of a take, stripped of quotes and stage punctuation. */
function openerOf(text) {
  return String(text ?? "").trim().replace(/^["'“”‘’\-—–(\[]+\s*/, "");
}


/**
 * Discourse markers a take can lose without losing meaning.
 *
 * "So the number that matters is the second one" minus "So" is the same
 * sentence, standing alone — which is the entire requirement. The back-
 * reference openers ("Which...", "That's why...") are NOT here: stripping
 * them leaves a sentence pointing at nothing, and those takes genuinely need
 * rewriting.
 */
const STRIPPABLE_OPENER = /^(so|and|but|or|plus|also|then|anyway|besides|however|meanwhile|therefore|nor)[,\s]+/i;

/**
 * Strip repairable connective openers instead of regenerating the script.
 *
 * THE COST THIS REMOVES, measured on run 31283932043: two of three topics
 * produced no script at all, and the killing gate was this one — the budget
 * topic burned attempts on 5, then 1, then 1 connective openers; the schools
 * topic died the same way. Each rejection threw away a ~700-second generation
 * over, in the end, ONE take of thirty that began with "Then". Same class as
 * repairTitle: the most expensive possible response to the cheapest possible
 * problem.
 *
 * The repair is conservative: strip the marker, re-test the opening, and if it
 * STILL reads as connective (e.g. "And that's why..." -> "that's why..."), put
 * the original back and let it regenerate — that take really does lean on its
 * neighbour. A repaired take must also still clear the length floor.
 */
export function repairConnectiveOpeners(script) {
  const repaired = [];
  const fix = (take) => {
    const text = String(take?.text || "");
    if (!STRIPPABLE_OPENER.test(text)) return take;

    const stripped = text.replace(STRIPPABLE_OPENER, "");
    const recapped = stripped.charAt(0).toUpperCase() + stripped.slice(1);

    // Still connective after the strip, or now too short to be a take — the
    // repair did not work; hand it back for regeneration untouched.
    const stillBad = CONNECTIVE_OPENER_PATTERNS.some((re) => re.test(recapped));
    const words = recapped.split(/\s+/).filter(Boolean).length;
    if (stillBad || words < 15) return take;

    repaired.push({ id: take.id || null, from: text.slice(0, 40), to: recapped.slice(0, 40) });
    return { ...take, text: recapped };
  };

  const out = {
    ...script,
    sections: (script.sections || []).map((s) => ({ ...s, takes: (s.takes || []).map(fix) })),
  };
  if (script.softCta) out.softCta = fix(script.softCta);
  if (script.close) out.close = fix(script.close);
  return { script: out, repaired };
}

/** Every take that opens with connective tissue, in any mode. */
export function findConnectiveOpeners(script) {
  const found = [];
  for (const take of allTakes(script)) {
    const opening = openerOf(take.text);
    if (!opening) continue;
    const hit = CONNECTIVE_OPENER_PATTERNS.find((re) => re.test(opening));
    if (hit) {
      found.push({
        id: take.id || null,
        section: take.section || null,
        opener: (opening.match(hit) || [""])[0],
        preview: opening.slice(0, 60),
      });
    }
  }
  return found;
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
        hook_punch: clamp(s.hook_punch),
        story: clamp(s.story),
        loop: clamp(s.loop),
        payoff: clamp(s.payoff),
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

/** The axes a script must clear, all at PASS_MARK or above. */
export const SCORE_AXES = ["clarity", "retention", "authenticity", "hook_punch", "story", "loop", "payoff"];

export function scoresPass(scores, mark = PASS_MARK) {
  return Boolean(scores) && SCORE_AXES.every((axis) => (scores[axis] ?? 0) >= mark);
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
  // Guest framing, from guestPresenterBlock(). Empty for the owner, so every
  // existing call site is byte-identical to before this parameter existed.
  presenterBlock = "",
} = {}) {
  if (!topic || !nonEmpty(topic.title)) throw new Error("generateScript requires a topic with a title");

  const system = writerSystem({ voiceBlock: buildVoiceBlock(voiceSamples), presenterBlock });

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
  // Every attempt that never became a scorable draft, kept so a total failure can
  // be diagnosed from the artifact instead of re-run and hoped to reproduce. The
  // raw sample is what a parse error is actually about — the position alone says
  // nothing about WHAT was malformed.
  const attemptFailures = [];
  let feedback = "";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let script;
    try {
      script = parseJson(await modelCall(system, basePrompt + feedback));
    } catch (err) {
      console.warn(`[YTScript] attempt ${attempt + 1}: unparseable output (${err.message})`);
      console.warn(`[YTScript]   ${describeLastCall()}`);
      attemptFailures.push({
        attempt: attempt + 1,
        kind: "unparseable",
        message: err.message,
        diagnostics: describeLastCall(),
        // The 400 characters either side of where the parser gave up. An
        // unescaped double quote is invisible in an error message and obvious
        // here, which is the whole difference between fixing it and guessing.
        rawAround: sampleAround(lastRawOutput, err.message),
      });
      feedback =
        `\n\nYour previous output could not be parsed as JSON: ${err.message}. ` +
        `Return ONLY the JSON object. Escape every quote and newline inside string values.`;
      continue;
    }

    // Trim an over-length title before validating. This is a repair, not a
    // regeneration: a 71-character title burned two whole attempts on a script
    // that was otherwise fine. repairTitle refuses if trimming would cost the
    // city, in which case validation fails below exactly as it used to.
    const titleFix = repairTitle(script.title);
    if (titleFix.repaired) {
      console.log(`[YTScript] trimmed the title to fit: ${titleFix.from} -> ${titleFix.to} chars`);
      script.title = titleFix.title;
    } else if (titleFix.reason) {
      console.warn(`[YTScript] title is over length and could not be trimmed: ${titleFix.reason}`);
    }

    const structure = validateScript(script);
    if (!structure.valid) {
      console.warn(`[YTScript] attempt ${attempt + 1}: structure failures: ${structure.failures.join("; ")}`);
      attemptFailures.push({
        attempt: attempt + 1,
        kind: "structure",
        failures: structure.failures,
        sectionCount: (script.sections || []).length,
      });
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

    // Standalone takes are a DETERMINISTIC gate, not a critic opinion.
    //
    // The critic named this as the single worst problem on two separate runs and
    // capped authenticity at 6 for it. A rule a regex can check should never
    // depend on the critic noticing: it gets three chances, this catches every
    // one and hands back the exact take ids to fix.
    // Repair before rejecting: a leading "So," costs one word to fix and a
    // whole generation to regenerate. Only what the repair cannot fix — the
    // genuine back-references — still forces the retry.
    const repair = repairConnectiveOpeners(guarded.script);
    if (repair.repaired.length > 0) {
      guarded.script = repair.script;
      console.log(
        `[YTScript] attempt ${attempt + 1}: stripped connective openers from ` +
          `${repair.repaired.map((r) => r.id || "?").join(", ")} — repaired, not regenerated`
      );
    }

    const connective = findConnectiveOpeners(guarded.script);
    if (connective.length > 0) {
      const list = connective.map((c) => `${c.id || "?"} ("${c.opener}...")`).join(", ");
      console.warn(`[YTScript] attempt ${attempt + 1}: takes opening with connective tissue: ${list} — regenerating`);
      attemptFailures.push({
        attempt: attempt + 1,
        kind: "connective-openers",
        takes: connective,
      });
      feedback =
        `\n\nThese takes open with connective tissue that assumes the previous take just played: ` +
        `${list}. Every take is recorded standalone, in any order, so each one must open cold. ` +
        `Rewrite ONLY the first sentence of each of those takes so it stands on its own — ` +
        `name the thing instead of referring back to it. Change nothing else.`;
      continue;
    }

    const scores = await scoreScript(guarded.script, modelCall);
    console.log(
      `[YTScript] attempt ${attempt + 1} scores: clarity=${scores.clarity} retention=${scores.retention} ` +
      `authenticity=${scores.authenticity}${scoresPass(scores) ? " PASS" : " below bar"}`
    );
    // The critic's prose is the only thing that says WHY a score is what it is.
    // It was being fed straight back into the retry prompt and then dropped, so
    // a below-bar run left three numbers and no way to tell a weak writer from
    // weak source material. Logged whenever the critic has something to say.
    if (scores.worst_problem) console.log(`[YTScript]   worst problem:  ${scores.worst_problem}`);
    if (scores.worst_boundary) console.log(`[YTScript]   worst boundary: ${scores.worst_boundary}`);
    if (scores.fix) console.log(`[YTScript]   fix:            ${scores.fix}`);
    attempts.push({ script: guarded.script, scores, leaksStripped: guarded.leaksStripped });

    if (scoresPass(scores)) {
      return finish(attempts[attempts.length - 1], { attemptsUsed: attempt + 1, regenerated: attempt > 0, attemptFailures });
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
        ? `CLARITY IS FAILING. A listener cannot rewind. Make each claim complete and withhold the answer, not the subject. ` +
          `Check every local name first — a street, highway, hospital, district, base or landmark used without a clause ` +
          `saying what it is ("Floyd Curl, the street the hospitals sit on") is unsolvable for someone who does not live here yet.\n`
        : "") +
      `Worst problem: ${scores.worst_problem}\nFix: ${scores.fix}\n` +
      `Rewrite completely. Do not lightly edit the previous version.`;
  }

  if (attempts.length === 0) {
    const err = new Error("Script generation produced no usable draft");
    // Carried on the error so the pipeline can persist it and tell Peter. A
    // total generation failure used to reach him as nothing but a red run.
    err.attemptFailures = attemptFailures;
    throw err;
  }

  const best = attempts.reduce((a, b) => (scoreTotal(b.scores) > scoreTotal(a.scores) ? b : a));
  console.warn(`[YTScript] no draft cleared ${PASS_MARK}/10 — using best-of (total ${scoreTotal(best.scores)})`);
  return finish(best, { attemptsUsed: attempts.length, regenerated: true, belowBar: true, attemptFailures });
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
    attemptFailures: meta.attemptFailures || [],
    criticUnavailable: Boolean(attempt.scores.unscored),
  };
}
