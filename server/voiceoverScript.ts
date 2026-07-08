/**
 * Voiceover Script Generation
 *
 * Uses LLM to generate a voiceover script for a real estate video reel.
 * The script is sized to fill the full video duration based on pacing estimates.
 *
 * Key rules:
 * - Conversational, confident real estate professional tone
 * - No invented pricing/incentives unless from source caption
 * - No fair-housing risk language
 * - Soft, varied CTA at the end
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
}

const WORDS_PER_SECOND_MIN = 2.3;
const WORDS_PER_SECOND_MAX = 2.6;
const WORDS_PER_SECOND_TARGET = 2.45;

/**
 * Strip any bracket tags like [excited], [warm], [pause], etc. from a script.
 * ElevenLabs does NOT support these — it reads them as literal words.
 */
export function stripDeliveryTags(script: string): string {
  return script.replace(/\[[\w\-]+\]/g, "").replace(/\s{2,}/g, " ").trim();
}

/**
 * Generate a voiceover script sized to fill the video duration MINUS 5 seconds
 * of breathing room, so the voice finishes naturally before the video ends.
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

  const systemPrompt = `You are writing a voiceover script for Peter Allen, a real estate professional who runs Lifestyle Design Realty in Texas. The script will be spoken aloud by a text-to-speech engine over a property tour video on Instagram Reels.

VOICE & TONE:
- Sound like a knowledgeable real estate professional speaking naturally to camera
- Conversational, confident, warm — NOT hype-y, NOT influencer-style
- Use natural speech patterns: vary sentence length, mix short punchy lines with longer descriptive ones
- The TTS engine handles tone automatically from context — do NOT include any emotion tags, brackets, stage directions, or delivery instructions

CONTENT RULES:
- NEVER invent specific pricing, rates, incentives, or availability unless that exact info appears in the source caption
- NEVER use fair-housing risk language (don't describe neighborhoods by who lives there)
- If the caption mentions specific numbers (price, sq ft, rates), you MAY reference them
- Focus on: property features, lifestyle benefits, neighborhood character, investment potential
- Make the viewer feel like they're getting insider knowledge from a trusted advisor

STRUCTURE:
- Open with a hook that stops the scroll (first 2-3 seconds are critical)
- Build through the middle with property/area details
- End with a soft CTA (vary between: "follow for more", "comment below", "DM me", "drop a comment", "save this for later")

SENTENCE ENDINGS — CRITICAL FOR NATURAL SOUND:
- NEVER end a sentence on a single low-energy word (like "today" or "home" or "here") — it makes TTS drop to a flat robotic tone
- End sentences with 2-3 word phrases that carry energy forward ("starting in the high threes" not "starting today")
- Use questions, exclamations, or upward-energy phrases to keep momentum
- Vary sentence endings: some short punchy ("Let's go."), some flowing ("and this is just the beginning.")
- The LAST sentence should feel like an invitation, not a statement trailing off

FORMAT — THIS IS CRITICAL:
- Output ONLY the exact words to be spoken. Nothing else.
- NO brackets of any kind: no [excited], no [pause], no [warm], no [confident]
- NO parenthetical directions like (enthusiastically) or (softly)
- NO stage directions, NO emotion labels, NO action words like "smile" or "nod"
- NO quotation marks around the script
- NO line numbers, bullet points, or timestamps
- Write as one continuous paragraph of spoken words only`;

  const userPrompt = `Write a voiceover script for a ${cityLabel} property video.

VIDEO DURATION: ${effectiveDuration} seconds (the video is ${input.videoDurationSec}s total but the voice should finish 5 seconds before the end)
TARGET WORD COUNT: ${targetWordCount} words (minimum ${minWords}, maximum ${maxWords})
AUDIO TYPE: ${input.audioType === "speech" ? "Original video has someone talking — voiceover will replace their audio entirely" : "Original video has music/ambient audio — voiceover will be layered on top with the music ducked"}

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

    console.log(`[VoScript] Attempt ${attempt + 1}: ${wordCount} words (target: ${targetWordCount}, min: ${minWords})`);

    if (wordCount >= minWords) break;
  }

  const estimatedDurationSec = Math.round(wordCount / WORDS_PER_SECOND_TARGET);

  return {
    script,
    wordCount,
    estimatedDurationSec,
    wordsPerSecond: wordCount / effectiveDuration,
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
