/**
 * presenter-script.js — making a script safe for a presenter who is not Peter.
 *
 * The writer's persona is Peter: a realtor with his own clients, his own
 * stories, his own phone number. Put those words in a guest's mouth and the
 * video has the guest claiming Peter's identity and experiences on camera —
 * which is not a style problem, it is a false statement to the audience with a
 * real person's name on it.
 *
 * TWO DEFENCES, BECAUSE PROMPTS ARE NOT GUARANTEES:
 *
 * 1. Generation: guestPresenterBlock() rides the writer system prompt so a
 *    guest script is written in team framing from the start.
 * 2. The sweep: findOwnerClaims / adaptScriptForPresenter run over the finished
 *    script — whether freshly generated or recovered from actedResult on a
 *    reassignment — neutralize what they can ("a family I worked with" -> "a
 *    family we worked with"), and report as UNRESOLVED what no mechanical edit
 *    can fix ("I'm Peter"). An unresolved claim blocks the kit; it is never
 *    shipped and never silently dropped.
 *
 * After any neutralization the FULL critic re-runs (vetAdaptedScript): the
 * edits are word-level, but "sounds like a person" is a property of the whole
 * take and only the critic scores that.
 *
 * WHAT IS DELIBERATELY NOT SWEPT: plain first person. "I want you to see this
 * road" and "I'm going to show you the number" are the presenter presenting —
 * a guest says those honestly. Only OWNERSHIP claims (clients, deals, years,
 * the personal contact channel) and IDENTITY claims are Peter's.
 */

import { allTakes } from "./yt-script.js";

/** The owner's name as scripts would speak it. */
const OWNER_FIRST_NAME = "Peter";

/**
 * The team CTA contact line for guest framing. Read from the same env the
 * packaging uses (YT_CONTACT_EMAIL, defaulted identically) — imported from
 * neither module, because packaging -> timeline -> script already forms a
 * cycle this file must not enter.
 */
export function teamContactEmail() {
  return (process.env.YT_CONTACT_EMAIL || "peter@lifestyledesignrealty.com").trim();
}

// ─── the claim patterns ─────────────────────────────────────────────────────

/**
 * IDENTITY claims — no mechanical rewrite makes these true in a guest's
 * mouth, so finding one after neutralization blocks the kit outright.
 */
const IDENTITY_CLAIMS = [
  new RegExp(`\\bI(?:'|’)?m ${OWNER_FIRST_NAME}\\b`, "i"),
  new RegExp(`\\bI am ${OWNER_FIRST_NAME}\\b`, "i"),
  new RegExp(`\\bmy name(?:'|’)?s ${OWNER_FIRST_NAME}\\b`, "i"),
  new RegExp(`\\bmy name is ${OWNER_FIRST_NAME}\\b`, "i"),
  new RegExp(`\\bthis is ${OWNER_FIRST_NAME}\\b`, "i"),
];

/**
 * OWNERSHIP claims — first-person singular over experiences, clients and the
 * contact channel. Each pairs with a team-framed replacement below; the
 * replacement keeps the sentence's shape so the critic re-run judges prose,
 * not grammar wreckage.
 *
 * Order matters: contracted and multi-word forms before their prefixes.
 */
const OWNERSHIP_REWRITES = [
  // experience: "a family I worked with", "buyers I've helped"
  [/\bI(?:'|’)?ve worked with\b/gi, "we've worked with"],
  [/\bI have worked with\b/gi, "we have worked with"],
  [/\bI worked with\b/gi, "we worked with"],
  [/\bI(?:'|’)?ve (helped|sold|closed|listed|toured|seen)\b/gi, "we've $1"],
  [/\bI have (helped|sold|closed|listed|toured|seen)\b/gi, "we have $1"],
  [/\bI (helped|sold|closed|listed|toured)\b/gi, "we $1"],
  [/\bI(?:'|’)?ve been (selling|doing|working|helping)\b/gi, "we've been $1"],
  // ownership: "my clients", "my listings", "my team"
  [/\bmy (clients?|buyers?|sellers?|listings?|team)\b/gi, "our $1"],
  // the contact channel is Peter's — guests offer it as the team's
  [/\btext me\b/gi, "text us"],
  [/\bemail me\b/gi, "email us"],
  [/\bcall me\b/gi, "call us"],
  [/\bmy (number|phone|email|inbox)\b/gi, "our $1"],
  [/\bI(?:'|’)?ll (reply|answer|respond|send|text|run|get back)\b/gi, "we'll $1"],
  [/\bI will (reply|answer|respond|send|text|run|get back)\b/gi, "we will $1"],
  [/\bI read (every|all|each)\b/gi, "we read $1"],
];

/** The patterns alone, for detection without rewriting. */
const OWNERSHIP_CLAIMS = OWNERSHIP_REWRITES.map(([re]) => re);

/**
 * Every owner claim in one string. Identity claims are marked resolvable:false
 * — those need a human or a regeneration, not a find-and-replace.
 */
export function findOwnerClaims(text) {
  const s = String(text || "");
  const found = [];
  for (const re of IDENTITY_CLAIMS) {
    const m = re.exec(s);
    if (m) found.push({ match: m[0], resolvable: false });
  }
  for (const re of OWNERSHIP_CLAIMS) {
    // The rewrite regexes are /g/ and stateful; probe with a fresh copy.
    const probe = new RegExp(re.source, re.flags.replace("g", ""));
    const m = probe.exec(s);
    if (m) found.push({ match: m[0], resolvable: true });
  }
  return found;
}

/**
 * Rewrite one string into team framing, preserving sentence-initial capitals:
 * "I've worked with..." at the top of a take becomes "We've worked with...",
 * not "we've" — a lowercase opener would hand the critic a typo we made.
 */
export function neutralizeOwnerClaims(text) {
  let out = String(text || "");
  const changes = [];
  for (const [re, replacement] of OWNERSHIP_REWRITES) {
    out = out.replace(new RegExp(re.source, re.flags), (match, ...rest) => {
      // rest = [...captures, offset, wholeString]. The replacement is built
      // from THESE captures, never by re-matching the pattern against the
      // isolated match — a pattern with lookaround or boundary context would
      // quietly fail to re-match and the "change" would be a no-op.
      const offset = rest[rest.length - 2];
      const whole = rest[rest.length - 1];
      const captures = rest.slice(0, -2);
      let replaced = replacement.replace(/\$(\d)/g, (_, n) => captures[Number(n) - 1] ?? "");
      const atSentenceStart = offset === 0 || /[.!?]["'”’]?\s+$/.test(whole.slice(0, offset));
      if (atSentenceStart) replaced = replaced.charAt(0).toUpperCase() + replaced.slice(1);
      changes.push({ from: match, to: replaced });
      return replaced;
    });
  }
  return { text: out, changes };
}

// ─── whole-script adaptation ────────────────────────────────────────────────

/**
 * Adapt a finished script for its presenter.
 *
 * Owner: returned untouched — Peter's claims are Peter's to make.
 * Guest: every spoken and on-screen string is swept and neutralized, and
 * anything still claiming Peter's identity afterwards comes back in
 * `unresolved`. The CALLER must refuse to build a kit while unresolved is
 * non-empty; this function never throws so the refusal can carry the list.
 */
export function adaptScriptForPresenter(script, presenter) {
  if (!presenter || presenter.role === "owner") {
    return { script, changes: [], unresolved: [], adapted: false };
  }

  const changes = [];
  const sweep = (where, text) => {
    if (typeof text !== "string" || !text.trim()) return text;
    const { text: out, changes: c } = neutralizeOwnerClaims(text);
    changes.push(...c.map((ch) => ({ where, ...ch })));
    return out;
  };

  const adapted = {
    ...script,
    hook: sweep("hook", script.hook),
    promise: sweep("promise", script.promise),
    openingOverlay: sweep("openingOverlay", script.openingOverlay),
    sections: (script.sections || []).map((s, si) => ({
      ...s,
      boundaryPull: sweep(`section ${si + 1} boundaryPull`, s.boundaryPull),
      takes: (s.takes || []).map((t) => ({ ...t, text: sweep(t.id || "take", t.text) })),
    })),
    softCta: script.softCta ? { ...script.softCta, text: sweep("softCta", script.softCta.text) } : script.softCta,
    close: script.close ? { ...script.close, text: sweep("close", script.close.text) } : script.close,
  };

  // The re-scan runs over the ADAPTED text: whatever survived neutralization
  // is what would actually reach the screen, and only identity claims plus
  // any pattern the rewrite failed to fully clear can still be here.
  const unresolved = [];
  const scan = (where, text) => {
    for (const claim of findOwnerClaims(text)) unresolved.push({ where, ...claim });
  };
  scan("hook", adapted.hook);
  scan("promise", adapted.promise);
  scan("openingOverlay", adapted.openingOverlay);
  for (const take of allTakes(adapted)) scan(take.id || "take", take.text);
  (adapted.sections || []).forEach((s, si) => scan(`section ${si + 1} boundaryPull`, s.boundaryPull));

  return { script: adapted, changes, unresolved, adapted: true };
}

// ─── generation-time framing ────────────────────────────────────────────────

/**
 * The block appended to the writer system prompt when the presenter is a
 * guest. It rewrites the persona rather than patching it: the model writes
 * for THIS person from the first token, and the sweep above is the backstop,
 * not the plan.
 */
export function guestPresenterBlock(presenter) {
  if (!presenter || presenter.role === "owner") return "";
  return `

THE PRESENTER IS NOT PETER. This script will be read on camera by ${presenter.name}, a presenter on the Lifestyle Design Realty team. Everything above about voice and structure still applies, with these overrides, which win any conflict:

- ${presenter.name} never claims to be Peter, never gives Peter's name as their own, and never claims Peter's personal history. No "I'm Peter", no "my name is".
- Experience and client stories are the TEAM'S, in team framing: "we've worked with a family who...", "our clients", "a buyer we helped". Never "I sold", "my client", "I've been doing this for years".
- Plain first person for PRESENTING is fine and encouraged: "I want you to look at this road", "I'm going to show you the number". The presenter is really presenting; they are just not the one who closed the deals.
- CTAs are in team framing: "text us at [the number on screen]", "email us at ${teamContactEmail()}", and comments get "we'll reply", never "I'll reply". The team reads and answers every channel.
- The payment-breakdown offer in the close is still made — "text us the address and we'll run your actual monthly payment" — and the number is still never spoken.`;
}

// ─── the re-vet after adaptation ────────────────────────────────────────────

/**
 * Run the full gate set over an adapted script, exactly as generation would:
 * guards (leaks, payment figure, banned tells, impossible CTAs), the
 * standalone-take rule, and the seven-axis critic. Used on the reassignment
 * path, where the script comes out of actedResult instead of the writer.
 *
 * Imports are dynamic so the sweep and the writer block stay usable in tests
 * with no ANTHROPIC key and no model call.
 */
export async function vetAdaptedScript(script, { modelCall } = {}) {
  const { applyGuards, findConnectiveOpeners, scoreScript, scoresPass, SCORE_AXES } = await import("./yt-script.js");

  const failures = [];
  const guarded = applyGuards(script);
  if (guarded.paymentFigure.found) failures.push(`states a monthly payment figure ("${guarded.paymentFigure.match}")`);
  for (const tell of guarded.bannedTells) failures.push(`banned AI tell: "${tell.match}"`);
  for (const block of guarded.impossibleCta) failures.push(`impossible CTA: "${block}"`);
  const connective = findConnectiveOpeners(guarded.script);
  for (const c of connective) failures.push(`take ${c.id || "?"} opens with connective tissue ("${c.opener}...")`);
  if (failures.length > 0) return { ok: false, failures, scores: null, script: guarded.script };

  const scores = modelCall ? await scoreScript(guarded.script, modelCall) : await scoreScript(guarded.script);
  if (scores.unscored) {
    // Same refusal the pipeline makes for a fresh script: an unjudged kit
    // costs the presenter a recording session. Retry later, do not ship.
    return { ok: false, failures: ["the critic could not be reached — nothing scored the adapted script"], scores, script: guarded.script };
  }
  if (!scoresPass(scores)) {
    const axes = SCORE_AXES.map((a) => `${a}=${scores[a]}`).join(" ");
    return { ok: false, failures: [`adapted script scored below the bar (${axes})`], scores, script: guarded.script };
  }
  return { ok: true, failures: [], scores, script: guarded.script };
}
