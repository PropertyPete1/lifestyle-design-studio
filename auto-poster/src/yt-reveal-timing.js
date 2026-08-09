/**
 * yt-reveal-timing.js — deciding WHEN each piece of a graphic appears.
 *
 * The difference between a graphic and a slide is that a graphic arrives while
 * you are being told about it. A tax table that draws all five rows at once is a
 * slide: the eye reads ahead, finishes before the sentence does, and spends the
 * rest of the hold with nothing to do. The same table striking each row as it is
 * named is an explanation.
 *
 * So every animated visual needs an answer to "at what second does item 3 land",
 * and the honest source for that is the narration audio itself. Whisper already
 * produces word-level timestamps for the burned captions; this module reuses
 * them to anchor reveals to the moment the words are actually spoken rather than
 * to a guess about reading speed.
 *
 * THE FALLBACK IS NOT AN ERROR PATH. Word timing is missing whenever Whisper is
 * unavailable, the take is narrated by Peter and not yet transcribed, or the
 * audio is too short to align. Even pacing is a perfectly good graphic — it is
 * what every motion template on earth does — so a missing transcript costs
 * synchronisation, never the visual, and never the build.
 */

/**
 * The longest any reveal state may hold before something must change.
 *
 * Peter's rule is ~2s. It is enforced twice: here, by inserting motion beats
 * into a plan whose anchors are too far apart, and again in yt-visual-qc.js by
 * diffing the rendered frames. Planning it and proving it are different jobs and
 * the second one is the one that catches a renderer that ignored the plan.
 */
export const MAX_STATIC_SECONDS = 2;

/** A reveal closer than this to the previous one reads as one event, not two. */
export const MIN_REVEAL_GAP = 0.35;

/** Words carrying no anchoring value — matching on these lands reveals anywhere. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for", "with",
  "is", "are", "was", "were", "be", "been", "it", "its", "this", "that", "these",
  "those", "you", "your", "we", "our", "they", "their", "i", "my", "as", "by",
  "from", "so", "if", "than", "then", "about", "into", "over", "per", "up", "out",
]);

/** Strip a word to its comparable core. Whisper emits punctuation and casing. */
export function normaliseWord(w) {
  return String(w || "")
    .toLowerCase()
    .replace(/[^a-z0-9$%.]/g, "")
    .replace(/\.$/, "");
}

/**
 * Distinctive tokens from a label, best-first.
 *
 * "School district taxes" anchors far better on "district" than on "taxes",
 * because a script about property tax says "taxes" thirty times and "district"
 * once. Longer words are rarer words, near enough, and cheaper than a corpus.
 */
export function anchorTokens(label) {
  return String(label || "")
    .split(/\s+/)
    .map(normaliseWord)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .sort((a, b) => b.length - a.length);
}

/**
 * Find when a label is spoken, in seconds from the start of the take.
 *
 * Searches forward from `after` so a table's rows anchor in the order they are
 * narrated. Without that, a row whose label appears early in an unrelated
 * sentence would pull its reveal backwards and the table would draw out of
 * order — which looks like a bug even though every individual match was right.
 *
 * A numeric token matches a numeric word loosely ("$4,200" vs "4200"), because
 * Whisper's transcription of a figure rarely matches the way the spec writes it.
 *
 * @returns {number|null} seconds, or null when the label is never spoken
 */
export function findWordTime(words, label, { after = 0 } = {}) {
  if (!Array.isArray(words) || words.length === 0) return null;
  const tokens = anchorTokens(label);
  if (tokens.length === 0) return null;

  const digits = (s) => s.replace(/[^0-9]/g, "");

  for (const token of tokens) {
    const tokenDigits = digits(token);
    for (const w of words) {
      if (w.start < after) continue;
      const norm = normaliseWord(w.word);
      if (!norm) continue;
      if (norm === token || norm.startsWith(token) || token.startsWith(norm)) return w.start;
      // A figure: compare digits only, and only when there are enough of them
      // that the match means something. Two digits collide constantly.
      if (tokenDigits.length >= 3 && digits(norm) === tokenDigits) return w.start;
    }
  }
  return null;
}

/**
 * Build the reveal schedule for one animated visual.
 *
 * @param {object}   opts
 * @param {string[]} opts.labels    one per revealable item, in draw order
 * @param {Array}    opts.words     [{word,start,end}] for THIS take, or null
 * @param {number}   opts.seconds   how long the visual is on screen
 * @param {number}   opts.leadIn    seconds before the first reveal may land
 * @returns {{ reveals, synced, syncedCount, source, beats }}
 *
 * `reveals[i].at` is when item i appears. `beats` are additional moments where
 * the picture must change even though nothing new is revealed — they exist so
 * that a slow stretch of narration never leaves a frozen frame, and they are
 * what the ~2s rule turns into at render time.
 */
export function planReveals({ labels = [], words = null, seconds = 0, leadIn = 0.4 } = {}) {
  const n = labels.length;
  const total = Math.max(0, Number(seconds) || 0);
  if (n === 0 || total <= 0) {
    return { reveals: [], synced: false, syncedCount: 0, source: "none", beats: [] };
  }

  // The window reveals may occupy. The tail is left clear so the finished
  // graphic is readable as a whole before it leaves — a table whose last row
  // lands on the final frame was never actually seen.
  const first = Math.min(leadIn, total * 0.15);
  const last = Math.max(first, total * 0.82);

  const even = () =>
    labels.map((label, i) => ({
      index: i,
      label,
      at: round(n === 1 ? first : first + ((last - first) * i) / (n - 1)),
      synced: false,
    }));

  let reveals;
  let source;
  let syncedCount = 0;

  const usable = Array.isArray(words) && words.length > 0;
  if (!usable) {
    reveals = even();
    source = "even-pacing";
  } else {
    // Anchor each label to its word, walking forward so reveals stay in order.
    const evenly = even();
    let cursor = 0;
    reveals = labels.map((label, i) => {
      const found = findWordTime(words, label, { after: cursor });
      if (found === null || found > last) {
        return { index: i, label, at: evenly[i].at, synced: false };
      }
      cursor = found;
      syncedCount++;
      return { index: i, label, at: round(Math.min(Math.max(found, first), last)), synced: true };
    });
    source = syncedCount > 0 ? "word-timing" : "even-pacing";

    // A reveal that landed on a word can still collide with the one before it —
    // two rows named in the same breath. Push the later one out rather than
    // dropping it, so the count of items drawn always equals the count asked
    // for, which is the property the renderer depends on.
    for (let i = 1; i < reveals.length; i++) {
      const min = reveals[i - 1].at + MIN_REVEAL_GAP;
      if (reveals[i].at < min) reveals[i] = { ...reveals[i], at: round(Math.min(min, last)), synced: false, nudged: true };
    }
    // Unsynced reveals sitting between two synced ones should sit BETWEEN them,
    // not on the even-pacing grid, or an anchored table develops a limp.
    redistributeUnsynced(reveals, first, last);
  }

  return {
    reveals,
    synced: syncedCount > 0,
    syncedCount,
    source,
    beats: motionBeats(reveals, total),
  };
}

/**
 * Space runs of unanchored reveals evenly between their anchored neighbours.
 *
 * Mixing two schedules produces the worst of both: rows 1 and 4 land on their
 * words, rows 2 and 3 land wherever the even grid put them, and the result
 * stutters. Interpolating the gap keeps the anchored rows honest and makes the
 * unanchored ones look deliberate.
 */
function redistributeUnsynced(reveals, first, last) {
  let i = 0;
  while (i < reveals.length) {
    if (reveals[i].synced) { i++; continue; }
    let j = i;
    while (j < reveals.length && !reveals[j].synced) j++;
    const before = i > 0 ? reveals[i - 1].at : first - MIN_REVEAL_GAP;
    const after = j < reveals.length ? reveals[j].at : last + MIN_REVEAL_GAP;
    const span = after - before;
    const count = j - i + 1;
    if (span > 0) {
      for (let k = i; k < j; k++) {
        reveals[k] = { ...reveals[k], at: round(before + (span * (k - i + 1)) / count) };
      }
    }
    i = j + 1;
  }
}

/**
 * Moments where the picture must change with no new item to reveal.
 *
 * Two causes, and both are ordinary: narration that dwells (a 9-second hold with
 * three reveals in the first four seconds), and the tail after the last reveal.
 * The renderer turns a beat into a small state change — an emphasis pulse on the
 * item that is current — so the ~2s rule holds without inventing content that
 * the narration never mentions.
 */
export function motionBeats(reveals, total, { maxStatic = MAX_STATIC_SECONDS } = {}) {
  const beats = [];
  const points = [0, ...reveals.map((r) => r.at), total];
  for (let i = 1; i < points.length; i++) {
    const gap = points[i] - points[i - 1];
    if (gap <= maxStatic) continue;
    const steps = Math.ceil(gap / maxStatic) - 1;
    for (let s = 1; s <= steps; s++) {
      beats.push({ at: round(points[i - 1] + (gap * s) / (steps + 1)), reason: i === points.length - 1 ? "tail" : "dwell" });
    }
  }
  return beats;
}

/**
 * Emphasis words — where a zoom pulse belongs.
 *
 * MrBeast's cut lands its punches on the stressed word, not on a metronome. The
 * stress candidates that survive without a prosody model are the ones that are
 * lexically emphatic regardless of delivery: figures, negations, and proper
 * nouns. Those three cover the sentences this channel actually writes — "it is
 * NOT four percent", "twelve THOUSAND dollars", "out past BOERNE".
 *
 * Deliberately conservative. A pulse on every third word is a nervous tic, so
 * `minGap` throttles them and the caller caps the count.
 */
export function findEmphasisWords(words, { minGap = 2.0, limit = 12 } = {}) {
  if (!Array.isArray(words) || words.length === 0) return [];
  const NEGATIONS = new Set(["not", "no", "never", "isnt", "wasnt", "dont", "doesnt", "cant", "wont", "nothing", "nobody"]);

  const hits = [];
  let last = -Infinity;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const raw = String(w.word || "").trim();
    const norm = normaliseWord(raw);
    if (!norm) continue;

    // Whisper capitalises the first word of every sentence, so capitalisation
    // alone is not evidence of a name. A word is a name only when something
    // that is NOT a sentence boundary precedes it. Without this the opening
    // word of every take reads as a proper noun and takes a pulse it has not
    // earned — which is a pulse spent on "Your" instead of on "Boerne".
    const prev = i > 0 ? String(words[i - 1].word || "").trim() : null;
    const afterSentenceEnd = prev === null || /[.!?]$/.test(prev);

    let kind = null;
    if (/[0-9]/.test(norm)) kind = "number";
    else if (NEGATIONS.has(norm)) kind = "negation";
    else if (/^[A-Z][a-z]{2,}/.test(raw) && !afterSentenceEnd) kind = "proper";

    if (!kind) continue;
    if (w.start - last < minGap) continue;
    hits.push({ at: round(w.start), word: raw.trim(), kind });
    last = w.start;
    if (hits.length >= limit) break;
  }
  return hits;
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}
