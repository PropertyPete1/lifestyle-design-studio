/**
 * Shared text sanitizer — strips AI-sounding patterns from generated captions
 * and converts digits/symbols to TTS-friendly words.
 * 
 * Used by caption.js (Instagram), linkedin.js, and the voiceover pipeline.
 */

/**
 * Strip em/en dashes and clean up resulting punctuation.
 * Belt-and-suspenders: even if the prompt says "no dashes", models sometimes ignore it.
 */
export function stripDashes(text) {
  let t = text;
  // Replace em/en dashes with periods (handles "word — word" and "word—word")
  t = t.replace(/\s*[—–]\s*/g, ". ");
  // Clean up double punctuation artifacts: ". ." → "." and ", ." → "."
  t = t.replace(/\.\s*\.\s*/g, ". ");
  t = t.replace(/,\s*\.\s*/g, ". ");
  // Clean up period after emoji (e.g. "💸. builder" → "💸 builder")
  t = t.replace(/([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}])\.\s*/gu, "$1 ");
  return t;
}

/**
 * Full sanitizer for Instagram captions.
 * Strips dashes, normalizes whitespace, preserves hashtags and emojis.
 */
export function sanitizeCaption(text) {
  if (!text) return text;
  let t = stripDashes(text);
  // Normalize excessive blank lines
  t = t.replace(/\n{3,}/g, "\n\n").trim();
  return t;
}

// ─── TTS SANITIZER ────────────────────────────────────────────────────────────

const ONES = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
  "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/**
 * Convert an integer (0–999,999,999,999) to English words.
 */
function intToWords(n) {
  if (n === 0) return "zero";
  if (n < 0) return "negative " + intToWords(-n);

  let result = "";

  if (n >= 1_000_000_000) {
    result += intToWords(Math.floor(n / 1_000_000_000)) + " billion ";
    n %= 1_000_000_000;
  }
  if (n >= 1_000_000) {
    result += intToWords(Math.floor(n / 1_000_000)) + " million ";
    n %= 1_000_000;
  }
  if (n >= 1000) {
    result += intToWords(Math.floor(n / 1000)) + " thousand ";
    n %= 1000;
  }
  if (n >= 100) {
    result += ONES[Math.floor(n / 100)] + " hundred ";
    n %= 100;
  }
  if (n >= 20) {
    result += TENS[Math.floor(n / 10)] + " ";
    n %= 10;
  }
  if (n > 0) {
    result += ONES[n] + " ";
  }

  return result.trim();
}

/**
 * Convert a decimal like 2.5 to "two and a half", 3.5 to "three and a half",
 * or generic "X point Y" for other decimals.
 */
function decimalToWords(numStr) {
  const num = parseFloat(numStr);
  if (isNaN(num)) return numStr;

  const intPart = Math.floor(num);
  const fracPart = num - intPart;

  // Handle common .5 case (e.g. "2.5 baths" → "two and a half baths")
  if (Math.abs(fracPart - 0.5) < 0.01) {
    if (intPart === 0) return "a half";
    return intToWords(intPart) + " and a half";
  }

  // Handle .25 case
  if (Math.abs(fracPart - 0.25) < 0.01) {
    return intToWords(intPart) + " and a quarter";
  }

  // Handle .75 case
  if (Math.abs(fracPart - 0.75) < 0.01) {
    return intToWords(intPart) + " and three quarters";
  }

  // Generic: "X point Y"
  if (fracPart > 0) {
    const fracStr = numStr.split(".")[1] || "";
    const fracWords = fracStr.split("").map(d => ONES[parseInt(d)] || d).join(" ");
    return intToWords(intPart) + " point " + fracWords;
  }

  return intToWords(intPart);
}

/**
 * Convert a dollar amount string to words.
 * "$389K" → "three hundred eighty nine thousand dollars"
 * "$1.2M" → "one point two million dollars"
 * "$450,000" → "four hundred fifty thousand dollars"
 */
function dollarToWords(match) {
  let s = match.replace(/^\$/, "").replace(/,/g, "");

  // Handle K/M/B suffixes
  let multiplier = 1;
  if (/[kK]$/.test(s)) { multiplier = 1000; s = s.slice(0, -1); }
  else if (/[mM]$/.test(s)) { multiplier = 1_000_000; s = s.slice(0, -1); }
  else if (/[bB]$/.test(s)) { multiplier = 1_000_000_000; s = s.slice(0, -1); }

  const num = parseFloat(s);
  if (isNaN(num)) return match; // bail out

  const total = Math.round(num * multiplier);
  return intToWords(total) + " dollars";
}

/**
 * Sanitize text for TTS: convert all digits, dollar amounts, percentages,
 * and problematic symbols to spoken-word equivalents.
 * 
 * This is the code-enforced safety net — the model sometimes ignores prompt rules.
 */
export function sanitizeForTTS(text) {
  if (!text) return text;
  let t = text;

  // Strip em/en dashes first
  t = stripDashes(t);

  // Dollar amounts: $389K, $1.2M, $450,000, $389,000
  t = t.replace(/\$[\d,.]+[kKmMbB]?/g, dollarToWords);

  // Percentages: 3.5% → "three and a half percent"
  t = t.replace(/([\d.]+)\s*%/g, (_, num) => decimalToWords(num) + " percent");

  // Decimal numbers (before integers): 2.5 → "two and a half"
  t = t.replace(/\b(\d+\.\d+)\b/g, (_, num) => decimalToWords(num));

  // Comma-separated integers: 1,500 → 1500 then convert
  t = t.replace(/\b(\d{1,3}(?:,\d{3})+)\b/g, (match) => {
    const num = parseInt(match.replace(/,/g, ""), 10);
    return intToWords(num);
  });

  // Plain integers
  t = t.replace(/\b(\d+)\b/g, (_, num) => intToWords(parseInt(num, 10)));

  // Common abbreviations that TTS mangles
  t = t.replace(/\bsqft\b/gi, "square feet");
  t = t.replace(/\bsq\s*ft\b/gi, "square feet");
  t = t.replace(/\bbr\b/gi, "bedroom");
  t = t.replace(/\bba\b/gi, "bathroom");
  t = t.replace(/\bDFW\b/g, "D F W");

  // Strip remaining symbols that TTS reads awkwardly
  t = t.replace(/[#$%&*]/g, "");

  // Clean up extra spaces
  t = t.replace(/\s{2,}/g, " ").trim();

  return t;
}
