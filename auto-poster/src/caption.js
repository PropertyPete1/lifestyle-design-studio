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
import { validateCaption, RETRY_INSTRUCTION } from "./caption-validator.js";
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

const LOCKED_HASHTAGS = {
  austin: "#texas #austin #realestate #military #veteran #newconstruction",
  san_antonio: "#texas #sanantonio #realestate #military #veteran #newconstruction",
  dallas: "#texas #dallas #realestate #military #veteran #newconstruction",
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
- ALL prices MUST include the $ sign (e.g. "$389,900" not "389,900")
- ALL tax rates MUST include the % sign (e.g. "2.5%" not "2.5")
- Return ONLY the caption text, nothing else
- NEVER ask clarifying questions. NEVER say you need more information. If you lack specific details, use generic new-construction descriptions.
- You are NOT an assistant having a conversation. You are a caption generator. Your output IS the caption that will be published directly.
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
      const brandedPatterns = [
        /^([A-Z][a-zA-Z\s']+(?:at\s[A-Z][a-zA-Z\s]+)?)\s*\(/,
        /^([A-Z][a-zA-Z\s']+)\s*$/,
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
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${escaped}\\b`, "gi");
    if (regex.test(cleaned)) {
      leakDetails.push({ term, type });
      // Reset lastIndex after test() since we reuse the regex
      regex.lastIndex = 0;
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
 * Post-generation currency/rate formatting pass.
 * Ensures all prices have $ and all rates have %.
 */
function fixCurrencyFormatting(caption) {
  let fixed = caption;

  // Fix prices that are missing $ sign: bare numbers that look like prices (100,000+)
  // Pattern: standalone number with commas that's >= 100,000 without a preceding $
  fixed = fixed.replace(/(?<!\$)\b(\d{3},\d{3}(?:,\d{3})?)\b/g, (match, num) => {
    const val = parseInt(num.replace(/,/g, ""));
    if (val >= 100000) return `$${num}`;
    return match;
  });

  // Fix "starting at 389,900" → "starting at $389,900"
  fixed = fixed.replace(/(?:starting at|from|about|around)\s+(?!\$)(\d{3},\d{3})/gi, (match, num) => {
    return match.replace(num, `$${num}`);
  });

  // Fix tax rates missing %: only when number has a decimal point AND is near "tax"/"rate"/"MUD"
  // OR immediately follows "rate" within a few words. Never fire on "rate buydowns on 3 select homes".
  fixed = fixed.replace(/\b(?:tax\s*rate|MUD\s*(?:rate|district|tax))\s[^.]{0,30}?\b(\d+\.\d+)\b(?!%)/gi, (match, num) => {
    const val = parseFloat(num);
    if (val > 0 && val < 15) return match.replace(num, `${num}%`);
    return match;
  });
  // Also catch standalone decimal numbers immediately after "rate" (e.g. "rate around 2.5")
  fixed = fixed.replace(/\brate\s+(?:around|about|of|is|at)?\s*(\d+\.\d+)\b(?!%)/gi, (match, num) => {
    const val = parseFloat(num);
    if (val > 0 && val < 15) return match.replace(num, `${num}%`);
    return match;
  });

  return fixed;
}

/**
 * Lock hashtags: strip any LLM-generated hashtags and append the fixed set.
 */
function lockHashtags(caption, city) {
  // Remove any line that is purely hashtags (one or more), regardless of count
  const lines = caption.split("\n");
  const cleanedLines = lines.filter(line => {
    const stripped = line.trim();
    if (!stripped) return true; // keep blank lines
    // A line is "purely hashtags" if after removing all #word tokens, nothing meaningful remains
    const withoutHashtags = stripped.replace(/#\w+/g, "").trim();
    if (withoutHashtags === "" && stripped.includes("#")) return false;
    return true;
  });

  // Also remove trailing hashtags from the last content line
  let result = cleanedLines.join("\n").trimEnd();

  // Append locked hashtags
  const hashtags = LOCKED_HASHTAGS[city] || LOCKED_HASHTAGS.austin;
  result += `\n${hashtags}`;

  return result;
}

/**
 * Generate a fresh real-estate caption for a video.
 * Uses community KB if a match is found from video overlays.
 * Applies lead-gating rules to withhold searchable details.
 * 
 * When NO KB match: only states facts from the video overlay (price, city).
 * Does NOT invent amenities, HOA, school districts, or any other claims.
 */
export async function generateCaption(city, videoOverlays = null) {
  const cityName = CITY_NAMES[city] || city;

  let community = null;
  if (videoOverlays?.community) {
    community = findCommunity(videoOverlays.community, cityName);
  }

  const communityBlock = buildCommunityFactsBlock(community);
  const hasRealFacts = !!community;

  // Build the no-KB-match section instructions
  const noKBInstructions = hasRealFacts ? "" : `
CRITICAL — NO COMMUNITY KNOWLEDGE BASE MATCH:
You do NOT have verified facts for this community. You MUST NOT invent or assume:
- Amenities (no pools, trails, playgrounds, fitness centers unless the video overlay explicitly states them)
- HOA amounts or ranges
- School district names or ratings
- Tax rates
- Bed/bath counts (unless video overlay shows them)
- Square footage ranges

For the 🌳 amenity section: replace it with ONLY this line:
"🌳 want the full community rundown and today's available homes? comment TOUR"

For the 🎓 school and numbers section: replace it with ONLY this line:
"🎓 school ratings, HOA and taxes vary by address. I'll send exact numbers when you comment"

You MAY state:
- The price from the video overlay (if shown)
- The city/area from the video overlay
- Generic interior descriptions visible in any new construction (open floor plan, natural light, modern finishes) for the ✨ section ONLY
- Financing options (VA/FHA/USDA) since these are universally available for new construction
`;

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

${hasRealFacts ? THEMED_SECTIONS_FORMAT : `
BODY FORMAT — use these themed sections:

✨ everyday living hits
(ONLY generic interior features visible in any new build: open floor plan, natural light, modern finishes, kitchen island. Keep it short. Do NOT invent specific sqft, bed counts, or features not in the video overlay.)

🌳 want the full community rundown and today's available homes? comment TOUR

🎓 school ratings, HOA and taxes vary by address. I'll send exact numbers when you comment

💸 buyer wins
(ONLY universally true financing options: VA/FHA/USDA/conventional welcome, builder incentives available, rate buydowns. Do NOT invent specific incentive amounts.)
`}

AFTER THE BODY:
- One line on who it's perfect for: "perfect for growing families, military/veteran buyers, or anyone ready to stop renting"
- PRIMARY CTA: "📲 comment TOUR and I'll DM you today's available homes. pick your favorite and I'll send the full monthly payment breakdown on it"
- SECONDARY: "📩 or DM LIST for a custom lineup of every similar option plus a fast approval game plan"
- LAST content line: "⭐️ link in bio to get started with us today"
- "Lifestyle Design Realty" on its own line
- DO NOT include any hashtags. They will be added separately.

${noKBInstructions}
${CAPTION_RULES}`;

  // Attempt generation with validation gate (retry once on failure)
  for (let attempt = 1; attempt <= 2; attempt++) {
    const currentPrompt = attempt === 1 ? prompt : prompt + RETRY_INSTRUCTION;
    try {
      const response = await getClient().messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1500,
        messages: [{ role: "user", content: currentPrompt }],
      });
      const content = response.content[0]?.text;
      if (content && content.length > 50) {
        // Post-generation leak scan
        const { caption: gatedCaption, leaksFound, leakDetails } = scanAndStripLeaks(content, community);
        if (leaksFound > 0) {
          console.log(`[Caption] LEAK SCANNER: stripped ${leaksFound} gated terms: ${leakDetails.map(l => `"${l.term}" (${l.type})`).join(", ")}`);
        }
        // Currency formatting pass
        const formatted = fixCurrencyFormatting(gatedCaption);
        // Lock hashtags
        const final = lockHashtags(formatted, city);
        // VALIDATION GATE — reject invalid LLM output
        const validation = validateCaption(final);
        if (!validation.valid) {
          console.error(`[Caption] ⚠️ VALIDATION FAILED (attempt ${attempt}/2): ${validation.reason}`);
          console.error(`[Caption] Rejected output (first 200 chars): ${final.slice(0, 200)}`);
          if (attempt === 1) {
            console.log(`[Caption] Retrying with correction instruction...`);
            continue; // retry with RETRY_INSTRUCTION appended
          }
          // Second attempt also failed — fall through to fallback
          console.error(`[Caption] ❌ BOTH attempts failed validation. Using hardcoded fallback.`);
          return getFallbackCaption(city);
        }
        console.log(`[Caption] Generated fresh caption (${final.length} chars, community=${community?.name || "none"}, leaks_stripped=${leaksFound})`);
        return sanitizeCaption(final);
      }
    } catch (err) {
      console.error(`[Caption] Anthropic API failed (attempt ${attempt}):`, err.message);
    }
  }
  console.error(`[Caption] All generation attempts exhausted. Using hardcoded fallback.`);
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
 * 
 * KB OVERRIDE: When a community KB entry exists, volatile numbers (HOA, tax, price ranges)
 * from the KB take precedence over the original caption's potentially stale values.
 */
export async function generateCaptionFromOriginal(originalCaption, city, videoOverlays = null) {
  const cityName = CITY_NAMES[city] || city;

  // Check if we can find a community match for KB override
  let community = null;
  if (videoOverlays?.community) {
    community = findCommunity(videoOverlays.community, cityName);
  }
  // Also try to find community from the original caption text (for restructure cases)
  if (!community) {
    const kb = loadCommunities();
    for (const [name, data] of Object.entries(kb)) {
      if (originalCaption.toLowerCase().includes(name.toLowerCase())) {
        community = { name, ...data };
        console.log(`[Caption] KB match from original caption text: "${name}"`);
        break;
      }
    }
  }

  // Build KB override instructions if we have a match
  const kbOverrideBlock = community ? `
KB OVERRIDE — USE THESE VALUES INSTEAD OF THE ORIGINAL'S (original may be stale):
${community.hoa ? `- HOA: ${community.hoa} (REPLACE any HOA amount from the original with this)` : ""}
${community.price_range ? `- Price range: ${community.price_range} (USE this if the original's price range differs)` : ""}
${community.school_district ? `- School district: ${community.school_district}` : ""}
${community.sqft_range ? `- Sqft range: ${community.sqft_range}` : ""}
${community.beds_baths_range ? `- Beds/baths: ${community.beds_baths_range}` : ""}
When the original caption and the KB disagree on a volatile number (HOA, tax rate, price range), the KB wins. The KB is updated from builder websites; old captions go stale.
` : "";

  const prompt = `You are given the original Instagram caption from a real estate video post. Your job is to RESTRUCTURE it into the themed-section format below.

CRITICAL RULE: Keep EVERY specific fact from the original (school district, HOA amount, sqft ranges, price, beds/baths, lot sizes, tax rates, specific incentive details, financing options). Do NOT summarize or compress. A 1,800-character rich caption should stay approximately 1,800 characters. You are REORGANIZING facts into better sections, not reducing them.

${kbOverrideBlock}

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
- PRIMARY CTA: "📲 comment TOUR and I'll DM you today's available homes. pick your favorite and I'll send the full monthly payment breakdown on it"
- SECONDARY: "📩 or DM LIST for a custom lineup of every similar option plus a fast approval game plan"
- LAST content line: "⭐️ link in bio to get started with us today"
- "Lifestyle Design Realty" on its own line
- DO NOT include any hashtags. They will be added separately.

PRESERVATION CHECKLIST — verify ALL of these from the original appear in your output (EXCEPT gated names):
- Every price mentioned (exact dollar amounts, ranges, "from the $Xs")
- Every bed/bath/sqft number
- School district name (KEEP — doesn't identify community alone)
- HOA amount (USE KB OVERRIDE VALUE if available, otherwise keep original)
- Tax rate if mentioned
- Every specific amenity DESCRIPTION (sizes, features — but NOT the branded name)
- Every financing detail (VA/FHA/USDA, rate buydowns, specific % rates)
- Every location detail at city/area level

If any FACT (not name) from the original is missing in your output, you have failed the task.
${CAPTION_RULES}`;

  // Attempt generation with validation gate (retry once on failure)
  for (let attempt = 1; attempt <= 2; attempt++) {
    const currentPrompt = attempt === 1 ? prompt : prompt + RETRY_INSTRUCTION;
    try {
      const response = await getClient().messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        messages: [{ role: "user", content: currentPrompt }],
      });
      const content = response.content[0]?.text;
      if (content && content.length > 50) {
        // Post-generation leak scan (check against ALL KB communities)
        const { caption: gatedCaption, leaksFound, leakDetails } = scanAndStripLeaks(content, community);
        if (leaksFound > 0) {
          console.log(`[Caption] LEAK SCANNER (restructure): stripped ${leaksFound} gated terms: ${leakDetails.map(l => `"${l.term}" (${l.type})`).join(", ")}`);
        }
        // Currency formatting pass
        const formatted = fixCurrencyFormatting(gatedCaption);
        // Lock hashtags
        const final = lockHashtags(formatted, city);
        // VALIDATION GATE — reject invalid LLM output
        const validation = validateCaption(final);
        if (!validation.valid) {
          console.error(`[Caption] ⚠️ VALIDATION FAILED (restructure, attempt ${attempt}/2): ${validation.reason}`);
          console.error(`[Caption] Rejected output (first 200 chars): ${final.slice(0, 200)}`);
          if (attempt === 1) {
            console.log(`[Caption] Retrying restructure with correction instruction...`);
            continue;
          }
          console.error(`[Caption] ❌ BOTH restructure attempts failed validation. Using fallback.`);
          break; // fall through to fallback below
        }
        console.log(`[Caption] Restructured from original (${final.length} chars, original was ${originalCaption.length} chars, KB_override=${!!community}, leaks_stripped=${leaksFound})`);
        return sanitizeCaption(final);
      }
    } catch (err) {
      console.error(`[Caption] Anthropic API failed for restructure (attempt ${attempt}):`, err.message);
    }
  }
  // Fallback: strip leaks from original, lock hashtags, and return it
  console.log("[Caption] Falling back to original caption (leak-scanned)");
  const { caption: gatedOriginal } = scanAndStripLeaks(originalCaption, null);
  const formatted = fixCurrencyFormatting(gatedOriginal);
  const final = lockHashtags(formatted, city);
  return sanitizeCaption(final);
}

function getFallbackCaption(city) {
  const cityName = CITY_NAMES[city] || city;
  const hashtags = LOCKED_HASHTAGS[city] || LOCKED_HASHTAGS.austin;
  return `the kitchen in this one made me stop mid-tour 😮‍💨

new construction like this doesn't sit long in ${cityName}

✨ everyday living hits
• brand new build with modern finishes and a smart open layout
• huge windows and natural light flooding every room
• chef's kitchen with island and upgraded counters
• energy efficient and move-in ready

🌳 want the full community rundown and today's available homes? comment TOUR

🎓 school ratings, HOA and taxes vary by address. I'll send exact numbers when you comment

💸 buyer wins
• builder incentives and rate buydowns available. ask what you qualify for
• VA, FHA, and conventional friendly with fast pre-approvals

perfect for growing families, military/veteran buyers, or anyone ready to stop renting

📲 comment TOUR and I'll DM you today's available homes. pick your favorite and I'll send the full monthly payment breakdown on it
📩 or DM LIST for a custom lineup of every similar option plus a fast approval game plan
⭐️ link in bio to get started with us today

Lifestyle Design Realty
${hashtags}`;
}

function getFallbackScript(city) {
  const cityName = CITY_NAMES[city] || city;
  return `Look at this brand new home in ${cityName}. The natural light coming through these windows is incredible. You have this gorgeous open concept layout with modern finishes throughout. The kitchen flows right into the living space, perfect for entertaining. And these bedrooms are so spacious. If you want to see more homes like this, comment below and I will send you everything available.`;
}
