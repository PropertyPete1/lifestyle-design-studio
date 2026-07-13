/**
 * Caption Generation — uses Anthropic Claude API
 * 
 * Format: themed sections with lowercase punchy sub-headers,
 * emoji-bulleted specifics, conversational personality.
 * 
 * LEAD-GATING: Captions tease but never reveal searchable details
 * (community names, builder names, branded amenity names).
 * The DM/comment CTA delivers what was withheld.
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
 * Facts are provided for CONTENT but community/builder/branded names are GATED.
 */
function buildCommunityFactsBlock(community) {
  if (!community) return "";
  const lines = [`\nCOMMUNITY KNOWLEDGE BASE MATCH (INTERNAL ONLY — name is GATED, do NOT include it):`];
  lines.push("Use these REAL facts in the themed sections (never invent beyond these):");
  if (community.price_range) lines.push(`- Price range: ${community.price_range}`);
  if (community.beds_baths_range) lines.push(`- Beds/baths: ${community.beds_baths_range}`);
  if (community.sqft_range) lines.push(`- Sqft range: ${community.sqft_range}`);
  if (community.school_district) lines.push(`- School district: ${community.school_district}`);
  if (community.hoa) lines.push(`- HOA: ${community.hoa}`);
  if (community.amenities && community.amenities.length > 0) {
    lines.push(`- Amenities (describe generically, NO branded names): ${community.amenities.join(", ")}`);
  }
  if (community.incentives) lines.push(`- Incentives: ${community.incentives}`);
  if (community.lot_size) lines.push(`- Lot size: ${community.lot_size}`);
  if (community.notes) lines.push(`- Notes: ${community.notes}`);
  return lines.join("\n");
}

/**
 * LEAD-GATING RULES — included in every caption prompt.
 */
const LEAD_GATING_RULES = `
LEAD-GATING RULES (CRITICAL — violating these ruins the business model):

NEVER include in the caption:
1. Community/subdivision names (no "Esperanza", "Rancho Sienna", "Travisso", "Walsh Ranch", "Ventana", etc.)
2. Builder names or "X different builders" phrasing that invites builder-shopping
3. Branded/googleable amenity names ("Roca Loca", "Happy's Splash Park", "The Club at Esperanza", "Wellness Barn", "Ranch Camp", "Palazzo Clubhouse", "The Forum", "Rover Oaks Bark Parque", "Reunión Parque") — describe them GENERICALLY instead:
   - "Roca Loca Beach" → "a sand volleyball beach"
   - "The Club (11-acre amenity center)" → "an 11-acre resort-style amenity club"
   - "Wellness Barn" → "a two-story fitness barn"
   - "Palazzo Clubhouse" → "a 9-acre clubhouse with resort pool"
   - "Ranch Camp" → "kids adventure camp"
4. Street/section names or anything uniquely searchable that identifies the specific community

KEEP in captions (the desire-builders):
- City/area level location ("in Boerne", "northwest San Antonio", "near Leander")
- Price ranges, beds/baths, sqft ranges (these create desire)
- School district name and rating (big draw, doesn't identify the specific community alone)
- HOA/tax ballparks with "confirm per address"
- Vivid but GENERIC amenity descriptions (sizes, features, but no proper nouns)
- Financing options (VA/FHA/USDA, rate buydowns)

THE GATE IS THE CTA: The caption teases, the DM delivers. The comment CTA must explicitly offer what was withheld.
`;

const THEMED_SECTIONS_FORMAT = `
BODY FORMAT — use these themed sections with lowercase punchy sub-headers:

✨ everyday living hits
(interior features: layout, kitchen, natural light, finishes, floor plans, sqft ranges. Use emoji bullets for each specific fact.)

🌳 amenity energy you will actually use
(community amenities: pools, trails, parks, fitness, playgrounds, dog parks. Be SPECIFIC with sizes and features but use GENERIC descriptions, never branded names.)

🎓 school and numbers
(school district name and rating, HOA amount, tax rate if known. Always add "confirm per address before writing the offer")

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
 * Build the list of gated terms from the KB for post-generation scanning.
 * Returns an array of { term, type } objects.
 */
function buildGatedTerms(community) {
  const terms = [];
  const kb = loadCommunities();

  // Always gate ALL community names from the entire KB
  for (const name of Object.keys(kb)) {
    terms.push({ term: name, type: "community_name" });
  }

  // Gate branded amenity names from the matched community
  if (community?.amenities) {
    for (const amenity of community.amenities) {
      // Extract proper nouns / branded names from amenity strings
      const brandedPatterns = [
        /^([A-Z][a-zA-Z\s']+(?:at\s[A-Z][a-zA-Z\s]+)?)\s*\(/,  // "The Club (11-acre..." → "The Club"
        /^([A-Z][a-zA-Z\s']+)\s*$/,  // standalone proper noun amenity
      ];
      for (const pat of brandedPatterns) {
        const m = amenity.match(pat);
        if (m && m[1].length > 4) {
          terms.push({ term: m[1].trim(), type: "branded_amenity" });
        }
      }
    }
  }

  // Also gate specific known branded names across all communities
  const knownBranded = [
    "Wellness Barn", "Ranch Camp", "Roca Loca", "The Club at Esperanza",
    "The Club", "Palazzo Clubhouse", "The Forum", "Rover Oaks",
    "Bark Parque", "Reunión Parque", "Roca Loca Lawn", "Roca Loca Beach",
    "Roca Loca Forest", "Happy's Splash Park", "Dr. Herff Elementary"
  ];
  for (const name of knownBranded) {
    terms.push({ term: name, type: "branded_amenity" });
  }

  // Gate builder names from notes
  const knownBuilders = [
    "KB Home", "Chesmar", "Scott Felder", "Perry Homes", "Highland Homes",
    "Weston Dean", "Taylor Morrison", "Toll Brothers", "Meritage", "Lennar",
    "DR Horton", "D.R. Horton", "Pulte", "Ashton Woods", "Trendmaker"
  ];
  for (const name of knownBuilders) {
    terms.push({ term: name, type: "builder_name" });
  }

  // Deduplicate
  const seen = new Set();
  return terms.filter(t => {
    const key = t.term.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Post-generation leak scanner.
 * Checks the generated caption against gated terms and strips any leaks.
 * Returns { caption, leaksFound, leakDetails }.
 */
function scanAndStripLeaks(caption, community) {
  const gatedTerms = buildGatedTerms(community);
  const leakDetails = [];

  let cleaned = caption;
  for (const { term, type } of gatedTerms) {
    // Case-insensitive search
    const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    if (regex.test(cleaned)) {
      leakDetails.push({ term, type });
      // Replace with generic alternatives based on type
      if (type === "community_name") {
        cleaned = cleaned.replace(regex, "this community");
      } else if (type === "builder_name") {
        cleaned = cleaned.replace(regex, "the builder");
      } else if (type === "branded_amenity") {
        cleaned = cleaned.replace(regex, "the amenity center");
      }
    }
  }

  // Also check for "X builders" or "X different builders" patterns
  const builderCountPattern = /\b\d+\s+(different\s+)?builders?\b/gi;
  if (builderCountPattern.test(cleaned)) {
    leakDetails.push({ term: "builder count", type: "builder_shopping" });
    cleaned = cleaned.replace(builderCountPattern, "multiple floor plan options");
  }

  return {
    caption: cleaned,
    leaksFound: leakDetails.length,
    leakDetails,
  };
}

/**
 * Generate a fresh real-estate caption for a video.
 * Uses community KB if a match is found from video overlays.
 * Applies lead-gating rules to withhold searchable details.
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

${LEAD_GATING_RULES}

STRUCTURE (follow this EXACT order):

1. HOOK (first line, under 100 chars): A curiosity line that makes people stop scrolling.
   ${getHookInstruction(cityName)}
   ${hasRealFacts ? `USE a real detail from the community KB in the hook (price, standout amenity description, etc.) but NEVER the community name.` : ""}
   NEVER start with a CTA. The hook must create curiosity.

2. One short scarcity/story line (e.g. "new construction like this doesn't sit long" or reference builder incentives if known)

${THEMED_SECTIONS_FORMAT}

AFTER THE BODY:
- One line on who it's perfect for: "perfect for growing families, military/veteran buyers, or anyone ready to stop renting"
- PRIMARY CTA: "📲 comment TOUR and I'll DM you the community name, builder lineup, exact pricing and tour times"
- SECONDARY: "📩 or DM LIST for every similar option in ${cityName}"
- LAST content line: "⭐️ link in bio to get started with us today"
- "Lifestyle Design Realty" on its own line
- Hashtags: #texas #${hashtag} #realestate #military #veteran #newconstruction

${hasRealFacts ? "" : "IMPORTANT: You do NOT have specific facts for this home. Keep features general but vivid. Do NOT invent specific prices, bedroom counts, or square footage unless the video overlay shows them."}
${CAPTION_RULES}`;

  try {
    const response = await getClient().messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    });
    const content = response.content[0]?.text;
    if (content && content.length > 50) {
      // Post-generation leak scan
      const { caption: gatedCaption, leaksFound, leakDetails } = scanAndStripLeaks(content, community);
      if (leaksFound > 0) {
        console.log(`[Caption] LEAK SCANNER: stripped ${leaksFound} gated terms: ${leakDetails.map(l => `"${l.term}" (${l.type})`).join(", ")}`);
      }
      console.log(`[Caption] Generated fresh caption (${gatedCaption.length} chars, community=${community?.name || "none"}, leaks_stripped=${leaksFound})`);
      return sanitizeCaption(gatedCaption);
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
- DO NOT mention specific prices, addresses, community names, or builder names
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
 * Applies lead-gating: strips community names, builder names, branded amenities.
 */
export async function generateCaptionFromOriginal(originalCaption, city) {
  const cityName = CITY_NAMES[city] || city;
  const hashtag = city === "san_antonio" ? "sanantonio" : city === "dallas" ? "dallas" : "austin";

  const prompt = `You are given the original Instagram caption from a real estate video post. Your job is to RESTRUCTURE it into the themed-section format below.

CRITICAL RULE: Keep EVERY specific fact from the original (school district, HOA amount, sqft ranges, price, beds/baths, lot sizes, tax rates, specific incentive details, financing options). Do NOT summarize or compress. A 1,800-character rich caption should stay approximately 1,800 characters. You are REORGANIZING facts into better sections, not reducing them.

${LEAD_GATING_RULES}

IMPORTANT FOR RESTRUCTURING: The original caption may contain community names, builder names, or branded amenity names. You MUST:
- REMOVE all community/subdivision names and replace with area-level location ("in Boerne", "northwest San Antonio")
- REMOVE all builder names and "X builders" phrasing
- CONVERT all branded amenity names to generic vivid descriptions (keep the SIZE and FEATURES, drop the proper noun)
- KEEP everything else: prices, sqft, beds/baths, school districts, HOA, financing, amenity descriptions

ORIGINAL CAPTION:
${originalCaption}

NEW STRUCTURE (follow this EXACT order):

1. HOOK (first line, under 100 chars): A curiosity line that references something specific from the original.
   USE THIS SPECIFIC HOOK STYLE: ${getHookInstruction(cityName)}
   Use the real price or a standout feature from the original. NEVER start with a CTA. NEVER include the community name.

2. One short scarcity/story line (reference builder incentives or timing if mentioned in original)

${THEMED_SECTIONS_FORMAT}

AFTER THE BODY:
- One line on who it's perfect for (growing families, military/veteran buyers, first-time buyers)
- PRIMARY CTA: "📲 comment TOUR and I'll DM you the community name, builder lineup, exact pricing and tour times"
- SECONDARY: "📩 or DM LIST for every similar option in ${cityName}"
- LAST content line: "⭐️ link in bio to get started with us today"
- "Lifestyle Design Realty" on its own line
- Hashtags: #texas #${hashtag} #realestate #military #veteran #newconstruction

PRESERVATION CHECKLIST — verify ALL of these from the original appear in your output (EXCEPT gated names):
- Every price mentioned (exact dollar amounts, ranges, "from the $Xs")
- Every bed/bath/sqft number
- School district name (KEEP — doesn't identify community alone)
- HOA amount
- Tax rate if mentioned
- Every specific amenity DESCRIPTION (sizes, features — but NOT the branded name)
- Every financing detail (VA/FHA/USDA, rate buydowns, specific % rates)
- Every location detail at city/area level

If any FACT (not name) from the original is missing in your output, you have failed the task.
${CAPTION_RULES}`;

  try {
    const response = await getClient().messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });
    const content = response.content[0]?.text;
    if (content && content.length > 50) {
      // Post-generation leak scan (check against ALL KB communities)
      const { caption: gatedCaption, leaksFound, leakDetails } = scanAndStripLeaks(content, null);
      if (leaksFound > 0) {
        console.log(`[Caption] LEAK SCANNER (restructure): stripped ${leaksFound} gated terms: ${leakDetails.map(l => `"${l.term}" (${l.type})`).join(", ")}`);
      }
      console.log(`[Caption] Restructured from original (${gatedCaption.length} chars, original was ${originalCaption.length} chars, leaks_stripped=${leaksFound})`);
      return sanitizeCaption(gatedCaption);
    }
  } catch (err) {
    console.error("[Caption] Anthropic API failed for restructure:", err.message);
  }
  // Fallback: strip leaks from original and return it
  console.log("[Caption] Falling back to original caption (leak-scanned)");
  const { caption: gatedOriginal } = scanAndStripLeaks(originalCaption, null);
  return sanitizeCaption(gatedOriginal);
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

📲 comment TOUR and I'll DM you the community name, builder lineup, exact pricing and tour times
📩 or DM LIST for every similar option in ${cityName}
⭐️ link in bio to get started with us today

Lifestyle Design Realty
#texas #${hashtag} #realestate #military #veteran #newconstruction`;
}

function getFallbackScript(city) {
  const cityName = CITY_NAMES[city] || city;
  return `Look at this brand new home in ${cityName}. The natural light coming through these windows is incredible. You have this gorgeous open concept layout with modern finishes throughout. The kitchen flows right into the living space, perfect for entertaining. And these bedrooms are so spacious. If you want to see more homes like this, comment below and I will send you everything available.`;
}
