/**
 * caption-provenance.js — two questions a caption must answer before it ships.
 *
 *   1. IS THIS "ORIGINAL" ACTUALLY OURS?        isBotAuthoredCaption()
 *   2. DOES THE CAPTION CLAIM AN AMENITY — OR A RATING — ITS SOURCE NEVER MADE?
 *                                               findUnsupportedClaims()
 *
 * Both were found on one post — austin am, 2026-09-18T17:21Z, Drive file
 * 1jEUxHWWJV8CTJVzZ2Lb81Zo0XDqoFzz_ — and they are one loop seen from two ends.
 *
 * ─── THE LOOP ───────────────────────────────────────────────────────────────
 *
 * The restructure lane (generateCaptionFromOriginal) exists to carry a caption
 * Peter WROTE — real school districts, real HOA figures, real acreage — onto a
 * re-run of the same footage. It finds that caption through video-matches.json,
 * a perceptual-hash cache of "which Instagram post is this Drive file".
 *
 * But the flagship account's posts are hand-posted FROM THIS PIPELINE'S OUTPUT:
 * the delivery hands Peter a video and a generated caption, and he posts both.
 * So the next time the matcher looks at the flagship, the "original Instagram
 * caption" it finds for a file is the template this pipeline generated for it
 * last time. Measured on 2026-09-18 with isBotAuthoredCaption() below: 48 of
 * the 90 cached originals are ours, and 39 of those sit inside the reuse bands
 * — 13 under distance 5 (reused with no check) and 26 at 5-9 (reused once a
 * vision pass confirms it is the same property, which it is).
 *
 * Under hash distance 5 the lane reuses a match with no further check, and its
 * prompt says "Keep EVERY specific fact… Do NOT summarize". Given a template, it
 * returns the template: the 2026-09-18 post went out with the identical hook and
 * the identical second line as the 2026-07-17 post it was "restructured" from.
 * That is the rerun-decay pattern the decision file flags — 3,722 → 2,898 →
 * 2,262 → 1,702 across four runs of one caption — produced automatically.
 *
 * And it PADS. The themed-section format asks for "pools, trails, parks,
 * fitness, playgrounds"; the template's amenity line carries no fact at all
 * ("full amenity and community rundown available"); so the model filled the
 * section with "resort-style pool and gathering spaces", which no source for
 * that video contains. The fresh lane forbids exactly that in words ("You MUST
 * NOT invent… Amenities (no pools, trails, playgrounds…)"). Nothing forbade it
 * in code, in either lane.
 *
 * It padded the SCHOOLS section the same way, and that one is worse. The
 * template's line is "school ratings, HOA and taxes vary by address"; what was
 * published under 🎓 was "top-rated school district serving the area" — a
 * school-quality claim about an unnamed district, with nothing behind it, in a
 * real-estate advertisement. Only the full published text shows it: the
 * posted-log keeps 200 characters of a caption and the manifest 500, and the
 * 🎓 section starts after both.
 *
 * ─── WHY FINGERPRINTS, NOT DATES ────────────────────────────────────────────
 *
 * "Published after the pipeline went live" would also refuse every caption
 * Peter has hand-written since July, and those are the lane's whole purpose.
 *
 * ─── WHY THESE FINGERPRINTS, AND NOT THE OBVIOUS ONES ───────────────────────
 *
 * The obvious fingerprint is the CTA — and it is wrong, because the prompt's
 * CTA was copied from Peter's own captions. The first cut of this list flagged
 * 3 of his 20 hand-written captions in the cache, one of them a top-ten post:
 *
 *   "comment TOUR and I will DM you exact payments incentives and private tour
 *    times"                                    — his, 2026-07-09, two days
 *                                                before this pipeline existed
 *   "…tap the link in bio to get started with us today"      — his, 2026-06-11
 *   "or DM LIST for a private lineup plus a quick approval game plan" — his
 *
 * So "comment TOUR", "I will DM you", "DM LIST" and "link in bio to get started
 * with us today" prove nothing, and none of them is below. What IS below are
 * phrases introduced by this repo's own commits from 2026-07-13 on and found in
 * none of his writing. Measured against the cache on 2026-09-18: 0 of 20
 * pre-pipeline captions match, the one hand-written caption published since
 * (2026-08-09) does not match, and 31 of the 32 pipeline-written captions do.
 * The miss is 2026-07-12 — a restructure that predates every phrase below and
 * still carries the real facts of the caption it came from, so reusing it
 * launders nothing.
 *
 * A false positive costs a fresh caption where a reuse was possible. A false
 * negative republishes a template and calls it restructured. When adding a
 * line here, run it over video-matches.json first: the prompt has borrowed from
 * Peter before, and a phrase that reads like ours may be his.
 */

/**
 * Fold the typographic variation Instagram and the model both introduce —
 * curly apostrophes, non-breaking spaces, hyphen-for-space — so a fingerprint
 * written in ASCII matches the text as it comes back from the platform.
 */
function fold(text) {
  return String(text ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // combining marks, so "ó" matches "o"
    .replace(/[\u2018\u2019\u02bc]/g, "'") // curly apostrophes
    .replace(/[\u2010-\u2015\u2212]/g, "-") // the hyphen and dash family
    .replace(/[\u200b-\u200d\ufeff\u00ad]/g, "") // zero-width characters, soft hyphen
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

/**
 * Phrases only this pipeline has written. Each entry names the commit that
 * introduced its wording, so a future change to the prompt has somewhere
 * obvious to add its own line — after checking it against Peter's captions.
 */
export const BOT_CAPTION_FINGERPRINTS = [
  // Primary CTA's second clause (6411fc5, 2026-07-13). NOT the "comment TOUR
  // and I'll DM you" opening, which is Peter's.
  { id: "payment_breakdown_cta", pattern: /pick your favorite and i'll send the full monthly payment breakdown/ },
  // The same CTA's one-day predecessor (d09f266, 2026-07-13).
  { id: "complete_breakdown_cta", pattern: /complete monthly payment breakdown/ },
  // Secondary CTA (d09f266). His is "a private lineup"; "a custom lineup with
  // tour times" (2026-07-03) is also his, which is why the tail is required.
  { id: "custom_lineup_cta", pattern: /custom lineup of every similar option/ },
  // The no-knowledge-base placeholder lines (0f33158, 2026-07-13), and the
  // first day's wording of the amenity one ("the full community rundown").
  { id: "amenity_placeholder", pattern: /full (?:amenity and )?community rundown/ },
  { id: "school_placeholder", pattern: /school ratings, hoa and taxes vary by address/ },
];

/**
 * Was this caption written by this pipeline?
 *
 * Returns the ids of the fingerprints that matched — an empty array means "no
 * evidence it is ours". The caller logs the ids, so a refusal names its reason.
 */
export function botCaptionFingerprints(caption) {
  const text = fold(caption);
  if (!text) return [];
  return BOT_CAPTION_FINGERPRINTS.filter(({ pattern }) => pattern.test(text)).map(({ id }) => id);
}

export function isBotAuthoredCaption(caption) {
  return botCaptionFingerprints(caption).length > 0;
}

// ─── claim support ──────────────────────────────────────────────────────────

/**
 * Claims a caption may only make when its source makes them too: amenities,
 * and ratings.
 *
 * A CLOSED LIST, chosen by two tests. The claim must be material — a buyer who
 * asks about "the pool" and learns there is none was misled. And the word must
 * be hard to reach by accident, because a false positive strips a line from a
 * caption: bare "park" is out (Cedar Park is a city we post for), bare "lake"
 * is out (Lake Travis, Lakeway), "amenity" is out (it is in our own section
 * header), and "resort-style" is out (puffery, not an amenity — the noun next
 * to it is what gets checked). Interior words — island, pantry, ceilings — are
 * deliberately not here: the fresh lane is allowed generic interior copy, and
 * nothing in this list may fire on it.
 *
 * EACH ENTRY IS A FAMILY, NOT A WORD. The same pattern runs against the caption
 * and against the source, so "pools" is supported by "pool" — and, on purpose,
 * "a two-story fitness barn" is supported by "Wellness Barn". That pair is not
 * hypothetical: LEAD_GATING_RULES prescribes exactly that rewrite, so the model
 * is TOLD to say "fitness" about a community whose knowledge-base entry only
 * says "Wellness". A gate that refused the prompt's own instruction would send
 * every such caption to a retry it cannot win. tests/caption-provenance pins
 * every prescribed rewrite against the real communities.json for this reason.
 *
 * RATINGS are one family for the same reason: "top-rated" is supported by a
 * source that says "A-rated" (Esperanza's entry does), and by Peter's own
 * "Top-rated schools nearby" when that is the caption being restructured. What
 * it is never supported by is nothing. The dictated no-KB line ("school
 * ratings, HOA and taxes vary by address") makes no claim and does not match.
 */
export const GATED_CLAIMS = [
  { id: "pool", pattern: /\bpools?\b/ },
  { id: "splash pad", pattern: /\bsplash[ -]?(?:pad|park|zone)s?\b/ },
  { id: "lazy river", pattern: /\blazy rivers?\b/ },
  { id: "trails", pattern: /\btrails?\b/ },
  { id: "playground", pattern: /\bplaygrounds?\b/ },
  { id: "dog park", pattern: /\bdog parks?\b|\bbark par(?:k|que)s?\b/ },
  { id: "parks", pattern: /\b(?:pocket|community|neighborhood|city) parks?\b|(?<!\bdog )\bparks\b/ },
  { id: "fitness", pattern: /\bfitness\b|\bgyms?\b|\bwellness\b/ },
  { id: "clubhouse", pattern: /\bclub ?houses?\b/ },
  { id: "amenity center", pattern: /\bamenity (?:center|club)s?\b/ },
  { id: "courts", pattern: /\bpickleball\b|\btennis\b|\bvolleyball\b|\bbasketball\b/ },
  { id: "golf", pattern: /\bgolf course\b|\bgolf community\b/ },
  {
    id: "rating",
    pattern: /\b(?:top|highly|best|highest|well)[ -]?(?:rated|ranked)\b|\ba\+?-rated\b|\baward[ -]winning\b|\bexemplary\b|\bblue[ -]ribbon\b|\b(?:great|excellent|amazing|acclaimed|sought[ -]after|top|best|premier) (?:public )?(?:schools|school districts?|districts?|isd)\b/,
  },
];

/**
 * Which gated claims does `caption` make that no source text makes?
 *
 * `sourceTexts` is everything the caption was allowed to draw on: the original
 * caption being restructured, the video's overlay text, the community
 * knowledge-base block. An empty source means every gated claim in the
 * caption is unsupported — which is the no-knowledge-base case exactly.
 *
 * Returns [{ id, match, line }]: the family, the words that tripped it, and
 * the caption line they sit on (what stripUnsupportedClaims removes).
 */
export function findUnsupportedClaims(caption, sourceTexts = []) {
  const source = fold((Array.isArray(sourceTexts) ? sourceTexts : [sourceTexts]).filter(Boolean).join("\n"));
  const found = [];
  for (const line of String(caption ?? "").split("\n")) {
    const folded = fold(line);
    if (!folded) continue;
    for (const { id, pattern } of GATED_CLAIMS) {
      const m = folded.match(pattern);
      if (m && !pattern.test(source)) found.push({ id, match: m[0], line });
    }
  }
  return found;
}

/**
 * A themed-section header: emoji, then a short label with no sentence in it —
 * "🌳 amenity energy you will actually use", "💸 buyer wins". A line carrying a
 * full stop is a sentence, and "🌳 full amenity and community rundown
 * available. it's worth asking about" is therefore not a header.
 */
const SECTION_HEADER = /^\s*[\p{Extended_Pictographic}\ufe0f\u200d]+\s+\S/u;
function isSectionHeader(line) {
  const t = line.trim();
  return SECTION_HEADER.test(t) && t.length <= 60 && !/[.!?]/.test(t);
}

/**
 * Remove every line carrying an unsupported claim, then remove a section
 * header whose whole body went with them.
 *
 * The remedy of LAST resort, after a retry has already asked the model to fix
 * it. Deleting a line is blunt — it can take a supported clause down with the
 * unsupported one — and that is the right way round: an incomplete caption is
 * a weaker post, an invented amenity or rating is a false statement about a home.
 *
 * HEADERS ARE JUDGED PER BLOCK. A block is a run of non-blank lines, which is
 * how every caption this pipeline writes lays out a section: header, its
 * bullets, blank line. A header is dropped only when it opens a block, the
 * block lost at least one line, and nothing else in the block survives. A
 * caption with no blank lines between sections keeps its headers — a heading
 * over nothing is cosmetic, and guessing where a section ends is not.
 *
 * Returns { caption, removed } where `removed` lists the deleted lines.
 */
export function stripUnsupportedClaims(caption, sourceTexts = []) {
  const text = String(caption ?? "");
  const bad = new Set(findUnsupportedClaims(text, sourceTexts).map((f) => f.line));
  if (bad.size === 0) return { caption: text, removed: [] };

  const removed = [];
  const out = [];
  let block = [];
  const flush = () => {
    if (block.length === 0) return;
    const survivors = block.filter((line) => !bad.has(line));
    removed.push(...block.filter((line) => bad.has(line)));
    const onlyHeaderLeft = survivors.length === 1 && survivors[0] === block[0] && isSectionHeader(block[0]);
    if (onlyHeaderLeft && survivors.length < block.length) removed.push(survivors[0]);
    else out.push(...survivors);
    block = [];
  };
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      flush();
      out.push(line);
    } else {
      block.push(line);
    }
  }
  flush();

  return { caption: out.join("\n").replace(/\n{3,}/g, "\n\n").trim(), removed };
}
