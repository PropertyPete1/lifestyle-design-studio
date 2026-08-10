/**
 * yt-scene-keywords.js — what each six-to-eight second window is ABOUT.
 *
 * THE PROBLEM THIS REPLACES
 *
 * Stock was fetched once per TAKE, from the writer's keywords for that take. A
 * thirty-second take is four or five scenes, and all of them got the same clip
 * sliced into windows — so a take that moved from a hospital campus to houses
 * from the eighties showed the same footage throughout, and the picture stopped
 * agreeing with the sentence about eight seconds in. The fix is not better
 * keywords; it is keywords per WINDOW, taken from the phrase actually spoken
 * while that window is on screen.
 *
 * NOTHING IN THIS FILE KNOWS WHAT THE VIDEO IS ABOUT
 *
 * There is no place name, no market, no topic vocabulary and no mapping table
 * anywhere in this module, and there must never be one. Every keyword is derived
 * from the transcript at build time by rules that are properties of English
 * rather than of real estate: function words are removed, proper nouns are
 * dropped in favour of the common nouns beside them, and what survives is ranked
 * by how specific it is TO THIS WINDOW relative to the rest of the same script.
 *
 * The only fixed vocabulary is the closed-class function-word list below. That
 * is language mechanics — the same category of thing as escaping a brace in an
 * ASS caption — and it is what makes the module universal instead of tuned. A
 * script about property taxes and a script about school attendance zones each
 * yield their own concepts from the same code, because the code reads the
 * script rather than recognising the subject.
 *
 * WHY PROPER NOUNS ARE DROPPED RATHER THAN TRANSLATED
 *
 * "Audie Murphy VA hospital" must return a hospital campus, not a picture of
 * that hospital — stock does not contain that building, and a clip captioned as
 * though it did would be a false claim about a real place. The generalisation is
 * therefore structural rather than clever: the proper noun is REMOVED and the
 * common noun standing next to it is kept, because a script that names a
 * specific thing almost always says what kind of thing it is in the same breath.
 * "Audie Murphy VA hospital" keeps "hospital"; "houses from the 80s and 90s"
 * keeps "houses" and the decade.
 *
 * That also makes the safety property structural. The vision check's subject is
 * built from the surviving words, so it CANNOT contain the proper noun — not
 * because a rule says not to include it, but because it was removed several
 * steps earlier and nothing downstream has it to put back.
 */

/**
 * Closed-class English function words.
 *
 * Deliberately only function words. No nouns, no adjectives, no domain terms —
 * the moment a content word appears in this list, the module has an opinion
 * about subject matter and stops being universal.
 */
const FUNCTION_WORDS = new Set(
  ("a an the and or but nor so yet for of in on at to from by with without within into onto upon over under " +
   "about above across after against along among around before behind below beneath beside between beyond during " +
   "except inside near off out outside past since through throughout till until up down toward towards " +
   "i you he she it we they me him her us them my your his its our their mine yours hers ours theirs " +
   "this that these those there here who whom whose which what when where why how " +
   "is are was were be been being am do does did doing have has had having " +
   "will would shall should can could may might must ought " +
   "not no yes if then than as such very much many more most less least too also just only even still " +
   "get gets got go goes going come comes came make makes made take takes took put puts " +
   "one two three four five six seven eight nine ten " +
   // Closed-class adverbs and quantifiers. Added after the universality probe
   // produced the query "commute already changed" — "already" carries no
   // picture, and neither do any of these, but they survive a stopword list
   // that stops at articles and prepositions.
   "already again always never often sometimes ever once twice apart instead rather almost nearly " +
   "back away back off out up down over here there now soon later first last next own same other " +
   "every each any all both few several enough while whether because although though since unless " +
   "opposite middle whole half part end ends side sides way ways thing things lot lots " +
   "s t re ve ll d m").split(/\s+/)
);

/**
 * Words that announce a noun is coming.
 *
 * A determiner or a possessive is followed by a noun phrase in English — "the
 * roof", "your kitchen", "a notice". That is syntax rather than vocabulary, so
 * it holds for any topic, and it is the cheapest reliable noun signal available
 * without a parser.
 *
 * Needed because the first version ranked by rarity alone and produced queries
 * like "arguing house worth" and "mails notice people": the verbs were rare in
 * the script and therefore scored well, while being exactly the words a stock
 * search cannot use. Stock footage is made of nouns.
 */
const DETERMINERS = new Set(
  "a an the this that these those my your his her its our their some any each every no another".split(/\s+/)
);

/** Two to five capitals is an initialism — an organisation or programme, not a picture. */
const ACRONYM = /^[A-Z]{2,5}$/;

/** A decade, however the script writes it. Kept: an era is a visual property. */
const DECADE = /^\d{2,4}s$/i;

/** Anything that is only digits and punctuation is a figure, not a subject. */
const FIGURE = /^[\d$,.%-]+$/;

const EDGE_PUNCT = /^[("'‘“]+|[)"'.,;:!?’”]+$/g;

/**
 * How many terms one search query carries.
 *
 * TWO, not three. A three-word query built from a spoken sentence reliably
 * picked up a verb — "mails notice people", "arguing house worth" — and Pexels
 * answers a query like that with whatever matches one of the words. Two nouns
 * describe a picture; three words describe a sentence.
 */
export const MAX_KEYWORDS = 2;

function bare(token) {
  return String(token || "").replace(EDGE_PUNCT, "");
}

/**
 * The tokens spoken while one window is on screen.
 *
 * PROPORTIONAL, AND ALIGNED WITH THE CAPTIONS BY CONSTRUCTION. Word timings from
 * Whisper were the obvious alternative and are not used, for a reason worth
 * stating: the captions are laid out by dividing each segment's tokens evenly
 * across its duration, so a window's caption text is determined by exactly this
 * arithmetic. Timing the keywords differently would mean the footage answered a
 * phrase the viewer was not reading at that moment — the picture and the words
 * disagreeing again, in a quieter way than card 7 but the same way.
 *
 * The segment's duration is the narration's true length by this point, so
 * proportional is not an estimate standing in for a measurement; it is the same
 * division the captions are already trusted to make.
 */
export function windowRange(seg, { startAt, seconds }) {
  const tokens = String(seg?.text || "").split(/\s+/).filter(Boolean);
  const total = seg?.seconds || 0;
  if (tokens.length === 0 || total <= 0) return { tokens, from: 0, to: 0 };
  const from = Math.max(0, Math.floor((startAt / total) * tokens.length));
  const to = Math.min(tokens.length, Math.ceil(((startAt + seconds) / total) * tokens.length));
  return { tokens, from, to: Math.max(from + 1, to) };
}

export function windowTokens(seg, block) {
  const { tokens, from, to } = windowRange(seg, block);
  return tokens.slice(from, to);
}

/**
 * Every word the script capitalises in a position where capitalisation MEANS
 * something.
 *
 * THE BUG THIS EXISTS TO KILL. The first version treated a capitalised token as
 * proper only when it was not the first token of the phrase it was handed — a
 * rule that is right for a sentence and wrong for a WINDOW, because a window
 * begins wherever six seconds of narration begins, which is usually mid
 * sentence and sometimes exactly on a place name. Every window whose first word
 * was a proper noun leaked it into the search. The test that found it asked for
 * a hospital and got a query naming the neighbourhood.
 *
 * So capitalisation is judged across the WHOLE script rather than inside the
 * fragment: any word the script capitalises somewhere other than after a full
 * stop is a proper noun everywhere it appears, including at the start of a
 * sentence and including at the start of a window. Built from the transcript at
 * build time like everything else here — no gazetteer, no place list.
 */
export function properLexicon(segments) {
  const lexicon = new Set();
  for (const seg of segments || []) {
    const tokens = String(seg?.text || "").split(/\s+/).filter(Boolean);
    tokens.forEach((raw, i) => {
      const t = bare(raw);
      if (!t) return;
      if (ACRONYM.test(t)) { lexicon.add(t.toLowerCase()); return; }
      if (!/^[A-Z][a-z’']/.test(t)) return;
      // Sentence-initial capitalisation carries no information — it is the
      // grammar, not the word. Anywhere else, it is the writer naming something.
      const startsSentence = i === 0 || /[.!?]["'’”]?$/.test(String(tokens[i - 1]));
      if (!startsSentence) lexicon.add(t.toLowerCase());
    });
  }
  return lexicon;
}

/**
 * Split a token run into the proper nouns and everything else.
 *
 * Three signals, in order of how much they can be trusted:
 *   1. the script's own capitalisation elsewhere (`lexicon`) — strongest,
 *      because it is evidence from outside this fragment;
 *   2. a capitalised RUN — "Stone Oak" at the head of a sentence is a name even
 *      the first time the script uses it, because names travel in pairs and
 *      common nouns do not;
 *   3. capitalisation mid-fragment, the local fallback.
 *
 * Errs the safe way throughout. Mistaking a sentence-initial common noun for a
 * proper noun costs one candidate term out of several; mistaking a place name
 * for a common noun puts that place name into a stock search, which is the
 * failure this whole classification exists to prevent.
 */
export function classifyTokens(tokens, { lexicon = new Set(), startsSentence = () => false } = {}) {
  const proper = [];
  const common = [];
  tokens.forEach((raw, i) => {
    const t = bare(raw);
    if (!t) return;
    if (ACRONYM.test(t)) { proper.push(t); return; }
    // An era is a visual property, and it is the one kind of figure that is.
    // Pushed in the same shape as every other kept token — it used to be a bare
    // string while the rest became objects, so a window containing a decade
    // crashed the ranking with an undefined word.
    if (DECADE.test(t)) { common.push({ word: t.toLowerCase(), nounCue: false }); return; }
    if (FIGURE.test(t)) return;

    const lower = t.toLowerCase().replace(/[^a-z0-9’'-]/g, "");
    const capitalised = /^[A-Z][a-z’']/.test(t);
    const nextCapitalised = /^[A-Z]/.test(bare(tokens[i + 1] || ""));

    // A FUNCTION WORD IS NEVER A NAME, whatever the capitalisation says. "Every
    // January" and "The Northside" both begin with a capitalised function word,
    // and reporting "Every" and "The" as dropped proper nouns made the build's
    // evidence line read like nonsense — which matters, because that line is
    // how a person checks that no place name reached a search.
    if (FUNCTION_WORDS.has(lower)) return;

    if (capitalised && (lexicon.has(lower) || nextCapitalised || !startsSentence(i))) {
      proper.push(t);
      return;
    }
    if (!capitalised && lexicon.has(lower)) { proper.push(t); return; }

    if (!lower) return;
    if (lower.length < 3) return;
    common.push({ word: lower, nounCue: DETERMINERS.has(bare(tokens[i - 1] || "").toLowerCase()) });
  });
  return { proper, common: common.map((c) => c.word), cues: common };
}

/**
 * How specific each word is to this window rather than to the script.
 *
 * A word that runs through the whole script describes the video, not this
 * six seconds of it — searching for it returns the same footage every window and
 * undoes the entire point of doing this per window. A word that appears here and
 * seldom elsewhere is what makes this window different, so it leads the query.
 *
 * Computed from the script in hand. There is no corpus, no frequency table and
 * nothing downloaded: rarity is measured against the other words of this very
 * video, which is what keeps the rule universal across topics.
 */
export function specificity(word, documentCounts, totalWords) {
  const seen = documentCounts.get(word) || 1;
  // Longer words carry more meaning on average, and it breaks ties sensibly
  // without needing to know what any particular word means.
  return Math.log((totalWords + 1) / seen) + Math.min(word.length, 12) / 24;
}

/** Word counts across the whole script, for the rarity signal. */
export function documentFrequencies(segments) {
  const counts = new Map();
  let total = 0;
  for (const seg of segments || []) {
    for (const raw of String(seg?.text || "").split(/\s+/)) {
      const t = bare(raw).toLowerCase().replace(/[^a-z0-9’'-]/g, "");
      if (!t || FUNCTION_WORDS.has(t) || t.length < 3) continue;
      counts.set(t, (counts.get(t) || 0) + 1);
      total++;
    }
  }
  return { counts, total: Math.max(1, total) };
}

/**
 * The search query for one window.
 *
 * @returns {{ keywords, subject, dropped, phrase, source }}
 *   `dropped` is every proper noun removed, reported so the build can prove no
 *   place name reached a search rather than merely asserting it.
 */
export function keywordsForWindow(seg, block, { frequencies, lexicon, fallbackKeywords = [] } = {}) {
  const { tokens: all, from, to } = windowRange(seg, block);
  const tokens = all.slice(from, to);
  const phrase = tokens.join(" ");
  // Sentence starts are a property of the SEGMENT, so they are resolved against
  // the absolute position — a window opening mid-sentence must not treat its
  // own first word as one.
  const startsSentence = (i) => {
    const abs = from + i;
    return abs === 0 || /[.!?]["'’”]?$/.test(String(all[abs - 1] || ""));
  };
  const { proper, common, cues } = classifyTokens(tokens, {
    lexicon: lexicon || properLexicon([seg]),
    startsSentence,
  });
  const { counts, total } = frequencies || documentFrequencies([seg]);

  // A word that follows a determiner is almost certainly the noun of its
  // phrase, and nouns are what stock footage is made of. The boost is large
  // enough to beat a rare verb and small enough that a genuinely distinctive
  // word without the cue still wins.
  const nounCue = new Map();
  for (const c of cues || []) nounCue.set(c.word, nounCue.get(c.word) || c.nounCue);

  const ranked = [...new Set(common)]
    .map((w) => ({ w, score: specificity(w, counts, total) + (nounCue.get(w) ? 1.2 : 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_KEYWORDS)
    .map((x) => x.w);

  // Word order as spoken, not as ranked — "hospital campus" reads as a place and
  // "campus hospital" reads as a search engine's idea of one.
  const ordered = common.filter((w, i) => common.indexOf(w) === i && ranked.includes(w));

  if (ordered.length === 0) {
    // A window made entirely of a proper noun and function words — "out past
    // Loop 1604" — has no concept of its own to search for. The writer's intent
    // for the take is the honest fallback: it is still derived from this script,
    // and it is what the old per-take behaviour would have used anyway.
    const fb = (fallbackKeywords || []).filter(Boolean).slice(0, MAX_KEYWORDS);
    return {
      keywords: fb,
      subject: fb[0] || null,
      dropped: proper,
      phrase,
      source: fb.length ? "take-intent" : "none",
    };
  }

  return {
    keywords: [ordered.join(" ")],
    subject: ordered.join(" "),
    dropped: proper,
    phrase,
    source: "window",
  };
}

/**
 * Every stock window in the plan, with its own query.
 *
 * PURE, so the universality claim can be demonstrated rather than argued: run it
 * over any script and read the windows, the phrases and the queries it produces.
 */
export function planWindowKeywords(segments) {
  const frequencies = documentFrequencies(segments);
  const lexicon = properLexicon(segments);
  const windows = [];
  for (const seg of segments || []) {
    if (seg?.kind !== "voiceover") continue;
    for (const block of seg.visualBlocks || []) {
      if (block.kind !== "stock") continue;
      windows.push({
        takeId: seg.takeId,
        startAt: block.startAt ?? 0,
        seconds: block.seconds,
        phase: block.phase ?? 0,
        ...keywordsForWindow(seg, block, {
          frequencies,
          lexicon,
          fallbackKeywords: seg.visualSpec?.keywords || [],
        }),
      });
    }
  }
  return windows;
}
