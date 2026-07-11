/**
 * Caption Generation — uses Anthropic Claude API
 */

import Anthropic from "@anthropic-ai/sdk";

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
 */
export async function generateCaption(city) {
  const cityName = CITY_NAMES[city] || city;
  const hashtag = city === "san_antonio" ? "sanantonio" : city === "dallas" ? "dallas" : "austin";

  const prompt = `Write an Instagram Reel caption for a real estate video showcasing a brand new home in ${cityName}, Texas. 

Write it in this EXACT style (this is how the account always posts):

RULES:
- Start with a catchy emoji hook line that grabs attention (use 🪟, 🏡, 😮‍💨, 🔥, or similar)
- Include "⭐️FILL OUT THE LINK IN BIO FOR INFO AND TO GET STARTED WITH US TODAY🌄" near the top
- Use emoji bullet points for features (🏡, 🛏, 🛁, 🍳, 🪟, 🔥, 💰, 💸, 🗓)
- Mention 3-5 bedrooms, 2-3.5 baths
- Include a realistic price between $280K-$550K for ${cityName}
- Include a financing mention (like "special financing available" or "low rate option")
- End with: "📲 comment TOUR and I will DM you exact payments incentives and private tour times"
- Then: "📩 or DM LIST for every similar option in ${cityName} plus a fast approval plan for VA FHA or conventional"
- Add "Lifestyle Design Realty" on its own line
- End with hashtags: #texas #${hashtag} #realestate #military #veteran #newconstruction

IMPORTANT: 
- Sound natural and excited, not robotic
- Keep it under 2000 characters total
- Use line breaks between sections
- DO NOT use markdown formatting
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
      return content.trim();
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
      return content.trim();
    }
  } catch (err) {
    console.error("[VoiceoverScript] Anthropic API failed:", err.message);
  }

  // Fallback script
  return getFallbackScript(city);
}

function getFallbackCaption(city) {
  const cityName = CITY_NAMES[city] || city;
  const hashtag = city === "san_antonio" ? "sanantonio" : city === "dallas" ? "dallas" : "austin";

  return `🪟 bright open layouts and that brand new home glow — this is what ${cityName} living looks like right now 😮‍💨🏡

⭐️FILL OUT THE LINK IN BIO FOR INFO AND TO GET STARTED WITH US TODAY🌄

🏡 brand new homes with modern finishes and smart floor plans
🛏 3-5 bedrooms 🛁 2-3.5 baths designed for real life
🪟 big windows natural light and open concept living
🔥 energy efficient and move-in ready

💰 homes starting in the low $300s
💸 special financing options available — ask what you qualify for
🗓 quick move-in options available now

📲 comment TOUR and I will DM you exact payments incentives and private tour times

📩 or DM LIST for every similar option in ${cityName} plus a fast approval plan for VA FHA or conventional

Lifestyle Design Realty

#texas #${hashtag} #realestate #military #veteran #newconstruction`;
}

function getFallbackScript(city) {
  const cityName = CITY_NAMES[city] || city;
  return `Look at this brand new home in ${cityName}. The natural light coming through these windows is incredible. You have this gorgeous open concept layout with modern finishes throughout. The kitchen flows right into the living space, perfect for entertaining. And these bedrooms are so spacious. If you want to see more homes like this, comment below and I will send you everything available.`;
}
