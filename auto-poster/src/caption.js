/**
 * Caption Generation — uses Anthropic Claude API
 * 
 * Format: themed sections with lowercase punchy sub-headers,
 * emoji-bulleted specifics, conversational personality.
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { sanitizeCaption, sanitizeForTTS } from "./sanitize.js";
import { pickHookStyle, loadWeights } from "./analytics.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
 * Load community knowledge base.
 */
let communitiesCache = null;
export function loadCommunities() {
  if (communitiesCache) return communitiesCache;
  const path = join(__dirname, "..", "communities.json");
  if (!existsSync(path)) {
    communitiesCache = {};
    return communitiesCache;
  }
  try {
    communitiesCache = JSON.parse(readFileSync(path, "utf-8"));
    console.log(`[Caption] Loaded ${Object.keys(communitiesCache).length} communities from KB`);
  } catch (err) {
    console.warn("[Caption] Failed to load communities.json:", err.message);
    communitiesCache = {};
  }
  return communitiesCache;
}

/**
 * Look up a community by name (fuzzy match).
 */
export function findCommunity(communityName, city) {
  if (!communityName) return null;
  const kb = loadCommunities();
  const needle = communityName.toLowerCase().trim();
  for (const [name, data] of Object.entries(kb)) {
    if (name.toLowerCase() === needle) return { name, ...data };
  }
  for (const [name, data] of Object.entries(kb)) {
    const lower = name.toLowerCase();
    if (needle.includes(lower) || lower.includes(needle)) {
      if (city && data.city && !data.city.toLowerCase().includes(city.toLowerCase())) continue;
      return { name, ...data };
    }
  }
  return null;
}

/**
 * Get a hook style instruction based on performance weights.
 */
function getHookInstruction(cityName) {
  const style = pickHookStyle();
  const instructions = {
    question: `Write a QUESTION hook. Example: "would you believe this is brand new construction in ${cityName}?" or "did you know you can get a brand new home in ${cityName} for less than rent?"`,
    bold_claim: `Write a BOLD CLAIM hook. Example: "this might be the best new build I've toured this month" or "I've never seen finishes like this at this price point"`,
    wait_tease: `Write a "WAIT FOR IT" TEASE hook. Example: "wait until you see the kitchen in this one 😮‍💨" or "you need to see what's behind this front door"`,
    reaction: `Write a REACTION hook. Example: "the floor plan in this one made me stop mid-tour" or "I was speechless when I walked in"`,
    vibe: `Write a VIBE hook. Example: "this is what new construction is supposed to feel like" or "the energy in this home is unmatched"`,
  };
  console.log(`[Caption] Using hook style: ${style} (weighted selection)`);
  return instructions[style] || instructions.question;
}

/**
 * Build a community facts block for the prompt (when KB match found).
 */
function buildCommunityFactsBlock(community) {
  if (!community) return "";
  const lines = [`\nCOMMUNITY KNOWLEDGE BASE MATCH: "${community.name}"`];
  lines.push("Use these REAL facts in the themed sections (never invent beyond these):");
  if (community.price_range) lines.push(`- Price range: ${community.price_range}`);
  if (community.beds_baths_range) lines.push(`- Beds/baths: ${community.beds_baths_range}`);
  if (community.sqft_range) lines.push(`- Sqft range: ${community.sqft_range}`);
  if (community.school_district) lines.push(`- School district: ${community.school_district}`);
  if (community.hoa) lines.push(`- HOA: ${community.hoa}`);
  if (community.amenities && community.amenities.length > 0) {
    lines.push(`- Amenities: ${community.amenities.join(", ")}`);
  }
  if (community.incentives) lines.push(`- Incentives: ${community.incentives}`);
  if (community.lot_size) lines.push(`- Lot size: ${community.lot_size}`);
  if (community.notes) lines.push(`- Notes: ${community.notes}`);
  return lines.join("\n");
}

const THEMED_SECTIONS_FORMAT = `
BODY FORMAT — use these themed sections with lowercase punchy sub-headers:

✨ everyday living hits
(interior features: layout, kitchen, natural light, finishes, floor plans, sqft ranges. Use emoji bullets for each specific fact.)

🌳 amenity energy you will actually use
(community amenities: pools, trails, parks, fitness, playgrounds, dog parks. Be specific with names and sizes if known.)

🎓 school and numbers
(school district name, HOA amount, tax rate if known. Always add "confirm per address before writing the offer")

💸 buyer wins
(financing options, incentives, VA/FHA/USDA eligibility, rate buydowns, closing cost help)

STYLE RULES:
- Each section starts with the emoji + lowercase sub-header on its own line
- Under each header: emoji-bulleted specifics (one fact per line)
- Personality phrases like "go cozy or go roomy" or "the payment actually makes sense"
- Conversational, specific, never corporate
- Ranges are great ("from about $455,990 to $591,990 with 3 to 4 bedrooms")
- Skip any section where you have zero facts for it (don't pad with generic filler)
`;

const CAPTION_RULES = `
RULES:
- Target 1,500-2,000 characters total (information-dense, not thin)
- Line breaks between each section
- Natural excited tone, like a real person posting who genuinely loves these homes
- DO NOT use markdown formatting (no bold, no headers, no asterisks)
- Do NOT use em-dashes or en-dashes (— or –). Use periods, commas, or line breaks instead
- NEVER invent facts. Only use what's provided (original caption, community KB, or video overlays)
- Return ONLY the caption text, nothing else
`;

/**
 * Generate a fresh real-estate caption for a video.
 * Uses community KB if a match is found from video overlays.
 */
export async function generateCaption(city, videoOverlays = null) {
  const cityName = CITY_NAMES[city] || city;
  const hashtag = city === "san_antonio" ? "sanantonio" : city === "dallas" ? "dallas" : "austin";

  let community = null;
  if (videoOverlays?.community) {
    community = findCommunity(videoOverlays.community, cityName);
  }

  const communityBlock = buildCommunityFactsBlock(community);
  const hasRealFacts = !!community;

  const prompt = `Write an Instagram Reel caption for a real estate video showcasing a brand new construction home in ${cityName}, Texas.
${communityBlock}
${videoOverlays?.price ? `VIDEO SHOWS PRICE: ${videoOverlays.price}` : ""}
${videoOverlays?.beds_baths ? `VIDEO SHOWS: ${videoOverlays.beds_baths}` : ""}

STRUCTURE (follow this EXACT order):

1. HOOK (first line, under 100 chars): A curiosity line that makes people stop scrolling.
   ${getHookInstruction(cityName)}
   ${hasRealFacts ? `USE a real detail from the community KB in the hook (price, standout amenity, etc.)` : ""}
   NEVER start with a CTA. The hook must create curiosity.

2. One short scarcity/story line (e.g. "new construction like this doesn't sit long" or reference builder incentives if known)

${THEMED_SECTIONS_FORMAT}

AFTER THE BODY:
- One line on who it's perfect for: "perfect for growing families, military/veteran buyers, or anyone ready to stop renting"
- PRIMARY CTA: "📲 comment TOUR and I will DM you exact payments, incentives and private tour times"
- SECONDARY: "📩 or DM LIST for every similar option in ${cityName}"
- LAST content line: "⭐️ link in bio to get started with us today"
- "Lifestyle Design Realty" on its own line
- Hashtags: #texas #${hashtag} #realestate #military #veteran #newconstruction

${hasRealFacts ? "" : "IMPORTANT: You do NOT have specific facts for this home. Keep features general but vivid. Do NOT invent specific prices, bedroom counts, or square footage."}
${CAPTION_RULES}`;

  try {
    const response = await getClient().messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    });
    const content = response.content[0]?.text;
    if (content && content.length > 50) {
      console.log(`[Caption] Generated fresh caption (${content.length} chars, community=${community?.name || "none"})`);
      return sanitizeCaption(content);
    }
  } catch (err) {
    console.error("[Caption] Anthropic API failed:", err.message);
  }
  return getFallbackCaption(city);
}

/**
 * Generate a voiceover script for a video.
 * Script should be shorter than video duration to ensure natural ending.
 */
export async function generateVoiceoverScript(city, videoDurationSec = 30) {
  const cityName = CITY_NAMES[city] || city;
  const targetWords = Math.floor(videoDurationSec * 2.2);

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
- Do NOT use em-dashes or en-dashes. Use periods, commas, or line breaks instead.
- Spell out ALL numbers as words. Never use digits. "three bedrooms" not "3 bedrooms", "two and a half baths" not "2.5 baths". Also spell out abbreviations that TTS mangles: "square feet" not "sqft", "street" not "st".
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
      return sanitizeForTTS(sanitizeCaption(content));
    }
  } catch (err) {
    console.error("[VoiceoverScript] Anthropic API failed:", err.message);
  }
  return getFallbackScript(city);
}

/**
 * Generate a caption by restructuring the original IG caption.
 * PRESERVES every specific fact from the original. Restructures, never summarizes.
 * A 1,800-char rich caption should stay ~1,800 chars, just better ordered.
 */
export async function generateCaptionFromOriginal(originalCaption, city) {
  const cityName = CITY_NAMES[city] || city;
  const hashtag = city === "san_antonio" ? "sanantonio" : city === "dallas" ? "dallas" : "austin";

  const prompt = `You are given the original Instagram caption from a real estate video post. Your job is to RESTRUCTURE it into the themed-section format below.

CRITICAL RULE: Keep EVERY specific fact from the original (amenity names, school district, HOA amount, sqft ranges, community name, price, beds/baths, lot sizes, tax rates, specific incentive details). Do NOT summarize or compress. A 1,800-character rich caption should stay approximately 1,800 characters. You are REORGANIZING facts into better sections, not reducing them.

ORIGINAL CAPTION:
${originalCaption}

NEW STRUCTURE (follow this EXACT order):

1. HOOK (first line, under 100 chars): A curiosity line that references something specific from the original.
   USE THIS SPECIFIC HOOK STYLE: ${getHookInstruction(cityName)}
   Use the real price or a standout feature from the original. NEVER start with a CTA.

2. One short scarcity/story line (reference builder incentives or timing if mentioned in original)

${THEMED_SECTIONS_FORMAT}

AFTER THE BODY:
- One line on who it's perfect for (growing families, military/veteran buyers, first-time buyers)
- PRIMARY CTA: "📲 comment TOUR and I will DM you exact payments, incentives and private tour times"
- SECONDARY: "📩 or DM LIST for every similar option in ${cityName}"
- LAST content line: "⭐️ link in bio to get started with us today"
- "Lifestyle Design Realty" on its own line
- Hashtags: #texas #${hashtag} #realestate #military #veteran #newconstruction

PRESERVATION CHECKLIST — verify ALL of these from the original appear in your output:
- Every price mentioned (exact dollar amounts, ranges, "from the $Xs")
- Every bed/bath/sqft number
- Community/subdivision name if mentioned
- School district name
- HOA amount
- Tax rate if mentioned
- Every specific amenity (pool sizes, trail lengths, park names, etc.)
- Every financing detail (VA/FHA/USDA, rate buydowns, specific % rates)
- Every location detail (nearby landmarks, roads, lakes)

If any fact from the original is missing in your output, you have failed the task.
${CAPTION_RULES}`;

  try {
    const response = await getClient().messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });
    const content = response.content[0]?.text;
    if (content && content.length > 50) {
      console.log(`[Caption] Restructured from original (${content.length} chars, original was ${originalCaption.length} chars)`);
      return sanitizeCaption(content);
    }
  } catch (err) {
    console.error("[Caption] Anthropic API failed for restructure:", err.message);
  }
  console.log("[Caption] Falling back to original caption");
  return sanitizeCaption(originalCaption);
}

function getFallbackCaption(city) {
  const cityName = CITY_NAMES[city] || city;
  const hashtag = city === "san_antonio" ? "sanantonio" : city === "dallas" ? "dallas" : "austin";
  return `the kitchen in this one made me stop mid-tour 😮‍💨

new construction like this doesn't sit long in ${cityName}

✨ everyday living hits
🏡 brand new build with modern finishes and a smart open layout
🪟 huge windows and natural light flooding every room
🍳 chef's kitchen with island and upgraded counters
🔥 energy efficient and move-in ready

🌳 amenity energy you will actually use
🏊 community pool and green spaces for weekend resets
🛝 playgrounds and trails right outside your door

💸 buyer wins
✅ builder incentives and rate buydowns available. ask what you qualify for
⚡ VA FHA and conventional friendly with fast pre approvals

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
