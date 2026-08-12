/**
 * yt-text-safety.js — text that reaches pixels is checked, not trusted.
 *
 * THE HOLE THIS CLOSES, AND IT WAS A REAL ONE.
 *
 * `escapeAss` in yt-assemble.js strips `{` and `}` from every caption before
 * writing the ASS file. The reason is sound — a brace opens an override block
 * in ASS and an unbalanced one swallows the rest of the line — but the effect is
 * that a caption reading `{{PRICE}}` does not fail, and does not render a
 * visible brace either. It renders `PRICE`, centred, in the caption font, for
 * as long as its chunk is on screen. An unsubstituted template does not look
 * like a bug at that point; it looks like a word.
 *
 * That is the whole class: every text layer in this pipeline sanitises its input
 * so the RENDERER cannot break, and sanitising is exactly what turns a
 * substitution failure into a plausible-looking frame. A build must be unable to
 * draw a template token, and "unable" has to mean it stops, because every other
 * option ends with Peter finding it.
 *
 * WHY THE MATCH IS ON THE PUNCTUATION AND NOT ON A LIST OF NAMES
 *
 * There is no register of the placeholder names this codebase might use, and
 * there never will be — the writer prompt is a language model and the templates
 * are written by whoever is adding a layer. What every template system on earth
 * shares is DELIMITERS: braces, angle brackets, percent signs, dollar-braces.
 * A string that still contains its delimiters was not substituted, whatever the
 * name inside them happened to be.
 *
 * The empty and the literal-undefined cases are here for the same reason. A
 * template that resolved to nothing and one that resolved to the string
 * "undefined" are both substitution failures that reach the frame looking like
 * content — the second one has shipped in this repo before, as a caption reading
 * "undefined" in `main.js`'s early days.
 */

/**
 * Delimiter shapes that mean "this string is still a template".
 *
 * Each entry is [pattern, what it is] so the error names the thing rather than
 * printing a regex at somebody trying to fix a build at midnight.
 */
const TEMPLATE_SHAPES = [
  [/\{\{[\s\S]*?\}\}/, "a {{mustache}} placeholder"],
  [/\$\{[\s\S]*?\}/, "a ${...} template literal"],
  [/<%[\s\S]*?%>/, "an <% ... %> template tag"],
  [/\[\[[\s\S]*?\]\]/, "a [[...]] placeholder"],
  [/%\([A-Za-z_][\w]*\)[sdfr]/, "a %(name)s format placeholder"],
  // A bare brace with no closing partner is the shape `escapeAss` used to
  // silently delete. Checked separately from the balanced pairs above so the
  // message can say which half is missing.
  [/[{}]/, "a stray { or } brace"],
  // Angle-bracket placeholders are the one shape that overlaps with legitimate
  // prose, so this is deliberately narrow: ALL-CAPS or snake_case only, which is
  // what a placeholder looks like and is not what "<3" or "a < b" looks like.
  [/<[A-Z_][A-Z0-9_]{2,}>/, "an <UPPERCASE> placeholder"],
];

/** Strings that are a substitution failure wearing the costume of a value. */
const FAILED_SUBSTITUTIONS = new Set(["undefined", "null", "nan", "[object object]"]);

/**
 * Throw unless this string is safe to draw.
 *
 * NOT a sanitiser, and the distinction is the point of the module. There is no
 * "cleaned" return value to accidentally use, because cleaning is the behaviour
 * that produced the defect. It either throws or it returns the string it was
 * given, unchanged.
 *
 * @param {string} text   what is about to be drawn
 * @param {string} where  human-readable location, quoted into the error
 * @returns {string} the same string, so this can wrap an expression
 */
export function assertRenderableText(text, where = "on-screen text") {
  const problem = describeTextProblem(text);
  if (problem) {
    throw new Error(
      `${where} is not renderable: ${problem}. ` +
        `The value was ${JSON.stringify(text)}. ` +
        `This is a substitution failure — the build stops rather than drawing it.`
    );
  }
  return text;
}

/**
 * What is wrong with this string, or null when nothing is.
 *
 * Split out from the assertion so the artifact checks can REPORT on OCR'd text
 * without throwing from inside a reporting loop — an OCR pass wants to collect
 * every bad frame and name them all, not die on the first one.
 */
export function describeTextProblem(text) {
  if (text === null || text === undefined) return "the value is missing entirely";
  if (typeof text !== "string") return `the value is a ${typeof text}, not a string`;
  if (text.trim().length === 0) return "the value is empty";
  if (FAILED_SUBSTITUTIONS.has(text.trim().toLowerCase())) {
    return `the value is the literal string "${text.trim()}"`;
  }
  for (const [pattern, description] of TEMPLATE_SHAPES) {
    const m = pattern.exec(text);
    if (m) return `it contains ${description} (${JSON.stringify(m[0])})`;
  }
  return null;
}

/**
 * True when a string is safe to draw. For callers that want to filter rather
 * than fail — there are none in the render path, and there should not be.
 */
export function isRenderableText(text) {
  return describeTextProblem(text) === null;
}
