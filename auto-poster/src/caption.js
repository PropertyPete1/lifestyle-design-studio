/**
 * Caption Generation — uses Anthropic Claude API
 */

import Anthropic from "@anthropic-ai/sdk";
import { sanitizeCaption } from "./sanitize.js";

let client = null;

function getClient() {
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

const CITY_NAMES = {
  austin: "Austin",
  san_antonio: "San Antonio",
  dallas: "Dallas / DFW",
};

/**
 * Generate a fresh real-estate caption for a video.
 * 
 * Structure:
 * 1. Hook (curiosity line, under 100 chars — drives watch time)
 * 2. Scarcity/story line
 * 3. Feature block with emoji bullets (NO fabricated prices or specific bed/bath counts)
 * 4. Who it's for
 * 5. Primary CTA (comment TOUR)
 * 6. Secondary CTA (DM LIST)
 * 7. Link in bio (demoted to end)
 * 8. Lifestyle Design Realty
 * 9. Hashtags
 */
export async function generateCaption(city) {
  const cityName = CITY_NAMES[city] || city;
  const hashtag = city === "san_antonio" ? "sanantonio" : city === "dallas" ? "dallas" : "austin";

  const prompt = `Write an Instagram Reel caption for a real estate video showcasing a brand new construction home in ${cityName}, Texas.

STRUCTURE (follow this EXACT order):

1. HOOK (first line, under 100 chars): A curiosity line that makes people stop scrolling and keep watching. Vary the style — use one of these approaches randomly:
   - Question: "would you believe this is brand new construction in ${cityName}?"
   - Bold claim: "this might be the best new build I've toured this month"
   - "Wait for it" tease: "wait until you see the kitchen in this one 😮‍💨"
   - Reaction: "the floor plan in this one made me stop mid-tour"
   - Vibe: "this is what new construction is supposed to feel like"
   NEVER start with a CTA or "fill out link in bio". The hook must create curiosity.

2. One short scarcity/story line (e.g. "new construction like this doesn't sit long in ${cityName}" or "builders are offering wild incentives right now")

3. Feature block with emoji bullets. Describe what you'd SEE in a new construction tour:
   🏡 new construction / modern finishes / smart layout
   🪟 natural light / open concept / big windows
   🍳 chef's kitchen / island / upgraded counters
   🔥 energy efficient / move-in ready
   💸 builder incentives / rate buydowns available, ask what you qualify for
   
   IMPORTANT: Do NOT invent specific prices, bedroom counts, or bathroom counts. You don't know the actual specs of this home. Keep features general but vivid.

4. One line on who it's perfect for: "perfect for growing families, military/veteran buyers, or anyone ready to stop renting"

5. PRIMARY CTA: "📲 comment TOUR and I will DM you exact payments, incentives and private tour times"

6. SECONDARY: "📩 or DM LIST for every similar option in ${cityName}"

7. LAST content line (low-key): "⭐️ link in bio to get started with us today"

8. "Lifestyle Design Realty" on its own line

9. Hashtags: #texas #${hashtag} #realestate #military #veteran #newconstruction

RULES:
- Under 2000 characters total
- Line breaks between each section
- Natural excited tone, like a real person posting
- DO NOT use markdown formatting (no bold, no headers)
- DO NOT fabricate specific dollar amounts, bedroom counts, or square footage
- Do NOT use em-dashes or en-dashes (— or –). Use periods, commas, or line breaks instead. This is important; dashes read as AI-written.
- Return ONLY the caption text, nothing else`;

  try {
    const response = await getClient().messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });

    const content = response.content[0]?.text;
    if (content && content.length > 50) {
      console.log(`[Caption] Generated (${content.length} chars)`);
      return sanitizeCaption(content);
    }
  } catch (err) {
    console.error("[Caption] Anthropic API failed:", err.message);
  }

  // Fallback caption if API fails
  return getFallbackCaption(city);
}

/**
 * Generate a voiceover script for a video.
 */
export async function generateVoiceoverScript(city, videoDurationSec = 30) {
  const cityName = CITY_NAMES[city] || city;
  const targetWords = Math.floor(videoDurationSec * 2.2); // ~2.2 words/sec for natural pace

  const prompt = `Write a short voiceover script for a real estate video tour of a brand new home in ${cityName}, Texas.

RULES:
- Maximum ${targetWords} words (MUST be shorter than ${videoDurationSec} seconds when spoken)
- Sound like a friendly, excited real estate agent giving a tour
- Mention the city name naturally
- Highlight features: open floor plan, natural light, modern finishes, spacious bedrooms
- End with a soft call to action like "comment below if you want to see more"
- DO NOT mention specific prices or addresses
- DO NOT use hashtags or emojis
- Keep it conversational and engaging
- Do NOT use em-dashes or en-dashes (— or –). Use periods, commas, or line breaks instead. This is important; dashes read as AI-written.
- Return ONLY the script text, nothing else

Example tone: "Oh my gosh, look at this brand new home in San Antonio. The natural light coming through these windows is incredible. You've got this gorgeous open concept layout..."`;

  try {
    const response = await getClient().messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });

    const content = response.content[0]?.text;
    if (content && content.length > 30) {
      console.log(`[VoiceoverScript] Generated (${content.length} chars, ~${content.split(/\s+/).length} words)`);
      return sanitizeCaption(content);
    }
  } catch (err) {
    console.error("[VoiceoverScript] Anthropic API failed:", err.message);
  }

  // Fallback script
  return getFallbackScript(city);
}

/**
 * Generate a caption by restructuring the original IG caption.
 * Preserves the real price, bed/bath, and features from the original post
 * but restructures for the new engagement format (hook first, CTA at end).
 */
export async function generateCaptionFromOriginal(originalCaption, city) {
  const cityName = CITY_NAMES[city] || city;
  const hashtag = city === "san_antonio" ? "sanantonio" : city === "dallas" ? "dallas" : "austin";

  const prompt = `You are given the original Instagram caption from a real estate video post. Your job is to RESTRUCTURE it into a new caption that follows the engagement-optimized format below.

IMPORTANT: Preserve ALL factual details from the original (price, bedrooms, bathrooms, square footage, features, community name). Do NOT invent new details. Only restructure the format and rewrite the hook.

ORIGINAL CAPTION:
${originalCaption}

NEW STRUCTURE (follow this EXACT order):

1. HOOK (first line, under 100 chars): A curiosity line that references something specific from the original caption. Use the real price or a standout feature. Examples:
   - "wait until you see what $389K gets you in ${cityName} right now"
   - "the kitchen in this $450K new build is unreal 😮‍💨"
   - "4 beds, 3 baths, and THAT backyard for under $400K?"
   NEVER start with a CTA. The hook must create curiosity using REAL details from the original.

2. One short scarcity/story line (e.g. "new construction like this doesn't sit long" or reference builder incentives if mentioned in original)

3. Feature block with emoji bullets. Pull the REAL specs from the original caption:
   🏡 [beds] / [baths] / [sqft if mentioned]
   💰 [REAL price from original]
   🪟 [real features mentioned: natural light, open concept, etc.]
   🍳 [kitchen details if mentioned]
   💸 [financing/incentives if mentioned in original]

4. One line on who it's perfect for (growing families, military/veteran buyers, first-time buyers)

5. PRIMARY CTA: "📲 comment TOUR and I will DM you exact payments, incentives and private tour times"

6. SECONDARY: "📩 or DM LIST for every similar option in ${cityName}"

7. LAST content line: "⭐️ link in bio to get started with us today"

8. "Lifestyle Design Realty" on its own line

9. Hashtags: #texas #${hashtag} #realestate #military #veteran #newconstruction

RULES:
- Under 2000 characters total
- Line breaks between each section
- Natural excited tone
- DO NOT use markdown formatting
- DO NOT invent details not in the original. If price isn't mentioned, don't add one
- Do NOT use em-dashes or en-dashes (— or –). Use periods, commas, or line breaks instead. This is important; dashes read as AI-written.
- Return ONLY the caption text, nothing else`;

  try {
    const response = await getClient().messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });

    const content = response.content[0]?.text;
    if (content && content.length > 50) {
      console.log(`[Caption] Restructured from original (${content.length} chars)`);
      return sanitizeCaption(content);
    }
  } catch (err) {
    console.error("[Caption] Anthropic API failed for restructure:", err.message);
  }

  // Fallback: use original caption as-is if restructuring fails (still sanitize it)
  console.log("[Caption] Falling back to original caption");
  return sanitizeCaption(originalCaption);
}

function getFallbackCaption(city) {
  const cityName = CITY_NAMES[city] || city;
  const hashtag = city === "san_antonio" ? "sanantonio" : city === "dallas" ? "dallas" : "austin";

  return `the kitchen in this one made me stop mid-tour 😮‍💨

new construction like this doesn't sit long in ${cityName}

🏡 brand new build with modern finishes and a smart open layout
🪟 huge windows and natural light flooding every room
🍳 chef's kitchen with island and upgraded counters
🔥 energy efficient and move-in ready
💸 builder incentives and rate buydowns available. ask what you qualify for

perfect for growing families, military/veteran buyers, or anyone ready to stop renting

📲 comment TOUR and I will DM you exact payments, incentives and private tour times

📩 or DM LIST for every similar option in ${cityName}

⭐️ link in bio to get started with us today

Lifestyle Design Realty

#texas #${hashtag} #realestate #military #veteran #newconstruction`;
}

function getFallbackScript(city) {
  const cityName = CITY_NAMES[city] || city;
  return `Look at this brand new home in ${cityName}. The natural light coming through these windows is incredible. You have this gorgeous open concept layout with modern finishes throughout. The kitchen flows right into the living space, perfect for entertaining. And these bedrooms are so spacious. If you want to see more homes like this, comment below and I will send you everything available.`;
}
