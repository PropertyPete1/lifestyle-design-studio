/**
 * Local test: Generate a full week of LinkedIn posts using the built-in Forge API.
 * This uses the OpenAI-compatible endpoint with claude-haiku-4-5 model.
 * Run with: node test-linkedin-week-local.mjs
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FORGE_URL = process.env.BUILT_IN_FORGE_API_URL;
const FORGE_KEY = process.env.BUILT_IN_FORGE_API_KEY;
const HISTORY_PATH = join(__dirname, "linkedin-history.json");

// Clear history for clean test
writeFileSync(HISTORY_PATH, JSON.stringify({ posts: [] }, null, 2) + "\n");

// ─── Import the logic from linkedin.js (we'll replicate the key parts here for local testing) ───

const LEAD_OVERFLOW_FACTS = `More buyer and lease leads than we can work efficiently. Mostly new construction buyer leads in San Antonio and Austin, plus out-of-state relocation buyers. Warm but need vetting and nurture. Most aren't ready today.`;
const LEAD_OVERFLOW_CTA = `If this sounds like something you'd take on, send me a DM.`;
const MARKET_FACTS = ``;

const LINKEDIN_TOPICS = [
  { key: "why_agents_leave", label: "Why agents leave brokerages", angle: "Why agents really leave their brokerage and what they are actually looking for (support, leadership, culture, splits, growth). Speak to the agent's frustration and what better looks like." },
  { key: "leadership_culture", label: "Leadership and culture", angle: "Leadership and culture at Lifestyle Design Realty. What it feels like to be led well, invested in, and part of a team that has your back." },
  { key: "income_potential", label: "Income potential", angle: "Income potential and what top agents do differently. Concrete habits, systems, and mindset that separate high earners from everyone else." },
  { key: "mindset_motivation", label: "Mindset and motivation", angle: "Mindset and motivation for realtors. Encouragement for agents grinding through a hard market, staying consistent, and betting on themselves." },
  { key: "wish_i_knew", label: "What I wish I knew earlier", angle: "What I wish I knew earlier in real estate. An honest lesson from Peter's own journey that a newer or stuck agent needs to hear." },
  { key: "time_to_level_up", label: "Signs it's time to level up", angle: "Signs it is time to level up or switch teams. Help an agent recognize they have outgrown where they are and it is time for more." },
  { key: "deal_story", label: "A deal story from this week", angle: "A lesson from a real transaction this week. Keep it generic (no client names or addresses). Focus on the lesson, the pivot, or the thing that almost went wrong. Make agents nod because they have been there." },
  { key: "market_now", label: "The market right now", angle: MARKET_FACTS ? `An honest take on the Texas market using ONLY these verified facts: ${MARKET_FACTS}. Focus on what smart agents are doing about it.` : "A timeless take on how smart agents navigate uncertain markets. Focus on pricing strategy, seller conversations, buyer psychology, and agent behavior. Do NOT state specific market-direction claims (prices rising/falling, inventory expanding/shrinking, rate levels). You do not have current data. Instead talk about timeless dynamics: pricing right beats chasing the market, how to talk to hesitant sellers, what separates agents who thrive in any market from those who wait for perfect conditions." },
  { key: "team_wins", label: "Team wins", angle: "Celebrating what the team accomplished recently. No names unless provided. Focus on the collective momentum, the culture of winning, and what it means to be part of something growing." },
  { key: "unpopular_opinion", label: "Unpopular opinion", angle: "A contrarian industry take that invites debate. Something most agents believe that Peter disagrees with, backed by experience. Make it specific enough to be interesting, not so extreme it is alienating." },
];

const FORMATS = [
  { key: "short_punchy", label: "Short punchy (under 60 words)", instruction: "Write this post in UNDER 60 WORDS. Extremely concise. Every word earns its place. No filler. Hit hard and stop.", maxWords: 60 },
  { key: "story", label: "Story format (~150 words)", instruction: "Write this as a mini-narrative (~150 words). Open in the middle of the action or with a specific moment. Build tension or insight. Land the lesson.", maxWords: 150 },
  { key: "list", label: "List format (3 numbered points)", instruction: "Write this as 3 quick numbered points (no more than 3). Brief intro line, then 3 numbered insights, then a closing line. Keep it tight.", maxWords: 150 },
  { key: "bold_statement", label: "Single bold statement + one paragraph", instruction: "Open with ONE bold declarative statement on its own line. Then one paragraph (3 to 5 sentences) that unpacks it. That is the whole post.", maxWords: 150 },
];

const ENDING_TYPES = ["question", "dm_cta", "strong_close"];
const DM_CTA_OPTIONS = [
  "And if you're an agent in Texas thinking about your next move, my DMs are open.",
  "If you want to talk about what we're building at Lifestyle Design Realty, send me a DM.",
  "Agents in San Antonio or Austin looking for more leads than you can handle, DM me.",
];

function getDayOfWeek(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).getDay();
}

function isLeadOverflowDay(dateStr) {
  const dow = getDayOfWeek(dateStr);
  return dow === 2 || dow === 5;
}

function topicForDate(dateStr) {
  if (isLeadOverflowDay(dateStr)) {
    return { key: "lead_overflow", label: "Lead overflow offer", angle: "SPECIAL TOPIC. Use ONLY the facts from LEAD_OVERFLOW_FACTS." };
  }
  const [y, m, d] = dateStr.split("-").map(Number);
  const dayIndex = Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
  const idx = ((dayIndex % LINKEDIN_TOPICS.length) + LINKEDIN_TOPICS.length) % LINKEDIN_TOPICS.length;
  return LINKEDIN_TOPICS[idx];
}

function formatForDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dayIndex = Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
  const idx = ((dayIndex % FORMATS.length) + FORMATS.length) % FORMATS.length;
  return FORMATS[idx];
}

function endingForDate(dateStr) {
  if (isLeadOverflowDay(dateStr)) return "dm_cta";
  const [y, m, d] = dateStr.split("-").map(Number);
  const dayIndex = Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
  const idx = ((dayIndex % ENDING_TYPES.length) + ENDING_TYPES.length) % ENDING_TYPES.length;
  return ENDING_TYPES[idx];
}

function dmCtaForDate(dateStr, isOverflow = false) {
  if (isOverflow) return LEAD_OVERFLOW_CTA;
  const [y, m, d] = dateStr.split("-").map(Number);
  const dayIndex = Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
  const idx = ((dayIndex % DM_CTA_OPTIONS.length) + DM_CTA_OPTIONS.length) % DM_CTA_OPTIONS.length;
  return DM_CTA_OPTIONS[idx];
}

function buildEndingInstruction(endingType, dateStr) {
  switch (endingType) {
    case "question": return "END with ONE thought-provoking question that drives comments from agents. The question MUST end with a question mark (?). No DM ask. Do NOT wrap the question in quotation marks.";
    case "dm_cta": return `END with this exact line (copy it verbatim): "${dmCtaForDate(dateStr, isLeadOverflowDay(dateStr))}"`;
    case "strong_close": return "END with a strong closing statement. No question, no DM ask, no call to action. Just land it.";
    default: return "END with a strong closing line.";
  }
}

function loadHistory() {
  try {
    if (existsSync(HISTORY_PATH)) {
      const data = JSON.parse(readFileSync(HISTORY_PATH, "utf8"));
      return Array.isArray(data.posts) ? data.posts.slice(-7) : [];
    }
  } catch (e) {}
  return [];
}

function saveToHistory(post) {
  let history = { posts: [] };
  try {
    if (existsSync(HISTORY_PATH)) {
      history = JSON.parse(readFileSync(HISTORY_PATH, "utf8"));
      if (!Array.isArray(history.posts)) history.posts = [];
    }
  } catch (e) { history = { posts: [] }; }
  history.posts.push(post);
  if (history.posts.length > 7) history.posts = history.posts.slice(-7);
  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2) + "\n");
}

function buildHistoryBlock(history) {
  if (!history.length) return "";
  const posts = history.map((h, i) => `--- Post ${i + 1} (${h.date || "recent"}) ---\n${h.body}`).join("\n\n");
  return `\n\nRECENT POSTS (do NOT open with a similar hook, reuse phrases, or repeat the angle of any of these):\n${posts}`;
}

const SYSTEM_VOICE = `You are Peter Allen, a real estate agent and the owner of Lifestyle Design Realty in Texas.
You write your own LinkedIn posts to grow your following and RECRUIT realtors to your brokerage.
Every post speaks to REALTORS and agents, never to home buyers or sellers.
Your goal is to position yourself as a leader that agents want to work for.

VOICE:
- First person, as Peter. Conversational, direct, and motivational. Never corporate.
- Sound like a real person talking, not a marketer or an AI.

HARD RULES:
- Text only. No images, no hashtags, no emojis-as-bullets.
- Do NOT use em-dashes or en-dashes (— or –). Use short sentences and periods instead. This is important; dashes read as AI.
- Never use generic quotes from famous people. Everything is your own voice and experience.
- Do not use hashtags.
- No hype words like "amazing opportunity", "incredible", "game-changer". No exclamation points.
- No "Here's the thing" or "Let me be real" or "The truth is" openers. Those are overused.
- NEVER ask clarifying questions. NEVER say you need more information. NEVER refuse. You have everything you need. Just write the post.
- NEVER include meta-commentary like "I have what I need" or "Here's today's post" or "I'll write this as...". Start directly with the post content.
- For "what I wish I knew" topics: draw from Peter's real journey. He started solo, built a team, learned to delegate, learned that splits don't matter if you have no support, learned that culture beats compensation. Pick one angle and write.

Return ONLY the post text. No preamble, no quotes around it, no explanation. Start with the first word of the actual post.`;

function sanitizePost(raw) {
  let t = (raw || "").trim();
  // Remove AI preambles (thinking out loud, meta-commentary)
  const preambleStarts = "here'?s|here is|sure|draft|post|I'm going to|I need to|I'll|Let me|I want to|I have what|I've got what";
  t = t.replace(new RegExp(`^(${preambleStarts})[^\\n]*\\n+`, "i"), "");
  t = t.replace(new RegExp(`^(${preambleStarts})[^\\n]*:\\s*\\n*`, "i"), "");
  // Remove lines that are clearly meta/thinking (not the post itself)
  const metaPattern = /^(I'm going to|I need to|I'll write|Let me|Here's today|Something honest|I have what|I've got what|I'm missing)/i;
  const lines = t.split("\n");
  while (lines.length > 0 && metaPattern.test(lines[0].trim())) {
    lines.shift();
  }
  t = lines.join("\n").trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }
  // Replace em/en dashes
  t = t.replace(/[\u2014\u2013]/g, ". ").replace(/ \. /g, ". ").replace(/\.\./g, ".");
  t = t.replace(/ —/g, ".").replace(/— /g, ". ").replace(/ – /g, ". ");
  // Remove hashtags
  t = t.split("\n").map(line => line.replace(/(^|\s)#[A-Za-z0-9_]+/g, "").replace(/\s+$/g, "")).join("\n");
  t = t.replace(/\n{3,}/g, "\n\n").trim();

  // Strip wrapping quotes from the final line (questions should be plain text)
  const finalLines = t.split("\n");
  const lastIdx = finalLines.length - 1;
  if (lastIdx >= 0) {
    let last = finalLines[lastIdx].trim();
    if ((last.startsWith('"') && last.endsWith('"')) || (last.startsWith("'") && last.endsWith("'"))) {
      last = last.slice(1, -1).trim();
    }
    if ((last.startsWith('"') && last.endsWith('."')) || (last.startsWith("'") && last.endsWith(".'"))) {
      last = last.slice(1, -2).trim() + "?";
    }
    finalLines[lastIdx] = last;
  }
  t = finalLines.join("\n");

  return t;
}

function wordCount(s) { return s.split(/\s+/).filter(Boolean).length; }

async function callLLM(systemPrompt, userPrompt) {
  const res = await fetch(`${FORGE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${FORGE_KEY}`,
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 600,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

// ─── Test dates: Mon Jul 28 through Sun Aug 3, 2026 ───
const TEST_DATES = [
  "2026-07-27", // Monday
  "2026-07-28", // Tuesday (lead_overflow)
  "2026-07-29", // Wednesday
  "2026-07-30", // Thursday
  "2026-07-31", // Friday (lead_overflow)
  "2026-08-01", // Saturday
  "2026-08-02", // Sunday
];
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  LINKEDIN DRY-RUN WEEK — 7 Posts for Approval");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const allPosts = [];

  for (let i = 0; i < TEST_DATES.length; i++) {
    const date = TEST_DATES[i];
    const dayName = DAY_NAMES[i];
    const topic = topicForDate(date);
    const format = formatForDate(date);
    const endingType = endingForDate(date);
    const history = loadHistory();
    const maxWords = format.maxWords;

    console.log(`\n━━━ ${dayName} (${date}) ━━━`);
    console.log(`Topic: ${topic.key} | Format: ${format.key} | Ending: ${endingType}`);

    const endingInstruction = buildEndingInstruction(endingType, date);
    const historyBlock = buildHistoryBlock(history);

    let topicBlock;
    if (topic.key === "lead_overflow") {
      topicBlock =
        `TODAY'S TOPIC: Lead overflow offer.\n` +
        `FACTS (use ONLY these, do not invent specifics): ${LEAD_OVERFLOW_FACTS}\n` +
        `STRUCTURE: Plain statement of the overflow, what kind of leads, the honest catch, then the DM line.\n` +
        `TONE: Direct, no hype, no exclamation points. Like telling a colleague you have more work than you can handle.`;
    } else {
      topicBlock = `TODAY'S TOPIC: ${topic.label}.\nANGLE: ${topic.angle}`;
    }

    const userPrompt =
      `Write today's LinkedIn post.\n\n${topicBlock}\n\nFORMAT: ${format.instruction}\n\nENDING: ${endingInstruction}\n\n` +
      `Remember: speak to realtors, recruit them to Lifestyle Design Realty, first person as Peter Allen, under ${maxWords} words, no dashes, no hashtags.${historyBlock}`;

    let body = sanitizePost(await callLLM(SYSTEM_VOICE, userPrompt));

    if (!body || wordCount(body) > maxWords) {
      body = sanitizePost(await callLLM(SYSTEM_VOICE + `\n\nYour previous attempt was too long or empty. Keep it well under ${maxWords} words.`, userPrompt)) || body;
    }

    if (wordCount(body) > maxWords) {
      const words = body.split(/\s+/).slice(0, maxWords).join(" ");
      const lastStop = Math.max(words.lastIndexOf("."), words.lastIndexOf("?"), words.lastIndexOf("!"));
      body = (lastStop > 40 ? words.slice(0, lastStop + 1) : words).trim();
    }

    // Enforce question mark on question endings
    if (endingType === "question") {
      const qLines = body.split("\n");
      const lastLine = qLines[qLines.length - 1].trimEnd();
      if (lastLine && !lastLine.endsWith("?")) {
        qLines[qLines.length - 1] = lastLine.replace(/\.\s*$/, "").trimEnd() + "?";
        body = qLines.join("\n");
      }
    }

    console.log(`Words: ${wordCount(body)}\n`);
    console.log(body);
    console.log("");

    allPosts.push({ dayName, date, topic: topic.key, format: format.key, ending: endingType, body, words: wordCount(body) });

    // Save to history for anti-repetition
    saveToHistory({ topic: topic.key, body, format: format.key, ending: endingType, date });

    // Small delay
    await new Promise(r => setTimeout(r, 500));
  }

  // Write results to file for easy reading
  let output = "# LinkedIn Dry-Run Week: Mon Jul 28 – Sun Aug 3, 2026\n\n";
  for (const p of allPosts) {
    output += `## ${p.dayName} (${p.date})\n`;
    output += `**Topic:** ${p.topic} | **Format:** ${p.format} | **Ending:** ${p.ending} | **Words:** ${p.words}\n\n`;
    output += `${p.body}\n\n---\n\n`;
  }
  writeFileSync(join(__dirname, "linkedin-week-preview.md"), output);
  console.log("\n✓ Full preview saved to linkedin-week-preview.md");
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
