/**
 * Voiceover Script Generation
 *
 * Uses LLM to generate a voiceover script for a real estate video reel.
 * Two modes:
 *   A) PAYMENT BREAKDOWN — when caption contains a price, calculates monthly
 *      payment (mortgage P&I + taxes + insurance) and weaves it into the script.
 *   B) VIRAL ENGAGEMENT — when no price is detected, generates a relatable,
 *      engaging script designed to keep people watching.
 *
 * Key rules:
 * - Conversational, confident real estate professional tone
 * - No invented pricing/incentives unless from source caption
 * - No fair-housing risk language
 * - Soft, varied CTA at the end (always "comment" not "DM")
 * - NO bracket tags, NO stage directions — only spoken words
 * - Pacing: ~2.3–2.6 words per second
 */

import { invokeLLM } from "./_core/llm";

interface ScriptGenerationInput {
  /** Video duration in seconds */
  videoDurationSec: number;
  /** Original caption from the IG reel */
  caption: string;
  /** City: austin, san_antonio, dallas */
  city: string;
  /** Audio type detected: speech, music_only, silent */
  audioType: string;
}

interface GeneratedScript {
  script: string;
  wordCount: number;
  estimatedDurationSec: number;
  wordsPerSecond: number;
  mode: "payment_breakdown" | "viral_engagement";
  paymentDetails?: PaymentBreakdown;
}

interface PaymentBreakdown {
  homePrice: number;
  downPaymentPct: number;
  downPaymentAmount: number;
  loanAmount: number;
  interestRate: number;
  monthlyPI: number;
  monthlyTax: number;
  monthlyInsurance: number;
  totalMonthly: number;
  propertyTaxRate: number;
}

const WORDS_PER_SECOND_MIN = 2.3;
const WORDS_PER_SECOND_MAX = 2.6;
const WORDS_PER_SECOND_TARGET = 2.45;

/** Property tax rates by area (for new construction communities) */
const PROPERTY_TAX_RATES: Record<string, number> = {
  san_antonio: 0.021, // 2.1% — Bexar County + MUDs
  austin: 0.020,      // 2.0% — Travis/Williamson/Hays
  dallas: 0.023,      // 2.3% — Collin/Denton/Tarrant
};

const DEFAULT_RATE = 4.99;       // Default interest rate if not in caption
const DOWN_PAYMENT_PCT = 0.03;   // Always 3% down
const ANNUAL_INSURANCE = 1200;   // $1,200/year default

/**
 * Strip any bracket tags like [excited], [warm], [pause], etc. from a script.
 * ElevenLabs does NOT support these — it reads them as literal words.
 */
export function stripDeliveryTags(script: string): string {
  return script.replace(/\[[\w\-]+\]/g, "").replace(/\s{2,}/g, " ").trim();
}

/**
 * Parse price from caption text. Looks for patterns like:
 * - "Starting at $349,990"
 * - "$500,000"
 * - "from the mid three forties" → ~$345,000
 * - "high three hundreds" → ~$380,000
 * Returns the price in dollars or null if not found.
 */
export function parsePriceFromCaption(caption: string): number | null {
  if (!caption) return null;
  const lower = caption.toLowerCase();

  // Match explicit dollar amounts: $349,990 or $500000 or $1,200,000
  const dollarMatch = caption.match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
  if (dollarMatch) {
    const val = parseFloat(dollarMatch[1].replace(/,/g, ""));
    // Only consider it a home price if it's between $100k and $5M
    if (val >= 100000 && val <= 5000000) return val;
  }

  // Match "starting at" followed by a number
  const startingMatch = caption.match(/starting\s+(?:at|from)\s+\$?\s*([\d,]+)/i);
  if (startingMatch) {
    const val = parseFloat(startingMatch[1].replace(/,/g, ""));
    if (val >= 100000 && val <= 5000000) return val;
  }

  // Match written-out price ranges like "mid three forties" "high three hundreds"
  const wordPricePatterns: Array<{ pattern: RegExp; compute: (m: RegExpMatchArray) => number }> = [
    // "mid/low/high X hundreds" → X00,000 range
    { pattern: /(?:the\s+)?(low|mid|high)\s+(two|three|four|five|six|seven|eight|nine)\s+hundreds/i, compute: (m) => {
      const pos = { low: 0.2, mid: 0.5, high: 0.8 }[m[1].toLowerCase()] ?? 0.5;
      const base = { two: 200, three: 300, four: 400, five: 500, six: 600, seven: 700, eight: 800, nine: 900 }[m[2].toLowerCase()] ?? 300;
      return (base + pos * 100) * 1000;
    }},
    // "mid/low/high three forties" → $340,000-$349,000 range
    { pattern: /(?:the\s+)?(low|mid|high)\s+(two|three|four|five|six|seven|eight|nine)\s+(twenties|thirties|forties|fifties|sixties|seventies|eighties|nineties)/i, compute: (m) => {
      const pos = { low: 0.2, mid: 0.5, high: 0.8 }[m[1].toLowerCase()] ?? 0.5;
      const hundred = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 }[m[2].toLowerCase()] ?? 3;
      const tens = { twenties: 20, thirties: 30, forties: 40, fifties: 50, sixties: 60, seventies: 70, eighties: 80, nineties: 90 }[m[3].toLowerCase()] ?? 50;
      return (hundred * 100 + tens + pos * 10) * 1000;
    }},
  ];

  for (const { pattern, compute } of wordPricePatterns) {
    const match = lower.match(pattern);
    if (match) return Math.round(compute(match));
  }

  return null;
}

/**
 * Parse interest rate from caption text.
 * Looks for patterns like "5.99%", "4.99% fixed rate", "at 5.25%"
 */
export function parseRateFromCaption(caption: string): number | null {
  if (!caption) return null;

  // Match percentage patterns that look like mortgage rates (2-8%)
  const rateMatch = caption.match(/(\d+\.\d{1,2})\s*%/);
  if (rateMatch) {
    const rate = parseFloat(rateMatch[1]);
    if (rate >= 2.0 && rate <= 10.0) return rate;
  }

  return null;
}

/**
 * Calculate monthly mortgage payment (principal + interest) using standard amortization formula.
 */
function calculateMonthlyPI(loanAmount: number, annualRate: number, years: number = 30): number {
  const monthlyRate = annualRate / 100 / 12;
  const numPayments = years * 12;
  if (monthlyRate === 0) return loanAmount / numPayments;
  return loanAmount * (monthlyRate * Math.pow(1 + monthlyRate, numPayments)) / (Math.pow(1 + monthlyRate, numPayments) - 1);
}

/**
 * Calculate full monthly payment breakdown.
 */
export function calculatePaymentBreakdown(homePrice: number, interestRate: number, city: string): PaymentBreakdown {
  const downPaymentAmount = Math.round(homePrice * DOWN_PAYMENT_PCT);
  const loanAmount = homePrice - downPaymentAmount;
  const monthlyPI = calculateMonthlyPI(loanAmount, interestRate);
  const propertyTaxRate = PROPERTY_TAX_RATES[city] || 0.021;
  const monthlyTax = (homePrice * propertyTaxRate) / 12;
  const monthlyInsurance = ANNUAL_INSURANCE / 12;
  const totalMonthly = monthlyPI + monthlyTax + monthlyInsurance;

  return {
    homePrice,
    downPaymentPct: DOWN_PAYMENT_PCT * 100,
    downPaymentAmount,
    loanAmount,
    interestRate,
    monthlyPI: Math.round(monthlyPI),
    monthlyTax: Math.round(monthlyTax),
    monthlyInsurance: Math.round(monthlyInsurance),
    totalMonthly: Math.round(totalMonthly),
    propertyTaxRate,
  };
}

/**
 * Generate a voiceover script sized to fill the video duration MINUS 5 seconds
 * of breathing room, so the voice finishes naturally before the video ends.
 *
 * Mode A: If price is detected in caption → payment breakdown script
 * Mode B: If no price → engaging viral-style script
 */
export async function generateVoiceoverScript(input: ScriptGenerationInput): Promise<GeneratedScript> {
  // Subtract 5 seconds for breathing room — voice should finish before video ends
  const effectiveDuration = Math.max(10, input.videoDurationSec - 5);
  const targetWordCount = Math.round(effectiveDuration * WORDS_PER_SECOND_TARGET);
  const minWords = Math.round(effectiveDuration * WORDS_PER_SECOND_MIN);
  const maxWords = Math.round(effectiveDuration * WORDS_PER_SECOND_MAX);

  const cityLabel = {
    austin: "Austin, Texas",
    san_antonio: "San Antonio, Texas",
    dallas: "Dallas–Fort Worth, Texas",
  }[input.city] || input.city;

  // Detect if caption has pricing info
  const detectedPrice = parsePriceFromCaption(input.caption);
  const detectedRate = parseRateFromCaption(input.caption);
  const mode = detectedPrice ? "payment_breakdown" : "viral_engagement";

  let paymentDetails: PaymentBreakdown | undefined;
  let paymentContext = "";

  if (detectedPrice) {
    const rate = detectedRate ?? DEFAULT_RATE;
    paymentDetails = calculatePaymentBreakdown(detectedPrice, rate, input.city);
    paymentContext = `
MONTHLY PAYMENT BREAKDOWN (weave these numbers naturally into the script):
- Home price: $${detectedPrice.toLocaleString()}
- Down payment: 3% ($${paymentDetails.downPaymentAmount.toLocaleString()})
- Interest rate: ${rate}%
- Monthly mortgage (P&I): ~$${paymentDetails.monthlyPI.toLocaleString()}
- Monthly property taxes: ~$${paymentDetails.monthlyTax.toLocaleString()}
- Monthly insurance: ~$${paymentDetails.monthlyInsurance}
- TOTAL MONTHLY PAYMENT: ~$${paymentDetails.totalMonthly.toLocaleString()}

The script should naturally break down the payment so viewers understand what they'd actually pay per month. Make it feel like insider knowledge — "here's what nobody tells you about the real monthly cost." Round numbers slightly for natural speech (say "about twenty-three hundred" instead of "$2,347").`;
  }

  const systemPrompt = mode === "payment_breakdown"
    ? `You are writing a voiceover script for Peter Allen, a real estate professional who runs Lifestyle Design Realty in Texas. The script will be spoken aloud by a text-to-speech engine over a property tour video on Instagram Reels.

VOICE & TONE:
- Sound like a knowledgeable real estate professional breaking down the REAL numbers
- Conversational, confident, warm — like you're telling a friend what the actual monthly cost is
- Use natural speech patterns: vary sentence length, mix short punchy lines with longer descriptive ones
- The TTS engine handles tone automatically from context — do NOT include any emotion tags, brackets, stage directions, or delivery instructions

CONTENT APPROACH — MONTHLY PAYMENT BREAKDOWN:
- The hook should be about the monthly payment or affordability (this is what stops the scroll)
- Break down the numbers naturally: price, rate, what that means monthly
- Make viewers feel like they're getting insider knowledge most agents won't share
- Include the total monthly payment prominently — this is the key number people care about
- Mention what's included (principal, interest, taxes, insurance) so they know it's the REAL number
- End with engagement — "comment HOME" or "comment PAYMENT" to learn more

SENTENCE ENDINGS — CRITICAL FOR NATURAL SOUND:
- NEVER end a sentence on a single low-energy word (like "today" or "home" or "here")
- End sentences with 2-3 word phrases that carry energy forward
- Use questions, exclamations, or upward-energy phrases to keep momentum
- The LAST sentence should feel like an invitation, not a statement trailing off

FORMAT — THIS IS CRITICAL:
- Output ONLY the exact words to be spoken. Nothing else.
- NO brackets, NO parenthetical directions, NO stage directions
- NO quotation marks, NO line numbers, NO bullet points
- Write as one continuous paragraph of spoken words only`
    : `You are writing a voiceover script for Peter Allen, a real estate professional who runs Lifestyle Design Realty in Texas. The script will be spoken aloud by a text-to-speech engine over a property tour video on Instagram Reels.

VOICE & TONE:
- Sound like a knowledgeable real estate professional speaking naturally to camera
- Conversational, confident, warm — NOT hype-y, NOT influencer-style
- Use natural speech patterns: vary sentence length, mix short punchy lines with longer descriptive ones
- The TTS engine handles tone automatically from context — do NOT include any emotion tags, brackets, stage directions, or delivery instructions

CONTENT APPROACH — VIRAL ENGAGEMENT (no price available):
- Make the viewer FEEL something — paint a picture of the lifestyle
- Use relatable scenarios: "imagine coming home to this after a long day" or "picture your morning coffee with this view"
- Create curiosity and FOMO — make them want to know more
- Focus on: what makes this property special, the lifestyle it offers, the neighborhood vibe
- End with strong engagement CTA — "comment" a keyword to learn more (NEVER say "DM")
- Make it the kind of content people save and share

SENTENCE ENDINGS — CRITICAL FOR NATURAL SOUND:
- NEVER end a sentence on a single low-energy word (like "today" or "home" or "here")
- End sentences with 2-3 word phrases that carry energy forward
- Use questions, exclamations, or upward-energy phrases to keep momentum
- The LAST sentence should feel like an invitation, not a statement trailing off

FORMAT — THIS IS CRITICAL:
- Output ONLY the exact words to be spoken. Nothing else.
- NO brackets, NO parenthetical directions, NO stage directions
- NO quotation marks, NO line numbers, NO bullet points
- Write as one continuous paragraph of spoken words only`;

  const userPrompt = `Write a voiceover script for a ${cityLabel} property video.

VIDEO DURATION: ${effectiveDuration} seconds (the video is ${input.videoDurationSec}s total but the voice should finish 5 seconds before the end)
TARGET WORD COUNT: ${targetWordCount} words (minimum ${minWords}, maximum ${maxWords})
AUDIO TYPE: ${input.audioType === "speech" ? "Original video has someone talking — voiceover will replace their audio entirely" : "Original video has music/ambient audio — voiceover will be layered on top with the music ducked"}
${paymentContext}
SOURCE CAPTION (use any factual details from this, but do NOT copy it verbatim):
${input.caption || "(No caption available)"}

CRITICAL WORD COUNT REQUIREMENT: The script MUST be EXACTLY ${targetWordCount} words (minimum ${minWords}, maximum ${maxWords}). This is non-negotiable — a script that is too short will leave awkward silence over the video. Count your words before submitting. If you're under ${minWords} words, add more detail about the property, lifestyle, or neighborhood until you hit the target. Output ONLY spoken words — no tags, no brackets, no directions.`;

  // Retry loop: if LLM generates too few words, retry with feedback
  let script = "";
  let wordCount = 0;
  const MAX_RETRIES = 3;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const messages: Array<{role: string; content: string}> = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    if (attempt > 0) {
      messages.push({
        role: "assistant",
        content: script,
      });
      messages.push({
        role: "user",
        content: `That script is only ${wordCount} words. I need EXACTLY ${targetWordCount} words (minimum ${minWords}). You are ${minWords - wordCount} words short. Please rewrite the FULL script with more detail about the property features, lifestyle benefits, and neighborhood. Add more sentences. The script must fill ${effectiveDuration} seconds of speaking time at 2.45 words per second. Output the complete rewritten script now.`,
      });
    }

    const response = await invokeLLM({ messages: messages as any });
    const rawContent = response.choices[0]?.message?.content;
    script = stripDeliveryTags((typeof rawContent === "string" ? rawContent : "").trim());
    wordCount = script.split(/\s+/).filter(Boolean).length;

    console.log(`[VoScript] Attempt ${attempt + 1}: ${wordCount} words (target: ${targetWordCount}, min: ${minWords}) [mode: ${mode}]`);

    if (wordCount >= minWords) break;
  }

  const estimatedDurationSec = Math.round(wordCount / WORDS_PER_SECOND_TARGET);

  return {
    script,
    wordCount,
    estimatedDurationSec,
    wordsPerSecond: wordCount / effectiveDuration,
    mode,
    paymentDetails,
  };
}

/**
 * Validate a script's word count against video duration.
 * Returns whether it's within acceptable range.
 */
export function validateScriptLength(
  script: string,
  videoDurationSec: number
): { valid: boolean; wordCount: number; estimatedSec: number; mismatchPct: number } {
  const cleanScript = stripDeliveryTags(script);
  const wordCount = cleanScript.split(/\s+/).filter(Boolean).length;
  const estimatedSec = Math.round(wordCount / WORDS_PER_SECOND_TARGET);
  const mismatchPct = Math.round(((estimatedSec - videoDurationSec) / videoDurationSec) * 100);

  return {
    valid: Math.abs(mismatchPct) <= 15,
    wordCount,
    estimatedSec,
    mismatchPct,
  };
}
